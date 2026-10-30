/**
 * Why money the processor took could not be applied to an invoice, in plain words. Moved server-side from the
 * Settings card (payments go-live P4) so the Needs attention list words it once for every screen. It uses the STORED
 * reason and the invoice's CURRENT status: "paid after the invoice was closed" is told from the invoice's real state.
 */
const REASON_TEXT: Record<string, string> = {
  // INVOICE_NOT_PAYABLE is worded from the invoice's state: see unappliedReasonText().
  OVERPAYMENT: 'Paid more than the balance due. This is the part that was not applied.',
  AMOUNT_MISMATCH: 'The amount paid did not match the amount owed.',
  DEPOSIT_SUPERSEDED: 'The estimate changed after this deposit was sent, so the amount paid is no longer the amount owed.',
  DEPOSIT_ON_HOLD: 'Paid while the deposit was on hold (the estimate was back in draft).',
  INVOICE_NOT_FOUND: 'Not tied to an invoice in this account.',
  WRONG_ORG: 'Not tied to an invoice in this account.',
  DOCUMENT_MISMATCH: 'Paid for a different document than the invoice it named.',
  REFUND_UNMATCHED: 'A refund went out of your ServWave Payments account for a payment ServWave has no record of.',
};

const FALLBACK_REASON = 'Could not be applied to an invoice.';

export function unappliedReasonText(reason: string, invoiceStatus: string | null | undefined): string {
  if (reason === 'INVOICE_NOT_PAYABLE') {
    switch (invoiceStatus) {
      case 'PAID':
        return 'Paid after the invoice was already paid in full.';
      case 'VOIDED':
        return 'Paid after the invoice was voided.';
      default:
        return 'Paid while the invoice was not open for payment.';
    }
  }
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason] : FALLBACK_REASON;
}
