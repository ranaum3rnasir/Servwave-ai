/**
 * V7-09b (BE-10, BE-11, C-33, C-34) - the money doors for unapplied money: put it on an invoice.
 *
 * Two doors share one booking: attaching a captured payment to an open invoice, and creating a new standalone invoice
 * for it (invoice.controller). Both book the WHOLE amount still on the item through the reconciler's own booking
 * function (so the payment row, the invoice balance and status, the history and the job money history are exactly what
 * any card payment gets), then close the item. Rules that never bend:
 *  - nothing is booked above the invoice's balance (no overpaid invoice: INVOICE_BALANCE_BELOW_PAYMENT);
 *  - the invoice and the item are locked, in that order (the order the refund door and the reconciler take), and the item
 *    is re-read OPEN under its lock, so two attaches of one item book once;
 *  - an item with a refund on its way out (refund_started_at is fresh) is not attached;
 *  - how the money was paid (card or bank, brand, last four) is read from the processor ONCE, before any transaction, and
 *    a failed read refuses the attach: a guessed method is never booked;
 *  - the customer gets the normal receipt, after the commit, like any payment the reconciler books.
 *
 * Copy here reaches the UI (extractApiError): it names ServWave, never the processor, and carries no processor id.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { tenantWhere } from '../../lib/tenant';
import { scopeWhereForReq } from '../../lib/permissions/enforce';
import { logger } from '../../lib/logger';
import { logAudit } from '../../lib/audit';
import { getStripeForOrg, listPaymentIntentRefunds, retrieveCapturePayerDetail } from '../../lib/stripe';
import {
  PAYABLE_STATUSES, PROCESSING_PAYMENT_WHERE, COMMITTED_REFUND_WHERE, committedRefundCents, fromCents, payableNowCents, rederiveRefundTotals, toCents,
} from '../../lib/payment-ledger';
import { clearUnappliedCaptureAlerts, ledgerPaymentIdOf } from '../../lib/unapplied-capture';
import { closeOpenCheckoutLinks } from '../../lib/invoice-checkout-expiry';
import { recordPayment, type AppliedEffects, type BookedPayment } from '../payment-reconciler/apply';
import { CHECKOUT_INVOICE_SELECT, runCheckoutEffects } from '../payment-reconciler/checkout-effects';

/** A refund on its way to the processor holds the item this long; nothing has to clear it. */
export const REFUND_CLAIM_MS = 5 * 60 * 1000;

const usd = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export type AttachCode =
  | 'NOT_OPEN' | 'ON_PAYMENT_ROW' | 'REFUND_IN_PROGRESS' | 'INVOICE_NOT_FOUND' | 'INVOICE_NOT_PAYABLE' | 'INVOICE_IS_DEPOSIT'
  | 'INVOICE_BALANCE_BELOW_PAYMENT' | 'INVOICE_TOTAL_BELOW_PAYMENT' | 'PAYER_UNAVAILABLE' | 'NO_AMOUNT' | 'NO_PAYMENT_FOR_REFUND' | 'WRONG_KIND';

/** A refusal the door answers as `status { code, error }`. Nothing was written. */
export class AttachRefusal extends Error {
  constructor(readonly status: number, readonly code: AttachCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AttachRefusal';
  }
}

const MESSAGES = {
  NOT_OPEN: 'This payment was already attached, refunded or resolved.',
  ON_PAYMENT_ROW: 'This money is already on a payment record, so it cannot be attached to an invoice again. Mark it resolved or send it back instead.',
  REFUND_IN_PROGRESS: 'A refund of this payment is in progress. Try again in a few minutes.',
  INVOICE_NOT_FOUND: 'Invoice not found.',
  INVOICE_NOT_PAYABLE: 'That invoice is not open for payment. Choose another invoice.',
  INVOICE_IS_DEPOSIT: 'A deposit invoice cannot take this payment. Choose another invoice.',
  PAYER_UNAVAILABLE: "ServWave Payments can’t confirm how this payment was made right now, so it can’t be attached. Try again in a moment, or contact ServWave support.",
  NO_AMOUNT: 'There is no amount left on this item to attach.',
  REFUNDS_UNCHECKED: "ServWave Payments can’t check this payment for refunds right now, so it can’t be attached. Try again in a moment, or contact ServWave support.",
  WRONG_KIND: 'This item cannot be attached here.',
} as const;

/** How the money was paid, as the booked payment stores it. */
export interface CapturePayer {
  method: 'CARD' | 'ACH';
  cardBrand: string | null;
  cardLast4: string | null;
  bankName: string | null;
  bankLast4: string | null;
}

