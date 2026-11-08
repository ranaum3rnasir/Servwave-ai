import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { attachmentObjectPath, removeStoredAttachmentObjects } from '../attachment-access';
import { dispatchAutomationEvent } from '../../services/automations/dispatch';
import { createDispatchLane, type DispatchLane } from '../../services/automations/dispatchLane';
import { TASK_ENTITY_TYPE, recordTaskActivities, toIdSet } from './activity';
import { emitTaskNotification, type TaskActor, type TaskRef } from './notify';

/**
 * A task's timeline OUTLIVES the task (issue 04). `remove` still deletes the row and its notes,
 * but the timeline is the audit trail that makes `created_by` worth keeping as a permission-free
 * audit field, so it stays.
 *
 * The cost is that every reader of TimelineEvent that does NOT filter by entity (the activity
 * report and the dashboard feed, both org-wide) can now meet an event whose `entity_id` names
 * nothing. Both halves of that contract live here so they cannot drift: the final event the
 * delete writes, and the lookup that turns a dangling `entity_id` back into something readable.
 */
export const TASK_DELETED_EVENT_TYPE = 'DELETED' as const;

/** Everything a reader needs about a task that is gone. There is nothing left to join to. */
export interface DeletedTaskSnapshot {
  task_title: string;
  task_number: string;
}

/** Never blank: the number stands in on its own if the title was empty. */
export function deletedTaskLabel(s: DeletedTaskSnapshot): string {
  const title = s.task_title.trim();
  return title ? `${s.task_number} · ${title}` : s.task_number;
}

/** `metadata` is untyped Json on the row, and pre-issue-04 task events carry none at all. */
function readSnapshot(metadata: unknown): DeletedTaskSnapshot | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (typeof m.task_number !== 'string' || !m.task_number) return null;
  return { task_number: m.task_number, task_title: typeof m.task_title === 'string' ? m.task_title : '' };
}

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * THE task-deletion service (slice 11). Every path that deletes tasks - the manual DELETE of one
 * task, a category delete that takes its tasks with it - runs these two halves, in this order, so
 * a task goes exactly the same way whichever door it left by:
 *
 *   1. `deleteTasks(tx, tasks, actor)` INSIDE the caller's transaction: the task's comments (notes),
 *      its file rows, a final DELETED timeline event per task (the audit trail), then the task rows.
 *      Subtasks go with the row (FK cascade); the timeline stays (issue 04).
 *   2. `announceTaskDeletions(actor, deleted, paths)` AFTER the commit, for exactly the tasks phase
 *      1 reports it deleted (a task a concurrent request took first is not among them): the files' storage objects,
 *      then, per task, the `task.deleted` bell and one TASK_DELETED automation run. Notifications
 *      and dispatches fired inside a transaction are silently dropped (and would survive a
 *      rollback), so they never move into phase 1.
 *
 * Both halves work from the SAME snapshot, read by the caller before the rows go: after phase 1
 * there is nothing left to read a title, a number or a roster from.
 */

/** The columns the service needs from a task about to be deleted. */
export const DELETABLE_TASK_SELECT = {
  id: true,
  title: true,
  task_number: true,
  assignee_ids: true,
  watcher_ids: true,
  created_by: true,
} as const;

export interface DeletableTask {
  id: string;
  title: string;
  task_number: string;
  assignee_ids: string[];
  watcher_ids: string[];
  created_by: string;
}

/**
 * Tasks per statement. A category can hold hundreds of tasks; one `IN (...)` per table per chunk
 * keeps a bulk delete to a handful of round trips inside the (30s) interactive transaction, where
 * a statement per task would scale with the category. Measured in task-category-delete-db.test.ts.
 */
const TASKS_PER_STATEMENT = 200;

/** Bells in flight at once after a bulk delete (each one's queries go through the shared pool). */
const TASKS_ANNOUNCED_AT_ONCE = 10;

/** Supabase Storage refuses a remove() naming more than 1000 objects. */
const OBJECTS_PER_REMOVE = 1000;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What phase 1 actually removed - the only tasks phase 2 may announce. */
export interface DeletedTasks {
  deleted: DeletableTask[];
  attachmentPaths: string[];
}

/**
 * Lock the rows of `taskIds` still in the organization and return their ids. A concurrent delete
 * of the same task holds its row until it commits; this waits for it, then finds the row gone -
 * so of two deletes racing for one task exactly one goes on to write its audit event and announce.
 */
