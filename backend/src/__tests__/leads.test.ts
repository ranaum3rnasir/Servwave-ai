import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  TEST_ORG,
  ALPHA_ORG_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  LEAD_FIXTURE,
  TAG_FIXTURE,
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { allocateNumber } from '../lib/numbering';
import { leadFacets } from '../lib/query/registries/lead.filters';
import { logger } from '../lib/logger';

// WALKTHROUGH_SCHEDULED/WALKTHROUGH_PERFORMER_ASSIGNED/_REMOVED now travel through
// dispatchAutomationEvent rather than a hard-coded sender — mocked here (mirroring
// automation-wiring.test.ts) so the tests below that assert on this can do so
// directly instead of via the (deleted) sendWalkthrough*Email functions.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;
function dispatchedType(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

// ─── Lead status writes (spec #1751 D6) ───────────────
//
// Every door that moves a lead's status now goes through transitionLeadStatus, which writes the
// status with `updateMany` (its guards live in the WHERE clause) and files a STATUS_CHANGE
// timeline event carrying `from` and `to`. The two helpers below read those two facts back.
//
// `leadStatusWrites` filters on `data.status` deliberately: the same `lead.updateMany` mock also
// receives the clock stamps (`won_at`, and the first-touch-wins writes), so an unfiltered call
// count cannot tell "the status moved" from "a timestamp was stamped".

function leadStatusWrites(updateMany: ReturnType<typeof vi.fn> = prisma.lead.updateMany as any) {
  return updateMany.mock.calls
    .map((c: any[]) => c[0])
    .filter((args: any) => args?.data?.status !== undefined);
}

function statusChangeEvents(create: ReturnType<typeof vi.fn> = prisma.timelineEvent.create as any) {
  return create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((data: any) => data?.event_type === 'STATUS_CHANGE');
}

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  lead: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    // Spec #1751 D6: the status write itself — transitionLeadStatus puts its guards in the
    // WHERE clause, so it is an updateMany, and `lead.update` now only re-reads the row.
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  estimate: {
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  payment: { count: ReturnType<typeof vi.fn> };
  serviceLocation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  tag: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  tagAssignment: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  // Walkthrough-as-entity redesign, PR-B2.
  visit: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  visitAssignee: {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clears the .mockResolvedValueOnce queue too,
  // so previously-queued values can't bleed into the next test.
  vi.resetAllMocks();
  // Clear the permissionCache so cached grants from one test don't leak into the next.
  // attachAbility and loadGrantsFor both use this cache; without clearing it, a test
  // that caches grants for role X would affect the next test's ability checks.
  clearPermissionCache();
  // Default resolutions for cascade calls added to markLost/cancelLead
  (prisma.estimate.updateMany as any).mockResolvedValue({ count: 0 });
  (prisma.estimate.findMany as any).mockResolvedValue([]);
  // Phase 4a: edit-freeze (update), casual-delete guard, deposit-invoice void.
  // Default to "no estimate / no payment / no deposit invoice" so existing tests
  // (which don't set these) keep their pre-4a behavior.
  (prisma.estimate.count as any).mockResolvedValue(0);
  (prisma.payment.count as any).mockResolvedValue(0);
  (prisma.invoice.findMany as any).mockResolvedValue([]);
  (prisma.invoice.updateMany as any).mockResolvedValue({ count: 0 });
  (prisma.serviceLocation.findFirst as any).mockResolvedValue(null);
  (prisma.serviceLocation.create as any).mockResolvedValue({ id: 'new-loc-id' });
  // Duplicate-customer guard (Fixes #42) runs prisma.customer.findMany on the
  // new_customer path before the transaction. Default to "no existing match".
  (prisma.customer.findMany as any).mockResolvedValue([]);
  (prisma.timelineEvent.create as any).mockResolvedValue({});
  (prisma.lead.delete as any).mockResolvedValue({});
  // Spec #1751 D6: every lead status change now runs through transitionLeadStatus, whose write
  // is `tx.lead.updateMany` and which reads `count` off the result to decide whether anything
  // actually moved. `{ count: 1 }` is "the row changed" — the ordinary case for every door here.
  // Without a resolution the destructure throws and the door 500s; with `{ count: 0 }` the write
  // would be treated as refused and no STATUS_CHANGE ledger entry would be written.
  (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });
  // Same hazard on the visit side: every visit LIFECYCLE write is CONDITIONAL
  // (`tx.visit.updateMany` with an accept-set for `status` in its WHERE) and the door reads
  // `count` to learn whether it was the request that landed the transition — complete, cancel and
  // unschedule all resolve their target with a read that runs before the transaction opens, so a
  // second concurrent request must not overwrite the first. `{ count: 1 }` is "this caller won",
  // the ordinary case here; `{ count: 0 }` would make every one of them answer 400. setup.ts
  // carries the same default, but resetAllMocks above wipes it.
  (prisma.visit.updateMany as any).mockResolvedValue({ count: 1 });
  // Lead status options (slice 04) count a lead's open and finished visits on GET and on a hand
  // status change. "No visits" is the right default for the fixture lead.
  (prisma.visit.count as any).mockResolvedValue(0);
  // attachAbility middleware queries rolePermission for non-ADMIN users;
  // return empty grants so non-ADMIN requests without explicit mock get 403.
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  // Walkthrough-as-entity redesign, PR-B2: several handlers (updateWalkthrough, cancelLead,
  // markLost, unscheduleWalkthrough, completeWalkthrough, cancelWalkthrough) now wrap their
  // lead update + walkthrough update + timeline write in a $transaction. Default the
  // transaction to hand the SAME mocked `prisma` object back as `tx`, so any test that already
  // configures `mockPrisma.lead.update` / `mockPrisma.timelineEvent.create` /
  // `mockPrisma.visit.*` at the top level keeps working transparently. Tests that need an
  // ISOLATED tx object (e.g. create()'s narrower txMock, scheduleWalkthrough's dedicated wiring)
  // override this with their own `mockPrisma.$transaction.mockImplementation(...)` inside the
  // test body.
  (prisma.$transaction as any).mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
});

// ═══════════════════════════════════════════════════════
// GET /api/leads
// ═══════════════════════════════════════════════════════

