import { Prisma, PrismaClient } from '@prisma/client';
import { normaliseTaskCategoryName } from './categories';
import { equalsIgnoringCase } from '../name-match';
import { DELETABLE_TASK_SELECT, deleteTasks, type DeletableTask } from './deletion';
import type { TaskActor } from './notify';

/**
 * Creating, renaming and recoloring a task category (visits-and-task-categories slice 09).
 *
 * The one rule both writes share: a name is unique per organization WHATEVER ITS LETTER CASE OR
 * SPACING (names are stored normalised - normaliseTaskCategoryName), so
 * "Permit" and "permit" never sit side by side in a picker. The table's unique index
 * (organization_id, name) is exact-match only - a lower(name) expression index is not something
 * schema.prisma can model (slice 08's migration explains), so the case-insensitive half is
 * enforced here.
 *
 * A check-then-write alone would race: two admins adding "Permit" and "permit" at the same moment
 * both see no match and both insert. So every category write runs in one transaction that first
 * takes a transaction-scoped advisory lock on the organization's category list (the idiom
 * lib/numbering.ts uses). Writes to one org's list are serialised; other orgs never wait, and
 * commit or rollback releases the lock. The exact-match index stays as the last line of defence
 * (P2002 answers the same `duplicate`).
 *
 * Takes the client as a parameter so the concurrency test can drive it against a real database.
 */

export interface TaskCategoryDto {
  id: string;
  name: string;
  color: string;
  sort_order: number;
}

export type TaskCategoryWriteResult =
  | { ok: true; category: TaskCategoryDto }
  | { ok: false; error: 'duplicate' | 'not_found' };

export const TASK_CATEGORY_SELECT = { id: true, name: true, color: true, sort_order: true } as const;

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;

class DuplicateName extends Error {}

async function lockOrgCategoryList(tx: Tx, orgId: string): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which the raw-query deserializer cannot map.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task_categories:${orgId}`}, 0))`;
}

