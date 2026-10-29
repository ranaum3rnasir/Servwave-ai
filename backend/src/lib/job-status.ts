import type { JobStatus, VisitStatus } from '@prisma/client';
import { LIVE_VISIT_STATUSES } from './visit-status';

/**
 * Multi-visit S4, D12: derive a job's status from its visit set.
 *
 * UNSCHEDULED means no live visits (D16). SCHEDULED means visits exist and none has been worked.
 * IN_PROGRESS means work has begun - a visit started, a visit finished, or the JOB itself started
 * before any visit existed (the urgent workflow). COMPLETED and CANCELLED are explicit, human-set
 * facts and are NEVER derived - the first clause below is the whole guard. A CANCELLED VISIT is
 * not evidence of anything: its stamps are kept as history and must not be read as work done.
 *
 * Returns `undefined` to mean "write nothing", not `current`. The difference is load-bearing: a
 * caller spreading `{ status: current }` would still clear the org-defined sub_status through any
 * subStatusClears spread, so a derivation that decided nothing had changed would silently blank a
 * dispatcher's sub-status.
 *
 * Ordering is the implementation. The started check MUST precede the live-set check: a job whose
 * only visit has just been COMPLETED has an EMPTY live set, and a naive
 * `if (noLiveVisits) return 'UNSCHEDULED'` written first silently demotes the job that was just
 * worked. That is the #1550 class - job status is UNORDERED (Spec B1), so this is keyed on the two
 * human-set values ONLY, as a whitelist of what may be derived, never as a blacklist of positions.
 *
 * Lives beside job-milestones.ts and job-sub-status.ts rather than in the visit service or the
 * controller: walkthrough.service.ts consumes it, and a service importing a controller export is
 * exactly the shape that made mirrorNextVisitOntoJob duplicate deriveStatusOnReschedule's rule in
 * a comment instead of sharing it.
 */
export function deriveJobStatus(
  current: JobStatus,
  visits: { status: VisitStatus; started_at: Date | null }[],
  jobStartedAt: Date | null = null,
): JobStatus | undefined {
  if (current === 'COMPLETED' || current === 'CANCELLED') return undefined;
  return deriveJobStatusFromVisits(visits, jobStartedAt);
}

/**
 * The same rule with the human-set guard REMOVED, for the one caller that is itself the human
 * leaving a terminal state: the lifecycle bar's backward move.
 *
 * `milestoneClears` nulls cancelled_at / cancelled_reason / completed_at on that move, so the
 * evidence of the terminal state is being erased in the same write. Leaving `status` at CANCELLED
 * there produces a job that still reads Cancelled everywhere with no record of why, which nothing
 * ever re-derives - deriveJobStatus above is precisely the thing that refuses to touch it. Every
 * other caller must go through deriveJobStatus and keep the guard.
 */
export function deriveJobStatusFromVisits(
  visits: { status: VisitStatus; started_at: Date | null }[],
  jobStartedAt: Date | null = null,
): JobStatus {
  // The JOB's own start stamp counts as much as a visit's, and the urgent workflow is why: a job
  // created UNSCHEDULED and started on the spot has no visit at all, so the whole visit set says
  // "nobody has started" while the crew is in the customer's house. Booking the return trip then
  // derived SCHEDULED over a running job, dropping it out of the board's in-flight colouring and
  // out of the in_progress KPI tile. Story 45 is exactly that flow.
  if (jobStartedAt != null) return 'IN_PROGRESS';
  // Nullish, not `!== null`: an absent column and an explicit null are the same fact here.
  //
  // A COMPLETED visit counts as work done whether or not it carries a start stamp. The card
  // offers Complete straight from EN_ROUTE and ON_SITE, so a finished trip can genuinely have no
  // started_at - and keying this clause on the stamp alone let that job fall through to an empty
  // live set and derive UNSCHEDULED, which is the #1550 demotion this ordering exists to forbid.
  // CANCELLED rows are excluded: the row is kept as history (D19) and keeps its stamps, so a trip
  // that was started and then called off would otherwise pin the job IN_PROGRESS for ever - there
  // is no live visit left to schedule it and no route that can un-start a visit.
  const notCalledOff = visits.filter((v) => v.status !== 'CANCELLED');
  if (notCalledOff.some((v) => v.started_at != null || v.status === 'COMPLETED')) return 'IN_PROGRESS';
  if (visits.some((v) => (LIVE_VISIT_STATUSES as readonly string[]).includes(v.status))) {
    return 'SCHEDULED';
  }
  return 'UNSCHEDULED';
}
