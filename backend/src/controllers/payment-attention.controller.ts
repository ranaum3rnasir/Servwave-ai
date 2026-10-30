/**
 * Payments go-live slice 11 (PRD Module 4, call 4) - the Needs attention card.
 *
 * Money the processor captured that ServWave could not apply to an invoice is written down as an
 * unapplied-capture record (lib/unapplied-capture.ts). This lists those records for the people
 * allowed to refund, and sends a capture back in full with one click. Nothing here refunds on its
 * own: a person decides.
 *
 * Every read and write is scoped to the caller's org. No processor id leaves this controller, and
 * the copy names ServWave Payments, never the processor.
 */
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { canSeePrices, scopeWhereForReq } from '../lib/permissions/enforce';
import { createRefund, getStripeForOrg, listPaymentIntentRefunds } from '../lib/stripe';
import { logAudit } from '../lib/audit';
import { logger } from '../lib/logger';
import { committedRefundCents, rederiveRefundTotals, toCents, UNAPPLIED_REFUND_REASON } from '../lib/payment-ledger';
import { clearUnappliedCaptureAlerts, countRefundOnCapture, ledgerPaymentIdOf } from '../lib/unapplied-capture';
import { UNAPPLIED_CLOSES_METADATA_KEY } from '../services/payment-reconciler/decide';
import { inAppRefundState } from './invoice.controller';
import { REFUND_ROW_METADATA_KEY, completeReservedRefund, releaseIfRefused, releaseRefundReservation, reserveRefund } from '../lib/in-app-refund';
import { BANK_REFUND_WINDOW_MESSAGE, isPastBankRefundWindow, REFUND_UNCONFIRMED_MESSAGE, refusedRefundAnswer } from '../lib/refund-rules';
import { CHOOSE_A_REASON, RESOLVE_REASONS_OTHER, resolveReasonSchema } from '../lib/resolve-reasons';
import { plainBody } from '../lib/request-body';
import { present } from '../services/payment-attention';
import {
  AttachRefusal, afterCaptureBooked, assertAttachable, assertNoUncountedRefund, bookCaptureOnInvoice, bookRefundOnInvoice, loadCapture, openableInvoiceWhere, readCapturePayer,
} from '../services/payment-attention/attach';
import { findUnapplied, searchInvoicesForCapture, unappliedDetail } from '../services/payment-attention/unapplied-detail';

/** Staff copy when the money could not be sent back. Names ServWave Payments, never the processor. */
export const ATTENTION_REFUND_NOT_SENT =
  "This refund couldn't be sent through ServWave Payments. Try again in a moment, or contact ServWave support.";

/** Staff copy when the money was already given back off its payment (from the invoice's own refund). */
const ALREADY_SENT_BACK =
  'This money was already refunded from its invoice, so there is nothing left to send back. Mark it resolved if nothing else is needed.';

/** Staff copy for money whose account is not on record. Names ServWave Payments, never the processor. */
const NO_ACCOUNT_ON_RECORD =
  "ServWave Payments can't tell which account this payment landed in, so it can't be sent back from here. Contact ServWave support, and mark it resolved once it is dealt with.";

/** A refund that went out for a payment ServWave never recorded is listed, but is not money to send back. */
const REFUND_REASON = 'REFUND_UNMATCHED';

const LIST_SELECT = {
  id: true,
  reason: true,
  amount: true,
  status: true,
  refunded_at: true,
  created_at: true,
  stripe_payment_intent_id: true,
  stripe_account_id: true,
  // V7-09b: what already went back (a partial refund leaves the record OPEN with the rest).
  refunded_amount: true,
  // The status says WHY an invoice that could not take a payment could not (already paid, voided, or neither).
  invoice: { select: { id: true, invoice_number: true, status: true } },
} as const;

type Row = {
  id: string;
  reason: string;
  amount: { toString(): string } | null;
  status: 'OPEN' | 'REFUNDED' | 'RESOLVED';
  refunded_at: Date | null;
  created_at: Date;
  stripe_payment_intent_id: string | null;
  stripe_account_id: string | null;
  refunded_amount: { toString(): string };
  invoice: { id: string; invoice_number: string; status: string } | null;
};

