import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { tenantWhere } from '../lib/tenant';
import { TASK_CATEGORY_COLORS, normaliseTaskCategoryName } from '../lib/tasks/categories';
import { isTerminalTaskStatus } from '../lib/tasks/status';
import {
  TASK_CATEGORY_SELECT,
  createTaskCategory,
  updateTaskCategory,
  deleteTaskCategory,
  type TaskCategoryWriteResult,
} from '../lib/tasks/categoryWrites';
import { announceTaskDeletions } from '../lib/tasks/deletion';
import { canAccessTask } from '../lib/tasks/visibility';

// Task categories (visits-and-task-categories plan). One org-wide list; a task carries at most one.
//
// Contract:
//   GET   /api/task-categories      -> { categories: [{ id, name, color, sort_order }] }  (sort_order, name)
//   POST  /api/task-categories      -> 201 { category }   400 validation, 409 duplicate name   (slice 09)
//   PATCH /api/task-categories/:id  -> 200 { category }   400, 404, 409 duplicate name         (slice 09)
//   DELETE /api/task-categories/:id { mode: 'keep' | 'move' + target_id
//                                     | 'delete_tasks' + confirm_name + expected_task_count }
//                                    -> 200 { mode, task_count, target, deleted_task_ids }
//                                       400 validation / bad target / wrong name, 404        (slice 11)
//                                       403 delete_tasks without the right to delete those tasks,
//                                       409 TASK_COUNT_CHANGED the category's task count moved (fix pass)
//
// For an admin (whoever may delete a category) the list also carries each category's
// `task_counts: { open, done }` - what the manage panel and the delete dialog show. Every handler
// is tenant-scoped; the routes gate on the `TaskCategory` subject, which every role reads and
// only ADMIN writes.

/** A palette color in any letter case, stored in the palette's own (upper) case. */
const paletteColor = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => TASK_CATEGORY_COLORS.includes(v), { message: 'Pick one of the palette colors.' });

/** Stored and compared normalised (trimmed, runs of spaces collapsed), so spacing never splits a duplicate. */
const categoryName = z
  .string()
  .transform(normaliseTaskCategoryName)
  .pipe(z.string().min(1, 'Name is required').max(50, 'Keep the name to 50 characters or fewer.'));

export const createTaskCategorySchema = z.object({ name: categoryName, color: paletteColor });

export const updateTaskCategorySchema = z
  .object({ name: categoryName.optional(), color: paletteColor.optional() })
  .refine((b) => b.name !== undefined || b.color !== undefined, { message: 'Nothing to change.' });

/**
 * The delete dialog's three choices. A missing typed name is refused here; a wrong one by the
 * write, which compares it with the stored name inside the transaction.
 */
export const deleteTaskCategorySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }),
  z.object({ mode: z.literal('move'), target_id: z.string().uuid('Pick a category to move the tasks to.') }),
  z.object({
    mode: z.literal('delete_tasks'),
    confirm_name: z.string({ required_error: 'Type the category name to confirm.' }).min(1, 'Type the category name to confirm.'),
    // The count the dialog showed; a different count at commit is refused (409 TASK_COUNT_CHANGED).
    expected_task_count: z.number({ required_error: 'Say how many tasks you expect to delete.' }).int().min(0),
  }),
]);

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

function notFound(res: Response) {
  res.status(404).json({ error: 'Category not found.' });
}

/** Answer a refused write. The duplicate message names the clash so the admin can fix it. */
function refuse(res: Response, result: Exclude<TaskCategoryWriteResult, { ok: true }>, name: string) {
  if (result.error === 'not_found') return notFound(res);
  res.status(409).json({ error: `A category named "${name}" already exists.`, code: 'CATEGORY_EXISTS' });
}

/**
 * Each category's tasks, split into open and done (DONE or CANCELLED - finished either way), in ONE
 * grouped query over the organization's tasks. Tasks the reader cannot see are counted too, which
 * is why only an admin gets them: the numbers say what a delete will touch.
 */
async function taskCountsByCategory(req: Request): Promise<Map<string, { open: number; done: number }>> {
  const groups = await prisma.task.groupBy({
    by: ['category_id', 'status'],
    where: { ...tenantWhere(req), category_id: { not: null } },
    _count: { _all: true },
  });
  const counts = new Map<string, { open: number; done: number }>();
  for (const g of groups) {
    if (!g.category_id) continue;
    const c = counts.get(g.category_id) ?? { open: 0, done: 0 };
    if (isTerminalTaskStatus(g.status)) c.done += g._count._all;
    else c.open += g._count._all;
    counts.set(g.category_id, c);
  }
  return counts;
}

