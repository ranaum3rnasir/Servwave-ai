/**
 * Payments go-live slice 05: the invoice page's money figures count only money that landed.
 *
 * A bank payment still PROCESSING may fail, and a FAILED one never arrived, so neither is
 * collected. A PENDING bank refund has not reached the customer yet, and a FAILED refund never
 * will, so neither is refunded. Those rows stay in the history (slice 28 badges them); they just
 * never enter a total.
 */
import { describe, it, expect } from 'vitest';
import { buildLedgerEvents, deriveInvoiceMoney } from '@/lib/invoices/invoiceMoney';

const at = '2026-10-06T12:00:00.000Z';
const payment = (id: string, amount: number, state: string) => ({
  id, amount, method: 'ACH', state, paid_at: at, collected_by: null, paid_through_processor: false,
  reference_number: null, notes: null, created_at: at, collector: null, voided_at: null,
});
const refund = (id: string, amount: number, state: string) => ({
  id, payment_id: null, amount, state, method: 'ACH', reason: null, reason_category: 'CUSTOMER_REQUEST', created_at: at,
});

function invoice(payments: unknown[], refunds: unknown[] = []) {
  return {
    id: 'inv-1', invoice_number: 'I00001', status: 'PARTIAL', subtotal: 300, discount_amount: 0, tax_rate: 0,
    tax_amount: 0, deposit_credit: 0, total_amount: 300, amount_due: 200, public_token: null, sent_at: null,
    paid_at: null, due_date: null, voided_at: null, voided_reason: null, refunded_at: null, total_refunded: 10,
    refund_reason: null, refund_reason_category: null, created_at: at, updated_at: at, job: null,
    payments, refunds, credits: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('invoice money figures count SUCCEEDED rows only', () => {
  it('a processing or failed payment is not collected; a pending or failed refund is not refunded', () => {
    const inv = invoice(
      [payment('p1', 100, 'SUCCEEDED'), payment('p2', 50, 'PROCESSING'), payment('p3', 25, 'FAILED')],
      [refund('r1', 10, 'SUCCEEDED'), refund('r2', 20, 'PENDING'), refund('r3', 30, 'FAILED')],
    );
    const ledger = buildLedgerEvents(inv);

    // Every row is still in the history...
    expect(ledger.map((e) => e.key).sort()).toEqual(['p1', 'p2', 'p3', 'refund-r1', 'refund-r2', 'refund-r3']);
    // ...but only the landed money is counted.
    expect(deriveInvoiceMoney(ledger, 300)).toMatchObject({ collectedGross: 100, refundedTotal: 10, netCash: 90 });
  });

  it('a row with no state (an older payload) counts, as it did before the column existed', () => {
    const { state: _p, ...legacyPayment } = payment('p1', 100, 'SUCCEEDED');
    const { state: _r, ...legacyRefund } = refund('r1', 10, 'SUCCEEDED');
    const ledger = buildLedgerEvents(invoice([legacyPayment], [legacyRefund]));
    expect(deriveInvoiceMoney(ledger, 300)).toMatchObject({ collectedGross: 100, refundedTotal: 10 });
  });
});
