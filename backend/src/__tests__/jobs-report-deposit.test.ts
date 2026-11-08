import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

// Issue #499 — Jobs Report must exclude DEPOSIT invoices from billed/paid.
// The bug is in WHICH invoices the query fetches (jobsReportSelect.invoices.where),
// so coverage lives at the endpoint, not the pure service (JobInvoiceInput has no `kind`).

const mockPrisma = prisma as unknown as {
  job: { findMany: ReturnType<typeof vi.fn> };
};

const ALL_INVOICES = [
  { kind: 'DEPOSIT', total_amount: 500, amount_due: 0, subtotal: 500, tax_amount: 0 },
  { kind: 'STANDARD', total_amount: 1000, amount_due: 250, subtotal: 920, tax_amount: 80 },
];

describe('Jobs Report — DEPOSIT invoices excluded from billed/paid (#499)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    // Honor the nested invoices.where with a THIN filter that mimics only the
    // relevant DB semantics — so the test exercises the controller's query, not the mock.
    mockPrisma.job.findMany.mockImplementation((args: any) => {
      const where = args.select.invoices.where;
      const invoices = ALL_INVOICES.filter(
        (inv) => where.voided_at === null && (!where.kind || inv.kind !== 'DEPOSIT'),
      );
      return Promise.resolve([
        {
          job_number: 'J00001',
          scope_notes: null,
          status: 'COMPLETED',
          created_at: new Date('2026-06-01T10:00:00Z'),
          scheduled_start: null,
          scheduled_end: null,
          // NON-NULL customer + service_location are MANDATORY — the controller
          // row-map (report.controller.ts:262-288) dereferences them unguarded.
          customer: { company_name: 'Acme', first_name: null, last_name: null, email: 'a@x.com', phone: null, source: null },
          service_location: { address_line1: '1 Main', address_line2: null, city: 'NYC', state: 'NY', zip: '10001' },
          assignees: [], visits: [{ assignees: [] }],
          dispatcher: null,
          invoices,
        },
      ]);
    });
  });

  it('billed/paid reflect the STANDARD invoice only, not the DEPOSIT', async () => {
    const res = await request(app).get('/api/reports/jobs').set(authHeader('admin'));
    expect(res.status).toBe(200);
    // AC#2/#3: STANDARD only → billed 1000, paid 1000-250 = 750.
    // Pre-fix the query has no kind filter → both invoices pass → billed 1500 / paid 1250 (RED).
    expect(res.body.jobs[0].billed).toBe(1000);
    expect(res.body.jobs[0].paid).toBe(750);
  });

  it('query filters invoices to kind not-DEPOSIT alongside voided_at null', async () => {
    await request(app).get('/api/reports/jobs').set(authHeader('admin'));
    // AC#1: exact nested where shape.
    expect(mockPrisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          invoices: expect.objectContaining({
            where: { voided_at: null, kind: { not: 'DEPOSIT' } },
          }),
        }),
      }),
    );
  });
});