/** The staff view of one record. */
function toItem(row: Row) {
  const kind = row.reason === REFUND_REASON ? 'REFUND' : 'PAYMENT';
  return {
    id: row.id,
    kind,
    reason: row.reason,
    // What is on the record now: the amount less what already went back (attached or resolved after a partial refund, it
    // shows what it held then). A record closed by a refund keeps its whole amount.
    amount: row.amount != null ? (row.status === 'REFUNDED' ? Number(row.amount.toString()) : Math.max(toCents(row.amount.toString()) - toCents(row.refunded_amount.toString()), 0) / 100) : null,
    status: row.status,
    created_at: row.created_at.toISOString(),
    refunded_at: row.refunded_at?.toISOString() ?? null,
    invoice: row.invoice,
    // Only money whose connected account is on record: without it a refund would come out of
    // ServWave's own balance.
    can_refund: row.status === 'OPEN' && kind === 'PAYMENT' && !!row.stripe_payment_intent_id && !!row.stripe_account_id
      && (row.amount == null || toCents(row.amount.toString()) > toCents(row.refunded_amount.toString())),
    // Any open row can be closed by a person who dealt with it (a stray refund has nothing to send).
    can_resolve: row.status === 'OPEN',
  };
}

/**
 * The records the caller may see and act on. The refund permission is not the right to see every
 * invoice: a caller whose Invoice scope is narrowed (their own, attached...) gets only the records
 * on an invoice that scope opens, the same per-row rule the invoice refund door applies (#106). A
 * record on the org itself (no invoice) is for callers who see every invoice. {} = org-wide.
 */
export async function visibleRecordsWhere(req: Request): Promise<Prisma.UnappliedCaptureWhereInput> {
  const invoiceScope = await scopeWhereForReq(req, 'Invoice');
  if (Object.keys(invoiceScope).length === 0) return {};
  return { invoice: { is: invoiceScope as Prisma.InvoiceWhereInput } };
}

/** Whether this org's record `id` is one the caller may act on (see visibleRecordsWhere). */
async function canActOnRecord(req: Request, id: string): Promise<boolean> {
  const visible = await visibleRecordsWhere(req);
  if (Object.keys(visible).length === 0) return true;
  return !!(await prisma.unappliedCapture.findFirst({ where: { id, ...tenantWhere(req), ...visible }, select: { id: true } }));
}

const NOT_ALLOWED = 'Insufficient permissions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/payments-needing-attention/:id - one unapplied item for its drawer (V7-09a, BE-10): the reasons in words, the
 * invoice it was meant for, who paid, the invoices that could take it and the actions this caller holds. Reading needs
 * View payments (the router); the actions keep their own switches. The same body answers through
 * GET /api/payments-page/attention/:key.
 */
export async function getPaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);
    const row = UUID.test(id) ? await findUnapplied(req, id.toLowerCase()) : null;
    if (!row) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json(await unappliedDetail(req, row));
  } catch (error) {
    logger.error('payments-needing-attention detail failed', error);
    res.status(500).json({ error: 'Could not load this item' });
  }
}

/**
 * GET /api/payments-needing-attention/:id/invoices?q= - the Attach dialog's invoice search: up to 25 invoices with
 * can_attach and balance on every row, so the dialog can grey out the ones that cannot take the money. Gated like the detail.
 */
export async function searchInvoicesForPaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);
    const row = UUID.test(id) ? await findUnapplied(req, id.toLowerCase()) : null;
    if (!row) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    // An item on an invoice the caller cannot open is shown restricted; the search would reveal other people's invoices.
    const [item] = await present(req, [row]);
    if (item.restricted) {
      res.status(403).json({ error: NOT_ALLOWED });
      return;
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    res.json({ items: await searchInvoicesForCapture(req, row, q) });
  } catch (error) {
    logger.error('payments-needing-attention invoice search failed', error);
    res.status(500).json({ error: 'Could not search invoices' });
  }
}

