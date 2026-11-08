/**
 * Money-trust unit tests for the invoice ledger derivation (#843).
 *
 * These cover the arithmetic directly, so the invariants are asserted on numbers rather than on
 * rendered strings. The rendering side lives in invoice-detail-page.test.tsx /
 * invoice-receipt-card.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLedgerEvents,
  deriveInvoiceMoney,
  type LedgerEvent,
} from '@/lib/invoices/invoiceMoney';

// Minimal InvoiceDetail-shaped fixture - buildLedgerEvents only reads payments[], refunds[],
// credits[], status/refunded_at/total_refunded and job.estimate.
function inv(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'I00001',
    status: 'PAID',
    subtotal: 0,
    discount_amount: 0,
    tax_rate: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 0,
    amount_due: 0,
    public_token: null,
    sent_at: null,
    paid_at: null,
    due_date: null,
    voided_at: null,
    voided_reason: null,
    refunded_at: null,
    total_refunded: 0,
    refund_reason: null,
    refund_reason_category: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    job: null,
    payments: [],
    refunds: [],
    credits: [],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function payment(o: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    amount: 100,
    method: 'CASH',
    paid_at: '2026-07-02T00:00:00.000Z',
    collected_by: null,
    stripe_payment_intent_id: null,
    reference_number: null,
    notes: null,
    created_at: '2026-07-02T00:00:00.000Z',
    collector: null,
    voided_at: null,
    ...o,
  };
}

/** A job whose estimate carries a sibling paid kind=DEPOSIT invoice of `depositPaid`. */
function jobWithDeposit(depositPaid: number) {
  return {
    id: 'job-1',
    job_number: 'J00001',
    status: 'COMPLETED',
    assignees: [],
    customer: { id: 'c1', first_name: 'A', last_name: 'B', email: 'a@b.com', phone: '5550000000' },
    service_location: { id: 'sl1', address_line1: '1 A St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' },
    estimate: {
      id: 'est-1',
      estimate_number: 'E00001',
      tax_rate: 0,
      discount_amount: 0,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      line_items: [],
      invoices: [
        {
          id: 'dep-inv',
          status: 'PAID',
          total_refunded: 0,
          refunded_at: null,
          payments: [
            { amount: depositPaid, method: 'CARD', paid_at: '2026-07-02T00:00:00.000Z', reference_number: null },
          ],
        },
      ],
      lead: null,
    },
  };
}

// ─── Defect (a): voided payments ───────────────────────────────────────────────