/** The capture, as the doors read it before they start. */
export interface CaptureForBooking {
  id: string;
  organization_id: string;
  reason: string;
  status: string;
  source_key: string;
  amount: { toString(): string } | null;
  refunded_amount: { toString(): string };
  stripe_payment_intent_id: string | null;
  stripe_account_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_refund_id: string | null;
  invoice_id: string | null;
  created_at: Date;
  invoice: { id: string; invoice_number: string } | null;
}

const CAPTURE_SELECT = {
  id: true, organization_id: true, reason: true, status: true, source_key: true, amount: true, refunded_amount: true, stripe_refund_id: true,
  stripe_payment_intent_id: true, stripe_account_id: true, stripe_checkout_session_id: true, invoice_id: true, created_at: true,
  invoice: { select: { id: true, invoice_number: true } },
} satisfies Prisma.UnappliedCaptureSelect;

/** What is still on the item, in cents: the amount less what already went back. */
export function leftCentsOf(c: { amount: { toString(): string } | null; refunded_amount: { toString(): string } }): number {
  return c.amount == null ? 0 : Math.max(toCents(c.amount.toString()) - toCents(c.refunded_amount.toString()), 0);
}

/** Refuse a capture that cannot be attached at all (before reading anything from the processor). */
export function assertAttachable(c: CaptureForBooking, kind: 'PAYMENT' | 'REFUND'): void {
  if (c.status !== 'OPEN') throw new AttachRefusal(409, 'NOT_OPEN', MESSAGES.NOT_OPEN);
  if ((c.reason === 'REFUND_UNMATCHED') !== (kind === 'REFUND')) throw new AttachRefusal(409, 'WRONG_KIND', MESSAGES.WRONG_KIND);
  // C-34: money that already sits on a payment row (a bank payment that cleared onto an invoice that could not take it)
  // has its payment row; attaching it would book it twice.
  if (ledgerPaymentIdOf(c.source_key)) throw new AttachRefusal(409, 'ON_PAYMENT_ROW', MESSAGES.ON_PAYMENT_ROW);
  if (leftCentsOf(c) <= 0) throw new AttachRefusal(409, 'NO_AMOUNT', MESSAGES.NO_AMOUNT);
}

/**
 * Whether this caller may act on the item: the refund permission is not the right to see every invoice, so a caller whose
 * Invoice reach is narrowed acts only on items on an invoice that reach opens (the rule the list and the refund door use).
 */
export async function canActOnCapture(req: Request, id: string): Promise<boolean> {
  const scope = await scopeWhereForReq(req, 'Invoice');
  if (Object.keys(scope).length === 0) return true;
  return !!(await prisma.unappliedCapture.findFirst({
    where: { id, ...tenantWhere(req), invoice: { is: scope as Prisma.InvoiceWhereInput } },
    select: { id: true },
  }));
}

/** The capture for this caller's company, or null. The caller checks the record scope. */
export async function loadCapture(req: Request, id: string): Promise<CaptureForBooking | null> {
  return prisma.unappliedCapture.findFirst({ where: { id, ...tenantWhere(req) }, select: CAPTURE_SELECT });
}

/**
 * Read how the money was paid, from the processor, once. Outside any transaction (the pool allows one connection).
 * A capture the processor cannot describe is not attached: a guessed method is never booked (C-33).
 */
export async function readCapturePayer(c: CaptureForBooking): Promise<CapturePayer> {
  if (!c.stripe_account_id || !c.stripe_payment_intent_id) throw new AttachRefusal(502, 'PAYER_UNAVAILABLE', MESSAGES.PAYER_UNAVAILABLE);
  const read = await retrieveCapturePayerDetail(c.stripe_account_id, c.stripe_payment_intent_id);
  if (!read) throw new AttachRefusal(502, 'PAYER_UNAVAILABLE', MESSAGES.PAYER_UNAVAILABLE);
  return read.method === 'card'
    ? { method: 'CARD', cardBrand: read.brand, cardLast4: read.last4, bankName: null, bankLast4: null }
    : { method: 'ACH', cardBrand: null, cardLast4: null, bankName: read.bank_name, bankLast4: read.last4 };
}

/**
 * Refuse while any refund of this money exists at the processor that the item has not counted: one whose answer was lost
 * and whose event has not landed (past the short claim window), or one made some other way. Booking the money on an
 * invoice while it is going back would put it in two places. Read once, outside any transaction; a read that fails
 * refuses (nothing is booked on a guess).
 */
