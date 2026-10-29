import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// ─── Typed mock (same idiom as estimates.test.ts's send suite) ─────
const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: { create: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  lead: { update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// SERV10X-61 §5.6 / R6 - send() must (a) refuse an estimate with no line items, and (b) work on a
// customer-anchored (lead-less) estimate, reaching the customer via the estimate's own direct
// customer relation + denormalized customer_id instead of lead.customer.

const LEAD_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const LEADLESS_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000bb';

// A working DRAFT first-send fixture: exactly the fields send()'s `existing` select reads.
const SEND_FIXTURE = {
  id: ESTIMATE_FIXTURE.id,
  status: 'DRAFT',
  estimate_number: ESTIMATE_FIXTURE.estimate_number,
  total_amount: 1062.5,
  lead_id: ESTIMATE_FIXTURE.lead_id,
  public_token: null,
  valid_until: null,
  modified_after_send: false,
  version: 1,
  deposit_type: null,
  deposit_value: null,
  created_by: TEST_USERS.sales.id,
  customer_id: LEAD_CUSTOMER_ID,
  customer: { id: LEAD_CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
  _count: { line_items: 2 },
  lead: {
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    status: 'CONTACTED',
    walkthrough_completed_at: null,
    customer: { id: LEAD_CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
  },
  send_config: null,
};

const ORG_FIXTURE = {
  id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
  estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
  deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
};

describe('POST /api/estimates/:id/send - SERV10X-61 gate + lead-less send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.appSetting.findUnique.mockResolvedValue(null); // no walkthrough / default 50%
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
    mockPrisma.estimate.update.mockResolvedValue({});
    // Fire-and-forget version snapshot (post-response) - keep it inert.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
  });

  it('refuses to send an estimate with zero line items → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...SEND_FIXTURE, _count: { line_items: 0 } });

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one line item/i);
    // The gate fires before any write transaction.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends a customer-anchored (lead-less) estimate → 200, deposit invoice uses the direct customer_id, no lead transition', async () => {
    mockAuthAs('admin');
    const leadless = {
      ...SEND_FIXTURE,
      lead_id: null,
      lead: null,
      customer_id: LEADLESS_CUSTOMER_ID,
      customer: { id: LEADLESS_CUSTOMER_ID, first_name: 'A', last_name: 'B', company_name: null, email: 'x@y.com' },
      _count: { line_items: 2 },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(leadless);

    // commitFirstSend runs inside the tx; capture the proxy so we can inspect the deposit
    // invoice.create + prove no lead.update fires. The estimate.update tx result carries
    // lead_id:null so the lead auto-transition branch is skipped.
    const sentResult = { ...leadless, status: 'SENT', lead_id: null, scopes: [] };
    let txProxy: Record<string, any> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentResult), findUnique: vi.fn().mockResolvedValue(sentResult) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { update: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // The DEPOSIT invoice was created against the estimate's OWN customer_id (not lead.customer).
    const invoiceCreateData = txProxy.invoice.create.mock.calls[0][0].data;
    expect(invoiceCreateData.customer_id).toBe(LEADLESS_CUSTOMER_ID);
    expect(invoiceCreateData.kind).toBe('DEPOSIT');
    // No lead → no lead auto-transition, at either the tx or top level.
    expect(txProxy.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });
});
