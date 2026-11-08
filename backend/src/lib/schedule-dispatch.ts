/**
 * The customer-facing schedule announcement, decided ONCE for every door that books a job.
 *
 * Scheduling-notifications PRD, "Job is scheduled fires on the date": "Job is scheduled" fires the
 * first time a job gains a scheduled start, whether or not a crew is named, from whichever door
 * booked it (POST /jobs/:id/assign or POST /jobs/:id/visits), and never fires again for that job.
 * A later move is "Job is rescheduled". A later crew change is "Technician is assigned", which is
 * a crew fact and not this decision's.
 *
 * Both doors used to decide this separately and disagreed: /assign required a crew in the same
 * save, the Visits tab fired on every new trip. Each door now states its facts and takes the
 * answer from here, so they cannot drift again.
 */

import { sameScheduleMinute } from './job-schedule-projection';

export type ScheduleDispatchEvent = 'JOB_SCHEDULED' | 'JOB_RESCHEDULED';

export interface ScheduleWriteFacts {
  /** The job's scheduled start before the write (its window across visits); null when it had none. */
  startBefore: Date | null;
  /** The start this write lands the trip on; the same as `startBefore` when nothing about the window was written. */
  startAfter: Date | null;
  /**
   * True when this write booked a FURTHER trip beside the ones the job holds (the Visits tab
   * door); false when it stated the job's own window (the Assign door), however the row write
   * was expressed - the window sync may move a live row or mint one for a job whose only live
   * trip's date has passed, and either way the customer's job MOVED.
   */
  additionalTrip: boolean;
  /** The once-per-job guard as read before the write: when the job's scheduling announcement already happened. */
  scheduledDispatchedAt: Date | null;
  /** The crew this write names. Never changes the answer; stated so the rule is tested rather than assumed. */
  crewCount: number;
}

export interface ScheduleDispatchDecision {
  event: ScheduleDispatchEvent | null;
  /** Write the once-per-job guard in the same transaction as the trip. True exactly when the event is JOB_SCHEDULED. */
  stampScheduledDispatched: boolean;
}

export function decideScheduleDispatch(facts: ScheduleWriteFacts): ScheduleDispatchDecision {
  if (facts.startBefore == null && facts.startAfter != null && facts.scheduledDispatchedAt == null) {
    return { event: 'JOB_SCHEDULED', stampScheduledDispatched: true };
  }
  if (
    facts.startBefore != null &&
    facts.startAfter != null &&
    !facts.additionalTrip &&
    facts.scheduledDispatchedAt != null &&
    !sameScheduleMinute(facts.startBefore, facts.startAfter)
  ) {
    return { event: 'JOB_RESCHEDULED', stampScheduledDispatched: false };
  }
  return { event: null, stampScheduledDispatched: false };
}
