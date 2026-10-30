import { describe, it, expect } from 'vitest';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '@/lib/reports/payments-report-data';

/**
 * Payments go-live slice 28: the payments report names a hand-recorded transfer "Bank transfer"
 * and the online debit "Bank (ACH)" (ACH means the online debit only), and a voided or partly
 * refunded payment says so rather than reading "Failed" / "Refunded". Mirrors the backend's
 * services/payments-report.ts, which the rows come from.
 */
describe('payments report labels', () => {
  it('separates the hand-recorded transfer from the online bank debit', () => {
    expect(PAYMENT_METHODS).toContain('Bank transfer');
    expect(PAYMENT_METHODS).toContain('Bank (ACH)');
    expect(PAYMENT_METHODS.filter((m) => /ACH/.test(m))).toEqual(['Bank (ACH)']);
  });

  it('has a status for a voided payment and a partly refunded one', () => {
    expect(PAYMENT_STATUSES).toEqual(['Succeeded', 'Pending', 'Failed', 'Voided', 'Charged back', 'Partly refunded', 'Refunded']);
  });
});
