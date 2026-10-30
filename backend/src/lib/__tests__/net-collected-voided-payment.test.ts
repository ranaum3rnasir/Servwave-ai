/* =============================================================================
   Payments go-live slice 09 - net collected after a payment is voided.

   A payment voided as a chargeback takes its whole amount off the ledger, but a refund given on it
   earlier already came out of that same money. Counting that refund again drove net collected
   below zero (a $500 payment refunded $150, then $350 lost to a dispute, read -$150) although the
   contractor kept exactly nothing. A refund on a voided payment no longer reduces net collected;
   refunds on payments that stand still do.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { netCollectedCents } from '../payment-ledger';

const payment = (id: string, amount: number, voided = false) => ({
  id, amount, state: 'SUCCEEDED', voided_at: voided ? new Date('2026-10-07T00:00:00Z') : null, reference_number: null,
});
const refund = (paymentId: string | null, amount: number) => ({ payment_id: paymentId, amount, state: 'SUCCEEDED' as const });

describe('net collected', () => {
  it('a refunded payment later voided as a chargeback leaves nothing collected, not minus the refund', () => {
    expect(netCollectedCents([payment('p1', 500, true)], [refund('p1', 150)])).toBe(0);
  });

  it('refunds on payments that stand still count, beside a voided one', () => {
    expect(netCollectedCents(
      [payment('p1', 500, true), payment('p2', 300)],
      [refund('p1', 150), refund('p2', 100)],
    )).toBe(20000);
  });
});
