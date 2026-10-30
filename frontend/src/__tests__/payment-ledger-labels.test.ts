import { describe, it, expect } from 'vitest';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';

/**
 * Payments go-live slice 04: the ledger's new states and the online bank-debit method read as
 * words a contractor understands, never as raw enum values, and never name the processor.
 */
describe('payment and refund states', () => {
  it('a payment reads Processing, Succeeded or Failed', () => {
    expect(Object.fromEntries(Object.entries(STATUS_REGISTRY.payment).map(([k, v]) => [k, v.label]))).toEqual({
      PROCESSING: 'Processing',
      SUCCEEDED: 'Succeeded',
      FAILED: 'Failed',
    });
  });

  it('a refund reads Pending, Succeeded or Failed', () => {
    expect(Object.fromEntries(Object.entries(STATUS_REGISTRY.refund).map(([k, v]) => [k, v.label]))).toEqual({
      PENDING: 'Pending',
      SUCCEEDED: 'Succeeded',
      FAILED: 'Failed',
    });
  });

  it('a failed payment or refund is painted as danger, money still in flight is not', () => {
    expect(STATUS_REGISTRY.payment.FAILED.intent).toBe('danger');
    expect(STATUS_REGISTRY.refund.FAILED.intent).toBe('danger');
    expect(STATUS_REGISTRY.payment.PROCESSING.intent).not.toBe('danger');
    expect(STATUS_REGISTRY.refund.PENDING.intent).not.toBe('danger');
  });
});

describe('the online bank-debit method', () => {
  it('is labelled "Bank (ACH)"', () => {
    expect(PAYMENT_METHOD_LABELS.ACH).toBe('Bank (ACH)');
  });

  it('is not offered where staff record or accept a payment by hand; a hand-recorded transfer stays BANK_TRANSFER', () => {
    // PAYMENT_METHOD_ORDER feeds the record-payment, refund and accepted-methods pickers. ACH only
    // ever arrives through an online checkout, so it must not be pickable there.
    expect(PAYMENT_METHOD_ORDER).not.toContain('ACH');
    expect(PAYMENT_METHOD_ORDER).toContain('BANK_TRANSFER');
  });
});
