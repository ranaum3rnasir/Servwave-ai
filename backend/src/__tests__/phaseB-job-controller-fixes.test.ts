import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleSwitches } from './helpers';
import { withDependantsOff } from './support/switchDependants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─────────────────────────────────────────────────────────────────────────────
// Two Phase-B-reachable job.controller.ts leaks (flagged by two prior fix agents,
// out-of-scope for them):
//
// Fix 1 — job LIST OR-clobber (row-scope leak for a MULTI-READ user). `buildJobListWhere`
//   spreads the grant-driven row-scope (which for a multi-read user is `{ OR: [...] }`),
//   then a search term did `where.OR = [...search...]`, silently DROPPING the scope OR =
//   the user sees jobs OUTSIDE their scope. Fix: compose via addOrFilter so a pre-existing
//   scope OR is demoted under AND alongside the search OR (neither lost). Mirrors the
//   lead/invoice/estimate list fixes (phaseB-scope-or-clobber.test.ts).
//
// Fix 2 — advance/mutate handlers echo UNSTRIPPED estimate/invoice pricing. getById + myToday
//   strip pricing for a non-`read Invoice` requester, but the action handlers did not. Phase B
//   now lets an admin grant a technician an advance verb (start/complete/…) or update Job WITHOUT
//   read Invoice, so the action response leaked estimate total / per-line unit_price/line_total /
//   amount_invoiced / embedded-invoice money back to that tech. Fix: route every jobDetailSelect
//   action response through the same ability-gated strip (a no-op for invoice readers).
// ─────────────────────────────────────────────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ID = JOB_FIXTURE.id;

// Recursively collect whether any node in the where tree carries `key` — lets us assert BOTH
// scope arms survived regardless of nesting (top-level OR vs demoted-under-AND).
function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ─── Fix 1 — job LIST: multi-read scope OR survives a search OR ──────────────
describe('GET /api/jobs (LIST) — multi-read scope OR survives a search OR (Fix 1)', () => {
  beforeEach(() => {
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
  });

  it('a scope with several arms (Attached) + ?search=: every scope arm is kept next to the search arm', async () => {
    mockAuthAs('sales');
    // Attached is a union: crew on a visit, Sold By, Dispatcher. Several distinct arms => { OR: [...] }.
    mockRoleSwitches({ jobs_scope: 'attached' });

    const res = await request(app).get('/api/jobs?search=J00001').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.job.findMany.mock.calls[0][0].where as Record<string, unknown>;

    // Every scope arm survives: the crew arm has `visits`, the Sold By arm `salesperson_id`.
    expect(deepHas(where, 'visits')).toBe(true);
    expect(deepHas(where, 'salesperson_id')).toBe(true);
    // …and the search clauses are present too (neither OR clobbered the other).
    expect(deepHas(where, 'job_number')).toBe(true);

    // Structural anti-leak invariant: the two ORs are AND-ed peers (the addOrFilter shape), not a
    // single clobbered top-level OR. A bare top-level OR would mean the scope OR was dropped.
    expect(where.OR).toBeUndefined();
    expect(Array.isArray(where.AND)).toBe(true);
    const andArms = where.AND as Record<string, unknown>[];
    // One AND arm is the scope OR (carries the ownership relations); another is the search OR.
    expect(andArms.some((c) => deepHas(c, 'visits') && deepHas(c, 'salesperson_id'))).toBe(true);
    expect(andArms.some((c) => deepHas(c, 'job_number'))).toBe(true);
  });

  it('a scope with several arms (Attached), NO search: the scope OR stays the (uncontested) top-level OR', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ jobs_scope: 'attached' });

    const res = await request(app).get('/api/jobs').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.job.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // No search → the scope OR is the plain top-level OR (cheap path, unchanged shape).
    expect(Array.isArray(where.OR)).toBe(true);
    expect(deepHas(where, 'visits')).toBe(true);
    expect(deepHas(where, 'salesperson_id')).toBe(true);
  });
});

