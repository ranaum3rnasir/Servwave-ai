/**
 * Payments go-live slice 05: which ledger rows count as money.
 *
 * A payment counts toward amount paid, the balance, invoice status, "Collected" figures and
 * INVOICE_PAID only once it has SUCCEEDED. A bank debit sits in PROCESSING until it clears and
 * may still FAIL; neither is money collected. A refund counts toward refunded totals only once it
 * has SUCCEEDED: a bank refund is PENDING until the processor confirms it, and a FAILED refund
 * gave nothing back (PRD Module 5, call 7).
 *
 * Every reader that sums payments or refunds uses the predicates below, and the processor's
 * state events flip a row through settlePayment / settleRefund, so the balance, the status and
 * the automation all move at the one moment the money actually lands.
 */
import { Prisma } from '@prisma/client';
import type { InvoiceStatus, PaymentMethod, RefundState } from '@prisma/client';
import { prisma } from './prisma';
import { logAudit } from './audit';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { DEPOSIT_CREDIT_REFERENCE } from './deposit-credit';
import { writeUnappliedCaptureEntry, alertUnappliedCapture, type UnappliedCapture } from './unapplied-capture';
import { impliedMoneyStatus, refundStatusFor } from './invoice-money-status';

export { refundStatusFor };


/** A payment that counts as money collected: not voided, and SUCCEEDED. */
export const COUNTED_PAYMENT_WHERE = { voided_at: null, state: 'SUCCEEDED' } satisfies Prisma.PaymentWhereInput;

/**
 * A payment still on its way: not voided, and PROCESSING (a bank debit that has not cleared). It
 * does not reduce the balance, but it does reduce what can be paid online right now (payable now).
 */
export const PROCESSING_PAYMENT_WHERE = { voided_at: null, state: 'PROCESSING' } satisfies Prisma.PaymentWhereInput;

/**
 * Slice 18: money taken on THIS invoice - a live SUCCEEDED or PROCESSING payment that is not the
 * synthetic DEPOSIT-CREDIT row (that credit's cash sits on the deposit invoice). An invoice holding
 * one is never voided, whatever has been refunded: only voiding the payment releases it. The job
 * cancel guard (job.controller MONEY_PAYMENT_WHERE) applies the same rule.
 */
export const MONEY_TAKEN_PAYMENT_WHERE = {
  voided_at: null,
  state: { in: ['SUCCEEDED', 'PROCESSING'] },
  // `not` alone would drop NULL references in SQL, so a plain payment with no reference is named.
  OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }],
} satisfies Prisma.PaymentWhereInput;

/** A refund that counts as money given back. */
export const COUNTED_REFUND_WHERE = { state: 'SUCCEEDED' } satisfies Prisma.RefundWhereInput;

/** A refund that is given back or still on its way back: everything but FAILED. */
export const COMMITTED_REFUND_WHERE = { state: { not: 'FAILED' } } satisfies Prisma.RefundWhereInput;

// ---- Money math: integer cents ----------------------------------------------------------------
// Every sum and comparison below is done in whole cents, read exactly from the two-decimal amounts
// the database holds; dollars appear only where a value is written back to a Decimal column.

type Amount = Prisma.Decimal | number | string;

