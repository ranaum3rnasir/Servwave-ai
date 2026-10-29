import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

// ---------------------------------------------------------------------------
// The third schedulable type was missing from the board's own search entirely.
// scheduleModel.ts has always declared `EventType = 'job' | 'walkthrough' |
// 'service-plan'`, and the sidebar renders a live Service Plans bucket, but
// /api/search only ever answered with jobs and leads - so searching a plan by
// its SP-number returned "No results" for a card sitting right there.
//
// Scoped to scope=schedule, mirroring how customers/estimates/invoices are
// skipped there: the group exists to serve the board, and the plans it offers
// are the ones the board's bucket can actually act on (ACTIVE, visits left).
// ---------------------------------------------------------------------------

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
  servicePlan: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

/**
 * A monthly plan starting well in the past with no visits actioned, so
 * derivePlanFields resolves a non-null next_due and visits_remaining > 0 - the
 * same two conditions GET /api/service-plans/scheduler-bucket filters on. A
 * plan failing either would be absent from the bucket, and a search hit on it
 * would be a dead end.
 */
function plan(over: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    service_plan_number: 'SP00001',
    name: 'Quarterly HVAC maintenance',
    status: 'ACTIVE',
    visit_cadence: 'MONTHLY',
    interval_unit: 'MONTH',
    interval_count: 1,
    byweekday: [],
    occurrence_count: 12,
    start_date: new Date('2026-01-05T09:00:00.000Z'),
    end_date: null,
    visits: [],
    customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
    service_location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX' },
    ...over,
  };
}

function reset() {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  m.lead.findMany.mockResolvedValue([]);
  m.job.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
  m.servicePlan.findMany.mockResolvedValue([plan()]);
}

/** Override the shared test org with a STARTER one (no `service_plans`) for one request. */
function nextRequestIsStarter() {
  m.user.findUnique.mockResolvedValueOnce({
    ...TEST_USERS.realOrgAdmin,
    organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
  });
}

function searchedFields(where: Record<string, unknown>): string[] {
  const out: string[] = [];
  (function walk(node: unknown) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'contains' in (v as object)) out.push(k);
      else walk(v);
    }
  })(where);
  return out;
}

async function search(query: Record<string, string>, as: 'admin' | 'realOrgAdmin' = 'admin') {
  mockAuthAs(as);
  return request(app).get('/api/search').query(query).set(authHeader(as));
}

describe('GET /api/search?scope=schedule - service plans', () => {
  beforeEach(reset);

  it('returns the plan whose SP-number was typed', async () => {
    const res = await search({ q: 'SP00001', scope: 'schedule' });

    expect(res.status).toBe(200);
    expect(res.body.results.servicePlans).toHaveLength(1);
    expect(res.body.results.servicePlans[0]).toMatchObject({
      id: 'plan-1',
      entity_type: 'service-plan',
      title: 'SP00001',
      subtitle: 'John Doe',
      status: 'ACTIVE',
    });
  });

  it('searches the SP-number, the plan name, the customer and the address', async () => {
    await search({ q: 'hvac', scope: 'schedule' });

    const where = m.servicePlan.findMany.mock.calls[0][0].where as Record<string, unknown>;
    const fields = searchedFields(where);
    expect(fields).toContain('service_plan_number');
    expect(fields).toContain('name');
    expect(fields).toContain('company_name');
    expect(fields).toContain('address_line1');
  });

  it('is tenant-scoped and limited to ACTIVE plans, matching the sidebar bucket', async () => {
    await search({ q: 'hvac', scope: 'schedule' });

    const where = m.servicePlan.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(where.status).toBe('ACTIVE');
  });

  it('dates the row by the plan next due, so selecting it lands on the right day', async () => {
    const res = await search({ q: 'hvac', scope: 'schedule' });

    const [row] = res.body.results.servicePlans;
    expect(row.date).not.toBeNull();
    expect(new Date(row.date).toISOString()).toBe(row.date);
  });

  it('drops a plan with no visits left - the bucket would not carry it either', async () => {
    // occurrence_count 1, and that single visit already completed.
    m.servicePlan.findMany.mockResolvedValue([
      plan({
        occurrence_count: 1,
        visits: [{ status: 'COMPLETED', scheduled_date: new Date('2026-01-05T09:00:00.000Z') }],
      }),
    ]);

    const res = await search({ q: 'hvac', scope: 'schedule' });

    expect(res.body.results.servicePlans).toEqual([]);
  });

  it('never offers plans to an org whose plan lacks `service_plans`, and does not 402', async () => {
    nextRequestIsStarter();
    const res = await search({ q: 'hvac', scope: 'schedule' }, 'realOrgAdmin');

    expect(res.status).toBe(200);
    expect(res.body.results.servicePlans).toEqual([]);
    expect(m.servicePlan.findMany).not.toHaveBeenCalled();
  });

  it('leaves global search alone - the group is empty and unqueried off the schedule', async () => {
    const res = await search({ q: 'SP00001' });

    expect(res.status).toBe(200);
    expect(res.body.results.servicePlans).toEqual([]);
    expect(m.servicePlan.findMany).not.toHaveBeenCalled();
  });
});
