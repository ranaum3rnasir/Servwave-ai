/**
 * Payments go-live slice 28: the staff payment history says HOW each payment was made, names an
 * online bank payment as a payment (never "Manual Payment"), names who sent a refund back, and
 * counts a deposit invoice's own payment once.
 */
import { describe, it, expect } from 'vitest';
import { buildLedgerEvents } from '@/lib/invoices/invoiceMoney';

function inv(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1', invoice_number: 'I00001', status: 'PAID', subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0,
    deposit_credit: 0, total_amount: 0, amount_due: 0, public_token: null, sent_at: null, paid_at: null, due_date: null,
    voided_at: null, voided_reason: null, refunded_at: null, total_refunded: 0, refund_reason: null, refund_reason_category: null,
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    job: null, payments: [], refunds: [], credits: [],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function payment(o: Record<string, unknown> = {}) {
  return {
    id: 'pay-1', amount: 100, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collected_by: null,
    paid_through_processor: false, reference_number: null, notes: null, created_at: '2026-07-02T00:00:00.000Z',
    collector: null, voided_at: null,
    ...o,
  };
}

const row = (events: ReturnType<typeof buildLedgerEvents>, key: string) => events.find((e) => e.key === key)!;

describe('how a payment was made', () => {
  it('each payment row carries its one-line reading', () => {
    const events = buildLedgerEvents(inv({
      payments: [
        payment({ id: 'card', method: 'CARD', card_brand: 'visa', card_last4: '4242' }),
        payment({ id: 'apple', method: 'CARD', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' }),
        payment({ id: 'link', method: 'CARD', wallet: 'LINK', card_brand: 'visa', card_last4: '0000' }),
        payment({ id: 'bank', method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }),
        payment({ id: 'cash', method: 'CASH' }),
      ],
    }));

    expect(row(events, 'card').methodDisplay).toBe('Visa •••• 4242');
    expect(row(events, 'apple').methodDisplay).toBe('Apple Pay (Visa •••• 4242)');
    expect(row(events, 'link').methodDisplay).toBe('Link');
    expect(row(events, 'bank').methodDisplay).toBe('Bank of Example •••• 6789');
    expect(row(events, 'cash').methodDisplay).toBe('Cash');
  });

  it('an online bank payment is a payment received online, never a "Manual Payment"', () => {
    const events = buildLedgerEvents(inv({ payments: [payment({ id: 'bank', method: 'ACH' }), payment({ id: 'cash', method: 'CASH' })] }));

    expect(row(events, 'bank').label).toBe('Invoice Paid');
    expect(row(events, 'bank').by).toBe('Customer (online)');
    // Staff-recorded payments are unchanged.
    expect(row(events, 'cash').label).toBe('Manual Payment');
  });

  it('a processing bank payment keeps its state so the page can say it has not cleared', () => {
    const events = buildLedgerEvents(inv({ payments: [payment({ id: 'bank', method: 'ACH', state: 'PROCESSING' })] }));

    expect(row(events, 'bank')).toMatchObject({ settlement: 'PROCESSING', countsInNet: false });
  });
});

// Conductor ruling D2 (2026-10-10): the event title follows the payment's state and the "By"
// column never names a method.
describe('payment titles and the By column (D2)', () => {
  it('titles an online payment by its state: processing, failed, and Invoice Paid only once received', () => {
    const events = buildLedgerEvents(inv({
      payments: [
        payment({ id: 'ok', method: 'ACH', state: 'SUCCEEDED' }),
        payment({ id: 'old', method: 'CARD' }),
        payment({ id: 'proc', method: 'ACH', state: 'PROCESSING' }),
        payment({ id: 'fail', method: 'ACH', state: 'FAILED' }),
      ],
    }));

    expect(row(events, 'ok').label).toBe('Invoice Paid');
    expect(row(events, 'old').label).toBe('Invoice Paid');
    expect(row(events, 'proc').label).toBe('Payment processing');
    expect(row(events, 'fail').label).toBe('Payment failed');
  });

  it('reads "Customer (online)" for every online payment and keeps the staff name on a hand payment', () => {
    const events = buildLedgerEvents(inv({
      payments: [
        payment({ id: 'card', method: 'CARD', paid_through_processor: true }),
        payment({ id: 'bank', method: 'ACH' }),
        payment({
          id: 'hand', method: 'CASH',
          collector: { id: 'u1', first_name: 'Sam', last_name: 'Staff' },
        }),
      ],
    }));

    expect(row(events, 'card').by).toBe('Customer (online)');
    expect(row(events, 'bank').by).toBe('Customer (online)');
    expect(row(events, 'hand').by).toBe('Sam Staff');
  });
});

describe('refund rows', () => {
  it('read the method from the refunded payment, like the payment row', () => {
    const events = buildLedgerEvents(inv({
      payments: [payment({ id: 'pay-v', method: 'CARD', card_brand: 'visa', card_last4: '4242' })],
      refunds: [{ id: 'r3', invoice_id: 'inv-1', payment_id: 'pay-v', amount: 10, method: 'CARD', state: 'SUCCEEDED' }],
    }));

    expect(row(events, 'refund-r3').methodDisplay).toBe('Visa •••• 4242');
  });

  it('name the person who sent the money back', () => {
    const events = buildLedgerEvents(inv({
      refunds: [{
        id: 'r1', invoice_id: 'inv-1', amount: 10, method: 'CARD', created_at: '2026-07-03T00:00:00.000Z', state: 'SUCCEEDED',
        refunded_by_user: { id: 'u1', first_name: 'Rita', last_name: 'Refunder' },
      }],
    }));

    expect(row(events, 'refund-r1').by).toBe('Rita Refunder');
  });

  it('a refund with no recorded person keeps the dash', () => {
    const events = buildLedgerEvents(inv({ refunds: [{ id: 'r2', invoice_id: 'inv-1', amount: 10, method: 'CARD', state: 'SUCCEEDED' }] }));

    expect(row(events, 'refund-r2').by).toBe('-');
  });
});

describe('a deposit invoice counts its own payment once', () => {
  const depositSiblings = (id: string) => ({
    id: 'est-1', estimate_number: 'E1',
    invoices: [{
      id, status: 'PAID', total_refunded: 0, refunded_at: null,
      payments: [{ amount: 200, method: 'CARD', paid_at: '2026-07-02T00:00:00.000Z', reference_number: null }],
    }],
  });

  it('lists the deposit payment once on the deposit invoice itself, not again as "Deposit Paid"', () => {
    const events = buildLedgerEvents(inv({
      id: 'dep-inv', kind: 'DEPOSIT', estimate: depositSiblings('dep-inv'),
      payments: [payment({ id: 'p1', amount: 200, method: 'CARD' })],
    }));

    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('p1');
  });

  it("still shows the deposit as 'Deposit Paid' on the final invoice it belongs to", () => {
    const events = buildLedgerEvents(inv({
      id: 'final-inv', estimate: depositSiblings('dep-inv'), payments: [],
    }));

    expect(events.map((e) => e.key)).toEqual(['deposit-paid']);
  });
});