/** An amount as whole cents, read exactly (a Decimal or string is never routed through a float). */
export function toCents(amount: Amount): number {
  return new Prisma.Decimal(amount).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Whole cents back to dollars, for a Decimal column or a response. */
export const fromCents = (cents: number): number => cents / 100;

const sumCents = (rows: ReadonlyArray<{ amount: Amount }>): number => rows.reduce((s, r) => s + toCents(r.amount), 0);

/** Money paid on these payment rows, in cents. The caller picks the rows (COUNTED_PAYMENT_WHERE). */
export function paidCents(payments: ReadonlyArray<{ amount: Amount }>): number {
  return sumCents(payments);
}

/**
 * What an invoice can take now, in cents: its balance less any bank debit still clearing (the PROCESSING rows the caller
 * read with PROCESSING_PAYMENT_WHERE). The one rule the attach booking enforces and the Attach dialog's can_attach shows.
 */
export function payableNowCents(invoice: { amount_due: Amount; payments: ReadonlyArray<{ amount: Amount }> }): number {
  return Math.max(toCents(invoice.amount_due) - sumCents(invoice.payments), 0);
}

type RefundRow = { amount: Amount; state: RefundState };

/** Money given back, in cents: SUCCEEDED refunds only. This is what total_refunded reports. */
export function refundedCents(refunds: ReadonlyArray<RefundRow>): number {
  return sumCents(refunds.filter((r) => r.state === 'SUCCEEDED'));
}

/**
 * Money given back or still on its way back (SUCCEEDED + PENDING), in cents. A new refund must
 * leave room for a PENDING one, or the same dollars could be sent back twice while the first is
 * in flight.
 */
export function committedRefundCents(refunds: ReadonlyArray<RefundRow>): number {
  return sumCents(refunds.filter((r) => r.state !== 'FAILED'));
}

/**
 * What still holds back refundable money, in cents: refunds given back or on their way back (not
 * FAILED) on a payment that still stands. A refund on a voided payment (a chargeback, a returned
 * bank payment) left the ledger with that payment, so it holds back nothing of the money paid
 * since (payments go-live slice 09 review, slice 29). Every refund cap uses this.
 */
export function heldRefundCents(
  refunds: ReadonlyArray<RefundRow & { payment?: { voided_at: Date | string | null } | null }>,
): number {
  return committedRefundCents(refunds.filter((r) => !r.payment?.voided_at));
}

/**
 * Net collected, in cents: money paid that landed (SUCCEEDED, not voided, applied deposit credit
 * aside) minus money given back (SUCCEEDED refunds) on payments that still stand. A refund on a
 * voided payment (a chargeback, a returned bank payment) came out of money that has left the
 * ledger whole, so it is not taken off a second time (payments go-live slice 09).
 */
export function netCollectedCents(
  payments: ReadonlyArray<{ id?: string; amount: Amount; state: string; voided_at: Date | string | null; reference_number: string | null }>,
  refunds: ReadonlyArray<RefundRow & { payment_id?: string | null }>,
): number {
  const landed = payments.filter((p) => p.state === 'SUCCEEDED' && p.voided_at === null && p.reference_number !== DEPOSIT_CREDIT_REFERENCE);
  const voided = new Set(payments.filter((p) => p.voided_at !== null && p.id).map((p) => p.id!));
  return paidCents(landed) - refundedCents(refunds.filter((r) => !r.payment_id || !voided.has(r.payment_id)));
}

/**
 * Payments go-live slice 11: the reason a person reads on a refund row for money sent back from
 * the Needs attention card that sat on a payment row (the excess of an overpayment, or a
 * payment that cleared on an invoice that could no longer take it). Such a row is marked
 * from_unapplied_capture, and the maths reads only that marker (a staff refund may carry any
 * reason). It is money given back off that payment, so it counts in total_refunded, net collected
 * and the payment's refund stamp. It was never the invoice's money, so it does not move the
 * invoice's refund status. Staff-facing; names no processor.
 */
export const UNAPPLIED_REFUND_REASON = 'Payment needing attention sent back';

/** The statuses whose refund half settleRefund re-derives; any other status is left as it is. */
const REFUND_DERIVED_STATUSES: readonly InvoiceStatus[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

export type RefundOutcome = 'SUCCEEDED' | 'FAILED';

/**
 * A refund reached its outcome: a PENDING (bank) refund SUCCEEDED or FAILED, or a SUCCEEDED card
 * refund FAILED after the fact. total_refunded, net_collected and the refund status are then
 * re-derived from the SUCCEEDED rows, so a refund counts the moment the money is confirmed gone
 * and stops counting if it bounces. Idempotent: a refund already in that state, or FAILED, is
 * left alone. Returns whether anything changed.
 */
export async function settleRefund(input: {
  refundId: string;
  organizationId: string;
  to: RefundOutcome;
}): Promise<{ changed: boolean }> {
  return prisma.$transaction((tx) => settleRefundInTx(tx, input));
}

/**
 * settleRefund inside a transaction the caller already holds (the reconciler's apply step runs
 * every action of one event in one transaction). Same rules, same lock.
 */
export async function settleRefundInTx(tx: Prisma.TransactionClient, input: {
  refundId: string;
  organizationId: string;
  to: RefundOutcome;
}): Promise<{ changed: boolean }> {
  const { refundId, organizationId, to } = input;
  const target = await tx.refund.findFirst({
    where: { id: refundId, organization_id: organizationId },
    select: { invoice_id: true },
  });
  if (!target) throw new Error(`settleRefund: refund ${refundId} not found in org ${organizationId}`);

  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.invoice_id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { state: true } });
  if (refund.state === to || refund.state === 'FAILED') return { changed: false };
  await tx.refund.update({ where: { id: refundId }, data: { state: to } });
  await rederiveRefundTotals(tx, { invoiceId: target.invoice_id, organizationId });
  return { changed: true };
}