export async function assertNoUncountedRefund(c: CaptureForBooking & { counted_refund_ids?: string[] }): Promise<void> {
  if (!c.stripe_account_id || !c.stripe_payment_intent_id) throw new AttachRefusal(502, 'PAYER_UNAVAILABLE', MESSAGES.REFUNDS_UNCHECKED);
  const counted = c.counted_refund_ids ?? (await prisma.unappliedCapture.findFirst({
    where: { id: c.id, organization_id: c.organization_id }, select: { counted_refund_ids: true },
  }))?.counted_refund_ids ?? [];
  let refunds: Awaited<ReturnType<typeof listPaymentIntentRefunds>>;
  try {
    refunds = await listPaymentIntentRefunds(c.stripe_payment_intent_id, getStripeForOrg({ stripe_account_id: c.stripe_account_id }));
  } catch (error) {
    logger.warn(`Refund list for unapplied capture ${c.id} (org ${c.organization_id}) failed before an attach`);
    throw new AttachRefusal(502, 'PAYER_UNAVAILABLE', MESSAGES.REFUNDS_UNCHECKED);
  }
  if (refunds.some((r) => r.status !== 'failed' && r.status !== 'canceled' && !counted.includes(r.id))) {
    throw new AttachRefusal(409, 'REFUND_IN_PROGRESS', MESSAGES.REFUND_IN_PROGRESS);
  }
}

/** The invoices this caller may attach to: this company's, inside their invoice reach. */
export async function openableInvoiceWhere(req: Request, invoiceId: string): Promise<Prisma.InvoiceWhereInput> {
  const scope = (await scopeWhereForReq(req, 'Invoice')) as Prisma.InvoiceWhereInput;
  return { AND: [tenantWhere(req), scope, { id: invoiceId }] };
}

export interface BookInput {
  organizationId: string;
  capture: CaptureForBooking;
  invoiceId: string;
  payer: CapturePayer;
  actor: { id: string; name: string };
  /** The item's resolution note once booked, given the invoice's number. */
  note: (invoiceNumber: string) => string;
  /** The invoice history line saying who put the money there. */
  history: (invoiceNumber: string, who: string) => string;
  /**
   * Whether the person may see prices: a refusal names the invoice's balance and the payment's amount only then
   * (re-audit P2-2, `canSeePrices`).
   */
  figures: boolean;
}

export interface Booked {
  booked: BookedPayment;
  invoiceNumber: string;
  amountCents: number;
  /** The invoice after the payment: its balance and status. */
  newStatus: 'PAID' | 'PARTIAL';
}

/**
 * Book the item's whole remaining amount on the invoice, inside the caller's transaction, and close the item.
 * Locks the invoice, then the item. Throws AttachRefusal (nothing written by this function) when the item is no longer
 * open, a refund is on its way, or the invoice cannot take the whole amount.
 */
