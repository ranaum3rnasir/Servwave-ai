import type { NextFunction, Request, Response } from 'express';
import type { JobStatus, VisitStatus } from '@prisma/client';
import type { Action, Subject } from './catalog';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { JOB_STATUS_ORDER } from '../job-status-order';
import { canAccessRow, canActOnRow } from './enforce';
import { logger } from '../logger';
import { isLiveVisit } from '../visit-status';
import { BACK_OUT_OF_REVIEW_FIRST_MESSAGE, REOPEN_FIRST_MESSAGE } from '../job-close-out';
import { DISCOUNT_REFUSAL } from './discountWrite';
import { isAllowedBackwardMove } from './jobStatusDoor';
import { jobsHoldingInvoice } from '../job-money-owed';
import { CANONICAL_ID, isOtherSpellingOfId } from '../ids/canonicalId';

/**
 * The completed-job lock (Roles & Permissions, PRD 4, S04.22): one answer to "is this job locked for this person".
 *
 * A job is locked while it is Completed or any status placed after Completed in the job status order (the review
 * states PRD 6 adds), and while it is Cancelled. A locked job can be changed only by a holder of Change locked jobs;
 * that switch lifts the lock and nothing else, so the ordinary switch for the action is still asked of them. The lock
 * follows the job's status as it stands, read on every call and never cached, so a Reopen lifts it on the next request.
 *
 * It covers changes to what the job holds: details, people, existing visits, line items and discounts. Collecting
 * money, invoice sends and creates, the close-out moves (complete, cancel, reopen) and adding new history (a note, a
 * file, a logged call) are not changes to the finished job, so their routes do not ask it.
 *
 * The one exception is the review's own edits (S06.9). While the job is in Office review, a person who holds Office review
 * and can open the job may still make the edits the review is for, each on its own ordinary switch: lines, scopes and the
 * job discount, the customer details on the job, and files on the job and its invoices. The caller says WHICH kind of
 * change it is asking about (a ReviewEdit), because the lock cannot tell from the job alone; a call that names no kind is
 * an ordinary change and gets no exception. From Ready to close on the exception is gone and only Change locked jobs passes.
 *
 * A backward move out of Office review or Ready to close (S06.18) is a close-out move, not a change to the finished job: the door
 * guard in jobStatusDoor.ts asks M7 first and, when it allows the move (the door's own switch and Complete jobs), flags the
 * request so `refuseWhenJobLocked` stands aside. A Change locked jobs holder without Complete jobs is refused by M7; the key to
 * this lock does not open that door. The lock lifts with the status the move writes.
 *
 * A DONE job takes no change to its lines or prices from anyone (S06.19): a line, scope or discount edit on the job, and a line,
 * scope, discount or tax edit on one of its invoices, answer `JOB_DONE_PRICES_MESSAGE` before the lock is asked, so Change locked
 * jobs does not open them and the Office review exception, which ended with the review, cannot either. It is the lock's own
 * answer with another reason (same status and code), asked by `refuseWhenJobLocked` for the job's doors and by
 * `refuseInvoicePriceEditOnDoneJob` for the invoice's, and drawn closed on the pages from `jobDonePriceRefusal`. Payments, sends,
 * a new invoice, notes and uploads are not changes to what the job holds, and stay open.
 *
 * A NEW visit is the one thing the lock's key does not open (S04.23): a finished or cancelled job takes no new trip
 * from anyone, a Change locked jobs holder included, until it is reopened. That is a different question from "may this
 * person change the job", so it has its own answer (jobClosedForNewVisit) and its own refusal.
 */

/** The one refusal, on the server and beside every disabled control. */
export const JOB_LOCKED_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';
/** The machine-readable code a refusal carries next to the message. */
export const JOB_LOCKED_CODE = 'JOB_LOCKED';

/** The refusal for a line, scope, discount or tax edit on a Done job or on one of its invoices: the way back is Reopen. */
export const JOB_DONE_PRICES_MESSAGE = 'This job is Done. Reopen it to change its lines or prices.';

/**
 * The refusal for a new visit on a locked job, and beside the disabled Add visit control. Same for everyone; the words
 * depend on where the job stands (S06.4): a job in Office review or Ready to close is moved back out first, a Completed,
 * Done or Cancelled one is reopened first.
 */
export function newVisitClosedMessage(status: JobStatus): string {
  return status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE' ? BACK_OUT_OF_REVIEW_FIRST_MESSAGE : REOPEN_FIRST_MESSAGE;
}
/** The machine-readable code a new-visit refusal carries next to the message. */
export const NEW_VISIT_CLOSED_CODE = 'JOB_CLOSED_FOR_NEW_VISIT';