export async function list(req: Request, res: Response) {
  try {
    const categories = await prisma.taskCategory.findMany({
      where: tenantWhere(req),
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      select: TASK_CATEGORY_SELECT,
    });
    if (!(req.ability?.can('delete', 'TaskCategory') ?? false)) {
      res.json({ categories });
      return;
    }
    const counts = await taskCountsByCategory(req);
    res.json({
      categories: categories.map((c) => ({ ...c, task_counts: counts.get(c.id) ?? { open: 0, done: 0 } })),
    });
  } catch (err) {
    logger.error('List task categories error:', err);
    res.status(500).json({ error: 'Failed to list task categories' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createTaskCategorySchema>;
    const result = await createTaskCategory(prisma, req.user!.organization_id, body);
    if (!result.ok) return refuse(res, result, body.name);

    void logAudit({
      req,
      action: 'task.category_created',
      resourceType: 'TaskCategory',
      resourceId: result.category.id,
      metadata: { name: result.category.name, color: result.category.color },
    });
    res.status(201).json({ category: result.category });
  } catch (err) {
    logger.error('Create task category error:', err);
    res.status(500).json({ error: 'Failed to create the category' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!isUuid(id)) return notFound(res);
    const body = req.body as z.infer<typeof updateTaskCategorySchema>;
    const result = await updateTaskCategory(prisma, req.user!.organization_id, id, body);
    if (!result.ok) return refuse(res, result, body.name ?? '');

    void logAudit({
      req,
      action: 'task.category_updated',
      resourceType: 'TaskCategory',
      resourceId: id,
      metadata: { ...body },
    });
    res.json({ category: result.category });
  } catch (err) {
    logger.error('Update task category error:', err);
    res.status(500).json({ error: 'Failed to update the category' });
  }
}

/**
 * DELETE /api/task-categories/:id - delete a category and keep, move or delete its tasks (slice 11).
 *
 * An admin can delete any task, so for them `delete_tasks` takes every task in the category
 * whatever its status or its people; any other role holding the category grant also needs
 * `delete Task` and access to each task. Deleted tasks go through the task-deletion service, like a
 * manual delete: its post-commit half (files, bell, one "Task is deleted" run per task) runs here,
 * after the transaction.
 */
export async function remove(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!isUuid(id)) return notFound(res);
    const body = req.body as z.infer<typeof deleteTaskCategorySchema>;
    const actor = { orgId: req.user!.organization_id, actorId: req.user!.id };

    // Deleting the tasks is deleting tasks: the category grant alone is not enough (security
    // review L1). A caller who can delete any task (manage all) takes every one; anyone else must
    // be able to open each task in the category, the same row rule a single task delete applies.
    if (body.mode === 'delete_tasks' && !(req.ability?.can('delete', 'Task') ?? false)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    const canDeleteAnyTask = req.ability?.can('manage', 'all') ?? false;

    const result = await deleteTaskCategory(prisma, actor, id, body, {
      canDeleteTask: canDeleteAnyTask ? undefined : (task) => canAccessTask(req, task),
    });
    if (!result.ok) {
      if (result.error === 'not_found') return notFound(res);
      if (result.error === 'forbidden') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      if (result.error === 'task_count_changed') {
        res.status(409).json({
          error: 'The number of tasks in this category changed. Check the new count and try again.',
          code: 'TASK_COUNT_CHANGED',
        });
        return;
      }
      if (result.error === 'invalid_target') {
        res.status(400).json({ error: 'Pick another category to move the tasks to.', code: 'INVALID_TARGET' });
        return;
      }
      res.status(400).json({ error: 'The name you typed does not match the category.', code: 'CONFIRM_MISMATCH' });
      return;
    }

    await announceTaskDeletions(actor, result.deletedTasks, result.attachmentPaths);

    void logAudit({
      req,
      action: 'task.category_deleted',
      resourceType: 'TaskCategory',
      resourceId: id,
      metadata: {
        name: result.category.name,
        mode: body.mode,
        task_count: result.taskCount,
        ...(result.target ? { target_id: result.target.id, target_name: result.target.name } : {}),
        ...(body.mode === 'delete_tasks' ? { deleted_task_numbers: result.deletedTasks.map((t) => t.task_number) } : {}),
      },
    });

    res.json({
      mode: body.mode,
      task_count: result.taskCount,
      target: result.target,
      deleted_task_ids: result.deletedTasks.map((t) => t.id),
    });
  } catch (err) {
    logger.error('Delete task category error:', err);
    res.status(500).json({ error: 'Failed to delete the category' });
  }
}
