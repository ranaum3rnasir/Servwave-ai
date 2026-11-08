/**
 * deactivation.ts — strip a deactivated user out of the two task people-lists.
 *
 * `assignee_ids` / `watcher_ids` are Postgres uuid arrays, and an array carries no foreign key,
 * so nothing in the database removes a user's id when that user is deactivated. Readers tolerate
 * the miss (`name: null`), which stops the UI crashing but leaves a task assigned to somebody who
 * no longer works here. A task whose ONLY assignee is deactivated is the bad case: it satisfies
 * the ">= 1 assignee" invariant while being assigned to nobody real, so it drops off every
 * workload view and nobody is accountable for it.
 *
 * Deactivation, not deletion, is the trigger: a User is referenced from too many relations to be
 * deletable (see DELETE_BLOCKING_RELATIONS), so `is_active: false` is the only way a seat is ever
 * freed. Both routes that can flip it call in here — `PATCH /api/users/:id` and
 * `DELETE /api/users/:id`.
 *
 * Removal is ONE-WAY by design (issue 02): re-activating a user restores their login, not their
 * place on tasks somebody else has since been made responsible for.
 *
 * ── The rule lives in TWO places, and they are kept identical ────────────────────────────────
 *
 * `applyTaskPeopleRule` below and the SQL in
 * `prisma/migrations/20260825120000_task_people_arrays_drop_inactive/migration.sql` decide the
 * same thing: keep only the ids that name an ACTIVE user of the task's OWN organization, and if
 * that empties `assignee_ids`, hand the task to its still-active creator, else to the org's
 * longest-serving active ADMIN, else leave the array alone and count it as stranded.
 *
 * What differs between them is the SCOPE, not the rule:
 *
 *   * this module looks only at the tasks that name the user being deactivated, in that user's
 *     org, because that is the transition it reacts to. The migration looks at every task in
 *     every org, because it is repairing everything that accumulated before this existed.
 *   * the migration writes no timeline entries and sends no notifications. A backfill has no
 *     actor to attribute them to.
 *   * `toIdSet` here de-duplicates; the SQL's `ARRAY(SELECT ... unnest)` does not. An
 *     `assignee_ids` of `{a,a}` with `a` still active comes back `[a]` from this module and
 *     `{a,a}` from the migration. Left as is on purpose: both satisfy the ">= 1 assignee"
 *     invariant, no writer produces a duplicate in the first place, and the DISTINCT that would
 *     close it would also throw away the array's order.
 *
 * Anything else that comes apart is a defect in one of the two. `task-people-rule.test.ts` pins
 * the rule case by case and re-reads the migration's load-bearing predicates.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import { PEOPLE_EVENT, recordTaskActivities, toIdSet, type TaskActivityType } from './activity';
import { resolveUserNames } from './enrich';
import { emit } from '../../services/notifications/notificationService';
import { loadRoleHolders } from '../../services/notifications/roleHolders';
import { dispatchAutomationEvent } from '../../services/automations/dispatch';

/**
 * Why a task's sole-assignee slot went to the person it went to.
 *
 * `creator`  — the task's `created_by`, who asked for the work and is still active here.
 * `admin`    — the creator is inactive too (or is the person being deactivated), so the task
 *              escalates to the org's LONGEST-SERVING active ADMIN: `role = 'ADMIN'`,
 *              `is_active`, ordered by `created_at` then `id`. Deterministic (two admins created
 *              in the same transaction still resolve the same way twice) and org-scoped. An ADMIN
 *              can already read every task, so the escalation grants nothing new; it only puts a
 *              name against the work.
 */
export type FallbackReason = 'creator' | 'admin';

export interface TaskReassignment {
  task_id: string;
  task_number: string;
  title: string;
  to: string;
  reason: FallbackReason;
}

