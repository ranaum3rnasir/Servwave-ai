import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// Phase B (§E) — QA-B2 leak follow-up.
//
// Leak 2 (MEDIUM): `stripJobPricingForRequester` never touched out.invoices, so each embedded
//   invoice's total_amount + amount_due leaked even on the "fixed" getById path. Fix: project the
//   invoices[] array to drop the monetary fields (keep invoice_number/status) when stripping.
//
// (Leak 1 covered GET /api/jobs/my-today, the technician mobile screen — retired with the
// /tech/* view in Spec A; its describe block was removed here, not just its endpoint.)
//
// The fixture below carries an estimate WITH pricing AND a non-empty invoices[] so the strip is
// actually exercised.

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ID = JOB_FIXTURE.id;

// A jobDetailSelect-shaped job owned by the technician, with estimate pricing + line items AND a
// non-empty invoices[] (each invoice carries the monetary fields jobDetailSelect projects).
function jobDetailOwnedByTech() {
  return {
    ...JOB_FIXTURE,
    amount_invoiced: 400,
    assignees: [{ user: { id: TEST_USERS.technician.id, first_name: 'Test', last_name: 'Tech' } }],
    estimate: {
      id: 'est-x',
      estimate_number: 'E00003',
      total_amount: 1062.5,
      status: 'WON',
      lead_id: 'lead-x',
      lead: null,
      line_items: [
        { id: 'li1', sequence: 1, description: 'AC Unit', quantity: 2, unit_price: 800, is_taxable: true, line_total: 1600, item_type: 'PART' },
        { id: 'li2', sequence: 2, description: 'Labor', quantity: 3, unit_price: 50, is_taxable: true, line_total: 150, item_type: 'LABOR' },
      ],
    },
    invoices: [
      { id: 'inv1', invoice_number: 'I00001', status: 'SENT', total_amount: 500, amount_due: 100, created_at: new Date('2026-02-01') },
      { id: 'inv2', invoice_number: 'I00002', status: 'DRAFT', total_amount: 200, amount_due: 200, created_at: new Date('2026-02-02') },
    ],
    // SRVW-96 - the job's attached (non-provenance) estimates.
    linked_estimates: [{ id: 'est-link', estimate_number: 'J00001-1', total_amount: 425, status: 'WON' }],
    source_plan_id: null,
    source_plan: null,
  };
}

// The accessCheck pre-query in getById selects only the ownership relations.
const ACCESS_CHECK_OWNED_BY_TECH = {
  assignees: [{ user_id: TEST_USERS.technician.id }],
  estimate: { lead: { lead_assignees: [] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ─── Leak 2 — getById invoices[] strip ──────────────────────────────────────

describe('GET /api/jobs/:id — Phase B invoices[] strip (Leak 2)', () => {
  beforeEach(() => {
    // getById: first findUnique = existence probe, second = full detail (non-empty invoices[]).
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(ACCESS_CHECK_OWNED_BY_TECH)
      .mockResolvedValueOnce(jobDetailOwnedByTech());
    // GAP-1 — getById gates via canAccessRow; the technician's OWN_JOB read issues a scoped
    // findFirst that matches their own job. (DISPATCHER's unconditional read skips the query.)
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  });

  it('strict technician gets a non-empty invoices[] with each total_amount/amount_due ABSENT', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.invoices).toHaveLength(2);
    for (const inv of job.invoices) {
      expect(inv.total_amount).toBeUndefined();
      expect(inv.amount_due).toBeUndefined();
      // Invoice identity preserved so the tech knows an invoice exists.
      expect(inv.invoice_number).toBeDefined();
      expect(inv.status).toBeDefined();
    }
  });

  it('DISPATCHER (read Invoice) keeps each invoice total_amount/amount_due on getById', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.invoices).toHaveLength(2);
    expect(job.invoices[0].total_amount).toBe(500);
    expect(job.invoices[0].amount_due).toBe(100);
    expect(job.invoices[1].total_amount).toBe(200);
    expect(job.invoices[1].amount_due).toBe(200);
  });
});

// ─── SRVW-96 - getById surfaces the job's attached (linked) estimates ──────────────────────

describe('GET /api/jobs/:id - linked_estimates on getById (SRVW-96)', () => {
  beforeEach(() => {
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(ACCESS_CHECK_OWNED_BY_TECH)
      .mockResolvedValueOnce(jobDetailOwnedByTech());
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  });

  it("getById's detail query requests linked_estimates in jobDetailSelect", async () => {
    mockAuthAs('dispatcher');

    await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    // Call 0 is the existence probe (job.controller.ts getById); call 1 is the jobDetailSelect
    // query. Prisma is fully mocked in this file, so `select` is otherwise inert - this is the
    // only assertion that proves the select was actually widened.
    expect(mockPrisma.job.findUnique.mock.calls[1][0].select).toHaveProperty('linked_estimates');
  });

  it('strips total_amount from linked_estimates for a price-blind requester', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const linked = res.body.job.linked_estimates;
    expect(linked).toHaveLength(1);
    expect(linked[0].estimate_number).toBe('J00001-1');
    expect(linked[0].status).toBe('WON');
    expect(linked[0].total_amount).toBeUndefined();
  });

  it('an invoice reader keeps total_amount on linked_estimates', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const linked = res.body.job.linked_estimates;
    expect(linked[0].estimate_number).toBe('J00001-1');
    expect(linked[0].total_amount).toBe(425);
  });
});
