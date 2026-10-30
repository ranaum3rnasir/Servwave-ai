import type { Request } from 'express';
import type { Action, Subject } from './catalog';
import { prisma } from '../prisma';
import { canActOnRow, scopeWhereForReq } from './enforce';
import { isOnJobCrew, type JobWithVisitCrew } from '../job-crew';
import { newVisitClosedReason, jobLockedFor, jobDonePriceRefusal, REVIEW_EDIT_OF_ACTION } from './jobLock';
import { statusDoorVerdict } from './jobStatusDoor';
import { decideCloseOutMove, finishReviewStartsFrom, cancelStartsFrom, reopenStartsFrom } from '../job-close-out';
import { readJobMoneyOwed } from '../job-money-owed';
import { fromCents } from '../payment-ledger';
import type { JobStatus } from '@prisma/client';

/**
 * M3 - the access resolver's per-record answer for a job (Roles & Permissions, PRD 4): which actions this person may
 * take on THIS job. The job page reads it and draws a control only for an action on the list, so no button shows that
 * the job's routes would refuse; the routes ask the same switches (the route guard names the action, the controller
 * asks the job's row scope), so a listed action is one the route lets in.
 *
 * Each action stands on one switch, never on a role name:
 *   edit               Edit jobs                       details, service type, job type, description, service location,
 *                                                      tags, sub-status and extra info
 *   assign             Assign people to jobs           the assign control and the Dispatcher field (naming OTHER people
 *                                                      is the crew picker's own pool, Assign work to other people)
 *   schedule           Schedule visits                 add, reschedule and cancel a visit
 *   complete           Complete jobs                   only on a job that can still be completed (Unscheduled, Scheduled or In Progress)
 *   cancel             Cancel jobs                     on any job but a Done one (S06.15): a Done job is reopened first
 *   reopen             Reopen Done jobs                only on a Done or Cancelled job (S06.16), or an old Completed one: the close-out
 *                                                      state machine says where Reopen starts, so the page never reads the status
 *   delete             Delete jobs
 *   duplicate          Duplicate jobs
 *   create_invoice     Create invoices
 *   create_estimate    Create estimates                a person whose Estimates scope is narrower than All may create
 *                                                      one only on a job they are on the crew of
 *   renumber           Edit record ID numbers (jobs)
 *   edit_line_items    Edit job line items             the Items tab's add, change and remove of lines and scopes, on
 *                                                      any job the person can open (creating or selling grants nothing)
 *   apply_discount     Apply discounts                 the job's discount; a discount is a pricing write, so the person
 *                                                      must also hold edit_line_items
 *   add_note           Add notes
 *   upload_attachment  Upload attachments
 *   log_communication  Log past communications
 *   office_review      Office review                   only on a job in Office review (S06.8): the banner's Review button and
 *                                                      the review panel
 *   finish_review      Office review                   only on a job in Office review (S06.12): the panel's Finish review.
 *                                                      The switch alone offers it; whether every item is checked is the
 *                                                      review's own state, which the panel reads from the review
 *   mark_done          Close jobs                      only on a job in Ready to close (S06.13), and with money owed only for a
 *                                                      holder of Close jobs with money owed. A Close jobs holder who may not close
 *                                                      over money owed is not offered it: the answer's `ready_to_close` block says
 *                                                      so, with the reason and the amount, for the page to draw it disabled
 *
 * The visit status steps are answered elsewhere (PRD 6, visitSteps.ts).
 *
 * The completed-job lock (S04.22, jobLock.ts): on a job that is locked for this person, the actions that change the
 * finished job (LOCKED_JOB_ACTIONS) are left off the list, so no control is offered that the job's routes would refuse.
 * The ones the lock withheld, which the person's switches would otherwise allow, are named in `locked_actions`, so the
 * page can show them disabled with the reason instead of leaving the reader to wonder where they went. What is not a
 * change to the finished job (a note, a file, a logged call, an invoice or estimate, duplicate, the close-out moves)
 * stays listed.
 *
 * A Done job takes no line, scope or discount edit from anyone (S06.19): Edit job line items and Apply discounts come off `actions`
 * for every person, a Change locked jobs holder included, and join `locked_actions` (the ones their switches would otherwise allow),
 * with `price_edit_closed_reason` carrying the Done sentence for the page to draw beside the closed controls. Collecting, sending,
 * a new invoice, a note and an upload stay listed.
 *
 * The one exception is the review's own edits (S06.9, jobLock.ts): while the job is in Office review, an Office review
 * holder who also holds the edit's own switch keeps edit_line_items and apply_discount on the list, and `contact_locked`
 * is false, so the lines tab and the customer block's pencils are drawn open for them. Details, people and visits stay
 * withheld. The answer is the server's own: the page never judges the status itself.
 */