export async function bookCaptureOnInvoice(tx: Prisma.TransactionClient, input: BookInput): Promise<Booked> {
  const { organizationId, invoiceId, capture, payer } = input;
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${capture.id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const locked = await tx.unappliedCapture.findFirst({
    where: { id: capture.id, organization_id: organizationId },
    select: { ...CAPTURE_SELECT, refund_started_at: true },
  });
  if (!locked) throw new AttachRefusal(404, 'NOT_OPEN', 'Payment not found');
  assertAttachable(locked, 'PAYMENT');
  if (locked.refund_started_at && Date.now() - locked.refund_started_at.getTime() < REFUND_CLAIM_MS) {
    throw new AttachRefusal(409, 'REFUND_IN_PROGRESS', MESSAGES.REFUND_IN_PROGRESS);
  }
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organization_id: organizationId },
    select: { invoice_number: true, status: true, kind: true, amount_due: true, payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } } },
  });
  if (!invoice) throw new AttachRefusal(404, 'INVOICE_NOT_FOUND', MESSAGES.INVOICE_NOT_FOUND);
  if (invoice.kind === 'DEPOSIT') throw new AttachRefusal(409, 'INVOICE_IS_DEPOSIT', MESSAGES.INVOICE_IS_DEPOSIT);
  if (!PAYABLE_STATUSES.includes(invoice.status)) throw new AttachRefusal(409, 'INVOICE_NOT_PAYABLE', MESSAGES.INVOICE_NOT_PAYABLE);

  const amountCents = leftCentsOf(locked);
  // No overpaid invoices: what is payable now is the balance less a bank debit still clearing.
  const dueCents = toCents(invoice.amount_due);
  const payableCents = payableNowCents(invoice);
  if (amountCents > payableCents) {
    throw new AttachRefusal(
      409, 'INVOICE_BALANCE_BELOW_PAYMENT',
      input.figures
        ? `Only ${usd(payableCents)} is due on ${invoice.invoice_number}, less than this ${usd(amountCents)} payment.`
        : `This payment is more than is due on ${invoice.invoice_number}.`,
      input.figures ? { balance: payableCents / 100, amount: amountCents / 100 } : {},
    );
  }
  const paysInFull = amountCents === dueCents;
  const booked = await recordPayment(tx, {
    type: 'record_payment',
    organizationId,
    invoiceId,
    kind: invoice.kind,
    method: payer.method,
    state: 'SUCCEEDED',
    amountCents,
    tipCents: 0,
    // When the money arrived, not when a person attached it.
    paidAt: locked.created_at,
    paysInFull,
    estimateClosed: false,
    processorPaymentIntentId: locked.stripe_payment_intent_id,
    processorChargeId: null,
    checkoutSessionId: locked.stripe_checkout_session_id,
    connectedAccountId: locked.stripe_account_id,
    wallet: null,
    cardBrand: payer.cardBrand,
    cardLast4: payer.cardLast4,
    bankName: payer.bankName,
    bankLast4: payer.bankLast4,
  }, { organizationId, eventId: `attach:${capture.id}`, accountId: locked.stripe_account_id });

  const now = new Date();
  await tx.unappliedCapture.updateMany({
    where: { id: capture.id, organization_id: organizationId, status: { in: ['OPEN', 'RESOLVED'] } },
    data: {
      status: 'RESOLVED', resolved_at: now, resolved_by: input.actor.id, resolved_by_name: input.actor.name,
      resolution_note: input.note(invoice.invoice_number),
    },
  });
  await tx.timelineEvent.create({
    data: {
      organization_id: organizationId,
      entity_type: 'INVOICE',
      entity_id: invoiceId,
      event_type: 'PAYMENT_ATTACHED',
      description: input.history(invoice.invoice_number, input.actor.name),
      metadata: { unapplied_capture_id: capture.id, payment_id: booked.paymentId, amount: amountCents / 100 },
      created_by: input.actor.id,
    },
  });
  return { booked, invoiceNumber: invoice.invoice_number, amountCents, newStatus: paysInFull ? 'PAID' : 'PARTIAL' };
}

/**
 * After the commit: the customer's receipt, the owner's notices, automation and fee capture a booked payment gets, the
 * item's alert read, and the open checkout links for the invoice closed (its balance moved). Never throws: an email
 * problem must not fail money that is already booked.
 */