/**
 * Re-derive an invoice's refund totals from its ledger rows: total_refunded and net_collected from
 * the SUCCEEDED refunds and the SUCCEEDED (non-credit) payments, and the refund half of the
 * status. The caller holds the invoice lock. Writing the totals from the rows, never adding to a
 * cached figure, is what keeps a refund counted once however many doors and events touch it.
 */
export async function rederiveRefundTotals(
  tx: Prisma.TransactionClient,
  input: { invoiceId: string; organizationId: string },
): Promise<void> {
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organization_id: input.organizationId },
    select: {
      status: true,
      amount_due: true,
      // The refunded payment's void: a refund on a voided payment is not taken off net collected.
      refunds: { select: { amount: true, state: true, from_unapplied_capture: true, payment: { select: { voided_at: true } } } },
      // Every SUCCEEDED payment, applied deposit credit included: credit is money on the invoice
      // for the PARTIAL check, but not money the refund maths can send back.
      payments: { where: COUNTED_PAYMENT_WHERE, select: { amount: true, reference_number: true } },
    },
  });
  const paid = paidCents(invoice.payments.filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE));
  // Every refund that landed stays on record (total_refunded). One on a voided payment (a
  // chargeback, a returned bank payment) left with that payment, so neither net collected nor the
  // refund status counts it: an invoice re-paid in full after one reads PAID (slice 09).
  const refunded = refundedCents(invoice.refunds);
  const standing = invoice.refunds.filter((r) => !r.payment?.voided_at);
  const refundedOnStanding = refundedCents(standing);
  // Money sent back from the Needs attention card was never applied to the invoice: it comes
  // off both sides of the status maths, so an overpaid invoice whose excess went back reads PAID.
  const unappliedBack = refundedCents(standing.filter((r) => r.from_unapplied_capture));
  const status = !REFUND_DERIVED_STATUSES.includes(invoice.status)
    ? undefined
    : impliedMoneyStatus({
      amountDueCents: toCents(invoice.amount_due),
      paidCents: paid - unappliedBack,
      refundedCents: refundedOnStanding - unappliedBack,
      anyMoneyLanded: invoice.payments.length > 0,
    });
  await tx.invoice.update({
    where: { id: input.invoiceId, organization_id: input.organizationId },
    data: { total_refunded: fromCents(refunded), net_collected: fromCents(paid - refundedOnStanding), ...(status ? { status } : {}) },
  });
  await restampPaymentRefunds(tx, input);
}

/**
 * Re-derive each payment's refund stamp (refunded_amount / refunded_at, which the fees report
 * prorates by) from its SUCCEEDED refund rows. The caller holds the invoice lock. Only payments a
 * refund row names are touched: a PENDING refund is not stamped until it lands, a FAILED one comes
 * off, and a payment left with nothing given back has no stamp (payments go-live slice 08).
 */
export async function restampPaymentRefunds(
  tx: Prisma.TransactionClient,
  input: { invoiceId: string; organizationId: string },
): Promise<void> {
  const rows = await tx.refund.findMany({
    where: { invoice_id: input.invoiceId, organization_id: input.organizationId },
    select: { id: true, payment_id: true, amount: true, state: true, created_at: true },
  });
  const refunds = [...rows.filter((r) => r.payment_id), ...(await tieUnnamedRefundsToTheOnePayment(tx, input, rows))];
  const byPayment = new Map<string, typeof refunds>();
  for (const r of refunds) byPayment.set(r.payment_id!, [...(byPayment.get(r.payment_id!) ?? []), r]);
  for (const [paymentId, paymentRows] of byPayment) {
    const landed = paymentRows.filter((r) => r.state === 'SUCCEEDED');
    const cents = refundedCents(landed);
    const last = landed.reduce<Date | null>((at, r) => (at && at > r.created_at ? at : r.created_at), null);
    // Only a payment of this org (slice 09 review): the refund rows were read in the org, and the
    // payment they name is written in it too.
    await tx.payment.update({
      where: { id: paymentId, invoice: { organization_id: input.organizationId } },
      data: cents > 0 ? { refunded_amount: fromCents(cents), refunded_at: last } : { refunded_amount: null, refunded_at: null },
    });
  }
}