/** Completed and everything after it in the status order (Cancelled sits last), as the status order places them. */
const LOCKED_STATUSES: readonly JobStatus[] = JOB_STATUS_ORDER.slice(JOB_STATUS_ORDER.indexOf('COMPLETED'));

export function isLockedJobStatus(status: JobStatus): boolean {
  return LOCKED_STATUSES.includes(status);
}

/**
 * The edits the review makes while the job is in Office review (S06.9), by the kind of change a lock check is asked about.
 * Everything else on the lock list (details, people, visits, note deletes) names none and stays locked.
 */
export type ReviewEdit =
  /** A job line or scope: add, change, remove, reorder. */
  | 'lines'
  /** The job discount: a pricing write, so it also needs the right to price the job. */
  | 'discount'
  /** A phone or email on the job (PRD 5's job contact entries): add, change, correct, remove. */
  | 'contact_details'
  /** The customer's name or company name on the job. */
  | 'customer_name'
  /** A file on the job or on one of its invoices: the file's own delete and rename switches are asked beside the lock. */
  | 'file';

/** A job action and the kind of review edit it stands for (the job page's answer is built from these). */
export const REVIEW_EDIT_OF_ACTION = { edit_line_items: 'lines', apply_discount: 'discount' } as const;

/** Does the person hold this action on the job, under their row scope for it? */
async function holdsAction(req: Request, jobId: string, action: Action): Promise<boolean> {
  return req.ability!.can(action, 'Job' as Subject) && (await canActOnRow(req, 'Job', prisma.job, jobId, action));
}

/** Does the person hold the switch that edit stands on? Each is asked of the job's row scope, the same as its route. */
async function holdsEditSwitch(req: Request, jobId: string, edit: ReviewEdit): Promise<boolean> {
  switch (edit) {
    case 'lines':
      return holdsAction(req, jobId, 'manage_lines');
    case 'discount':
      return (await holdsAction(req, jobId, 'manage_lines')) && (await holdsAction(req, jobId, 'apply_discount'));
    case 'contact_details':
      return (await holdsAction(req, jobId, 'edit_contact_details')) || (await holdsAction(req, jobId, 'update'));
    case 'customer_name':
      return holdsAction(req, jobId, 'update');
    case 'file':
      return true;
  }
}

/** Does the person hold Office review on this job and can they open it? The first half of the review exception. */
async function isReviewerOf(req: Request, jobId: string): Promise<boolean> {
  if (!req.ability!.can('office_review', 'Job' as Subject)) return false;
  if (!(await canActOnRow(req, 'Job', prisma.job, jobId, 'office_review'))) return false;
  return canActOnRow(req, 'Job', prisma.job, jobId, 'read');
}

/**
 * Does the Office review exception free this person for this kind of change? True only while the job is in Office review,
 * and only for a person who holds Office review, can open the job and holds the edit's own switch.
 */
async function reviewExceptionFrees(req: Request, jobId: string, status: JobStatus, edit: ReviewEdit | undefined): Promise<boolean> {
  if (!edit || status !== 'OFFICE_REVIEW') return false;
  if (!(await isReviewerOf(req, jobId))) return false;
  return holdsEditSwitch(req, jobId, edit);
}

/** The ordinary refusal of a route whose switch the person does not hold. */
const MISSING_PERMISSION_MESSAGE = 'Insufficient permissions';

/**
 * The ordinary missing-permission refusal for a review edit, when that is the real reason the lock held: the job is in
 * Office review, the person holds Office review and can open the job, the change is one of the review's kinds, and the
 * ONLY thing they lack is the edit's own switch. The lock sentence would blame the lock for what is a missing switch.
 * Null in every other case, and the caller answers with the lock. `status` is passed when the caller already has it.
 */
