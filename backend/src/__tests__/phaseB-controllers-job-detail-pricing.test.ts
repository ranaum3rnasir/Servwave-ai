import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// Phase B (§E) — job-detail pricing projection. A strict technician reads their OWN job
// (read Job OWN_JOB is kept), and estimate pricing leaks through the job payload (estimate
// total_amount + per-line unit_price/line_total + derived remaining_unbilled). Strip those
// monetary fields when the requester cannot see pricing; keep descriptions + quantities so the
// tech can still do the work. Mirrors the lead-controller `stripEstimateMonetaryFields`.
//
// SRVW-140 (2026-08-03) - the predicate this file exercises is `canSeePricing`, which now keys
// on the dedicated `read Pricing` grant written by the Roles UI "See financial data" switch, NOT
// on `read Invoice`. DISPATCHER/ADMIN below still see pricing (DISPATCHER holds read Pricing by
// default; ADMIN via manage-all). The deliberately-rewritten case at the bottom of the file used
// to assert that a per-user Invoice capability confers pricing - that WAS the leak the card
// names, and it no longer does.

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ID = JOB_FIXTURE.id;

// Detail-shaped job (jobDetailSelect) owned by the technician, with estimate pricing + lines.
function jobDetailOwnedByTech() {
  return {
    ...JOB_FIXTURE,
    amount_invoiced: 400,
    // R3b (2026-07-21) — cost model (D2/D8), same staff-only strip as the estimate/invoice fields above.
    labor_hours: 6,
    overhead_mode: 'FIXED',
    overhead_value: 75,
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
    invoices: [],
    source_plan_id: null,
    source_plan: null,
  };
}

// getById's first findUnique is now the existence/tenant probe ({ id: true }); any truthy row
// clears the 404. (GAP-1: per-instance ownership moved to canAccessRow's scoped findFirst.)
const ACCESS_CHECK_OWNED_BY_TECH = { id: JOB_ID };

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // getById: first findUnique = existence probe, second = full detail.
  mockPrisma.job.findUnique
    .mockResolvedValueOnce(ACCESS_CHECK_OWNED_BY_TECH)
    .mockResolvedValueOnce(jobDetailOwnedByTech());
  // GAP-1 — getById now gates via canAccessRow. For a conditional read (the technician's OWN_JOB)
  // it issues a scoped findFirst; the job is the tech's own, so it matches. ADMIN/DISPATCHER have
  // an unconditional read → canAccessRow short-circuits without querying (this mock is unused).
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
});

describe('GET /api/jobs/:id — Phase B pricing strip for non-invoice readers', () => {
  it('strict technician (own job, no read Invoice) gets descriptions/quantities but NO pricing', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    // Estimate total + derived remaining stripped.
    expect(job.estimate.total_amount).toBeUndefined();
    expect(job.remaining_unbilled == null).toBe(true);
    // R3b — cost model fields stripped too.
    expect(job.labor_hours).toBeUndefined();
    expect(job.overhead_mode).toBeUndefined();
    expect(job.overhead_value).toBeUndefined();
    // Per-line money stripped, but the work detail kept.
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeUndefined();
      expect(li.line_total).toBeUndefined();
      expect(li.description).toBeDefined();
      expect(li.quantity).toBeDefined();
    }
  });

  // The other side of the same switch, and the one this PR changed. `read Pricing` unlocks eleven
  // consumers (the list is in canSeePricing's docblock); the job DETAIL strip is the widest of them,
  // and it was only ever asserted in its stripped direction for a technician because the role could
  // not hold the grant. It can now, by default, so the positive projection needs pinning too - the
  // whole point of the grant is that a technician pricing a job they created can see what things
  // cost, and a silent regression here would look like a rendering bug, not a permissions one.
  it('technician on the DEFAULT grants (read Pricing) gets the full money on their own job', async () => {
    mockAuthAs('technician');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.estimate.total_amount).toBeDefined();
    // R3b cost model - the margin inputs, not just the sell price.
    expect(job.labor_hours).toBeDefined();
    expect(job.overhead_mode).toBeDefined();
    expect(job.overhead_value).toBeDefined();
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeDefined();
      expect(li.line_total).toBeDefined();
    }
  });
});

describe('GET /api/jobs/:id — pricing retained for invoice readers', () => {
  it('DISPATCHER sees estimate pricing on the job detail', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.estimate.total_amount).toBe(1062.5);
    expect(job.remaining_unbilled).toBeCloseTo(662.5, 1);
    expect(job.estimate.line_items[0].unit_price).toBe(800);
    expect(job.estimate.line_items[0].line_total).toBe(1600);
    // R3b — cost model fields retained for an invoice reader.
    expect(job.labor_hours).toBe(6);
    expect(job.overhead_mode).toBe('FIXED');
    expect(job.overhead_value).toBe(75);
  });

  it('ADMIN sees estimate pricing on the job detail', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.estimate.total_amount).toBe(1062.5);
    expect(res.body.job.estimate.line_items[0].unit_price).toBe(800);
  });

  // SRVW-140 - DELIBERATE REWRITE. This case previously asserted the OPPOSITE: that a per-user
  // `create Invoice` allow override (impliesRead → a paired conditional read Invoice) handed the
  // technician full dollar visibility on their own job. That is exactly the leak the card names -
  // an admin granting on-site invoicing or payment collection silently unlocked cost/margin data
  // while the Roles UI switch that claims to control it still read OFF. The See financial data
  // switch (read Pricing) is now the only door; an admin's remedy is to turn it on for that role.
  it('technician granted per-user Invoice access does NOT get pricing on their own job', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Invoice', effect: 'allow' },
    ]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.job.estimate.total_amount).toBeUndefined();
    expect(res.body.job.estimate.line_items[0].unit_price).toBeUndefined();
    // Work detail still survives - the capability grant is not revoked, only cost visibility.
    expect(res.body.job.estimate.line_items[0].description).toBe('AC Unit');
  });
});
