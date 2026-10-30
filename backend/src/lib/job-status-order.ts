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

/** Takes the raw string too: a status that arrives as plain text (an automation's entity state, a message's job) is asked the same way. */
export function isCompletedOrLater(status: string | null | undefined): boolean {
  return status != null && (COMPLETED_OR_LATER_JOB_STATUSES as readonly string[]).includes(status);
}