export async function missingEditSwitchRefusal(req: Request, jobId: string, edit: ReviewEdit | undefined, status?: JobStatus): Promise<string | null> {
  if (!edit) return null;
  const current = status ?? (await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (current !== 'OFFICE_REVIEW' || !(await isReviewerOf(req, jobId))) return null;
  if (await holdsEditSwitch(req, jobId, edit)) return null;
  return edit === 'discount' && !(await holdsAction(req, jobId, 'apply_discount')) ? DISCOUNT_REFUSAL : MISSING_PERMISSION_MESSAGE;
}

/**
 * Is this job locked for the person asking? True only when the job's status is a locked one, the person does not hold
 * Change locked jobs, and they can open the job at all: a job they cannot open answers with its ordinary refusal, so
 * the lock never tells anyone the status of a job they cannot see. `status` is passed when the caller already has it;
 * `edit` names the review edit being asked about, when it is one (see ReviewEdit).
 */
export async function jobLockedFor(req: Request, jobId: string, status?: JobStatus, edit?: ReviewEdit): Promise<boolean> {
  if (!(await lockBindsPerson(req, jobId, status, edit))) return false;
  return canActOnRow(req, 'Job', prisma.job, jobId, 'read');
}

/**
 * Does the lock on this job bind the person, whether or not they can open the job itself? True when the job's status is
 * a locked one and the person does not hold Change locked jobs on it, apart from the Office review exception for the
 * review edit named in `edit`. The files on a job's invoice ask this: a person who opened the invoice is bound by the lock
 * on its job even when their reach does not include the job page. Fails closed: a job the person cannot reach is a job
 * they hold no key for.
 */
export async function lockBindsPerson(req: Request, jobId: string, status?: JobStatus, edit?: ReviewEdit): Promise<boolean> {
  const current = status ?? (await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (!current || !isLockedJobStatus(current)) return false;
  if (req.ability!.can('change_locked', 'Job' as Subject) && (await canActOnRow(req, 'Job', prisma.job, jobId, 'change_locked'))) return false;
  return !(await reviewExceptionFrees(req, jobId, current, edit));
}

/**
 * The words a Done job gives a line, scope, discount or tax edit (on the job or on one of its invoices), or null while the edit is
 * open. Judged for everyone: Change locked jobs does not lift it. Like the lock, it never tells anyone the status of a job they cannot
 * open (a job outside their reach answers with its ordinary refusal). `status` is passed when the caller already has it.
 */
export async function jobDonePriceRefusal(req: Request, jobId: string, status?: JobStatus): Promise<string | null> {
  const current = status ?? (await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (current !== 'DONE') return null;
  return (await canActOnRow(req, 'Job', prisma.job, jobId, 'read')) ? JOB_DONE_PRICES_MESSAGE : null;
}

/**
 * The words a Done job gives a line, scope, discount or tax edit on one of ITS INVOICES (the invoices the job's balance is worked
 * out over: `jobsHoldingInvoice`), or null while the edit is open. One query for an invoice that belongs to no Done job; the
 * reach check runs only for one that does, so the status of a job is never described to a person who cannot open the invoice.
 */
export async function invoiceDonePriceRefusal(req: Request, invoiceId: string): Promise<string | null> {
  const done = await prisma.job.findFirst({
    where: { ...tenantWhere(req), status: 'DONE', ...jobsHoldingInvoice(invoiceId) },
    select: { status: true },
  });
  if (done?.status !== 'DONE') return null;
  return (await canAccessRow(req, 'Invoice', prisma.invoice, invoiceId)) ? JOB_DONE_PRICES_MESSAGE : null;
}

/** The refusal for a price edit on a Done job, written once for every door that gives it: the lock's status and code, the Done words. */
export function respondJobDonePrices(res: Response): void {
  res.status(403).json({ error: JOB_DONE_PRICES_MESSAGE, code: JOB_LOCKED_CODE });
}

/**
 * Is a new visit closed on this job? True when the job's status is a locked one and the person can open the job at all
 * (a job they cannot open answers with its ordinary refusal, so this never tells anyone the status of a job they cannot
 * see). Unlike jobLockedFor it ignores Change locked jobs: nobody adds a visit to a finished job. `status` is passed
 * when the caller already has it.
 */
export async function jobClosedForNewVisit(req: Request, jobId: string, status?: JobStatus): Promise<boolean> {
  return (await newVisitClosedReason(req, jobId, status)) !== null;
}

/** The words a closed job gives a new visit (the refusal and the disabled control), or null while a new visit is open. */
export async function newVisitClosedReason(req: Request, jobId: string, status?: JobStatus): Promise<string | null> {
  const current = status ?? (await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (!current || !isLockedJobStatus(current)) return null;
  return (await canActOnRow(req, 'Job', prisma.job, jobId, 'read')) ? newVisitClosedMessage(current) : null;
}

/**
 * Would booking a window on this job mint a new visit it must not have? True when the job is locked (Completed or later, or Cancelled) and
 * none of its visits is live: the job edit and Assign both land a window on the next live visit and, finding none,
 * create one. A closed job takes no new trip by any door, so those doors ask this before they write and answer
 * with the same refusal as Add visit.
 */
export async function windowWouldMintVisitOnClosedJob(
  req: Request,
  job: { id: string; status: JobStatus; visits: { status: VisitStatus }[] },
): Promise<boolean> {
  if (!(await jobClosedForNewVisit(req, job.id, job.status))) return false;
  return !job.visits.some(isLiveVisit);
}

/** The refusal for a new visit on a closed job, written once for every door that gives it. */
export function respondNewVisitClosed(res: Response, status: JobStatus): void {
  res.status(403).json({ error: newVisitClosedMessage(status), code: NEW_VISIT_CLOSED_CODE });
}


/**
 * Route guard for a job write: refuses with the lock message when the job in `:id` is locked for the person. It sits
 * after the route's own switch guard, so a person without the switch still gets that refusal first. A uuid spelled any way
 * but the canonical one answers 404 "Job not found", never steps aside (security review, side finding): the handler's own
 * lookup would still find the job by that spelling. A malformed id or a job that is not there falls through to the handler,
 * which answers as it always has.
 *
 * `edit` is the review edit the route makes (S06.9), or a function that reads it off the request when the same route
 * serves both an edit the review makes and one it does not (the job PATCH, whose discount is the review's and whose
 * details are not). A route that names none gets no Office review exception.
 */
export function refuseWhenJobLocked(edit?: ReviewEdit | ((req: Request) => ReviewEdit | undefined)) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      if (isOtherSpellingOfId(id)) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!CANONICAL_ID.test(id)) {
        next();
        return;
      }
      // A backward move out of Office review or Ready to close that M7 allowed is a close-out move: the lock does not bind it (S06.18).
      if (isAllowedBackwardMove(res)) {
        next();
        return;
      }
      const named = typeof edit === 'function' ? edit(req) : edit;
      // A Done job takes no line, scope or discount edit from anyone, so this is asked before the lock (S06.19).
      let status: JobStatus | undefined;
      if (named === 'lines' || named === 'discount') {
        status = (await prisma.job.findFirst({ where: { id, ...tenantWhere(req) }, select: { status: true } }))?.status;
        if (status && (await jobDonePriceRefusal(req, id, status))) {
          respondJobDonePrices(res);
          return;
        }
      }
      if (await jobLockedFor(req, id, status, named)) {
        // A reviewer who lacks only the edit's own switch is told that, not that the job is locked.
        const missing = await missingEditSwitchRefusal(req, id, named);
        if (missing) res.status(403).json({ error: missing });
        else res.status(403).json({ error: JOB_LOCKED_MESSAGE, code: JOB_LOCKED_CODE });
        return;
      }
      next();
    } catch (err) {
      logger.error('Job lock check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}

/**
 * Route guard for a line, scope, discount or tax edit on an invoice: refuses with the Done words when the invoice belongs to a Done
 * job (S06.19), for every person. It sits after the route's own switch guard, so a person without the switch still gets that
 * refusal first. `when` narrows it to the requests that touch a price (the billing route also takes a tip, which is not one). A
 * uuid in another spelling answers 404 "Invoice not found"; a malformed id or an invoice that is not there falls through.
 */
export function refuseInvoicePriceEditOnDoneJob(when?: (req: Request) => boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      if (isOtherSpellingOfId(id)) {
        res.status(404).json({ error: 'Invoice not found' });
        return;
      }
      if (!CANONICAL_ID.test(id)) {
        next();
        return;
      }
      if (when && !when(req)) {
        next();
        return;
      }
      if (await invoiceDonePriceRefusal(req, id)) {
        respondJobDonePrices(res);
        return;
      }
      next();
    } catch (err) {
      logger.error('Done job invoice check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}

/**
 * Route guard for Add visit: refuses with the job's new-visit words (newVisitClosedMessage) when the job in `:id` is
 * locked, for every person. It sits after the route's own switch guard, so a person without Schedule visits gets that refusal
 * first. A uuid in another spelling answers 404 "Job not found"; a malformed id or a job that is not there falls through.
 */
export function refuseNewVisitOnClosedJob() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      if (isOtherSpellingOfId(id)) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!CANONICAL_ID.test(id)) {
        next();
        return;
      }
      const reason = await newVisitClosedReason(req, id);
      if (reason) {
        res.status(403).json({ error: reason, code: NEW_VISIT_CLOSED_CODE });
        return;
      }
      next();
    } catch (err) {
      logger.error('Job new-visit check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}
