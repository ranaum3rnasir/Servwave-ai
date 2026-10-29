import { describe, it, expect } from 'vitest';
import {
  buildPaymentsReport,
  toPaymentRow,
  methodLabel,
  categoryLabel,
  statusLabel,
  type PaymentInput,
} from '../services/payments-report';

function input(over: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: 'pay-1',
    amount: 250,
    method: 'CARD',
    paidAt: new Date('2026-06-01T00:00:00.000Z'),
    refundedAt: null,
    voidedAt: null,
    isDepositCredit: false,
    invoiceKind: 'STANDARD',
    customerName: 'Acme Co',
    customerEmail: 'ap@acme.com',
    collectorName: 'Emanuel Dahan',
    tipAmount: 0,
    ...over,
  };
}

describe('methodLabel', () => {
  it('maps both card kinds to "Credit card"', () => {
    expect(methodLabel('CARD')).toBe('Credit card');
    expect(methodLabel('EXTERNAL_CARD')).toBe('Credit card');
  });
  it('maps BANK_TRANSFER to "ACH / Bank transfer"', () => {
    expect(methodLabel('BANK_TRANSFER')).toBe('ACH / Bank transfer');
  });
  it('maps CASH and CHECK through', () => {
    expect(methodLabel('CASH')).toBe('Cash');
    expect(methodLabel('CHECK')).toBe('Check');
  });
  // R5b (2026-07-22) — D3: PaymentMethod +4.
  it('maps the D3 methods to their display labels', () => {
    expect(methodLabel('ZELLE')).toBe('Zelle');
    expect(methodLabel('VENMO')).toBe('Venmo');
    expect(methodLabel('CASH_APP')).toBe('Cash App');
    expect(methodLabel('OTHER')).toBe('Other');
  });
});

describe('categoryLabel', () => {
  it('maps invoice kinds to report categories', () => {
    expect(categoryLabel('STANDARD')).toBe('Invoice');
    expect(categoryLabel('DEPOSIT')).toBe('Deposit');
    expect(categoryLabel('PLAN')).toBe('Recurring');
  });
});

describe('statusLabel', () => {
  it('is Succeeded by default (live payments are recorded only once collected)', () => {
    expect(statusLabel({ refundedAt: null, voidedAt: null })).toBe('Succeeded');
  });
  it('is Failed when voided', () => {
    expect(statusLabel({ refundedAt: null, voidedAt: new Date() })).toBe('Failed');
  });
  it('is Refunded when refunded', () => {
    expect(statusLabel({ refundedAt: new Date(), voidedAt: null })).toBe('Refunded');
  });
  it('refund wins over void when both are set', () => {
    expect(statusLabel({ refundedAt: new Date(), voidedAt: new Date() })).toBe('Refunded');
  });
});

describe('toPaymentRow', () => {
  it('maps a card payment to a complete transaction row', () => {
    const r = toPaymentRow(input());
    expect(r).toMatchObject({
      id: 'pay-1',
      amount: 250,
      method: 'Credit card',
      category: 'Invoice',
      status: 'Succeeded',
      client: 'Acme Co',
      email: 'ap@acme.com',
      technician: 'Emanuel Dahan',
      txnKind: 'Keyed',
      confirmation: 'Approved',
    });
    expect(r.date).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
  });

  // SRVW-55 — the report was hardcoding tip: 0 behind a stale "no tip field in the schema"
  // claim, which hid every card tip (shipped SRVW-193/194) as well as manual ones.
  it('surfaces the tip a payment carries, regardless of method', () => {
    expect(toPaymentRow(input({ method: 'CARD', tipAmount: 15 })).tip).toBe(15);
    expect(toPaymentRow(input({ method: 'CASH', tipAmount: 12.5 })).tip).toBe(12.5);
  });

  it('reports 0 for a payment with no tip', () => {
    expect(toPaymentRow(input({ tipAmount: 0 })).tip).toBe(0);
  });

  it('only card payments carry a card mask + confirmation', () => {
    expect(toPaymentRow(input({ method: 'CARD' })).card).not.toBe('');
    expect(toPaymentRow(input({ method: 'CASH' })).card).toBe('');
    expect(toPaymentRow(input({ method: 'CHECK' })).confirmation).toBe('');
    expect(toPaymentRow(input({ method: 'BANK_TRANSFER' })).confirmation).toBe('Approved');
  });

  it('falls back to Dispatch when no collector and empty email when none', () => {
    const r = toPaymentRow(input({ collectorName: null, customerEmail: null }));
    expect(r.technician).toBe('Dispatch');
    expect(r.email).toBe('');
  });

  it('falls back to Unknown when no customer name', () => {
    expect(toPaymentRow(input({ customerName: '' })).client).toBe('Unknown');
  });
});

describe('buildPaymentsReport', () => {
  it('returns rows under a `payments` key, newest first', () => {
    const out = buildPaymentsReport([
      input({ id: 'old', paidAt: new Date('2026-01-01T00:00:00.000Z') }),
      input({ id: 'new', paidAt: new Date('2026-06-01T00:00:00.000Z') }),
      input({ id: 'mid', paidAt: new Date('2026-03-01T00:00:00.000Z') }),
    ]);
    expect(out.payments.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('carries each row\'s own tip through independently of the others', () => {
    const out = buildPaymentsReport([
      input({ id: 'tipped', method: 'CARD', tipAmount: 20 }),
      input({ id: 'untipped', method: 'CASH', tipAmount: 0 }),
    ]);
    expect(out.payments.find((r) => r.id === 'tipped')?.tip).toBe(20);
    expect(out.payments.find((r) => r.id === 'untipped')?.tip).toBe(0);
  });
});

// #498 - a paid deposit later applied to a STANDARD invoice writes a synthetic Payment
// (reference_number = DEPOSIT-CREDIT). It is the SAME money as the original deposit payment,
// so it must never be summed again. The controller resolves the reference; the row carries the
// verdict so the frontend can show the application without counting it.
describe('deposit-credit rows', () => {
  it('carries the deposit-credit verdict onto the row', () => {
    expect(toPaymentRow(input({ isDepositCredit: true })).isDepositCredit).toBe(true);
  });

  it('leaves an ordinary payment unflagged', () => {
    expect(toPaymentRow(input()).isDepositCredit).toBe(false);
  });

  it('still emits the credit row - it is hidden from sums, not from the transaction table', () => {
    const out = buildPaymentsReport([
      input({ id: 'deposit', invoiceKind: 'DEPOSIT' }),
      input({ id: 'credit', isDepositCredit: true }),
    ]);
    expect(out.payments.map((r) => r.id).sort()).toEqual(['credit', 'deposit']);
  });
});