export async function afterCaptureBooked(input: {
  organizationId: string; capture: CaptureForBooking; booked: Booked; actor: { id: string }; via: 'attach' | 'new_invoice';
}): Promise<void> {
  const { organizationId, capture, booked } = input;
  try {
    await clearUnappliedCaptureAlerts(prisma, organizationId, capture.source_key);
    const [invoice, organization] = await Promise.all([
      prisma.invoice.findFirst({ where: { id: booked.booked.invoiceId, organization_id: organizationId }, select: CHECKOUT_INVOICE_SELECT }),
      prisma.organization.findFirst({ where: { id: organizationId }, select: { id: true, name: true, stripe_payouts_enabled: true } }),
    ]);
    if (!invoice || !organization) return;
    const effects: AppliedEffects = {
      settledRefunds: [], externalRefunds: [], bookedPayments: [booked.booked], unappliedCaptures: [], disputeNotices: [],
      expireCheckouts: [booked.booked.invoiceId],
      // A bank payment is told to the customer through its "cleared" notice; a card payment through its receipt.
      bankNotices: booked.booked.method === 'ACH'
        ? [{ type: 'notify_bank_payment', kind: 'cleared', invoiceId: booked.booked.invoiceId, amountCents: booked.amountCents, deposit: false, payAgain: false, eventId: `attach:${capture.id}` }]
        : [],
      settledPayments: [], reopenedInvoices: [], accountStatusWritten: false, accountNotices: [], failedRefunds: [], failedPayments: [], bankReturnNotices: [],
    };
    await runCheckoutEffects(effects, {
      organization: { id: organization.id, name: organization.name, stripe_payouts_enabled: organization.stripe_payouts_enabled },
      account: capture.stripe_account_id ?? undefined,
      paymentIntentId: capture.stripe_payment_intent_id,
      invoice,
    });
  } catch (error) {
    logger.error(`Post-commit effects of attaching unapplied capture ${capture.id} (org ${organizationId}) failed`, error);
  }
  void logAudit({
    action: 'billing.unapplied_capture_attached',
    resourceType: 'Invoice',
    resourceId: booked.booked.invoiceId,
    orgId: organizationId,
    actorId: input.actor.id,
    metadata: { unapplied_capture_id: capture.id, invoice_number: booked.invoiceNumber, amount: booked.amountCents / 100, payment_id: booked.booked.paymentId, via: input.via },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// A refund that went out for a payment ServWave never recorded is tied back to the invoice it belongs to.
// ---------------------------------------------------------------------------------------------------------------------

export interface BookedRefund {
  invoiceNumber: string;
  invoiceId: string;
  amountCents: number;
  paymentId: string;
}

/**
 * Record a stray refund (REFUND_UNMATCHED) against the invoice's succeeded payment that still has at least that much
 * to give back (never a voided invoice), and close the item. Under the invoice and item locks. The refund already
 * went out at the processor; this only makes the invoice's own numbers say so.
 */
export async function bookRefundOnInvoice(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; captureId: string; invoiceId: string; actor: { id: string; name: string }; figures: boolean },
): Promise<BookedRefund> {
  const { organizationId, invoiceId, captureId } = input;
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${captureId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const locked = await tx.unappliedCapture.findFirst({ where: { id: captureId, organization_id: organizationId }, select: CAPTURE_SELECT });
  if (!locked) throw new AttachRefusal(404, 'NOT_OPEN', 'Payment not found');
  assertAttachable(locked, 'REFUND');
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organization_id: organizationId }, select: { invoice_number: true, status: true } });
  if (!invoice) throw new AttachRefusal(404, 'INVOICE_NOT_FOUND', MESSAGES.INVOICE_NOT_FOUND);
  if (invoice.status === 'VOIDED') throw new AttachRefusal(409, 'INVOICE_NOT_PAYABLE', 'A voided invoice cannot take this refund. Choose another invoice.');
  const amountCents = leftCentsOf(locked);
  const processorRefundId = locked.stripe_refund_id;
  // A refund row already carries this id (it was recorded some other way): a second one would count it twice.
  if (processorRefundId && await tx.refund.findFirst({ where: { stripe_refund_id: processorRefundId }, select: { id: true } })) {
    throw new AttachRefusal(409, 'WRONG_KIND', 'This refund is already recorded on an invoice. Mark it resolved instead.');
  }
  const payments = await tx.payment.findMany({
    where: { invoice_id: invoiceId, state: 'SUCCEEDED', voided_at: null },
    orderBy: { paid_at: 'desc' },
    select: { id: true, amount: true, method: true, refunds: { where: COMMITTED_REFUND_WHERE, select: { amount: true, state: true } } },
  });
  const payment = payments.find((p) => toCents(p.amount) - committedRefundCents(p.refunds) >= amountCents);
  if (!payment) {
    // The refund's amount is a figure: a person without See prices is told there is not enough, not how much (P2-2).
    const left = input.figures ? usd(amountCents) : 'enough';
    throw new AttachRefusal(409, 'NO_PAYMENT_FOR_REFUND', `${invoice.invoice_number} has no payment with ${left} left to refund. Choose another invoice.`);
  }
  await tx.refund.create({
    data: {
      invoice_id: invoiceId,
      payment_id: payment.id,
      amount: fromCents(amountCents),
      tax_portion: 0,
      non_taxable_concession: false,
      method: payment.method,
      reason: 'Refund recorded from payments needing attention',
      reason_category: 'OTHER',
      // The refund already exists at the processor; the same id is what its own events find.
      stripe_refund_id: processorRefundId,
      state: 'SUCCEEDED',
      refunded_by: input.actor.id,
      organization_id: organizationId,
    },
  });
  await rederiveRefundTotals(tx, { invoiceId, organizationId });
  await tx.unappliedCapture.updateMany({
    where: { id: captureId, organization_id: organizationId, status: 'OPEN' },
    data: {
      status: 'RESOLVED', resolved_at: new Date(), resolved_by: input.actor.id, resolved_by_name: input.actor.name,
      resolution_note: `Attached to ${invoice.invoice_number}`,
    },
  });
  await tx.timelineEvent.create({
    data: {
      organization_id: organizationId,
      entity_type: 'INVOICE',
      entity_id: invoiceId,
      event_type: 'INVOICE_REFUNDED',
      description: `Refund recorded on this invoice by ${input.actor.name}`,
      metadata: { unapplied_capture_id: captureId, payment_id: payment.id, amount: amountCents / 100 },
      created_by: input.actor.id,
    },
  });
  return { invoiceNumber: invoice.invoice_number, invoiceId, amountCents, paymentId: payment.id };
}