describe('GET /api/leads', () => {
  it('returns paginated lead list', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1 });
  });

  // PR-D2: walkthrough_needed is a deleted concept, not merely hidden - the list select must
  // not read the raw column at all.
  it('does not select walkthrough_needed', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.select.walkthrough_needed).toBeUndefined();
  });

  /**
   * Mirror of the jobs list-select pin: the walkthrough crew's phone rides on the LEAD.
   * The picker roster (`GET /api/users/assignable`, gated on `assign User`) no longer carries
   * contact fields, so dropping this makes the schedule editor's call/text affordance vanish
   * for the very viewers the slice is meant to keep it for.
   */
  it('includes visits.assignees.user.phone in leadListSelect (schedule board crew contact)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    const userSelect = findManyArgs.select.visits?.select?.assignees?.select?.user?.select;
    expect(userSelect).toMatchObject({ id: true, first_name: true, last_name: true, phone: true });
  });

  it('filters by status', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?status=NEW')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toBe('NEW');
  });

  it('auto-filters by assigned_to for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('sales'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_assignees).toEqual({ some: { user_id: TEST_USERS.sales.id } });
  });

  it('does not auto-filter for ADMIN', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_assignees).toBeUndefined();
  });

  // #106 ENFORCEMENT: list scope is grant-DRIVEN, not a hardcoded SALES-only filter.
  // TECHNICIAN's Lead read grant is scoped via OWN_WALKTHROUGH, NOT lead_assignees. The
  // fail-open hand-rolled block skipped every non-SALES role, so a TECHNICIAN list saw the
  // whole org. scopeWhereForReq must scope it to its OWN walkthroughs — proving the scope
  // follows the role's grant condition.
  //
  // Walkthrough-as-entity redesign, PR-B2: OWN_WALKTHROUGH is now a nested relation through
  // the walkthroughs -> performers join (defaultGrants.ts), not a direct walkthrough_performers
  // relation on Lead.
  it('scopes the list by the role grant condition for TECHNICIAN (walkthrough-owned, not lead_assignees)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('technician'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    // Scoped to the technician's own walkthroughs — NOT the lead-owner field, and NOT unscoped.
    expect(findManyArgs.where.visits).toEqual({ some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } });
    expect(findManyArgs.where.lead_assignees).toBeUndefined();
  });

  // #106 ENFORCEMENT (fail-closed): a non-ADMIN role that passes the subject-level route
  // guard but carries NO read grant on Lead must see NOTHING (MATCH_NOTHING), never the
  // whole org. The old hardcoded block was fail-OPEN for any non-SALES role.
  it('fail-closed: a non-ADMIN role with no Lead read grant lists nothing (MATCH_NOTHING)', async () => {
    mockAuthAs('technician');
    // Override the default TECHNICIAN grants with an empty grant set: the route-level
    // canDo guard is stubbed permissive here, but list-scope must still deny via MATCH_NOTHING.
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('technician'));

    // When no findMany ran the route guard denied first (also fail-closed) — accept either,
    // but if it DID run, the where must be MATCH_NOTHING (id: { in: [] }).
    if (mockPrisma.lead.findMany.mock.calls.length > 0) {
      const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
      expect(findManyArgs.where.id).toEqual({ in: [] });
    }
  });

  it('returns 401 without auth header', async () => {
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(401);
  });

  it('filters by multiple statuses', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?status=NEW&status=CONTACTED')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toEqual({ in: ['NEW', 'CONTACTED'] });
  });

  // Walkthrough lead statuses, slice 01: the Status filter takes either new status, and sorting by
  // status hands the database the status column itself, whose enum order is the pipeline order
  // (proved against real Postgres in lead-status-walkthrough-migration-db.test.ts).
  it('filters by either walkthrough status', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?status=WALKTHROUGH_SCHEDULED&status=WALKTHROUGH_COMPLETED')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toEqual({ in: ['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED'] });
  });

  it('filters by a single walkthrough status', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads?status=WALKTHROUGH_COMPLETED').set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].where.status).toBe('WALKTHROUGH_COMPLETED');
  });

  it('sorting by status orders by the status column', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads?sortBy=status&sortDir=asc').set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].orderBy[0]).toEqual({ status: 'asc' });
  });

  it('filters by customer ad_source', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?ad_source=Google')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.customer).toEqual({ ad_source: 'Google' });
  });

  it('filters by multiple customer ad_sources', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?ad_source=Google&ad_source=Referral')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.customer).toEqual({ ad_source: { in: ['Google', 'Referral'] } });
  });

  it('filters by job_type', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?job_type=Plumbing')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.job_type).toBe('Plumbing');
  });

  it('filters by assigned_to=UNASSIGNED', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?assigned_to=UNASSIGNED')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_assignees).toEqual({ none: {} });
  });

  // Task 4 (generalized filter engine) — assigned_to becomes multi-select.
  it('filters by multiple assigned_to values (matches either)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/leads?assigned_to=${TEST_USERS.sales.id}&assigned_to=${TEST_USERS.technician.id}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_assignees).toEqual({
      some: { user_id: { in: [TEST_USERS.sales.id, TEST_USERS.technician.id] } },
    });
  });

  // SECURITY (most important test in Task 4): scopeWhereForReq already narrows
  // where.lead_assignees to the SALES rep's own leads. Passing a DIFFERENT
  // user's id via ?assigned_to must NOT widen or replace that row-scope
  // restriction — the generalized facet must preserve the exact no-op gate the
  // hand-rolled code had (`if (scopeWhere.lead_assignees === undefined)`).
  it('SECURITY: assigned_to query param cannot override a row-scoped role\'s own scope', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/leads?assigned_to=${TEST_USERS.technician.id}`)
      .set(authHeader('sales'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    // Must remain the SALES rep's own scope — not widened/replaced by the
    // (different) user id passed in the query string.
    expect(findManyArgs.where.lead_assignees).toEqual({ some: { user_id: TEST_USERS.sales.id } });
  });

  // Task 4 — # of Estimates countRange facet, wired through the live endpoint.
  it('filters by estimates_min/estimates_max (countRange facet)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const atLeastOne = ['lead-with-2-estimates', 'lead-with-5-estimates'];
    const overThree = ['lead-with-5-estimates'];
    (prisma.estimate.groupBy as any).mockImplementation((args: any) => {
      const having = args?.having?.lead_id?._count;
      if (having?.gte !== undefined) return Promise.resolve(atLeastOne.map((id) => ({ lead_id: id })));
      if (having?.gt !== undefined) return Promise.resolve(overThree.map((id) => ({ lead_id: id })));
      return Promise.resolve([]);
    });

    await request(app)
      .get('/api/leads?estimates_min=1&estimates_max=3')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    // min narrows to >=1 estimate, max=3 excludes the 5-estimate lead — net
    // result should be the 2-estimate lead only, expressed as an AND'd
    // in/notIn pair (see filterEngine's mergeIdFilter).
    expect(findManyArgs.where.AND).toEqual([
      { id: { in: atLeastOne } },
      { id: { notIn: overThree } },
    ]);
  });

  it('unassigned stat counts all crew-empty leads regardless of status', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);
    await request(app).get('/api/leads').set(authHeader('admin'));
    const countWheres = mockPrisma.lead.count.mock.calls.map((c: any) => c[0].where);
    const unassigned = countWheres.find(
      (w: any) => JSON.stringify(w.AND) === JSON.stringify([{ lead_assignees: { none: {} } }]),
    );
    expect(unassigned).toBeDefined();
    expect(unassigned.status).toBeUndefined();
  });

  it('ignores invalid status values', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?status=INVALID')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    // The invalid literal is ignored; with the open-pipeline default removed,
    // no status constraint is applied → all statuses are returned.
    expect(findManyArgs.where.status).toBeUndefined();
  });

  it('returns leads list for TECHNICIAN role (CASL allows conditional read)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('technician'));

    // TECHNICIAN has conditional read Lead grant (own walkthroughs) — route guard passes,
    // record-level scoping (Task 11) enforces the condition at DB query time.
    expect(res.status).toBe(200);
  });

  it('should scope stats to own leads for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads').set(authHeader('sales'));

    const salesFilter = { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } };

    // All count calls for stats must include the SALES crew filter
    const countCalls = mockPrisma.lead.count.mock.calls;
    // Skip the first call (total count uses full `where`), check all the remaining stats calls
    const statCountCalls = countCalls.slice(1);
    for (const call of statCountCalls) {
      expect(call[0].where).toMatchObject(salesFilter);
    }
  });

  it('SALES unassigned stat is scoped AND unassigned (some ∩ none → 0), not clobbered (#281)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads').set(authHeader('sales'));

    const countWheres = mockPrisma.lead.count.mock.calls.map((c: any) => c[0].where);
    const unassigned = countWheres.find(
      (w: any) => JSON.stringify(w.AND) === JSON.stringify([{ lead_assignees: { none: {} } }]),
    );
    expect(unassigned).toBeDefined();
    // Scope `some` must co-exist top-level with the AND'd `none` → empty set → tile reads 0.
    expect(unassigned).toMatchObject({ lead_assignees: { some: { user_id: TEST_USERS.sales.id } } });
  });

  it('includes customer_number in nested customer select', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.select.customer.select.customer_number).toBe(true);
  });

  // ─── Date range + status-derived KPI stats ───
  // The list `created_at` filter is a real, user-reproducible param (no ?kpi= token).
  // Won/Lost KPI tiles are all-time status counts → clicking them sets a status filter.

  it('filters created_at >= created_after', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads?created_after=2026-06-01T00:00:00.000Z').set(authHeader('admin'));

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeUndefined();
  });

  it('filters created_at <= created_before and combines both bounds', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?created_after=2026-06-01T00:00:00.000Z&created_before=2026-06-30T23:59:59.999Z')
      .set(authHeader('admin'));

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeInstanceOf(Date);
  });

  it('no longer honors the legacy ?kpi= token', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads?kpi=new_this_week').set(authHeader('admin'));

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.created_at).toBeUndefined();
  });

  it('won/lost stats are all-time status counts (no date constraint)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads').set(authHeader('admin'));

    const countWheres = mockPrisma.lead.count.mock.calls.map((c: any) => c[0].where);
    const wonWhere = countWheres.find((w: any) => w.status === 'WON');
    const lostWhere = countWheres.find((w: any) => w.status === 'LOST');
    expect(wonWhere).toBeDefined();
    expect(lostWhere).toBeDefined();
    expect(wonWhere.updated_at).toBeUndefined();
    expect(lostWhere.lost_at).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads
// ═══════════════════════════════════════════════════════

describe('POST /api/leads', () => {
  const validBody = {
    customer_id: CUSTOMER_FIXTURE.id,
    service_request: 'AC not cooling',
  };

  it('creates lead with existing customer_id', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
        // Existing-customer create now defaults the lead to the customer's primary
        // service location when none is supplied (the column is NOT NULL).
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.lead).toBeDefined();
  });

  // Lead statuses are fixed (walkthrough lead-statuses PRD, D12): create() never passes a
  // status, so every new lead starts at the column's database default, NEW.
  it('creates the lead without a status so the database default (NEW) applies', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let createData: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            createData = args.data;
            return Promise.resolve(LEAD_FIXTURE);
          }),
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    const res = await request(app).post('/api/leads').set(authHeader('admin')).send(validBody);

    expect(res.status).toBe(201);
    expect(createData).toBeDefined();
    expect(createData).not.toHaveProperty('status');
  });

  // Same rule on the inline new_customer branch (a separate tx.lead.create call site).
  it('new_customer: creates the lead without a status so the database default (NEW) applies', async () => {
    mockAuthAs('admin');
    let createData: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({
            id: 'new-cust-id',
            service_locations: [{ id: 'new-primary-loc-id' }],
          }),
        },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            createData = args.data;
            return Promise.resolve(LEAD_FIXTURE);
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: { first_name: 'New', last_name: 'Client', phone: '5551112222' },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(createData).toBeDefined();
    expect(createData).not.toHaveProperty('status');
  });

  it('existing customer_id + a typed phone belonging to a DIFFERENT customer → 409 (cross-customer accretion guard)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // A DIFFERENT customer already owns 5559998888 (relation-aware match excludes the linked one).
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'c0000000-0000-0000-0000-0000000000bb', customer_number: 'C00099',
      first_name: 'Other', last_name: 'Person', company_name: null,
      email: null, phone: '5559998888', is_active: true, archived_at: null,
      service_locations: [], phones: [], extra_emails: [],
    }]);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling', phone: '5559998888' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing.id).toBe('c0000000-0000-0000-0000-0000000000bb');
    // the linked customer is excluded from the cross-customer lookup
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.id).toEqual({ not: CUSTOMER_FIXTURE.id });
  });

  it('existing customer_id + cross-customer phone match, ?override=true → 201 (accrete anyway)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'c0000000-0000-0000-0000-0000000000bb', customer_number: 'C00099',
      first_name: 'Other', last_name: null, company_name: null,
      email: null, phone: '5559998888', is_active: true, archived_at: null,
      service_locations: [], phones: [], extra_emails: [],
    }]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          update: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({ phone: CUSTOMER_FIXTURE.phone, email: null, phones: [], extra_emails: [] }),
        },
        customerPhone: { create: vi.fn() },
        customerEmail: { create: vi.fn() },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads?override=true')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling', phone: '5559998888' });

    expect(res.status).toBe(201);
  });

  it('creates lead with new_customer (inline)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({
            id: 'new-cust-id',
            service_locations: [{ id: 'new-primary-loc-id' }],
          }),
        },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: {
            address_line1: '100 Test Ave',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
  });

  it('creates lead with new_customer missing last_name + email (both optional)', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      customerCreate = vi.fn().mockResolvedValue({
        id: 'new-cust-id',
        service_locations: [{ id: 'new-primary-loc-id' }],
      });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { create: customerCreate },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '5551112222',
          location: {
            address_line1: '100 Test Ave',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    // Omitted email must persist as null, not crash on email.trim().
    const createArgs = customerCreate!.mock.calls[0][0];
    expect(createArgs.data.email ?? null).toBeNull();
  });

  it('persists new_customer.phone_ext onto the created customer (#530)', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      customerCreate = vi.fn().mockResolvedValue({
        id: 'new-cust-id',
        service_locations: [{ id: 'new-primary-loc-id' }],
      });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { create: customerCreate },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '5551112222',
          phone_ext: '102',
          location: {
            address_line1: '100 Test Ave',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    // newCustomerSchema is a plain z.object, so an unknown `phone_ext` would be
    // silently STRIPPED (never a 400) and never reach the customer row.
    expect(customerCreate!.mock.calls[0][0].data.phone_ext).toBe('102');
  });

  it('creates lead with new_customer email only, no phone (SERV10X-35)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({
            id: 'new-cust-id',
            service_locations: [{ id: 'new-primary-loc-id' }],
          }),
        },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          email: 'new.client@example.com',
          location: {
            address_line1: '100 Test Ave',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for new_customer with neither phone nor email (SERV10X-35)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(400);
  });

  it('creates a lead with new_customer company-only, no first_name (Chestnut regression)', async () => {
    mockAuthAs('admin');
    (allocateNumber as any).mockResolvedValue('L00099');
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) },
        lead: { create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        timelineEvent: { create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: { company_name: 'Chestnut', phone: '5551234567' },
        service_request: 'AC not cooling',
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for new_customer with neither first_name nor company_name', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: { phone: '5551234567' },
        service_request: 'AC not cooling',
      });
    expect(res.status).toBe(400);
  });

  it('new_customer inline create allocates customer_number + sets kind/segment (NOT-NULL safety)', async () => {
    // Regression: the inline new_customer path must satisfy the same NOT-NULL,
    // no-default columns as POST /api/customers (customer_number/kind/segment),
    // or tx.customer.create throws against a real DB → 500 "Failed to create lead".
    mockAuthAs('admin');
    // beforeEach's vi.resetAllMocks() wipes setup.ts's allocateNumber impl, so
    // stub it here to prove the controller threads its result into customer_number.
    vi.mocked(allocateNumber).mockImplementation(((_tx: unknown, entity: string) =>
      Promise.resolve(entity === 'customer' ? 'C00042' : 'L00001')) as typeof allocateNumber);
    const customerCreate = vi.fn().mockResolvedValue({
      id: 'new-cust-id',
      service_locations: [{ id: 'new-primary-loc-id' }],
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { create: customerCreate },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(LEAD_FIXTURE),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: {
            address_line1: '100 Test Ave',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(allocateNumber).toHaveBeenCalledWith(expect.anything(), 'customer', expect.anything());
    expect(customerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customer_number: 'C00042',
          kind: 'PERSON',
          segment: 'RESIDENTIAL',
        }),
      }),
    );
  });

  it('new_customer with a duplicate email/phone → 409 { error:"duplicate", existing } (Fixes #42)', async () => {
    mockAuthAs('admin');
    const existingRow = {
      id: 'c0000000-0000-0000-0000-0000000000ee',
      customer_number: 'C00042',
      first_name: 'Existing',
      last_name: 'Person',
      company_name: null,
      email: 'new.client@example.com',
      phone: '5551112222',
      is_active: true,
      archived_at: null,
      service_locations: [{ address_line1: '1 Old Rd', city: 'Austin', state: 'TX' }],
      phones: [],
      extra_emails: [],
    };
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing).toMatchObject({
      id: existingRow.id,
      customer_number: 'C00042',
      email: 'new.client@example.com',
      phone: '5551112222',
      primary_address: { line1: '1 Old Rd', city: 'Austin', state: 'TX' },
    });
    // org-scoped lookup
    const findArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findArgs.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('new_customer ?override=true bypasses the duplicate guard → 201', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([
      {
        id: 'c0000000-0000-0000-0000-0000000000ee',
        customer_number: 'C00042',
        first_name: 'Existing',
        last_name: 'Person',
        company_name: null,
        email: 'new.client@example.com',
        phone: '5551112222',
        is_active: true,
        archived_at: null,
        service_locations: [],
        phones: [],
        extra_emails: [],
      },
    ]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }),
        },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads?override=true')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
  });

  it('new_customer ?override=true writes a CUSTOMER_CREATED timeline event recording the bypassed duplicate (Fixes #42)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([
      {
        id: 'c0000000-0000-0000-0000-0000000000ee',
        customer_number: 'C00042',
        first_name: 'Existing',
        last_name: 'Person',
        company_name: null,
        email: 'new.client@example.com',
        phone: '5551112222',
        is_active: true,
        archived_at: null,
        service_locations: [],
        phones: [],
        extra_emails: [],
      },
    ]);
    let txTimelineCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txTimelineCreate = vi.fn().mockResolvedValue({});
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }),
        },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        timelineEvent: { create: txTimelineCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads?override=true')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    // The bypass MUST leave an audit trail on the newly-created customer — the only
    // forward record of a knowingly-duplicate create (no merge tool).
    expect(txTimelineCreate!).toHaveBeenCalledTimes(1);
    const eventData = txTimelineCreate!.mock.calls[0][0].data;
    expect(eventData).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      entity_type: 'CUSTOMER',
      entity_id: 'new-cust-id',
      event_type: 'CUSTOMER_CREATED',
      metadata: {
        duplicate_override: true,
        matched_customer_id: 'c0000000-0000-0000-0000-0000000000ee',
        matched_customer_number: 'C00042',
      },
    });
  });

  it('new_customer without a duplicate writes NO timeline event (bypass-only audit)', async () => {
    mockAuthAs('admin');
    // No duplicate match (default empty findMany) → a normal inline customer create.
    let txTimelineCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txTimelineCreate = vi.fn().mockResolvedValue({});
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: {
          create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }),
        },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        timelineEvent: { create: txTimelineCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          email: 'new.client@example.com',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(txTimelineCreate!).not.toHaveBeenCalled();
  });

  it('includes extra fields (job_type, scheduled_start, service address) and sets ad_source on customer', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    let txCustomerUpdate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, job_type: 'HVAC Service' });
      txCustomerUpdate = vi.fn().mockResolvedValue({ ...CUSTOMER_FIXTURE, ad_source: 'Google' });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        customer: { update: txCustomerUpdate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'loc-from-legacy' }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        ...validBody,
        job_type: 'HVAC Service',
        ad_source: 'Google',
        scheduled_start: '2026-03-01T09:00:00.000Z',
        service_address_line1: '456 Oak Ave',
        service_city: 'Dallas',
        service_state: 'TX',
        service_zip: '75201',
      });

    expect(res.status).toBe(201);
    // ad_source must NOT appear on the lead create data
    const leadCreateData = txLeadCreate!.mock.calls[0][0].data;
    expect(leadCreateData.ad_source).toBeUndefined();
    // ad_source must be written to the customer
    expect(txCustomerUpdate!.mock.calls[0][0].data.ad_source).toBe('Google');
  });

  it('auto-assigns to self for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: txLeadCreate,
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    await request(app)
      .post('/api/leads')
      .set(authHeader('sales'))
      .send(validBody);

    const createArgs = txLeadCreate!.mock.calls[0][0];
    // The SINGLE owner is written into the M2M spine (commission_owner_id + one nested
    // lead_assignees create) so the Owned-scope key is correct from creation.
    expect(createArgs.data.commission_owner_id).toBe(TEST_USERS.sales.id);
    expect(createArgs.data.lead_assignees.create.user_id).toBe(TEST_USERS.sales.id);
  });

  it('does not auto-assign for ADMIN role', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: txLeadCreate,
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send(validBody);

    const createArgs = txLeadCreate!.mock.calls[0][0];
    // No auto-assign for ADMIN: neither the owner column nor the M2M mirror is written.
    expect(createArgs.data.commission_owner_id).toBeUndefined();
    expect(createArgs.data.lead_assignees).toBeUndefined();
  });

  // #389 — non-SALES creators can pick an owner at creation via body.assigned_to.
  it('ADMIN can assign an owner at creation', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // The eligibility guard reads the target via prisma.user.findUnique, whose
    // mockAuthAs default resolves TEST_USERS.sales (owner-eligible, active) by id.
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: txLeadCreate,
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ ...validBody, assigned_to: TEST_USERS.sales.id });

    const createArgs = txLeadCreate!.mock.calls[0][0];
    expect(createArgs.data.commission_owner_id).toBe(TEST_USERS.sales.id);
    expect(createArgs.data.lead_assignees.create.user_id).toBe(TEST_USERS.sales.id);
  });

  it('assigns a DISPATCHER owner at creation (#366: all active users owner-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // Target TEST_USERS.dispatcher (DISPATCHER, active) — owner-eligible since #366.
    // mockAuthAs's default findUnique resolves it by id.
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: txLeadCreate,
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(txMock);
    });

    await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ ...validBody, assigned_to: TEST_USERS.dispatcher.id });

    const createArgs = txLeadCreate!.mock.calls[0][0];
    expect(createArgs.data.commission_owner_id).toBe(TEST_USERS.dispatcher.id);
    expect(createArgs.data.lead_assignees.create.user_id).toBe(TEST_USERS.dispatcher.id);
  });

  it('rejects an inactive/cross-org assignee at creation', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // A uuid not in TEST_USERS → the default findUnique resolves null (cross-org /
    // nonexistent) → 400, no write.

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ ...validBody, assigned_to: '00000000-0000-0000-0000-777777777777' });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // A TENANT-CLAUSE probe. TEST_USERS.orgB_admin is ACTIVE and owner-eligible (ADMIN), so
  // neither the is_active check nor isOwnerEligible can refuse it — the ONLY thing that can
  // is the `...tenantWhere(req)` in the create-path eligibility lookup. The sibling test
  // above uses a uuid absent from TEST_USERS, which the default mock resolves to null on the
  // `id` match alone, so it would stay GREEN if someone dropped the tenant clause.
  //
  // mockAuthAs's default user.findUnique matches on `where.id` and IGNORES organization_id,
  // so it is overridden here with one that honours the tenant clause. Without that override
  // this test passes against a guard written as `where: { id: bodyAssignee }` — a false green.
  it('SECURITY: refuses an out-of-org assignee at creation (tenant clause is load-bearing)', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string; organization_id?: string } }) => {
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        if (!match) return Promise.resolve(null);
        if (args.where.organization_id && match.organization_id !== args.where.organization_id) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...match, organization: TEST_ORG });
      }
    );
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ ...validBody, assigned_to: TEST_USERS.orgB_admin.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when customer_id not found', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: '00000000-0000-0000-0000-999999999999', service_request: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Customer not found');
  });

  it('returns 400 when both customer_id and new_customer provided', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        new_customer: { first_name: 'A', last_name: 'B', phone: '5551111111', location: { address_line1: 'x', city: 'y', state: 'TX', zip: '78701' } },
        service_request: 'Test',
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 when neither customer_id nor new_customer provided', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ service_request: 'Test' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when service_request missing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id });

    expect(res.status).toBe(400);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('technician'))
      .send(validBody);

    expect(res.status).toBe(403);
  });

  it('creates a lead for an existing customer that has NO service location (location now optional)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let leadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      leadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: leadCreate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      return fn(txMock);
    });
    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });
    expect(res.status).toBe(201);
    expect(leadCreate!.mock.calls[0][0].data.service_location_id).toBeNull();
  });

  it('creates a lead with a new_customer and NO location (location now optional)', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    let leadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      customerCreate = vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] });
      leadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { create: customerCreate },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: leadCreate },
      };
      return fn(txMock);
    });
    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ new_customer: { first_name: 'NoAddr', phone: '5551112222' }, service_request: 'Phone enquiry, no address yet' });
    expect(res.status).toBe(201);
    expect(customerCreate!.mock.calls[0][0].data.service_locations).toBeUndefined();
    const leadData = leadCreate!.mock.calls[0][0].data;
    expect(leadData.service_location_id).toBeNull();
    expect(leadData.service_address_line1).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/:id
// ═══════════════════════════════════════════════════════

describe('GET /api/leads/:id', () => {
  it('returns lead details', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe(LEAD_FIXTURE.id);
  });

  // PR-D2: walkthrough_needed is a deleted concept, not merely hidden - the detail select must
  // not read the raw column at all.
  it('does not select walkthrough_needed', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    const selectArg = (prisma.lead.findUnique as any).mock.calls[0][0].select;
    expect(selectArg.walkthrough_needed).toBeUndefined();
  });

  it('includes each estimate\'s job in the response', async () => {
    mockAuthAs('admin');
    const leadWithEstimates = {
      ...LEAD_FIXTURE,
      estimates: [
        {
          id: 'f0000000-0000-0000-0000-000000000001',
          estimate_number: 'E00001',
          status: 'DRAFT',
          total_amount: 1062.5,
          created_at: new Date('2026-01-20'),
          creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
          job: { id: 'a0000000-0000-0000-0000-000000000001', job_number: 'J00001', status: 'UNSCHEDULED' },
        },
        {
          id: 'f0000000-0000-0000-0000-000000000002',
          estimate_number: 'E00002',
          status: 'DRAFT',
          total_amount: 2000,
          created_at: new Date('2026-01-21'),
          creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
          job: null,
        },
      ],
    };
    mockPrisma.lead.findUnique.mockResolvedValue(leadWithEstimates);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates[0].job).toEqual({ id: 'a0000000-0000-0000-0000-000000000001', job_number: 'J00001', status: 'UNSCHEDULED' });
    expect(res.body.lead.estimates[1].job).toBeNull();
    // Verify the select shape includes job for each estimate
    expect((prisma.lead.findUnique as any).mock.calls[0][0].select.estimates.select.job)
      .toEqual({ select: { id: true, job_number: true, status: true } });
  });

  // #2048 — the ANCHOR pointer (`job_id` / `job_link`), alongside the PROVENANCE `job` relation
  // above. The multi-estimate convert path attaches through this pointer and deliberately leaves
  // `job` null (job.controller.ts:2292-2340), so a folded estimate's row must carry `job_id` and a
  // populated `job_link` too, or the frontend keeps offering it as convertible.
  it('includes each estimate\'s job_id and job_link in the response (#2048)', async () => {
    mockAuthAs('admin');
    const leadWithEstimates = {
      ...LEAD_FIXTURE,
      estimates: [
        {
          id: 'f0000000-0000-0000-0000-000000000003',
          estimate_number: 'E00003',
          status: 'WON',
          total_amount: 1500,
          created_at: new Date('2026-01-22'),
          creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
          // Attached only through the anchor FK — PROVENANCE stays null.
          job: null,
          job_id: 'a0000000-0000-0000-0000-000000000009',
          job_link: { id: 'a0000000-0000-0000-0000-000000000009', job_number: 'J00042', status: 'UNSCHEDULED' },
        },
      ],
    };
    mockPrisma.lead.findUnique.mockResolvedValue(leadWithEstimates);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const est = res.body.lead.estimates[0];
    expect(est.job).toBeNull();
    expect(est.job_id).toBe('a0000000-0000-0000-0000-000000000009');
    expect(est.job_link).toEqual({ id: 'a0000000-0000-0000-0000-000000000009', job_number: 'J00042', status: 'UNSCHEDULED' });

    // Verify the select shape carries both new fields.
    const estimatesSelect = (prisma.lead.findUnique as any).mock.calls[0][0].select.estimates.select;
    expect(estimatesSelect.job_id).toBe(true);
    expect(estimatesSelect.job_link).toEqual({ select: { id: true, job_number: true, status: true } });
  });

  it('returns 404 for non-existent lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/leads/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('allows SALES to view own lead', async () => {
    mockAuthAs('sales');
    // LEAD_FIXTURE is owned by sales via the M2M (lead_assignees → TEST_USERS.sales.id).
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // #106 P1: getById now gates visibility via canAccessRow's scoped findFirst — owned → visible.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('returns 403 for SALES viewing another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      // Owned-scope mirrors the owner into lead_assignees; point it at admin so SALES is denied.
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/leads/:id
// ═══════════════════════════════════════════════════════

describe('PATCH /api/leads/:id', () => {
  it('updates lead fields', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, service_request: 'Updated request' });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_request: 'Updated request' });

    expect(res.status).toBe(200);
    expect(res.body.lead.service_request).toBe('Updated request');
  });

  it('allows ADMIN to update status', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'CONTACTED' });

    // Spec #1751 D6: the status is written by transitionLeadStatus (an updateMany), and the
    // ledger entry that makes time-in-stage computable is written alongside it.
    const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('CONTACTED');
    expect(statusChangeEvents()).toHaveLength(1);
    expect(statusChangeEvents()[0].metadata).toMatchObject({ from: 'NEW', to: 'CONTACTED' });
  });

  it('strips status from SALES update', async () => {
    mockAuthAs('sales');
    // LEAD_FIXTURE is owned by sales via the M2M (lead_assignees → TEST_USERS.sales.id).
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // #106 P1: ownership now enforced via canAccessRow's scoped findFirst — owned → visible.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    mockPrisma.lead.update.mockResolvedValue(LEAD_FIXTURE);

    await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ status: 'CONTACTED', service_request: 'Updated' });

    const updateArgs = mockPrisma.lead.update.mock.calls[0][0];
    expect(updateArgs.data.service_request).toBe('Updated');
    // Spec #1751 D6 moved the status out of this statement for EVERY caller, so
    // `update.data.status === undefined` no longer distinguishes a stripped status from an
    // allowed one. The refusal is now proved where the status actually gets written: no
    // guarded write, and no ledger entry claiming the lead moved.
    expect(leadStatusWrites(mockPrisma.lead.updateMany)).toHaveLength(0);
    expect(statusChangeEvents()).toHaveLength(0);
  });

  // PR-D2: walkthrough_needed is deleted entirely (Ran's call - see the "Decision update" note
  // in md_files/specs/leads/2026-07-28-walkthrough-as-entity.md) rather than kept as a bucket
  // toggle. A PATCH can no longer set it - the field is not in updateLeadSchema at all, so zod
  // strips it before it ever reaches leadData.
  it('ignores walkthrough_needed in the PATCH body - it is no longer an accepted field', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.update.mockResolvedValue(LEAD_FIXTURE);

    await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ walkthrough_needed: false, service_request: 'Updated' });

    const updateArgs = mockPrisma.lead.update.mock.calls[0][0];
    expect(updateArgs.data.walkthrough_needed).toBeUndefined();
    expect(updateArgs.data.service_request).toBe('Updated');
  });

  it('writes ad_source through to the customer when updating a lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    let txCustomerUpdate: ReturnType<typeof vi.fn>;
    let txLeadUpdate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txCustomerUpdate = vi.fn().mockResolvedValue({ ...CUSTOMER_FIXTURE, ad_source: 'Referral' });
      txLeadUpdate = vi.fn().mockResolvedValue({ ...LEAD_FIXTURE });
      const txMock = {
        customer: { update: txCustomerUpdate },
        lead: { update: txLeadUpdate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ ad_source: 'Referral' });

    expect(res.status).toBe(200);
    // ad_source must NOT appear on the lead update data
    const leadUpdateData = txLeadUpdate!.mock.calls[0][0].data;
    expect(leadUpdateData.ad_source).toBeUndefined();
    // ad_source must be written to the customer
    expect(txCustomerUpdate!.mock.calls[0][0].data.ad_source).toBe('Referral');
  });

  it('returns 403 for SALES updating another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ service_request: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/leads/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'))
      .send({ service_request: 'Updated' });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// #106 P1 — NESTED Team/Location scope (canAccessRow)
// ═══════════════════════════════════════════════════════
//
// A role scoped via TEAM (lead_assignees.some.user.department_id) carries a NESTED
// to-one→to-many condition. The OLD per-instance check req.ability.can('…', subject('Lead', row))
// THROWS "equals does not supports comparison of arrays and objects" on that shape → the
// handler's try/catch turns it into a 500 (fail-OPEN-ish: the owner can't act; worse, a
// non-owner would 500 instead of a clean 403). canAccessRow resolves visibility through SQL
// (a scoped findFirst), so it is nested-safe: owner → 200, non-owner → 403. Proven on the base
// update AND a lifecycle verb (contact). Single-hop Owned (SALES via lead_assignees.some.user_id)
// stays green — those tests live above.
describe('PATCH/contact with NESTED Team scope (#106 P1 — must not 500)', () => {
  // A custom SALES grant set scoped by TEAM: read/update/contact on Lead conditioned on the
  // performer's department, NOT a flat user_id. This is the nested shape can() throws on.
  const TEAM_COND = { lead_assignees: { some: { user: { department_id: '{{teamId}}' } } } };
  const SALES_TEAM_GRANTS = [
    { role: 'SALES', action: 'read', subject: 'Lead', conditions: TEAM_COND },
    { role: 'SALES', action: 'update', subject: 'Lead', conditions: TEAM_COND },
    { role: 'SALES', action: 'contact', subject: 'Lead', conditions: TEAM_COND },
    // Phase B (technician redesign): the walkthrough routes re-gated from `update Lead` to the new
    // `perform_walkthrough` capability. Carry it (team-conditioned) so this team-scoped SALES
    // fixture still reaches POST /:id/walkthrough — the canAccessRow probe still keys off `read`.
    { role: 'SALES', action: 'perform_walkthrough', subject: 'Lead', conditions: TEAM_COND },
  ];

  // mockAuthAs('sales') wires auth, but the team scope needs req.user.department_id populated
  // (resolveAppUser selects it) and the nested grant loaded for the SALES role.
  function mockTeamScopedSales() {
    mockAuthAs('sales');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.sales.id) {
          return Promise.resolve({ ...TEST_USERS.sales, department_id: 'dept-9', location_id: null, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      },
    );
    (prisma.rolePermission.findMany as any).mockResolvedValue(SALES_TEAM_GRANTS);
  }

  it('base update: owner-by-team → 200 (NOT 500 — canAccessRow probe matches)', async () => {
    mockTeamScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // canAccessRow runs one scoped findFirst; visible (in the team) → returns the id.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, service_request: 'Updated via team' });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ service_request: 'Updated via team' });

    expect(res.status).toBe(200);
    expect(res.body.lead.service_request).toBe('Updated via team');
  });

  it('base update: NOT in the team → 403 (canAccessRow probe → null), never 500', async () => {
    mockTeamScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // Scoped findFirst sees nothing → not visible under the team scope.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ service_request: 'Updated via team' });

    expect(res.status).toBe(403);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  // "lifecycle verb (contact)" cases were removed by D6, PR-B2. Spec #1751 D5 REINSTATED the
  // door as a hand CORRECTION and gave contacted_at real automatic writers — the "inferred from
  // outbound activity" claim this comment used to make described an inference nobody ever built.
  // Coverage for both lives in lead-contact-clock.test.ts.

  // getById is the most-hit endpoint and was the reproduced 500: it still ran the throwing
  // req.ability.can('read', subject('Lead', row)) matcher, which blows up on the nested
  // Team condition. canAccessRow's scoped findFirst makes it owner → 200, non-owner → 403.
  it('getById: owner-by-team → 200 (NOT 500 — canAccessRow probe matches)', async () => {
    mockTeamScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe(LEAD_FIXTURE.id);
  });

  it('getById: NOT in the team → 403 (probe → null), never 500', async () => {
    mockTeamScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('updateWalkthrough: owner-by-team → 200 (NOT 500 — canAccessRow probe matches)', async () => {
    mockTeamScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    // walkthrough_notes in the JSON response is now PROJECTED from the current (D15) visit
    // (leadDetailSelect's `walkthroughs` relation), not the raw legacy column the mock sets.
    const currentVisit = {
      id: 'wt-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01'), duration_minutes: 60,
      completed_at: null, notes: 'Updated via team', cancelled_at: null, cancelled_reason: null,
      cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-03-01'),
    };
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, visits: [currentVisit] });
    mockPrisma.visit.findMany.mockResolvedValue([currentVisit]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('sales'))
      .send({ walkthrough_notes: 'Updated via team' });

    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_notes).toBe('Updated via team');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/stats (getStats) — RBAC QA GAP-3
// ═══════════════════════════════════════════════════════
// The dedicated stats endpoint built total/new_this_week/unassigned/won_this_month/
// lost_this_month from `tenantWhere` ONLY — so a row-scoped SALES rep (own-lead
// scoped on the list) saw ORG-WIDE lead totals/won/lost. The counts must be scoped
// with the SAME role-scope the list endpoint uses (scopeWhereForReq):
// ADMIN/DISPATCHER stay org-wide ({} scope → no extra restriction); SALES is
// own-lead-scoped (lead_assignees.some.user_id == me) on EVERY count.
describe('GET /api/leads/stats — role-scoped aggregates (GAP-3)', () => {
  it('scopes ALL stat counts to own leads for SALES (not org-wide)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads/stats').set(authHeader('sales'));

    expect(res.status).toBe(200);

    const salesFilter = { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } };
    const countCalls = mockPrisma.lead.count.mock.calls;
    // getStats fires exactly 5 counts; every one must carry the SALES own-lead scope.
    expect(countCalls).toHaveLength(5);
    for (const call of countCalls) {
      expect(call[0].where).toMatchObject(salesFilter);
    }
  });

  it('SALES unassigned count keeps both the own-scope AND the none filter (#281)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads/stats').set(authHeader('sales'));

    const countWheres = mockPrisma.lead.count.mock.calls.map((c: any) => c[0].where);
    const unassigned = countWheres.find(
      (w: any) => JSON.stringify(w.AND) === JSON.stringify([{ lead_assignees: { none: {} } }]),
    );
    expect(unassigned).toBeDefined();
    expect(unassigned).toMatchObject({ lead_assignees: { some: { user_id: TEST_USERS.sales.id } } });
    // An unassigned lead with a walkthrough booked or done still needs an owner (walkthrough
    // lead statuses, slice 01), so both walkthrough statuses count.
    expect(unassigned.status).toEqual({ in: ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED'] });
  });

  it('keeps stat counts org-wide for ADMIN (no row-scope condition)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads/stats').set(authHeader('admin'));

    expect(res.status).toBe(200);

    const countCalls = mockPrisma.lead.count.mock.calls;
    expect(countCalls).toHaveLength(5);
    // ADMIN scope is {} → no OWN-lead `some` restriction on any count (org-wide).
    // (The `unassigned` count legitimately carries `lead_assignees: { none: {} }`;
    // what must NEVER appear for ADMIN is the requester-scoping `{ some: { user_id } }`.)
    for (const call of countCalls) {
      expect((call[0].where.lead_assignees as { some?: unknown } | undefined)?.some).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/assign
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/assign', () => {
  // assign() mirrors the SINGLE owner into commission_owner_id + ONE lead_assignees row
  // inside a $transaction. Wire the tx client so tx.leadAssignee.* + tx.lead.update resolve.
  function wireAssignTx(updated: any) {
    const txLeadAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txLeadAssigneeCreate = vi.fn().mockResolvedValue({});
    const txLeadUpdate = vi.fn().mockResolvedValue(updated);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        leadAssignee: { deleteMany: txLeadAssigneeDeleteMany, create: txLeadAssigneeCreate },
        lead: { update: txLeadUpdate },
      }),
    );
    return { txLeadAssigneeDeleteMany, txLeadAssigneeCreate, txLeadUpdate };
  }

  it('assigns lead to a valid SALES user (SINGLE owner: commission_owner_id + one mirrored lead_assignees row)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // Override user.findUnique to return SALES user for the target (include organization_id)
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.sales.id) {
          return Promise.resolve({ ...TEST_USERS.sales, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    // Owner eligibility is now a fixed-code constant (Decision #4): SALES is owner-eligible.
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    // commission_owner_id is set from the assigned_to request field
    expect(tx.txLeadUpdate.mock.calls[0][0].data.commission_owner_id).toBe(TEST_USERS.sales.id);
    // Exactly one mirrored lead_assignees row (delete-all, then create one)
    expect(tx.txLeadAssigneeDeleteMany).toHaveBeenCalledWith({ where: { lead_id: LEAD_FIXTURE.id } });
    expect(tx.txLeadAssigneeCreate).toHaveBeenCalledTimes(1);
    expect(tx.txLeadAssigneeCreate.mock.calls[0][0].data.user_id).toBe(TEST_USERS.sales.id);
  });

  // Bug #11 — owner-eligibility was narrower (ADMIN/SALES) than the assignable pool
  // (ADMIN/SALES/TECHNICIAN) the AssignLeadDialog offers, so a TECHNICIAN shown in the
  // picker was rejected with "not eligible to be assigned as a lead owner". A TECHNICIAN
  // must now be assignable as a lead owner.
  it('assigns lead to a valid TECHNICIAN user (owner-eligibility mirrors the assignable pool)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.technician.id) {
          return Promise.resolve({ ...TEST_USERS.technician, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.technician.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.technician.id });

    expect(res.status).toBe(200);
    expect(tx.txLeadUpdate.mock.calls[0][0].data.commission_owner_id).toBe(TEST_USERS.technician.id);
    expect(tx.txLeadAssigneeCreate).toHaveBeenCalledTimes(1);
    expect(tx.txLeadAssigneeCreate.mock.calls[0][0].data.user_id).toBe(TEST_USERS.technician.id);
  });

  it('clears the owner when assigned_to is null (commission_owner_id + all lead_assignees rows)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: null });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: null });

    expect(res.status).toBe(200);
    expect(tx.txLeadUpdate.mock.calls[0][0].data.commission_owner_id).toBeNull();
    // All lead_assignees rows dropped, none created
    expect(tx.txLeadAssigneeDeleteMany).toHaveBeenCalledWith({ where: { lead_id: LEAD_FIXTURE.id } });
    expect(tx.txLeadAssigneeCreate).not.toHaveBeenCalled();
  });

  it('assigns lead to a DISPATCHER (#366: all active users owner-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.dispatcher.id) {
          return Promise.resolve({ ...TEST_USERS.dispatcher, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.dispatcher.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(200);
    expect(tx.txLeadUpdate.mock.calls[0][0].data.commission_owner_id).toBe(TEST_USERS.dispatcher.id);
    expect(tx.txLeadAssigneeCreate).toHaveBeenCalledTimes(1);
    expect(tx.txLeadAssigneeCreate.mock.calls[0][0].data.user_id).toBe(TEST_USERS.dispatcher.id);
  });

  it('rejects assigning to inactive user', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.sales.id) {
          return Promise.resolve({ id: TEST_USERS.sales.id, role: 'SALES', is_active: false });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found or inactive');
  });

  it('rejects when target user not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === '00000000-0000-0000-0000-999999999999') {
          return Promise.resolve(null);
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: '00000000-0000-0000-0000-999999999999' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/assign')
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(404);
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('sales'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(403);
  });

  it('allows DISPATCHER to assign', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.sales.id) {
          return Promise.resolve({ ...TEST_USERS.sales, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    // loadGrantsFor will call rolePermission.findMany for the SALES target user.
    // mockAuthAs('dispatcher') already set up a rolePermission mock for DISPATCHER.
    // Override to return SALES default grants when looking up target user grants.
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) => {
        return Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role));
      }
    );
    wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
  });

  // ─── GAP-4: per-instance ownership check on assign ──────────────────────
  // Every other lead mutator (update/delete/contact/mark-lost/cancel/notes/walkthrough)
  // gates the loaded row with canAccessRow; assign relied on the route guard ONLY. The
  // route guard (canDo('assign','Lead')) is a BARE-subject check — it does not bind the
  // row — so a row-scoped principal that holds `assign` could reassign a lead it cannot
  // access. These tests grant SALES an own-scoped `assign Lead` (+ the OWN_LEAD `read`
  // canAccessRow keys on) and prove the instance check blocks a foreign lead.
  function mockAssignScopedSales() {
    mockAuthAs('sales');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { role: 'SALES', action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
      { role: 'SALES', action: 'assign', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
  }

  it('blocks a row-scoped user from assigning a lead they cannot access (canAccessRow → 403)', async () => {
    mockAssignScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // canAccessRow's scoped findFirst sees nothing → lead is outside the SALES own-scope.
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('sales'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(403);
    // No reassignment performed.
    expect(tx.txLeadUpdate).not.toHaveBeenCalled();
    expect(tx.txLeadAssigneeDeleteMany).not.toHaveBeenCalled();
  });

  it('allows a row-scoped user to assign a lead they CAN access (canAccessRow → 200)', async () => {
    mockAssignScopedSales();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // canAccessRow's scoped findFirst matches → lead is within the SALES own-scope.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('sales'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(tx.txLeadUpdate).toHaveBeenCalledTimes(1);
  });

  it('still lets ADMIN assign without a per-instance query (fast-path)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // ADMIN scope is {} → canAccessRow fast-paths true; this must NOT be consulted.
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    const tx = wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(tx.txLeadUpdate).toHaveBeenCalledTimes(1);
  });

  // ─── #585: sold-by (owner) change → LEAD timeline event ─────────────────
  it('writes a LEAD OWNER_CHANGED timeline event when the owner changes', async () => {
    mockAuthAs('admin');
    // LEAD_FIXTURE.commission_owner_id = sales; assigning to admin is a real owner change.
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.admin.id) {
          return Promise.resolve({ ...TEST_USERS.admin, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    wireAssignTx({
      ...LEAD_FIXTURE,
      commission_owner_id: TEST_USERS.admin.id,
      commission_owner: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin', email: 'admin@test.com' },
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.admin.id });

    expect(res.status).toBe(200);
    expect(prisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'LEAD',
          entity_id: LEAD_FIXTURE.id,
          event_type: 'OWNER_CHANGED',
          organization_id: ALPHA_ORG_ID,
        }),
      }),
    );
  });

  it('does not write an OWNER_CHANGED event when re-assigning the same owner', async () => {
    mockAuthAs('admin');
    // Re-assign to the current owner (sales) → previousOwnerId === assigned_to → no event.
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.sales.id) {
          return Promise.resolve({ ...TEST_USERS.sales, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );
    wireAssignTx({ ...LEAD_FIXTURE });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign: this handler writes the CURRENT visit's (D15) own
// notes/duration_minutes fields on the Walkthrough row - PR-D2 dropped the legacy
// Lead.walkthrough_notes/walkthrough_duration_minutes columns this used to dual-write, so the
// Walkthrough row is now the sole target. `mockPrisma.visit.findMany` defaults to `[]` in
// setup.ts, so `findCurrentWalkthroughForLead` resolves no current visit and the Walkthrough-row
// write is skipped unless a test explicitly stocks a walkthrough row.
describe('POST /api/leads/:id/walkthrough (notes/duration update)', () => {
  beforeEach(() => {
    // Default: no current visit — findCurrentWalkthroughForLead resolves null and the extra
    // Walkthrough-row write is skipped. Tests that need a current visit override this.
    mockPrisma.visit.findMany.mockResolvedValue([]);
  });

  it('updates walkthrough notes successfully', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      walkthrough_notes: 'Updated notes',
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_notes: 'Updated notes' });

    expect(res.status).toBe(200);
  });

  it('updates walkthrough duration', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // walkthrough_duration_minutes in the JSON response is now PROJECTED from the current (D15)
    // visit, not the raw legacy column the mock sets.
    const currentVisit = {
      id: 'wt-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01'), duration_minutes: 120,
      completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
      cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-03-01'),
    };
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      visits: [currentVisit],
    });
    mockPrisma.visit.findMany.mockResolvedValue([currentVisit]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_duration_minutes: 120 });

    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_duration_minutes).toBe(120);
  });

  it('also writes notes/duration onto the CURRENT (D15) Walkthrough row, not just the legacy Lead columns', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, walkthrough_notes: 'On-site notes' });
    mockPrisma.visit.findMany.mockResolvedValue([
      { id: 'wt-scheduled-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01'), duration_minutes: 60, completed_at: null, cancelled_at: null, created_at: new Date('2026-03-01') },
    ]);
    mockPrisma.visit.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_notes: 'On-site notes', walkthrough_duration_minutes: 75 });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wt-scheduled-1' },
        data: expect.objectContaining({ notes: 'On-site notes', duration_minutes: 75 }),
      }),
    );
    // PR-D2: the legacy Lead columns are dropped - the lead update itself carries no data now,
    // the Walkthrough row above is the sole write target.
    const leadUpdateCall = mockPrisma.lead.update.mock.calls[0][0];
    expect(leadUpdateCall.data).toEqual({});
  });

  it('skips the Walkthrough-row write when the lead has no current (D15) visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'NEW' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, walkthrough_notes: 'Pre-visit note' });
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_notes: 'Pre-visit note' });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('returns 403 for SALES on another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('sales'))
      .send({ walkthrough_notes: 'Test' });

    expect(res.status).toBe(403);
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/walkthrough')
      .set(authHeader('admin'))
      .send({ walkthrough_notes: 'Test' });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough — walkthrough_duration_minutes
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/walkthrough — walkthrough_duration_minutes', () => {
  beforeEach(() => {
    mockPrisma.visit.findMany.mockResolvedValue([]);
  });

  it('saves walkthrough_duration_minutes and returns it in response', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // walkthrough_duration_minutes in the JSON response is now PROJECTED from the current (D15)
    // visit, not the raw legacy column the mock sets.
    const currentVisit = {
      id: 'wt-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01'), duration_minutes: 90,
      completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
      cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-03-01'),
    };
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      visits: [currentVisit],
    });
    mockPrisma.visit.findMany.mockResolvedValue([currentVisit]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({
        walkthrough_duration_minutes: 90,
      });

    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_duration_minutes).toBe(90);
    // PR-D2: the legacy Lead column is dropped - the lead update itself carries no data now.
    const updateCall = (mockPrisma.lead.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data).toEqual({});
  });

  it('rejects walkthrough_duration_minutes below minimum (15)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_duration_minutes: 10 });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads — walkthrough_after / walkthrough_before filters
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: repointed from the legacy walkthrough_scheduled_at
// column onto the walkthroughs relation (lead.controller.ts's buildLeadListWhere).
describe('GET /api/leads — walkthrough date filters', () => {
  it('filters by walkthrough_after', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'))
      .query({ walkthrough_after: '2026-03-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    const whereArg = (mockPrisma.lead.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    // Visits slice 03: the window is its own clause under AND (parity with the job lane), never
    // merged into `where.visits`, where a technician's own-walkthrough row scope lives.
    const window = whereArg.AND.find((c: any) => c.visits?.some?.scheduled_at).visits.some;
    expect(window.scheduled_at.gte).toBeInstanceOf(Date);
  });

  it('filters by walkthrough_before', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'))
      .query({ walkthrough_before: '2026-03-31T23:59:59.000Z' });

    expect(res.status).toBe(200);
    const whereArg = (mockPrisma.lead.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    // Visits slice 03: the window is its own clause under AND (parity with the job lane), never
    // merged into `where.visits`, where a technician's own-walkthrough row scope lives.
    const window = whereArg.AND.find((c: any) => c.visits?.some?.scheduled_at).visits.some;
    expect(window.scheduled_at.lte).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads (+ /export) — a cancelled walkthrough is never the list's date (visits slice 05)
// ═══════════════════════════════════════════════════════

// The list payload carries no walkthrough_cancelled_at (that is detail-only), so every list reader
// - the leads list's Walkthrough column, the scheduler's bucket, the CSV export - takes a non-null
// walkthrough_scheduled_at to mean "booked". Marking a lead lost cancels its walkthrough, and the
// list used to report that called-off trip's time as the lead's date.
describe('GET /api/leads — the flat walkthrough fields ignore cancelled visits', () => {
  const BEN = { user: { id: 'u-ben', first_name: 'Ben', last_name: 'Ortiz', phone: null } };
  const visitRow = (over: Record<string, unknown>) => ({
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-10-20T15:00:00.000Z'),
    duration_minutes: 60, completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-09-01T00:00:00.000Z'),
    canceller: null, assignees: [BEN],
    ...over,
  });
  const cancelled = visitRow({
    id: 'v-cx', visit_seq: 2, status: 'CANCELLED', scheduled_at: new Date('2026-11-02T15:00:00.000Z'),
    cancelled_at: new Date('2026-10-01T12:00:00.000Z'), cancelled_reason: 'Lead marked as lost',
  });
  const completed = visitRow({
    id: 'v-done', visit_seq: 1, status: 'COMPLETED', scheduled_at: new Date('2026-09-10T15:00:00.000Z'),
    completed_at: new Date('2026-09-10T16:00:00.000Z'), assignees: [],
  });

  async function listWith(visits: unknown[], path = '/api/leads') {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([{ ...LEAD_FIXTURE, status: 'LOST', visits }]);
    mockPrisma.lead.count.mockResolvedValue(1);
    const res = await request(app).get(path).set(authHeader('admin'));
    expect(res.status).toBe(200);
    return res.body.leads[0];
  }

  it('a lost lead whose only walkthrough was cancelled has no walkthrough date, duration or crew', async () => {
    const lead = await listWith([cancelled]);
    expect(lead.walkthrough_scheduled_at).toBeNull();
    expect(lead.walkthrough_duration_minutes).toBeNull();
    expect(lead.walkthrough_completed_at).toBeNull();
    expect(lead.walkthrough_performers).toEqual([]);
  });

  it('a walkthrough cancelled after a completed one: the list reports the completed trip', async () => {
    const lead = await listWith([completed, cancelled]);
    expect(lead.walkthrough_scheduled_at).toBe('2026-09-10T15:00:00.000Z');
    expect(lead.walkthrough_completed_at).toBe('2026-09-10T16:00:00.000Z');
    expect(lead.walkthrough_performers).toEqual([]);
  });

  it('a live walkthrough is unaffected', async () => {
    const lead = await listWith([visitRow({}), cancelled]);
    expect(lead.walkthrough_scheduled_at).toBe('2026-10-20T15:00:00.000Z');
    expect(lead.walkthrough_performers).toEqual([BEN]);
  });

  it('the CSV export follows the same rule', async () => {
    const lead = await listWith([cancelled], '/api/leads/export');
    expect(lead.walkthrough_scheduled_at).toBeNull();
    expect(lead.walkthrough_performers).toEqual([]);
  });

  it('the lead DETAIL still describes the cancelled trip - it carries walkthrough_cancelled_at to say so', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST', visits: [cancelled] });
    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_scheduled_at).toBe('2026-11-02T15:00:00.000Z');
    expect(res.body.lead.walkthrough_cancelled_at).toBe('2026-10-01T12:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads — walkthrough_status=needs_scheduling filter
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: the bucket collapses to Walkthrough.status =
// REQUESTED - no lead status default/involved at all (the old NEW/CONTACTED/(walkthrough-
// completed) default is gone, along with the array-order dependency on `status` that
// produced it; the walkthrough lead statuses exist again, but this bucket still reads only the
// visit, never the lead status).
describe('GET /api/leads — walkthrough_status=needs_scheduling filter', () => {
  // Multi-visit D22a: the bucket is the ABSENCE of a live visit, not a REQUESTED placeholder.
  // Visits slice 03: and a CLOSED lead (WON/LOST/CANCELLED) never needs scheduling - it rode into
  // the scheduler's Unscheduled bucket and the leads list's "Needs Scheduling" filter because it
  // holds no live visit either. The exclusion is composed under AND, never on `where.status`, so an
  // explicit status filter (below) is neither overwritten nor widened.
  it('expands to a visits relation filter on having NO live visit, excluding closed leads', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'))
      .query({ walkthrough_status: 'needs_scheduling' });

    expect(res.status).toBe(200);
    const whereArg = (mockPrisma.lead.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(whereArg.visits).toEqual({ none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] } } });
    expect(whereArg.status).toBeUndefined();
    expect(whereArg.AND).toContainEqual({ status: { notIn: ['WON', 'LOST', 'CANCELLED'] } });
  });

  it('returns NEW leads that hold no live visit', async () => {
    mockAuthAs('admin');
    const newLead = { ...LEAD_FIXTURE, status: 'NEW' };
    mockPrisma.lead.findMany.mockResolvedValue([newLead]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'))
      .query({ walkthrough_status: 'needs_scheduling' });

    expect(res.status).toBe(200);
    const whereArg = (mockPrisma.lead.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(whereArg.visits).toEqual({ none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] } } });
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].status).toBe('NEW');
  });

  it('coexists with an explicit status param (no longer defaults or overrides it)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'))
      .query({ status: 'CONTACTED', walkthrough_status: 'needs_scheduling' });

    expect(res.status).toBe(200);
    const whereArg = (mockPrisma.lead.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(whereArg.visits).toEqual({ none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] } } });
    expect(whereArg.status).toBe('CONTACTED');
    expect(whereArg.AND).toContainEqual({ status: { notIn: ['WON', 'LOST', 'CANCELLED'] } });
  });

  it('adds the closed-lead exclusion beside an AND already on the where, never replacing it', () => {
    const facet = leadFacets({}).find((f) => f.key === 'walkthrough_status')!;
    const existing = { customer: { is: { id: 'c-1' } } };
    const where: Record<string, unknown> = { AND: [existing] };
    (facet as { apply: (w: Record<string, unknown>, v: string[]) => void }).apply(where, ['needs_scheduling']);
    expect(where.AND).toEqual([existing, { status: { notIn: ['WON', 'LOST', 'CANCELLED'] } }]);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/mark-lost
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/mark-lost', () => {
  it('marks lead as lost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'NEW' });
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'LOST',
      lost_at: new Date(),
      lost_reason: 'Customer chose competitor',
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Customer chose competitor' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('LOST');
  });

  it('returns 400 when lead is already LOST', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Another reason' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('lost');
  });

  // Walkthrough lead-statuses PRD D10 + section 7.1: Lost is pickable from the status menu "always",
  // Won, Lost and Cancelled leads included, and the menu closes a lead through this door (D11). So a
  // WON lead can be marked lost with a reason. Only "already lost" is refused (a no-op).
  it('marks a WON lead as lost (a closed lead stays changeable, PRD D10)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'WON' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST', lost_reason: 'Some reason' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Some reason' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('LOST');
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event_type: 'STATUS_CHANGE',
        metadata: expect.objectContaining({ from: 'WON', to: 'LOST' }),
      }),
    });
  });

  it('allows marking CONTACTED lead as lost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'No budget' });

    expect(res.status).toBe(200);
  });

  it('allows marking ESTIMATED lead as lost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Price too high' });

    expect(res.status).toBe(200);
  });

  it('returns 400 when lost_reason is missing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 403 for SALES on another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'NEW',
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('sales'))
      .send({ lost_reason: 'Customer cancelled' });

    expect(res.status).toBe(403);
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/mark-lost')
      .set(authHeader('admin'))
      .send({ lost_reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('should cancel active estimates and void unpaid kind=DEPOSIT invoices when marking lost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    (prisma.estimate.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.estimate.findMany as any).mockResolvedValue([{ id: 'est-uuid-1' }]);
    // The kind=DEPOSIT invoice is unpaid (no non-voided payments) → it gets voided.
    (prisma.invoice.findMany as any).mockResolvedValue([{ id: 'dep-inv-1', payments: [] }]);
    (prisma.invoice.updateMany as any).mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Customer chose competitor' });

    expect(res.status).toBe(200);

    const estimateUpdateCall = (prisma.estimate.updateMany as any).mock.calls[0][0];
    expect(estimateUpdateCall.where.status).toEqual({ in: ['DRAFT', 'SENT', 'PENDING'] });
    expect(estimateUpdateCall.data.status).toBe('ARCHIVED');
    expect(estimateUpdateCall.data.cancelled_reason).toBe('Lead marked as lost');

    // The deposit document is now the kind=DEPOSIT Invoice — assert it is voided.
    const depInvFind = (prisma.invoice.findMany as any).mock.calls[0][0];
    expect(depInvFind.where.kind).toBe('DEPOSIT');
    expect(depInvFind.where.status).toEqual({ in: ['DRAFT', 'SENT'] });
    const invVoidCall = (prisma.invoice.updateMany as any).mock.calls[0][0];
    expect(invVoidCall.data.status).toBe('VOIDED');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/stats
// ═══════════════════════════════════════════════════════

describe('GET /api/leads/stats', () => {
  it('returns all five stat counts', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.count
      .mockResolvedValueOnce(42) // total
      .mockResolvedValueOnce(5)  // new_this_week
      .mockResolvedValueOnce(3)  // unassigned
      .mockResolvedValueOnce(8)  // won_this_month
      .mockResolvedValueOnce(2); // lost_this_month

    const res = await request(app)
      .get('/api/leads/stats')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 42,
      new_this_week: 5,
      unassigned: 3,
      won_this_month: 8,
      lost_this_month: 2,
    });
  });

  it('returns stats for TECHNICIAN role (CASL allows conditional read Lead)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/leads/stats')
      .set(authHeader('technician'));

    // TECHNICIAN has conditional read Lead grant — route guard passes.
    expect(res.status).toBe(200);
  });

  it('allows SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/leads/stats')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/:id/notes
// ═══════════════════════════════════════════════════════

const NOTE_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000901',
  content: 'Follow up with customer about quote.',
  created_at: '2026-02-18T10:00:00.000Z',
  creator: { id: TEST_USERS.admin.id, first_name: 'Admin', last_name: 'User' },
};

describe('GET /api/leads/:id/notes', () => {
  it('returns notes for a lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([NOTE_FIXTURE]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].content).toBe('Follow up with customer about quote.');
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/leads/00000000-0000-0000-0000-999999999999/notes')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/:id/timeline (#585)
// ═══════════════════════════════════════════════════════

describe('GET /api/leads/:id/timeline', () => {
  const TIMELINE_EVENT_FIXTURE = {
    id: 'd0000000-0000-0000-0000-000000000001',
    event_type: 'OWNER_CHANGED',
    description: 'Test Admin set as sold-by on L00001',
    metadata: null,
    created_at: new Date('2026-02-01'),
    creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
  };

  it('returns timeline events for a lead (tenant-scoped, LEAD-typed)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([TIMELINE_EVENT_FIXTURE]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/timeline`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    // 2026-09-18 revision: #2088's B6 had widened this `where` into an `OR` (LEAD branch + an
    // ESTIMATE branch scoped to SELECTION_CHANGED). With that event type no longer written, the
    // branch is dead and the `where` is back to its LEAD-only shape, flat. `where.organization_id`
    // stays asserted where it always was - that is the tenant guard.
    const where = mockPrisma.timelineEvent.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.entity_type).toBe('LEAD');
    expect(where.entity_id).toBe(LEAD_FIXTURE.id);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/leads/00000000-0000-0000-0000-999999999999/timeline')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 for an own-scoped SALES user that cannot access the lead', async () => {
    mockAuthAs('sales');
    // Owned-scope mirrors the owner into lead_assignees; point it at admin so SALES is denied.
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    // canAccessRow's scoped findFirst sees nothing → lead is outside the SALES own-scope.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/timeline`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/notes
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/notes', () => {
  it('creates a note successfully', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.note.create.mockResolvedValue(NOTE_FIXTURE);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'Follow up with customer about quote.' });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('Follow up with customer about quote.');
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/notes')
      .set(authHeader('admin'))
      .send({ content: 'Some note' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when content is empty', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  // Phase B (technician redesign): adding a lead note is gated canDo('update','Lead'), and a
  // technician no longer holds general `update Lead` by default — the only thing a tech does on a
  // lead is the walkthrough (the narrow `perform_walkthrough` capability). General lead edits,
  // including adding notes/tags, are denied unless granted a per-user `update Lead` toggle.
  it('blocks a strict TECHNICIAN from adding a lead note by default (no update Lead grant → 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/notes`)
      .set(authHeader('technician'))
      .send({ content: 'Technician note' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Mark Lost — CANCELLED status
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/mark-lost (CANCELLED lead)', () => {
  // PRD D10 + 7.1: a Cancelled lead can be moved to Lost from the menu, so this door takes it.
  it('marks a CANCELLED lead as lost (a closed lead stays changeable, PRD D10)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST', lost_reason: 'Some reason' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Some reason' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('LOST');
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/leads/:id — new statuses
// ═══════════════════════════════════════════════════════

describe('PATCH /api/leads/:id (new statuses)', () => {
  // CANCELLED is no longer settable on this door: closing a lead always asks for a reason
  // (walkthrough lead-statuses PRD D11), so it goes through POST /cancel.
  const newStatuses = ['ESTIMATED'] as const;

  it('refuses ADMIN setting status to CANCELLED with no reason, writing nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please give a reason.' });
    expect(leadStatusWrites(mockPrisma.lead.updateMany)).toHaveLength(0);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  newStatuses.forEach((status) => {
    it(`allows ADMIN to set status to ${status}`, async () => {
      mockAuthAs('admin');
      mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
      mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status });
      // Estimate Sent can be picked only when an estimate went out (lead-statuses slice 04).
      mockPrisma.estimate.count.mockResolvedValue(status === 'ESTIMATED' ? 1 : 0);

      const res = await request(app)
        .patch(`/api/leads/${LEAD_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ status });

      expect(res.status).toBe(200);
      // Spec #1751 D6: written through transitionLeadStatus, with the from/to ledger entry.
      const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
      expect(statusWrites).toHaveLength(1);
      expect(statusWrites[0].data.status).toBe(status);
      expect(statusChangeEvents()[0].metadata).toMatchObject({ from: 'NEW', to: status });
    });
  });

  // Walkthrough lead statuses, slice 01: both are real statuses again. A hand change writes the
  // lead's status, and its History line reads the label - never the raw value, never lower-cased.
  ([
    ['WALKTHROUGH_SCHEDULED', 'Walkthrough Scheduled'],
    ['WALKTHROUGH_COMPLETED', 'Walkthrough Completed'],
    ['ESTIMATED', 'Estimate Sent'],
    ['CONTACTED', 'Contacted'],
  ] as const).forEach(([status, label]) => {
    it(`a hand change to ${status} writes History "Lead status changed to ${label}"`, async () => {
      mockAuthAs('admin');
      mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
      mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status });
      // Give the lead the data each status needs to be pickable (lead-statuses slice 04): a booked
      // visit, a finished one, or a sent estimate. Contacted needs none.
      mockPrisma.visit.count.mockImplementation(async (args: { where: { status: unknown } }) =>
        status === 'WALKTHROUGH_SCHEDULED' && args.where.status !== 'COMPLETED' ? 1
          : status === 'WALKTHROUGH_COMPLETED' && args.where.status === 'COMPLETED' ? 1
          : 0);
      mockPrisma.estimate.count.mockResolvedValue(status === 'ESTIMATED' ? 1 : 0);

      const res = await request(app)
        .patch(`/api/leads/${LEAD_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ status });

      expect(res.status).toBe(200);
      const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
      expect(statusWrites).toHaveLength(1);
      expect(statusWrites[0].data.status).toBe(status);
      const [event] = statusChangeEvents();
      expect(event.description).toBe(`Lead status changed to ${label}`);
      expect(event.metadata).toMatchObject({ from: 'NEW', to: status });
    });
  });

  it('refuses a status that is not in the list with 400', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'WALKTHROUGH_DONE' });

    expect(res.status).toBe(400);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/tags
// ═══════════════════════════════════════════════════════

describe('GET /api/tags', () => {
  it('returns list of tags', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findMany.mockResolvedValue([
      { id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' },
    ]);

    const res = await request(app)
      .get('/api/tags')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.tags).toHaveLength(1);
    expect(res.body.tags[0].name).toBe('Urgent');
  });

  it('returns 403 for TECHNICIAN', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/tags')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/tags
// ═══════════════════════════════════════════════════════

describe('POST /api/tags', () => {
  it('creates a new tag', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'VIP', color: '#8B5CF6' });

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: 'VIP', color: '#8B5CF6' });

    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe('VIP');
  });

  it('returns 409 for duplicate tag name', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(TAG_FIXTURE);

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: 'Urgent' });

    expect(res.status).toBe(409);
  });

  it('returns 400 for empty name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid color', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: 'Test', color: 'not-a-color' });

    expect(res.status).toBe(400);
  });

  // The length checks must read the TRIMMED name. Chained the other way round
  // (`.min(1).max(50).trim()`) zod sized the raw string and trimmed afterwards, so
  // a name of nothing but spaces cleared min(1) and was created as ''. Same root
  // cause as the PATCH defect covered in tag-management.test.ts.
  it('returns 400 for a whitespace-only name rather than creating a blank tag', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  it('trims a padded name before the duplicate check and the write', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'VIP', color: '#6B7280' });

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: '  VIP  ' });

    expect(res.status).toBe(201);
    expect(mockPrisma.tag.findUnique.mock.calls[0][0].where.organization_id_name.name).toBe('VIP');
    expect(mockPrisma.tag.create.mock.calls[0][0].data.name).toBe('VIP');
  });

  it('accepts a name that is exactly the 50-character limit', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'x'.repeat(50), color: '#6B7280' });

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(50) });

    expect(res.status).toBe(201);
  });

  // The other half of the same operator-order bug: 52 characters that trim to a
  // legal 50 were rejected, because max(50) also read the untrimmed string.
  it('accepts padding around a 50-character name', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'x'.repeat(50), color: '#6B7280' });

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: `  ${'x'.repeat(50)}  ` });

    expect(res.status).toBe(201);
    expect(mockPrisma.tag.create.mock.calls[0][0].data.name).toBe('x'.repeat(50));
  });

  it('still rejects a name longer than 50 characters once trimmed (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/tags')
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/tags
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/tags', () => {
  it('attaches existing tag to lead by tag_id', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: TAG_FIXTURE.id, entity_type: 'LEAD', entity_id: LEAD_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe('Urgent');
  });

  it('creates and attaches tag by name', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tag.findUnique
      .mockResolvedValueOnce(null) // name lookup — doesn't exist
      .mockResolvedValueOnce({ id: 'new-tag-id', name: 'Priority', color: '#6B7280' }); // final fetch
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'Priority', color: '#6B7280' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: 'new-tag-id', entity_type: 'LEAD', entity_id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: 'Priority' });

    expect(res.status).toBe(201);
  });

  it('returns 409 when tag already attached', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id, entity_type: 'LEAD', entity_id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(409);
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/tags')
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(404);
  });

  it('returns 400 when neither tag_id nor name provided', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/leads/:id/tags/:tagId
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// GET /api/leads — search & filter
// ═══════════════════════════════════════════════════════

describe('GET /api/leads (search & filter)', () => {
  it('passes search term to OR clause on lead_number, service_request and customer fields', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?search=cooling')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.OR).toBeDefined();
    // #352 — the raw `customer.phone contains` clause became digit-normalized
    // phoneSearchClauses/phoneRelationSearchClauses, which add NOTHING for a
    // digit-less term like 'cooling': 5 text clauses, no phone clause.
    expect(findManyArgs.where.OR).toHaveLength(5);
    expect(findManyArgs.where.OR[0]).toMatchObject({
      lead_number: { contains: 'cooling', mode: 'insensitive' },
    });
    expect(findManyArgs.where.OR[1]).toMatchObject({
      service_request: { contains: 'cooling', mode: 'insensitive' },
    });
  });

  it('filters by assigned_to query param for non-SALES roles', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/leads?assigned_to=${TEST_USERS.sales.id}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_assignees).toEqual({ some: { user_id: TEST_USERS.sales.id } });
  });

  it('returns empty leads for non-matching search (not an error)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/leads?search=zzz_nonexistent_zzz')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('ignores invalid status filter value', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads?status=INVALID_STATUS')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    // Invalid literal ignored → no status constraint applied (open-pipeline default removed).
    expect(findManyArgs.where.status).toBeUndefined();
  });

  it('filters by customer_id query param', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const customerId = 'cust-uuid-123';
    await request(app)
      .get(`/api/leads?customer_id=${customerId}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.customer_id).toBe(customerId);
  });

  it('combines customer_id with status filter', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const customerId = 'cust-uuid-456';
    await request(app)
      .get(`/api/leads?customer_id=${customerId}&status=NEW`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(findManyArgs.where.customer_id).toBe(customerId);
    expect(findManyArgs.where.status).toBe('NEW');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads — pagination edge cases
// ═══════════════════════════════════════════════════════

describe('GET /api/leads (pagination)', () => {
  it('clamps page=0 to page 1', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads?page=0')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
  });

  it('returns empty leads when page exceeds total', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(5);

    const res = await request(app)
      .get('/api/leads?page=999')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);
    expect(res.body.pagination.totalPages).toBeDefined();
  });

  it('clamps limit=200 to 100', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/leads?limit=200')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════
// DISPATCHER access to leads
// ═══════════════════════════════════════════════════════

describe('DISPATCHER lead access', () => {
  it('can list leads', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
  });

  it('can view lead detail', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe(LEAD_FIXTURE.id);
  });

  it('can update lead status', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ status: 'CONTACTED' });

    expect(res.status).toBe(200);
    // Spec #1751 D6: written through transitionLeadStatus, with the from/to ledger entry.
    const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('CONTACTED');
    expect(statusChangeEvents()[0].metadata).toMatchObject({ from: 'NEW', to: 'CONTACTED' });
  });
});

// ═══════════════════════════════════════════════════════
// Response payload validation
// ═══════════════════════════════════════════════════════

describe('Lead response payload', () => {
  it('list response includes tags array (polymorphic tag_assignments)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: LEAD_FIXTURE.id, tag: { id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' } },
    ]);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads[0].tags).toHaveLength(1);
    expect(res.body.leads[0].tags[0]).toMatchObject({
      id: TAG_FIXTURE.id,
      name: 'Urgent',
      color: '#EF4444',
    });
  });

  it('detail response includes tags with flat shape', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([
      { entity_id: LEAD_FIXTURE.id, tag: { id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' } },
    ]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.tags[0]).toHaveProperty('id');
    expect(res.body.lead.tags[0]).toHaveProperty('name');
    expect(res.body.lead.tags[0]).toHaveProperty('color');
  });

  it('list response bundles stats alongside leads', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count
      .mockResolvedValueOnce(0)   // where count
      .mockResolvedValueOnce(10)  // total
      .mockResolvedValueOnce(3)   // new_this_week
      .mockResolvedValueOnce(1)   // unassigned
      .mockResolvedValueOnce(4)   // won
      .mockResolvedValueOnce(2);  // lost

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats).toHaveProperty('total');
    expect(res.body.stats).toHaveProperty('new_this_week');
    expect(res.body.stats).toHaveProperty('unassigned');
    expect(res.body.stats).toHaveProperty('won');
    expect(res.body.stats).toHaveProperty('lost');
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/tags — edge cases
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/tags (edge cases)', () => {
  it('finds existing tag by name and attaches it (idempotent create)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    // tag.findUnique returns existing tag on name lookup
    mockPrisma.tag.findUnique
      .mockResolvedValueOnce({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' }) // found by name
      .mockResolvedValueOnce({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' }); // final fetch
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null); // not attached yet
    mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: TAG_FIXTURE.id, entity_type: 'LEAD', entity_id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: 'Urgent' });

    expect(res.status).toBe(201);
    // Should NOT have called tag.create since tag already exists
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  // Phase B (technician redesign): tagging a lead is gated canDo('update','Lead'); a technician no
  // longer holds general `update Lead` by default (only `perform_walkthrough`), so the route guard
  // blocks the request before the controller — adding tags is not a default tech ability.
  it('blocks a strict TECHNICIAN from adding tags by default (no update Lead grant → 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('technician'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });
});

describe('DELETE /api/leads/:id/tags/:tagId', () => {
  it('removes tag from lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id, entity_type: 'LEAD', entity_id: LEAD_FIXTURE.id });
    mockPrisma.tagAssignment.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('returns 404 when tag not attached', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  // Phase B (technician redesign): removing a lead tag is gated canDo('update','Lead'); without
  // the general `update Lead` grant (now a per-user toggle), a strict technician is blocked at the
  // route guard.
  it('blocks a strict TECHNICIAN from removing tags by default (no update Lead grant → 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });
});

// POST /api/leads/:id/contact was removed by D6, PR-B2 and is BACK under spec #1751 D5, scoped
// as a correction to an automatic stamp rather than the primary mechanism. See
// lead-contact-clock.test.ts for the door and for the three channels that set the clock on
// their own.

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough/schedule
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: the status guard is DELETED entirely (D2) — visit
// events push the lead forward, the lead never gates them. scheduleWalkthrough now
// create-or-updates a Walkthrough row instead of stamping the lead directly. The lead's status
// then follows its visits through syncLeadWalkthroughStatus: New, Contacted and Walkthrough
// Completed move to Walkthrough Scheduled; Estimate Sent, Won, Lost and Cancelled are never moved.
describe('POST /api/leads/:id/walkthrough/schedule', () => {
  // performer_ids is the FULL new performer set (REPLACE; [] is a valid state-4 schedule).
  const scheduleBody = {
    walkthrough_scheduled_at: '2026-04-01T09:00:00Z',
    performer_ids: [TEST_USERS.sales.id],
    walkthrough_duration_minutes: 60,
  };

  // scheduleWalkthrough() create-or-updates the Walkthrough row, replaces its performer set,
  // and updates the lead — all inside ONE $transaction.
  function wireScheduleTx(
    updatedLead: any,
    currentPerformers: { user_id: string }[] = [],
    // What the status rule sees under the lead lock: the lead's status and its visit counts. The
    // default is a lead the rule leaves alone (Walkthrough Scheduled with one open visit).
    syncState: { status?: string; open?: number; finished?: number } = {},
  ) {
    const txFindMany = vi.fn().mockResolvedValue(currentPerformers);
    const txCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txLeadUpdate = vi.fn().mockResolvedValue(updatedLead);
    // The status move is written by transitionLeadStatus, which updates through `updateMany` and
    // reads `count` off the result to decide whether to file the ledger entry. `{ count: 1 }` =
    // the row moved.
    const txLeadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txWalkthroughCreate = vi.fn().mockResolvedValue({ id: 'wt-new-1' });
    const txWalkthroughUpdate = vi.fn().mockResolvedValue({ id: 'wt-active-1' });
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(withLeadStatusSync({
        visitAssignee: { findMany: txFindMany, createMany: txCreateMany, deleteMany: txDeleteMany },
        visit: { aggregate: mockPrisma.visit.aggregate, create: txWalkthroughCreate, update: txWalkthroughUpdate },
        lead: { update: txLeadUpdate, updateMany: txLeadUpdateMany },
        timelineEvent: { create: txTimelineCreate },
      }, syncState)),
    );
    return { txFindMany, txCreateMany, txDeleteMany, txLeadUpdate, txLeadUpdateMany, txWalkthroughCreate, txWalkthroughUpdate, txTimelineCreate };
  }

  beforeEach(() => {
    // loadGrantsFor() calls rolePermission.findMany for the performer user.
    // Return grants by role so perform Walkthrough is correctly resolved.
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) =>
        Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role))
    );
    // Performer validation default
    (prisma.user.findUnique as any).mockImplementation(
      (args: { where: { id: string } }) => {
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match || null);
      },
    );
    (prisma.job.findMany as any).mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);
    // findActiveWalkthrough (pre-transaction) default: no active visit — a fresh booking.
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    // detectPerformerConflicts' "other scheduled walkthroughs" leg (unconditional unless force).
    mockPrisma.visit.findMany.mockResolvedValue([]);
  });

  it('schedules a walkthrough on a CONTACTED lead (performers≥1 → scheduled + WALKTHROUGH_SCHEDULED dispatch + flag)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' }, [], { status: 'CONTACTED', open: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(200);
    // The lead's status follows its visits: booking moves a Contacted lead to Walkthrough
    // Scheduled. Asserted against the status writer itself (spec #1751 D6) — `lead.update` no
    // longer carries a status for ANY caller, so reading it there would prove nothing.
    expect(leadStatusWrites(tx.txLeadUpdateMany).map((w: any) => w.data.status)).toEqual(['WALKTHROUGH_SCHEDULED']);
    expect(statusChangeEvents(tx.txTimelineCreate)).toHaveLength(1);
    // The Walkthrough row itself is what carries SCHEDULED + the time — created fresh here
    // (no active visit existed).
    expect(tx.txWalkthroughCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED', lead_id: LEAD_FIXTURE.id }) }),
    );
    expect(tx.txCreateMany).toHaveBeenCalled();
    // PR-D2: the legacy Lead columns are dropped, so `lead.update` now writes NOTHING at all —
    // the row is re-read only for the response shape.
    expect(tx.txLeadUpdate.mock.calls[0][0].data).toEqual({});
    // Spec #1751 D2's booking clock is a CONDITIONAL write of its own (stampLeadClock), not a
    // patch merged into the statement above. It is monotonic, and deciding "is it still null?"
    // from a row read before the transaction opened is a read-then-write two concurrent bookings
    // can both win; the `walkthrough_first_booked_at: null` in the WHERE is what makes
    // first-touch-wins atomic, so it is asserted rather than assumed.
    const bookedWrites = tx.txLeadUpdateMany.mock.calls
      .map((c: any[]) => c[0])
      .filter((args: any) => args?.data?.walkthrough_first_booked_at !== undefined);
    expect(bookedWrites).toHaveLength(1);
    expect(bookedWrites[0].where).toMatchObject({
      id: LEAD_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      walkthrough_first_booked_at: null,
    });
    // The moment of the BOOKING, not the appointment instant ('2026-04-01T09:00:00Z' in
    // scheduleBody) — an appointment set three weeks out was still booked on time.
    expect(bookedWrites[0].data.walkthrough_first_booked_at).toBeInstanceOf(Date);
    expect(bookedWrites[0].data.walkthrough_first_booked_at.toISOString()).not.toBe('2026-04-01T09:00:00.000Z');
    expect(dispatchedType('WALKTHROUGH_SCHEDULED')).toHaveLength(1);
  });

  it('booking moves a NEW lead to Walkthrough Scheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'NEW' });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'WALKTHROUGH_SCHEDULED' }, [], { status: 'NEW', open: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(200);
    // Spec #1751 D6: the move goes through transitionLeadStatus, so it is an updateMany and it
    // leaves a from/to ledger entry.
    const statusWrites = leadStatusWrites(tx.txLeadUpdateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('WALKTHROUGH_SCHEDULED');
    const ledger = statusChangeEvents(tx.txTimelineCreate);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'NEW', to: 'WALKTHROUGH_SCHEDULED' });
  });

  it('never moves an ESTIMATED lead: booking leaves the status untouched', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'ESTIMATED' }, [], { status: 'ESTIMATED', open: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(200);
    // Read off the status writer (spec #1751 D6), not off `lead.update`, which no longer
    // carries a status for any caller.
    expect(leadStatusWrites(tx.txLeadUpdateMany)).toHaveLength(0);
    expect(statusChangeEvents(tx.txTimelineCreate)).toHaveLength(0);
  });

  it('state 4: performer_ids:[] + a time → SCHEDULED, 0 performers, NO WALKTHROUGH_SCHEDULED dispatch, flag stays unset', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ ...scheduleBody, performer_ids: [] });

    expect(res.status).toBe(200);
    // The visit is SCHEDULED regardless of performer count (time-driven, not performer-driven).
    expect(tx.txWalkthroughCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
    );
    // No dispatch, flag NOT stamped.
    expect(dispatchedType('WALKTHROUGH_SCHEDULED')).toHaveLength(0);
    expect(tx.txLeadUpdate.mock.calls[0][0].data.walkthrough_customer_email_sent_at).toBeUndefined();
  });

  it('returns 409 when a per-member schedule conflict is detected (same body shape)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // Return a conflicting job for the performer (crew M2M overlap). Multi-visit close-out: the
    // job arm is now matched through the job's VISITS relation, not the Job.scheduled_start/end
    // mirror, so the overlapping window comes back nested under `visits`, mirroring the shape
    // job.controller.ts's own detectCrewConflicts has used since S6.
    (prisma.job.findMany as any).mockResolvedValue([{
      id: 'conflict-job',
      job_number: 'J00099',
      visits: [{ id: 'conflict-visit', scheduled_at: new Date('2026-04-01T08:00:00Z'), scheduled_end: new Date('2026-04-01T10:00:00Z') }],
    }]);
    mockPrisma.lead.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].number).toBe('J00099');
  });

  it('succeeds with force: true despite conflict', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ ...scheduleBody, force: true });

    expect(res.status).toBe(200);
    // Conflict check was skipped — job.findMany should not have been called
    expect((prisma.job.findMany as any)).not.toHaveBeenCalled();
  });

  it('accepts a DISPATCHER performer (#366: all active users walkthrough-eligible)', async () => {
    // #366: walkthrough performers = ALL active org users (widened ASSIGNABLE_ROLES).
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({
        ...scheduleBody,
        performer_ids: [TEST_USERS.dispatcher.id],
      });

    expect(res.status).toBe(200);
    expect(tx.txCreateMany).toHaveBeenCalled();
  });

  it('returns 403 for TECHNICIAN', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('technician'))
      .send(scheduleBody);

    expect(res.status).toBe(403);
  });

  it('reschedules an existing SCHEDULED visit and creates a WALKTHROUGH_RESCHEDULED event', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // An active SCHEDULED visit already exists — this call reschedules it (same row), not a
    // fresh one.
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-03-15T09:00:00Z'),
      customer_email_sent_at: new Date('2026-03-01T00:00:00Z'), assignees: [],
    });
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(200);
    // Reuses (updates) the existing Walkthrough row rather than creating a new one.
    expect(tx.txWalkthroughUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wt-active-1' } }),
    );
    expect(tx.txWalkthroughCreate).not.toHaveBeenCalled();
    // Verify the timeline event is WALKTHROUGH_RESCHEDULED (not WALKTHROUGH_SCHEDULED)
    const timelineCall = tx.txTimelineCreate.mock.calls[0][0];
    expect(timelineCall.data.event_type).toBe('WALKTHROUGH_RESCHEDULED');
  });

  it('D1: books a SECOND, distinct visit after the first one COMPLETED (same performer, no unique-constraint conflict)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // The lead's last visit already finished — findActiveWalkthrough (REQUESTED/SCHEDULED
    // only) correctly sees nothing, so this books a FRESH visit.
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    const tx = wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(scheduleBody);

    expect(res.status).toBe(200);
    expect(tx.txWalkthroughCreate).toHaveBeenCalled();
    expect(tx.txWalkthroughUpdate).not.toHaveBeenCalled();
    const timelineCall = tx.txTimelineCreate.mock.calls[0][0];
    expect(timelineCall.data.event_type).toBe('WALKTHROUGH_SCHEDULED');
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough/complete
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status (only a
// SCHEDULED Walkthrough row can be completed).
//
// PERMISSION CHANGE: this used to be the one handler that never called canAccessRow — it
// hand-rolled `manage('all') || is-performer`, so a non-performer DISPATCHER 403'd, unlike
// every sibling handler. Repointed onto canAccessRow('Lead') for consistency (see
// lead.controller.ts's completeWalkthrough for the full note); it resolves through the SAME
// read-Lead grant every sibling already uses — unconditional for ADMIN/DISPATCHER, OWN_LEAD for
// SALES, OWN_WALKTHROUGH for TECHNICIAN.
describe('POST /api/leads/:id/walkthrough/complete', () => {
  beforeEach(() => {
    mockPrisma.visitAssignee.findMany.mockResolvedValue([]);
  });

  it('completes a lead with a SCHEDULED visit (ADMIN — unconditional, no row probe needed)', async () => {
    mockAuthAs('admin');
    // The walkthrough lead statuses exist again, but completeWalkthrough does not itself move the
    // lead: completing a visit writes no lead-status side effect, so the lead stays wherever the
    // earlier schedule call (or whatever else) left it. The automatic visit rule is a later slice.
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CONTACTED');
    // The lead.update payload carries no `status` key at all - completion is purely a fact on
    // the Walkthrough row now, not a lead-pipeline transition.
    expect(mockPrisma.lead.update.mock.calls[0][0].data).not.toHaveProperty('status');
    // The transition is a GUARDED write: the WHERE re-tests the status, so a visit another
    // request already completed matches nothing instead of being overwritten.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wt-scheduled-1' }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('returns 400 when the lead has no SCHEDULED visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scheduled walkthrough');
  });

  it('returns 403 for SALES on a lead they do not own', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    // canAccessRow's scoped probe finds nothing → not visible under SALES' OWN_LEAD scope.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(403);
  });

  // MV-RBAC-19: authorization must run BEFORE the business-state check, or an unowned lead's
  // "no scheduled walkthrough" state leaks through a 400 instead of a 403 - telling a caller who
  // should not even know this lead exists whether it currently has one.
  it('returns 403, not 400, for SALES on a lead they do not own that ALSO has no scheduled visit', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // No scheduled visit either - if this were checked first, the response would be a 400
    // ("Can only complete a scheduled walkthrough"), leaking that fact about an invisible lead.
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    // canAccessRow's scoped probe finds nothing → not visible under SALES' OWN_LEAD scope.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(403);
  });

  it('allows a performer (TECHNICIAN) to complete via OWN_WALKTHROUGH', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    // canAccessRow's scoped probe (matches — tech is a performer).
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('DISPATCHER can complete a walkthrough even without being a performer (unconditional read Lead)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough/cancel
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status. Per D12
// a cancelled visit with nothing rebooked leaves a FRESH REQUESTED row so the lead reappears in
// the scheduler bucket — it does not just go CANCELLED and stop.
describe('POST /api/leads/:id/walkthrough/cancel', () => {
  // Multi-visit D22a: cancelling a visit no longer mints a replacement placeholder. The lead
  // returns to "needs scheduling" simply by having no live visit, and minting a row would be
  // actively wrong once a lead can hold several trips - cancelling one of three must not put the
  // lead in the needs-scheduling bucket while two are still booked.
  it('cancels the lead\'s live visit WITHOUT rebooking a placeholder row (D22a)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.visit.update.mockResolvedValue({});
    mockPrisma.visit.create.mockResolvedValue({ id: 'wt-rebooked-1' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduled' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CONTACTED');
    // A GUARDED updateMany, not a bare update: the target was resolved by a read that ran
    // before the transaction opened, so the accept-set is re-tested in the WHERE and the door
    // reads `count` to learn whether it was the one that landed the transition.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wt-scheduled-1', status: { in: expect.arrayContaining(['SCHEDULED']) } }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    // No replacement row - the absence of a live visit IS the needs-scheduling signal now.
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the lead has no SCHEDULED visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scheduled walkthrough');
  });

  it('requires cancelled_reason', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 403 for SALES on another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      assigned_to: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
      .set(authHeader('sales'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/cancel
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/cancel', () => {
  it('cancels a NEW lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'NEW' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CANCELLED');
  });

  // Walkthrough lead-statuses PRD D10 + section 7.1: Cancelled is pickable from the status menu
  // "always", Won, Lost and Cancelled leads included, and the menu closes a lead through this door
  // (D11). Only "already cancelled" is refused (a no-op).
  it.each(['WON', 'LOST'])('cancels a %s lead (a closed lead stays changeable, PRD D10)', async (status) => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED', cancelled_reason: 'Test' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CANCELLED');
  });

  it('returns 400 for already CANCELLED', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cancelled');
  });

  // Walkthrough-as-entity redesign, PR-B2: the trigger is now the Walkthrough row's own
  // SCHEDULED status (findScheduledWalkthrough), not lead.status. Auto-cancel does NOT rebook
  // a fresh REQUESTED row (unlike a standalone cancelWalkthrough) — the lead itself is now
  // CANCELLED and must not reappear in the "needs scheduling" bucket.
  it('auto-cancels walkthrough when cancelling a lead with a SCHEDULED visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.visit.update.mockResolvedValue({});
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled project' });

    expect(res.status).toBe(200);
    // The visit rows themselves are cancelled, no rebooking - EVERY live trip of the lead (fix
    // pass: a lead can hold several), guarded by the live set in the WHERE so a trip another
    // request completed first keeps its outcome. lead-exit-cancels-walkthroughs.test.ts asserts
    // which rows change.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ALPHA_ORG_ID, lead_id: LEAD_FIXTURE.id, status: { in: expect.arrayContaining(['SCHEDULED']) },
        }),
        data: expect.objectContaining({ status: 'CANCELLED', cancelled_reason: 'Lead cancelled' }),
      }),
    );
    // PR-D2: the dual-write onto the legacy Lead.walkthrough_* columns is gone - the write only
    // carries the lead's OWN cancellation fields. Spec #1751 D6 moved that write into
    // transitionLeadStatus, which puts the status and the columns that travel with it in ONE
    // statement, and files the from/to ledger entry the hand-rolled event it replaces lacked.
    const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('CANCELLED');
    expect(statusWrites[0].data.cancelled_at).toBeInstanceOf(Date);
    expect(statusWrites[0].data.cancelled_reason).toBe('Customer cancelled project');
    const ledger = statusChangeEvents();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'CONTACTED', to: 'CANCELLED' });
  });

  it('does not touch the Walkthrough row when cancelling a lead with no SCHEDULED visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    // The live-trip sweep finds nothing to cancel.
    mockPrisma.visit.updateMany.mockResolvedValue({ count: 0 });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    // Only the live-set sweep ran, and it changed nothing; the ledger says no trip was called off.
    for (const [args] of mockPrisma.visit.updateMany.mock.calls) {
      expect(args.where.status.in).not.toContain('COMPLETED');
    }
    expect(statusChangeEvents()[0].metadata).toMatchObject({ walkthrough_auto_cancelled: false });
    const updateCall = mockPrisma.lead.update.mock.calls[0][0];
    expect(updateCall.data.walkthrough_scheduled_at).toBeUndefined();
  });

  it('requires cancelled_reason', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 403 for SALES on another users lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'NEW',
      assigned_to: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('sales'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(403);
  });

  it('should cancel active estimates and void unpaid kind=DEPOSIT invoices when cancelling lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    (prisma.estimate.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.estimate.findMany as any).mockResolvedValue([{ id: 'est-uuid-1' }]);
    (prisma.invoice.findMany as any).mockResolvedValue([{ id: 'dep-inv-1', payments: [] }]);
    (prisma.invoice.updateMany as any).mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);

    const estimateUpdateCall = (prisma.estimate.updateMany as any).mock.calls[0][0];
    expect(estimateUpdateCall.where.status).toEqual({ in: ['DRAFT', 'SENT', 'PENDING'] });
    expect(estimateUpdateCall.data.status).toBe('ARCHIVED');
    expect(estimateUpdateCall.data.cancelled_reason).toBe('Lead cancelled');

    const depInvFind = (prisma.invoice.findMany as any).mock.calls[0][0];
    expect(depInvFind.where.kind).toBe('DEPOSIT');
    const invVoidCall = (prisma.invoice.updateMany as any).mock.calls[0][0];
    expect(invVoidCall.data.status).toBe('VOIDED');
  });
});

// PATCH /api/leads/:id (walkthrough_needed toggle) — the "cannot disable walkthrough_needed
// while one is scheduled" guard is REMOVED (PR-B2): walkthrough_needed (bucket intent) and
// visit state are separate concerns now.

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/mark-lost — auto-cancels walkthrough
// ═══════════════════════════════════════════════════════

// Walkthrough-as-entity redesign, PR-B2: same repoint as cancelLead's auto-cancel test — the
// trigger is the Walkthrough row's own SCHEDULED status, and no fresh REQUESTED row is
// rebooked (the lead is now LOST).
describe('POST /api/leads/:id/mark-lost (walkthrough auto-cancel)', () => {
  it('auto-cancels walkthrough when marking a lead with a SCHEDULED visit as lost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.visit.update.mockResolvedValue({});
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Customer went elsewhere' });

    expect(res.status).toBe(200);
    // A GUARDED updateMany, not a bare update: the target was resolved by a read that ran
    // before the transaction opened, so the accept-set is re-tested in the WHERE and the door
    // reads `count` to learn whether it was the one that landed the transition.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ALPHA_ORG_ID, lead_id: LEAD_FIXTURE.id, status: { in: expect.arrayContaining(['SCHEDULED']) },
        }),
        data: expect.objectContaining({ status: 'CANCELLED', cancelled_reason: 'Lead marked as lost' }),
      }),
    );
    // PR-D2: the dual-write onto the legacy Lead.walkthrough_* columns is gone - the write only
    // carries the lead's OWN lost fields. Spec #1751 D6 moved that write into
    // transitionLeadStatus (status + lost_at + lost_reason in ONE statement) and gave the ledger
    // entry the from/to the hand-rolled event it replaces did not carry.
    const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('LOST');
    expect(statusWrites[0].data.lost_at).toBeInstanceOf(Date);
    expect(statusWrites[0].data.lost_reason).toBe('Customer went elsewhere');
    const ledger = statusChangeEvents();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'CONTACTED', to: 'LOST' });
  });
});

// ═══════════════════════════════════════════════════════
// Lead number generation in create
// ═══════════════════════════════════════════════════════

describe('POST /api/leads (lead_number generation)', () => {
  it('generates lead_number during creation', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: LEAD_FIXTURE.customer_id });
    const createdLead = { ...LEAD_FIXTURE, lead_number: 'L00001' };
    mockPrisma.$transaction.mockImplementation((fn: any) => {
      const tx = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(createdLead),
        },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: LEAD_FIXTURE.customer_id,
        service_request: 'New service request',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.lead_number).toBe('L00001');
  });
});

// ═══════════════════════════════════════════════════════
// Phase 4a — Service-location anchoring on create
// ═══════════════════════════════════════════════════════

describe('POST /api/leads (service-location anchoring)', () => {
  it('accretes/sets service_location_id from new_location on an existing customer', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      txLocCreate = vi.fn().mockResolvedValue({ id: 'accreted-loc-id' });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_request: 'AC not cooling',
        new_location: {
          address_line1: '789 New St',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
        },
      });

    expect(res.status).toBe(201);
    // A new location was accreted on the customer …
    expect(txLocCreate!).toHaveBeenCalled();
    expect(txLocCreate!.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    // … and its id was set on the lead.
    expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBe('accreted-loc-id');
  });

  it('sets an explicit service_location_id without accreting', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    let txLocFindFirst: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      txLocCreate = vi.fn();
      txLocFindFirst = vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: txLocFindFirst, create: txLocCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_request: 'AC not cooling',
        service_location_id: LOCATION_FIXTURE.id,
      });

    expect(res.status).toBe(201);
    expect(txLocCreate!).not.toHaveBeenCalled();
    expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBe(LOCATION_FIXTURE.id);
  });

  // Regression: Servy creates a lead for an existing customer by name only, sending
  // { customer_id, service_request } with NO location. leads.service_location_id is
  // NOT NULL, so the create used to 500 (P2011). It must default to the primary location.
  it('defaults to the customer primary location when an existing-customer create omits one', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    let txLocFindFirst: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      txLocFindFirst = vi.fn().mockResolvedValue({ id: 'primary-loc-id' });
      txLocCreate = vi.fn();
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: txLocFindFirst, create: txLocCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'Front door replacement' });

    expect(res.status).toBe(201);
    expect(txLocFindFirst!).toHaveBeenCalled(); // looked up the primary location
    expect(txLocCreate!).not.toHaveBeenCalled(); // did NOT accrete a new one
    expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBe('primary-loc-id'); // never null
  });

  // #2041 decision 8 — new_location is a WRITE onto the customer (find-or-create a
  // ServiceLocation), so it must be gated the same way ad_source/accreteContactMethods already
  // are: only when the requester can read the customer row.
  describe('#2041 decision 8 — new_location accretion is gated on customer readability', () => {
    it('SALES, unassociated customer + new_location -> no accretion write; falls back to the primary-location lookup', async () => {
      mockAuthAs('sales');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE); // no created_by_id/leads/jobs tie to SALES
      let txLeadCreate: ReturnType<typeof vi.fn>;
      let txLocCreate: ReturnType<typeof vi.fn>;
      let txLocFindFirst: ReturnType<typeof vi.fn>;
      let txCustomerUpdate: ReturnType<typeof vi.fn>;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
        txLocCreate = vi.fn().mockResolvedValue({ id: 'accreted-loc-id' });
        txLocFindFirst = vi.fn().mockResolvedValue(null);
        txCustomerUpdate = vi.fn();
        const txMock = {
          visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
          lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
          serviceLocation: { findFirst: txLocFindFirst, create: txLocCreate },
          customer: { update: txCustomerUpdate },
        };
        return fn(txMock);
      });

      const res = await request(app)
        .post('/api/leads')
        .set(authHeader('sales'))
        .send({
          customer_id: CUSTOMER_FIXTURE.id,
          service_request: 'AC not cooling',
          new_location: {
            address_line1: '789 New St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
          },
        });

      expect(res.status).toBe(201);
      // No accretion write onto the customer the requester cannot read.
      expect(txLocCreate!).not.toHaveBeenCalled();
      expect(txCustomerUpdate!).not.toHaveBeenCalled();
      // Falls through to the same "no location supplied" primary-location lookup (a read).
      expect(txLocFindFirst!).toHaveBeenCalled();
      expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBeNull();
      // Response stays the redacted shape for an unreadable customer.
      expect(res.body.lead.customer).not.toHaveProperty('email');
    });

    it('SALES, ASSOCIATED customer (created_by_id = requester) + new_location -> accretion unchanged', async () => {
      mockAuthAs('sales');
      const ownedCustomer = { ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id };
      mockPrisma.customer.findUnique.mockResolvedValue(ownedCustomer);
      let txLeadCreate: ReturnType<typeof vi.fn>;
      let txLocCreate: ReturnType<typeof vi.fn>;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
        txLocCreate = vi.fn().mockResolvedValue({ id: 'accreted-loc-id' });
        const txMock = {
          visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
          lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
          serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
          customer: { update: vi.fn() },
        };
        return fn(txMock);
      });

      const res = await request(app)
        .post('/api/leads')
        .set(authHeader('sales'))
        .send({
          customer_id: ownedCustomer.id,
          service_request: 'AC not cooling',
          new_location: {
            address_line1: '789 New St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
          },
        });

      expect(res.status).toBe(201);
      expect(txLocCreate!).toHaveBeenCalled();
      expect(txLocCreate!.mock.calls[0][0].data.customer_id).toBe(ownedCustomer.id);
      expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBe('accreted-loc-id');
    });
  });

  // #2041 findings 1/6 — the created lead's OWN `service_location` (leadDetailSelect) is the SAME
  // customer's street address one key over from `customer`. Picking an EXISTING location by id
  // stays allowed for an unreadable customer (a read, not a write — Fix 3 above), but the address
  // it carries in the response must be redacted exactly like `customer`'s contact block is.
  describe('#2041 findings 1/6 — the created leads sibling service_location is redacted too', () => {
    it('SALES, unassociated customer + an existing service_location_id -> service_location address stripped in the response', async () => {
      mockAuthAs('sales');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE); // no association to SALES
      const leadWithLocation = {
        ...LEAD_FIXTURE,
        service_location_id: LOCATION_FIXTURE.id,
        service_location: {
          id: LOCATION_FIXTURE.id,
          address_line1: LOCATION_FIXTURE.address_line1,
          address_line2: LOCATION_FIXTURE.address_line2,
          city: LOCATION_FIXTURE.city,
          state: LOCATION_FIXTURE.state,
          zip: LOCATION_FIXTURE.zip,
        },
      };
      let txLeadCreate: ReturnType<typeof vi.fn>;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        txLeadCreate = vi.fn().mockResolvedValue(leadWithLocation);
        const txMock = {
          visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
          lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
          serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id, state: LOCATION_FIXTURE.state }) },
          customer: { update: vi.fn() },
        };
        return fn(txMock);
      });

      const res = await request(app)
        .post('/api/leads')
        .set(authHeader('sales'))
        .send({
          customer_id: CUSTOMER_FIXTURE.id,
          service_request: 'AC not cooling',
          service_location_id: LOCATION_FIXTURE.id,
        });

      expect(res.status).toBe(201);
      const location = res.body.lead.service_location as Record<string, unknown>;
      expect(location).toBeTruthy();
      expect(location.id).toBe(LOCATION_FIXTURE.id); // id kept
      for (const key of ['address_line1', 'address_line2', 'city', 'state', 'zip']) {
        expect(key in location, `service_location.${key} must not be present`).toBe(false);
      }
    });

    it('green control: SALES, ASSOCIATED customer -> service_location address stays intact', async () => {
      mockAuthAs('sales');
      const ownedCustomer = { ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id };
      mockPrisma.customer.findUnique.mockResolvedValue(ownedCustomer);
      const leadWithLocation = {
        ...LEAD_FIXTURE,
        service_location_id: LOCATION_FIXTURE.id,
        service_location: {
          id: LOCATION_FIXTURE.id,
          address_line1: LOCATION_FIXTURE.address_line1,
          address_line2: LOCATION_FIXTURE.address_line2,
          city: LOCATION_FIXTURE.city,
          state: LOCATION_FIXTURE.state,
          zip: LOCATION_FIXTURE.zip,
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txLeadCreate = vi.fn().mockResolvedValue(leadWithLocation);
        const txMock = {
          visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
          lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
          serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id, state: LOCATION_FIXTURE.state }) },
          customer: { update: vi.fn() },
        };
        return fn(txMock);
      });

      const res = await request(app)
        .post('/api/leads')
        .set(authHeader('sales'))
        .send({
          customer_id: ownedCustomer.id,
          service_request: 'AC not cooling',
          service_location_id: LOCATION_FIXTURE.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.lead.service_location.address_line1).toBe(LOCATION_FIXTURE.address_line1);
      expect(res.body.lead.service_location.city).toBe(LOCATION_FIXTURE.city);
    });
  });

  // Lead service location is now OPTIONAL (servwave prod cutover, Part A). An existing
  // customer with NO service location to default to no longer 400s — the lead is created
  // with service_location_id null (a JOB still requires one; a lead may have none).
  it('creates a lead (201, null location) when an existing customer has no service location to default to', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'Front door replacement' });

    expect(res.status).toBe(201);
    expect(txLeadCreate!.mock.calls[0][0].data.service_location_id).toBeNull();
  });

  it('resolves a ServiceLocation from only legacy service_address_* and sets service_location_id', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      txLocCreate = vi.fn().mockResolvedValue({ id: 'legacy-loc-id' });
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_request: 'AC not cooling',
        service_address_line1: '456 Oak Ave',
        service_city: 'Dallas',
        service_state: 'TX',
        service_zip: '75201',
      });

    expect(res.status).toBe(201);
    // Backward-compat: legacy address still written on the lead row …
    const leadData = txLeadCreate!.mock.calls[0][0].data;
    expect(leadData.service_address_line1).toBe('456 Oak Ave');
    // … and a location was accreted + set as service_location_id.
    expect(leadData.service_location_id).toBe('legacy-loc-id');
  });
});

describe('POST /api/leads (existing-customer accretion — unified-client-creation §5.3)', () => {
  it('accretes a typed phone as a new secondary CustomerPhone (primary untouched)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txCustomerPhoneCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txCustomerPhoneCreate = vi.fn();
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { findUnique: vi.fn().mockResolvedValue({ phone: CUSTOMER_FIXTURE.phone, email: null, phones: [], extra_emails: [] }) },
        customerPhone: { create: txCustomerPhoneCreate },
        customerEmail: { create: vi.fn() },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling', phone: '5559998888' });

    expect(res.status).toBe(201);
    expect(txCustomerPhoneCreate!).toHaveBeenCalledWith({
      data: { customer_id: CUSTOMER_FIXTURE.id, phone: '5559998888', is_primary: false },
    });
  });

  it('does NOT create a customer_id lead as new_customer when only phone/email are typed (link preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let txLeadCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadCreate = vi.fn().mockResolvedValue(LEAD_FIXTURE);
      const txMock = {
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        customer: { findUnique: vi.fn().mockResolvedValue({ phone: null, email: null, phones: [], extra_emails: [] }) },
        customerPhone: { create: vi.fn() },
        customerEmail: { create: vi.fn() },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: txLeadCreate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling', phone: '5559998888', email: 'new@example.com' });

    expect(res.status).toBe(201);
    expect(txLeadCreate!.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });
});

// ═══════════════════════════════════════════════════════
// Phase 4a — Edit-freeze + tax-warning on update
// ═══════════════════════════════════════════════════════

describe('PATCH /api/leads/:id (edit-freeze + tax-warning)', () => {
  it('rejects a location change once an estimate exists', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.estimate.count as any).mockResolvedValue(1);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: 'b0000000-0000-0000-0000-0000000000aa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Location locked');
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  it('allows detail/scope edits even when an estimate exists', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.estimate.count as any).mockResolvedValue(1);
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, service_request: 'Reworded scope' });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_request: 'Reworded scope', notes: 'call back' });

    expect(res.status).toBe(200);
    expect(mockPrisma.lead.update).toHaveBeenCalled();
    // estimate rows untouched
    expect((prisma.estimate.updateMany as any)).not.toHaveBeenCalled();
  });

  it('returns a tax_warning when an open lead changes to a different-state location', async () => {
    mockAuthAs('admin');
    // Existing lead anchored in TX
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'TX' });
    (prisma.estimate.count as any).mockResolvedValue(0);
    let txLeadUpdate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadUpdate = vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'CA' });
      const txMock = {
        lead: { update: txLeadUpdate },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'ca-loc-id' }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        new_location: { address_line1: '1 CA Way', city: 'San Diego', state: 'CA', zip: '92101' },
      });

    expect(res.status).toBe(200);
    expect(res.body.tax_warning).toBeDefined();
    expect(res.body.tax_warning.old_state).toBe('TX');
    expect(res.body.tax_warning.new_state).toBe('CA');
  });

  it('returns a tax_warning when picking an existing different-state location by id', async () => {
    mockAuthAs('admin');
    // Existing lead anchored in TX
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'TX' });
    (prisma.estimate.count as any).mockResolvedValue(0);
    let txLeadUpdate: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadUpdate = vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'CA' });
      txLocCreate = vi.fn();
      const txMock = {
        lead: { update: txLeadUpdate },
        // Pure id-pick: the existing CA location resolves with its state, no create.
        serviceLocation: {
          findFirst: vi.fn().mockResolvedValue({ id: 'b0000000-0000-0000-0000-0000000000ca', state: 'CA' }),
          create: txLocCreate,
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: 'b0000000-0000-0000-0000-0000000000ca' });

    expect(res.status).toBe(200);
    expect(txLocCreate!).not.toHaveBeenCalled();
    expect(res.body.tax_warning).toBeDefined();
    expect(res.body.tax_warning.old_state).toBe('TX');
    expect(res.body.tax_warning.new_state).toBe('CA');
  });

  it('does not return a tax_warning when the new location is the same state', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'TX' });
    (prisma.estimate.count as any).mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        lead: { update: vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'TX' }) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'tx-loc-id' }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        new_location: { address_line1: '999 TX Rd', city: 'Houston', state: 'TX', zip: '77001' },
      });

    expect(res.status).toBe(200);
    expect(res.body.tax_warning).toBeUndefined();
  });

  // ── Explicit null clear (anchor removal) ───────────────
  //
  // `{ service_location_id: null }` is a real write, not a no-op: it detaches the lead from its
  // ServiceLocation. It used to be swallowed by the `(service_location_id || addressForResolve)`
  // guard — null is falsy, so the block was skipped, nothing was assigned to leadData, and the
  // caller got a 200 for a write that never happened. These three tests pin the distinction
  // between an explicit null (clear), an estimate-frozen null (400) and an absent key (no-op).

  it('clears the anchor when service_location_id is explicitly null on an estimate-free lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      service_location_id: LOCATION_FIXTURE.id,
      service_location: { state: 'TX' },
    });
    (prisma.estimate.count as any).mockResolvedValue(0);
    let txLeadUpdate: ReturnType<typeof vi.fn>;
    let txLocFindFirst: ReturnType<typeof vi.fn>;
    let txLocCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txLeadUpdate = vi.fn().mockResolvedValue({
        ...LEAD_FIXTURE,
        service_location_id: null,
        service_location: null,
      });
      txLocFindFirst = vi.fn();
      txLocCreate = vi.fn();
      const txMock = {
        lead: { update: txLeadUpdate },
        serviceLocation: { findFirst: txLocFindFirst, create: txLocCreate },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: null });

    expect(res.status).toBe(200);
    // The write is what proves the clear happened — a 200 alone does not.
    const writtenData = txLeadUpdate!.mock.calls[0][0].data;
    expect(writtenData).toHaveProperty('service_location_id', null);
    expect(res.body.lead.service_location).toBeNull();
    // No resolution work: there is nothing to resolve or accrete.
    expect(txLocFindFirst!).not.toHaveBeenCalled();
    expect(txLocCreate!).not.toHaveBeenCalled();
    // A cleared anchor has no new state, so buildLocationTaxWarning has nothing to compare.
    expect(res.body).not.toHaveProperty('tax_warning');
    // The deprecated loose columns are NOT revived as a mirror of the anchor.
    expect(writtenData).not.toHaveProperty('service_address_line1');
    expect(writtenData).not.toHaveProperty('service_city');
    expect(writtenData).not.toHaveProperty('service_state');
    expect(writtenData).not.toHaveProperty('service_zip');
  });

  it('still rejects an explicit null clear once an estimate exists', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      service_location_id: LOCATION_FIXTURE.id,
    });
    (prisma.estimate.count as any).mockResolvedValue(1);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Location locked — lead has estimates');
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('leaves the anchor untouched when service_location_id is absent from the body', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      service_location_id: LOCATION_FIXTURE.id,
    });
    (prisma.estimate.count as any).mockResolvedValue(0);
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      service_location_id: LOCATION_FIXTURE.id,
      service_request: 'Reworded scope',
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_request: 'Reworded scope' });

    expect(res.status).toBe(200);
    const writtenData = mockPrisma.lead.update.mock.calls[0][0].data;
    expect(writtenData).not.toHaveProperty('service_location_id');
  });
});

// ═══════════════════════════════════════════════════════
// Phase 4a — Casual delete  DELETE /api/leads/:id
// ═══════════════════════════════════════════════════════

describe('DELETE /api/leads/:id (casual delete)', () => {
  it('deletes a lead with no estimate and no payment', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.estimate.count as any).mockResolvedValue(0);
    (prisma.payment.count as any).mockResolvedValue(0);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect((prisma.lead.delete as any)).toHaveBeenCalledWith({ where: { id: LEAD_FIXTURE.id } });
  });

  it('returns 400 when the lead has an estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.estimate.count as any).mockResolvedValue(2);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('estimates');
    expect((prisma.lead.delete as any)).not.toHaveBeenCalled();
  });

  it('returns 400 when a payment exists in the lead subtree', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    (prisma.estimate.count as any).mockResolvedValue(0);
    (prisma.payment.count as any).mockResolvedValue(1);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('payments');
    expect((prisma.lead.delete as any)).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-existent lead', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/leads/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('allows SALES to delete own lead but 403 on another users lead', async () => {
    // Own lead → 204
    mockAuthAs('sales');
    // LEAD_FIXTURE is already owned by sales via the M2M (commission_owner_id + lead_assignees).
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    // #106 P1: ownership now enforced via canAccessRow's scoped findFirst — owned → visible.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    (prisma.estimate.count as any).mockResolvedValue(0);
    (prisma.payment.count as any).mockResolvedValue(0);

    const ownRes = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));
    expect(ownRes.status).toBe(204);

    // Another user's lead → 403 (scoped findFirst sees nothing under the SALES owner scope).
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.admin.id, lead_assignees: [{ user_id: TEST_USERS.admin.id }] });
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    const otherRes = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));
    expect(otherRes.status).toBe(403);
  });

  it('returns 403 for TECHNICIAN', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// Phase 4a — Cancel/Lost cascade re-key (deposit invoices)
// ═══════════════════════════════════════════════════════

describe('Lead cancel/lost cascade — deposit invoice void (Phase 4a)', () => {
  it('markLost voids unpaid kind=DEPOSIT invoices (the SOLE deposit document)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST' });
    (prisma.estimate.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.estimate.findMany as any).mockResolvedValue([{ id: 'est-1' }]);
    // One unpaid DEPOSIT invoice (SENT, no non-voided payment)
    (prisma.invoice.findMany as any).mockResolvedValue([{ id: 'dep-inv-1', payments: [] }]);
    (prisma.invoice.updateMany as any).mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Customer chose competitor' });

    expect(res.status).toBe(200);

    // Estimates still auto-cancelled
    expect((prisma.estimate.updateMany as any).mock.calls[0][0].data.status).toBe('ARCHIVED');
    // The deposit-Invoice is voided
    const invFindWhere = (prisma.invoice.findMany as any).mock.calls[0][0].where;
    expect(invFindWhere.kind).toBe('DEPOSIT');
    expect(invFindWhere.status).toEqual({ in: ['DRAFT', 'SENT'] });
    const invUpdate = (prisma.invoice.updateMany as any).mock.calls[0][0];
    expect(invUpdate.where.id).toEqual({ in: ['dep-inv-1'] });
    expect(invUpdate.data.status).toBe('VOIDED');
  });

  it('cancelLead does NOT void a kind=DEPOSIT invoice that has a non-voided payment', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });
    (prisma.estimate.findMany as any).mockResolvedValue([{ id: 'est-1' }]);
    // The deposit invoice carries a real payment — it must be excluded from the void set.
    (prisma.invoice.findMany as any).mockResolvedValue([{ id: 'dep-inv-paid', payments: [{ id: 'pay-1' }] }]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    expect((prisma.invoice.updateMany as any)).not.toHaveBeenCalled();
  });

  // A no-op (already CANCELLED) is the one case this door still refuses (PRD D10 lets a Won or Lost
  // lead be cancelled), and when it does, no cascade runs.
  it('cancelLead blocked once already CANCELLED — no cascade runs', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cancelled');
    expect((prisma.estimate.updateMany as any)).not.toHaveBeenCalled();
    expect((prisma.invoice.findMany as any)).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// List status default — returns ALL statuses (open-pipeline default removed)
// ═══════════════════════════════════════════════════════

describe('GET /api/leads (no status default)', () => {
  it('returns ALL statuses by default (no filter, no search)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    // No status constraint → WON/LOST/CANCELLED are included alongside the open pipeline.
    expect(where.status).toBeUndefined();
  });

  it('returns terminal leads when a status filter is supplied', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads?status=WON').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('WON');
  });

  it('applies no status constraint when search is supplied', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads?search=smith').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
    expect(where.OR).toBeDefined();
  });

  it('stat counts are computed independently of the list where', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    // findMany.where, total.where, then the 5 stat wheres
    mockPrisma.lead.count.mockResolvedValue(0);

    const res = await request(app).get('/api/leads').set(authHeader('admin'));

    expect(res.status).toBe(200);
    // count() call order (Promise.all): [0]=page total (uses the page where),
    // [1..5]=the 5 stat wheres (independent).
    const countCalls = mockPrisma.lead.count.mock.calls.map((c: any[]) => c[0].where);
    const statWheres = countCalls.slice(1); // skip the page total

    // won_this_month / lost_this_month stats still explicitly target WON / LOST.
    expect(statWheres.find((w: any) => w.status === 'WON')).toBeDefined();
    expect(statWheres.find((w: any) => w.status === 'LOST')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough/performers (setPerformers — performer-only REPLACE)
// ═══════════════════════════════════════════════════════
//
// REPLACE the walkthrough performer set WITHOUT touching status or walkthrough_scheduled_at.
// Diff-emails per added/removed performer; NO customer email; NO flag change.
// Mirrors POST /api/jobs/:id/assignees.
//
// Walkthrough-as-entity redesign, PR-B2: today this had NO status guard at all — performers
// could be swapped on a lead in ANY status, including a WON/LOST one whose visit is long over.
// New guard: performers can only be set on the lead's ACTIVE (REQUESTED/SCHEDULED) visit — this
// rejects the terminal (COMPLETED/CANCELLED) and the "no visit at all" case.
describe('POST /api/leads/:id/walkthrough/performers', () => {
  // The handler replaces performers on the ACTIVE walkthrough (found pre-transaction via
  // findActiveWalkthrough) inside a $transaction, then re-reads the lead via tx.lead.findUnique
  // (NOT lead.update) to return the updated detail.
  function wirePerformersTx(updated: any, currentPerformers: { user_id: string }[] = []) {
    const txFindMany = vi.fn().mockResolvedValue(currentPerformers);
    const txCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txLeadFindUnique = vi.fn().mockResolvedValue(updated);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        visitAssignee: { findMany: txFindMany, createMany: txCreateMany, deleteMany: txDeleteMany },
        lead: { findUnique: txLeadFindUnique },
      }),
    );
    return { txFindMany, txCreateMany, txDeleteMany, txLeadFindUnique };
  }

  beforeEach(() => {
    // loadGrantsFor() calls rolePermission.findMany for performer validation.
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) =>
        Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role))
    );
    // validatePerformers calls prisma.user.findUnique per performer id.
    (prisma.user.findUnique as any).mockImplementation(
      (args: { where: { id: string } }) => {
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match || null);
      },
    );
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);
  });

  it('200 + updated lead returned via detail select', async () => {
    mockAuthAs('admin');
    const scheduledLead = { ...LEAD_FIXTURE, status: 'CONTACTED' };
    mockPrisma.lead.findUnique.mockResolvedValue(scheduledLead);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01T09:00:00Z'), assignees: [],
    });
    const updatedLead = { ...scheduledLead, visit_assignees: [{ user_id: TEST_USERS.sales.id, user: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales', email: 'sales@test.com' } }] };
    wirePerformersTx(updatedLead);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    expect(res.status).toBe(200);
    expect(res.body.lead).toBeDefined();
  });

  it('returns 400 when the lead has no active (REQUESTED/SCHEDULED) visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'WON' });
    mockPrisma.visit.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    expect(res.status).toBe(400);
  });

  it('REPLACE semantics: replaceVisitCrew deleteMany/createMany called inside tx', async () => {
    mockAuthAs('admin');
    // Current performer: technician (will be removed). New performer: sales (will be added).
    const existingLead = { ...LEAD_FIXTURE, status: 'CONTACTED' };
    mockPrisma.lead.findUnique.mockResolvedValue(existingLead);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01T09:00:00Z'),
      assignees: [{ user_id: TEST_USERS.technician.id }],
    });
    const tx = wirePerformersTx(
      { ...existingLead, visit_assignees: [{ user_id: TEST_USERS.sales.id }] },
      [{ user_id: TEST_USERS.technician.id }], // current performers passed to replaceVisitCrew
    );

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    // The tx ran replaceVisitCrew which calls deleteMany (old) then createMany (new)
    expect(tx.txDeleteMany).toHaveBeenCalled();
    expect(tx.txCreateMany).toHaveBeenCalled();
    // The tx re-reads the lead via findUnique (NOT lead.update — status/schedule untouched)
    expect(tx.txLeadFindUnique).toHaveBeenCalled();
  });

  it('does NOT write status or walkthrough_scheduled_at (performer-only mutation)', async () => {
    mockAuthAs('admin');
    const scheduledLead = { ...LEAD_FIXTURE, status: 'CONTACTED' };
    mockPrisma.lead.findUnique.mockResolvedValue(scheduledLead);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01T09:00:00Z'), assignees: [],
    });
    const tx = wirePerformersTx(scheduledLead);

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    // The handler uses tx.lead.findUnique (re-read), not tx.lead.update — no update call at all.
    // Verify no lead.update was made (would carry status/schedule if it were called).
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    // The tx re-read (findUnique) does not carry status or walkthrough_scheduled_at writes.
    const findUniqueCall = tx.txLeadFindUnique.mock.calls[0][0];
    expect(findUniqueCall.where?.id).toBe(LEAD_FIXTURE.id);
    // No data property (it's a findUnique, not update)
    expect((findUniqueCall as any).data).toBeUndefined();
  });

  it('dispatches WALKTHROUGH_PERFORMER_ASSIGNED for the added performer, WALKTHROUGH_PERFORMER_REMOVED (with recipient) for the removed one', async () => {
    mockAuthAs('admin');
    const existingLead = { ...LEAD_FIXTURE, status: 'CONTACTED' };
    mockPrisma.lead.findUnique.mockResolvedValue(existingLead);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01T09:00:00Z'),
      assignees: [{ user_id: TEST_USERS.technician.id }],
    });
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TEST_USERS.technician.id, email: 'tech@test.com', first_name: 'Test', last_name: 'Tech' },
    ]);
    wirePerformersTx(
      { ...existingLead, visit_assignees: [{ user_id: TEST_USERS.sales.id }] },
      [{ user_id: TEST_USERS.technician.id }],
    );

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    // Added performer (sales) → WALKTHROUGH_PERFORMER_ASSIGNED
    const assigned = dispatchedType('WALKTHROUGH_PERFORMER_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ occurrenceKey: TEST_USERS.sales.id });
    // Removed performer (technician) → WALKTHROUGH_PERFORMER_REMOVED, carrying their identity
    const removed = dispatchedType('WALKTHROUGH_PERFORMER_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      occurrenceKey: TEST_USERS.technician.id,
      eventPayload: { recipient: { email: 'tech@test.com' } },
    });
    // NO customer dispatch — /walkthrough/performers is performer-only (no schedule/customer path)
    expect(dispatchedType('WALKTHROUGH_SCHEDULED')).toHaveLength(0);
  });

  it('accepts a DISPATCHER performer (#366: all active users walkthrough-eligible)', async () => {
    mockAuthAs('admin');
    const scheduledLead = { ...LEAD_FIXTURE, status: 'CONTACTED' };
    mockPrisma.lead.findUnique.mockResolvedValue(scheduledLead);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-04-01T09:00:00Z'), assignees: [],
    });
    const tx = wirePerformersTx({ ...scheduledLead, visit_assignees: [{ user_id: TEST_USERS.dispatcher.id }] });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.dispatcher.id] });

    expect(res.status).toBe(200);
    expect(tx.txCreateMany).toHaveBeenCalled();
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/walkthrough/performers')
      .set(authHeader('admin'))
      .send({ performer_ids: [TEST_USERS.sales.id] });

    expect(res.status).toBe(404);
  });

  it('returns 403 for TECHNICIAN (lacks schedule_walkthrough permission)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('technician'))
      .send({ performer_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/walkthrough/unschedule (unscheduleWalkthrough)
// ═══════════════════════════════════════════════════════
//
// Clear the walkthrough TIME → status CONTACTED. KEEPS performers (no deleteMany).
// NO email (distinct from cancelWalkthrough). Mirrors POST /api/jobs/:id/unassign.
//
// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status; the row
// returns to REQUESTED, performers retained. Walkthrough update + lead update + timeline write
// now share ONE transaction (previously the timeline write sat outside it).
describe('POST /api/leads/:id/walkthrough/unschedule', () => {
  beforeEach(() => {
    mockPrisma.visit.update.mockResolvedValue({});
  });

  // Multi-visit D22a: with REQUESTED retired there is no "booked but timeless" state to fall
  // back to, so unscheduling a trip cancels its row. The row is KEPT, never deleted - the
  // customer may hold an email naming it, and deleting it would make the first-time-fix /
  // callback data (SRVW-41) unrecoverable.
  it('200: cancels the visit row and leaves the lead status alone', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      walkthrough_scheduled_at: null,
    });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CONTACTED');
    // A GUARDED updateMany, not a bare update: the target was resolved by a read that ran
    // before the transaction opened, so the accept-set is re-tested in the WHERE and the door
    // reads `count` to learn whether it was the one that landed the transition.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wt-scheduled-1', status: { in: expect.arrayContaining(['SCHEDULED']) } }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
  });

  // The lead's status follows its visits: taking the last open visit off a Walkthrough Scheduled
  // lead that never had a finished visit sends it back to Contacted. The row is re-read and the
  // visits counted under the lead lock (through the shared mock here).
  it('the last open visit going back to Contacted: Walkthrough Scheduled -> Contacted, one History row', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'WALKTHROUGH_SCHEDULED' });
    mockPrisma.lead.findFirst.mockResolvedValue({ status: 'WALKTHROUGH_SCHEDULED' });
    (prisma.visit.count as any).mockResolvedValue(0);
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    const statusWrites = leadStatusWrites(mockPrisma.lead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('CONTACTED');
    const ledger = statusChangeEvents();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'CONTACTED' });
    expect(ledger[0].description).toBe('Lead moved back to Contacted: its walkthrough was cancelled');
    // The remaining lead.update is the re-read for the response shape and carries nothing.
    expect(mockPrisma.lead.update.mock.calls[0][0].data).toEqual({});
  });

  // Regression (PRD 2.3): this door used to pull an Estimate Sent lead back to Contacted.
  it('an ESTIMATED lead stays ESTIMATED when its last open visit is unscheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    mockPrisma.lead.findFirst.mockResolvedValue({ status: 'ESTIMATED' });
    (prisma.visit.count as any).mockResolvedValue(0);
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(leadStatusWrites(mockPrisma.lead.updateMany)).toHaveLength(0);
    expect(statusChangeEvents()).toHaveLength(0);
  });

  it('does NOT delete/replace performers (crew kept — no performer deleteMany call)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    // Now wrapped in a transaction (timeline write moved inside — see the handler's own note),
    // but it never touches performers.
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.visitAssignee.deleteMany).not.toHaveBeenCalled();
    const updateCall = mockPrisma.lead.update.mock.calls[0][0];
    expect((updateCall.data as any).leadWalkthroughPerformer).toBeUndefined();
    expect((updateCall.data as any).visit_assignees).toBeUndefined();
  });

  it('does NOT dispatch any automation event (no walkthrough or customer notification)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns 400 when the lead has no SCHEDULED visit', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scheduled walkthrough');
  });

  it('returns 404 when lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/leads/00000000-0000-0000-0000-999999999999/walkthrough/unschedule')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 for TECHNICIAN (lacks schedule_walkthrough permission)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('DISPATCHER can unschedule a walkthrough', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });
});

// ─── GET /api/leads/export ─────────────────────────────

describe('GET /api/leads/export', () => {
  it('returns all matching rows under the {leads} envelope, unpaginated', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);

    const res = await request(app).get('/api/leads/export').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    const args = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
  });

  it('applies the status filter just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);

    await request(app).get('/api/leads/export?status=NEW').set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].where.status).toBe('NEW');
  });

  it('scopes export to the SALES user\'s own leads (row-scope respected)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findMany.mockResolvedValue([]);

    await request(app).get('/api/leads/export').set(authHeader('sales'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].where.lead_assignees)
      .toEqual({ some: { user_id: TEST_USERS.sales.id } });
  });

  // LED-B3: tenant isolation — the export where must carry the org scope so cross-org
  // rows are never returned (same tenantWhere() the list uses).
  it('scopes export to the requesting org (tenant isolation)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);

    await request(app).get('/api/leads/export').set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  // LED-B6: select parity — export uses the same list select shape so every CSV column
  // has data (asserts the key list-only relations the detail-less export still needs).
  it('uses the list select shape (envelope + column parity)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);

    await request(app).get('/api/leads/export').set(authHeader('admin'));

    const args = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(args.select.lead_number).toBe(true);
    expect(args.select.status).toBe(true);
    expect(args.select.customer).toBeDefined();
    expect(args.select.commission_owner).toBeDefined();
    // S8 (D6): the walkthrough crew is selected through the lead's TRIPS now
    // (`visit_assignees.lead_id` is dropped); the projected wire key is unchanged.
    expect(args.select.visits.select.assignees).toBeDefined();
    expect(args.select.visit_assignees).toBeUndefined();
    expect(args.select.estimates).toBeDefined();
  });

  // LED-B1 / LED-B7: defensive row cap — findMany is called with take: 50_000 (not the
  // list page size) and no logger.warn when the cap is not hit.
  it('passes the defensive take: 50_000 cap and does not warn below the cap', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    const warnSpy = vi.spyOn(logger, 'warn');

    await request(app).get('/api/leads/export').set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].take).toBe(50_000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // LED-B7: logger.warn fires when the row cap is hit (returned rows === cap).
  it('logs a warning when the export hits the row cap', async () => {
    mockAuthAs('admin');
    const capRows = Array.from({ length: 50_000 }, () => LEAD_FIXTURE);
    mockPrisma.lead.findMany.mockResolvedValue(capRows);
    const warnSpy = vi.spyOn(logger, 'warn');

    await request(app).get('/api/leads/export').set(authHeader('admin'));

    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toContain('row cap');
    warnSpy.mockRestore();
  });

  // LED-B5: auth gate — unauthenticated request rejected.
  it('returns 401 without auth header', async () => {
    const res = await request(app).get('/api/leads/export');
    expect(res.status).toBe(401);
  });
});

// ─── Multi-visit S8 (behaviour 16) ────────────────────────────────────────────────────────────
// `visit_assignees.lead_id` is dropped, so a lead's walkthrough crew is reached one array level
// deeper, through `lead.visits[].assignees`. THE WIRE KEY THE FRONTEND READS DOES NOT CHANGE -
// that is the whole insulation.
//
// That wire key is `walkthrough_performers`, not `visit_assignees`. #1637/#1642 landed after this
// slice was cut and restored the pre-S1 public name, because S1's relation rename had silently
// blanked six frontend readers. So the projection is now TWO hops, and this test pins both:
// projectLeadVisitCrew resolves `visits[].assignees` onto the internal `visit_assignees`, then
// projectLeadWalkthroughFields renames that to `walkthrough_performers` on the way out. Asserting
// the outgoing name rather than the intermediate one is the point - the intermediate is private.
//
// WHAT CHANGED (#1952): S8 flat-mapped EVERY visit's assignees together and this test pinned the
// resulting union, dedupe deliberately absent. That union was wrong for all four of its readers -
// each describes ONE visit - so it printed "with Mike Turner, Mike Turner" on the lead card, and
// it dead-ended the walkthrough form on a lead whose visits were all cancelled: the field seeded
// a technician off a dead trip, locked, on a save `findActiveWalkthrough` answers 403 for. The
// crew is now the CURRENT visit's alone (resolveCurrentWalkthrough - the same visit the flat
// walkthrough_* fields describe), which is what the assertions below pin.
describe('S8 - the lead payload keeps its walkthrough crew key across the relation move', () => {
  const U1 = '00000000-0000-0000-0000-0000000000c1';
  const U2 = '00000000-0000-0000-0000-0000000000c2';
  const LEAD_ID = 'e0000000-0000-0000-0000-0000000000c9';

  function crewUser(id: string) {
    return { id, first_name: 'F', last_name: 'L', email: `${id}@t.com` };
  }
  function snapshot(id: string, scheduledAt: string) {
    return {
      id, status: 'SCHEDULED', scheduled_at: new Date(scheduledAt), duration_minutes: 60,
      completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null, cancelled_by: null,
      customer_email_sent_at: null, created_at: new Date('2026-08-01T00:00:00Z'), canceller: null,
    };
  }

  it('serves the CURRENT visit\'s crew, reached through the trips', async () => {
    mockAuthAs('admin');
    (prisma.lead.findUnique as any).mockImplementation(async (args: any) => {
      const select = args?.select ?? {};
      if (Object.keys(select).length <= 1) return { id: LEAD_ID };
      return {
        id: LEAD_ID,
        lead_number: 'L00001',
        status: 'NEW',
        organization_id: ALPHA_ORG_ID,
        customer: null,
        commission_owner: null,
        lead_assignees: [],
        estimates: [],
        visits: [
          // The LATER trip first in array order, so "earliest live" is doing the picking and not
          // the order the rows happen to arrive in.
          { ...snapshot('v2', '2026-09-08T14:00:00Z'), assignees: [{ user_id: U2, user: crewUser(U2) }] },
          { ...snapshot('v1', '2026-09-01T14:00:00Z'), assignees: [{ user_id: U1, user: crewUser(U1) }, { user_id: U2, user: crewUser(U2) }] },
        ],
      };
    });

    const res = await request(app).get(`/api/leads/${LEAD_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    // v1's set, entire and unmerged: the EARLIEST live visit is the one the flat
    // walkthrough_scheduled_at names and the one findActiveWalkthrough hands the validator, so
    // it is the one whose crew the wire has to carry. U2 rides on both trips and appears ONCE.
    const crew = res.body.lead.walkthrough_performers as { user_id: string }[];
    expect(crew.map((c) => c.user_id)).toEqual([U1, U2]);

    // The internal hop must not leak: only the restored public name reaches the client.
    expect(res.body.lead).not.toHaveProperty('visit_assignees');

    // And the dead back-relation is gone from the query itself.
    const detailCall = (prisma.lead.findUnique as any).mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => Object.keys(a.select ?? {}).length > 1);
    expect(detailCall.select).not.toHaveProperty('visit_assignees');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/:id — the lead's OWN anchored service location
// (entity-redesign §3/§10, slice 01)
// ═══════════════════════════════════════════════════════
//
// The discriminating fixture is a customer holding THREE locations whose lead is anchored to a
// NON-PRIMARY one. A single-location customer, or a lead anchored to the primary, would pass
// against the old (roster-only) payload and prove nothing.
//
// Prisma is mocked in this suite, so a mock that resolves a whole row regardless of `select`
// would return the anchor whether or not the controller asked for it. `selectFrom` below is a
// faithful-enough Prisma stand-in: it projects the row through the select the controller
// actually passed, so the assertions below are about what goes over the wire — not about the
// shape of the select object.
function selectFrom(row: any, select: any): any {
  if (row === null || row === undefined) return row ?? null;
  if (Array.isArray(row)) return row.map((r) => selectFrom(r, select));
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select ?? {})) {
    if (spec === true) out[key] = row[key];
    else if (spec && typeof spec === 'object' && 'select' in (spec as Record<string, unknown>)) {
      out[key] = selectFrom(row[key], (spec as { select: unknown }).select);
    }
  }
  return out;
}

