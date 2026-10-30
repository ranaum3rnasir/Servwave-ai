/**
 * Payments go-live slice 27 - what the public estimate page is told about its deposit.
 *
 * The page renders from one answer: the deposit invoice's pay state (the same one the deposit link
 * renders from), the hold reason when the deposit is held, and the resolved deposit policy. So a
 * held deposit shows WHY, a pay-later estimate shows an open deposit beside an approved estimate,
 * and a WON estimate whose bank deposit failed shows the deposit open again and payable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ESTIMATE_SENT_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

const URL = `/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`;

const estimateRow = (over: Record<string, unknown> = {}) => ({
  ...ESTIMATE_SENT_FIXTURE,
  organization_id: 'org-test-1',
  send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK'] },
  invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }],
  lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
  ...over,
});

/** The deposit as the hold test reads it: the invoice with its estimate beside it. */
const depositRow = (invoice: Record<string, unknown> = {}, estimate: Record<string, unknown> = {}) => ({
  status: 'SENT',
  kind: 'DEPOSIT',
  total_amount: 500,
  amount_due: 500,
  payments: [],
  estimate: {
    status: 'SENT',
    modified_after_send: false,
    deposit_type: 'PERCENTAGE',
    deposit_value: 50,
    total_amount: 1000,
    ...estimate,
  },
  ...invoice,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: 'org-test-1', name: 'Org', accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: true,
    deposit_policy: 'REQUIRED_BEFORE_APPROVAL', deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50,
  });
});

describe('GET /api/estimates/:id/public - the deposit state', () => {
  it('an open deposit is payable, with the amount that can be paid now', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow());
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow());

    const res = await request(app).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.deposit).toEqual({ pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 });
  });

  it('a deposit held while the estimate is being updated says why', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow());
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({}, { status: 'DRAFT' }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toMatchObject({ pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 0 });
  });

  it('a deposit whose figure went stale says so', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow());
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({}, { modified_after_send: true, total_amount: 1600 }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toMatchObject({ pay_state: 'CHANGED', hold_reason: 'SUPERSEDED' });
  });

  it('a bank deposit still clearing is processing, with nothing left to pay now', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ status: 'WON' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({ payments: [{ amount: 500 }] }, { status: 'WON' }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toEqual({ pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 });
  });

  it('a WON estimate whose bank debit failed shows the deposit open and payable again', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ status: 'WON' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({}, { status: 'WON' }));

    const res = await request(app).get(URL);

    expect(res.body.estimate.status).toBe('WON');
    expect(res.body.deposit).toMatchObject({ pay_state: 'PAYABLE', payable_now: 500 });
  });

  it('a paid deposit is PAID', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ status: 'WON' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({ status: 'PAID', amount_due: 0 }, { status: 'WON' }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toMatchObject({ pay_state: 'PAID', payable_now: 0 });
  });

  it('a part-paid deposit on a declined estimate is closed, not payable', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ status: 'DECLINED' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({ status: 'PARTIAL', amount_due: 300 }, { status: 'DECLINED' }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toMatchObject({ pay_state: 'VOIDED', payable_now: 0 });
  });

  it('an unpaid deposit on an expired estimate is closed, not payable', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ status: 'EXPIRED' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow({ status: 'SENT', amount_due: 500 }, { status: 'EXPIRED' }));

    const res = await request(app).get(URL);

    expect(res.body.deposit).toMatchObject({ pay_state: 'VOIDED', payable_now: 0 });
  });

  it('an estimate with no deposit invoice reports none', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ invoices: [], send_config: null }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app).get(URL);

    expect(res.body.deposit).toBeNull();
  });

  it('the deposit is looked up inside the estimate\'s own organization', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow());
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow());

    await request(app).get(URL);

    const where = mockPrisma.invoice.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ estimate_id: ESTIMATE_SENT_FIXTURE.id, organization_id: 'org-test-1', kind: 'DEPOSIT' });
  });

  it('reports the resolved deposit policy: an estimate override beats the org default', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow({ deposit_policy: 'PAY_LATER' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(depositRow());

    const res = await request(app).get(URL);

    expect(res.body.payment_options.deposit_policy).toBe('PAY_LATER');
  });
});
