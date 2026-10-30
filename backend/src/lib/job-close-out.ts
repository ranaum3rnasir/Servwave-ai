import type { JobStatus } from '@prisma/client';

/**
 * M7 - the job close-out state machine (Roles & Permissions, PRD 6). One pure module decides every close-out move: the
 * input is the job's status, the move and the person's switch values; the output is "allowed, and the job lands here"
 * or "refused, with a plain reason". The routes and the answer the job page reads both ask it, so a hidden control and
 * a refused request always give the same reason.
 *
 * S06.1 builds the Complete move, S06.12 the Finish review move, S06.13 the Mark Done move, S06.15 the Cancel move and S06.16
 * the Reopen move. S06.17 makes every other door that sets a job's status ask `statusDoorRefusal` first, so a Done or
 * Cancelled job leaves only through Reopen. S06.18 adds the backward move out of Office review and Ready to close (`back_out`)
 * and folds the doors' three questions into `statusDoorAnswer`. None of them is decided anywhere else.
 */

/** The machine-readable code on a close-out move refused because of where the job stands. */
export const JOB_CLOSE_OUT_REFUSED = 'JOB_CLOSE_OUT_REFUSED';

/** The refusal for any move out of Cancelled (and Done): the only way back is Reopen. */
export const REOPEN_FIRST_MESSAGE = 'Reopen this job first';

/** The refusal for a new visit on a job in Office review or Ready to close: the way out is a backward move, not Reopen. */
export const BACK_OUT_OF_REVIEW_FIRST_MESSAGE = 'Move this job back out of review first';

/** The refusals for a Reopen on a job that is not closed: the way out of Office review and Ready to close is the status menu. */
export const NOT_CLOSED_MESSAGE = 'This job is not closed, so there is nothing to reopen.';
export const NOT_CLOSED_IN_REVIEW_MESSAGE = 'This job is not closed. Use the status menu to move it back out of office review.';

/** The statuses a job-level Complete may start from. Every other status is already past it, or called off. */
export const COMPLETABLE_JOB_STATUSES: readonly JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];

/** The refusal for a Finish review sent against a review that has changed since the person loaded it. */
export const REVIEW_CHANGED_MESSAGE = 'Something changed on this job while you were reviewing. Check the new items and finish again.';

/** The refusal for a Finish review on a job that is not in Office review (it never was, or the review is already over). */
export const NOT_IN_OFFICE_REVIEW_MESSAGE = 'This job is not in office review.';
export const REVIEW_ALREADY_FINISHED_MESSAGE = 'This review has already been finished.';

/** The refusals for a Mark Done on a job that is not in Ready to close. */
export const FINISH_REVIEW_FIRST_MESSAGE = 'Finish the office review first';
export const ALREADY_DONE_MESSAGE = 'This job is already Done.';
export const NOT_READY_TO_CLOSE_MESSAGE = 'This job is not ready to close.';

/** The refusal for a Mark Done on a job with money owed, from a person without Close jobs with money owed. */
export const MONEY_OWED_MESSAGE =
  'Money is still owed on this job. Only someone allowed to close jobs with money owed can mark it Done.';

/** The refusal for a Mark Done with money owed that was sent without the amount the person confirmed. */
export const CONFIRM_AMOUNT_MESSAGE = 'Confirm the amount still owed before marking this job Done.';

/** The refusals for a Cancel that names no reason, or one the job's org does not offer (unknown, another org's, turned off). */
export const CANCEL_REASON_REQUIRED_MESSAGE = 'Choose a reason for cancelling this job.';
export const CANCEL_REASON_UNAVAILABLE_MESSAGE = 'That cancel reason is not available. Choose one from the list.';

/** The machine-readable code on a cancel refused because its reason is missing or not on the org's list. */
export const JOB_CANCEL_REASON_INVALID = 'JOB_CANCEL_REASON_INVALID';

