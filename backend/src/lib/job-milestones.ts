/**
 * Backward-move policy for the job lifecycle bar (Spec B1).
 *
 * This module is STILL required after multi-visit S5 removed the bar's forward-fill (D11a), and
 * the reason changed rather than went away. The old justification was that `reached` painted
 * itself from LATER stages, so a backward move was invisible unless those were cleared. Under
 * per-node truth a node lights only while its OWN column holds a stamp - which is exactly why the
 * clears still matter: a backward move that left completed_at set would light Completed forever.
 * This module is the single source of truth for what each milestone clears - one place to read,
 * one place to change.
 *
 * Two invariants worth stating out loud, because both are load-bearing:
 *
 *  1. `scheduled_start` / `scheduled_end` / `is_all_day` are NEVER cleared - trivially true since
 *     S8 (RATIFIED, A5): they are no longer JOB columns at all, only a computed projection of the
 *     visit set. Nothing precedes Scheduled but Job Created, which is not actionable, so the rule
 *     they existed to express (clearing them would drop the job out of the board's date-range
 *     query and misfire the JOB_SCHEDULED-vs-JOB_RESCHEDULED automation branch) is unchanged -
 *     there is simply nothing left here to name.
 *
 *  2. Invoice and payment state is NEVER touched. You cannot un-send an invoice or un-receive a
 *     payment by clicking a job node; those reverse through void and refund. Clicking Completed
 *     on a job whose invoice is already sent moves the job and leaves the invoice alone.
 *
 * Also deliberately preserved: `completion_notes` and `signature_*` (work product - still valid
 * on re-completion) and `customer_scheduled_email_sent_at` (the once-per-job "scheduled
 * announcement already dispatched" guard, see lib/schedule-dispatch.ts; clearing it announces the
 * job to the customer a second time).
 *
 * S8 (RATIFIED): `en_route_at` / `on_site_at` DROPPED from `LATER_TIMESTAMPS.scheduled` below.
 * They were the JOB-level milestone mirror; S8's DROP migration removes the columns entirely
 * (every reader of those two names is on the VISIT - see the migration header). The visit's OWN
 * `en_route_at`/`on_site_at` are untouched by this bar - a job-level backward move to Scheduled
 * has never rewound a visit's own history, only the job row's copy of it.
 */

export type Milestone = 'scheduled' | 'on_site' | 'started' | 'completed';

/** Later-stage timestamps each milestone nulls, in bar order. */
const LATER_TIMESTAMPS: Record<Milestone, readonly string[]> = {
  scheduled: ['started_at', 'completed_at'],
  on_site: ['started_at', 'completed_at'],
  started: ['completed_at'],
  completed: [],
};

/**
 * The `data` fragment to spread into a job update for `milestone`. Every milestone also
 * un-cancels: cancellation is not terminal, so moving a cancelled job anywhere revives it.
 */
export function milestoneClears(milestone: Milestone): Record<string, null> {
  const out: Record<string, null> = {};
  for (const field of LATER_TIMESTAMPS[milestone]) out[field] = null;
  out.cancelled_at = null;
  out.cancelled_reason = null;
  return out;
}

/**
 * Does this milestone null `completed_at`? A transition that does must also revert the linked
 * PlanVisit - `complete()` cascades it to COMPLETED, and every uncompleting move has to put it
 * back, or servicePlans/derive.ts keeps counting the visit as consumed and `visits_remaining`
 * stays permanently decremented.
 *
 * This docstring used to record `reopen()` as a LIVE BUG on exactly that count. Multi-visit S4
 * fixed it: reopen() now calls revertPlanVisitOnUncomplete like start() and arrive() do, and
 * job-visits.test.ts holds the regression case. Per-visit completion is what made it worth
 * fixing rather than filing - it runs this path far more often.
 */
export function clearsCompletion(milestone: Milestone): boolean {
  return LATER_TIMESTAMPS[milestone].includes('completed_at');
}
