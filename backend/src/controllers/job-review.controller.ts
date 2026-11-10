import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow, canActOnRow, canSeeCosts } from '../lib/permissions/enforce';
import { readJobReview, type ReviewAnswer } from '../lib/job-review-reader';
import { jobHasReview } from '../lib/job-review';
import { invoiceOpenerFor, openableInvoiceIds } from '../lib/permissions/invoiceAccess';
import { CUSTOMER_ONE_BY_ONE, judgeCheck, storeChecks, type CheckRequest } from '../lib/job-review-checks';
import { judgeDecision, storeDecision, type DecisionRequest } from '../lib/job-review-decisions';
import { JOB_CLOSE_OUT_REFUSED } from '../lib/job-close-out';
import { queueReviewAttention } from '../services/notifications/reviewAttentionQueue';
import { finishReview, FinishRefusal, REVIEW_NOT_OPEN_MESSAGE } from '../lib/job-review-finish';
import { logAudit } from '../lib/audit';
import { NumberOutOfReachRefusal, numberCarryCheckForReq } from '../lib/communication/numberGuard';

/**
 * GET /api/jobs/:id/review - the office review panel's content (Roles & Permissions, PRD 6, S06.8): the job summary and
 * the change list, built by M8 from the job's own history. Only a holder of Office review gets it (the route's guard
 * names the switch, and the job's row scope is asked here), and only for a job that has reached the review.
 */
export const NOT_IN_REVIEW_MESSAGE = 'This job is not in office review.';
export { REVIEW_NOT_OPEN_MESSAGE };
export const ITEM_MOVED_ON_MESSAGE = 'Something changed on this item while you were reviewing. Look at the new version and check it again.';

/** The job opened for the person's review: their row scope and the Office review switch, answered once for every route. */
async function openJobForReview(req: Request, res: Response): Promise<{ id: string; status: string } | null> {
  const id = String(req.params.id);
  const job = await prisma.job.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true, status: true } });
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  // The person must be able to open the job, and hold Office review for it under their row scope.
  if (!(await canAccessRow(req, 'Job', prisma.job, id)) || !(await canActOnRow(req, 'Job', prisma.job, id, 'office_review'))) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return job;
}

const readFor = (req: Request, jobId: string) =>
  readJobReview({
    orgId: req.user!.organization_id,
    jobId,
    mayCosts: canSeeCosts(req),
    openInvoices: (ids) => openableInvoiceIds(req, ids),
  });

export async function getReview(req: Request, res: Response) {
  try {
    const job = await openJobForReview(req, res);
    if (!job) return;
    if (!jobHasReview(job.status as Parameters<typeof jobHasReview>[0])) {
      res.status(409).json({ error: NOT_IN_REVIEW_MESSAGE });
      return;
    }
    res.json({ review: await readFor(req, job.id) });
  } catch (err) {
    logger.error('Get job review error:', err);
    res.status(500).json({ error: 'Failed to load the review' });
  }
}

// ─── Checks (S06.10) ───────────────────────────────────

const checkRequestSchema = z.object({
  item_key: z.string().min(1).max(300),
  entry_id: z.string().uuid(),
});
export const checkItemSchema = checkRequestSchema;
export const checkAllSchema = z.object({ items: z.array(checkRequestSchema).min(1).max(2000) });

/**
 * The review a check may be written to: the job is in Office review and the latest round is still open. The checks are
 * the review's own writes, so the job's lock is not asked and not loosened; the Office review switch is.
 */
async function reviewToCheck(req: Request, res: Response): Promise<{ jobId: string; roundId: string; review: ReviewAnswer } | null> {
  const job = await openJobForReview(req, res);
  if (!job) return null;
  if (job.status !== 'OFFICE_REVIEW') {
    res.status(409).json({ error: NOT_IN_REVIEW_MESSAGE });
    return null;
  }
  const review = await readFor(req, job.id);
  if (!review?.round || review.round.state !== 'OPEN') {
    res.status(409).json({ error: REVIEW_NOT_OPEN_MESSAGE });
    return null;
  }
  return { jobId: job.id, roundId: review.round.id, review };
}

/**
 * POST /api/jobs/:id/review/checks - check one item of the review, or the job summary (item_key "summary"). The body
 * carries the history entry the person saw as the item's latest; if the item has changed since, nothing is stored.
 */
export async function checkItem(req: Request, res: Response) {
  try {
    const open = await reviewToCheck(req, res);
    if (!open) return;
    const request = req.body as CheckRequest;
    const verdict = judgeCheck(open.review, request);
    if (verdict === 'not_found') {
      res.status(404).json({ error: 'Review item not found' });
      return;
    }
    if (verdict === 'customer') {
      res.status(400).json({ error: CUSTOMER_ONE_BY_ONE });
      return;
    }
    if (verdict === 'stale') {
      res.status(409).json({ error: ITEM_MOVED_ON_MESSAGE });
      return;
    }
    await storeChecks({ orgId: req.user!.organization_id, reviewId: open.roundId, checkedById: req.user!.id, checks: [request] });
    res.json({ review: await readFor(req, open.jobId) });
  } catch (err) {
    logger.error('Check review item error:', err);
    res.status(500).json({ error: 'Failed to save the check' });
  }
}

/**
 * POST /api/jobs/:id/review/checks/all - Mark all checked. The body is what the person saw (each item with its latest
 * entry). Of those, the job summary and every non-customer item that is still as they saw it is checked; customer items
 * are skipped (they are confirmed one by one), and so is anything that changed in the meantime, which then stays
 * unchecked and shows up in the "what is left" line.
 */