export interface TaskDeactivationSweep {
  /** Tasks that named the user on either list. */
  matched: number;
  /** Tasks actually rewritten, i.e. those in a chunk that COMMITTED. */
  updated: number;
  /**
   * Tasks this sweep meant to rewrite and did not, because a chunk failed and the loop stopped.
   * Their rows still name the departing user, so the next sweep of that user picks them up.
   */
  failed: number;
  reassigned: TaskReassignment[];
  /**
   * Tasks whose assignee list held nobody active and whose org offered no fallback at all.
   * Their `assignee_ids` is left exactly as it was: a dangling id is bad, but an empty list is
   * worse — it is invisible to every view instead of merely wrong in one.
   *
   * NOT theoretical. `wouldRemoveLastAdmin` only refuses to deactivate the last active ADMIN when
   * the TARGET is an admin; deactivating a technician in an org that already has no active admin
   * walks straight into this branch.
   */
  stranded: string[];
}

const emptySweep = (): TaskDeactivationSweep => ({ matched: 0, updated: 0, failed: 0, reassigned: [], stranded: [] });

/**
 * How many tasks one interactive transaction is allowed to rewrite.
 *
 * A single transaction spanning the whole sweep was the shape this started as, and it does not
 * survive contact with a user who is solely assigned to a few hundred tasks: Prisma's interactive
 * transactions time out at 5s by default, so the sweep would roll back entirely and the caller
 * would see only a log line. Chunking bounds every transaction to ~26 statements.
 *
 * What chunking costs, stated precisely, because "re-running is idempotent anyway" is true of the
 * DATA and false of everything else:
 *
 *   * DATA - recovered by a re-run. A chunk that failed left its tasks still naming the departing
 *     user, so the next sweep selects them again and finishes the job. A chunk that committed is
 *     not selected again, so nothing is rewritten twice and nothing is announced twice.
 *   * NOTIFICATIONS and the AUDIT ROW - recovered only inside THIS request. A re-run cannot do it
 *     for them: those tasks no longer name the departing user, so a second sweep never sees them.
 *     That is why the loop below returns what it committed instead of throwing it away.
 *   * NOT recovered at all: a crash between a chunk's COMMIT and the announcement. Those new
 *     owners are never told they own the work. The task is in their list either way, which is why
 *     this is the accepted floor rather than an outbox table.
 */