/** The refusal for a backward move out of Office review or Ready to close from a person who cannot complete jobs. */
export const BACK_OUT_NEEDS_COMPLETE_MESSAGE = 'Only someone who can complete jobs can move this job out of office review.';

/** The refusal for job-level Arrived on a job in Office review or Ready to close: Arrived is never a deliberate backward move. */
export const ARRIVED_IN_REVIEW_MESSAGE = "Arrived can't move a job in office review. Use the status menu to send it back.";

/** The switch values M7 reads, by catalog key. A switch left out is off. */
export type CloseOutSwitches = {
  /** The switch of the door making a backward move (Start and finish visits, Assign people to jobs, ...), asked of the route first. */
  step_switch?: boolean;
  complete_jobs?: boolean;
  office_review?: boolean;
  close_jobs?: boolean;
  close_jobs_with_money_owed?: boolean;
  cancel_jobs?: boolean;
  reopen_done_jobs?: boolean;
};

export type CloseOutMove = 'complete' | 'finish_review' | 'mark_done' | 'cancel' | 'reopen' | 'back_out' | 'return_to_review';

/**
 * What Cancel needs to know about the reason: the code the person picked (null or blank when they picked none), and the
 * codes the job's org offers now (its ACTIVE reasons). Both are read by the route; a code outside the offered list is
 * unknown, another org's or turned off, and the three are refused alike.
 */
export interface CancelState {
  reasonCode: string | null | undefined;
  offeredCodes: readonly string[];
}

/**
 * What Mark Done needs to know about the job's money: what is owed as the server reads it now, and the amount the person
 * confirmed (null when they were not asked, or sent none). Both are whole cents, so no float is ever compared.
 */
export interface MarkDoneState {
  owedCents: number;
  confirmedCents: number | null;
}

/**
 * What Finish review needs to know about the review itself: its version as the server reads it now, the version the
 * client sent (null when it sent none), and the names of the items not yet checked (the job summary and customer items
 * included).
 */
export interface FinishReviewState {
  version: string;
  sentVersion: string | null;
  left: readonly string[];
}

export type CloseOutDecision =
  | { allowed: true; next: JobStatus }
  /**
   * `forbidden`: the person lacks the move's switch. `status`: the job is not somewhere the move can start from.
   * `stale`: the review changed since the client loaded it. `unchecked`: items are still to check. `money_owed`: money is
   * owed and the person lacks Close jobs with money owed (a permission refusal). `amount`: the amount owed was not
   * confirmed, or is no longer the amount the person confirmed. `reason`: a cancel with no reason, or one the org does not
   * offer.
   */
  | { allowed: false; kind: 'forbidden' | 'status' | 'stale' | 'unchecked' | 'money_owed' | 'amount' | 'reason'; reason: string };

const STATUS_REFUSAL: Partial<Record<JobStatus, string>> = {
  CANCELLED: REOPEN_FIRST_MESSAGE,
  DONE: REOPEN_FIRST_MESSAGE,
  OFFICE_REVIEW: 'This job is already completed and in office review.',
  READY_TO_CLOSE: 'This job is already completed and ready to close.',
  COMPLETED: 'This job is already completed.',
};

const NAMES_IN_REFUSAL = 3;