/**
 * Payments go-live slice 29: every refund now names the payment it came from. A refund recorded
 * before that rule (payment_id null) is tied to its payment where that can be told for certain: an
 * invoice with exactly one payment (the synthetic deposit-credit row aside) had nowhere else to give
 * money back from. On an invoice with several payments it is left as it is. Runs under the invoice
 * lock, whenever the invoice's money is written, so old refunds are backfilled as they are touched.
 * Returns the refunds it tied, now naming their payment.
 */
async function tieUnnamedRefundsToTheOnePayment<R extends { id: string; payment_id: string | null }>(
  tx: Prisma.TransactionClient,
  input: { invoiceId: string; organizationId: string },
  refunds: R[],
): Promise<R[]> {
  const unnamed = refunds.filter((r) => !r.payment_id);
  if (unnamed.length === 0) return [];
  const payments = await tx.payment.findMany({
    where: {
      invoice_id: input.invoiceId,
      invoice: { organization_id: input.organizationId },
      OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }],
    },
    select: { id: true },
    take: 2,
  });
  if (payments.length !== 1) return [];
  const paymentId = payments[0].id;
  await tx.refund.updateMany({
    where: { id: { in: unnamed.map((r) => r.id) }, organization_id: input.organizationId, payment_id: null },
    data: { payment_id: paymentId },
  });
  return unnamed.map((r) => ({ ...r, payment_id: paymentId }));
}

/**
 * A bank debit started: record it as a PROCESSING payment. This is the door the processor's
 * "payment is processing" event uses (slice 13). It writes the payment row and nothing else: the
 * balance, the invoice status and INVOICE_PAID stay where they are until settlePayment moves the
 * row to SUCCEEDED. Returns the payment's id.
 *
 * Keyed on the processor's payment id, which is stored on the row so the later outcome event can
 * find it. The event may arrive twice, even at the same time: under the invoice lock, a row that
 * already carries this id on this invoice is returned as it is, so one debit is one row and its
 * money can land only once.
 */
export async function recordProcessingPayment(input: {
  invoiceId: string;
  organizationId: string;
  amount: number;
  method: PaymentMethod;
  paymentIntentId: string;
  paidAt?: Date;
}): Promise<string> {
  const { invoiceId, organizationId, amount, method, paymentIntentId, paidAt } = input;
  if (!paymentIntentId) throw new Error('recordProcessingPayment: a processor payment id is required');
  return prisma.$transaction(async (tx) => {
    // Same lock order as every payment door, and the tenant check in the same statement.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new Error(`recordProcessingPayment: invoice ${invoiceId} not found in org ${organizationId}`);
    const existing = await tx.payment.findFirst({
      where: { invoice_id: invoiceId, stripe_payment_intent_id: paymentIntentId },
      select: { id: true },
    });
    if (existing) return existing.id;
    const payment = await tx.payment.create({
      data: {
        invoice_id: invoiceId, amount, method, paid_at: paidAt ?? new Date(),
        state: 'PROCESSING', created_by_source: 'CLIENT', stripe_payment_intent_id: paymentIntentId,
      },
      select: { id: true },
    });
    return payment.id;
  });
}

/** The statuses a payment landing may move: a settled or voided invoice keeps its status. Also what "open" means for attaching unapplied money. */
export const PAYABLE_STATUSES: readonly InvoiceStatus[] = ['DRAFT', 'SENT', 'PARTIAL'];

export type PaymentOutcome = 'SUCCEEDED' | 'FAILED';

export interface SettlePaymentResult {
  /** False when the payment had already left PROCESSING (a re-delivered event). */
  changed: boolean;
  /** True only on the one call that took the invoice to PAID. */
  becamePaid: boolean;
}

