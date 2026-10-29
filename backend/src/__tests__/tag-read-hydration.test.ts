import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID,
  ORG_B_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  ESTIMATE_FIXTURE,
  ESTIMATE_SENT_FIXTURE,
  INVOICE_FIXTURE,
  INVOICE_SENT_FIXTURE,
} from './helpers';

// SRVW-103 - tag read-hydration on customers, estimates and invoices. The polymorphic
// TagAssignment has no Prisma back-relation to these three models, so hydration is a
// post-query call to lib/tags.ts (the only place tenantWhere(req) is spread for tags).

const mockPrisma = prisma as unknown as {
  customer: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
  lead: { count: ReturnType<typeof vi.fn> };
  task: { count: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { findFirst: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};

const RECURRING = { id: 'a0000000-0000-0000-0000-0000000000aa', name: 'Recurring billing', color: '#2F7D5D' };
const VIP = { id: 'a0000000-0000-0000-0000-0000000000bb', name: 'VIP', color: '#EF4444' };

const SECOND_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000002';
const SECOND_ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000011';
const SECOND_INVOICE_ID = '00000000-0000-0000-0000-000000000911';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
});

// ─── Customer read mocks ─────────────────────────────

function mockCustomerSummaryQueries() {
  mockPrisma.$queryRaw
    .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
    .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
    .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);
}

function mockCustomerDetail(customer: Record<string, unknown> = CUSTOMER_FIXTURE) {
  mockPrisma.customer.findUnique.mockResolvedValue(customer);
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.lead.count.mockResolvedValue(0);
  mockPrisma.task.count.mockResolvedValue(0);
  mockCustomerSummaryQueries();
}

function mockCustomerList(rows: Array<Record<string, unknown>>) {
  mockPrisma.customer.findMany.mockResolvedValue(rows);
  mockPrisma.customer.count.mockResolvedValue(rows.length);
}

// ─── Estimate read mocks ─────────────────────────────

function mockEstimateList(rows: Array<Record<string, unknown>>) {
  mockPrisma.estimate.findMany.mockResolvedValue(rows);
  mockPrisma.estimate.count.mockResolvedValue(rows.length);
  mockPrisma.estimate.groupBy.mockResolvedValue([]);
  mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: 0 } });
}

// ─── Invoice read mocks ──────────────────────────────

function mockInvoiceList(rows: Array<Record<string, unknown>>) {
  mockPrisma.invoice.findMany.mockResolvedValue(rows);
  mockPrisma.invoice.count.mockResolvedValue(rows.length);
  mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
  mockPrisma.job.count.mockResolvedValue(0);
}

// ═══════════════════════════════════════════════════════
// Customers
// ═══════════════════════════════════════════════════════

describe('SRVW-103 customer tag hydration', () => {
  it("GET /api/customers/:id returns the customer's tags", async () => {
    mockAuthAs('admin');
    mockCustomerDetail();
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: CUSTOMER_FIXTURE.id, tag: RECURRING },
    ]);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customer.tags).toEqual([RECURRING]);
  });

  it('GET /api/customers/:id returns tags: [] (never undefined) when the customer has none', async () => {
    mockAuthAs('admin');
    mockCustomerDetail();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customer.tags).toBeDefined();
    expect(res.body.customer.tags).toEqual([]);
  });

  it('GET /api/customers hydrates every row with ONE batched tagAssignment.findMany', async () => {
    mockAuthAs('admin');
    mockCustomerList([
      { ...CUSTOMER_FIXTURE },
      { ...CUSTOMER_FIXTURE, id: SECOND_CUSTOMER_ID, first_name: 'Jane' },
    ]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: CUSTOMER_FIXTURE.id, tag: RECURRING },
    ]);

    const res = await request(app).get('/api/customers').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
    expect(res.body.customers[0].tags).toEqual([RECURRING]);
    expect(res.body.customers[1].tags).toEqual([]);
    expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tagAssignment.findMany.mock.calls[0][0].where.entity_id.in)
      .toEqual([CUSTOMER_FIXTURE.id, SECOND_CUSTOMER_ID]);
  });
});

// ═══════════════════════════════════════════════════════
// Estimates
// ═══════════════════════════════════════════════════════

