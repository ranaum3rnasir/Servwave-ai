/**
 * Payments go-live slice 28 follow-up: the JOB history line for money that moved never prints a raw
 * method code. An online payment (the ones the payment reconciler records) reads "received via
 * ServWave Payments", the same words as the invoice timeline; a payment taken by hand reads its
 * method the way the payments report names it. The metadata keeps the code for the readers that
 * branch on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { recordJobMoneyMovement } from '../lib/job-change-history';

const ACTOR = { orgId: 'org-1', userId: null };
const INVOICE = { id: 'inv-1', invoice_number: 'INV-100' };

async function line(
  kind: Parameters<typeof recordJobMoneyMovement>[4],
  movement: Parameters<typeof recordJobMoneyMovement>[5],
) {
  const create = vi.fn().mockResolvedValue({});
  await recordJobMoneyMovement({ timelineEvent: { create } } as never, ACTOR, 'job-1', INVOICE, kind, movement);
  return create.mock.calls[0][0].data as { description: string; metadata: Record<string, unknown> };
}

describe('job money history wording', () => {
  it('an online card payment reads "received via ServWave Payments"', async () => {
    const d = await line('PAYMENT_RECORDED', { amount: 500, method: 'CARD', online: true });
    expect(d.description).toBe('Invoice INV-100 payment recorded via ServWave Payments');
    expect(d.metadata.method).toBe('CARD');
  });

  it('an online bank payment reads the same, never ACH', async () => {
    const d = await line('PAYMENT_RECORDED', { amount: 500, method: 'ACH', online: true });
    expect(d.description).toBe('Invoice INV-100 payment recorded via ServWave Payments');
    expect(d.description).not.toMatch(/ACH/);
  });

  it.each([
    ['CHECK', 'Check'],
    ['CASH', 'Cash'],
    ['BANK_TRANSFER', 'Bank transfer'],
    ['EXTERNAL_CARD', 'Card (outside ServWave)'],
    ['CASH_APP', 'Cash App'],
  ])('a hand payment by %s reads "%s"', async (method, label) => {
    const d = await line('PAYMENT_RECORDED', { amount: 400, method });
    expect(d.description).toBe(`Invoice INV-100 payment recorded via ${label}`);
  });

  it('a refund and a void name the method in words too', async () => {
    expect((await line('REFUND_ISSUED', { amount: 50, method: 'BANK_TRANSFER' })).description)
      .toBe('Invoice INV-100 refund issued via Bank transfer');
    expect((await line('PAYMENT_VOIDED', { amount: 50, method: 'EXTERNAL_CARD' })).description)
      .toBe('Invoice INV-100 payment voided via Card (outside ServWave)');
  });

  it('a deposit applied has no method wording, and a null method has none', async () => {
    expect((await line('DEPOSIT_APPLIED', { amount: 100, method: 'DEPOSIT_CREDIT' })).description)
      .toBe('Invoice INV-100 deposit applied');
    expect((await line('REFUND_ISSUED', { amount: 5, method: null })).description)
      .toBe('Invoice INV-100 refund issued');
  });
});
