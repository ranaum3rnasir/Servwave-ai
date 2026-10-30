/**
 * Payments go-live slice 27 - the approval route honours the RESOLVED deposit policy.
 *
 * Under "required before approval" a deposit estimate is not won at signing: it waits for the
 * deposit payment. Under "pay later" the signature alone approves it (the estimate and its lead go
 * WON at signing), and the deposit invoice is left exactly as it was - still SENT, still payable
 * from the same link. The policy is the estimate's own override, else the org default.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured } from '../lib/stripe';
import { ESTIMATE_SENT_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoice: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  lead: { update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const TOKEN = ESTIMATE_SENT_FIXTURE.public_token;
const APPROVE_URL = `/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`;
const SIGNATURE = 'data:image/png;base64,AAA';

const OPEN_DEPOSIT = { id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, payments: [] };

function approveExisting(over: Record<string, unknown> = {}, org: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: null,
    lead: null,
    organization_id: 'org-test-1',
    total_amount: 1000,
    valid_until: new Date('2099-12-31'),
    signature_data: null,
    snapshot_terms: null,
    modified_after_send: false,
    deposit_type: 'PERCENTAGE',
    deposit_value: 50,
    deposit_policy: null,
    invoices: [OPEN_DEPOSIT],
    send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK'] },
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_test',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      ...org,
    },
    ...over,
  };
}

function mockApprove(existing: ReturnType<typeof approveExisting>) {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        invoice: { findFirst: mockPrisma.invoice.findFirst, update: mockPrisma.invoice.update },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
        lead: { update: mockPrisma.lead.update },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  mockPrisma.estimate.findFirst.mockResolvedValue(existing);
  mockPrisma.estimate.findUnique.mockResolvedValue(null);
  mockPrisma.estimate.update.mockResolvedValue({ id: ESTIMATE_ID, status: 'WON', line_items: [], invoices: [] });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
}

const estimateStatusWrites = () =>
  mockPrisma.estimate.update.mock.calls
    .map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.status)
    .filter((s) => s !== undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isStripeConfigured).mockReturnValue(true);
});

describe('POST /api/estimates/:id/approve - deposit policy', () => {
  it('pay later (estimate override): the signature alone wins the estimate and no method is needed', async () => {
    mockApprove(approveExisting({ deposit_policy: 'PAY_LATER' }));

    const res = await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBeUndefined();
    expect(estimateStatusWrites()).toEqual(['WON']);
  });

  it('pay later leaves the deposit invoice untouched: still open and payable', async () => {
    mockApprove(approveExisting({ deposit_policy: 'PAY_LATER' }));

    await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE });

    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('pay later (org default): an estimate with no override follows the org', async () => {
    mockApprove(approveExisting({}, { deposit_policy: 'PAY_LATER' }));

    const res = await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE });

    expect(res.status).toBe(200);
    expect(estimateStatusWrites()).toEqual(['WON']);
  });

  it('pay later ignores a payment method the customer sent: nothing is charged, the estimate is won', async () => {
    mockApprove(approveExisting({ deposit_policy: 'PAY_LATER' }));

    const res = await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE, payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBeUndefined();
    expect(estimateStatusWrites()).toEqual(['WON']);
  });

  it('required (estimate override beats a pay-later org default): a method is still demanded', async () => {
    mockApprove(approveExisting({ deposit_policy: 'REQUIRED_BEFORE_APPROVAL' }, { deposit_policy: 'PAY_LATER' }));

    const res = await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payment method is required');
    expect(estimateStatusWrites()).toEqual([]);
  });

  it('required (org default): a signed estimate goes PENDING, not WON, when paid by a manual method', async () => {
    mockApprove(approveExisting());

    const res = await request(app).post(APPROVE_URL).send({ signature_data: SIGNATURE, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    expect(estimateStatusWrites()).toEqual(['PENDING']);
  });
});
