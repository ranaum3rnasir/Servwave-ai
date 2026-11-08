import { describe, it, expect } from 'vitest';
import {
  isInvoiceEditable,
  amountPaidOf,
  creditsTotalOf,
  LOCKED_INVOICE_STATUSES,
  isSentInvoice,
  needsResend,
} from '../invoice-editable';

// Pure policy helper (no Prisma/IO) for the P2 invoice edit-lock: editable until fully settled.
describe('isInvoiceEditable', () => {
  it('treats DRAFT, SENT, and PARTIAL as editable (partial payment does NOT lock)', () => {
    expect(isInvoiceEditable('DRAFT')).toBe(true);
    expect(isInvoiceEditable('SENT')).toBe(true);
    expect(isInvoiceEditable('PARTIAL')).toBe(true);
  });

  it('locks PAID / VOIDED / REFUNDED / PARTIALLY_REFUNDED / DISPUTED', () => {
    for (const s of LOCKED_INVOICE_STATUSES) {
      expect(isInvoiceEditable(s)).toBe(false);
    }
  });
});

describe('amountPaidOf', () => {
  it('is 0 for a DRAFT/SENT invoice with no payments (amount_due == total − deposit)', () => {
    expect(amountPaidOf(1080, 0, 1080, 0)).toBe(0);
    expect(amountPaidOf(1080, 200, 880, 0)).toBe(0);
  });

  it('returns the real money applied on a PARTIAL invoice', () => {
    expect(amountPaidOf(1080, 0, 580, 0)).toBe(500); // paid 500 of 1080
    expect(amountPaidOf(1080, 200, 380, 0)).toBe(500); // deposit 200 + paid 500, due 380
  });

  it('clamps at 0 (never negative)', () => {
    expect(amountPaidOf(100, 0, 250, 0)).toBe(0);
  });

  // SRVW-84: credit() lowers amount_due with no Payment row, so a credited balance is a
  // write-off, not cash. It has to come out of the derivation or it reads as a phantom payment.
  it('reads 0 collected on a fully credit-noted invoice', () => {
    expect(amountPaidOf(1000, 0, 0, 1000)).toBe(0);
  });

  it('nets credits out but keeps the real cash', () => {
    expect(amountPaidOf(1000, 0, 0, 600)).toBe(400); // 400 collected, 600 written off
  });
});

describe('creditsTotalOf', () => {
  it('sums the credit rows on the invoice', () => {
    expect(creditsTotalOf([{ amount: 600 }, { amount: 400 }])).toBe(1000);
  });

  it('is 0 for an empty list or a relation the caller did not load', () => {
    expect(creditsTotalOf([])).toBe(0);
    expect(creditsTotalOf(null)).toBe(0);
    expect(creditsTotalOf(undefined)).toBe(0);
  });

  it('rounds to cents (Decimal columns arrive as strings/Decimal, not floats)', () => {
    expect(creditsTotalOf([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
  });
});

describe('isSentInvoice', () => {
  it('is true for SENT with a sent_at timestamp', () => {
    expect(isSentInvoice('SENT', new Date())).toBe(true);
  });

  it('is true for PARTIAL with a sent_at timestamp', () => {
    expect(isSentInvoice('PARTIAL', new Date())).toBe(true);
  });

  it('is false for DRAFT even with a sent_at timestamp', () => {
    expect(isSentInvoice('DRAFT', new Date())).toBe(false);
  });

  it('is false for SENT with a null sent_at', () => {
    expect(isSentInvoice('SENT', null)).toBe(false);
  });

  it('is false for a locked/settled status', () => {
    expect(isSentInvoice('PAID', new Date())).toBe(false);
  });
});

describe('needsResend', () => {
  it('is true when the latest material edit is after the latest send', () => {
    const sentAt = new Date('2026-07-30T10:00:00Z');
    const editedAt = new Date('2026-07-30T11:00:00Z');
    expect(needsResend(editedAt, sentAt)).toBe(true);
  });

  it('is false when there is no edit at all', () => {
    const sentAt = new Date('2026-07-30T10:00:00Z');
    expect(needsResend(null, sentAt)).toBe(false);
  });

  it('is false when the edit is before the send (resend clears it)', () => {
    const sentAt = new Date('2026-07-30T11:00:00Z');
    const editedAt = new Date('2026-07-30T10:00:00Z');
    expect(needsResend(editedAt, sentAt)).toBe(false);
  });

  it('is false on an exact tie (strict greater-than, not gte)', () => {
    const same = new Date('2026-07-30T10:00:00Z');
    expect(needsResend(same, same)).toBe(false);
  });

  it('is false when the invoice was never sent', () => {
    const editedAt = new Date('2026-07-30T10:00:00Z');
    expect(needsResend(editedAt, null)).toBe(false);
  });
});
