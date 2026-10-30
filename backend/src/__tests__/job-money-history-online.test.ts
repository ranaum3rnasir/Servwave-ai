/**
 * Roles & Permissions Overhaul, PRD 6 / S06.7 - money that arrives online lands on the job's own
 * timeline too.
 *
 * A card payment the processor captured, and a bank payment that cleared, are booked by the payment
 * reconciler's apply step with nobody signed in. Each writes a JOB timeline entry with the amount
 * and method, exactly as a payment taken at the desk does. A standalone invoice writes no job entry,
 * a bank payment that has not cleared is not money yet, and money the invoice could not take is
 * not recorded as collected.
 *
 * Harness: the apply step is called with a hand-made transaction client. The ledger's own money
 * rules (settlePaymentInTx) have their database-backed suites; here it is replaced by the verdict
 * it would reach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/payment-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/payment-ledger')>()),
  settlePaymentInTx: vi.fn(),
}));

import { applyActions } from '../services/payment-reconciler/apply';
import { settlePaymentInTx } from '../lib/payment-ledger';
import type { LedgerAction } from '../services/payment-reconciler/decide';
import { ALPHA_ORG_ID } from './helpers';

const INVOICE_ID = '00000000-0000-0000-0000-000000000901';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const PAYMENT_ID = 'cc000000-0000-0000-0000-000000000002';
const CTX = { organizationId: ALPHA_ORG_ID, eventId: 'evt_1' };

let timeline: any[] = [];

function transaction(invoice: { job_id: string | null }, extra: Record<string, any> = {}) {
  timeline = [];
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    invoice: {
      findFirstOrThrow: vi.fn().mockResolvedValue({
        invoice_number: 'I00001', job_id: invoice.job_id, amount_due: 1000, status: 'SENT', estimate: null, refunds: [], payments: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ invoice_number: 'I00001' }),
    },
    payment: {
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: PAYMENT_ID, ...data })),
      findFirstOrThrow: vi.fn().mockResolvedValue({
        amount: 400, method: 'ACH', invoice_id: INVOICE_ID, stripe_payment_intent_id: 'pi_1',
        invoice: { invoice_number: 'I00001', job_id: invoice.job_id },
      }),
      updateMany: vi.fn(),
    },
    refund: { findMany: vi.fn().mockResolvedValue([]) },
    // Slice 37b: a booked payment looks for an open "charge with no payment" record to close.
    unappliedCapture: { findMany: vi.fn().mockResolvedValue([]) },
    timelineEvent: { create: vi.fn().mockImplementation(({ data }: any) => { timeline.push(data); return Promise.resolve(data); }) },
    ...extra,
  } as any;
}

const jobEntries = () => timeline.filter((e) => e.entity_type === 'JOB');

function cardPayment(over: Partial<Extract<LedgerAction, { type: 'record_payment' }>> = {}): LedgerAction {
  return {
    type: 'record_payment', organizationId: ALPHA_ORG_ID, invoiceId: INVOICE_ID, kind: 'STANDARD', method: 'CARD', state: 'SUCCEEDED',
    amountCents: 40000, tipCents: 0, paidAt: null, paysInFull: false, processorPaymentIntentId: 'pi_1', processorChargeId: 'ch_1',
    checkoutSessionId: 'cs_1', connectedAccountId: null, wallet: null, cardBrand: null, cardLast4: null, bankName: null, bankLast4: null,
    ...over,
  } as LedgerAction;
}

const clearing = (to: 'SUCCEEDED' | 'FAILED'): LedgerAction =>
  ({ type: 'settle_payment', paymentId: PAYMENT_ID, invoiceId: INVOICE_ID, to } as LedgerAction);

beforeEach(() => {
  vi.mocked(settlePaymentInTx).mockReset();
});

describe('an online card payment on the job', () => {
  it('writes ONE job entry with the amount, the method and no signed-in user', async () => {
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [cardPayment()], CTX);

    expect(jobEntries()).toHaveLength(1);
    expect(jobEntries()[0]).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      entity_id: JOB_ID,
      event_type: 'JOB_PAYMENT_RECORDED',
      created_by: null,
      metadata: { invoice_id: INVOICE_ID, invoice_number: 'I00001', payment_id: PAYMENT_ID, amount: 400, method: 'CARD' },
    });
  });

  it('on a standalone invoice writes no job entry', async () => {
    const tx = transaction({ job_id: null });
    await applyActions(tx, [cardPayment()], CTX);
    expect(jobEntries()).toEqual([]);
  });

  it('a bank payment still clearing is not money yet: no job entry', async () => {
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [cardPayment({ method: 'ACH', state: 'PROCESSING' })], CTX);
    expect(jobEntries()).toEqual([]);
  });
});

describe('a bank payment that clears on the job', () => {
  it('writes ONE job entry with the amount and the method', async () => {
    vi.mocked(settlePaymentInTx).mockResolvedValue({ changed: true, becamePaid: false, invoice: { id: INVOICE_ID, invoice_number: 'I00001' }, unapplied: null });
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [clearing('SUCCEEDED')], CTX);

    expect(jobEntries()).toHaveLength(1);
    expect(jobEntries()[0]).toMatchObject({
      entity_id: JOB_ID, event_type: 'JOB_PAYMENT_RECORDED', created_by: null,
      metadata: { invoice_id: INVOICE_ID, payment_id: PAYMENT_ID, amount: 400, method: 'ACH' },
    });
  });

  it('records only what the invoice took when the payment was more than the balance', async () => {
    vi.mocked(settlePaymentInTx).mockResolvedValue({
      changed: true, becamePaid: true, invoice: { id: INVOICE_ID, invoice_number: 'I00001' },
      unapplied: { record: { amountCents: 15000 } } as any,
    });
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [clearing('SUCCEEDED')], CTX);

    expect(jobEntries()[0].metadata.amount).toBe(250);
  });

  it('money the invoice could not take is not recorded as collected', async () => {
    vi.mocked(settlePaymentInTx).mockResolvedValue({ changed: true, becamePaid: false, invoice: null, unapplied: { record: { amountCents: 40000 } } as any });
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [clearing('SUCCEEDED')], CTX);
    expect(jobEntries()).toEqual([]);
  });

  it('a bank payment that failed collected nothing: no job entry', async () => {
    vi.mocked(settlePaymentInTx).mockResolvedValue({ changed: true, becamePaid: false, invoice: null, unapplied: null });
    const tx = transaction({ job_id: JOB_ID });
    await applyActions(tx, [clearing('FAILED')], CTX);
    expect(jobEntries()).toEqual([]);
  });
});
