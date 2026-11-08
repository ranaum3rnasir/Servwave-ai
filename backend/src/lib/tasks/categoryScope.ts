import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';

/** Refusal copy when a task names a category that is not in the caller's organization. */
export const UNKNOWN_TASK_CATEGORY = 'That category does not exist.';

/**
 * True when `categoryId` names a task category in the caller's organization. Another
 * organization's category is indistinguishable from one that does not exist - the tenant filter
 * IS the check (slice 08: "a category id from another organization is refused").
 */
export async function isTaskCategoryInOrg(req: Request, categoryId: string): Promise<boolean> {
  const row = await prisma.taskCategory.findFirst({
    where: { id: categoryId, ...tenantWhere(req) },
    select: { id: true },
  });
  return row !== null;
}

/**
 * True when a task write failed because its category is gone - deleted by an admin between
 * `isTaskCategoryInOrg` and the write (code review #6). The foreign key refuses it (Prisma P2003 on
 * `tasks_category_id_fkey`), which is the same fact as "no such category", so the caller answers
 * the same 400 instead of a generic 500. Any other foreign key is not this.
 */
export function isMissingTaskCategoryError(err: unknown): boolean {
  const e = err as { code?: string; meta?: { constraint?: unknown; field_name?: unknown } } | null;
  if (e?.code !== 'P2003') return false;
  const where = String(e.meta?.constraint ?? e.meta?.field_name ?? '');
  return where.includes('tasks_category_id_fkey');
}