// ─── Fix 2 — advance handler strips pricing for a granted tech w/o read Invoice ──
describe('POST /api/jobs/:id/start — Phase B pricing strip on advance response (Fix 2)', () => {
  // A jobDetailSelect-shaped job owned by the technician carrying estimate pricing + line items
  // AND a non-empty invoices[] (so both the estimate strip and the invoices[] strip are exercised).
  function startedJobDetailOwnedByTech() {
    return {
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      amount_invoiced: 400,
      // S8 (D6): crew rides on the trips; `assignees` survives as the DERIVED payload key.
      visits: [{ assignees: [{ user_id: TEST_USERS.technician.id, user: { id: TEST_USERS.technician.id, first_name: 'Test', last_name: 'Tech' } }] }],
      estimate: {
        id: 'est-x',
        estimate_number: 'E00003',
        total_amount: 1062.5,
        status: 'WON',
        line_items: [
          { id: 'li1', sequence: 1, description: 'AC Unit', quantity: 2, unit_price: 800, is_taxable: true, line_total: 1600, item_type: 'PART' },
          { id: 'li2', sequence: 2, description: 'Labor', quantity: 3, unit_price: 50, is_taxable: true, line_total: 150, item_type: 'LABOR' },
        ],
      },
      invoices: [
        { id: 'inv1', invoice_number: 'I00001', status: 'SENT', total_amount: 500, amount_due: 100, created_at: new Date('2026-02-01') },
      ],
    };
  }

  // The pre-update findUnique in start() selects only id/status/visits/job_number; the visit carries what the
  // current-visit check reads (S04.5).
  const START_PRECHECK_OWNED_BY_TECH = {
    id: JOB_ID,
    status: 'SCHEDULED',
    visits: [{ status: 'SCHEDULED', scheduled_at: new Date(Date.now() + 86_400_000), scheduled_end: null, created_at: new Date(), assignees: [{ user_id: TEST_USERS.technician.id }] }],
    job_number: 'J00001',
  };

  beforeEach(() => {
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    // The invoices the person can open: none unless a case says so (S04.26).
    mockPrisma.invoice.findMany.mockResolvedValue([]);
  });

  it('technician who may start visits but WITHOUT View estimates / View invoices gets the estimate money stripped and no invoice listed', async () => {
    mockAuthAs('technician');
    mockRoleSwitches(withDependantsOff(['view_estimates', 'view_invoices']));  // View invoices is already off in the preset
    // The Technician preset holds Start and finish visits and View jobs — but NOT View estimates / View invoices
    // (turned off above). So the strip must fire on the action response.
    mockPrisma.job.findUnique.mockResolvedValue(START_PRECHECK_OWNED_BY_TECH);
    mockPrisma.job.update.mockResolvedValue(startedJobDetailOwnedByTech());

    const res = await request(app).post(`/api/jobs/${JOB_ID}/start`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    // Estimate as-sold figures stripped; work detail (description/quantity) kept. The job's own
    // amount_invoiced is its price and stays (S01.15: prices follow the record).
    expect(job.amount_invoiced).toBe(400);
    expect(job.estimate.total_amount).toBeUndefined();
    expect(job.remaining_unbilled == null).toBe(true);
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeUndefined();
      expect(li.line_total).toBeUndefined();
      expect(li.description).toBeDefined();
      expect(li.quantity).toBeDefined();
    }
    // An invoice the person cannot open is not echoed back at all (S04.26).
    expect(job.invoices).toEqual([]);
  });

  it('DISPATCHER (read Invoice) gets full estimate pricing + invoice totals on the start response', async () => {
    mockAuthAs('dispatcher');
    // The start handler also gates on assignee membership unless the requester has `manage all`.
    // DISPATCHER lacks `manage all`, so put them on the crew to clear that check — this test is
    // about the PRICING strip (gated on read Invoice), not the assignee gate.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...START_PRECHECK_OWNED_BY_TECH,
      assignees: [{ user_id: TEST_USERS.dispatcher.id }],
    });
    mockPrisma.job.update.mockResolvedValue(startedJobDetailOwnedByTech());

    const res = await request(app).post(`/api/jobs/${JOB_ID}/start`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.amount_invoiced).toBe(400);
    expect(job.estimate.total_amount).toBe(1062.5);
    expect(job.remaining_unbilled).toBeCloseTo(662.5, 1);
    expect(job.estimate.line_items[0].unit_price).toBe(800);
    expect(job.invoices[0].total_amount).toBe(500);
    expect(job.invoices[0].amount_due).toBe(100);
  });

  it('ADMIN gets full estimate pricing + invoice totals on the start response', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(START_PRECHECK_OWNED_BY_TECH);
    mockPrisma.job.update.mockResolvedValue(startedJobDetailOwnedByTech());

    const res = await request(app).post(`/api/jobs/${JOB_ID}/start`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.estimate.total_amount).toBe(1062.5);
    expect(job.invoices[0].total_amount).toBe(500);
    expect(job.invoices[0].amount_due).toBe(100);
  });
});