/** Staff-facing name for a payment by how it was made. Names no processor. */
function paymentLabel(method: PaymentMethod): string {
  if (method === 'ACH') return 'Bank payment';
  if (method === 'CARD') return 'Card payment';
  return 'Payment';
}

const usd = (cents: number): string => `$${fromCents(cents).toFixed(2)}`;

/** What settling a payment changed, for the effects that run once its transaction commits. */
export interface SettledPayment extends SettlePaymentResult {
  /** The payment's invoice, once the money was applied to it (SUCCEEDED). */
  invoice: { id: string; invoice_number: string } | null;
  /** Money that landed but could not be applied (written down inside the transaction). */
  unapplied: UnappliedCapture | null;
  /** Slice 28b: set on a bank payment that left PROCESSING, for the audit row written once it commits. */
  bankOutcome?: { paymentId: string; invoiceId: string; invoiceNumber: string; amount: number; to: PaymentOutcome };
}

/**
 * A PROCESSING payment reached its outcome. SUCCEEDED applies the money to the invoice (balance
 * down, PARTIAL or PAID, INVOICE_PAID once when it reaches the total); FAILED changes nothing but
 * the payment's own state. Idempotent: a payment no longer PROCESSING, or voided, is left alone.
 *
 * Money that lands is never dropped. If the invoice can no longer take a payment (voided, already
 * paid), the payment is still SUCCEEDED, the invoice is left as it is, and the whole amount is
 * written down as an unapplied capture. If it lands for more than the balance, the invoice is
 * settled to PAID and the excess is written down the same way. A DISPUTED invoice with a balance
 * still takes the money: the balance comes down and the status stays DISPUTED.
 */
export async function settlePayment(input: {
  paymentId: string;
  organizationId: string;
  to: PaymentOutcome;
}): Promise<SettlePaymentResult> {
  const outcome = await prisma.$transaction((tx) => settlePaymentInTx(tx, input));
  await afterPaymentSettled(outcome, input.organizationId);
  return { changed: outcome.changed, becamePaid: outcome.becamePaid };
}

/**
 * settlePayment inside a transaction the caller already holds (the reconciler's apply step runs
 * every action of one event in one transaction). Same rules, same lock. The caller runs
 * afterPaymentSettled once the transaction commits.
 */
