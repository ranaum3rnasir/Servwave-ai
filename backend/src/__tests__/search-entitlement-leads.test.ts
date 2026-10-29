import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

// ---------------------------------------------------------------------------
// SRVW-102 sweep result #2 - the INVERSE entitlement gap on the schedule.
//
// /api/leads sits behind requireFeature('leads') (lead.routes.ts:14, minPlan PRO),
// so a STARTER org's schedule board can never render a walkthrough. /api/search had
// no feature awareness at all, so schedule search still offered "Walkthroughs" rows
// whose highlighted event id the board is guaranteed not to hold - a silent dead end.
//
// The fix is a per-entity filter INSIDE the controller, never a route-level
// requireFeature: global search itself is Starter core and must keep answering 200.
// ---------------------------------------------------------------------------

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

/**
 * A lead carrying a REAL current (SCHEDULED, non-null scheduled_at) walkthrough, shaped
 * to walkthroughSnapshotSelect. Load-bearing, do not simplify: the scope=schedule branch
 * runs through findScheduleLeads, which maps via resolveCurrentWalkthrough and drops any
 * row whose current visit has no scheduled_at. A bare lead row would therefore produce
 * `results.leads === []` even WITHOUT the fix, and the test would be green from birth.
 */
const LEAD_ROW = {
  id: 'lead-1',
  lead_number: 'L00203',
  service_request: 'Furnace inspection',
  status: 'CONTACTED',
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  service_address_line1: '100 Test Ave',
  service_city: 'Austin',
  service_state: 'TX',
  customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
  visits: [
    {
      id: 'w-current',
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-08-15T14:00:00.000Z'),
      duration_minutes: 60,
      completed_at: null,
      notes: null,
      cancelled_at: null,
      cancelled_reason: null,
      cancelled_by: null,
      customer_email_sent_at: null,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      canceller: null,
    },
  ],
};

/** One job row, so a lead-less response still proves the endpoint did not short-circuit. */
const JOB_ROW = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scheduled_start: new Date('2026-08-15T09:00:00.000Z'),
  customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
  service_location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX' },
};

function reset() {
  vi.clearAllMocks();
  // authenticate caches the resolved user by bearer token, so without this the STARTER
  // override queued below is never even consulted on the second and later requests.
  clearTokenCache();
  clearPermissionCache();
  m.lead.findMany.mockResolvedValue([LEAD_ROW]);
  m.job.findMany.mockResolvedValue([JOB_ROW]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
}

/**
 * Override the shared SCALE test org with a STARTER one for the NEXT user lookup only.
 * mockResolvedValueOnce (the comm-phone-access.test.ts precedent) - queued immediately
 * before the single request each unentitled test makes, because vi.clearAllMocks() does
 * not drain a once-queue.
 */
function nextRequestIsStarter() {
  m.user.findUnique.mockResolvedValueOnce({
    ...TEST_USERS.realOrgAdmin,
    organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
  });
}

function wheresOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls.map((c) => c[0].where as Record<string, unknown>);
}

describe('GET /api/search - leads are filtered out for an org whose plan lacks `leads`', () => {
  beforeEach(reset);

  it('an org whose plan lacks `leads` gets zero lead results and prisma.lead is never queried', async () => {
    mockAuthAs('realOrgAdmin');
    nextRequestIsStarter();

    const res = await request(app).get('/api/search').query({ q: 'doe' }).set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(200);
    expect(res.body.results.leads).toEqual([]);
    expect(m.lead.findMany).not.toHaveBeenCalled();
    // The endpoint kept working for everything the org DOES pay for.
    expect(res.body.results.jobs.length).toBeGreaterThan(0);
  });

  it('schedule-scope search on an unentitled org drops walkthroughs but keeps jobs - no 402, no route-level gate', async () => {
    mockAuthAs('realOrgAdmin');
    nextRequestIsStarter();

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'doe', scope: 'schedule' })
      .set(authHeader('realOrgAdmin'));

    // Global search is Starter core - a route-level requireFeature('leads') here would
    // 402 the whole endpoint for every Starter org. This is the guard against that.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(402);
    expect(res.body.results.leads).toEqual([]);
    expect(m.lead.findMany).not.toHaveBeenCalled();
    expect(res.body.results.jobs.length).toBeGreaterThan(0);
  });

  it('control - an entitled (SCALE) org still gets leads, with tenant and row scope intact', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'doe', scope: 'schedule' })
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.results.leads.map((l: { id: string }) => l.id)).toContain('lead-1');
    expect(m.lead.findMany).toHaveBeenCalled();
    for (const w of wheresOf(m.lead.findMany)) {
      // tenantWhere(req) survives untouched - the fix adds no where clause at all.
      expect(w.organization_id).toBe(TEST_USERS.admin.organization_id);
      // ... and so does the schedule-scope relation filter. Multi-visit S4 changed BOTH halves of
      // what this line used to pin: REQUESTED was retired from VisitStatus (the filter now names
      // every LIVE state), and the filter is AND-composed rather than assigned onto `visits`, so
      // that it can never delete a caller's own `visits`-keyed row-scope. Found in the tree rather
      // than at a fixed key for exactly that reason.
      expect(JSON.stringify(w)).toContain('"status":{"in":["SCHEDULED","EN_ROUTE","ON_SITE","IN_PROGRESS"]}');
    }
  });
});
