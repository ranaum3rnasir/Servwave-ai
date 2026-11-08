import { prisma } from '../prisma';

/**
 * Task id -> number of files on it, for the board card (visits-and-task-categories slice 12).
 *
 * Attachments are polymorphic (`entity_type` + `entity_id`, no relation), so Prisma's `_count`
 * cannot reach them. ONE grouped query for the whole set, never one per task; a task with no files
 * is simply absent from the map (callers read `?? 0`). Tenant-scoped by `orgId` as well as by the
 * ids, so a stray id from another org can never pick up that org's count.
 */
export async function taskAttachmentCounts(orgId: string, taskIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!taskIds.length) return out;
  const groups = await prisma.attachment.groupBy({
    by: ['entity_id'],
    where: { entity_type: 'TASK', organization_id: orgId, entity_id: { in: taskIds } },
    _count: { _all: true },
  });
  for (const g of groups) out.set(g.entity_id, g._count._all);
  return out;
}
