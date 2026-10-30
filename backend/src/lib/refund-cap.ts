import type { Prisma } from '@prisma/client';

import { DEPOSIT_CREDIT_REFERENCE, remainingDepositCredit } from './deposit-credit';
import { COUNTED_PAYMENT_WHERE, fromCents, heldRefundCents, paidCents } from './payment-ledger';

/**
 * How much of an invoice's money can still be given back, in ONE place, so the refund route (which refuses) and the
 * Payments drawer (which decides whether to offer the button) can never disagree.
 *
 * Payments go-live P6: the drawer used to look only at the payment's own room, so a deposit already drawn down onto a job,
 * or a hand refund recorded with no payment named, left it offering a refund the route then refused.
 */

/** Real money payments of an invoice: counted ones (succeeded, not voided), never the synthetic deposit-credit rows. */
export const REFUNDABLE_PAYMENT_WHERE: Prisma.PaymentWhereInput = {
  ...COUNTED_PAYMENT_WHERE,
  OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }],
};

/** The invoice statuses the refund route accepts. */
export const REFUNDABLE_INVOICE_STATUSES: readonly string[] = ['PAID', 'PARTIALLY_REFUNDED'];

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

export interface RefundCapInvoice {
  id: string;
  kind: string;
  /** Loaded with {@link REFUNDABLE_PAYMENT_WHERE}. */
  payments: ReadonlyArray<{ amount: Prisma.Decimal | number | string }>;
  /** Every refund of the invoice, with its payment's void date. */
  refunds: ReadonlyArray<{
    amount: Prisma.Decimal | number | string;
    state: 'PENDING' | 'SUCCEEDED' | 'FAILED';
    payment?: { voided_at: Date | string | null } | null;
  }>;
}

/**
 * The invoice-level ceiling on all refunds, in dollars. A DEPOSIT invoice refunds only the credit not yet drawn down
 * onto a job (paid - applied - refunded); any other invoice what it has net paid (payments less the refunds that still
 * hold money back).
 */
export async function invoiceRefundCap(tx: Prisma.TransactionClient, invoice: RefundCapInvoice): Promise<number> {
  if (invoice.kind === 'DEPOSIT') return roundMoney(await remainingDepositCredit(tx, invoice.id));
  return fromCents(paidCents(invoice.payments) - heldRefundCents(invoice.refunds));
}
