import type { Prisma, PrismaClient } from '@prisma/client';

export const TASK_ENTITY_TYPE = 'TASK';

export type TaskActivityType =
  | 'CREATED' | 'ASSIGNED' | 'UNASSIGNED'
  | 'WATCHER_ADDED' | 'WATCHER_REMOVED'
  | 'STATUS_CHANGED' | 'PRIORITY_CHANGED'
  | 'DUE_CHANGED' | 'COMMENTED' | 'NUDGED' | 'COMPLETED' | 'CANCELLED'
  // Written by `deleteTasks` (./deletion) and outlives the task row it names.
  | 'DELETED';

type Tx = PrismaClient | Prisma.TransactionClient;

export async function recordTaskActivity(
  tx: Tx,
  a: { taskId: string; orgId: string; actorId: string; type: TaskActivityType; description: string; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.timelineEvent.create({
    data: {
      organization_id: a.orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: a.taskId,
      event_type: a.type,
      description: a.description,
      metadata: a.metadata,
      created_by: a.actorId,
    },
  });
}

/**
 * Bulk sibling of `recordTaskActivity`, for a writer that holds many tasks at once.
 *
 * One INSERT per event is right for an interactive edit (a handful of them) and wrong for the
 * deactivation sweep, which can rewrite hundreds of tasks in one go: those INSERTs are sequential
 * round trips inside an interactive transaction, and Prisma closes one of those after 5s.
 * Batching costs no ordering - `created_at` defaults to now(), which is the TRANSACTION
 * timestamp, so rows written one at a time inside one transaction already shared it.
 */
export async function recordTaskActivities(
  tx: Tx,
  entries: Array<{ taskId: string; orgId: string; actorId: string; type: TaskActivityType; description: string; metadata?: Prisma.InputJsonValue }>,
): Promise<void> {
  if (!entries.length) return;
  await tx.timelineEvent.createMany({
    data: entries.map((a) => ({
      organization_id: a.orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: a.taskId,
      event_type: a.type,
      description: a.description,
      metadata: a.metadata,
      created_by: a.actorId,
    })),
  });
}

/**
 * id → display name, resolved by the CALLER (`resolveUserNames`) and handed in. The lookup is a
 * parameter, not a query, precisely so `diffTaskActivities` stays pure and synchronous — the
 * activity diff also feeds notification recipient resolution, and both callers want to compute it
 * once, before any transaction opens.
 */
export type TaskNameResolver = Map<string, string> | ((id: string) => string | undefined);

/** Arrays carry no FK (design §2), so an id that no longer resolves is expected, not an error. */
export const UNKNOWN_PERSON_LABEL = 'Unknown user';

function nameOf(resolver: TaskNameResolver | undefined, id: string): string {
  if (!resolver) return UNKNOWN_PERSON_LABEL;
  const name = typeof resolver === 'function' ? resolver(id) : resolver.get(id);
  return name && name.trim() ? name : UNKNOWN_PERSON_LABEL;
}

/** Normalise an unknown payload/row value into a de-duplicated list of ids. */
export function toIdSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

interface BA {
  status?: string;
  priority?: string;
  assignee_ids?: unknown;
  watcher_ids?: unknown;
  due_at?: Date | string | null;
}

type TaskActivity = { type: TaskActivityType; description: string };

export interface IdSetDelta { added: string[]; removed: string[] }

/**
 * Membership diff for one of the two people-lists — the SINGLE implementation.
 *
 * HAZARD this replaces: the old `after.owner_id !== before.owner_id` was a VALUE compare on a
 * scalar. Applied to an array it becomes a REFERENCE compare, so every PATCH that merely carried
 * `assignee_ids` would emit a spurious ASSIGNED event. Membership is what changed or did not.
 *
 * Exported because design §5 and §6 are the same diff seen twice: the activity feed turns it
 * into named events, the notification layer turns it into recipient lists. Two hand-rolled
 * diffs would eventually disagree about who was added, and the feed and the inbox would tell
 * two different stories about the same edit. `diffPeople` below is the only other caller.
 */
export function diffIdSets(before: unknown, after: unknown): IdSetDelta {
  // Field absent from the payload — nothing asserted. A FRESH object each time: callers own
  // what they are handed, and a shared constant would let one of them corrupt the others.
  if (after === undefined) return { added: [], removed: [] };
  const beforeIds = toIdSet(before);
  const afterIds  = toIdSet(after);
  return {
    added:   afterIds.filter((id) => !beforeIds.includes(id)),
    removed: beforeIds.filter((id) => !afterIds.includes(id)),
  };
}

/**
 * The four people-event phrasings, in ONE place.
 *
 * Exported because the interactive PATCH is no longer the only writer: the deactivation sweep
 * (`lib/tasks/deactivation.ts`) records the same events outside a diff. Two hand-written copies
 * of "unassigned Dana" would drift, and the feed would read as two different systems.
 */
export const PEOPLE_EVENT = {
  ASSIGNED:        { type: 'ASSIGNED'        as TaskActivityType, label: (n: string) => `assigned ${n}` },
  UNASSIGNED:      { type: 'UNASSIGNED'      as TaskActivityType, label: (n: string) => `unassigned ${n}` },
  WATCHER_ADDED:   { type: 'WATCHER_ADDED'   as TaskActivityType, label: (n: string) => `added ${n} as watcher` },
  WATCHER_REMOVED: { type: 'WATCHER_REMOVED' as TaskActivityType, label: (n: string) => `removed ${n} as watcher` },
} as const;

function diffPeople(
  before: unknown,
  after: unknown,
  names: TaskNameResolver | undefined,
  added:   { type: TaskActivityType; label: (name: string) => string },
  removed: { type: TaskActivityType; label: (name: string) => string },
): TaskActivity[] {
  const delta = diffIdSets(before, after);
  return [
    ...delta.added.map((id)   => ({ type: added.type,   description: added.label(nameOf(names, id)) })),
    ...delta.removed.map((id) => ({ type: removed.type, description: removed.label(nameOf(names, id)) })),
  ];
}

export function diffTaskActivities(before: BA, after: BA, names?: TaskNameResolver): TaskActivity[] {
  const out: TaskActivity[] = [];
  if (after.status !== undefined && after.status !== before.status) {
    // The two terminal statuses each get their own named event. Issue 03 keeps `completed_at`
    // null for a cancellation precisely because the timeline is where the abandonment is
    // recorded, so it cannot be a generic STATUS_CHANGED line.
    if (after.status === 'DONE') out.push({ type: 'COMPLETED', description: 'marked the task complete' });
    else if (after.status === 'CANCELLED') out.push({ type: 'CANCELLED', description: 'cancelled the task' });
    else out.push({ type: 'STATUS_CHANGED', description: `changed status to ${after.status}` });
  }
  if (after.priority !== undefined && after.priority !== before.priority)
    out.push({ type: 'PRIORITY_CHANGED', description: `changed priority to ${after.priority}` });

  // Design §6 — one NAMED event per person, on both lists, replacing the single
  // "reassigned the task" string. Watcher changes emitted no activity at all before this.
  out.push(...diffPeople(before.assignee_ids, after.assignee_ids, names,
    PEOPLE_EVENT.ASSIGNED, PEOPLE_EVENT.UNASSIGNED));
  out.push(...diffPeople(before.watcher_ids, after.watcher_ids, names,
    PEOPLE_EVENT.WATCHER_ADDED, PEOPLE_EVENT.WATCHER_REMOVED));

  if (after.due_at !== undefined && String(after.due_at ?? '') !== String(before.due_at ?? ''))
    out.push({ type: 'DUE_CHANGED', description: after.due_at ? 'changed the due date' : 'cleared the due date' });
  return out;
}