/** "Check everything first. Still to check: Job details, Phone and 2 more." */
function uncheckedReason(left: readonly string[]): string {
  const named = left.slice(0, NAMES_IN_REFUSAL);
  const more = left.length - named.length;
  return `Check every item before finishing the review. Still to check: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

function decideFinishReview(input: { status: JobStatus; switches: CloseOutSwitches; review?: FinishReviewState }): CloseOutDecision {
  const { status, switches, review } = input;
  if (!switches.office_review) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  if (status !== 'OFFICE_REVIEW') {
    const reason =
      status === 'READY_TO_CLOSE' || status === 'DONE'
        ? REVIEW_ALREADY_FINISHED_MESSAGE
        : status === 'CANCELLED'
          ? REOPEN_FIRST_MESSAGE
          : NOT_IN_OFFICE_REVIEW_MESSAGE;
    return { allowed: false, kind: 'status', reason };
  }
  // Nobody finishes a review they have not read: with no review to judge, the move is refused as stale.
  if (!review || review.sentVersion !== review.version) return { allowed: false, kind: 'stale', reason: REVIEW_CHANGED_MESSAGE };
  if (review.left.length > 0) return { allowed: false, kind: 'unchecked', reason: uncheckedReason(review.left) };
  // The review is finished by a person and lands in Ready to close; Done is its own step (Close jobs).
  return { allowed: true, next: 'READY_TO_CLOSE' };
}

const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function markDoneStatusRefusal(status: JobStatus): string {
  switch (status) {
    case 'OFFICE_REVIEW': return FINISH_REVIEW_FIRST_MESSAGE;
    case 'DONE': return ALREADY_DONE_MESSAGE;
    case 'CANCELLED': return REOPEN_FIRST_MESSAGE;
    default: return NOT_READY_TO_CLOSE_MESSAGE;
  }
}

function decideMarkDone(input: { status: JobStatus; switches: CloseOutSwitches; markDone?: MarkDoneState }): CloseOutDecision {
  const { status, switches, markDone } = input;
  if (!switches.close_jobs) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  // Done always comes after Ready to close: a person holding both switches still finishes the review first.
  if (status !== 'READY_TO_CLOSE') return { allowed: false, kind: 'status', reason: markDoneStatusRefusal(status) };
  // Nobody closes a job over an amount nobody looked at: with no money facts the move is refused as unconfirmed.
  if (!markDone) return { allowed: false, kind: 'amount', reason: CONFIRM_AMOUNT_MESSAGE };
  if (markDone.owedCents > 0 && !switches.close_jobs_with_money_owed) return { allowed: false, kind: 'money_owed', reason: MONEY_OWED_MESSAGE };
  if (markDone.owedCents > 0 && markDone.confirmedCents === null) return { allowed: false, kind: 'amount', reason: CONFIRM_AMOUNT_MESSAGE };
  // An amount the person confirmed must still be the amount owed (a payment may have landed since).
  if (markDone.confirmedCents !== null && markDone.confirmedCents !== markDone.owedCents) {
    return { allowed: false, kind: 'amount', reason: `The amount owed on this job is now ${dollars(markDone.owedCents)}. Check it and confirm again.` };
  }
  return { allowed: true, next: 'DONE' };
}

/**
 * Cancel: from any status except Done (a cancelled job may be cancelled again, to change its reason). The person needs Cancel
 * jobs and a reason the job's org offers. A job is only ever Cancelled; no move lands anywhere called Lost.
 */
function decideCancel(input: { status: JobStatus; switches: CloseOutSwitches; cancel?: CancelState }): CloseOutDecision {
  const { status, switches, cancel } = input;
  if (!switches.cancel_jobs) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  if (status === 'DONE') return { allowed: false, kind: 'status', reason: REOPEN_FIRST_MESSAGE };
  const code = cancel?.reasonCode?.trim();
  if (!code) return { allowed: false, kind: 'reason', reason: CANCEL_REASON_REQUIRED_MESSAGE };
  if (!cancel!.offeredCodes.includes(code)) return { allowed: false, kind: 'reason', reason: CANCEL_REASON_UNAVAILABLE_MESSAGE };
  return { allowed: true, next: 'CANCELLED' };
}

/**
 * Reopen (Reopen Done jobs): from Done or Cancelled, and from Completed, which no job rests at any more but which jobs
 * finished before the close-out flow still hold until the one-time move takes them to Done. The job goes back to In
 * Progress. A job that is not closed has nothing to reopen: a job in Office review or Ready to close is sent back with the
 * status menu (the backward moves), the others are still being worked.
 */
const REOPENABLE_JOB_STATUSES: readonly JobStatus[] = ['DONE', 'CANCELLED', 'COMPLETED'];

function decideReopen(input: { status: JobStatus; switches: CloseOutSwitches }): CloseOutDecision {
  const { status, switches } = input;
  if (!switches.reopen_done_jobs) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  if (!REOPENABLE_JOB_STATUSES.includes(status)) {
    const inReview = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE';
    return { allowed: false, kind: 'status', reason: inReview ? NOT_CLOSED_IN_REVIEW_MESSAGE : NOT_CLOSED_MESSAGE };
  }
  return { allowed: true, next: 'IN_PROGRESS' };
}

/** The statuses a job leaves by a backward move, and the ones it can be sent back to. */
const REVIEW_JOB_STATUSES: readonly JobStatus[] = ['OFFICE_REVIEW', 'READY_TO_CLOSE'];
const BACK_OUT_TARGETS: readonly JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];

/**
 * Backward move (status door, calendar drag, reschedule, unschedule, job-level Start): the job leaves Office review or Ready to
 * close for Scheduled, Unscheduled or In Progress. It needs the door's own switch AND Complete jobs, so someone who can only
 * start or schedule work can never pull a job out of the office's hands. It is a close-out move, so the completed-job lock
 * does not stand in its way. Done and Cancelled are never left this way: the only way out is Reopen.
 */
function decideBackOut(input: { status: JobStatus; switches: CloseOutSwitches; target?: JobStatus }): CloseOutDecision {
  const { status, switches, target } = input;
  if (status === 'DONE' || status === 'CANCELLED') return { allowed: false, kind: 'status', reason: REOPEN_FIRST_MESSAGE };
  if (!REVIEW_JOB_STATUSES.includes(status)) return { allowed: false, kind: 'status', reason: 'This job is not in office review.' };
  if (!target || !BACK_OUT_TARGETS.includes(target)) {
    return { allowed: false, kind: 'status', reason: 'A job in office review goes back to Scheduled, Unscheduled or In Progress.' };
  }
  if (!switches.step_switch) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  if (!switches.complete_jobs) return { allowed: false, kind: 'forbidden', reason: BACK_OUT_NEEDS_COMPLETE_MESSAGE };
  return { allowed: true, next: target };
}

/**
 * An unusual change on a Ready to close job (S06.20): the job returns to Office review on the same round. It is a move the
 * system makes when the change lands, not one a person asks for, so it reads no switch: whoever made the change, the job
 * is sent back. Only a job in Ready to close can be sent back; every other status stays where it is.
 */
function decideReturnToReview(input: { status: JobStatus }): CloseOutDecision {
  if (input.status !== 'READY_TO_CLOSE') return { allowed: false, kind: 'status', reason: NOT_READY_TO_CLOSE_MESSAGE };
  return { allowed: true, next: 'OFFICE_REVIEW' };
}

/** Whether a job in this status is somewhere Reopen can start from; the job page offers the control on this. */
export function reopenStartsFrom(status: JobStatus): boolean {
  return REOPENABLE_JOB_STATUSES.includes(status);
}

/** Whether a job in this status is somewhere Cancel can start from (every status but Done); the job page offers the control on this. */
export function cancelStartsFrom(status: JobStatus): boolean {
  return status !== 'DONE';
}

/** Whether a job in this status is somewhere Finish review can start from (the job page offers the control on this; the move still asks the review). */
export function finishReviewStartsFrom(status: JobStatus): boolean {
  const standing = decideFinishReview({ status, switches: { office_review: true } });
  return standing.allowed || standing.kind !== 'status';
}

export function decideCloseOutMove(input: {
  move: CloseOutMove;
  status: JobStatus;
  switches: CloseOutSwitches;
  review?: FinishReviewState;
  markDone?: MarkDoneState;
  cancel?: CancelState;
  /** Where a backward move sends the job. */
  target?: JobStatus;
}): CloseOutDecision {
  if (input.move === 'back_out') return decideBackOut(input);
  if (input.move === 'return_to_review') return decideReturnToReview(input);
  if (input.move === 'finish_review') return decideFinishReview(input);
  if (input.move === 'cancel') return decideCancel(input);
  if (input.move === 'reopen') return decideReopen(input);
  if (input.move === 'mark_done') return decideMarkDone(input);
  const { status, switches } = input;
  if (!switches.complete_jobs) return { allowed: false, kind: 'forbidden', reason: 'Insufficient permissions' };
  if (!COMPLETABLE_JOB_STATUSES.includes(status)) {
    return { allowed: false, kind: 'status', reason: STATUS_REFUSAL[status] ?? REOPEN_FIRST_MESSAGE };
  }
  // The job never rests at Completed: the move stamps it and lands in Office review in the same write.
  return { allowed: true, next: 'OFFICE_REVIEW' };
}

/**
 * The doors that set a job's status other than a close-out move (the status door to Scheduled, In Progress or
 * Unscheduled, the calendar drag and reschedule from the job, unschedule, job-level Start and Arrived, bulk start and
 * bulk arrive) ask this before they write anything (S06.17). A Done or Cancelled job leaves only through Reopen, so each of
 * them is refused with "Reopen this job first" for everyone, whatever they hold. Returns the plain reason, or null when
 * the job is not closed and the door follows its own switch, the lock and its own rules. The refusal comes before any
 * write, so no milestone, visit, sub status, cancel stamp, reason code or note is cleared by a refused move.
 */
export function statusDoorRefusal(status: JobStatus): string | null {
  return status === 'DONE' || status === 'CANCELLED' ? REOPEN_FIRST_MESSAGE : null;
}

/**
 * Job-level Arrived (single or bulk) on a job the office has taken over. Arrived is a crew step, never a deliberate
 * backward move, so a job in Office review or Ready to close is refused with a pointer to the status menu, and a Done or
 * Cancelled job with the Reopen rule. Returns the plain reason, or null when Arrived may run (which then follows its own
 * switch and the lock). The refusal comes before any write, so no stamp is cleared by a refused press.
 */
export function jobLevelArriveRefusal(status: JobStatus): string | null {
  if (status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE') return ARRIVED_IN_REVIEW_MESSAGE;
  return statusDoorRefusal(status);
}

/** The doors that set a job's status other than a close-out move, by the backward target each stands for. */
export type StatusDoor = 'start' | 'schedule' | 'unschedule' | 'arrive';

const DOOR_TARGET: Record<Exclude<StatusDoor, 'arrive'>, JobStatus> = {
  start: 'IN_PROGRESS',
  schedule: 'SCHEDULED',
  unschedule: 'UNSCHEDULED',
};

/**
 * What a status door answers for a job in this status (S06.18): `open` with `backward` true when the door is making a backward
 * move out of Office review or Ready to close that M7 allows (the lock does not bind it), `open` with `backward` false while
 * the job is not closed and the door follows its own switch and the lock, or `refused` with the plain reason. Done and
 * Cancelled answer "Reopen this job first" to every door; job-level Arrived is refused in Office review and Ready to close
 * whatever the person holds; every other door there is a backward move that needs `step_switch` and `complete_jobs`.
 * `step_switch` is true when the route has already let the person in on the door's own switch.
 */
export type StatusDoorAnswer = { open: true; backward: boolean } | { open: false; reason: string };

export function statusDoorAnswer(input: { status: JobStatus; door: StatusDoor; switches: CloseOutSwitches }): StatusDoorAnswer {
  const { status, door, switches } = input;
  if (door === 'arrive') {
    const reason = jobLevelArriveRefusal(status);
    return reason ? { open: false, reason } : { open: true, backward: false };
  }
  const closed = statusDoorRefusal(status);
  if (closed) return { open: false, reason: closed };
  if (!REVIEW_JOB_STATUSES.includes(status)) return { open: true, backward: false };
  const decision = decideBackOut({ status, switches, target: DOOR_TARGET[door] });
  return decision.allowed ? { open: true, backward: true } : { open: false, reason: decision.reason };
}