/**
 * POST /api/payments-needing-attention/:id/attach { invoice_id } (V7-09b, BE-10) - put the whole amount still on an
 * unapplied payment on an open invoice of this company, or tie a stray refund to the invoice it belongs to. A payment
 * larger than the invoice's balance is refused (no overpaid invoices): 409 INVOICE_BALANCE_BELOW_PAYMENT, nothing written.
 * How the money was paid is read from the processor before the transaction; a failed read refuses the attach.
 */
export async function attachPaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const body = attachBodySchema.safeParse(plainBody(req));
  if (!UUID.test(id) || !body.success) {
    res.status(400).json({ error: 'Choose an invoice.', field: 'invoice_id' });
    return;
  }
  try {
    const capture = await loadCapture(req, id.toLowerCase());
    if (!capture) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    if (!(await canActOnRecord(req, capture.id))) {
      res.status(403).json({ error: NOT_ALLOWED });
      return;
    }
    const kind = capture.reason === REFUND_REASON ? 'REFUND' : 'PAYMENT';
    assertAttachable(capture, kind);
    // The invoice must be this company's and one the caller can open (the same reach the Attach search uses).
    const invoiceId = body.data.invoice_id;
    const target = await prisma.invoice.findFirst({ where: await openableInvoiceWhere(req, invoiceId.toLowerCase()), select: { id: true } });
    if (!target) {
      res.status(404).json({ error: 'Invoice not found.' });
      return;
    }
    const orgId = req.user!.organization_id;
    const actor = { id: req.user!.id, name: `${req.user!.first_name} ${req.user!.last_name}`.trim() };
    if (kind === 'REFUND') {
      const refund = await prisma.$transaction((tx) => bookRefundOnInvoice(tx, { organizationId: orgId, captureId: capture.id, invoiceId: target.id, actor, figures: canSeePrices(req) }));
      await clearUnappliedCaptureAlerts(prisma, orgId, capture.source_key);
      void logAudit({
        action: 'billing.unapplied_capture_attached', resourceType: 'Invoice', resourceId: target.id, orgId, actorId: actor.id,
        metadata: { unapplied_capture_id: capture.id, invoice_number: refund.invoiceNumber, amount: refund.amountCents / 100, kind: 'REFUND' },
      });
      res.json({ item: await itemOf(req, capture.id), invoice: { id: target.id, number: refund.invoiceNumber } });
      return;
    }
    // Before the transaction: the pool allows one connection, and a read must not hold a lock.
    const payer = await readCapturePayer(capture);
    await assertNoUncountedRefund(capture);
    const booked = await prisma.$transaction((tx) => bookCaptureOnInvoice(tx, {
      organizationId: orgId, capture, invoiceId: target.id, payer, actor, figures: canSeePrices(req),
      note: (number) => `Attached to ${number}`,
      history: (number, who) => `Payment from payments needing attention attached to ${number} by ${who}`,
    }), { timeout: 20_000 });
    await afterCaptureBooked({ organizationId: orgId, capture, booked, actor, via: 'attach' });
    res.json({
      item: await itemOf(req, capture.id),
      invoice: { id: target.id, number: booked.invoiceNumber, status: booked.newStatus },
    });
  } catch (error) {
    if (error instanceof AttachRefusal) {
      res.status(error.status).json({ code: error.code, error: error.message, ...error.extra });
      return;
    }
    logger.error('payments-needing-attention attach failed', error);
    res.status(500).json({ error: 'Could not attach this payment' });
  }
}

async function itemOf(req: Request, id: string) {
  const row = await prisma.unappliedCapture.findFirstOrThrow({ where: { id, ...tenantWhere(req) }, select: LIST_SELECT });
  return toItem(row);
}

/** GET /api/payments-needing-attention - open records first, newest first. */
export async function listPaymentsNeedingAttention(req: Request, res: Response): Promise<void> {
  const rows = await prisma.unappliedCapture.findMany({
    where: { ...tenantWhere(req), ...(await visibleRecordsWhere(req)) },
    orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
    take: 200,
    select: LIST_SELECT,
  });
  res.json({ items: rows.map(toItem) });
}

