/**
 * Payments go-live slice 29 (D17): the refund rules a person sees before they press the button.
 * Mirrors the backend's lib/refund-rules.ts, which enforces them; copy names no processor.
 */
import { refundHoldsCap } from '@/lib/payment-ledger';

export const BANK_REFUND_WINDOW_DAYS = 180;

export const BANK_REFUND_WINDOW_MESSAGE =
  'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.';

export const BANK_DUAL_CREDIT_WARNING =
  'If the customer also disputes this payment with their bank within 60 days, they could be credited twice.';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RefundSourcePayment {
  id: string;
  amount: number | string;
  method: string;
  paid_at: string;
  /** Present on a payment taken through the processor. Absent on older payloads (see below). */
  paid_through_processor?: boolean;
}

/**
 * Whether a refund of this payment goes back through the processor (a payment taken through it).
 * A payload that carries no processor flag falls back to the method: card and bank payments
 * are only ever taken through the processor.
 */
export function paidThroughProcessor(payment: Pick<RefundSourcePayment, 'method' | 'paid_through_processor'>): boolean {
  if (payment.paid_through_processor !== undefined) return payment.paid_through_processor;
  return payment.method === 'CARD' || payment.method === 'ACH';
}

/** A bank (ACH) payment past the processor's 180-day refund window. */
export function isPastBankRefundWindow(payment: Pick<RefundSourcePayment, 'method' | 'paid_at'>, now: Date = new Date()): boolean {
  if (payment.method !== 'ACH') return false;
  return now.getTime() - new Date(payment.paid_at).getTime() > BANK_REFUND_WINDOW_DAYS * DAY_MS;
}

const cents = (amount: number | string | undefined | null): number => Math.round(Number(amount ?? 0) * 100);

/**
 * The payment a refund comes from, as the server picks it: the named one, else ("Auto / oldest")
 * the oldest payment that can return the whole amount (its amount less the refunds on it, landed
 * or on their way). Null when no one payment can (the server then spreads a hand refund, or asks
 * for one refund per payment).
 */
export function refundSourcePayment<P extends RefundSourcePayment>(input: {
  payments: P[];
  refunds: ReadonlyArray<{ amount: number | string; payment_id?: string | null; state?: string | null }>;
  amount: number;
  selectedPaymentId?: string;
}): P | null {
  const { payments, refunds, amount, selectedPaymentId } = input;
  if (selectedPaymentId) return payments.find((p) => p.id === selectedPaymentId) ?? null;
  const room = (p: P) => cents(p.amount)
    - refunds.filter((r) => r.payment_id === p.id && refundHoldsCap(r)).reduce((sum, r) => sum + cents(r.amount), 0);
  const oldestFirst = [...payments].sort((a, b) => new Date(a.paid_at).getTime() - new Date(b.paid_at).getTime());
  return oldestFirst.find((p) => room(p) >= cents(amount)) ?? null;
}

/**
 * Slice 28b: every payment a refund of `amount` would draw from. The source when one payment can
 * return it (the named one, or the oldest that covers it); otherwise ("Auto / oldest" with no single
 * payment that covers the amount) every payment with something left to give back.
 */
export function refundDrawnPayments<P extends RefundSourcePayment>(input: {
  payments: P[];
  refunds: ReadonlyArray<{ amount: number | string; payment_id?: string | null; state?: string | null }>;
  amount: number;
  selectedPaymentId?: string;
}): P[] {
  const source = refundSourcePayment(input);
  if (source) return [source];
  if (input.selectedPaymentId) return [];
  const room = (p: P) => cents(p.amount)
    - input.refunds.filter((r) => r.payment_id === p.id && refundHoldsCap(r)).reduce((sum, r) => sum + cents(r.amount), 0);
  return input.payments.filter((p) => room(p) > 0);
}

/**
 * What the bank rules and the method picker show for a refund or give-back, from the payments it
 * would draw from. The hand-method picker appears only when something is recorded by hand: a
 * hand-paid payment, or a bank payment past the window (or when nothing is known to draw from).
 */
export function refundDoorState(drawn: ReadonlyArray<RefundSourcePayment>, chosenMethod: string, now: Date = new Date()) {
  const showMethodPicker = drawn.length === 0
    || drawn.some((p) => !paidThroughProcessor(p) || isPastBankRefundWindow(p, now));
  const method = showMethodPicker ? chosenMethod : '';
  const pastWindow = drawn.some((p) => isPastBankRefundWindow(p, now));
  const recordedByHand = pastWindow && !!method;
  return {
    showMethodPicker,
    /** The method to send: a hand method only when the refund is recorded by hand. */
    method,
    recordedByHand,
    bankRefund: drawn.some((p) => p.method === 'ACH') && !recordedByHand,
    pastBankWindow: pastWindow && !recordedByHand,
  };
}

export type GiveBackDestination = 'card' | 'bank' | 'processor' | 'hand';

/**
 * Where a give-back's money goes, for the words a person reads (slice 32b): back to the card, to the
 * bank account, to the original payments when both went through the processor, or a refund recorded
 * by hand (a hand-paid payment, a bank payment past the window, or nothing known to draw from).
 */
export function giveBackDestination(drawn: ReadonlyArray<RefundSourcePayment>, showMethodPicker: boolean): GiveBackDestination {
  if (showMethodPicker || drawn.length === 0) return 'hand';
  if (drawn.every((p) => p.method === 'CARD')) return 'card';
  if (drawn.every((p) => p.method === 'ACH')) return 'bank';
  return 'processor';
}

/** The destination as it reads after "refunded"; a hand refund is recorded, not sent. */
export const GIVE_BACK_PHRASE: Record<GiveBackDestination, string> = {
  card: 'to the card',
  bank: 'to the bank account',
  processor: 'to the original payments',
  hand: 'recorded by hand',
};