async function assertNameFree(tx: Tx, orgId: string, name: string, excludeId?: string): Promise<void> {
  const clash = await tx.taskCategory.findFirst({
    where: {
      organization_id: orgId,
      // Exact text, any case - never a LIKE pattern (a name may contain % or _).
      name: equalsIgnoringCase(name),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new DuplicateName();
}

/** One transaction holding the organization's category-list lock for its whole length. */
function withCategoryListLock<T>(db: Db, orgId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockOrgCategoryList(tx, orgId);
    return work(tx);
  });
}

async function runLocked(
  db: Db,
  orgId: string,
  write: (tx: Tx) => Promise<TaskCategoryWriteResult>,
): Promise<TaskCategoryWriteResult> {
  try {
    return await withCategoryListLock(db, orgId, write);
  } catch (err) {
    if (err instanceof DuplicateName) return { ok: false, error: 'duplicate' };
    // Duck-typed, as inv-vendor-categories does: the exact-match unique index caught a same-name
    // row the lock could not (a write from outside this module).
    if ((err as { code?: string } | null)?.code === 'P2002') return { ok: false, error: 'duplicate' };
    throw err;
  }
}

/** Add a category to the end of the organization's list. */
export function createTaskCategory(
  db: Db,
  orgId: string,
  input: { name: string; color: string },
): Promise<TaskCategoryWriteResult> {
  const name = normaliseTaskCategoryName(input.name);
  return runLocked(db, orgId, async (tx) => {
    await assertNameFree(tx, orgId, name);
    const { _max } = await tx.taskCategory.aggregate({
      where: { organization_id: orgId },
      _max: { sort_order: true },
    });
    const category = await tx.taskCategory.create({
      data: {
        organization_id: orgId,
        name,
        color: input.color,
        sort_order: (_max.sort_order ?? -1) + 1,
      },
      select: TASK_CATEGORY_SELECT,
    });
    return { ok: true, category };
  });
}

/**
 * Rename and/or recolor one of the organization's categories. Another organization's id is
 * `not_found`, exactly like an id that does not exist. Every task shows the change at once: tasks
 * reference the category row, and each task payload reads its name and color from it.
 */
export function updateTaskCategory(
  db: Db,
  orgId: string,
  id: string,
  patch: { name?: string; color?: string },
): Promise<TaskCategoryWriteResult> {
  const data = patch.name === undefined ? patch : { ...patch, name: normaliseTaskCategoryName(patch.name) };
  return runLocked(db, orgId, async (tx) => {
    const existing = await tx.taskCategory.findFirst({
      where: { id, organization_id: orgId },
      select: { id: true },
    });
    if (!existing) return { ok: false, error: 'not_found' };
    if (data.name !== undefined) await assertNameFree(tx, orgId, data.name, id);
    const category = await tx.taskCategory.update({
      where: { id },
      data,
      select: TASK_CATEGORY_SELECT,
    });
    return { ok: true, category };
  });
}

/**
 * What happens to a category's tasks when the category is deleted (slice 11):
 *   keep          - they stay, with no category;
 *   move          - they all move to `target_id`, another category of the same organization
 *                   (this doubles as a merge);
 *   delete_tasks  - they are all deleted, whatever their status, through the task-deletion
 *                   service. `confirm_name` must be the category's name, typed by the admin.
 */
export type TaskCategoryDeleteInput =
  | { mode: 'keep' }
  | { mode: 'move'; target_id: string }
  | {
      mode: 'delete_tasks';
      confirm_name: string;
      /**
       * How many tasks the admin was shown. When given and the category now holds a different
       * number, nothing is deleted (`task_count_changed`): the confirmation named a count, and a
       * task that joined the category after the dialog opened must not go with the others unseen.
       * The route requires it; it is optional here only for callers that confirm no count.
       */
      expected_task_count?: number;
    };

/** A task as the delete_tasks door reads it: enough to delete it and to ask who may open it. */
export type TaskInCategory = DeletableTask & { linked_entity_type: string | null; linked_entity_id: string | null };

export interface TaskCategoryDeleteOptions {
  /**
   * delete_tasks only: whether the caller may open (and so delete) this task. Every task in the
   * category must pass, or nothing is deleted (`forbidden`). Omitted for a caller who can delete
   * any task in the organization.
   */
  canDeleteTask?: (task: TaskInCategory) => Promise<boolean>;
}

export type TaskCategoryDeleteResult =
  | {
      ok: true;
      category: TaskCategoryDto;
      /** The tasks the category held: kept, moved or deleted. */
      taskCount: number;
      target: TaskCategoryDto | null;
      /** delete_tasks only: the snapshot the caller announces from after the commit. */
      deletedTasks: DeletableTask[];
      attachmentPaths: string[];
    }
  | { ok: false; error: 'not_found' | 'invalid_target' | 'confirm_mismatch' | 'task_count_changed' | 'forbidden' };

/**
 * The typed confirmation matches when it is the category's name, spaced the way names are stored.
 * Letter case counts: the admin types exactly what the dialog shows. The dialog applies the same
 * rule (taskCategoryDefaults.ts) to enable its button.
 */
export function confirmsTaskCategoryName(typed: string, name: string): boolean {
  return normaliseTaskCategoryName(typed) === name;
}

/**
 * Delete one of the organization's categories, and keep, move or delete its tasks - all in ONE
 * transaction: the category never goes without its tasks being dealt with, and a refusal changes
 * nothing. It holds the category-list lock, so a rename cannot slip between the typed-name check
 * and the delete, and a concurrent delete of the move target cannot leave tasks pointing at it.
 *
 * Another organization's category - as the one deleted or as the move target - is exactly as
 * absent as one that does not exist. The side effects of deleted tasks (storage objects, bell,
 * automation runs) are the CALLER's, after this commits: `announceTaskDeletions`.
 */
export function deleteTaskCategory(
  db: Db,
  actor: TaskActor,
  id: string,
  input: TaskCategoryDeleteInput,
  options: TaskCategoryDeleteOptions = {},
): Promise<TaskCategoryDeleteResult> {
  const orgId = actor.orgId;
  return withCategoryListLock(db, orgId, async (tx): Promise<TaskCategoryDeleteResult> => {
    const category = await tx.taskCategory.findFirst({
      where: { id, organization_id: orgId },
      select: TASK_CATEGORY_SELECT,
    });
    if (!category) return { ok: false, error: 'not_found' };

    const inCategory = { category_id: id, organization_id: orgId };
    let taskCount: number;
    let target: TaskCategoryDto | null = null;
    let deletedTasks: DeletableTask[] = [];
    let attachmentPaths: string[] = [];

    if (input.mode === 'move') {
      target = input.target_id === id
        ? null
        : await tx.taskCategory.findFirst({
            where: { id: input.target_id, organization_id: orgId },
            select: TASK_CATEGORY_SELECT,
          });
      if (!target) return { ok: false, error: 'invalid_target' };
      ({ count: taskCount } = await tx.task.updateMany({ where: inCategory, data: { category_id: target.id } }));
    } else if (input.mode === 'delete_tasks') {
      if (!confirmsTaskCategoryName(input.confirm_name, category.name)) return { ok: false, error: 'confirm_mismatch' };
      const inIt: TaskInCategory[] = await tx.task.findMany({
        where: inCategory,
        select: { ...DELETABLE_TASK_SELECT, linked_entity_type: true, linked_entity_id: true },
      });
      if (input.expected_task_count !== undefined && inIt.length !== input.expected_task_count) {
        return { ok: false, error: 'task_count_changed' };
      }
      if (options.canDeleteTask) {
        for (const task of inIt) {
          if (!(await options.canDeleteTask(task))) return { ok: false, error: 'forbidden' };
        }
      }
      // What the service actually deleted: a task a concurrent single delete took first is left
      // out of the count, the response and the audit entry, and is announced by that request.
      ({ deleted: deletedTasks, attachmentPaths } = await deleteTasks(tx, inIt, actor));
      taskCount = deletedTasks.length;
    } else {
      // The foreign key would clear these too (ON DELETE SET NULL); clearing them here states it
      // and counts them for the audit entry.
      ({ count: taskCount } = await tx.task.updateMany({ where: inCategory, data: { category_id: null } }));
    }

    await tx.taskCategory.delete({ where: { id } });
    return { ok: true, category, taskCount, target, deletedTasks, attachmentPaths };
  });
}
