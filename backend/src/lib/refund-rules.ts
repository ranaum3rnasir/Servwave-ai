/**
 * Payments go-live slice 29 (D17): the rules a refund through ServWave Payments follows, for card
 * and bank (ACH) payments alike. Every door that sends money back (the invoice refund, the credit
 * give-back, the Needs attention card) asks these before it calls the processor.
 *
 * The messages reach the refund dialogs, so they name no processor.
 */
import type { PaymentMethod } from '@prisma/client';
import type { RefundTiming } from './email';

/** The processor refunds a bank payment only within 180 days of it. */
export const BANK_REFUND_WINDOW_DAYS = 180;

export const BANK_REFUND_WINDOW_MESSAGE =
  'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a bank payment is past the processor's refund window. Card payments have no such window
 * here (the card networks' own limits surface as a refused refund).
 */
export function isPastBankRefundWindow(payment: { method: PaymentMethod | string; paid_at: Date }, now: Date = new Date()): boolean {
  if (payment.method !== 'ACH') return false;
  return now.getTime() - payment.paid_at.getTime() > BANK_REFUND_WINDOW_DAYS * DAY_MS;
}

/**
 * How a refund of this payment is given back (conductor ruling 2026-10-08):
 * - 'processor': sent back through the processor (a payment taken through it);
 * - 'record': recorded only, the money handed back another way (a payment taken by hand, or a
 *   bank payment past the 180-day window refunded with a hand method chosen);
 * - 'refused': a bank payment past the window with no hand method chosen (it would go to the
 *   processor, which no longer takes it).
 * `chosenMethod` is the method the person picked; the schemas already refuse ACH, so any chosen
 * method is a hand one.
 */
export function refundRoute(
  payment: { method: PaymentMethod | string; paid_at: Date; stripe_payment_intent_id: string | null },
  chosenMethod: PaymentMethod | string | null | undefined,
  now: Date = new Date(),
): 'processor' | 'record' | 'refused' {
  if (!payment.stripe_payment_intent_id) return 'record';
  if (!isPastBankRefundWindow(payment, now)) return 'processor';
  return chosenMethod ? 'record' : 'refused';
}

/**
 * Slice 28b: the method a refund row records. A refund sent back through the processor records the
 * payment's own method (a hand method chosen in the dialog would skew the method reports and the
 * job money history); a record-only refund records the hand method the person chose, else the
 * payment's own.
 */
export function refundRowMethod(
  payment: { method: PaymentMethod | string; paid_at: Date; stripe_payment_intent_id: string | null },
  chosenMethod: PaymentMethod | string | null | undefined,
  now: Date = new Date(),
): PaymentMethod {
  const route = refundRoute(payment, chosenMethod, now);
  return (route === 'processor' ? payment.method : chosenMethod ?? payment.method) as PaymentMethod;
}

/**
 * Payments go-live slice 07: what the user sees when the processor refuses an in-app refund.
 * Reaches the refund dialog, so it names no processor.
 */
export const REFUND_NOT_SENT_MESSAGE =
  "This refund couldn't be sent through ServWave Payments. Refund the customer another way, then record it here.";

export const REFUND_BALANCE_TOO_LOW_MESSAGE =
  'Your ServWave Payments balance is too low to send this refund. It will be possible once new payments arrive, or refund the customer another way.';

/** The refund call got no answer: it may have gone out, so its money stays held. */
export const REFUND_UNCONFIRMED_MESSAGE =
  "We couldn't confirm whether this refund was sent. Check the invoice again in a few minutes before trying again.";

/** The processor's codes for a refund the account's balance cannot cover. */
const BALANCE_TOO_LOW_CODES = new Set(['balance_insufficient', 'insufficient_funds']);

/**
 * The answer for a refund the processor refused: the status and the message the dialog shows. A
 * low balance is the business's to fix (it clears as new payments arrive), so it is a 400 with its
 * own words; anything else is the general "couldn't be sent" (500, as before).
 */
export function refusedRefundAnswer(err: unknown): { status: number; error: string } {
  const e = err as { code?: unknown; raw?: { code?: unknown; decline_code?: unknown } } | null;
  const codes = [e?.code, e?.raw?.code, e?.raw?.decline_code];
  if (codes.some((c) => typeof c === 'string' && BALANCE_TOO_LOW_CODES.has(c))) {
    return { status: 400, error: REFUND_BALANCE_TOO_LOW_MESSAGE };
  }
  return { status: 500, error: REFUND_NOT_SENT_MESSAGE };
}

export const BANK_PAYMENT_PROCESSING_MESSAGE =
  'This bank payment is still processing. Cancel the payment instead of refunding it.';

export const BANK_PAYMENT_NOT_CANCELLABLE_MESSAGE =
  'This bank payment can no longer be cancelled. It can be refunded once it clears.';

export const ONLY_PROCESSING_BANK_PAYMENT_CANCELS_MESSAGE =
  'Only a bank payment that is still processing can be cancelled.';

export const REFUND_SPANS_PAYMENTS_MESSAGE =
  'This refund is more than any one payment on the invoice. Refund each payment separately.';

type Cents = number;
interface RefundablePayment {
  id: string;
  /** Face amount, in cents. */
  amountCents: Cents;
  /** Whether the payment went through the processor (a refund of it goes back through it). */
  online: boolean;
}

export type RefundAllocation<P extends RefundablePayment> =
  | { ok: true; parts: Array<{ payment: P; cents: Cents }> }
  | { ok: false; error: string };

/**
 * Where a refund comes from (slice 29). Every refund row names its payment, so each payment's own
 * cap holds and its refund stamp is right:
 * - a named payment, when it can return the amount;
 * - else ("Auto / oldest") the oldest payment that can return the whole amount;
 * - else, only when every payment involved was paid by hand, the amount spread over the payments
 *   oldest first, one part each. A refund through the processor goes back to one charge.
 *
 * `payments` are oldest first; `roomCents` is what a payment can still give back (its amount less
 * the refunds on it, landed or on their way).
 */
export function allocateRefund<P extends RefundablePayment>(input: {
  payments: P[];
  roomCents: (payment: P) => Cents;
  amountCents: Cents;
  namedPaymentId?: string | null;
}): RefundAllocation<P> {
  const { payments, roomCents, amountCents, namedPaymentId } = input;
  if (namedPaymentId) {
    const named = payments.find((p) => p.id === namedPaymentId);
    if (!named) return { ok: false, error: 'Payment not found on this invoice' };
    if (amountCents > roomCents(named)) return { ok: false, error: 'Refund exceeds payment balance' };
    return { ok: true, parts: [{ payment: named, cents: amountCents }] };
  }
  const covering = payments.find((p) => roomCents(p) >= amountCents);
  if (covering) return { ok: true, parts: [{ payment: covering, cents: amountCents }] };
  const parts: Array<{ payment: P; cents: Cents }> = [];
  let leftCents = amountCents;
  for (const p of payments) {
    const take = Math.min(roomCents(p), leftCents);
    if (take <= 0) continue;
    parts.push({ payment: p, cents: take });
    leftCents -= take;
    if (leftCents === 0) break;
  }
  if (leftCents > 0) return { ok: false, error: 'Refund exceeds net paid' };
  if (parts.some((part) => part.payment.online)) return { ok: false, error: REFUND_SPANS_PAYMENTS_MESSAGE };
  return { ok: true, parts };
}

/**
 * Payments go-live D1: whether a refund should ask the processor to give back the application fee.
 * Only a payment that CARRIED a fee can have one reversed (today: legacy sandbox charges, taken
 * before D9 removed the fee). The processor refuses the request on a charge with no fee, so a
 * payment without one is refunded plainly. The fact is read from what the payment recorded
 * (Payment.platform_fee_amount, written from the charge's application_fee_amount), so the refund
 * path makes no extra processor call. Every refund door spreads this into createRefund's options.
 */
export function feeReversalOption(
  payment: { stripe_account_id?: string | null; platform_fee_amount?: unknown } | null | undefined,
): { reverseApplicationFee?: true } {
  if (!payment?.stripe_account_id) return {};
  return Number(payment.platform_fee_amount ?? 0) > 0 ? { reverseApplicationFee: true } : {};
}

/**
 * What the customer's refund email promises about timing, by how the money went back: a refund the
 * processor sent to a card has the card line, to a bank account the bank line, and one recorded by
 * hand (cash, check, or no processor involved) none (slice 31).
 */
export function refundTimingFor(refund: { method: string | null | undefined; processed: boolean }): RefundTiming {
  if (!refund.processed) return 'none';
  if (refund.method === 'CARD') return 'card';
  if (refund.method === 'ACH') return 'bank';
  return 'none';
}
