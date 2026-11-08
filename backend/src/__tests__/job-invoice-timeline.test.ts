import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  ALPHA_ORG_ID, mockRoleGrantsWithout, } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  customer: {
    findMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  payment: {
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // Deposit-gate default: no deposit invoice.
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  // Cross-customer accretion guard default: no other customer matches.
  (prisma.customer.findMany as any).mockResolvedValue([]);
  // Setup $transaction passthrough so the callback runs with mockPrisma (tx = mockPrisma).
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
});

// ─── Test Helpers ────────────────────────────────────

/**
 * Mock a job that satisfies jobInvoiceGuardSelect for the invoice creation endpoint.
 * Mirrors the field list from job.controller.ts:3153-3175.
 */
function mockJobForInvoicing(overrides: Partial<any> = {}) {
  const defaults = {
    id: 'job-1',
    status: 'UNSCHEDULED',
    source_plan_id: null,
    job_number: 'J00001',
    customer: {
      id: CUSTOMER_FIXTURE.id,
      tax_exempt: false,
    },
    job_line_items: [
      {
        id: 'line-1',
        description: 'Service work',
        quantity: '1',
        unit_price: '600',
        is_taxable: false,
        line_total: '600',
        item_type: null,
        price_book_item_id: null,
      },
    ],
    scopes: [],
    invoices: [],
    estimate: null,
    // SERV10X-61 Task 10: createInvoiceFromJob now always reads job.linked_estimates (the
    // EstimateJobLink deposit source) - shape it here so a from-job invoice doesn't NPE.
    linked_estimates: [],
  };
  const job = { ...defaults, ...overrides };
  mockPrisma.job.findUnique.mockResolvedValue(job);
  return job;
}

// ─── Tests ────────────────────────────────────────────

describe('POST /api/jobs/:id/invoices — timeline', () => {
  it('writes an INVOICE_CREATED event on the new invoice', async () => {
    mockAuthAs('admin');
    mockJobForInvoicing({ id: 'job-1', job_number: 'J00001', source_plan_id: null });

    // Mock the invoice.create response
    mockPrisma.invoice.create.mockResolvedValue({
      id: 'inv-new',
      invoice_number: 'I00031',
      total_amount: 600,
    });

    // Mock job.update (for amount_invoiced increment)
    mockPrisma.job.update.mockResolvedValue({ id: 'job-1' });

    const res = await request(app)
      .post('/api/jobs/job-1/invoices')
      .set(authHeader('admin'))
      .send({ amount: 600, description: 'Cash collected on site' });

    expect(res.status).toBe(201);
    const events = mockPrisma.timelineEvent.create.mock.calls.map((c) => c[0].data);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: 'inv-new',
          event_type: 'INVOICE_CREATED',
        }),
      ]),
    );
  });
});

describe('GET /api/jobs/:id/timeline — invoice events', () => {
  it('returns this job’s INVOICE events alongside its JOB events', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { id: 'e1', event_type: 'COMPLETED', description: 'Job completed', metadata: null, created_at: new Date('2026-03-02'), creator: null },
      { id: 'e2', event_type: 'PAYMENT_RECEIVED', description: 'Payment of $900.00 received via CASH', metadata: null, created_at: new Date('2026-03-03'), creator: null },
    ]);

    const res = await request(app).get('/api/jobs/job-1/timeline').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { event_type: string }) => e.event_type))
      .toEqual(expect.arrayContaining(['COMPLETED', 'PAYMENT_RECEIVED']));
  });

  it('scopes invoice events to THIS job’s invoices, never the org’s', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/job-1/timeline').set(authHeader('admin'));

    const where = mockPrisma.timelineEvent.findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain('inv-1');
  });

  it('does NOT widen to invoice events for a price-blind requester', async () => {
    // The money is in the description string, which redactTimelineMoneyForRequester never
    // touches — it only strips metadata keys. So the events must not be fetched at all.
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    // canAccessRow's per-instance gate (GAP-1): TECHNICIAN's default read-Job grant is
    // conditional (OWN_JOB), so canAccessRow issues a scoped job.findFirst — mock it so the
    // request reaches getTimeline's body instead of 403ing before the query under test runs.
    mockPrisma.job.findFirst.mockResolvedValue({ id: 'job-1' });
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/job-1/timeline').set(authHeader('technician'));

    const where = mockPrisma.timelineEvent.findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).not.toContain('INVOICE');
  });

  it('still strips money metadata from JOB events for a price-blind requester', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    // Same canAccessRow gate as above.
    mockPrisma.job.findFirst.mockResolvedValue({ id: 'job-1' });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { id: 'e1', event_type: 'CANCELLED', description: 'Job cancelled', metadata: { collected_total: 900 }, created_at: new Date(), creator: null },
    ]);

    const res = await request(app).get('/api/jobs/job-1/timeline').set(authHeader('technician'));

    expect(res.body.events[0].metadata).not.toHaveProperty('collected_total');
  });
});
