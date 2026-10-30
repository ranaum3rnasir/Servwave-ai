/* =============================================================================
   Payments go-live P4 - when a Needs attention item is open and how it resolves. Pure: no database.
   One row per combination in the slice's table; the expected words are written out from the slice.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import {
  classifyDispute, classifyFailedPayment, classifyFailedPayout, classifyFailedRefund, classifyUnapplied, itemKey, parseItemKey,
} from '../services/payment-attention/rules';
import { unappliedReasonText } from '../lib/unapplied-reason-text';

const at = new Date('2026-10-05T12:00:00Z');
const person = { text: 'Marked resolved', by: 'Pat Admin', note: 'Called the customer', at };

describe('failed_payment', () => {
  const base = { resolution: null, invoiceStatus: 'SENT', later: null };
  it('is open with nothing after it', () => {
    expect(classifyFailedPayment(base)).toEqual({ open: true });
  });
  it('resolves "Paid again" when later non-failed (succeeded or processing) online payments cover it (queries.ts decides which payments count; this only words it)', () => {
    expect(classifyFailedPayment({ ...base, later: { method: 'ACH', at } })).toMatchObject({ open: false, text: 'Paid again', at });
    expect(classifyFailedPayment({ ...base, later: { method: 'CARD', at } })).toMatchObject({ open: false, text: 'Paid again' });
  });
  it('resolves "Paid another way" when a later hand payment, or the invoice itself, is paid', () => {
    expect(classifyFailedPayment({ ...base, later: { method: 'CASH', at } })).toMatchObject({ open: false, text: 'Paid another way' });
    expect(classifyFailedPayment({ ...base, invoiceStatus: 'PAID' })).toMatchObject({ open: false, text: 'Paid another way' });
  });
  it('resolves "Invoice voided" when the invoice is voided', () => {
    expect(classifyFailedPayment({ ...base, invoiceStatus: 'VOIDED' })).toMatchObject({ open: false, text: 'Invoice voided' });
  });
  it('a person\'s resolution wins over everything and carries the note and name', () => {
    expect(classifyFailedPayment({ ...base, invoiceStatus: 'PAID', resolution: { kind: 'RESOLVED', note: person.note, by: person.by, at } }))
      .toEqual({ open: false, text: 'Marked resolved', by: 'Pat Admin', note: 'Called the customer', at });
  });
});

describe('failed_refund', () => {
  it('is open until a later non-failed (pending or succeeded) refund of at least the amount, or a person, closes it', () => {
    expect(classifyFailedRefund({ resolution: null, later: null })).toEqual({ open: true });
    expect(classifyFailedRefund({ resolution: null, later: { by: 'Sam Refunder', at } })).toEqual({ open: false, text: 'Refunded again', by: 'Sam Refunder', note: null, at });
    expect(classifyFailedRefund({ resolution: { kind: 'SETTLED', note: null, by: 'Pat Admin', at }, later: null })).toMatchObject({ open: false, text: 'Marked settled', by: 'Pat Admin' });
  });
});

describe('dispute', () => {
  it('is open only while it needs a response; each other status says what happened', () => {
    expect(classifyDispute({ status: 'NEEDS_RESPONSE', at })).toEqual({ open: true });
    const text = (status: string) => (classifyDispute({ status, at }) as { text: string }).text;
    expect(text('UNDER_REVIEW')).toBe('Evidence submitted');
    expect(text('WON')).toBe('Dispute won');
    expect(text('LOST')).toBe('Dispute lost');
    expect(text('CLOSED')).toBe('Dispute closed');
  });
});

describe('failed_payout', () => {
  it('is open until a later payout is paid or a person closes it', () => {
    expect(classifyFailedPayout({ resolution: null, laterPaidAt: null })).toEqual({ open: true });
    expect(classifyFailedPayout({ resolution: null, laterPaidAt: at })).toMatchObject({ open: false, text: 'Payout sent', at });
    expect(classifyFailedPayout({ resolution: { kind: 'RESOLVED', note: null, by: 'Pat Admin', at }, laterPaidAt: at })).toMatchObject({ open: false, text: 'Marked resolved' });
  });
});

describe('unmatched captures', () => {
  it('are open while OPEN, then Refunded or Marked resolved', () => {
    expect(classifyUnapplied({ status: 'OPEN', refundedAt: null, updatedAt: at })).toEqual({ open: true });
    expect(classifyUnapplied({ status: 'REFUNDED', refundedAt: at, updatedAt: new Date(0) })).toMatchObject({ open: false, text: 'Refunded', at });
    expect(classifyUnapplied({ status: 'RESOLVED', refundedAt: null, updatedAt: at })).toMatchObject({ open: false, text: 'Marked resolved', at });
  });
});

describe('item keys', () => {
  it('are <type>:<uuid> and parse back; anything else is refused', () => {
    const id = '0b5e7d6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    expect(itemKey('failed_refund', id)).toBe(`failed_refund:${id}`);
    expect(parseItemKey(`failed_refund:${id}`)).toEqual({ type: 'failed_refund', id });
    expect(parseItemKey(`bogus:${id}`)).toBeNull();
    expect(parseItemKey('failed_refund:not-a-uuid')).toBeNull();
    expect(parseItemKey('failed_refund')).toBeNull();
  });
});

describe('unapplied reason text (moved server-side, wording unchanged)', () => {
  it('words "not payable" from the invoice\'s current state', () => {
    expect(unappliedReasonText('INVOICE_NOT_PAYABLE', 'PAID')).toBe('Paid after the invoice was already paid in full.');
    expect(unappliedReasonText('INVOICE_NOT_PAYABLE', 'VOIDED')).toBe('Paid after the invoice was voided.');
    expect(unappliedReasonText('INVOICE_NOT_PAYABLE', 'SENT')).toBe('Paid while the invoice was not open for payment.');
    expect(unappliedReasonText('INVOICE_NOT_PAYABLE', null)).toBe('Paid while the invoice was not open for payment.');
  });
  // Moved from the Settings card's wording test (payments go-live P8): the reason follows the invoice's real state.
  it.each([
    ['DRAFT', /not open for payment/i, /voided|already paid/i],
    ['REFUNDED', /not open for payment/i, /voided|already paid/i],
    ['PAID', /already paid in full/i, /voided/i],
    ['VOIDED', /voided/i, /already paid/i],
  ])('an invoice that was %s is worded from that state alone', (status, says, doesNotSay) => {
    const text = unappliedReasonText('INVOICE_NOT_PAYABLE', status);
    expect(text).toMatch(says);
    expect(text).not.toMatch(doesNotSay);
  });
  it('words an org-level row as "not tied to an invoice" for every reason that means no invoice', () => {
    for (const reason of ['INVOICE_NOT_FOUND', 'WRONG_ORG']) {
      expect(unappliedReasonText(reason, null)).toBe('Not tied to an invoice in this account.');
    }
    expect(unappliedReasonText('REFUND_UNMATCHED', null)).not.toMatch(/stripe/i);
  });
  it('words the estimate-deposit reasons and never names the payment processor', () => {
    expect(unappliedReasonText('DEPOSIT_SUPERSEDED', null)).toMatch(/estimate changed after this deposit was sent/i);
    expect(unappliedReasonText('DEPOSIT_ON_HOLD', null)).toMatch(/deposit was on hold/i);
    expect(unappliedReasonText('AMOUNT_MISMATCH', null)).toBe('The amount paid did not match the amount owed.');
    expect(unappliedReasonText('DOCUMENT_MISMATCH', null)).toBe('Paid for a different document than the invoice it named.');
    for (const reason of ['OVERPAYMENT', 'AMOUNT_MISMATCH', 'DEPOSIT_SUPERSEDED', 'DEPOSIT_ON_HOLD', 'INVOICE_NOT_FOUND', 'WRONG_ORG', 'DOCUMENT_MISMATCH', 'REFUND_UNMATCHED']) {
      expect(unappliedReasonText(reason, null), reason).not.toMatch(/stripe/i);
    }
  });
  it('words the other reasons and falls back for an unknown one', () => {
    expect(unappliedReasonText('OVERPAYMENT', null)).toBe('Paid more than the balance due. This is the part that was not applied.');
    expect(unappliedReasonText('REFUND_UNMATCHED', null)).toBe('A refund went out of your ServWave Payments account for a payment ServWave has no record of.');
    expect(unappliedReasonText('SOMETHING_NEW', null)).toBe('Could not be applied to an invoice.');
  });
});