const TASKS_PER_TRANSACTION = 25;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** The org's longest-serving active ADMIN, excluding the user being deactivated. */
async function escalationTarget(orgId: string, userId: string): Promise<string | null> {
  const admin = await prisma.user.findFirst({
    where: { organization_id: orgId, role: 'ADMIN', is_active: true, id: { not: userId } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return admin?.id ?? null;
}

export interface TaskPeopleRuleInput {
  assignee_ids: string[];
  watcher_ids: string[];
  created_by: string;
  /**
   * "Does this id name an active user of THIS task's organization?" - the entire rule turns on
   * it. Both halves matter: an id that names an active user of a DIFFERENT tenant is just as
   * dangling as one that names nobody, and must not be kept on the strength of being active
   * somewhere else.
   */
  isActiveHere: (id: string) => boolean;
  /** The org's longest-serving active ADMIN, or null if it has none. */
  admin: string | null;
}

export interface TaskPeopleRuleOutput {
  assignee_ids: string[];
  watcher_ids: string[];
  handoverTo: string | null;
  reason: FallbackReason | null;
  stranded: boolean;
}

/**
 * The rule, as a pure function, so that the thing the SQL backfill has to agree with is one
 * readable expression rather than a control-flow shape spread through a sweep.
 *
 * Note what it does NOT do: a task whose `assignee_ids` is ALREADY empty is left empty. Inventing
 * an assignee for a row nobody has broken is not this rule's job, and the migration skips such a
 * row for the same reason (its predicate is "this task still names a non-active user").
 *
 * One thing it does that the SQL does not: `toIdSet` de-duplicates. `{a,a}` with `a` active is
 * `[a]` here and stays `{a,a}` there. See the header for why that is left alone.
 */
export function applyTaskPeopleRule(input: TaskPeopleRuleInput): TaskPeopleRuleOutput {
  const assignees = toIdSet(input.assignee_ids);
  const watcher_ids = toIdSet(input.watcher_ids).filter(input.isActiveHere);
  const kept = assignees.filter(input.isActiveHere);

  if (kept.length > 0 || assignees.length === 0) {
    return { assignee_ids: kept, watcher_ids, handoverTo: null, reason: null, stranded: false };
  }

  const to = input.isActiveHere(input.created_by) ? input.created_by : input.admin;
  if (!to) {
    return { assignee_ids: assignees, watcher_ids, handoverTo: null, reason: null, stranded: true };
  }
  return {
    assignee_ids: [to],
    watcher_ids,
    handoverTo: to,
    reason: to === input.created_by ? 'creator' : 'admin',
    stranded: false,
  };
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Remove every id that no longer names an active member of the org from `assignee_ids` and
 * `watcher_ids`, on the tasks that name `userId`, repairing the ">= 1 assignee" invariant where
 * that would have emptied the list.
 *
 * The trigger is one user's deactivation; the rule applied to the rows it touches is the whole
 * rule, not "delete this one id". A task carrying `[someoneStrandedLastMonth, theDepartingUser]`
 * would otherwise come out of a "delete this one id" sweep assigned solely to a dangling id -
 * which is the precise defect this module exists to prevent.
 *
 * Scoped to ONE organization. A user belongs to exactly one org and their id can only be on that
 * org's tasks, but the scope is written explicitly rather than inferred: an unscoped array
 * predicate would happily sweep another tenant's rows.
 *
 * Best-effort at the call sites: the seat is already freed by the time this runs, and a failure
 * here must not turn a completed deactivation into a 500. What it leaves behind is exactly what
 * the backfill migration repairs, so the failure mode is "stale until the next backfill", not
 * "lost".
 */
export async function sweepDeactivatedUserFromTasks(args: {
  orgId: string;
  userId: string;
  actorId: string;
}): Promise<TaskDeactivationSweep> {
  const { orgId, userId, actorId } = args;

  const tasks = await prisma.task.findMany({
    where: {
      organization_id: orgId,
      OR: [{ assignee_ids: { has: userId } }, { watcher_ids: { has: userId } }],
    },
    select: {
      id: true, task_number: true, title: true,
      assignee_ids: true, watcher_ids: true, created_by: true,
    },
  });
  if (!tasks.length) return emptySweep();

  const result = emptySweep();
  result.matched = tasks.length;

  // ONE membership probe for every id these tasks name, creators included. `is_active` AND
  // `organization_id` together are the question; see TaskPeopleRuleInput.isActiveHere.
  const named = new Set<string>();
  for (const t of tasks) {
    for (const id of toIdSet(t.assignee_ids)) named.add(id);
    for (const id of toIdSet(t.watcher_ids)) named.add(id);
    named.add(t.created_by);
  }
  named.delete(userId);
  const activeHere = new Set(
    named.size
      ? (await prisma.user.findMany({
          where: { id: { in: [...named] }, organization_id: orgId, is_active: true },
          select: { id: true },
        })).map((u) => u.id)
      : [],
  );
  // The routes flip `is_active` BEFORE calling in here, so the probe already excludes the
  // departing user. Stated anyway: the rule must not depend on that ordering.
  activeHere.delete(userId);
  const isActiveHere = (id: string) => activeHere.has(id);

  // Only pay for the admin lookup if some task actually escalates.
  const needsEscalation = tasks.some((t) => {
    const assignees = toIdSet(t.assignee_ids);
    return assignees.length > 0 && !assignees.some(isActiveHere) && !isActiveHere(t.created_by);
  });
  const admin = needsEscalation ? await escalationTarget(orgId, userId) : null;

  type Pending = {
    task: (typeof tasks)[number];
    data: { assignee_ids?: string[]; watcher_ids?: string[] };
    droppedAssignees: string[];
    droppedWatchers: string[];
    handover: TaskReassignment | null;
  };
  const pending: Pending[] = [];
  const displayIds = new Set<string>();

  for (const task of tasks) {
    const assignees = toIdSet(task.assignee_ids);
    const watchers = toIdSet(task.watcher_ids);
    const next = applyTaskPeopleRule({
      assignee_ids: assignees,
      watcher_ids: watchers,
      created_by: task.created_by,
      isActiveHere,
      admin,
    });
    if (next.stranded) result.stranded.push(task.id);

    const assigneesChanged = !sameIds(next.assignee_ids, assignees);
    const watchersChanged = !sameIds(next.watcher_ids, watchers);
    if (!assigneesChanged && !watchersChanged) continue;

    const droppedAssignees = assignees.filter((id) => !next.assignee_ids.includes(id));
    const droppedWatchers = watchers.filter((id) => !next.watcher_ids.includes(id));
    for (const id of [...droppedAssignees, ...droppedWatchers]) displayIds.add(id);
    if (next.handoverTo) displayIds.add(next.handoverTo);

    pending.push({
      task,
      data: {
        ...(assigneesChanged ? { assignee_ids: next.assignee_ids } : {}),
        ...(watchersChanged ? { watcher_ids: next.watcher_ids } : {}),
      },
      droppedAssignees,
      droppedWatchers,
      handover: next.handoverTo && next.reason
        ? { task_id: task.id, task_number: task.task_number, title: task.title, to: next.handoverTo, reason: next.reason }
        : null,
    });
  }
  if (!pending.length) {
    if (result.stranded.length) logStranded(orgId, userId, result.stranded);
    return result;
  }

  const names = await resolveUserNames(orgId, [...displayIds]);
  const nameOf = (id: string) => names.get(id) || 'Unknown user';
  const event = (e: { type: TaskActivityType; label: (n: string) => string }, id: string) =>
    ({ type: e.type, description: e.label(nameOf(id)) });
  const eventsFor = (p: Pending) => [
    ...p.droppedAssignees.map((id) => event(PEOPLE_EVENT.UNASSIGNED, id)),
    ...p.droppedWatchers.map((id) => event(PEOPLE_EVENT.WATCHER_REMOVED, id)),
    ...(p.handover ? [event(PEOPLE_EVENT.ASSIGNED, p.handover.to)] : []),
  ];

  // Chunked: see TASKS_PER_TRANSACTION. Task rewrite + its activity entries stay in one
  // transaction, so no task is ever rewritten without the feed saying why.
  //
  // A failed chunk does NOT abandon the finished ones. Letting the exception out of here threw
  // away `reassigned`, so the handovers that had already committed were never announced and the
  // deactivation was never audited - and no re-run could make that good, because those tasks no
  // longer name the departing user.
  const committed: Pending[] = [];
  let failure: unknown = null;

  for (let i = 0; i < pending.length; i += TASKS_PER_TRANSACTION) {
    const chunk = pending.slice(i, i + TASKS_PER_TRANSACTION);
    try {
      await prisma.$transaction(async (tx) => {
        for (const p of chunk) {
          await tx.task.update({ where: { id: p.task.id }, data: p.data });
        }
        await recordTaskActivities(
          tx,
          chunk.flatMap((p) => eventsFor(p).map((e) => ({
            taskId: p.task.id, orgId, actorId, type: e.type, description: e.description,
          }))),
        );
      }, TX_OPTIONS);
      committed.push(...chunk);
    } catch (err) {
      // STOP rather than try the next chunk. Every failure this can plausibly see is systemic -
      // a lost connection, a saturated pool (P2024), a transaction past its ceiling (P2028) -
      // because the statements are a uuid[] rewrite and one insert, with no per-row constraint
      // that one chunk could violate and the next not. Marching on would only pay `maxWait`
      // again per remaining chunk, inside a request that has not answered yet.
      failure = err;
      break;
    }
  }

  result.updated = committed.length;
  result.failed = pending.length - committed.length;
  result.reassigned = committed.map((p) => p.handover).filter((h): h is TaskReassignment => !!h);
  if (failure) {
    logger.error(
      `Task people-array sweep stopped after ${result.updated} of ${pending.length} task(s) ` +
      `(org ${orgId}, user ${userId}); the committed ones are announced and audited, the ` +
      `remaining ${result.failed} still name the user and are left for the next sweep:`,
      failure,
    );
  }
  if (result.stranded.length) logStranded(orgId, userId, result.stranded);
  return result;
}

/**
 * How many stranded task ids the error log and the audit row carry.
 *
 * A count alone pages somebody who then has no way to find the rows: `assignee_ids` is a uuid[]
 * with no FK, so there is no join that finds "tasks assigned to nobody real" without re-deriving
 * the whole rule. The ids are the actionable part; the cap keeps one deactivation from writing a
 * log line the size of the org's task table.
 */
export const STRANDED_IDS_REPORTED = 20;

function logStranded(orgId: string, userId: string, taskIds: string[]): void {
  const shown = taskIds.slice(0, STRANDED_IDS_REPORTED);
  const rest = taskIds.length - shown.length;
  logger.error(
    `Task assignee sweep found no active admin to escalate to (org ${orgId}, user ${userId}): ` +
    `${taskIds.length} task(s) keep a deactivated assignee: ${shown.join(', ')}` +
    (rest > 0 ? ` (+${rest} more)` : ''),
  );
}

/**
 * Tell each fallback assignee they now own somebody else's task - by bell AND by email.
 *
 * Landing responsibility for work a person never asked for is precisely what `task.assigned`
 * exists to announce, so no new verb is invented here. The people merely REMOVED get nothing:
 * the only one removed is the account that was just deactivated, and it can no longer sign in.
 *
 * Spec B: the same moment also dispatches TASK_ASSIGNED. Somebody inherited work in flight
 * without asking for it and was not in the app when it happened, which is the case most in
 * need of an email rather than a bell they may never open. One event per reassigned task,
 * discriminated by the inheriting user's id (the trigger is occurrence-scoped, and without
 * that key buildDedupeKey throws into createEnrollment's catch and nothing enrols at all).
 * The inheriting person's own row rides `eventPayload.recipient`, which is what the
 * `assigned_user` audience reads; addressing this to the live roster would instead re-email
 * whoever else is on the task.
 *
 * NOT awaited by the deactivation request, deliberately. `emit` ends in
 * `publishNotificationsChanged`, which opens, joins and tears down one Supabase Realtime channel
 * PER RECIPIENT PER TASK. A user solely assigned to a few hundred tasks would hold the
 * deactivation response open for that many channel round trips. The database repair is already
 * committed by the time this starts and the new owner sees the task in their list either way, so
 * the in-app ping is the only thing that can be late.
 *
 * Never throws: `emit` swallows its own errors by contract, and the rest is guarded here.
 */
export async function announceTaskHandovers(
  orgId: string,
  actorId: string,
  reassigned: TaskReassignment[],
): Promise<void> {
  if (!reassigned.length) return;
  try {
    // Loaded once and handed in - emit() would otherwise re-query it per task.
    const roleHolders = await loadRoleHolders(orgId).catch(() => undefined);
    // One org-scoped, active-only lookup for every inheriting person, rather than one per
    // task: a user solely assigned to hundreds of tasks escalates to a handful of names.
    const inheritors = await prisma.user.findMany({
      where: { id: { in: [...new Set(reassigned.map((r) => r.to))] }, organization_id: orgId, is_active: true },
      select: { id: true, email: true, first_name: true, last_name: true, phone: true },
    });
    for (const r of reassigned) {
      await emit({
        verb: 'task.assigned',
        organizationId: orgId,
        actorId,
        object: { type: 'TASK', id: r.task_id, label: r.title },
        entity: { added_assignee_ids: [r.to], ...(roleHolders ? { roleHolders } : {}) },
        data: { task_number: r.task_number },
      });
      const inheritor = inheritors.find((u) => u.id === r.to);
      dispatchAutomationEvent({
        type: 'TASK_ASSIGNED',
        organizationId: orgId,
        // The TITLE, as everywhere else a task names itself to a reader.
        entity: { type: 'task', id: r.task_id, label: r.title },
        occurrenceKey: r.to,
        // The admin who deactivated the departing user, NOT the person inheriting the work -
        // so Rule 0 suppresses this email in the one case where it should, an admin who ends
        // up holding the task themselves, and in no other.
        actorId,
        ...(inheritor ? { eventPayload: { recipient: inheritor } } : {}),
      });
    }
  } catch (err) {
    logger.error('Task handover announcement failed:', err);
  }
}