export async function checkAll(req: Request, res: Response) {
  try {
    const open = await reviewToCheck(req, res);
    if (!open) return;
    const wanted = (req.body as { items: CheckRequest[] }).items;
    const checks = wanted.filter((request) => judgeCheck(open.review, request) === 'ok');
    await storeChecks({ orgId: req.user!.organization_id, reviewId: open.roundId, checkedById: req.user!.id, checks });
    res.json({ review: await readFor(req, open.jobId) });
  } catch (err) {
    logger.error('Check all review items error:', err);
    res.status(500).json({ error: 'Failed to save the checks' });
  }
}

// ─── Customer decisions (S06.11) ───────────────────────

export const decisionSchema = z.object({
  item_key: z.string().min(1).max(300),
  entry_id: z.string().uuid(),
  choice: z.string().min(1).max(40).optional(),
});

const DECISION_REFUSALS = {
  not_found: { status: 404, error: 'Review item not found' },
  not_customer: { status: 400, error: 'Only a customer change takes a decision.' },
  bad_choice: { status: 400, error: 'That choice is not offered for this change.' },
  stale: { status: 409, error: ITEM_MOVED_ON_MESSAGE },
} as const;

/**
 * POST /api/jobs/:id/review/decisions - tick one customer item with the choice it showed, or change the choice of one
 * already ticked. Like the checks it is the review's own write (Office review only, never Edit customers, and the job's
 * lock is not asked), and it only RECORDS the decision: the customer is changed when the review is finished (S06.12).
 */
export async function decideCustomerItem(req: Request, res: Response) {
  try {
    const open = await reviewToCheck(req, res);
    if (!open) return;
    const request = req.body as DecisionRequest;
    const judged = judgeDecision(open.review, request);
    if (judged.verdict !== 'ok') {
      const refusal = DECISION_REFUSALS[judged.verdict];
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }
    await storeDecision({
      orgId: req.user!.organization_id,
      reviewId: open.roundId,
      decidedById: req.user!.id,
      contactEntryId: judged.contactEntryId,
      eventId: request.entry_id,
      choice: judged.choice,
    });
    res.json({ review: await readFor(req, open.jobId) });
  } catch (err) {
    logger.error('Decide review customer item error:', err);
    res.status(500).json({ error: 'Failed to save the decision' });
  }
}

// ─── Finish review (S06.12) ────────────────────────────

/** The round's version as the person loaded it (`review.version`); a request without it is refused as stale. */
export const finishSchema = z.object({ version: z.string().min(1).max(200).optional() });

/** The machine-readable code the screen reads to know why a finish was refused. */
export const REVIEW_CHANGED = 'REVIEW_CHANGED';
export const REVIEW_INCOMPLETE = 'REVIEW_INCOMPLETE';

// Finish review never asks about money or a cancel reason, so those kinds carry no code here.
const REFUSAL_CODE = {
  forbidden: undefined, status: JOB_CLOSE_OUT_REFUSED, stale: REVIEW_CHANGED, unchecked: REVIEW_INCOMPLETE, money_owed: undefined, amount: undefined, reason: undefined,
} as const;

/**
 * POST /api/jobs/:id/review/finish - Finish review: Office review to Ready to close, applying the customer decisions, in
 * one transaction (lib/job-review-finish). Office review is the only switch it asks: the customer's edit switch, Complete
 * jobs and Close jobs play no part, and Mark Done is a separate step. The body carries the version of the review the
 * person loaded; if anything changed since, nothing is done and the answer says so.
 */
export async function finish(req: Request, res: Response) {
  try {
    const job = await openJobForReview(req, res);
    if (!job) return;
    const user = req.user!;
    // The person's invoice reach is read BEFORE the transaction opens and asked on the transaction's own client: a query on
    // another connection from inside it waits for the one the transaction holds (the hosted pool has one) and fails the finish.
    const openInvoices = await invoiceOpenerFor(req);
    // Guard the number (lib/communication/numberGuard.ts), read here for the same reason.
    const mayCarry = await numberCarryCheckForReq(req);
    const result = await finishReview({
      orgId: user.organization_id,
      jobId: job.id,
      actor: { id: user.id, name: `${user.first_name} ${user.last_name}`.trim() || user.email },
      sentVersion: (req.body as z.infer<typeof finishSchema>).version ?? null,
      mayCosts: canSeeCosts(req),
      openInvoices,
      mayCarry,
    });
    if (result.customer_fields.length > 0) {
      void logAudit({
        req,
        action: 'customer.updated',
        resourceType: 'Customer',
        resourceId: result.customer_id,
        metadata: { fields: result.customer_fields, via: 'office_review', job_id: job.id },
      });
    }
    // S06.24: the job's people and every Close jobs holder who can open it hear that the job is ready to close. Queued, and sent
    // once the response has gone out: the finish has committed, and the alert's reads are nothing the person waits for.
    queueReviewAttention({ orgId: user.organization_id, actorId: user.id, jobId: job.id, onlyIfDone: false, items: [], readyToClose: true });
    res.json({ status: result.status, review: await readFor(req, job.id) });
  } catch (err) {
    if (err instanceof FinishRefusal) {
      const { kind, reason } = err.refusal;
      const code = REFUSAL_CODE[kind];
      res.status(kind === 'forbidden' ? 403 : 409).json({ error: reason, ...(code ? { code } : {}) });
      return;
    }
    if (err instanceof NumberOutOfReachRefusal) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error('Finish job review error:', err);
    res.status(500).json({ error: 'Failed to finish the review' });
  }
}
