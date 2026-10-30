/**
 * The invoice status its money implies, as pure functions (no database), so the payment event
 * reconciler's decide step and the ledger's re-derive share one rule.
 *
 * Moved out of payment-ledger.ts (payments go-live slice 09): a won dispute returns the invoice to
 * the status its SUCCEEDED payments and refunds imply, decided before anything is written.
 */

/** Status once money has been given back: REFUNDED when it all went back, else PARTIALLY_REFUNDED. */
export function refundStatusFor(paidCentsTotal: number, refundedCentsTotal: number): 'REFUNDED' | 'PARTIALLY_REFUNDED' {
  return refundedCentsTotal >= paidCentsTotal ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

/**
 * Status with no money given back, from the balance: PAID only when nothing is owed, PARTIAL when
 * some money landed and some is still due, SENT when nothing has landed yet.
 */
export function balanceStatusFor(amountDueCents: number, anyMoneyLanded: boolean): 'PAID' | 'PARTIAL' | 'SENT' {
  if (amountDueCents <= 0) return 'PAID';
  return anyMoneyLanded ? 'PARTIAL' : 'SENT';
}

/** The status an invoice's money implies: the refund half when anything was given back, else the balance half. */
export function impliedMoneyStatus(input: {
  amountDueCents: number;
  /** SUCCEEDED, not voided payments, applied deposit credit aside. */
  paidCents: number;
  /** SUCCEEDED refunds. */
  refundedCents: number;
  /** Any SUCCEEDED payment on the invoice, applied deposit credit included. */
  anyMoneyLanded: boolean;
}): 'PAID' | 'PARTIAL' | 'SENT' | 'REFUNDED' | 'PARTIALLY_REFUNDED' {
  return input.refundedCents > 0
    ? refundStatusFor(input.paidCents, input.refundedCents)
    : balanceStatusFor(input.amountDueCents, input.anyMoneyLanded);
}

/**
 * Slice 32b: the status a live, unpaid invoice (SENT or PARTIAL, or a DRAFT as it is issued) takes
 * when its deposit credit alone covers it. Credit is not cash: nobody owes anything, so the invoice
 * reads PAID (with a paid date), and `stillOwed` keeps it where it was. Only the credit counts. A
 * balance a credit NOTE wrote off is not "paid" and never settles an invoice, and an invoice with
 * no deposit credit (a $0 total, say) is left as it is. One rule for every place totals are
 * written: issuing, a line edit, a payment link.
 */
export function creditCoveredStatus<S extends string>(input: {
  status: S;
  /** total - deposit credit - cash paid, in cents; <= 0 means nothing is owed in cash. */
  cashBalanceCents: number;
  depositCreditCents: number;
}): S | 'PAID' {
  return input.depositCreditCents > 0 && input.cashBalanceCents <= 0 ? 'PAID' : input.status;
}
