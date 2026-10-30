/* =============================================================================
   Payments go-live, slice 05: the ledger's money math is integer cents.

   Every total the ledger hands back (what was paid, what was refunded, what is committed to go
   back) is a whole number of cents, summed from the exact two-decimal amounts the database
   holds, and refund status is decided by comparing cents, never by a float tolerance.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  toCents, paidCents, refundedCents, committedRefundCents, refundStatusFor,
} from '../lib/payment-ledger';

const refund = (amount: string, state: 'PENDING' | 'SUCCEEDED' | 'FAILED') => ({ amount: new Prisma.Decimal(amount), state });

describe('payment ledger money math is integer cents', () => {
  it('reads an amount as whole cents, from a Decimal, a string or a number', () => {
    expect(toCents(new Prisma.Decimal('19.99'))).toBe(1999);
    expect(toCents('0.10')).toBe(10);
    expect(toCents(1.15)).toBe(115);
    expect(toCents(new Prisma.Decimal('9999999999.99'))).toBe(999999999999);
  });

  it('sums payments to whole cents: ten 10-cent payments are exactly 100 cents', () => {
    const payments = Array.from({ length: 10 }, () => ({ amount: new Prisma.Decimal('0.10') }));
    expect(paidCents(payments)).toBe(100);
    expect(paidCents([{ amount: '0.10' }, { amount: '0.20' }])).toBe(30);
  });

  it('counts SUCCEEDED refunds as refunded, and SUCCEEDED + PENDING as committed', () => {
    const refunds = [refund('19.99', 'SUCCEEDED'), refund('0.01', 'SUCCEEDED'), refund('5.00', 'PENDING'), refund('7.00', 'FAILED')];
    expect(refundedCents(refunds)).toBe(2000);
    expect(committedRefundCents(refunds)).toBe(2500);
  });

  it('decides refund status on cents: one cent short is a partial refund', () => {
    expect(refundStatusFor(15000, 15000)).toBe('REFUNDED');
    expect(refundStatusFor(15000, 14999)).toBe('PARTIALLY_REFUNDED');
    expect(refundStatusFor(30, paidCents([{ amount: '0.10' }, { amount: '0.20' }]))).toBe('REFUNDED');
  });
});
