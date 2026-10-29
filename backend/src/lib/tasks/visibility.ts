import type { Request } from 'express';
import { tenantWhere } from '../tenant';
import { entityAccessScope, ENTITY_DELEGATES } from './entityAccess';

export interface TaskListFilters { linked_entity_type?: string; linked_entity_id?: string; }

export function taskVisibilityWhere(req: Request, filters: TaskListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { ...tenantWhere(req) };
  if (filters.linked_entity_type && filters.linked_entity_id) {
    where.linked_entity_type = filters.linked_entity_type;
    where.linked_entity_id = filters.linked_entity_id;
    return where;
  }
  if (req.user!.role !== 'ADMIN') {
    const me = req.user!.id;
    // Design §4 — `created_by = me` is deliberately NOT an arm: creating is an event, not a role.
    where.OR = [{ assignee_ids: { has: me } }, { watcher_ids: { has: me } }];
  }
  return where;
}

/**
 * SQL row check for a task's polymorphic link (#245): can the caller access the linked entity?
 *
 * The policy itself is `entityAccessScope` - shared with the batched readers in entityAccess.ts so
 * the one-row question and the whole-list question cannot drift apart. This is the single-row
 * probe over it, and stays a findFirst: one id needs no `in`.
 */
export async function canAccessLinkedEntity(
  req: Request,
  type: string,
  id: string,
): Promise<boolean> {
  const scope = await entityAccessScope(req.user!, type, { ability: req.ability });
  const delegate = ENTITY_DELEGATES[type];
  if (!scope || !delegate) return false; // unknown linked type / no subject grant - fail closed
  return !!(await delegate.findFirst({ where: { id, ...scope.where }, select: { id: true } }));
}

/**
 * Per-row (own-or-linked) access policy for a loaded task (#245):
 *   ADMIN → always; principal (assignee / watcher) → always;
 *   otherwise linked → the caller must be able to access the linked entity;
 *   unlinked non-principal → denied.
 * Reads only fields the handlers' existing tenant findFirst already loaded.
 *
 * Design §4: `created_by` is audit-only and grants NOTHING, so it is no longer consulted here.
 * A creator who is neither assignee nor watcher loses access — unreachable in practice, because
 * create force-assigns (§3). The linked-entity fallthrough below is load-bearing: it is what
 * keeps the tasks tab on a job/lead page working for the crew on that job.
 */
export async function canAccessTask(
  req: Request,
  task: {
    assignee_ids: unknown;
    watcher_ids: unknown;
    linked_entity_type: string | null;
    linked_entity_id: string | null;
  },
): Promise<boolean> {
  if (req.user!.role === 'ADMIN') return true;
  const me = req.user!.id;
  if (Array.isArray(task.assignee_ids) && (task.assignee_ids as string[]).includes(me)) return true;
  if (Array.isArray(task.watcher_ids) && (task.watcher_ids as string[]).includes(me)) return true;
  if (task.linked_entity_type && task.linked_entity_id) {
    return canAccessLinkedEntity(req, task.linked_entity_type, task.linked_entity_id);
  }
  return false;
}
