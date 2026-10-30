/* =============================================================================
   Payments go-live P4 - when a Needs attention item is open and how it resolves. Pure: no database.
   One row per combination in the slice's table; the expected words are written out from the slice.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import {
  classifyDispute, classifyFailedPayment, classifyFailedPayout, classifyFailedRefund, classifyUnapplied, itemKey, parseItemKey,
} from '../services/payment-attention/rules';
import { unappliedReasonTexts } from '../lib/unapplied-reason-text';

const at = new Date('2026-10-05T12:00:00Z');
const person = { text: 'Called the customer', by: 'Pat Admin', note: 'Called the customer', at };

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
      .toEqual({ open: false, text: 'Called the customer', by: 'Pat Admin', note: 'Called the customer', at });
  });
});

describe('failed_refund', () => {
  it('is open until a later non-failed (pending or succeeded) refund of at least the amount, or a person, closes it', () => {
    expect(classifyFailedRefund({ resolution: null, later: null })).toEqual({ open: true });
    expect(classifyFailedRefund({ resolution: null, later: { by: 'Sam Refunder', at } })).toEqual({ open: false, text: 'Refunded again', by: 'Sam Refunder', note: null, at });
    expect(classifyFailedRefund({ resolution: { kind: 'SETTLED', note: null, by: 'Pat Admin', at }, later: null })).toMatchObject({ open: false, text: 'Marked resolved', by: 'Pat Admin' });
  });
  it('words a person\'s resolution as the plain reason (no prefix, C-21), and never says "settled"', () => {
    const r = classifyFailedRefund({ resolution: { kind: 'SETTLED', note: 'Returned the money another way', by: 'Pat Admin', at }, later: null });
    expect(r).toEqual({ open: false, text: 'Returned the money another way', by: 'Pat Admin', note: 'Returned the money another way', at });
    expect(JSON.stringify(r)).not.toMatch(/settled|Resolved: /i);
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
  it('words a resolved capture with its reason, by and date when it has them', () => {
    const resolvedAt = new Date('2026-10-06T09:00:00Z');
    expect(classifyUnapplied({ status: 'RESOLVED', refundedAt: null, updatedAt: at, note: 'Duplicate entry', by: 'Pat Admin', at: resolvedAt }))
      .toEqual({ open: false, text: 'Duplicate entry', by: 'Pat Admin', note: 'Duplicate entry', at: resolvedAt });
    expect(classifyUnapplied({ status: 'RESOLVED', refundedAt: null, updatedAt: at, note: null, by: 'Pat Admin', at: resolvedAt }))
      .toEqual({ open: false, text: 'Marked resolved', by: 'Pat Admin', note: null, at: resolvedAt });
  });
  it('keeps REFUNDED as "Refunded", whatever else the row carries', () => {
    expect(classifyUnapplied({ status: 'REFUNDED', refundedAt: at, updatedAt: at, note: 'Duplicate entry', by: 'Pat Admin', at: null })).toMatchObject({ open: false, text: 'Refunded', at });
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

describe('unapplied reason text (spec 7.15, exact strings)', () => {
  const base = { invoiceStatus: null, invoiceNumber: null, invoiceTotal: null, amount: null, sameAmountPaid: false } as const;
  const words = (reason: string, over: Partial<Parameters<typeof unappliedReasonTexts>[0]> = {}) => unappliedReasonTexts({ reason, ...base, ...over });

  it('words an amount mismatch with both sums', () => {
    expect(words('AMOUNT_MISMATCH', { amount: 25, invoiceTotal: 600, invoiceNumber: 'INV-12' })).toEqual({
      short: 'Amount did not match the invoice', long: '$25.00 was paid against an invoice of $600.00.',
    });
    expect(words('AMOUNT_MISMATCH').long).toBe('Amount did not match the invoice.');
  });
  it('words the two deposit reasons', () => {
    expect(words('DEPOSIT_SUPERSEDED')).toEqual({
      short: 'Deposit no longer fits the estimate', long: 'The estimate changed after the deposit was requested, so this deposit no longer fits it.',
    });
    expect(words('DEPOSIT_ON_HOLD')).toEqual({ short: 'Deposit was on hold when it was paid', long: 'Deposit was on hold when it was paid.' });
  });
  it('tells "paid twice" from "already paid" by a same-amount payment, and voided from the rest', () => {
    const inv = { invoiceNumber: 'INV-7' };
    expect(words('INVOICE_NOT_PAYABLE', { ...inv, invoiceStatus: 'PAID', sameAmountPaid: true })).toEqual({
      short: 'Invoice paid twice', long: 'INV-7 was paid twice. It was already paid in full, and this is the second payment.',
    });
    expect(words('INVOICE_NOT_PAYABLE', { ...inv, invoiceStatus: 'PAID', sameAmountPaid: false })).toEqual({
      short: 'Invoice was already paid', long: 'INV-7 was already paid in full, by another payment, when this one arrived.',
    });
    expect(words('INVOICE_NOT_PAYABLE', { ...inv, invoiceStatus: 'VOIDED' })).toEqual({
      short: 'Invoice was voided', long: 'INV-7 was voided before this payment arrived.',
    });
    for (const status of ['SENT', 'DRAFT', 'REFUNDED', null]) {
      expect(words('INVOICE_NOT_PAYABLE', { ...inv, invoiceStatus: status }).short, String(status)).toBe('Paid while the invoice was not open for payment');
    }
    // A same-amount twin only matters when the invoice is PAID.
    expect(words('INVOICE_NOT_PAYABLE', { ...inv, invoiceStatus: 'VOIDED', sameAmountPaid: true }).short).toBe('Invoice was voided');
  });
  it('words a refund with and without an invoice reference', () => {
    expect(words('REFUND_UNMATCHED', { invoiceNumber: 'INV-9' })).toEqual({
      short: 'Refund has no invoice reference', long: 'The refund was sent without an invoice reference, so INV-9 does not show it.',
    });
    expect(words('REFUND_UNMATCHED')).toEqual({ short: 'Refund has no invoice reference', long: 'The refund was sent without an invoice reference.' });
  });
  it('gives the short-only reasons their short text plus a full stop, and falls back for an unknown one', () => {
    const cases: Array<[string, string]> = [
      ['OVERPAYMENT', 'Paid more than was owed'],
      ['INVOICE_NOT_FOUND', 'Payment is not tied to an invoice'],
      ['WRONG_ORG', 'Payment is not tied to an invoice'],
      ['DOCUMENT_MISMATCH', 'Paid for a different document than the invoice'],
      ['SOMETHING_NEW', 'Could not be applied to an invoice'],
    ];
    for (const [reason, short] of cases) expect(words(reason), reason).toEqual({ short, long: `${short}.` });
  });
  it('never names the payment processor or carries a processor id', () => {
    for (const reason of ['OVERPAYMENT', 'AMOUNT_MISMATCH', 'DEPOSIT_SUPERSEDED', 'DEPOSIT_ON_HOLD', 'INVOICE_NOT_FOUND', 'WRONG_ORG', 'DOCUMENT_MISMATCH', 'REFUND_UNMATCHED', 'INVOICE_NOT_PAYABLE', 'X']) {
      const t = words(reason, { invoiceNumber: 'INV-1', invoiceStatus: 'PAID', amount: 5, invoiceTotal: 9 });
      expect(`${t.short} ${t.long}`, reason).not.toMatch(/stripe|\b(pi|re|dp|po|acct)_/i);
    }
  });
});