describe('buildLedgerEvents - voided payments', () => {
  it('tags a live payment voided:false and a voided payment voided:true (both stay listed)', () => {
    const events = buildLedgerEvents(
      inv({
        payments: [payment({ id: 'p1' }), payment({ id: 'p2', voided_at: '2026-07-03T00:00:00.000Z' })],
      }),
    );
    expect(events.find((e) => e.key === 'p1')!.voided).toBe(false);
    expect(events.find((e) => e.key === 'p2')!.voided).toBe(true);
    // Voiding hides nothing - the row remains as evidence.
    expect(events).toHaveLength(2);
  });

  it('excludes voided cash from collectedGross and netCash', () => {
    // $1,000 invoice, $1,000 recorded then $200 of it voided. Collected must be $800, never $1,000.
    const ledger = buildLedgerEvents(
      inv({
        total_amount: 1000,
        amount_due: 200,
        payments: [
          payment({ id: 'p1', amount: 800 }),
          payment({ id: 'p2', amount: 200, voided_at: '2026-07-03T00:00:00.000Z' }),
        ],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 1000);
    expect(money.collectedGross).toBe(800);
    expect(money.netCash).toBe(800);
    // Negative guard: the pre-fix sum-everything reading.
    expect(money.collectedGross).not.toBe(1000);
    expect(money.overpaidAmount).toBe(0);
  });
});

// ─── Slice 5 (card service fee) — org-facing visibility ────────────────────────

describe('buildLedgerEvents - service fee (Slice 5)', () => {
  it('carries payment.service_fee_amount onto the ledger event as serviceFeeAmount', () => {
    const events = buildLedgerEvents(
      inv({
        payments: [payment({ id: 'p1', method: 'CARD', service_fee_amount: 35 })],
      }),
    );
    expect(events.find((e) => e.key === 'p1')!.serviceFeeAmount).toBe(35);
  });

  it('is null/undefined for a payment with no service fee', () => {
    const events = buildLedgerEvents(inv({ payments: [payment({ id: 'p1' })] }));
    expect(events.find((e) => e.key === 'p1')!.serviceFeeAmount ?? null).toBeNull();
  });

  it('is null for the synthetic DEPOSIT-CREDIT row, even if the underlying field were set', () => {
    const events = buildLedgerEvents(
      inv({ payments: [payment({ id: 'p1', reference_number: 'DEPOSIT-CREDIT', service_fee_amount: 35 })] }),
    );
    expect(events.find((e) => e.key === 'p1')!.serviceFeeAmount).toBeNull();
  });

  it('carries the deposit payment service fee onto the Deposit Paid row', () => {
    const job = jobWithDeposit(500);
    (job.estimate.invoices[0].payments[0] as Record<string, unknown>).service_fee_amount = 17.5;
    const events = buildLedgerEvents(inv({ job }));
    expect(events.find((e) => e.key === 'deposit-paid')!.serviceFeeAmount).toBe(17.5);
  });
});

describe('buildLedgerEvents - tip (Slice 8)', () => {
  it('carries payment.tip_amount onto the ledger event as tipAmount', () => {
    const events = buildLedgerEvents(
      inv({
        payments: [payment({ id: 'p1', method: 'CARD', tip_amount: 150 })],
      }),
    );
    expect(events.find((e) => e.key === 'p1')!.tipAmount).toBe(150);
  });

  it('is null/undefined for a payment with no tip', () => {
    const events = buildLedgerEvents(inv({ payments: [payment({ id: 'p1' })] }));
    expect(events.find((e) => e.key === 'p1')!.tipAmount ?? null).toBeNull();
  });

  it('is null for the synthetic DEPOSIT-CREDIT row, even if the underlying field were set', () => {
    const events = buildLedgerEvents(
      inv({ payments: [payment({ id: 'p1', reference_number: 'DEPOSIT-CREDIT', tip_amount: 150 })] }),
    );
    expect(events.find((e) => e.key === 'p1')!.tipAmount).toBeNull();
  });
});

// ─── Defect (b): refunds[] / credits[] are itemized ────────────────────────────

describe('buildLedgerEvents - refunds and credits', () => {
  it('emits one outbound row per refunds[] row using the ROW amount, on a PARTIALLY_REFUNDED invoice', () => {
    // The pre-fix code only read `status === 'REFUNDED' && total_refunded`, so a partial refund
    // (status PARTIALLY_REFUNDED) rendered no refund evidence whatsoever.
    const events = buildLedgerEvents(
      inv({
        status: 'PARTIALLY_REFUNDED',
        total_refunded: 65,
        refunds: [
          { id: 'r1', invoice_id: 'inv-1', amount: 40, method: 'CARD', created_at: '2026-07-04T00:00:00.000Z' },
          { id: 'r2', invoice_id: 'inv-1', amount: 25, method: 'CASH', created_at: '2026-07-05T00:00:00.000Z' },
        ],
      }),
    );
    const refunds = events.filter((e) => e.isRefund);
    expect(refunds).toHaveLength(2);
    expect(refunds.map((e) => e.amount).sort((a, b) => a - b)).toEqual([25, 40]);
    expect(refunds.every((e) => e.label === 'Refund' && e.sign === '−' && e.countsInNet)).toBe(true);
  });

  it('does NOT double-count: with refunds[] present, the legacy aggregate row is omitted', () => {
    const events = buildLedgerEvents(
      inv({
        status: 'REFUNDED',
        refunded_at: '2026-07-06T00:00:00.000Z',
        total_refunded: 100,
        refunds: [{ id: 'r1', invoice_id: 'inv-1', amount: 100, method: 'CARD', created_at: '2026-07-04T00:00:00.000Z' }],
      }),
    );
    expect(events.filter((e) => e.isRefund)).toHaveLength(1);
    expect(events.some((e) => e.key === 'invoice-refunded')).toBe(false);
    expect(deriveInvoiceMoney(events, 100).refundedTotal).toBe(100);
  });

  it('keeps the legacy aggregate row as a fallback when refunds[] is empty', () => {
    const events = buildLedgerEvents(
      inv({ status: 'REFUNDED', refunded_at: '2026-07-06T00:00:00.000Z', total_refunded: 200, refunds: [] }),
    );
    const agg = events.find((e) => e.key === 'invoice-refunded')!;
    expect(agg).toBeDefined();
    expect(agg.amount).toBe(200);
    expect(agg.isRefund).toBe(true);
  });

  it('tags a credit isCredit:true and never counts it as cash', () => {
    const events = buildLedgerEvents(
      inv({
        total_amount: 1000,
        amount_due: 0,
        payments: [payment({ id: 'p1', amount: 950 })],
        credits: [{ id: 'c1', invoice_id: 'inv-1', amount: 50, reason: 'Goodwill', created_at: '2026-07-07T00:00:00.000Z' }],
      }),
    );
    const credit = events.find((e) => e.isCredit)!;
    expect(credit.label).toBe('Credit');
    expect(credit.amount).toBe(50);
    expect(credit.sign).toBe('−');
    expect(credit.isRefund).toBe(false);

    const money = deriveInvoiceMoney(events, 1000);
    // Net CASH is the $950 actually received - the credit is NOT cash and is reported separately.
    expect(money.netCash).toBe(950);
    expect(money.creditedTotal).toBe(50);
    // Negative guard: a credit must never be added into, nor subtracted from, net cash.
    expect(money.netCash).not.toBe(1000);
    expect(money.netCash).not.toBe(900);
  });
});

// ─── Defect (c): refunds reopen the settled basis ──────────────────────────────

describe('deriveInvoiceMoney - settled basis', () => {
  it('a refund lowers settled even though amount_due stays 0 (the backend never reopens it)', () => {
    const ledger = buildLedgerEvents(
      inv({
        status: 'PARTIALLY_REFUNDED',
        total_amount: 1000,
        amount_due: 0,
        payments: [payment({ id: 'p1', amount: 1000 })],
        refunds: [{ id: 'r1', invoice_id: 'inv-1', amount: 300, method: 'CASH', created_at: '2026-07-04T00:00:00.000Z' }],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 1000);
    expect(money.netCash).toBe(700);
    expect(money.settled).toBe(700);
    // Negative guard: the legacy (total − amount_due) reading.
    expect(money.settled).not.toBe(1000);
  });

  it('a credit alone keeps a zero-balance invoice fully settled (the conservative choice)', () => {
    // $50 credit + $950 cash on a $1,000 invoice: nothing is owed, so the bar must not read as
    // uncollected. `settled` = 1000 while `netCash` still truthfully reports 950.
    const ledger = buildLedgerEvents(
      inv({
        total_amount: 1000,
        amount_due: 0,
        payments: [payment({ id: 'p1', amount: 950 })],
        credits: [{ id: 'c1', invoice_id: 'inv-1', amount: 50, created_at: '2026-07-07T00:00:00.000Z' }],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 1000);
    expect(money.settled).toBe(1000);
    expect(money.netCash).toBe(950);
    expect(money.overpaidAmount).toBe(0);
  });
});

// ─── Defect (d) basis + the deposit money bug ─────────────────────────────────

describe('deriveInvoiceMoney - overpayment', () => {
  it('reports the surplus when more cash is settled than the invoice bills for', () => {
    const ledger = buildLedgerEvents(
      inv({ status: 'PAID', total_amount: 500, amount_due: 0, payments: [payment({ id: 'p1', amount: 650 })] }),
    );
    const money = deriveInvoiceMoney(ledger, 500);
    expect(money.overpaidAmount).toBe(150);
  });

  it('does NOT invent an overpayment from an UNSPENT deposit (the applied credit is the basis)', () => {
    // A $500 deposit against a $300 invoice: applyDepositCredit draws down only
    // min(remaining, invoiceTotal) = $300, leaving $200 unspent on the deposit invoice. Reading the
    // RAW deposit payment would compute overpaid = $200 and render a false "issue a refund" banner.
    const ledger = buildLedgerEvents(
      inv({
        status: 'PAID',
        total_amount: 300,
        amount_due: 0,
        deposit_credit: 300,
        job: jobWithDeposit(500),
        payments: [
          // The synthetic drawdown Payment the backend writes: the APPLIED $300, not the raw $500.
          payment({ id: 'dc', amount: 300, method: 'CARD', reference_number: 'DEPOSIT-CREDIT' }),
        ],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 300);
    expect(money.collectedGross).toBe(300);
    expect(money.overpaidAmount).toBe(0);
    // Negative guard: the raw-deposit reading that produced the false banner.
    expect(money.collectedGross).not.toBe(500);
    expect(money.overpaidAmount).not.toBe(200);

    // The raw Deposit Paid row still RENDERS as evidence - it just does not count here.
    const depositRow = ledger.find((e) => e.key === 'deposit-paid')!;
    expect(depositRow.amount).toBe(500);
    expect(depositRow.countsInNet).toBe(false);
  });

  it('counts the APPLIED deposit toward collection, so a deposit-settled invoice reads fully settled', () => {
    // $1,000 invoice: $300 deposit applied + $700 paid directly. Both must count.
    const ledger = buildLedgerEvents(
      inv({
        status: 'PAID',
        total_amount: 1000,
        amount_due: 0,
        deposit_credit: 300,
        job: jobWithDeposit(300),
        payments: [
          payment({ id: 'dc', amount: 300, method: 'CARD', reference_number: 'DEPOSIT-CREDIT' }),
          payment({ id: 'p1', amount: 700, paid_at: '2026-07-03T00:00:00.000Z' }),
        ],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 1000);
    expect(money.settled).toBe(1000);
    // Negative guard: the payments-only reading that ignores the deposit drawdown.
    expect(money.settled).not.toBe(700);
  });

  it('drops the deposit contribution once its drawdown is reversed (voided synthetic row)', () => {
    // Voiding the DEPOSIT invoice's payment cascades: it voids the synthetic DEPOSIT-CREDIT row on
    // the target and raises amount_due. `invoice.deposit_credit` is NOT cleared, so reading that
    // column instead would keep counting money that was reversed.
    const ledger = buildLedgerEvents(
      inv({
        status: 'PARTIAL',
        total_amount: 1000,
        amount_due: 300,
        deposit_credit: 300,
        job: jobWithDeposit(300),
        payments: [
          payment({ id: 'dc', amount: 300, method: 'CARD', reference_number: 'DEPOSIT-CREDIT', voided_at: '2026-07-09T00:00:00.000Z' }),
          payment({ id: 'p1', amount: 700, paid_at: '2026-07-03T00:00:00.000Z' }),
        ],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 1000);
    expect(money.collectedGross).toBe(700);
    expect(money.settled).toBe(700);
    expect(money.collectedGross).not.toBe(1000);
  });

  it('leaves the sibling deposit invoice REFUND out of this invoice arithmetic', () => {
    // The deposit refund is money leaving the DEPOSIT invoice. This invoice only ever received the
    // applied slice, so subtracting the full deposit refund here would double-charge it.
    const job = jobWithDeposit(500);
    job.estimate.invoices[0] = {
      ...job.estimate.invoices[0],
      status: 'REFUNDED',
      total_refunded: 500,
      refunded_at: '2026-07-08T00:00:00.000Z',
    };
    const ledger = buildLedgerEvents(
      inv({
        status: 'PAID',
        total_amount: 300,
        amount_due: 0,
        deposit_credit: 300,
        job,
        payments: [payment({ id: 'dc', amount: 300, method: 'CARD', reference_number: 'DEPOSIT-CREDIT' })],
      }),
    );
    const money = deriveInvoiceMoney(ledger, 300);
    expect(money.refundedTotal).toBe(0);
    expect(money.netCash).toBe(300);
    // Negative guard: subtracting the raw deposit refund would drive net cash to −$200.
    expect(money.netCash).not.toBe(-200);
    // The row is still rendered as evidence.
    expect(ledger.find((e) => e.key === 'deposit-refunded')!.countsInNet).toBe(false);
  });
});

// Type-only guard so the LedgerEvent import is load-bearing (these fields must exist on the type).
const _shape: Pick<LedgerEvent, 'voided' | 'isCredit' | 'isRefund' | 'countsInNet'> = {
  voided: false,
  isCredit: false,
  isRefund: false,
  countsInNet: true,
};
void _shape;