describe('SRVW-103 estimate tag hydration', () => {
  it("GET /api/estimates/:id returns the estimate's tags", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: ESTIMATE_FIXTURE.id, tag: RECURRING },
      { entity_id: ESTIMATE_FIXTURE.id, tag: VIP },
    ]);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.tags).toEqual([RECURRING, VIP]);
    // The photo-url / cost-strip / walkthrough presenters still run around the spread.
    expect(res.body.estimate.id).toBe(ESTIMATE_FIXTURE.id);
    expect(res.body.estimate.line_items).toHaveLength(2);
  });

  it('GET /api/estimates hydrates every row with ONE batched tagAssignment.findMany', async () => {
    mockAuthAs('admin');
    mockEstimateList([
      { ...ESTIMATE_FIXTURE },
      { ...ESTIMATE_FIXTURE, id: SECOND_ESTIMATE_ID, estimate_number: 'E00011' },
    ]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: SECOND_ESTIMATE_ID, tag: VIP },
    ]);

    const res = await request(app).get('/api/estimates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimates).toHaveLength(2);
    expect(res.body.estimates[0].tags).toEqual([]);
    expect(res.body.estimates[1].tags).toEqual([VIP]);
    expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════
// Invoices
// ═══════════════════════════════════════════════════════

describe('SRVW-103 invoice tag hydration', () => {
  it('GET /api/invoices/:id returns the invoice tags alongside needs_resend', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: INVOICE_FIXTURE.id, tag: RECURRING },
    ]);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.tags).toEqual([RECURRING]);
    // The tags spread must not displace the derived needs_resend field.
    expect(res.body.invoice.needs_resend).toBe(false);
  });

  it('GET /api/invoices hydrates every row with ONE batched tagAssignment.findMany', async () => {
    mockAuthAs('admin');
    mockInvoiceList([
      { ...INVOICE_FIXTURE },
      { ...INVOICE_FIXTURE, id: SECOND_INVOICE_ID, invoice_number: 'I00011' },
    ]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: INVOICE_FIXTURE.id, tag: RECURRING },
    ]);

    const res = await request(app).get('/api/invoices').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(2);
    expect(res.body.invoices[0].tags).toEqual([RECURRING]);
    expect(res.body.invoices[1].tags).toEqual([]);
    expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════
// Tenancy
// ═══════════════════════════════════════════════════════

describe('SRVW-103 tag hydration is tenant-scoped', () => {
  // lib/tags.ts spreads tenantWhere(req) inside the ONLY query it issues, so an org-B
  // assignment can never be selected onto an org-A read. canAccessRow short-circuits to
  // true for an unconditional (ADMIN) reader, so no extra row-scope mocking is needed.
  const cases: Array<{ label: string; entityType: string; url: string; arrange: () => void }> = [
    {
      label: 'customer',
      entityType: 'CUSTOMER',
      url: `/api/customers/${CUSTOMER_FIXTURE.id}`,
      arrange: () => mockCustomerDetail(),
    },
    {
      label: 'estimate',
      entityType: 'ESTIMATE',
      url: `/api/estimates/${ESTIMATE_FIXTURE.id}`,
      arrange: () => { mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE); },
    },
    {
      label: 'invoice',
      entityType: 'INVOICE',
      url: `/api/invoices/${INVOICE_FIXTURE.id}`,
      arrange: () => { mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE); },
    },
  ];

  for (const c of cases) {
    it(`scopes the ${c.label} tag read to the caller's organization`, async () => {
      mockAuthAs('orgB_admin');
      c.arrange();

      const orgBRes = await request(app).get(c.url).set(authHeader('orgB_admin'));

      expect(orgBRes.status).toBe(200);
      expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_B_ID, entity_type: c.entityType }),
        }),
      );

      vi.clearAllMocks();
      mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
      mockAuthAs('admin');
      c.arrange();

      const orgARes = await request(app).get(c.url).set(authHeader('admin'));

      expect(orgARes.status).toBe(200);
      expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ALPHA_ORG_ID, entity_type: c.entityType }),
        }),
      );
    });
  }
});

// ═══════════════════════════════════════════════════════
// Public routes (guard-rail lock)
// ═══════════════════════════════════════════════════════

describe('SRVW-103 public reads never hydrate tags', () => {
  // HONEST NOTE: both of these PASS on origin/staging. They are locks against the named
  // public-route 500 regression (tenantWhere dereferences req.user!, which a token-authed
  // request does not have), not regression tests for a live defect.

  it('GET /api/estimates/:id/public returns 200 with no tags field and issues no tag query', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      organization_id: ALPHA_ORG_ID,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.estimate.tags).toBeUndefined();
    expect(mockPrisma.tagAssignment.findMany).not.toHaveBeenCalled();
  });

  it('GET /api/invoices/:id/public returns 200 with no tags field and issues no tag query', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      ...INVOICE_SENT_FIXTURE,
      organization_id: ALPHA_ORG_ID,
      line_items: [],
      customer: { first_name: 'John', last_name: 'Doe', company_name: null },
      job: {
        job_number: 'J00001',
        estimate: null,
        customer: { first_name: 'John', last_name: 'Doe', company_name: null },
        service_location: { city: 'Austin', state: 'TX', zip: '78701' },
      },
      payments: [],
    });
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=${INVOICE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.tags).toBeUndefined();
    expect(mockPrisma.tagAssignment.findMany).not.toHaveBeenCalled();
  });
});
