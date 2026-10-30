/**
 * Payments go-live slice 27 (slice 21 note) - recording a deposit by hand against the pay-later rules.
 *
 * Under pay later the estimate is WON at signing and its deposit stays open. Staff collecting that
 * deposit in cash must be able to record it on the WON estimate, and it must not re-approve it: the
 * approval date, the lead and the "approved" events are the signing's, not the payment's. A WON
 * estimate with no open deposit still refuses a payment. An unsigned SENT estimate paid in full by
 * hand still wins (a staff-witnessed payment is the approval, as under "required").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ESTIMATE_FIXTURE, TEST_USERS, mockAuthAs, authHeader } from './helpers';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));
vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { emit } from '../services/notifications/notificationService';

const mockPrisma = prisma as any;
const EST_ID = ESTIMATE_FIXTURE.id;

function arm(status: string, deposit: { status: string; amount_due: number; payments?: { amount: number }[] } | null) {
  const writes = { estimateUpdates: [] as any[], leadTouched: false, timeline: [] as string[] };
  mockAuthAs('admin');
  mockPrisma.estimate.findUnique.mockResolvedValue({
    id: EST_ID, status, estimate_number: ESTIMATE_FIXTURE.estimate_number, total_amount: 1000, public_token: 'tok',
    valid_until: null, lead_id: ESTIMATE_FIXTURE.lead_id, deposit_type: 'PERCENTAGE', deposit_value: 50,
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa' }, commission_owner_id: TEST_USERS.sales.id, status: 'ESTIMATED' },
    send_config: { id: 'sc-1' },
  });
  mockPrisma.estimate.findFirst.mockResolvedValue({ id: EST_ID });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      invoice: {
        findFirst: vi.fn().mockResolvedValue(deposit && { id: 'dep-1', total_amount: 500, invoice_number: 'I00050', payments: [], ...deposit }),
        create: vi.fn().mockResolvedValue({ id: 'dep-new', status: 'SENT', amount_due: 500, total_amount: 500, invoice_number: 'I00051' }),
        update: vi.fn().mockResolvedValue({}),
      },
      payment: { create: vi.fn().mockResolvedValue({}) },
      estimate: {
        update: vi.fn().mockImplementation((a: any) => { writes.estimateUpdates.push(a.data); return Promise.resolve({}); }),
        findUnique: vi.fn().mockResolvedValue({ id: EST_ID, estimate_number: ESTIMATE_FIXTURE.estimate_number, status: 'WON', lead_id: ESTIMATE_FIXTURE.lead_id, lead: { commission_owner_id: null } }),
      },
      estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
      lead: { updateMany: vi.fn().mockImplementation(() => { writes.leadTouched = true; return Promise.resolve({ count: 1 }); }), findUnique: vi.fn().mockResolvedValue({ status: 'ESTIMATED' }), update: vi.fn().mockImplementation(() => { writes.leadTouched = true; return Promise.resolve({}); }) },
      leadStatusHistory: { create: vi.fn().mockImplementation(() => { writes.leadTouched = true; return Promise.resolve({}); }) },
      timelineEvent: { create: vi.fn().mockImplementation((a: any) => { writes.timeline.push(a.data.event_type); return Promise.resolve({}); }) },
      estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(0),
    }),
  );
  return writes;
}

const record = () => request(app).post(`/api/estimates/${EST_ID}/record-payment`).set(authHeader('admin')).send({ amount: 500, payment_method: 'CASH' });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0 });
});

describe('record-payment and the pay-later rules', () => {
  it('takes the deposit on a WON estimate (pay later) without approving it again', async () => {
    const writes = arm('WON', { status: 'SENT', amount_due: 500 });

    const res = await record();

    expect(res.status).toBe(200);
    expect(writes.estimateUpdates.some((d) => 'status' in d || 'approved_at' in d)).toBe(false);
    expect(writes.leadTouched).toBe(false);
    expect(writes.timeline).toContain('DEPOSIT_PAID');
    expect(writes.timeline).not.toContain('APPROVED');
    const approved = vi.mocked(dispatchAutomationEvent).mock.calls.filter((c) => (c[0] as any).type === 'ESTIMATE_APPROVED');
    expect(approved).toHaveLength(0);
    expect(vi.mocked(emit).mock.calls.some((c) => (c[0] as any).verb === 'estimate.approved')).toBe(false);
    // The deposit invoice itself still reaches PAID and says so.
    expect(vi.mocked(dispatchAutomationEvent).mock.calls.filter((c) => (c[0] as any).type === 'INVOICE_PAID')).toHaveLength(1);
  });

  it('still refuses a payment on a WON estimate that has no open deposit', async () => {
    arm('WON', null);

    const res = await record();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Estimate is already approved/paid');
  });

  it('still refuses a payment on a WON estimate whose deposit is already paid', async () => {
    arm('WON', { status: 'PAID', amount_due: 0 });

    const res = await record();

    expect(res.status).toBe(409);
  });

  it('an unsigned SENT estimate paid in full by hand is still won (the staff-witnessed payment is the approval)', async () => {
    const writes = arm('SENT', { status: 'SENT', amount_due: 500 });

    const res = await record();

    expect(res.status).toBe(200);
    expect(writes.estimateUpdates.some((d) => d.status === 'WON')).toBe(true);
    expect(writes.timeline).toContain('DEPOSIT_PAID');
    expect(writes.timeline).toContain('APPROVED');
  });

  // Conductor ruling 1: the door works from payable-now, so bank money still clearing is not paid twice.
  it('refuses a cash payment when a bank payment for the full deposit is still processing', async () => {
    const writes = arm('WON', { status: 'SENT', amount_due: 500, payments: [{ amount: 500 }] });

    const res = await record();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bank payment of \$500\.00 is still processing/i);
    expect(writes.timeline).not.toContain('DEPOSIT_PAID');
  });

  it('with part of the deposit processing, accepts only the rest', async () => {
    arm('WON', { status: 'SENT', amount_due: 500, payments: [{ amount: 200 }] });

    const tooMuch = await record();
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/bank payment of \$200\.00 is still processing/i);

    arm('WON', { status: 'SENT', amount_due: 500, payments: [{ amount: 200 }] });
    const rest = await request(app).post(`/api/estimates/${EST_ID}/record-payment`).set(authHeader('admin')).send({ amount: 300, payment_method: 'CASH' });
    expect(rest.status).toBe(200);
  });
});
