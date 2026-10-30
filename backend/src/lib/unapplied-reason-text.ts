/**
 * Why money the processor took could not be applied to an invoice, in plain words (spec 7.15). The server words it once
 * for every screen: `short` is the card, table and alert text, `long` the sentence after it. It uses the STORED reason and
 * the invoice's CURRENT state: "paid after the invoice was closed" is told from the invoice's real status, and "paid
 * twice" from an earlier payment of the same amount. Never a processor id or error text.
 */
export interface UnappliedReasonInput {
  reason: string;
  /** The meant-for invoice's current status, or null when the capture sits on no invoice. */
  invoiceStatus: string | null | undefined;
  invoiceNumber: string | null | undefined;
  invoiceTotal: number | null | undefined;
  /** The money on the capture, in dollars. */
  amount: number | null | undefined;
  /** A succeeded payment on the invoice has the same amount as this one (not counting the capture's own payment row). */
  sameAmountPaid: boolean | null | undefined;
}

export interface UnappliedReasonText { short: string; long: string }

const money = (n: number): string => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const plain = (short: string): UnappliedReasonText => ({ short, long: `${short}.` });

export function unappliedReasonTexts(i: UnappliedReasonInput): UnappliedReasonText {
  const inv = i.invoiceNumber || 'The invoice';
  switch (i.reason) {
    case 'AMOUNT_MISMATCH': {
      const short = 'Amount did not match the invoice';
      return i.amount != null && i.invoiceTotal != null
        ? { short, long: `${money(i.amount)} was paid against an invoice of ${money(i.invoiceTotal)}.` }
        : plain(short);
    }
    case 'DEPOSIT_SUPERSEDED':
      return { short: 'Deposit no longer fits the estimate', long: 'The estimate changed after the deposit was requested, so this deposit no longer fits it.' };
    case 'DEPOSIT_ON_HOLD':
      return plain('Deposit was on hold when it was paid');
    case 'INVOICE_NOT_PAYABLE':
      if (i.invoiceStatus === 'PAID' && i.sameAmountPaid) {
        return { short: 'Invoice paid twice', long: `${inv} was paid twice. It was already paid in full, and this is the second payment.` };
      }
      if (i.invoiceStatus === 'PAID') {
        return { short: 'Invoice was already paid', long: `${inv} was already paid in full, by another payment, when this one arrived.` };
      }
      if (i.invoiceStatus === 'VOIDED') return { short: 'Invoice was voided', long: `${inv} was voided before this payment arrived.` };
      return plain('Paid while the invoice was not open for payment');
    case 'REFUND_UNMATCHED': {
      const short = 'Refund has no invoice reference';
      return i.invoiceNumber
        ? { short, long: `The refund was sent without an invoice reference, so ${i.invoiceNumber} does not show it.` }
        : { short, long: 'The refund was sent without an invoice reference.' };
    }
    case 'OVERPAYMENT':
      return plain('Paid more than was owed');
    case 'INVOICE_NOT_FOUND':
    case 'WRONG_ORG':
      return plain('Payment is not tied to an invoice');
    case 'DOCUMENT_MISMATCH':
      return plain('Paid for a different document than the invoice');
    default:
      return plain('Could not be applied to an invoice');
  }
}
