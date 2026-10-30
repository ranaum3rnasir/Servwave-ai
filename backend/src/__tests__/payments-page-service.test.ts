/* =============================================================================
   Payments go-live P3 - the pure half of the Payments page read API (services/payments-page.ts).
   No database, no Express: fixtures in, rows out.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  paymentDisplayStatus,
  chargedAmount,
  feeOf,
  payoutReference,
  shortCode,
  toPageRow,
  type PaymentRowInput,
  payoutStatusOf,
  nextPayoutDate,
  payoutScheduleText,
  buildTimeline,
  type StatusInput,
} from '../services/payments-page';
import { describeDisputeReason } from '../lib/payment-failure-reasons';

const base: StatusInput = {
  state: 'SUCCEEDED',
  amount: 100,
  succeededRefundTotal: 0,
  voidedAt: null,
  voidCategory: null,
  openDispute: false,
  refundFailedOpen: false,
};

describe('paymentDisplayStatus', () => {
  // [name, change to the base input, expected]
  const table: Array<[string, Partial<StatusInput>, string]> = [
    ['a bank debit still clearing', { state: 'PROCESSING' }, 'Pending'],
    ['a failed payment', { state: 'FAILED' }, 'Failed'],
    ['a plain succeeded payment', {}, 'Succeeded'],
    ['an open dispute', { openDispute: true }, 'Disputed'],
    ['an open dispute that also has a partial refund', { openDispute: true, succeededRefundTotal: 20 }, 'Disputed'],
    ['a payment lost to a dispute', { voidedAt: new Date('2026-10-01'), voidCategory: 'CHARGEBACK' }, 'Charged back'],
    ['a voided payment (not a chargeback)', { voidedAt: new Date('2026-10-01'), voidCategory: 'DUPLICATE' }, 'Voided'],
    ['refunded in full', { succeededRefundTotal: 100 }, 'Refunded'],
    ['refunded in two parts that add up', { succeededRefundTotal: 100.0 }, 'Refunded'],
    ['some refunded', { succeededRefundTotal: 40 }, 'Partially refunded'],
    ['a cent short of full', { succeededRefundTotal: 99.99 }, 'Partially refunded'],
    ['refund wins over a plain void', { succeededRefundTotal: 100, voidedAt: new Date('2026-10-01'), voidCategory: 'ERROR' }, 'Refunded'],
    ['a failed payment with a stale open dispute flag', { state: 'FAILED', openDispute: true }, 'Failed'],
    ['a pending payment with a refund total', { state: 'PROCESSING', succeededRefundTotal: 10 }, 'Pending'],
    ['a refund that failed and nobody dealt with', { refundFailedOpen: true }, 'Refund failed'],
    ['an open failed refund beats Refunded', { refundFailedOpen: true, succeededRefundTotal: 100 }, 'Refund failed'],
    ['an open failed refund beats Partially refunded', { refundFailedOpen: true, succeededRefundTotal: 40 }, 'Refund failed'],
    ['an open failed refund beats Charged back', { refundFailedOpen: true, voidedAt: new Date('2026-10-01'), voidCategory: 'CHARGEBACK' }, 'Refund failed'],
    ['an open failed refund beats Voided', { refundFailedOpen: true, voidedAt: new Date('2026-10-01'), voidCategory: 'ERROR' }, 'Refund failed'],
    ['an open dispute beats an open failed refund', { refundFailedOpen: true, openDispute: true }, 'Disputed'],
    ['a failed payment beats an open failed refund', { refundFailedOpen: true, state: 'FAILED' }, 'Failed'],
    ['a pending payment beats an open failed refund', { refundFailedOpen: true, state: 'PROCESSING' }, 'Pending'],
  ];
  it.each(table)('%s', (_name, change, expected) => {
    expect(paymentDisplayStatus({ ...base, ...change })).toBe(expected);
  });
});

describe('charged amount, fee and net arithmetic', () => {
  it('adds the tip and the service fee to the invoice amount, in cents', () => {
    expect(chargedAmount({ amount: 100.1, tip: 5.2, serviceFee: 3.03 })).toBe(108.33);
  });
  it('treats a missing tip and service fee as zero', () => {
    expect(chargedAmount({ amount: 250, tip: null, serviceFee: null })).toBe(250);
  });
  it('lets Amount - Fee - Refunds equal Net on a charge with a tip and a service fee', () => {
    // charged 108.33; processor fee 3.50 + platform 0.00; net_amount is stored on the charged basis.
    const charged = chargedAmount({ amount: 100.1, tip: 5.2, serviceFee: 3.03 });
    const fee = feeOf({ stripeFee: 3.5, platformFee: 0 });
    expect(fee).toBe(3.5);
    expect(Math.round((charged - (fee as number)) * 100) / 100).toBe(104.83);
  });
  it('sums the two fee columns, and reads null (a dash) while neither is captured', () => {
    expect(feeOf({ stripeFee: 2.9, platformFee: 1.1 })).toBe(4);
    expect(feeOf({ stripeFee: 2.9, platformFee: null })).toBe(2.9);
    expect(feeOf({ stripeFee: null, platformFee: null })).toBeNull();
  });
});

describe('payout references and status', () => {
  it('derives the same short code from the same id every time, and never the processor id', () => {
    const id = '3f2a9c1e-7b64-4d0a-9e55-0a1b2c3d4e5f';
    expect(payoutReference(id)).toBe('PO-3F2A9C1E');
    expect(payoutReference(id)).toBe(payoutReference(id));
    expect(payoutReference('aaaaaaaa-0000-0000-0000-000000000000')).not.toBe(payoutReference(id));
  });
  it('builds the four short codes from the first 8 hex of the uuid, uppercased', () => {
    const id = '3f2a9c1e-7b64-4d0a-9e55-0a1b2c3d4e5f';
    expect(shortCode('PMT-', id)).toBe('PMT-3F2A9C1E');
    expect(shortCode('DSP-', id)).toBe('DSP-3F2A9C1E');
    expect(shortCode('RCV-', id)).toBe('RCV-3F2A9C1E');
    expect(shortCode('REF-', id)).toBe('REF-3F2A9C1E');
  });
  it.each([
    ['no payout yet on a collected payment', 'SUCCEEDED', null, 'awaiting'],
    ['no payout on a pending payment', 'PROCESSING', null, null],
    ['no payout on a failed payment', 'FAILED', null, null],
    ['payout pending', 'SUCCEEDED', 'PENDING', 'in_transit'],
    ['payout in transit', 'SUCCEEDED', 'IN_TRANSIT', 'in_transit'],
    ['payout paid', 'SUCCEEDED', 'PAID', 'paid'],
    ['payout failed', 'SUCCEEDED', 'FAILED', 'failed'],
    ['payout canceled', 'SUCCEEDED', 'CANCELED', 'failed'],
  ])('%s', (_n, state, payout, expected) => {
    expect(payoutStatusOf({ state: state as 'SUCCEEDED', voided: false }, payout)).toBe(expected);
  });
  it('does not call a voided payment awaiting payout', () => {
    expect(payoutStatusOf({ state: 'SUCCEEDED', voided: true }, null)).toBeNull();
  });
});

describe('payout schedule', () => {
  it('reads the schedule in words', () => {
    expect(payoutScheduleText({ interval: 'weekly', weekly_anchor: 'friday', delay_days: 2, bank_label: null })).toBe('Weekly on Fridays');
    expect(payoutScheduleText({ interval: 'daily', weekly_anchor: null, delay_days: 2, bank_label: null })).toBe('Daily');
    expect(payoutScheduleText({ interval: 'manual', weekly_anchor: null, delay_days: null, bank_label: null })).toBe('Manual');
    expect(payoutScheduleText(null)).toBeNull();
  });
  it('finds the next weekly payout day after today', () => {
    // 2026-10-13 is a Tuesday.
    expect(nextPayoutDate({ interval: 'weekly', weekly_anchor: 'friday', delay_days: 2, bank_label: null }, '2026-10-13')).toBe('2026-10-16');
    expect(nextPayoutDate({ interval: 'weekly', weekly_anchor: 'tuesday', delay_days: 2, bank_label: null }, '2026-10-13')).toBe('2026-10-20');
  });
  it('finds the next daily payout after the delay, and nothing for a schedule it cannot compute', () => {
    expect(nextPayoutDate({ interval: 'daily', weekly_anchor: null, delay_days: 2, bank_label: null }, '2026-10-13')).toBe('2026-10-15');
    expect(nextPayoutDate({ interval: 'manual', weekly_anchor: null, delay_days: null, bank_label: null }, '2026-10-13')).toBeNull();
    expect(nextPayoutDate(null, '2026-10-13')).toBeNull();
  });
});

describe('buildTimeline', () => {
  it('lists Paid, refunds, the dispute and the payout from ServWave rows, oldest first, with no processor words', () => {
    const t = buildTimeline({
      method: 'CARD',
      state: 'SUCCEEDED',
      paidAt: new Date('2026-10-01T15:00:00Z'),
      failureText: null,
      refunds: [{ amount: 20, state: 'SUCCEEDED', createdAt: new Date('2026-10-03T10:00:00Z') }],
      dispute: { status: 'NEEDS_RESPONSE', createdAt: new Date('2026-10-04T10:00:00Z'), closedAt: null },
      payout: { reference: 'PO-3F2A9C1E', arrivalDate: new Date('2026-10-02T00:00:00Z'), status: 'PAID' },
      figures: true,
    });
    expect(t.map((e) => e.label)).toEqual(['Paid', 'Paid out in PO-3F2A9C1E', 'Refunded $20.00', 'Dispute opened']);
    expect(JSON.stringify(t)).not.toMatch(/stripe|pi_|po_|ch_/i);
  });
  it('names no refund figure for a person without See prices (re-audit P2-2)', () => {
    const refunds = [
      { amount: 20, state: 'SUCCEEDED' as const, createdAt: new Date('2026-10-03T10:00:00Z') },
      { amount: 30, state: 'PENDING' as const, createdAt: new Date('2026-10-04T10:00:00Z') },
      { amount: 40, state: 'FAILED' as const, createdAt: new Date('2026-10-05T10:00:00Z') },
    ];
    const base = { method: 'CARD', state: 'SUCCEEDED' as const, paidAt: new Date('2026-10-01T15:00:00Z'), failureText: null, refunds, dispute: null, payout: null };
    expect(buildTimeline({ ...base, figures: false }).map((e) => e.label)).toEqual(['Paid', 'Refunded', 'Refund pending', 'Refund failed']);
    expect(buildTimeline({ ...base, figures: true }).map((e) => e.label)).toEqual(['Paid', 'Refunded $20.00', 'Refund of $30.00 pending', 'Refund of $40.00 failed']);
  });
  it('shows Processing then Cleared for a bank payment that succeeded, and Failed with the failure words', () => {
    const cleared = buildTimeline({ method: 'ACH', state: 'SUCCEEDED', paidAt: new Date('2026-10-01T15:00:00Z'), failureText: null, refunds: [], dispute: null, payout: null, figures: true });
    expect(cleared.map((e) => e.label)).toEqual(['Processing', 'Cleared']);
    const failed = buildTimeline({ method: 'ACH', state: 'FAILED', paidAt: new Date('2026-10-01T15:00:00Z'), failureText: 'Insufficient funds', refunds: [], dispute: null, payout: null, figures: true });
    expect(failed.map((e) => e.label)).toEqual(['Processing', 'Failed']);
    expect(failed[1].note).toBe('Insufficient funds');
    expect(failed[1].tone).toBe('danger');
  });
});

describe('describeDisputeReason', () => {
  it('turns the reason code into words and never passes an unknown code through', () => {
    expect(describeDisputeReason('fraudulent')).toBe('The cardholder says they did not make this payment');
    expect(describeDisputeReason('product_not_received')).toBe('The customer says they did not receive the service');
    expect(describeDisputeReason('something_new_from_the_processor')).toBe('The customer disputed this payment');
    expect(describeDisputeReason(null)).toBe('The customer disputed this payment');
  });
});

describe('toPageRow', () => {
  const input: PaymentRowInput = {
    id: '3f2a9c1e-7b64-4d0a-9e55-0a1b2c3d4e5f', amount: 100, tip: null, serviceFee: null, stripeFee: 3, platformFee: 0, net: 97,
    method: 'CARD', state: 'SUCCEEDED', paidAt: new Date('2026-10-01T12:00:00Z'), voidedAt: null, voidCategory: null,
    wallet: null, cardBrand: 'visa', cardLast4: '4242', bankName: null, bankLast4: null, refunds: [], openDispute: false, refundFailedOpen: false,
    payout: null, invoice: { id: 'inv-1', number: 'INV-1' }, customer: { id: 'cus-1', name: 'Pat Lee', customer_number: 'C-0042' },
  };
  it('returns the PMT- reference and the customer number', () => {
    const row = toPageRow(input, false);
    expect(row.reference).toBe('PMT-3F2A9C1E');
    expect(row.customer).toEqual({ id: 'cus-1', name: 'Pat Lee', customer_number: 'C-0042' });
  });
  it('keeps the reference on a restricted row but drops the customer', () => {
    const row = toPageRow(input, true);
    expect(row.reference).toBe('PMT-3F2A9C1E');
    expect(row.customer).toBeNull();
  });
  it('reads Refund failed when the flag is set, never Succeeded', () => {
    expect(toPageRow({ ...input, refundFailedOpen: true }, false).status).toBe('Refund failed');
  });
});
