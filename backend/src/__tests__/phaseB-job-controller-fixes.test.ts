import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

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
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
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
  clearUserOverrideCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ─── Fix 1 — job LIST: multi-read scope OR survives a search OR ──────────────
describe('GET /api/jobs (LIST) — multi-read scope OR survives a search OR (Fix 1)', () => {
  beforeEach(() => {
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
  });

  it('SALES (role read OWN_JOB_VIA_ESTIMATE) + override create Job + ?search=: BOTH scope arms kept', async () => {
    mockAuthAs('sales');
    // SALES default role read Job = OWN_JOB_VIA_ESTIMATE (estimate.lead.lead_assignees).
    setCachedGrants(TEST_USERS.sales.organization_id, 'SALES', [
      {
        action: 'read',
        subject: 'Job',
        conditions: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
      },
    ]);
    // Per-user override `create Job` synthesizes a SECOND distinct conditional read = OWN_JOB
    // (visits.some.assignees.some.user_id). Two distinct conditions => scopeWhereFor returns { OR: [via_estimate, own] }.
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Job', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/jobs?search=J00001').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.job.findMany.mock.calls[0][0].where as Record<string, unknown>;

    // Both scope arms survive: the via-estimate arm has `estimate`; the own arm has `visits`.
    expect(deepHas(where, 'estimate')).toBe(true); // unique to OWN_JOB_VIA_ESTIMATE
    expect(deepHas(where, 'visits')).toBe(true); // OWN_JOB (S8: the visits path)
    // …and the search clauses are present too (neither OR clobbered the other).
    expect(deepHas(where, 'job_number')).toBe(true);

    // Structural anti-leak invariant: the two ORs are AND-ed peers (the addOrFilter shape), not a
    // single clobbered top-level OR. A bare top-level OR would mean the scope OR was dropped.
    expect(where.OR).toBeUndefined();
    expect(Array.isArray(where.AND)).toBe(true);
    const andArms = where.AND as Record<string, unknown>[];
    // One AND arm is the scope OR (carries the ownership relations); another is the search OR.
    expect(andArms.some((c) => deepHas(c, 'estimate') && deepHas(c, 'visits'))).toBe(true);
    expect(andArms.some((c) => deepHas(c, 'job_number'))).toBe(true);
  });

  it('SALES multi-read, NO search: scope OR stays the (uncontested) top-level OR', async () => {
    mockAuthAs('sales');
    setCachedGrants(TEST_USERS.sales.organization_id, 'SALES', [
      {
        action: 'read',
        subject: 'Job',
        conditions: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
      },
    ]);
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Job', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/jobs').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.job.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // No search → the scope OR is the plain top-level OR (cheap path, unchanged shape).
    expect(Array.isArray(where.OR)).toBe(true);
    expect(deepHas(where, 'estimate')).toBe(true);
    expect(deepHas(where, 'visits')).toBe(true);
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

  // The pre-update findUnique in start() selects only id/status/visits/job_number.
  const START_PRECHECK_OWNED_BY_TECH = {
    id: JOB_ID,
    status: 'SCHEDULED',
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    job_number: 'J00001',
  };

  beforeEach(() => {
    mockPrisma.timelineEvent.create.mockResolvedValue({});
  });

  it('technician granted `start Job` (override) but WITHOUT read Invoice gets pricing STRIPPED', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    // Override grants `start Job` (passes canDo('start','Job')) + the paired own-scoped read Job —
    // but NOT read Invoice. So the strip must fire on the action response.
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'start', subject: 'Job', effect: 'allow' },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue(START_PRECHECK_OWNED_BY_TECH);
    mockPrisma.job.update.mockResolvedValue(startedJobDetailOwnedByTech());

    const res = await request(app).post(`/api/jobs/${JOB_ID}/start`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    // Estimate as-sold figures stripped; work detail (description/quantity) kept.
    expect(job.amount_invoiced).toBeUndefined();
    expect(job.estimate.total_amount).toBeUndefined();
    expect(job.remaining_unbilled == null).toBe(true);
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeUndefined();
      expect(li.line_total).toBeUndefined();
      expect(li.description).toBeDefined();
      expect(li.quantity).toBeDefined();
    }
    // Embedded invoice money stripped, identity kept.
    for (const inv of job.invoices) {
      expect(inv.total_amount).toBeUndefined();
      expect(inv.amount_due).toBeUndefined();
      expect(inv.invoice_number).toBeDefined();
      expect(inv.status).toBeDefined();
    }
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