const HEAD_OFFICE = {
  id: 'b0000000-0000-0000-0000-0000000000a1',
  customer_id: CUSTOMER_FIXTURE.id,
  address_line1: '1 Head Office Plaza',
  address_line2: 'Suite 900',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  is_primary: true,
};
const WAREHOUSE = {
  id: 'b0000000-0000-0000-0000-0000000000a2',
  customer_id: CUSTOMER_FIXTURE.id,
  address_line1: '456 Warehouse Way',
  address_line2: 'Bay 4',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  is_primary: false,
};
const ANNEX = {
  id: 'b0000000-0000-0000-0000-0000000000a3',
  customer_id: CUSTOMER_FIXTURE.id,
  address_line1: '789 Annex Rd',
  address_line2: null,
  city: 'Pflugerville',
  state: 'TX',
  zip: '78660',
  is_primary: false,
};

// The lead is anchored to the WAREHOUSE — not the customer's primary.
const MULTI_LOCATION_LEAD_ROW = {
  ...LEAD_FIXTURE,
  service_location_id: WAREHOUSE.id,
  service_location: WAREHOUSE,
  customer: {
    ...LEAD_FIXTURE.customer,
    service_locations: [HEAD_OFFICE, WAREHOUSE, ANNEX],
  },
};

describe("GET /api/leads/:id — the lead's anchored service location", () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) =>
      selectFrom(MULTI_LOCATION_LEAD_ROW, args.select));
  });

  it("returns the location the lead is anchored to, with its full address, not the customer's primary", async () => {
    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.service_location).toMatchObject({
      id: WAREHOUSE.id,
      address_line1: '456 Warehouse Way',
      address_line2: 'Bay 4',
      city: 'Round Rock',
      state: 'TX',
      zip: '78664',
    });
  });

  it("still returns the customer's full location roster", async () => {
    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.customer.service_locations.map((l: any) => l.address_line1))
      .toEqual(['1 Head Office Plaza', '456 Warehouse Way', '789 Annex Rd']);
  });

  it('returns a null anchor for a lead that has none', async () => {
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) =>
      selectFrom({ ...MULTI_LOCATION_LEAD_ROW, service_location_id: null, service_location: null }, args.select));

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.service_location).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/leads/:id — a legacy lead's loose inline address
// (entity-redesign §3/§10, slice 02)
// ═══════════════════════════════════════════════════════
//
// Slice 02 renders the deprecated inline `service_address_*` columns as the fallback for leads
// created before the anchor existed. Its issue asserted no response change was needed because
// those columns are already selected — this pins that claim so a future tidy-up of
// leadDetailSelect cannot quietly blank the legacy panel. (Verified true when slice 02 was
// written: the fields were already in the select, so this test was green on arrival.)
//
// It does NOT extend the life of those columns: they remain deprecated and scheduled for removal
// by their own phase of the redesign, and this asserts only that they are readable while they
// still exist.
describe('GET /api/leads/:id — a lead with no anchor still carries its legacy loose address', () => {
  beforeEach(() => {
    mockAuthAs('admin');
  });

  it('returns the deprecated inline address fields when the lead has no anchored location', async () => {
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) =>
      selectFrom({
        ...MULTI_LOCATION_LEAD_ROW,
        service_location_id: null,
        service_location: null,
        service_address_line1: '900 Legacy Ln',
        service_address_line2: 'Unit 3',
        service_city: 'Dallas',
        service_state: 'TX',
        service_zip: '75201',
      }, args.select));

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.service_location).toBeNull();
    expect(res.body.lead).toMatchObject({
      service_address_line1: '900 Legacy Ln',
      service_address_line2: 'Unit 3',
      service_city: 'Dallas',
      service_state: 'TX',
      service_zip: '75201',
    });
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/leads/:id — re-pointing the lead's anchor (slice 03)
// ═══════════════════════════════════════════════════════
//
// NO NEW ENDPOINT. The lead update path already accepts `service_location_id` OR a
// `new_location` payload, already resolves-or-accretes against the customer, and already
// computes the cross-state tax warning. Slice 03 is a new CONSUMER of that behaviour, so what
// these lock is the CONTRACT the lead page now depends on — specifically that the PATCH
// response carries the lead's NEW anchor and the customer's grown roster, so the page can
// re-read and show the change. (The freeze and the tax-warning states themselves are already
// held by 'PATCH /api/leads/:id (edit-freeze + tax-warning)' above; these do not restate them.)
//
// The tx `lead.update` below projects through the select the controller actually passed
// (`selectFrom`), so a response field is only present here if the controller really asked the
// database for it — the assertions are about what goes over the wire, not about select shapes.
describe('PATCH /api/leads/:id — re-pointing the anchor', () => {
  const SAN_DIEGO = {
    id: 'b0000000-0000-0000-0000-0000000000ca',
    customer_id: CUSTOMER_FIXTURE.id,
    address_line1: '1 Harbor Dr',
    address_line2: null,
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    is_primary: false,
  };

  /**
   * A small in-memory stand-in for the customer's ServiceLocation table: `create` appends to
   * the roster, and the lead row the update returns is rebuilt from that roster. This is what
   * makes "a new address is saved onto the customer" observable over the wire — the response's
   * `customer.service_locations` grows — rather than by asserting that a Prisma method was
   * called, which would say nothing about what a user of the API gets back.
   */
  function serveRepoint(startingRoster: any[], anchorTo?: (roster: any[]) => any) {
    const roster = [...startingRoster];
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, service_state: 'TX' });
    (prisma.estimate.count as any).mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        lead: {
          update: async (args: any) => {
            const anchor = anchorTo
              ? anchorTo(roster)
              : roster.find((l) => l.id === args.data.service_location_id) ?? null;
            return selectFrom({
              ...LEAD_FIXTURE,
              service_location_id: args.data.service_location_id ?? null,
              service_location: anchor,
              customer: { ...LEAD_FIXTURE.customer, service_locations: roster },
            }, args.select);
          },
        },
        serviceLocation: {
          findFirst: async (args: any) =>
            roster.find((l) => l.id === args.where?.id) ?? null,
          create: async (args: any) => {
            const created = { id: 'accreted-loc-id', customer_id: CUSTOMER_FIXTURE.id, ...args.data };
            roster.push(created);
            return created;
          },
        },
      };
      return fn(txMock);
    });
    return roster;
  }

  it("returns the lead re-anchored to the picked location, with that location's full address", async () => {
    serveRepoint([HEAD_OFFICE, WAREHOUSE, ANNEX]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: ANNEX.id });

    expect(res.status).toBe(200);
    expect(res.body.lead.service_location).toMatchObject({
      id: ANNEX.id,
      address_line1: '789 Annex Rd',
      city: 'Pflugerville',
      state: 'TX',
      zip: '78660',
    });
  });

  it("saves a brand-new address onto the customer and anchors the lead to it", async () => {
    const roster = serveRepoint([HEAD_OFFICE, WAREHOUSE, ANNEX]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        new_location: {
          address_line1: '55 Brand New Blvd', city: 'Georgetown', state: 'TX', zip: '78626',
        },
      });

    expect(res.status).toBe(200);
    // The lead now points at the new address …
    expect(res.body.lead.service_location).toMatchObject({
      address_line1: '55 Brand New Blvd', city: 'Georgetown', zip: '78626',
    });
    // … and it belongs to the CUSTOMER now, so the next lead for this site can just pick it.
    expect(res.body.lead.customer.service_locations.map((l: any) => l.address_line1))
      .toContain('55 Brand New Blvd');
    expect(roster.find((l) => l.address_line1 === '55 Brand New Blvd')?.customer_id)
      .toBe(CUSTOMER_FIXTURE.id);
  });

  it('returns the tax warning alongside the re-anchored lead on a cross-state move', async () => {
    serveRepoint([HEAD_OFFICE, WAREHOUSE, SAN_DIEGO]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: SAN_DIEGO.id });

    expect(res.status).toBe(200);
    // Both facts arrive in ONE response — the page needs the new anchor to redraw the panel
    // AND the warning to show, and it makes only this one request.
    expect(res.body.lead.service_location).toMatchObject({ id: SAN_DIEGO.id, state: 'CA' });
    expect(res.body.tax_warning).toEqual({ tax_warning: true, old_state: 'TX', new_state: 'CA' });
  });

  /**
   * A stateful stand-in for the lead row: the anchor MOVES with each re-point, while the
   * deprecated loose `service_*` columns stay exactly as the update path leaves them — untouched
   * (only CREATE ever writes them). That is the whole point of this fixture: a mock that
   * re-served a constant `service_state: 'TX'` AND a constant anchor could never tell the two
   * possible bases apart, so it would pass against the bug.
   */
  function serveRepointChain(roster: any[], startingAnchor: any) {
    mockAuthAs('admin');
    (prisma.estimate.count as any).mockResolvedValue(0);
    const leadRow: any = {
      ...LEAD_FIXTURE,
      // Frozen at the state the lead was CREATED in and never updated again.
      service_state: 'TX',
      service_location_id: startingAnchor?.id ?? null,
      service_location: startingAnchor,
      customer: { ...LEAD_FIXTURE.customer, service_locations: roster },
    };
    // `update()` reads `existing` with no select, so hand back the whole row.
    mockPrisma.lead.findUnique.mockImplementation(async () => ({ ...leadRow }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        lead: {
          update: async (args: any) => {
            const anchor = roster.find((l) => l.id === args.data.service_location_id) ?? null;
            leadRow.service_location_id = args.data.service_location_id ?? null;
            leadRow.service_location = anchor;
            return selectFrom(leadRow, args.select);
          },
        },
        serviceLocation: {
          findFirst: async (args: any) => roster.find((l) => l.id === args.where?.id) ?? null,
          create: vi.fn(),
        },
      };
      return fn(txMock);
    });
    return leadRow;
  }

  const repoint = (locationId: string) =>
    request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: locationId });

  it('computes the tax warning from the CURRENT anchor on a SECOND re-point, not the stale create-time column', async () => {
    const leadRow = serveRepointChain([HEAD_OFFICE, SAN_DIEGO], HEAD_OFFICE);

    // Move 1 — TX → CA. Correct either way; this is only setup for the move that matters.
    const first = await repoint(SAN_DIEGO.id);
    expect(first.status).toBe(200);
    expect(first.body.tax_warning).toEqual({ tax_warning: true, old_state: 'TX', new_state: 'CA' });
    // The re-point did NOT write the deprecated column — it is now stale by design.
    expect(leadRow.service_state).toBe('TX');

    // Move 2 — CA → TX. A real cross-state move. Reading the stale column would compare
    // 'TX' with 'TX' and return NO warning at all.
    const second = await repoint(HEAD_OFFICE.id);
    expect(second.status).toBe(200);
    expect(second.body.lead.service_location).toMatchObject({ id: HEAD_OFFICE.id, state: 'TX' });
    expect(second.body.tax_warning).toEqual({ tax_warning: true, old_state: 'CA', new_state: 'TX' });
  });

  it('reports no warning for a same-state second move, even though the stale column agrees by accident', async () => {
    serveRepointChain([HEAD_OFFICE, WAREHOUSE, SAN_DIEGO], HEAD_OFFICE);

    await repoint(SAN_DIEGO.id);
    // CA → CA is not a move at all as far as tax is concerned … but the anchor is CA and the
    // stale column is 'TX', so a stale-basis read would invent a "TX → CA" warning here.
    const second = await repoint(SAN_DIEGO.id);

    expect(second.status).toBe(200);
    expect(second.body.tax_warning).toBeUndefined();
  });

  it('falls back to the deprecated column for a legacy lead that has no anchor to read', async () => {
    // Unanchored legacy row: service_location_id is null, only the loose columns say TX.
    serveRepointChain([SAN_DIEGO], null);

    const res = await repoint(SAN_DIEGO.id);

    expect(res.status).toBe(200);
    expect(res.body.tax_warning).toEqual({ tax_warning: true, old_state: 'TX', new_state: 'CA' });
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/leads/:id — the estimate freeze, from the caller's side (slice 04)
// ═══════════════════════════════════════════════════════
//
// Entity-redesign §10 EDIT-FREEZE. Once a lead has ≥1 estimate its location is frozen: the
// estimate is priced against that address, including its tax state, so re-pointing it would
// invalidate money already quoted.
//
// The freeze itself is not new and its refusal is already asserted above ('rejects a location
// change once an estimate exists'). What that test does NOT establish is the half slice 04's
// UI leans on: that the lead is genuinely LEFT ALONE. It asserts `prisma.lead.update` was not
// called — an implementation fact, and one the update path no longer even routes through (the
// write happens on the transaction client). This asserts the outcome a caller can see instead:
// after the refusal, reading the lead back over the wire still returns the anchor it had.
//
// The transaction stand-in below WOULD re-point the lead if the request got that far, so this
// cannot pass by the request merely erroring out short of the write.
describe('PATCH /api/leads/:id — a lead with estimates keeps the location it was quoted at', () => {
  function serveFrozenLead(estimateCount: number) {
    mockAuthAs('admin');
    (prisma.estimate.count as any).mockResolvedValue(estimateCount);
    const roster = [HEAD_OFFICE, WAREHOUSE, ANNEX];
    const leadRow: any = {
      ...LEAD_FIXTURE,
      service_location_id: WAREHOUSE.id,
      service_location: WAREHOUSE,
      customer: { ...LEAD_FIXTURE.customer, service_locations: roster },
    };
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) =>
      (args.select ? selectFrom(leadRow, args.select) : { ...leadRow }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        lead: {
          update: async (args: any) => {
            leadRow.service_location_id = args.data.service_location_id ?? null;
            leadRow.service_location = roster.find((l) => l.id === args.data.service_location_id) ?? null;
            return selectFrom(leadRow, args.select);
          },
        },
        serviceLocation: {
          findFirst: async (args: any) => roster.find((l) => l.id === args.where?.id) ?? null,
          create: vi.fn(),
        },
      };
      return fn(txMock);
    });
  }

  const readLead = () =>
    request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

  it('refuses the re-point with a client error naming the reason, and the lead still reads as anchored where it was', async () => {
    serveFrozenLead(1);

    const refused = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: ANNEX.id });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Location locked — lead has estimates');

    // Unchanged: the address the estimate was priced against is still the lead's anchor.
    const after = await readLead();
    expect(after.status).toBe(200);
    expect(after.body.lead.service_location).toMatchObject({
      id: WAREHOUSE.id,
      address_line1: '456 Warehouse Way',
      state: 'TX',
    });
  });

  it('refuses a brand-new address on a lead with estimates just as it refuses a pick', async () => {
    serveFrozenLead(1);

    const refused = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ new_location: { address_line1: '1 Harbor Dr', city: 'San Diego', state: 'CA', zip: '92101' } });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Location locked — lead has estimates');

    const after = await readLead();
    expect(after.body.lead.service_location).toMatchObject({ id: WAREHOUSE.id });
  });

  // The contrast that makes the two above mean something: the SAME request, the SAME fixture,
  // differing only in the estimate count, does re-point the lead. Without this, both could pass
  // against an endpoint that refuses every location change outright.
  it('accepts the same re-point on the same lead when it has no estimates', async () => {
    serveFrozenLead(0);

    const accepted = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: ANNEX.id });

    expect(accepted.status).toBe(200);
    expect(accepted.body.lead.service_location).toMatchObject({ id: ANNEX.id, address_line1: '789 Annex Rd' });
  });
});
