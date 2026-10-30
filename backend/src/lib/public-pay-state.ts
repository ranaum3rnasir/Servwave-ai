/**
 * Payments go-live slice 25 (PRD Module 7, stories 63 and 66) - the one state a public invoice
 * page renders from, so a homeowner always sees the true state of the invoice:
 *
 * - PAYABLE: money can be paid online now (the amount due less bank payments still processing);
 * - PROCESSING: nothing is left to pay because a bank payment is still clearing;
 * - PAID / VOIDED: closed, no checkout;
 * - CHANGED: the document changed under the link (a deposit whose estimate was edited or recalled);
 * - CLOSED: any other status that takes no money online (a draft deposit, a refunded or disputed invoice).
 *
 * W4: an ordinary DRAFT with a public link is payable (a payment link no longer issues the invoice).
 * A deposit invoice is created SENT and is never payable as a DRAFT.
 *
 * The checkout door refuses every state but PAYABLE, so the page and the door cannot disagree.
 */
/** The statuses a public checkout opens on: SENT and PARTIAL, plus a DRAFT that is not a deposit (W4). */
export function checkoutOpenStatus(status: string, deposit: boolean): boolean {
  return status === 'SENT' || status === 'PARTIAL' || (status === 'DRAFT' && !deposit);
}

export type PublicPayState = 'PAYABLE' | 'PROCESSING' | 'PAID' | 'VOIDED' | 'CHANGED' | 'CLOSED';

export function publicPayState(input: {
  status: string;
  amountDueCents: number;
  processingCents: number;
  /** The deposit hold (depositHoldReason) is set: the figure or the document is no longer current. */
  held: boolean;
  /** A deposit whose estimate was declined or cancelled: closed for good, whatever is left on it. */
  estimateClosed?: boolean;
  /** A deposit invoice: payable only once issued (SENT or PARTIAL), never as a DRAFT. */
  deposit?: boolean;
}): PublicPayState {
  const { status, amountDueCents, processingCents, held, estimateClosed, deposit } = input;
  if (status === 'VOIDED') return 'VOIDED';
  if (status === 'PAID') return 'PAID';
  if (!checkoutOpenStatus(status, deposit === true)) return 'CLOSED';
  if (estimateClosed) return 'VOIDED';
  if (held) return 'CHANGED';
  if (amountDueCents <= 0) return 'PAID';
  if (amountDueCents - processingCents <= 0) return 'PROCESSING';
  return 'PAYABLE';
}
