/**
 * The job close-out rules a screen needs where the server's per-record answer is not at hand (Roles & Permissions,
 * PRD 6, S06.1). The server decides every close-out move (backend `lib/job-close-out.ts`, M7) and the job page reads its
 * answer (`job.actions`); a list or board row carries no such answer, so the one fact it needs - which statuses a
 * job-level Complete can start from - lives here, with a test that fails when it drifts from the server's list.
 */

/** The statuses a job-level Complete starts from. A job in any other status (Completed, Office review, Ready to close, Done, Cancelled) is not offered it. */
export const COMPLETABLE_JOB_STATUSES: readonly string[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];

export function isCompletableJobStatus(status: string | null | undefined): boolean {
  return status != null && COMPLETABLE_JOB_STATUSES.includes(status);
}

/**
 * "The work is done" (PRD 6's completed-or-later set): Completed and the close-out statuses after it. Cancelled is not
 * finished work. A screen that has to say a job is finished asks this instead of comparing against Completed, because a
 * job completed from now on rests in Office review and never at Completed. The backend's `lib/job-status-order.ts` owns
 * the set; a test fails when this copy drifts from it.
 */
export const COMPLETED_OR_LATER_JOB_STATUSES: readonly string[] = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'];

export function isCompletedOrLaterJobStatus(status: string | null | undefined): boolean {
  return status != null && COMPLETED_OR_LATER_JOB_STATUSES.includes(status);
}

/** The server's words when a closed job is asked to move (backend `REOPEN_FIRST_MESSAGE`); a board that refuses a move up front says the same. */
export const REOPEN_FIRST_MESSAGE = 'Reopen this job first';

/**
 * A job that leaves only through Reopen: Done and Cancelled. Every door that would move its time or set its status is
 * refused with `REOPEN_FIRST_MESSAGE` (the server's `statusDoorRefusal`), so a screen offers no drag of its card.
 */
export const CLOSED_JOB_STATUSES: readonly string[] = ['DONE', 'CANCELLED'];

export function isClosedJobStatus(status: string | null | undefined): boolean {
  return status != null && CLOSED_JOB_STATUSES.includes(status);
}
