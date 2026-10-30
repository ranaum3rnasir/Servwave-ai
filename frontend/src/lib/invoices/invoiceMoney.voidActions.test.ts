/**
 * Payments go-live slice 28b: Void is offered on a PAID invoice that holds no money taken (paid
 * only by a drawn deposit credit), so the server door and the page agree. Money taken (a live
 * SUCCEEDED or PROCESSING payment that is not the deposit-credit row) still blocks it.
 */
import { describe, it, expect } from 'vitest';
import { buildAbility } from '@/lib/ability';
import { getAvailableActions, type InvoiceDetail, type Payment } from './invoiceMoney';

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);

const payment = (over: Partial<Payment>): Payment => ({
  id: 'p', amount: 100, method: 'CASH', paid_at: '2026-10-01T00:00:00Z', collected_by: null,
  paid_through_processor: false, reference_number: null, notes: null, created_at: '2026-10-01T00:00:00Z',
  collector: null, state: 'SUCCEEDED', ...over,
});
const invoice = (status: string, payments: Payment[]) => ({ id: 'i', status, payments, sent_at: '2026-10-01T00:00:00Z' }) as unknown as InvoiceDetail;
const canVoid = (status: string, payments: Payment[]) => getAvailableActions(invoice(status, payments), ability).canVoid;

describe('canVoid on a PAID invoice', () => {
  it('is offered when only a deposit credit paid it', () => {
    expect(canVoid('PAID', [payment({ reference_number: 'DEPOSIT-CREDIT', method: 'OTHER' })])).toBe(true);
  });

  it('is offered when it holds no payment rows at all', () => {
    expect(canVoid('PAID', [])).toBe(true);
  });

  it('is not offered when money was taken on it', () => {
    expect(canVoid('PAID', [payment({ reference_number: 'DEPOSIT-CREDIT' }), payment({ id: 'q', method: 'CASH' })])).toBe(false);
    expect(canVoid('PAID', [payment({ method: 'ACH', state: 'PROCESSING' })])).toBe(false);
  });

  it('ignores a voided or failed payment', () => {
    expect(canVoid('PAID', [payment({ voided_at: '2026-10-02T00:00:00Z' }), payment({ id: 'r', state: 'FAILED' })])).toBe(true);
  });

  it('stays offered on SENT and PARTIAL, and not on a refunded or voided invoice', () => {
    expect(canVoid('SENT', [])).toBe(true);
    expect(canVoid('PARTIAL', [payment({})])).toBe(true);
    expect(canVoid('PARTIALLY_REFUNDED', [])).toBe(false);
    expect(canVoid('VOIDED', [])).toBe(false);
  });
});