export async function settlePaymentInTx(tx: Prisma.TransactionClient, input: {
  paymentId: string;
  organizationId: string;
  to: PaymentOutcome;
}): Promise<SettledPayment> {
  const { paymentId, organizationId, to } = input;
  const target = await tx.payment.findFirst({
    where: { id: paymentId, invoice: { organization_id: organizationId } },
    select: { invoice_id: true },
  });
  if (!target) throw new Error(`settlePayment: payment ${paymentId} not found in org ${organizationId}`);

  // Lock the invoice first (the same order every payment door uses), then re-read the payment
  // under it, so two deliveries of one event cannot both apply the money.
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.invoice_id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { amount: true, tip_amount: true, state: true, method: true, voided_at: true, stripe_payment_intent_id: true, stripe_account_id: true },
  });
  const nothing = { becamePaid: false, invoice: null, unapplied: null };
  // A voided payment is out of the ledger: its outcome never applies money (slice 09 review).
  if (payment.state !== 'PROCESSING' || payment.voided_at) return { ...nothing, changed: false };

  await tx.payment.update({ where: { id: paymentId }, data: { state: to } });
  if (to === 'FAILED') return { ...nothing, changed: true };

  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: target.invoice_id },
    select: { id: true, invoice_number: true, organization_id: true, status: true, amount_due: true },
  });
  const chargedCents = toCents(payment.amount);
  const label = paymentLabel(payment.method);
  const unappliedCapture = (
    reason: 'INVOICE_NOT_PAYABLE' | 'OVERPAYMENT', unappliedCents: number, description: string,
  ): UnappliedCapture => ({
    organizationId: invoice.organization_id,
    invoice: { id: invoice.id, invoice_number: invoice.invoice_number },
    description,
    metadata: { reason, payment_id: paymentId, charged_cents: chargedCents, unapplied_cents: unappliedCents, invoice_status: invoice.status },
    dedupKey: `billing.payment_unrecorded:payment:${paymentId}`,
    notificationData: { payment_label: label, reason },
    record: {
      amountCents: unappliedCents,
      paymentIntentId: payment.stripe_payment_intent_id,
      checkoutSessionId: null,
      accountId: payment.stripe_account_id,
      sourceKey: `payment:${paymentId}`,
    },
  });

  // A DISPUTED invoice that still has a balance takes the money too: a dispute on another payment
  // opened while this one cleared. The balance comes down and the invoice keeps reading DISPUTED
  // until the dispute closes and re-derives its status from the balance (fix round 2, slice 13).
  const disputedWithBalance = invoice.status === 'DISPUTED' && toCents(invoice.amount_due) > 0;
  if (!PAYABLE_STATUSES.includes(invoice.status) && !disputedWithBalance) {
    // None of the debit was applied, so all of it is listed to go back: the tip too (slice 29), as
    // the card path lists a checkout's whole total.
    const wholeCents = chargedCents + toCents(payment.tip_amount ?? 0);
    const unapplied = unappliedCapture('INVOICE_NOT_PAYABLE', wholeCents,
      `${label} of ${usd(wholeCents)} on invoice ${invoice.invoice_number} was not applied: the invoice was closed for payment (voided or already paid) while the payment was clearing.`);
    await writeUnappliedCaptureEntry(tx, unapplied);
    return { ...nothing, changed: true, unapplied };
  }

  const dueCents = toCents(invoice.amount_due);
  const excessCents = Math.max(chargedCents - dueCents, 0);
  const amountDueCents = dueCents - (chargedCents - excessCents);
  // Under a dispute the invoice is not PAID yet, whatever the balance: it becomes PAID (or not) when
  // the dispute closes.
  const becamePaid = amountDueCents === 0 && !disputedWithBalance;
  await tx.invoice.update({
    where: { id: invoice.id },
    data: disputedWithBalance
      ? { amount_due: fromCents(amountDueCents) }
      : { amount_due: fromCents(amountDueCents), status: becamePaid ? 'PAID' : 'PARTIAL', ...(becamePaid ? { paid_at: new Date() } : {}) },
  });
  // The stored net collected from the ledger rows, under the same lock (reports read the column).
  await rederiveRefundTotals(tx, { invoiceId: invoice.id, organizationId });
  if (becamePaid) {
    await tx.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: 'INVOICE',
        entity_id: invoice.id,
        event_type: 'INVOICE_PAID',
        description: `Invoice ${invoice.invoice_number} paid in full`,
        metadata: { payment_id: paymentId } satisfies Prisma.InputJsonValue,
      },
    });
  }
  let unapplied: UnappliedCapture | null = null;
  if (excessCents > 0) {
    unapplied = unappliedCapture('OVERPAYMENT', excessCents,
      `${label} of ${usd(chargedCents)} on invoice ${invoice.invoice_number} was more than the balance due: ${usd(excessCents)} was not applied to the invoice.`);
    await writeUnappliedCaptureEntry(tx, unapplied);
  }
  return { changed: true, becamePaid, invoice: { id: invoice.id, invoice_number: invoice.invoice_number }, unapplied };
}

/**
 * Post-commit, like every other door: the automation and the alert must never see money that
 * rolled back.
 */
export async function afterPaymentSettled(outcome: SettledPayment, organizationId: string): Promise<void> {
  if (outcome.bankOutcome) {
    const b = outcome.bankOutcome;
    void logAudit({
      action: b.to === 'SUCCEEDED' ? 'invoice.bank_payment_cleared' : 'invoice.bank_payment_failed',
      resourceType: 'Invoice',
      resourceId: b.invoiceId,
      orgId: organizationId,
      actorId: null,
      metadata: { payment_id: b.paymentId, invoice_number: b.invoiceNumber, amount: b.amount, method: 'ACH' },
    });
  }
  if (outcome.unapplied) await alertUnappliedCapture(outcome.unapplied);
  if (outcome.becamePaid && outcome.invoice) {
    dispatchAutomationEvent({
      type: 'INVOICE_PAID',
      organizationId,
      entity: { type: 'invoice', id: outcome.invoice.id, label: outcome.invoice.invoice_number },
      actorId: null,
    });
  }
}
