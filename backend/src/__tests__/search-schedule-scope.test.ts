import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Walkthrough-as-entity redesign, PR-B2 — PR-D2 gap #4: `GET /api/search?scope=schedule`
// was the last site still filtering/sorting/serializing off the raw legacy
// `Lead.walkthrough_scheduled_at` column instead of the new `Walkthrough` relation. A later
// stage that tried to drop the legacy columns found this made the drop unsafe. These tests
// assert the schedule-scope lead query is fully repointed onto the relation while the JSON
// response's `date` field keeps behaving exactly as before (D15 "current visit" sourced).
// ─────────────────────────────────────────────────────────────────────────────

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

function reset() {
  vi.clearAllMocks();
  m.lead.findMany.mockResolvedValue([]);
  m.job.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
}

function wheresOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls.map((c) => c[0].where as Record<string, unknown>);
}

/** Every `visits.some.status` value named anywhere in a where tree, however it is composed. */
function collectVisitStatuses(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectVisitStatuses);
  if (!node || typeof node !== 'object') return [];
  const out: string[] = [];
  const rec = node as Record<string, any>;
  const status = rec.visits?.some?.status;
  if (typeof status === 'string') out.push(status);
  else if (Array.isArray(status?.in)) out.push(...status.in);
  for (const v of Object.values(rec)) out.push(...collectVisitStatuses(v));
  return out;
}

function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