export type JobAction =
  | 'edit'
  | 'assign'
  | 'schedule'
  | 'complete'
  | 'cancel'
  // S06.16 - Reopen on a Done or Cancelled job (the Reopen Done jobs switch).
  | 'reopen'
  | 'delete'
  | 'duplicate'
  | 'create_invoice'
  | 'create_estimate'
  | 'renumber'
  | 'edit_line_items'
  | 'apply_discount'
  | 'add_note'
  | 'upload_attachment'
  | 'log_communication'
  | 'office_review'
  | 'finish_review'
  // S06.13 - Mark Done on a job in Ready to close (the Close jobs switch).
  | 'mark_done';

/** The order the answer lists them in. */
export const JOB_ACTIONS: readonly JobAction[] = [
  'edit', 'assign', 'schedule', 'complete', 'cancel',
  'reopen',
  'delete', 'duplicate',
  'create_invoice', 'create_estimate', 'renumber', 'edit_line_items', 'apply_discount', 'add_note', 'upload_attachment', 'log_communication',
  'office_review',
  'finish_review',
  'mark_done',
];

/** The actions that change what a finished job holds, which the lock takes away from anyone without Change locked jobs. */
export const LOCKED_JOB_ACTIONS: readonly JobAction[] = [
  'edit', 'assign', 'schedule', 'delete', 'renumber', 'edit_line_items', 'apply_discount',
];

/** An action on the job itself: the Job verb its switch grants, asked of the job's row scope. */
const JOB_VERB: Partial<Record<JobAction, Action>> = {
  edit: 'update',
  assign: 'assign',
  schedule: 'reschedule',
  complete: 'complete',
  cancel: 'cancel',
  reopen: 'reopen',
  delete: 'delete',
  duplicate: 'duplicate',
  renumber: 'renumber',
  edit_line_items: 'manage_lines',
  add_note: 'add_note',
  office_review: 'office_review',
  finish_review: 'office_review',
  mark_done: 'close',
};

/** An action on another kind of record, made from the job: the ability its switch grants. */
const OTHER_ABILITY: Partial<Record<JobAction, { action: Action; subject: Subject }>> = {
  create_invoice: { action: 'create', subject: 'Invoice' },
  create_estimate: { action: 'create', subject: 'Estimate' },
  upload_attachment: { action: 'create', subject: 'Attachment' },
  log_communication: { action: 'log_past', subject: 'Communication' },
};

/**
 * What the job page draws for a job in Ready to close (S06.13), decided here and never by the browser: whether Mark Done is
 * offered, drawn disabled with a reason, or absent, and the amount owed (the Balance card's figure; the browser never works
 * out money owed). Present only on a job in Ready to close, and only for a person who may close it or review it.
 */
export interface ReadyToCloseAnswer {
  /** What is owed now, in dollars; 0 when nothing is. */
  amount_owed: number;
  /** `offered`: Mark Done may be pressed. `disabled`: shown with `mark_done_reason`. `none`: this person does not close jobs. */
  mark_done: 'offered' | 'disabled' | 'none';
  mark_done_reason: string | null;
  /** True when the press must confirm the amount first: money is owed and this person may close over it. */
  confirm_amount: boolean;
  /**
   * True when this person holds Office review on the job, so the banner offers the review's "Since the review" list (S06.20): what
   * changed after the review was finished and did not send the job back. The browser never works out who may read the review.
   */
  review_changes: boolean;
}

