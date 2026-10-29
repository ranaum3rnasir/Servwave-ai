import { Request } from 'express';
import { prisma } from './prisma';
import { tenantWhere } from './tenant';

export type TagSummary = { id: string; name: string; color: string };
export type TagEntityType = 'CUSTOMER' | 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE';

/**
 * Load tags grouped by entity id, tenant-scoped via req.
 * Returns a Map<entity_id, TagSummary[]>; entities without tags are absent.
 */
export async function loadTagsByEntity(
  req: Request,
  entityType: TagEntityType,
  entityIds: string[]
): Promise<Map<string, TagSummary[]>> {
  if (entityIds.length === 0) return new Map();

  const assignments = (await prisma.tagAssignment.findMany({
    where: {
      entity_type: entityType,
      entity_id: { in: entityIds },
      ...tenantWhere(req),
    },
    select: {
      entity_id: true,
      tag: { select: { id: true, name: true, color: true } },
    },
    orderBy: { tag: { name: 'asc' } },
  })) ?? [];

  const grouped = new Map<string, TagSummary[]>();
  for (const a of assignments) {
    const list = grouped.get(a.entity_id) ?? [];
    list.push(a.tag);
    grouped.set(a.entity_id, list);
  }
  return grouped;
}

/** Convenience: tags for a single entity. Returns [] if none. */
export async function loadTagsForEntity(
  req: Request,
  entityType: TagEntityType,
  entityId: string
): Promise<TagSummary[]> {
  const grouped = await loadTagsByEntity(req, entityType, [entityId]);
  return grouped.get(entityId) ?? [];
}
