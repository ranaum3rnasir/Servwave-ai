// Checkout pricing (payments go-live PRD Module 2; decisions D9, D4, D15).
//
// One pure function owns what a hosted checkout charges: given what is owed, what may be paid
// right now, the customer's requested amount, their tip and the payment method, it returns the
// checkout's line items and ServWave's platform fee. Callers never compute a fee themselves.
//
// At launch (D9) there is no card service fee, no bank surcharge (D4) and no platform fee: the
// homeowner pays the document amount plus any tip, and ServWave takes no cut. The shape is kept
// for later - a surcharge (D15) would be another line item and a platform fee (D8) a non-zero
// `platformFeeCents` - so either can return here without touching the invoice or deposit
// checkout callers.

export type CheckoutMethod = 'card' | 'bank';

export interface CheckoutPricingInput {
  /**
   * The document's total (the invoice or deposit amount), in cents, before any payment. The tip
   * cap: a tip may be up to this figure even when part of the invoice is already paid.
   */
  invoiceTotalCents: number;
  /** What is owed on the document, in cents. */
  amountDueCents: number;
  /**
   * What may be paid online right now, in cents: the amount due less PROCESSING payments
   * (`payableNowCents()` below). Omitted = the amount due.
   */
  payableNowCents?: number;
  /** The customer's partial amount, in cents. Omitted = pay the payable-now amount in full. */
  requestedCents?: number;
  /** The customer's tip, in cents. At most the invoice amount (`invoiceTotalCents`). */
  tipCents?: number;
  /** Shown as the name of the amount line on the hosted checkout. */
  description: string;
  method: CheckoutMethod;
}

export interface CheckoutLineItem {
  name: string;
  amountCents: number;
}

export interface PricedCheckout {
  ok: true;
  /** Every line the customer sees, in order. Never a fee line at launch. */
  lineItems: CheckoutLineItem[];
  /** The document amount being paid (full or partial), excluding the tip. */
  amountCents: number;
  tipCents: number;
  /** What the hosted checkout charges: the sum of the line items. */
  totalCents: number;
  /** The payable-now figure this checkout was built against (rides in the session metadata). */
  payableNowCents: number;
  /** ServWave's cut of this payment. 0 for every method at launch (D9). */
  platformFeeCents: number;
}

export type CheckoutPricingError =
  | 'NOTHING_PAYABLE_NOW'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_PAYABLE_NOW'
  | 'TIP_NEGATIVE'
  | 'TIP_ABOVE_CAP';

export type CheckoutPricing = PricedCheckout | { ok: false; error: CheckoutPricingError };

/** The smallest partial payment a customer may make: $1.00. */
export const MIN_PARTIAL_PAYMENT_CENTS = 100;

/**
 * What may be paid online right now (PRD Module 2): the amount due less the payments still
 * PROCESSING on the document (a bank debit in flight does not reduce the balance until it clears,
 * but it must not be paid a second time meanwhile). Never below zero.
 */
export function payableNowCents(amountDueCents: number, processingCents: number): number {
  return Math.max(0, amountDueCents - processingCents);
}

/**
 * Slice 28b: whether a payment recorded by hand would take money a bank debit already in flight is
 * collecting. True when something is processing and the amount is above payable-now. The invoice's
 * Record Payment door and the estimate's deposit door share this one rule.
 */
export function exceedsPayableNow(amountDueCents: number, processingCents: number, amountCents: number): boolean {
  return processingCents > 0 && amountCents > payableNowCents(amountDueCents, processingCents);
}

/** What staff read when a hand payment is refused for that reason. `what` is "invoice" or "deposit". */
export function processingBlocksHandPaymentMessage(processingCents: number, what: 'invoice' | 'deposit'): string {
  return `A bank payment of $${(processingCents / 100).toFixed(2)} is still processing on this ${what}. You can record only the part of the ${what} not covered by it.`;
}

export function priceCheckout(input: CheckoutPricingInput): CheckoutPricing {
  const payableNowCents = input.payableNowCents ?? input.amountDueCents;
  if (payableNowCents <= 0) return { ok: false, error: 'NOTHING_PAYABLE_NOW' };
  const amountCents = input.requestedCents ?? payableNowCents;
  if (input.requestedCents !== undefined) {
    if (amountCents < MIN_PARTIAL_PAYMENT_CENTS) return { ok: false, error: 'AMOUNT_BELOW_MINIMUM' };
    if (amountCents > payableNowCents) return { ok: false, error: 'AMOUNT_ABOVE_PAYABLE_NOW' };
  }
  const tipCents = input.tipCents ?? 0;
  if (tipCents < 0) return { ok: false, error: 'TIP_NEGATIVE' };
  if (tipCents > input.invoiceTotalCents) return { ok: false, error: 'TIP_ABOVE_CAP' };

  const lineItems: CheckoutLineItem[] = [{ name: input.description, amountCents }];
  if (tipCents > 0) lineItems.push({ name: 'Tip', amountCents: tipCents });

  return {
    ok: true,
    lineItems,
    amountCents,
    tipCents,
    totalCents: amountCents + tipCents,
    payableNowCents,
    platformFeeCents: 0,
  };
}