/**
 * POST /api/payments-needing-attention/:id/refund { amount? } - send the capture back (for an
 * overpayment, the part that was not applied), out of the account it landed in: all that is left, or the
 * amount typed (V7-09b: a partial refund leaves the record OPEN with the rest), and mark the record
 * REFUNDED with the refund's id once the whole amount is back. The refund names the record, so its own events find it and never
 * write the money down a second time. Money-first, like the invoice refund door: the record moves
 * only once the processor has taken the refund. A retry (a double click, a lost response) reuses the
 * same idempotency key, so the processor sends one refund; a refund that later fails reopens the
 * record (the reconciler), and the next click sends a new one.
 */
export async function refundPaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  const where = { id: String(req.params.id), ...tenantWhere(req) };
  const record = await prisma.unappliedCapture.findFirst({
    where,
    select: { ...LIST_SELECT, updated_at: true, source_key: true, organization_id: true, counted_refund_ids: true },
  });
  if (!record) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  if (!(await canActOnRecord(req, record.id))) {
    res.status(403).json({ error: NOT_ALLOWED });
    return;
  }
  if (record.reason === REFUND_REASON) {
    res.status(400).json({ error: 'This is a refund that already went out to a customer. There is no payment to send back.' });
    return;
  }
  if (record.status !== 'OPEN') {
    res.status(409).json({ error: record.status === 'REFUNDED' ? 'This payment was already refunded.' : 'This payment was already resolved.' });
    return;
  }
  const paymentIntentId = record.stripe_payment_intent_id;
  if (!paymentIntentId) {
    res.status(400).json({ error: "This payment can't be refunded through ServWave Payments. Refund the customer another way." });
    return;
  }
  // No account on record (a legacy record, or an event that named none): the processor would take
  // the refund from the platform's own balance. Never sent; the record stays open to be resolved.
  const accountId = record.stripe_account_id;
  if (!accountId) {
    res.status(400).json({ error: NO_ACCOUNT_ON_RECORD });
    return;
  }

  const orgId = where.organization_id;
  const paymentId = ledgerPaymentIdOf(record.source_key);
  const recordCents = record.amount != null ? toCents(record.amount.toString()) : undefined;
  // V7-09b (C-32): what is still on the record, and what this click asks for (the rest unless an amount was typed).
  const leftCents = recordCents != null ? recordCents - toCents(record.refunded_amount.toString()) : undefined;
  if (leftCents != null && leftCents <= 0) {
    res.status(409).json({ error: ALREADY_SENT_BACK });
    return;
  }
  // A body whose amount is not a number or text (a boolean, an object) is the same "not an amount" answer as text that is not a number.
  const body = refundBodySchema.safeParse(plainBody(req));
  const asked = body.success ? parseRefundAmount(body.data.amount, leftCents, canSeePrices(req)) : { error: NOT_AN_AMOUNT };
  if (asked.error) {
    res.status(400).json({ error: asked.error, field: 'amount' });
    return;
  }
  // True when this refund gives back everything still on the record: the record then closes.
  const closes = asked.cents == null || asked.cents === leftCents;
  // What the processor is asked to send back, in cents (what is left unless an amount was typed).
  let amountCents = asked.cents ?? leftCents;
  // V7-09b: say a refund is on its way, under the record's row lock and only while it is OPEN, so attaching the same
  // money to an invoice (which waits for this to be fresh) can never run alongside it. Raw SQL: the record's
  // updated_at is part of the refund's key and must not move here.
  const claimed = await prisma.$executeRaw`UPDATE unapplied_captures SET refund_started_at = now()
    WHERE id = ${record.id}::uuid AND organization_id = ${orgId}::uuid AND status = 'OPEN'`;
  if (claimed === 0) {
    res.status(409).json({ error: 'This payment was already attached, refunded or resolved.' });
    return;
  }
  const onPayment = paymentId && recordCents != null
    ? await prisma.payment.findFirst({
        where: { id: paymentId, invoice: { organization_id: orgId } },
        select: { id: true, invoice_id: true, method: true, amount: true, tip_amount: true, paid_at: true },
      })
    : null;
  // Slice 29: money that sits on a payment row is held under the invoice lock before the processor
  // is asked (lib/in-app-refund.ts), so the invoice's own refund door, at the same moment, sees it.
  let reservation: { id: string } | null = null;
  if (onPayment && recordCents != null) {
    if (isPastBankRefundWindow(onPayment)) {
      res.status(400).json({ error: BANK_REFUND_WINDOW_MESSAGE });
      return;
    }
    // Money that can also be refunded from the invoice. The invoice keeps what was applied from
    // this payment (its face amount less this record's money), so whatever has already been given
    // back off the payment, or is on its way back, came out of this money first: only the rest is
    // sent, and the same dollars never go back twice. A debit none of which was applied
    // (INVOICE_NOT_PAYABLE) goes back whole, its tip with it; the ledger books the face amount
    // only, as every refund does (the tip never entered it).
    const paidFaceCents = toCents(onPayment.amount);
    const tipCents = toCents(onPayment.tip_amount ?? 0);
    const wholeDebit = record.reason === 'INVOICE_NOT_PAYABLE';
    const recordFaceCents = wholeDebit ? paidFaceCents : recordCents;
    const appliedCents = paidFaceCents - recordFaceCents;
    // Earlier partial refunds are already held on the payment (committedRefundCents below), so "the rest" needs no
    // subtraction here; a typed amount is asked for as it is.
    // A typed amount is what the operator confirmed and what the processor is sent, to the cent. For a debit that goes back
    // whole with its tip, the typed figure is of the charged total, so the booked face share is worked out from it.
    const chargedCents = wholeDebit ? paidFaceCents + tipCents : paidFaceCents;
    const askedFaceCents = asked.cents == null
      ? recordFaceCents
      : wholeDebit && chargedCents > 0 ? Math.round((asked.cents * paidFaceCents) / chargedCents) : asked.cents;
    reservation = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${onPayment.invoice_id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      const refunds = await tx.refund.findMany({ where: { payment_id: onPayment.id, organization_id: orgId }, select: { amount: true, state: true } });
      const faceLeftCents = Math.min(askedFaceCents, paidFaceCents - committedRefundCents(refunds) - appliedCents);
      if (faceLeftCents <= 0) return null;
      amountCents = asked.cents != null && faceLeftCents === askedFaceCents
        ? asked.cents
        : faceLeftCents + (wholeDebit && paidFaceCents > 0 ? Math.round((tipCents * faceLeftCents) / paidFaceCents) : 0);
      return reserveRefund(tx, {
        invoice_id: onPayment.invoice_id,
        payment_id: onPayment.id,
        amount: faceLeftCents / 100,
        tax_portion: 0,
        non_taxable_concession: false,
        method: onPayment.method,
        reason: UNAPPLIED_REFUND_REASON,
        reason_category: record.reason === 'OVERPAYMENT' ? 'OVERPAYMENT' : 'OTHER',
        from_unapplied_capture: true,
        refunded_by: req.user!.id,
        organization_id: orgId,
      });
    });
    if (!reservation) {
      await prisma.$executeRaw`UPDATE unapplied_captures SET refund_started_at = NULL WHERE id = ${record.id}::uuid AND organization_id = ${orgId}::uuid`;
      res.status(409).json({ error: ALREADY_SENT_BACK });
      return;
    }
  }
  // Nothing went out: the money may be attached again at once.
  const clearClaim = () => prisma.$executeRaw`UPDATE unapplied_captures SET refund_started_at = NULL WHERE id = ${record.id}::uuid AND organization_id = ${orgId}::uuid`;
  const release = async () => {
    if (reservation) await releaseRefundReservation(orgId, reservation.id);
    await clearClaim();
  };
  const processor = getStripeForOrg({ stripe_account_id: accountId });
  // An earlier attempt may have sent this refund even though its answer was an error (a 5xx) or
  // never arrived: the refund names this record, so it is found here and stored, never sent twice.
  // When the refunds already on the payment cannot be read, nothing is sent.
  let alreadySent: { id: string; status?: string | null; amount: number } | undefined;
  try {
    // A refund already counted on the record (an earlier partial one) is not this click's: it was dealt with. Without a
    // payment row the amount must be the one asked for now, so a lost answer for another amount does not stand in.
    alreadySent = (await listPaymentIntentRefunds(paymentIntentId, processor)).find(
      (r) => r.metadata?.unapplied_capture_id === record.id && r.status !== 'failed' && r.status !== 'canceled'
        && !record.counted_refund_ids.includes(r.id) && (reservation || amountCents == null || r.amount === amountCents),
    );
  } catch (err) {
    logger.error(`Refund list for unapplied capture ${record.id} (org ${where.organization_id}) failed:`, err);
    await release();
    res.status(502).json({ error: ATTENTION_REFUND_NOT_SENT });
    return;
  }
  let refund: { id: string; status?: string | null };
  if (alreadySent) {
    refund = alreadySent;
    if (amountCents != null) amountCents = alreadySent.amount;
  } else {
    try {
      refund = await createRefund(paymentIntentId, processor, amountCents, {
        metadata: {
          source: 'in_app',
          unapplied_capture_id: record.id,
          // V7-09b: this refund gives back the whole rest, so the record closes when it lands.
          ...(closes ? { [UNAPPLIED_CLOSES_METADATA_KEY]: '1' } : {}),
          // Slice 29: the row held for it, so its own event completes that row.
          ...(reservation ? { [REFUND_ROW_METADATA_KEY]: reservation.id } : {}),
        },
        // Keyed on the record as it stands: a retry of this click sends one refund, and a record
        // reopened by a failed refund, or whose last attempt the processor answered with a stored
        // error (updated_at moved), sends a new one.
        // V7-09b: the cents are part of it, so a different amount is a different refund.
        idempotencyKey: `unapplied-capture-refund:${record.id}:${record.updated_at.getTime()}:${amountCents ?? 'all'}`,
      });
    } catch (err) {
      logger.error(`Refund of unapplied capture ${record.id} (org ${where.organization_id}) failed:`, err);
      if (answerIsStoredAgainstKey(err)) await nextAttempt(record);
      // A definite refusal (4xx) sent nothing: the claim is lifted. An answer that never arrived keeps it (it may have gone out).
      const refusedStatus = (err as { statusCode?: unknown } | null)?.statusCode;
      if (typeof refusedStatus === 'number' && refusedStatus >= 400 && refusedStatus < 500 && refusedStatus !== 409 && refusedStatus !== 429) await clearClaim();
      // Only a definite refusal frees the money. An answer that never arrived (timeout, dropped
      // connection, 5xx, 409) may mean the refund exists, so its hold stays and its event completes it.
      if (reservation && !(await releaseIfRefused(orgId, reservation.id, err))) {
        res.status(502).json({ error: REFUND_UNCONFIRMED_MESSAGE });
        return;
      }
      // A refund the payout balance cannot cover says so (slice 29); anything else keeps the
      // general "couldn't be sent".
      const refused = refusedRefundAnswer(err);
      res.status(refused.status === 400 ? 400 : 502).json({ error: refused.status === 400 ? refused.error : ATTENTION_REFUND_NOT_SENT });
      return;
    }
  }
  if (refund.status === 'failed' || refund.status === 'canceled') {
    logger.error(`Refund ${refund.id} of unapplied capture ${record.id} came back ${refund.status}`);
    await nextAttempt(record);
    await release();
    res.status(502).json({ error: ATTENTION_REFUND_NOT_SENT });
    return;
  }

  const marked = await prisma.$transaction(async (tx) => {
    // The same locks, in the same order, the reconciler takes for this refund's events: the
    // refund's own lock, then the invoice, then the record. A refund.failed it is mid-way through
    // (it read the record OPEN and is about to keep the failure) finishes first, and its failure is
    // seen below; one that arrives later reads the record this commit leaves.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${refund.id}`}, 0))`;
    // Money that sat on a payment row (a bank payment that cleared for more than the balance, or
    // onto an invoice that could no longer take it) comes off that payment in the invoice's totals,
    // once (PRD story 40): the row held for it gets the processor's refund id, under the invoice
    // lock the reconciler takes too, so its event completes this row instead of writing a second.
    if (onPayment && reservation) {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${onPayment.invoice_id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      await completeReservedRefund(tx, {
        refundRowId: reservation.id,
        organizationId: orgId,
        stripeRefundId: refund.id,
        state: inAppRefundState(refund.status, onPayment.method),
      });
      await rederiveRefundTotals(tx, { invoiceId: onPayment.invoice_id, organizationId: orgId });
    }
    await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${record.id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
    const current = await tx.unappliedCapture.findFirstOrThrow({ where, select: { status: true, failed_refund_ids: true } });
    // A refund whose failure already landed (events arrive in any order) never marks the record:
    // the money is still here. A REFUNDED record is left as it is: the refund's own event may
    // already have marked it (it carries the record's id), and that is the same refund. A record
    // someone marked resolved while this refund was on its way out is marked too: the money went
    // back, and that is what the record must say.
    if (current.failed_refund_ids.includes(refund.id)) return false;
    // Slice 28b: the invoice's own history says the money went back (a voided invoice's timeline
    // otherwise ends at "payment was not recorded"). One entry per processor refund.
    if (record.invoice) {
      const written = await tx.timelineEvent.findFirst({
        where: { organization_id: orgId, entity_type: 'INVOICE', entity_id: record.invoice.id, event_type: 'PAYMENT_SENT_BACK', metadata: { path: ['processor_refund_id'], equals: refund.id } },
        select: { id: true },
      });
      if (!written) {
        await tx.timelineEvent.create({
          data: {
            organization_id: orgId,
            entity_type: 'INVOICE',
            entity_id: record.invoice.id,
            event_type: 'PAYMENT_SENT_BACK',
            description: 'A payment that could not be recorded on this invoice was sent back to the customer',
            metadata: { unapplied_capture_id: record.id, processor_refund_id: refund.id, reason: record.reason, amount: (amountCents ?? recordCents ?? 0) / 100 },
            created_by: req.user!.id,
          },
        });
      }
    }
    // V7-09b: counted once (the refund's own event may have counted it already) and the record closes only when the
    // whole amount is back. Who sent it back and when (V7-05b); resolution_note stays null here.
    await countRefundOnCapture(tx, {
      organizationId: orgId, recordId: record.id, refundId: refund.id, refundCents: amountCents ?? recordCents ?? 0, closes,
      closedBy: { id: req.user!.id, name: `${req.user!.first_name} ${req.user!.last_name}`.trim() },
    });
    await tx.$executeRaw`UPDATE unapplied_captures SET refund_started_at = NULL WHERE id = ${record.id}::uuid AND organization_id = ${orgId}::uuid`;
    return true;
  });
  if (!marked) {
    logger.error(`Refund ${refund.id} of unapplied capture ${record.id} failed before it was stored; the payment stays open`);
    res.status(502).json({ error: ATTENTION_REFUND_NOT_SENT });
    return;
  }
  const updated = await prisma.unappliedCapture.findFirstOrThrow({ where, select: LIST_SELECT });
  // The alert is read once the whole amount is back; a partial refund leaves it as it was.
  if (updated.status !== 'OPEN') await clearUnappliedCaptureAlerts(prisma, where.organization_id, record.source_key);

  void logAudit({
    action: 'billing.unapplied_capture_refunded',
    resourceType: record.invoice ? 'Invoice' : 'Organization',
    resourceId: record.invoice?.id ?? where.organization_id,
    orgId: where.organization_id,
    actorId: req.user!.id,
    metadata: {
      unapplied_capture_id: record.id,
      reason: record.reason,
      // What went back: money already refunded off its payment from the invoice was not sent again.
      amount: amountCents != null ? amountCents / 100 : null,
      processor_refund_id: refund.id,
    },
  });
  res.json({ item: toItem(updated) });
}

const NOT_AN_AMOUNT = 'Enter an amount above $0.00.';
/** The bodies of the V7 doors, read once at the boundary. */
const attachBodySchema = z.object({ invoice_id: z.string().regex(UUID) });
const refundBodySchema = z.object({ amount: z.union([z.number(), z.string(), z.null()]).optional() });
const resolveBodySchema = z.object({ reason: resolveReasonSchema(RESOLVE_REASONS_OTHER) });

const dollars = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The amount typed for a partial refund, in cents. None typed = the rest of the record. Anything that is not a number
 * above zero, or is above what is left, is refused with the two sentences the dialog shows. What is left is a figure, so a
 * person without See prices (`figures` false) is told to enter a smaller amount, not how much (re-audit P2-2).
 */
function parseRefundAmount(raw: number | string | null | undefined, leftCents: number | undefined, figures: boolean): { cents?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const n = typeof raw === 'number' ? raw : raw.trim() !== '' ? Number(raw) : NaN;
  const cents = Math.round(n * 100);
  if (!Number.isFinite(n) || cents <= 0) return { error: NOT_AN_AMOUNT };
  if (leftCents != null && cents > leftCents) return { error: figures ? `Enter ${dollars(leftCents)} or less.` : 'Enter a smaller amount.' };
  return { cents };
}

/**
 * Whether the processor stored this error as the answer to the key, so the next click needs a new
 * one. It replays a stored answer for a day, failures included. A 4xx is a definite "no": no refund
 * was made. A 5xx is stored too, but may mean the refund went out: the next click finds that refund
 * on the payment before it sends anything. A 409 (another request under the key is still running)
 * or a 429 (this one never ran) is not stored, and a lost answer (no status) may still be running:
 * all three keep the key, so the processor sends one refund.
 */
function answerIsStoredAgainstKey(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status !== 'number') return false;
  return status !== 409 && status !== 429;
}