export interface JobActionAnswer {
  /** What the person may do now, in the order of JOB_ACTIONS. */
  actions: JobAction[];
  /** True when the job is locked for this person (it is Completed or later, or Cancelled, and they lack Change locked jobs). */
  locked: boolean;
  /** The actions their switches allow that the lock is withholding, in the order of JOB_ACTIONS. */
  locked_actions: JobAction[];
  /**
   * True when the lock binds this person on the job's own customer details (a phone, an email, a name): the customer
   * block draws its pencils only while this is false. Differs from `locked` only in Office review, for the review's holder.
   */
  contact_locked: boolean;
  /** True when a new visit cannot be added: the job is locked (Completed or later, or Cancelled), whoever asks (S04.23). */
  new_visit_closed: boolean;
  /** The words beside the disabled Add visit control and in the refusal, or null while a new visit is open (S06.4). */
  new_visit_closed_reason: string | null;
  /**
   * The words beside every control that would set the job's status (Start, Schedule, Reschedule) when the job is Done or
   * Cancelled and leaves only through Reopen, whoever asks (S06.17); null on any other status. The page draws those controls
   * only while this is null, so it never judges the status itself.
   */
  status_door_closed_reason: string | null;
  /**
   * True when the job is in Office review or Ready to close and this person may move it back out (S06.18): they hold Complete
   * jobs on it, and the door's own switch decides which control (Start, Schedule, Reschedule) is drawn. A backward move is a close-out
   * move, so these controls are open to them although the lock withholds the rest of the finished job. False on any other status.
   */
  backward_move_open: boolean;
  /**
   * The words beside the closed line, scope and discount controls when the job is Done (S06.19): nobody edits a Done job's lines or
   * prices until it is reopened, Change locked jobs holders included. Null on any other status, and for a person who cannot open the job.
   */
  price_edit_closed_reason: string | null;
  /** The Ready to close banner's facts (S06.13), or null when the job is not in Ready to close or the person has no part in it. */
  ready_to_close: ReadyToCloseAnswer | null;
}

type JobForActions = { id: string; status?: JobStatus } & NonNullable<JobWithVisitCrew>;

/** The actions this person may take on the job and what the completed-job lock withholds. `job.visits` carries the crew when known. */
export async function jobActionAnswerFor(req: Request, job: JobForActions): Promise<JobActionAnswer> {
  const price_edit_closed_reason = await jobDonePriceRefusal(req, job.id, job.status);
  const answer = await lockedAnswerFor(req, job);
  if (!price_edit_closed_reason) return { ...answer, price_edit_closed_reason };
  // A Done job's lines and prices are closed to everyone: the two actions leave the list and are drawn disabled with the Done words.
  const closed = (a: JobAction) => DONE_CLOSED_JOB_ACTIONS.includes(a);
  return {
    ...answer,
    actions: answer.actions.filter((a) => !closed(a)),
    locked_actions: JOB_ACTIONS.filter((a) => answer.locked_actions.includes(a) || (closed(a) && answer.actions.includes(a))),
    price_edit_closed_reason,
  };
}

/** The actions a Done job closes to everyone (S06.19): the job's lines and scopes, and its discount. */
export const DONE_CLOSED_JOB_ACTIONS: readonly JobAction[] = ['edit_line_items', 'apply_discount'];

async function lockedAnswerFor(req: Request, job: JobForActions): Promise<Omit<JobActionAnswer, 'price_edit_closed_reason'>> {
  const [answers, locked, new_visit_closed_reason, doorVerdict] = await Promise.all([
    Promise.all(JOB_ACTIONS.map((action) => mayTake(req, job, action))),
    jobLockedFor(req, job.id, job.status),
    newVisitClosedReason(req, job.id, job.status),
    statusDoorVerdict(req, job.id, 'schedule', job.status),
  ]);
  const status_door_closed_reason = doorVerdict.reason;
  const backward_move_open = doorVerdict.backward;
  // Mark Done and the Ready to close banner (S06.13): the money is read only for a job in Ready to close, and only for a
  // person who closes jobs or reviews them, so no other job page pays for it.
  const mayClose = answers[JOB_ACTIONS.indexOf('mark_done')]!;
  const mayReview = answers[JOB_ACTIONS.indexOf('office_review')]!;
  const ready_to_close = job.status === 'READY_TO_CLOSE' && (mayClose || mayReview) ? await readyToCloseFor(req, job.id, mayClose, mayReview) : null;
  // Complete starts only from Unscheduled, Scheduled or In Progress (M7): a job already past it, or cancelled, is not offered
  // the control, the same answer the route gives.
  // The review panel is offered while the job is in Office review (S06.8); its route answers the same person the same way.
  const new_visit_closed = new_visit_closed_reason !== null;
  const allowed = JOB_ACTIONS.filter(
    (action, i) =>
      answers[i] &&
      (action !== 'complete' || !job.status || decideCloseOutMove({ move: 'complete', status: job.status, switches: { complete_jobs: true } }).allowed) &&
      (action !== 'cancel' || !job.status || cancelStartsFrom(job.status)) &&
      (action !== 'reopen' || (!!job.status && reopenStartsFrom(job.status))) &&
      (action !== 'office_review' || job.status === 'OFFICE_REVIEW') &&
      (action !== 'finish_review' || (!!job.status && finishReviewStartsFrom(job.status))) &&
      (action !== 'mark_done' || ready_to_close?.mark_done === 'offered'),
  );
  if (!locked) return { actions: allowed, locked, locked_actions: [], contact_locked: false, new_visit_closed, new_visit_closed_reason, status_door_closed_reason, backward_move_open, ready_to_close };
  // The review's own edits (S06.9): in Office review the lock does not bind an Office review holder for these, and each
  // asks the same question its route asks, so a control is drawn only where the route would let the request in.
  const [excepted, contact_locked] = await Promise.all([
    Promise.all(
      LOCKED_JOB_ACTIONS.map(async (action) => {
        const edit = REVIEW_EDIT_OF_ACTION[action as keyof typeof REVIEW_EDIT_OF_ACTION];
        return !!edit && !(await jobLockedFor(req, job.id, job.status, edit));
      }),
    ),
    jobLockedFor(req, job.id, job.status, 'contact_details'),
  ]);
  const withheld = (a: JobAction) => LOCKED_JOB_ACTIONS.includes(a) && !excepted[LOCKED_JOB_ACTIONS.indexOf(a)];
  return {
    actions: allowed.filter((a) => !withheld(a)),
    locked,
    locked_actions: allowed.filter(withheld),
    contact_locked,
    new_visit_closed,
    new_visit_closed_reason,
    status_door_closed_reason,
    backward_move_open,
    ready_to_close,
  };
}

