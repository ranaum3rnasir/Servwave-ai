/**
 * Payments go-live slice 11 (PRD Module 4, call 4) - "Payments needing attention".
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
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { createRefund, getStripeForOrg, listPaymentIntentRefunds } from '../lib/stripe';
import { logAudit } from '../lib/audit';
import { logger } from '../lib/logger';
import { committedRefundCents, rederiveRefundTotals, toCents, UNAPPLIED_REFUND_REASON } from '../lib/payment-ledger';
import { clearUnappliedCaptureAlerts, ledgerPaymentIdOf } from '../lib/unapplied-capture';
import { inAppRefundState } from './invoice.controller';
import { REFUND_ROW_METADATA_KEY, completeReservedRefund, releaseIfRefused, releaseRefundReservation, reserveRefund } from '../lib/in-app-refund';
import { BANK_REFUND_WINDOW_MESSAGE, isPastBankRefundWindow, REFUND_UNCONFIRMED_MESSAGE, refusedRefundAnswer } from '../lib/refund-rules';

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
  invoice: { id: string; invoice_number: string; status: string } | null;
};

/** The staff view of one record. */
function toItem(row: Row) {
  const kind = row.reason === REFUND_REASON ? 'REFUND' : 'PAYMENT';
  return {
    id: row.id,
    kind,
    reason: row.reason,
    amount: row.amount != null ? Number(row.amount.toString()) : null,
    status: row.status,
    created_at: row.created_at.toISOString(),
    refunded_at: row.refunded_at?.toISOString() ?? null,
    invoice: row.invoice,
    // Only money whose connected account is on record: without it a refund would come out of
    // ServWave's own balance.
    can_refund: row.status === 'OPEN' && kind === 'PAYMENT' && !!row.stripe_payment_intent_id && !!row.stripe_account_id,
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
 * POST /api/payments-needing-attention/:id/refund - send the whole capture back (for an
 * overpayment, the part that was not applied), out of the account it landed in, and mark the record
 * REFUNDED with the refund's id. The refund names the record, so its own events find it and never
 * write the money down a second time. Money-first, like the invoice refund door: the record moves
 * only once the processor has taken the refund. A retry (a double click, a lost response) reuses the
 * same idempotency key, so the processor sends one refund; a refund that later fails reopens the
 * record (the reconciler), and the next click sends a new one.
 */
export async function refundPaymentNeedingAttention(req: Request, res: Response): Promise<void> {
  const where = { id: String(req.params.id), ...tenantWhere(req) };
  const record = await prisma.unappliedCapture.findFirst({
    where,
    select: { ...LIST_SELECT, updated_at: true, source_key: true, organization_id: true },
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
  // What the processor is asked to send back, in cents (the whole record unless it sits on a payment).
  let amountCents = recordCents;
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
    reservation = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${onPayment.invoice_id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      const refunds = await tx.refund.findMany({ where: { payment_id: onPayment.id, organization_id: orgId }, select: { amount: true, state: true } });
      const faceLeftCents = Math.min(recordFaceCents, paidFaceCents - committedRefundCents(refunds) - appliedCents);
      if (faceLeftCents <= 0) return null;
      amountCents = faceLeftCents + (wholeDebit && paidFaceCents > 0 ? Math.round((tipCents * faceLeftCents) / paidFaceCents) : 0);
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
      res.status(409).json({ error: ALREADY_SENT_BACK });
      return;
    }
  }
  const release = async () => {
    if (reservation) await releaseRefundReservation(orgId, reservation.id);
  };
  const processor = getStripeForOrg({ stripe_account_id: accountId });
  // An earlier attempt may have sent this refund even though its answer was an error (a 5xx) or
  // never arrived: the refund names this record, so it is found here and stored, never sent twice.
  // When the refunds already on the payment cannot be read, nothing is sent.
  let alreadySent: { id: string; status?: string | null; amount: number } | undefined;
  try {
    alreadySent = (await listPaymentIntentRefunds(paymentIntentId, processor)).find(
      (r) => r.metadata?.unapplied_capture_id === record.id && r.status !== 'failed' && r.status !== 'canceled',
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
          // Slice 29: the row held for it, so its own event completes that row.
          ...(reservation ? { [REFUND_ROW_METADATA_KEY]: reservation.id } : {}),
        },
        // Keyed on the record as it stands: a retry of this click sends one refund, and a record
        // reopened by a failed refund, or whose last attempt the processor answered with a stored
        // error (updated_at moved), sends a new one.
        idempotencyKey: `unapplied-capture-refund:${record.id}:${record.updated_at.getTime()}`,
      });
    } catch (err) {
      logger.error(`Refund of unapplied capture ${record.id} (org ${where.organization_id}) failed:`, err);
      if (answerIsStoredAgainstKey(err)) await nextAttempt(record);
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
            description: `$${((amountCents ?? recordCents ?? 0) / 100).toFixed(2)} that could not be recorded on this invoice was sent back to the customer`,
            metadata: { unapplied_capture_id: record.id, processor_refund_id: refund.id, reason: record.reason },
            created_by: req.user!.id,
          },
        });
      }
    }
    if (current.status === 'OPEN' || current.status === 'RESOLVED') {
      await tx.unappliedCapture.updateMany({
        where: { ...where, status: { in: ['OPEN', 'RESOLVED'] } },
        data: { status: 'REFUNDED', stripe_refund_id: refund.id, refunded_at: new Date() },
      });
    }
    return true;
  });
  if (!marked) {
    logger.error(`Refund ${refund.id} of unapplied capture ${record.id} failed before it was stored; the payment stays open`);
    res.status(502).json({ error: ATTENTION_REFUND_NOT_SENT });
    return;
  }
  const updated = await prisma.unappliedCapture.findFirstOrThrow({ where, select: LIST_SELECT });
  await clearUnappliedCaptureAlerts(prisma, where.organization_id, record.source_key);

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
    return tx.unappliedCapture.updateMany({ where: { ...where, status: 'OPEN' }, data: { status: 'RESOLVED' } });
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