/**
 * The attempt the processor answered "no" is over: the record's updated_at (the refund key) moves, so
 * the next click sends a new refund instead of replaying that answer. Only from the attempt's own
 * starting point, so a double click that failed twice moves it once.
 */
async function nextAttempt(record: { id: string; updated_at: Date; organization_id: string }): Promise<void> {
  await prisma.unappliedCapture.updateMany({
    where: { id: record.id, organization_id: record.organization_id, status: 'OPEN', updated_at: record.updated_at },
    // Always a later instant than the key it replaces, even within the same millisecond.
    data: { updated_at: new Date(Math.max(Date.now(), record.updated_at.getTime() + 1)) },
  });
}

/**
 * POST /api/payments-needing-attention/:id/resolve - a person dealt with this row another way (a
 * stray refund they checked, money applied or sent back outside the list): it closes as RESOLVED
 * and stays listed. Nothing moves money. Only an OPEN row closes, so a refunded row, or a second
 * click, changes nothing.
 */
export async function resolvePaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  const parsed = resolveBodySchema.safeParse(plainBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: CHOOSE_A_REASON, field: 'reason' });
    return;
  }
  const reason = parsed.data.reason ?? null;
  const where = { id: String(req.params.id), ...tenantWhere(req) };
  const record = await prisma.unappliedCapture.findFirst({ where, select: { id: true, reason: true, status: true, amount: true, source_key: true, invoice: { select: { id: true } } } });
  if (!record) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  if (!(await canActOnRecord(req, record.id))) {
    res.status(403).json({ error: NOT_ALLOWED });
    return;
  }
  // Under the same row lock the refund's commit takes, so the two never interleave.
  const moved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${record.id}::uuid AND organization_id = ${where.organization_id}::uuid FOR UPDATE`;
    return tx.unappliedCapture.updateMany({ where: { ...where, status: 'OPEN' }, data: {
        status: 'RESOLVED', resolved_at: new Date(), resolved_by: req.user!.id,
        resolved_by_name: `${req.user!.first_name} ${req.user!.last_name}`.trim(), resolution_note: reason,
      },
    });
  });
  if (moved.count === 0) {
    res.status(409).json({ error: 'This payment was already refunded or resolved.' });
    return;
  }
  const updated = await prisma.unappliedCapture.findFirstOrThrow({ where, select: LIST_SELECT });
  await clearUnappliedCaptureAlerts(prisma, where.organization_id, record.source_key);
  void logAudit({
    action: 'billing.unapplied_capture_resolved',
    resourceType: record.invoice ? 'Invoice' : 'Organization',
    resourceId: record.invoice?.id ?? where.organization_id,
    orgId: where.organization_id,
    actorId: req.user!.id,
    metadata: {
      unapplied_capture_id: record.id,
      reason: record.reason,
      amount: record.amount != null ? Number(record.amount.toString()) : null,
    },
  });
  res.json({ item: toItem(updated) });
}
