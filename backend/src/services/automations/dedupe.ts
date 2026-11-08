/**
 * dedupe.ts — occurrence-identity keys for automation runs.
 *
 * The (rule_id, dedupe_key) unique constraint on automation_runs is the
 * engine's idempotency mechanism. The key must encode WHICH occurrence of the
 * trigger this run belongs to:
 *  - plain event triggers fire once per entity per rule,
 *  - reschedule/assignment/time triggers fire once per occurrence, so a
 *    rescheduled job automatically re-arms its reminder (new scheduled_start
 *    → new key) while the stale run is skipped at execution time.
 */

import { AutomationTriggerType } from '@prisma/client';
import { TASK_TRANSITIONS } from './taskTransitions';

/** Triggers whose dedupe key must include an occurrence discriminator. */
const OCCURRENCE_SCOPED: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_RESCHEDULED',   // occurrence = new scheduled_start ISO
  'TECH_ASSIGNED',     // occurrence = assigned user id
  'BEFORE_JOB_START',  // occurrence = scheduled_start ISO
  'AFTER_JOB_COMPLETED', // occurrence = completed_at ISO
  'WALKTHROUGH_SCHEDULED',        // occurrence = walkthrough_scheduled_at ISO
  'WALKTHROUGH_RESCHEDULED',      // occurrence = new walkthrough_scheduled_at ISO
  'WALKTHROUGH_PERFORMER_ASSIGNED', // occurrence = assigned performer user id
  'WALKTHROUGH_PERFORMER_REMOVED', // occurrence = removed performer user id
  'TECH_UNASSIGNED',   // occurrence = removed technician user id
  'JOB_EN_ROUTE',      // occurrence = en_route_at ISO
  'LEAD_ASSIGNED',                // occurrence = assigned owner user id
  'JOB_DATE_ANCHORED',       // occurrence = job.scheduled_start ISO (Task A2/A5)
  'LEAD_DATE_ANCHORED',      // occurrence = lead.walkthrough_scheduled_at ISO (Task A2/A5)
  'INVOICE_DATE_ANCHORED',   // occurrence = invoice.due_date ISO (Task A2/A5)
  'ESTIMATE_DATE_ANCHORED',  // occurrence = estimate.valid_until ISO (Task A2/A5)
  'JOB_SUB_STATUS_ENTERED',  // occurrence = sub_status_id (SRVW-113) - a job cycling A -> B -> A re-fires
  // Spec B: occurrence = the added assignee's user id. A task takes several people, added
  // one PATCH at a time, and each addition is its own occurrence. Keyed on the task alone,
  // the second person is swallowed as a duplicate of the first for the life of the task.
  'TASK_ASSIGNED',
  // Spec B: occurrence = the NOTE id. A comment is not a state a task is in, it is one of
  // many. Keyed on the task alone, only the FIRST comment on any task ever notifies and
  // every later one is swallowed as a duplicate of it, for the life of that task.
  'TASK_COMMENT_ADDED',
  // Spec B: occurrence = the task's due date ISO. Date-anchored triggers have no re-arm
  // mechanism by design - nothing is parked ahead of the fire moment - so the occurrence key
  // IS the anchor date and a moved due date is a genuinely new occurrence, picked up on a
  // later tick. Keyed on the task alone, a task fires its reminder exactly once ever and
  // moving the due date changes nothing.
  'TASK_DATE_ANCHORED',
  // The task status-transition triggers ("Task is done"): occurrence = the transition moment's
  // ISO. A task finished, reopened and finished again is two occurrences; keyed on the task alone
  // the second is swallowed as a duplicate of the first for the life of the task. Read off the
  // one registry (taskTransitions.ts) so a new transition trigger cannot be added without it.
  ...TASK_TRANSITIONS.map((t) => t.trigger),
] satisfies AutomationTriggerType[]);

export function isOccurrenceScoped(trigger: AutomationTriggerType): boolean {
  return OCCURRENCE_SCOPED.has(trigger);
}

/**
 * Multi-visit D18: when the CALLER supplies a visit id, it is spliced between
 * the entity id and the occurrence. Keyed on the parent job alone, visit 2's
 * "scheduled" notification is swallowed by the [workflow_id, dedupe_key] unique
 * constraint as a duplicate of visit 1's - the exact swallow D18 names.
 *
 * Scoping is driven purely by whether the CALLER asks for it. No member is added
 * to OCCURRENCE_SCOPED and no second set exists, so this helper gains NO new way
 * to throw. That matters: the throw is swallowed by createEnrollment's catch,
 * which logs at warn and returns null, i.e. the automation silently stops firing.
 *
 * WHO ASKS, AND WHY IT IS NOT "WHOEVER HAS A VISIT ID". Since the per-visit-
 * enrollment spec (2026-09-14) the three cron sweeps DO carry a visit id - they
 * persist it on the enrollment so the send resolves the right trip - and they
 * deliberately do not let it reach this function. createEnrollment gates that on
 * a separate `visitScopedDedupe` flag, set by the dispatch door alone, because
 * the two doors differ in the one property that matters here: a dispatch
 * occurrence is minted fresh at dispatch time (en_route_at, the new start), so a
 * visit-scoped key cannot collide with a historical one, while a cron occurrence
 * is a visit's FUTURE scheduled_at, which historical rows already hold. Widening
 * the key on the cron door would therefore stop those rows colliding and re-remind
 * every customer inside the trigger's lead-time window, once, on deploy day - and
 * it would buy nothing, since two trips at different times already mint two keys.
 *
 * The visit id goes ONLY here, never into occurrence_key. stopIf.ts and
 * terminalStale.ts compare occurrence_key against someDate.toISOString() and,
 * on a mismatch, return a stale-reason rather than erroring - widening that
 * format would quietly kill every anchored wait. rearmAnchoredWaits writes
 * occurrence_key and never dedupe_key, so it cannot clobber this either.
 *
 * REJECTED, and why - no data migration rewrites the two persisted ledgers
 * (workflow_enrollments.dedupe_key and automation_runs.dedupe_key):
 *  1. A dual probe (check the old job-only key as well) would suppress exactly
 *     the visit-2 enrollment D18 exists to create. It defeats the change.
 *  2. A rewrite migration is unnecessary. Every visit-scoped trigger's
 *     occurrence is either a freshly minted millisecond stamp (JOB_EN_ROUTE =
 *     en_route_at, JOB_RESCHEDULED = the new start) or already guarded
 *     once-per-job by a persisted column (JOB_SCHEDULED via
 *     Job.customer_scheduled_email_sent_at, the "scheduled announcement already
 *     dispatched" guard both booking doors set through decideScheduleDispatch;
 *     its name notwithstanding it is not a receipt). So a historical row that stops
 *     colliding has nothing left that would re-dispatch it.
 */
export function buildDedupeKey(
  trigger: AutomationTriggerType,
  entityId: string,
  occurrence?: string,
  visitId?: string,
): string {
  const scope = visitId ? `${entityId}:${visitId}` : entityId;
  if (OCCURRENCE_SCOPED.has(trigger)) {
    if (!occurrence) {
      throw new Error(`buildDedupeKey: trigger ${trigger} requires an occurrence key`);
    }
    return `${trigger}:${scope}:${occurrence}`;
  }
  return `${trigger}:${scope}`;
}