describe('GET /api/search?scope=schedule — repointed onto the Walkthrough relation (PR-D2 gap)', () => {
  beforeEach(reset);

  it('filters leads by the walkthroughs relation, never the raw walkthrough_scheduled_at column', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/search').query({ q: 'doe', scope: 'schedule' }).set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(m.lead.findMany).toHaveBeenCalled();
    for (const w of wheresOf(m.lead.findMany)) {
      expect(deepHas(w, 'walkthrough_scheduled_at')).toBe(false);
      expect(deepHas(w, 'visits')).toBe(true);
    }
  });

  it("sources a schedule-scope lead's date from its CURRENT (SCHEDULED) visit, not a raw column", async () => {
    mockAuthAs('admin');
    const scheduledAt = new Date('2026-08-15T14:00:00.000Z');
    m.lead.findMany.mockResolvedValue([
      {
        id: 'lead-1',
        lead_number: 'L00203',
        service_request: 'Furnace inspection',
        status: 'CONTACTED',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        service_address_line1: '100 Test Ave',
        service_city: 'Austin',
        service_state: 'TX',
        customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
        // A COMPLETED older visit plus the CURRENT SCHEDULED one — the raw
        // walkthrough_scheduled_at column (dual-write) never clears on completion, so this
        // fixture only proves the fix if the resolver picks the SCHEDULED row over it.
        visits: [
          {
            id: 'w-old', status: 'COMPLETED', scheduled_at: new Date('2026-07-01T09:00:00.000Z'),
            duration_minutes: 60, completed_at: new Date('2026-07-01T10:00:00.000Z'), notes: null,
            cancelled_at: null, cancelled_reason: null, cancelled_by: null,
            customer_email_sent_at: null, created_at: new Date('2026-06-25T00:00:00.000Z'), canceller: null,
          },
          {
            id: 'w-current', status: 'SCHEDULED', scheduled_at: scheduledAt,
            duration_minutes: 60, completed_at: null, notes: null,
            cancelled_at: null, cancelled_reason: null, cancelled_by: null,
            customer_email_sent_at: null, created_at: new Date('2026-08-01T00:00:00.000Z'), canceller: null,
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/search').query({ q: 'doe', scope: 'schedule' }).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lead = res.body.results.leads.find((l: { id: string }) => l.id === 'lead-1');
    expect(lead).toBeDefined();
    expect(lead.date).toBe(scheduledAt.toISOString());
    // Schedule rows are titled by the L-number, mirroring the board card (and job rows).
    expect(lead.title).toBe('L00203');
  });
});

describe('schedule-scope lead search only asks for VisitStatus values that exist (S4 B13)', () => {
  const VISIT_STATUSES = ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

  /**
   * A lead.findMany that REJECTS an unknown VisitStatus literal, the way real Postgres does.
   *
   * Without this the defect is invisible: `leadBaseWhere` is a `Record<string, unknown>` so a
   * retired enum value typechecks, and safeQuery swallows the Prisma validation error and returns
   * [] - so schedule-scope lead search silently returns nothing in production while every mocked
   * test in this file stays green.
   */
  function seedEnumStrictLeads() {
    m.lead.findMany.mockImplementation(async (args: any) => {
      const wanted = args?.where?.visits?.some?.status;
      const values = wanted?.in ?? (typeof wanted === 'string' ? [wanted] : []);
      for (const v of values) {
        if (!VISIT_STATUSES.includes(v)) {
          throw new Error(`invalid input value for enum "VisitStatus": "${v}"`);
        }
      }
      return [];
    });
  }

  it('never names a retired VisitStatus in the board query', async () => {
    reset();
    seedEnumStrictLeads();
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/search?q=smith&scope=schedule')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Collected from ANYWHERE in the where tree, not from a fixed key path: the board filter is
    // AND-composed on top of the caller's row-scope (which owns a `visits` key of its own), so a
    // top-level lookup would silently find nothing and this assertion would pass over an empty
    // list.
    const asked = wheresOf(m.lead.findMany).flatMap((w) => collectVisitStatuses(w));
    expect(asked.length).toBeGreaterThan(0);
    for (const value of asked) expect(VISIT_STATUSES).toContain(value);
  });
});

/**
 * The board-status predicate is COMPOSED into the caller's Lead row-scope, never assigned over it.
 *
 * TECHNICIAN's `read Lead` grant is OWN_WALKTHROUGH - `{ visits: { some: { assignees: { some:
 * { user_id } } } } }` - so the scope's ONLY top-level key is `visits`, the same key the
 * schedule-scope filter wants. A plain `where.visits = ...` therefore does not narrow the scope,
 * it DELETES it, and the query comes back with every crew's leads in the org: lead number, service
 * request, service address and the customer's name and phone.
 */
describe('GET /api/search?scope=schedule - the lead row-scope survives the board-status filter', () => {
  beforeEach(reset);

  it('keeps a technician\'s own-visit scope on every schedule-scope lead query', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/search')
      // Multi-word AND a date range, so all three lead branches run: the base query, the
      // in-range priority query and the split-word query. All three set a `visits` predicate.
      .query({ q: 'sm ith', scope: 'schedule', rangeStart: '2026-09-01T00:00:00.000Z', rangeEnd: '2026-09-30T00:00:00.000Z' })
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const wheres = wheresOf(m.lead.findMany);
    expect(wheres.length).toBe(3);
    for (const w of wheres) {
      // The board-status filter is still applied...
      expect(deepHas(w, 'visits')).toBe(true);
      // ...and the caller's own-crew scope is still in the tree beside it.
      expect(JSON.stringify(w)).toContain(TEST_USERS.technician.id);
    }
  });
});

/**
 * S8 repoint (contract 09, site 7): search's in-range job filter moved from the (to-be-dropped)
 * `Job.scheduled_start` mirror onto the visit SET — the same D14 mirror bug the dashboard's
 * windows are fixed for (a COMPLETED job's mirror NULLs once its last live visit leaves the live
 * set, so the OLD column filter silently dropped completed work from schedule-scope search).
 *
 * The row-scope risk is the same one the lead test above guards: TECHNICIAN's `read Job` grant is
 * OWN_JOB - `{ visits: { some: { assignees: { some: { user_id } } } } }` (defaultGrants.ts) -
 * whose only top-level key is `visits`, the exact key the window filter also wants. A bare
 * `inRangeWhere.visits = ...` would DELETE the scope rather than narrow it, handing a technician
 * every crew's jobs org-wide. The fix composes via `addAndWords` instead.
 */
describe('GET /api/search?scope=schedule&rangeStart=...&rangeEnd=... — job in-range filter repoint (S8)', () => {
  beforeEach(reset);

  it("keeps a technician's own-crew job scope on the in-range query, composed under AND beside the visit-window clause", async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'doe', scope: 'schedule', rangeStart: '2026-09-01T00:00:00.000Z', rangeEnd: '2026-09-30T00:00:00.000Z' })
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const wheres = wheresOf(m.job.findMany);
    // Tier 1 (in-range) + Tier 2 (fallback) — `q=doe` is a single word, so no split tier.
    expect(wheres.length).toBe(2);
    const inRangeWhere = wheres[0];

    // The window clause reads the visit set now, not the mirror column.
    expect(deepHas(inRangeWhere, 'scheduled_at')).toBe(true);
    expect(inRangeWhere.scheduled_start).toBeUndefined();
    // ...and the caller's own-crew scope is STILL in the tree beside it, not clobbered.
    expect(JSON.stringify(inRangeWhere)).toContain(TEST_USERS.technician.id);
    // Composed under AND, never a bare `where.visits` overwrite (house rule).
    expect(Array.isArray(inRangeWhere.AND)).toBe(true);
  });

  it('carries both OR arms of the reference pattern — a CANCELLED job with a cancelled trip in range still matches', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'doe', scope: 'schedule', rangeStart: '2026-09-01T00:00:00.000Z', rangeEnd: '2026-09-30T00:00:00.000Z' })
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const inRangeWhere = wheresOf(m.job.findMany)[0];
    const andClauses = inRangeWhere.AND as Record<string, unknown>[];
    const windowClause = andClauses.find((c) => 'OR' in c) as { OR: Record<string, unknown>[] } | undefined;
    expect(windowClause).toBeDefined();
    expect(windowClause!.OR).toHaveLength(2);
    // Arm 1: a live (non-cancelled) trip in range.
    expect(deepHas(windowClause!.OR[0], 'visits')).toBe(true);
    expect(JSON.stringify(windowClause!.OR[0])).toContain('CANCELLED');
    // Arm 2: the job itself is CANCELLED, trip need not be live (D19 keeps cancelled trips).
    expect(windowClause!.OR[1].status).toBe('CANCELLED');
  });

  // S8 repoint (D14), FINISHED (this PR): first_visit_start now exists (S8 §4, #1698) and
  // scheduled_start is DROPPED (S8 §2/§3) - the deferred TODO this test used to pin is done.
  it('orders the schedule-scope query by first_visit_start, the real maintained scalar', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'doe', scope: 'schedule', rangeStart: '2026-09-01T00:00:00.000Z', rangeEnd: '2026-09-30T00:00:00.000Z' })
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    for (const call of m.job.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual({ first_visit_start: 'asc' });
    }
  });
});