async function lockLiveTasks(tx: Tx, taskIds: string[], orgId: string): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM tasks
    WHERE organization_id = ${orgId}::uuid AND id = ANY(${taskIds}::uuid[])
    FOR UPDATE`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Phase 1: delete `tasks` (already read, tenant-scoped, by the caller) and everything that hangs
 * off them without a foreign key. The rows are locked first and only those still there are
 * deleted: a task another request deleted in the meantime is left out - no second DELETED event,
 * and absent from `deleted`, so phase 2 never announces it twice. Returns what was deleted and the
 * storage paths of its files. Every statement is scoped to the organization as well as to the ids.
 */
export async function deleteTasks(tx: Tx, tasks: DeletableTask[], actor: TaskActor): Promise<DeletedTasks> {
  const deleted: DeletableTask[] = [];
  const paths: string[] = [];
  for (const candidates of chunks(tasks, TASKS_PER_STATEMENT)) {
    const live = await lockLiveTasks(tx, candidates.map((task) => task.id), actor.orgId);
    const chunk = candidates.filter((task) => live.has(task.id));
    if (!chunk.length) continue;
    deleted.push(...chunk);
    const taskIds = chunk.map((task) => task.id);
    // Issue 04 - the two polymorphic tables are treated DIFFERENTLY, and the asymmetry is the whole
    // fix. Notes are user-written content with no surface once the drawer is gone, so they go.
    // Timeline events are the audit trail that makes design's permission-free `created_by` worth
    // keeping, so they stay, closed off by a final DELETED event that snapshots the title and
    // number the row can no longer supply.
    await tx.note.deleteMany({
      where: { entity_type: TASK_ENTITY_TYPE, entity_id: { in: taskIds }, organization_id: actor.orgId },
    });
    // Slice 12 - the task's files are content too: their rows go here, their objects after commit.
    paths.push(...(await deleteTaskAttachmentRows(tx, { taskIds, orgId: actor.orgId })));
    // The last event on each task's timeline, written BEFORE the row it describes goes.
    await recordTaskActivities(
      tx,
      chunk.map((task) => ({
        taskId: task.id,
        orgId: actor.orgId,
        actorId: actor.actorId,
        type: TASK_DELETED_EVENT_TYPE,
        description: 'deleted the task',
        metadata: { task_title: task.title, task_number: task.task_number } satisfies DeletedTaskSnapshot,
      })),
    );
    await tx.task.deleteMany({ where: { id: { in: taskIds }, organization_id: actor.orgId } });
  }
  return { deleted, attachmentPaths: paths };
}

/**
 * Phase 2, after the commit. Never throws for a storage failure (the orphan sweep reclaims what
 * storage keeps); the bell is best-effort and the dispatch fire-and-forget, as on every task write.
 */
export async function announceTaskDeletions(
  actor: TaskActor,
  tasks: DeletableTask[],
  attachmentPaths: string[],
): Promise<void> {
  await removeTaskAttachmentObjects(attachmentPaths);
  // A few tasks at a time: each bell is a handful of queries, and a category of 500 tasks
  // announced one by one kept the admin waiting seconds after the delete had committed. The
  // automation runs go through a lane of the same width (code review #12): dispatch is
  // fire-and-forget, so without it all 500 enrolments started together on the next tick.
  const lane = createDispatchLane(TASKS_ANNOUNCED_AT_ONCE);
  for (const batch of chunks(tasks, TASKS_ANNOUNCED_AT_ONCE)) {
    await Promise.all(batch.map((task) => announceTaskDeletion(actor, task, lane)));
  }
}

async function announceTaskDeletion(actor: TaskActor, task: DeletableTask, lane: DispatchLane): Promise<void> {
  const assigneeIds = toIdSet(task.assignee_ids);
  const watcherIds = toIdSet(task.watcher_ids);
  const ref: TaskRef = { id: task.id, title: task.title, task_number: task.task_number };

  // Its deep link dead-ends - design §5 accepts that.
  await emitTaskNotification(actor, 'task.deleted', ref, { assignee_ids: assigneeIds, watcher_ids: watcherIds });

  // ─── Automation Center event - post-commit, fire-and-forget (#271) ───────────────────
  // Spec B slice 4, and the ONE task dispatch whose entity is guaranteed GONE before a single
  // step of the workflow runs. Task deletion is a hard delete and `entity_id` carries no
  // foreign key, so an enrollment created here points at nothing.
  //
  // Everything the run will need therefore rides the event_payload, which createEnrollment
  // persists on the enrollment row and context.ts re-reads on EVERY step - so it survives a
  // WAIT of any length, which a dispatch-time-only mechanism would not:
  //   * the IDENTITY, as merge fields. Restricted, deliberately, to the number and the title:
  //     they are what the snapshot holds, and the catalogue advertises exactly those two on
  //     this trigger so the validator refuses to save a body asking for a due date there is
  //     no honest value for.
  //   * the ROSTER, as ids. The SAME snapshot the bell above uses, so the two halves cannot
  //     drift into disagreeing about who was on the task. context.ts reads the users live off
  //     these ids (they outlived the task), which keeps the org scoping and the is_active
  //     filter the live task arm applies.
  //
  // No occurrence key: a task is deleted exactly once, so the entity-scoped dedupe key is the
  // occurrence, and TASK_DELETED is correctly absent from dedupe.ts's OCCURRENCE_SCOPED set.
  //
  // No `notify` gate, matching the bell: `notify` suppresses the ADDED notices on create and
  // update, while removal and deletion stay unconditional - those are the ones nobody would
  // think to ask for and everybody needs. A category delete that takes 40 tasks therefore
  // dispatches 40 runs, one per task (story 46: each assignee hears their task is gone).
  dispatchAutomationEvent({
    type: 'TASK_DELETED',
    organizationId: actor.orgId,
    // The TITLE, not the task number - the same choice, and the same reason, the bell verbs
    // make. It is also the last copy of the identity outside the payload: the enrollment's
    // entity_label is what the Activity tab renders for a task nothing can be joined to.
    entity: { type: 'task', id: task.id, label: task.title },
    actorId: actor.actorId,
    eventPayload: {
      mergeFields: { 'task.number': task.task_number, 'task.title': task.title },
      taskSnapshot: { assigneeIds, watcherIds, creatorId: task.created_by },
    },
  }, { lane });
}

/**
 * A task's files go with the task (slice 12), in TWO phases, because the rows and the bytes live
 * in two systems with no shared transaction: the ROWS inside the delete transaction (they vanish
 * with the task or not at all), returning the storage paths they owned; the OBJECTS after the
 * commit (`removeTaskAttachmentObjects`) - an object removed for a task whose transaction then
 * rolled back would be a file its surviving row points at, lost for good. Attachments are
 * polymorphic with no foreign key, so nothing in the database does this for them.
 */
async function deleteTaskAttachmentRows(tx: Tx, a: { taskIds: string[]; orgId: string }): Promise<string[]> {
  const where = { entity_type: 'TASK' as const, entity_id: { in: a.taskIds }, organization_id: a.orgId };
  const rows = await tx.attachment.findMany({ where, select: { storage_path: true, file_url: true } });
  if (!rows.length) return [];
  // By the same `where`, not by the ids just read: a file landing in between loses its row too,
  // rather than surviving as a row on a deleted task. Its object is then the sweep's to reclaim.
  await tx.attachment.deleteMany({ where });
  return rows.map(attachmentObjectPath).filter((p): p is string => !!p);
}

/** Best-effort: whatever storage keeps, the orphan sweep reclaims (it owns the `task` segment). */
async function removeTaskAttachmentObjects(paths: string[]): Promise<void> {
  for (const batch of chunks(paths, OBJECTS_PER_REMOVE)) {
    await removeStoredAttachmentObjects(batch, 'Task deletion');
  }
}

/**
 * `entity_id` to label, for the TASK events in `events` whose task is gone.
 *
 * Deleted-ness is decided by the final DELETED event rather than by probing the Task table: the
 * snapshot on that row is the only surviving copy of the title, so the same query has to answer
 * both "is it gone" and "what was it called". An absent key means the entity is NOT known to be
 * deleted, and callers must then render the event exactly as they do today rather than invent a
 * label for it.
 */
export async function resolveDeletedTaskLabels(
  orgId: string,
  events: { entity_type: string; entity_id: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(events.filter((e) => e.entity_type === TASK_ENTITY_TYPE).map((e) => e.entity_id))];
  if (!ids.length) return out;

  const rows = await prisma.timelineEvent.findMany({
    where: {
      organization_id: orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: { in: ids },
      event_type: TASK_DELETED_EVENT_TYPE,
    },
    select: { entity_id: true, metadata: true },
  });
  for (const r of rows) {
    const snap = readSnapshot(r.metadata);
    if (snap) out.set(r.entity_id, deletedTaskLabel(snap));
  }
  return out;
}
