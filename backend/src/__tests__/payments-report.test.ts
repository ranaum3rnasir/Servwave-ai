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
    refundedAmount: null,
    voidedAt: null,
    isDepositCredit: false,
    invoiceKind: 'STANDARD',
    customerName: 'Acme Co',
    customerEmail: 'ap@acme.com',
    collectorName: 'Sam Rivera',
    tipAmount: 0,
    ...over,
  };
}

describe('methodLabel', () => {
  it('maps the processor card to "Credit card" and a card taken elsewhere to its own label', () => {
    expect(methodLabel('CARD')).toBe('Credit card');
    expect(methodLabel('EXTERNAL_CARD')).toBe('Card (outside ServWave)');
  });
  // Payments go-live slice 28: ACH means the online bank debit only. A transfer recorded by hand
  // is just a bank transfer.
  it('maps a hand-recorded BANK_TRANSFER to "Bank transfer", with no ACH in it', () => {
    expect(methodLabel('BANK_TRANSFER')).toBe('Bank transfer');
  });
  // Payments go-live slice 13: an online bank debit (ACH) is a row the report must name, from the
  // first bank payment on. The union is the database enum itself, so a new method cannot be missed.
  it('maps an online bank payment (ACH) to "Bank (ACH)"', () => {
    expect(methodLabel('ACH')).toBe('Bank (ACH)');
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
  const none = { amount: 100, refundedAt: null, refundedAmount: null, voidedAt: null };
  it('is Succeeded by default (live payments are recorded only once collected)', () => {
    expect(statusLabel(none)).toBe('Succeeded');
  });
  // Slice 28: a voided payment was cancelled; "Failed" now means a bank debit that did not clear.
  it('is Charged back when voided because of a chargeback, and Voided for every other void (slice 33b)', () => {
    expect(statusLabel({ ...none, voidedAt: new Date(), voidCategory: 'CHARGEBACK' })).toBe('Charged back');
    expect(statusLabel({ ...none, voidedAt: new Date(), voidCategory: 'BOUNCED' })).toBe('Voided');
    expect(statusLabel({ ...none, voidedAt: new Date(), voidCategory: null })).toBe('Voided');
    expect(toPaymentRow(input({ voidedAt: new Date(), voidCategory: 'CHARGEBACK' })).status).toBe('Charged back');
  });
  it('is Voided when voided', () => {
    expect(statusLabel({ ...none, voidedAt: new Date() })).toBe('Voided');
  });
  it('is Refunded when the whole payment was refunded', () => {
    expect(statusLabel({ ...none, refundedAt: new Date(), refundedAmount: 100 })).toBe('Refunded');
  });
  it('is Partly refunded when only part of it went back', () => {
    expect(statusLabel({ ...none, refundedAt: new Date(), refundedAmount: 40 })).toBe('Partly refunded');
  });
  it('treats a refund with no recorded amount as a full refund (rows from before the amount was kept)', () => {
    expect(statusLabel({ ...none, refundedAt: new Date() })).toBe('Refunded');
  });
  it('refund wins over void when both are set', () => {
    expect(statusLabel({ ...none, refundedAt: new Date(), refundedAmount: 100, voidedAt: new Date() })).toBe('Refunded');
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
      technician: 'Sam Rivera',
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

  it('only card and bank payments carry a confirmation', () => {
    expect(toPaymentRow(input({ method: 'CASH' })).card).toBe('');
    expect(toPaymentRow(input({ method: 'CHECK' })).confirmation).toBe('');
    expect(toPaymentRow(input({ method: 'BANK_TRANSFER' })).confirmation).toBe('Approved');
  });

  it('an online bank payment (ACH) is labelled and carries the processor confirmation', () => {
    const row = toPaymentRow(input({ method: 'ACH' }));
    expect(row.method).toBe('Bank (ACH)');
    expect(row.confirmation).toBe('Approved');
    expect(row.card).toBe('');
  });

  // Conductor ruling 2026-10-10 (D3): the Card column reads like the ledger, from the fields the
  // payment row stores, never a placeholder mask.
  it('a card payment reads brand plus last four', () => {
    expect(toPaymentRow(input({ method: 'CARD', cardBrand: 'visa', cardLast4: '4242' })).card).toBe('Visa •••• 4242');
  });
  it('a bank debit reads bank name plus last four', () => {
    expect(toPaymentRow(input({ method: 'ACH', bankName: 'First Test Bank', bankLast4: '6789' })).card).toBe('First Test Bank •••• 6789');
  });
  it('a wallet payment names the wallet and the card behind it', () => {
    expect(toPaymentRow(input({ method: 'CARD', wallet: 'APPLE_PAY', cardBrand: 'visa', cardLast4: '4242' })).card).toBe('Apple Pay (Visa •••• 4242)');
  });
  it('a card with no stored details reads empty rather than a mask, and a hand payment stays empty', () => {
    expect(toPaymentRow(input({ method: 'CARD' })).card).toBe('');
    expect(toPaymentRow(input({ method: 'CASH', cardLast4: '4242' })).card).toBe('');
  });

  it('falls back to Dispatch when no collector and empty email when none', () => {
    const r = toPaymentRow(input({ collectorName: null, customerEmail: null }));
    expect(r.technician).toBe('Dispatch');
    expect(r.email).toBe('');
  });

  // Payments go-live slice 35 (from the slice 13 acceptance): an online payment was made by the customer, not keyed
  // by anyone, so it names no technician and reads "Online" rather than "Dispatch" / "Keyed".
  it('an online payment reads Online with no technician', () => {
    const r = toPaymentRow(input({ method: 'ACH', collectorName: null, paidOnline: true }));
    expect(r.txnKind).toBe('Online');
    expect(r.technician).toBe('');
  });

  it('an online card payment reads the same way', () => {
    const r = toPaymentRow(input({ method: 'CARD', collectorName: null, paidOnline: true }));
    expect(r).toMatchObject({ txnKind: 'Online', technician: '' });
  });

  it('a payment someone keyed stays Keyed, and still falls back to Dispatch without a collector', () => {
    expect(toPaymentRow(input({ paidOnline: false })).txnKind).toBe('Keyed');
    expect(toPaymentRow(input({ collectorName: null })).technician).toBe('Dispatch');
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
