import type { Request } from 'express';
import { tenantWhere } from '../tenant';
import { accessibleEntityRefs, entityAccessScope, entityRefKey, ENTITY_DELEGATES } from './entityAccess';

export interface TaskListFilters { linked_entity_type?: string; linked_entity_id?: string; }

/**
 * Does the caller see every task in the company (the "See all tasks" switch)? The one question the list, the
 * open check, the linked-record list and summary and the activity feed's file names all ask, so a custom role
 * copied from Admin is held to its switch like any other role. Fails closed with no ability attached.
 */
export function seesAllTasks(req: Request): boolean {
  return req.ability?.can('see_all', 'Task') ?? false;
}

export function taskVisibilityWhere(req: Request, filters: TaskListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { ...tenantWhere(req) };
  if (filters.linked_entity_type && filters.linked_entity_id) {
    where.linked_entity_type = filters.linked_entity_type;
    where.linked_entity_id = filters.linked_entity_id;
    return where;
  }
  if (!seesAllTasks(req)) {
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
 *   See all tasks → always; principal (assignee / watcher) → always;
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
  if (seesAllTasks(req)) return true;
  const me = req.user!.id;
  if (Array.isArray(task.assignee_ids) && (task.assignee_ids as string[]).includes(me)) return true;
  if (Array.isArray(task.watcher_ids) && (task.watcher_ids as string[]).includes(me)) return true;
  if (task.linked_entity_type && task.linked_entity_id) {
    return canAccessLinkedEntity(req, task.linked_entity_type, task.linked_entity_id);
  }
  return false;
}

/**
 * `canAccessTask` for a whole list at once: which of these tasks can the caller open? The same rule - See all tasks,
 * assignee or watcher, otherwise whoever can open the linked record - but the linked records are asked in ONE batched
 * read (at most one query per kind of record) instead of one probe per task. Never call `canAccessTask` in a loop over
 * a feed: on the hosted database's single connection a probe per task is a request that takes seconds.
 */
export async function openableTaskIds(
  req: Request,
  tasks: Array<{ id: string; assignee_ids: unknown; watcher_ids: unknown; linked_entity_type: string | null; linked_entity_id: string | null }>,
): Promise<Set<string>> {
  if (seesAllTasks(req)) return new Set(tasks.map((t) => t.id));
  const me = req.user!.id;
  const open = new Set<string>();
  const linked: Array<(typeof tasks)[number] & { linked_entity_type: string; linked_entity_id: string }> = [];
  for (const task of tasks) {
    if (Array.isArray(task.assignee_ids) && (task.assignee_ids as string[]).includes(me)) open.add(task.id);
    else if (Array.isArray(task.watcher_ids) && (task.watcher_ids as string[]).includes(me)) open.add(task.id);
    else if (task.linked_entity_type && task.linked_entity_id) linked.push({ ...task, linked_entity_type: task.linked_entity_type, linked_entity_id: task.linked_entity_id });
  }
  if (linked.length === 0) return open;
  const reachable = await accessibleEntityRefs(
    req.user!,
    linked.map((t) => ({ type: t.linked_entity_type, id: t.linked_entity_id })),
    { ability: req.ability },
  );
  for (const task of linked) if (reachable.has(entityRefKey(task.linked_entity_type, task.linked_entity_id))) open.add(task.id);
  return open;
}
