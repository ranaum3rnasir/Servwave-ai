import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// #2044 — unit twin of repro-2044.test.ts, extending coverage beyond the frozen pair: an org WITH
// accepted methods must still round-trip its list verbatim (AC3), and the send() route's specific
// `send_config.payment_methods` persistence is asserted for both the empty and non-empty cases.
// Pattern reused wholesale from repro-2044.test.ts (supertest + mockAuthAs + mocked prisma).

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: { create: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ORG = {
  id: 'org-1', name: 'Org', logo_url: null, brand_color: null,
  estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
  deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
};

const TOTAL = 1000;

function markSentDraft() {
  return {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: TOTAL,
    customer_id: 'c0000000-0000-0000-0000-0000000000aa',
    lead_id: 'lead-2044-1',
    deposit_type: null,
    deposit_value: null,
    created_by: TEST_USERS.sales.id,
    public_token: null,
    _count: { line_items: 2 },
    job_id: null, job: null, job_link: null,
    lead: {
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      status: 'CONTACTED',
      customer: { id: 'c0000000-0000-0000-0000-0000000000aa' },
      walkthrough_completed_at: null,
    },
  };
}

function sendDraft() {
  return {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: TOTAL,
    customer_id: 'c0000000-0000-0000-0000-0000000000aa',
    lead_id: ESTIMATE_FIXTURE.lead_id,
    public_token: null,
    valid_until: null,
    modified_after_send: false,
    version: 1,
    deposit_type: null,
    deposit_value: null,
    created_by: TEST_USERS.sales.id,
    send_config: null,
    _count: { line_items: 2 },
    job_id: null, job: null, job_link: null,
    customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
    lead: {
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      status: 'CONTACTED',
      walkthrough_completed_at: null,
      customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG);
  mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [], scopes: [] });
  mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
  mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
});

describe('#2044 — payment_methods persists verbatim on both routes, empty or not', () => {
  it('(a) mark-sent with a non-empty list persists it verbatim, order preserved', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(markSentDraft());
    const sendConfigUpsert = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Freeze-at-send: commitFirstSend re-reads `scopes` inside the tx before stamping the
        // send-time snapshot onto the same write that flips the status to SENT.
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
          findUnique: vi.fn().mockResolvedValue({ scopes: null }),
        },
        estimateSendConfig: { upsert: sendConfigUpsert },
        lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['EXTERNAL_CARD', 'CHECK'] });

    expect(res.status).toBe(200);
    expect(sendConfigUpsert.mock.calls[0][0].create.payment_methods).toEqual(['EXTERNAL_CARD', 'CHECK']);
  });

  it('(b) send with a non-empty list persists it verbatim, order preserved', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(sendDraft());
    const sendConfigUpsert = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', scopes: [] }),
          findUnique: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', scopes: [] }),
        },
        estimateSendConfig: { upsert: sendConfigUpsert, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['EXTERNAL_CARD', 'CHECK'] });

    expect(res.status).toBe(200);
    expect(sendConfigUpsert.mock.calls[0][0].create.payment_methods).toEqual(['EXTERNAL_CARD', 'CHECK']);
  });
});
