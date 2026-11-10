import type { JobStatus } from '@prisma/client';

/**
 * The order a job moves through its statuses, first to last. Anything that has to say "at or past
 * Completed" says it against this list instead of naming statuses, so a status added later is placed
 * here once and every such reader follows. PRD 6's close-out states (Office review, Ready to close,
 * Done) sit between Completed and Cancelled. Cancelled sits last: a cancelled
 * job is past Completed for every reader that asks "is this job still live".
 *
 * `job-status-order.test.ts` fails when the schema has a status this list does not place.
 */
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  'UNSCHEDULED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'OFFICE_REVIEW',
  'READY_TO_CLOSE',
  'DONE',
  'CANCELLED',
];

/**
 * "The work is done": Completed and every close-out status after it, Cancelled excluded. The one backend definition
 * of the completed-or-later set (PRD 6): the places that today test for Completed alone as "work done" (scoreboards,
 * reports, tiles, derivation) ask this instead of naming statuses, so a status placed in the order above joins them
 * without another edit. Derived from the order, never listed.
 */
export const COMPLETED_OR_LATER_JOB_STATUSES: readonly JobStatus[] = JOB_STATUS_ORDER.slice(
  JOB_STATUS_ORDER.indexOf('COMPLETED'),
).filter((s) => s !== 'CANCELLED');

/**
 * A closed job, where ServWave picks or ties a customer, lead or job for a text or a call (#3013; Ran, 2026-11-05): Done
 * or Cancelled, nothing else. Completed, Office review and Ready to close are still open work. This is narrower than
 * "the work is done" above on purpose: a customer whose job is waiting on the office is still the one most likely to call.
 * Derived from the order: Done and everything after it.
 */
export const DONE_OR_CANCELLED_JOB_STATUSES: readonly JobStatus[] = JOB_STATUS_ORDER.slice(JOB_STATUS_ORDER.indexOf('DONE'));

/** Takes the raw string too: a status that arrives as plain text (an automation's entity state, a message's job) is asked the same way. */
export function isCompletedOrLater(status: string | null | undefined): boolean {
  return status != null && (COMPLETED_OR_LATER_JOB_STATUSES as readonly string[]).includes(status);
}