/** What the Ready to close banner shows this person: the amount owed and whether Mark Done is offered, disabled or absent. */
async function readyToCloseFor(req: Request, jobId: string, mayClose: boolean, review_changes: boolean): Promise<ReadyToCloseAnswer> {
  const { owedCents } = await readJobMoneyOwed({ orgId: req.user!.organization_id, jobId });
  const amount_owed = fromCents(owedCents);
  if (!mayClose) return { amount_owed, mark_done: 'none', mark_done_reason: null, confirm_amount: false, review_changes };
  const mayCloseOwed = req.ability!.can('close_with_money_owed', 'Job' as Subject) && (await canActOnRow(req, 'Job', prisma.job, jobId, 'close_with_money_owed'));
  // Asked as if the amount were confirmed: the press itself must still confirm it, but whether it is offered is this answer.
  const decision = decideCloseOutMove({
    move: 'mark_done',
    status: 'READY_TO_CLOSE',
    switches: { close_jobs: true, close_jobs_with_money_owed: mayCloseOwed },
    markDone: { owedCents, confirmedCents: owedCents },
  });
  if (decision.allowed) return { amount_owed, mark_done: 'offered', mark_done_reason: null, confirm_amount: owedCents > 0, review_changes };
  return { amount_owed, mark_done: 'disabled', mark_done_reason: decision.reason, confirm_amount: false, review_changes };
}

/** The actions this person may take on the job, in the order of JOB_ACTIONS. */
export async function jobActionsFor(req: Request, job: JobForActions): Promise<JobAction[]> {
  return (await jobActionAnswerFor(req, job)).actions;
}

async function mayTake(req: Request, job: { id: string } & NonNullable<JobWithVisitCrew>, action: JobAction): Promise<boolean> {
  // A discount is a pricing write: it needs Apply discounts and the right to price the job.
  if (action === 'apply_discount') {
    return req.ability!.can('apply_discount', 'Job' as Subject) && (await mayTake(req, job, 'edit_line_items'));
  }
  const verb = JOB_VERB[action];
  if (verb) {
    return req.ability!.can(verb, 'Job' as Subject) && canActOnRow(req, 'Job', prisma.job, job.id, verb);
  }
  const needs = OTHER_ABILITY[action]!;
  if (!req.ability!.can(needs.action, needs.subject)) return false;
  if (action !== 'create_estimate') return true;
  // An estimate made from a job: a person whose Estimates scope is narrower than All may do it only on a job they are crewed on.
  const narrowed = Object.keys(await scopeWhereForReq(req, 'Estimate')).length > 0;
  return !narrowed || (await onCrew(req, job));
}

async function onCrew(req: Request, job: { id: string } & NonNullable<JobWithVisitCrew>): Promise<boolean> {
  if (job.visits) return isOnJobCrew(job, req.user!.id);
  return !!(await prisma.visitAssignee.findFirst({
    where: { user_id: req.user!.id, visit: { job_id: job.id } },
    select: { visit_id: true },
  }));
}
