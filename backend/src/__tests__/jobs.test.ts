import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  TEST_ORG,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
  STANDALONE_JOB_FIXTURE_2,
  STANDALONE_JOB_FIXTURE,
  ALPHA_ORG_ID,
  LEAD_FIXTURE,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
  mockScopedFindFirst,
} from './helpers';
import * as resolveNotifs from '../services/notifications/resolveNotifications';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';
// The enum as a VALUE, so the #1626 invariants below enumerate the statuses the schema actually
// carries rather than a hand-copied list that can rot (EN_ROUTE / ON_SITE were retired by design
// in multi-visit S4/D17, and this is what keeps them from creeping back in through a test).
import { JobStatus } from '@prisma/client';

// TECH_ASSIGNED/TECH_UNASSIGNED/JOB_SCHEDULED/JOB_RESCHEDULED now travel through
// dispatchAutomationEvent rather than a hard-coded sender — mocked here (mirroring
// automation-wiring.test.ts) so the few tests below that assert on this can do so
// directly instead of via the (deleted) sendJob*Email functions.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';

/** S8: the one trip a job-level crew statement lands on in these fixtures. */
const FIXTURE_CURRENT_VISIT = {
  id: 'v0000000-0000-0000-0000-0000000000f1',
  job_id: JOB_FIXTURE.id,
  lead_id: null,
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-10-01T09:00:00.000Z'),
  scheduled_end: new Date('2026-10-01T11:00:00.000Z'),
  is_all_day: false,
  created_at: new Date('2026-09-01T00:00:00.000Z'),
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
};

/**
 * Multi-visit S8 (D6): crew lives on the VISIT, so a job fixture has to state it there.
 *
 * The `assignees` key is kept alongside because it survives as the payload's DERIVED wire key -
 * a fixture that only stated the relation would stop exercising the readers of the key, and one
 * that only stated the key would stop exercising the row scope. Both are true of the real row.
 */
function withCrew(userIds: string[]) {
  return {
    assignees: userIds.map((id) => ({ user_id: id, user: { id, first_name: 'F', last_name: 'L' } })),
    visits: [
      {
        id: 'v0000000-0000-0000-0000-0000000000f1',
        visit_seq: 1,
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-10-01T09:00:00.000Z'),
        scheduled_end: new Date('2026-10-01T11:00:00.000Z'),
        is_all_day: false,
        customer_email_sent_at: null,
        created_at: new Date('2026-09-01T00:00:00.000Z'),
        assignees: userIds.map((id) => ({ user_id: id, user: { id, first_name: 'F', last_name: 'L' } })),
      },
    ],
  };
}

const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;
function dispatchedType(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  tag: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  tagAssignment: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  serviceLocation: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  jobAssignee: {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  planVisit: { updateMany: ReturnType<typeof vi.fn> };
  // Inventory P1 (§4) — document-verb auto-returns delegate tx stock writes to these spies.
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  lead: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  // SRVW-114 slice 1 - validateCustomFieldValues' lookup.
  customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the permissionCache so cached grants from one test don't leak into the next.
  clearPermissionCache();
  // Deposit-gate re-key (§5/§6) consults a kind=DEPOSIT Invoice; default to "no deposit invoice"
  // so the existing from-estimate tests fall back to the legacy Deposit-row gate.
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  // The new_customer guard AND the cross-customer accretion guard both run
  // prisma.customer.findMany; default to "no other customer matches" so existing-customer
  // accretion tests don't spuriously 409.
  (prisma.customer.findMany as any).mockResolvedValue([]);
});

/**
 * Every `visits.some` inside an emitted `where`, however it is nested under AND/OR.
 *
 * The date-window predicate is composed, not assigned, and its arrangement is the query
 * builder's business: multi-visit S6 first pushed one clause under AND and then wrapped it in an
 * OR so a CALLED-OFF job stays findable by date. A literal `toContainEqual` on `where.AND`
 * reddens on that rearrangement while the behaviour is unchanged, so ask what the predicate
 * MEANS instead.
 */
function visitWindowsIn(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (node.visits?.some) out.push(node.visits.some);
  for (const list of [node.AND, node.OR, node.NOT]) {
    for (const child of (Array.isArray(list) ? list : list ? [list] : [])) visitWindowsIn(child, out);
  }
  return out;
}

// ─── GET /api/jobs ─────────────────────────────────────

describe('GET /api/jobs', () => {
  beforeEach(() => {
    // groupBy is called on every list request; default to empty array
    mockPrisma.job.groupBy.mockResolvedValue([]);
  });

  it('returns paginated job list with stats', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([JOB_FIXTURE]);
    // First count is the pagination total; subsequent counts (monthly completed/cancelled, need_invoices) default to 0
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValueOnce(1);
    mockPrisma.job.groupBy.mockResolvedValue([
      { status: 'UNSCHEDULED', _count: 1 },
    ]);

    const res = await request(app).get('/api/jobs').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.stats).toMatchObject({
      unassigned: 1,
      scheduled: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    });
    expect(res.body.pagination).toBeDefined();
  });

  it('list select includes job_type and customer phone for linked-entity labels', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app).get('/api/jobs').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.select.job_type).toBe(true);
    expect(call.select.customer.select.phone).toBe(true);
  });

  it('paginates results', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app).get('/api/jobs?page=2&limit=10').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
  });

  it('filters by status', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs?status=SCHEDULED').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('SCHEDULED');
  });

  it('excludes service-plan visit-jobs when exclude_plan_visits=true (office list)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs?exclude_plan_visits=true').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.source_plan_id).toBeNull();
  });

  it('includes visit-jobs by default (calendar + tech app use the same endpoint without the flag)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.source_plan_id).toBeUndefined();
  });

  it('filters by multiple statuses', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs?status=UNSCHEDULED&status=SCHEDULED').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['UNSCHEDULED', 'SCHEDULED'] });
  });

  it('TECHNICIAN auto-filters to own jobs', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs').set(authHeader('technician'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    // Assigned OR created by them (technician-ownership spec, Part C). The OR half is what keeps
    // a job the technician made but was taken off visible to them.
    expect(call.where.OR).toEqual([
      { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } },
      { created_by_id: TEST_USERS.technician.id },
    ]);
  });

  it('SALES auto-filters to jobs from own leads', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs').set(authHeader('sales'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.estimate).toEqual({ lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } });
  });

  it('searches by job number', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs?search=J00001').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
  });

  it('SALES can list jobs', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app).get('/api/jobs').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('filters by date range', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?scheduled_after=2026-01-01T00:00:00.000Z&scheduled_before=2026-12-31T00:00:00.000Z')
      .set(authHeader('admin'));

    // Multi-visit S6: the window is a question about the job's VISIT set, not about the
    // Job.scheduled_start mirror (which only ever held the NEXT upcoming trip, so a job whose
    // second trip fell in the window was invisible). Composed under AND, never assigned onto
    // `where.visits`, because S8 repoints the stored OWN_JOB row scope at that same path.
    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.scheduled_start).toBeUndefined();
    // Asserted as a PROPERTY of the emitted predicate rather than as its literal arrangement:
    // the clause is an OR (the second arm keeps a CALLED-OFF job findable by date, which the
    // board's arm cannot express), and rearranging AND/OR must not redden a test that is really
    // about "the window is measured on the visit".
    const windows = visitWindowsIn(call.where);
    expect(windows.length).toBeGreaterThan(0);
    for (const some of windows) {
      expect(some.scheduled_at).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
    }
    expect(windows).toContainEqual(expect.objectContaining({ status: { not: 'CANCELLED' } }));
  });

  it('should scope stats to own leads for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('sales'));

    const salesFilter = { estimate: { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } } };

    // The groupBy call for stats must include the SALES lead filter
    const groupByCall = mockPrisma.job.groupBy.mock.calls[0][0];
    expect(groupByCall.where).toMatchObject(salesFilter);
  });

  it('should scope stats to own jobs for TECHNICIAN role', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('technician'));

    const techFilter = {
      OR: [
        { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } },
        { created_by_id: TEST_USERS.technician.id },
      ],
    };

    // The groupBy call for stats must include the TECHNICIAN crew filter
    const groupByCall = mockPrisma.job.groupBy.mock.calls[0][0];
    expect(groupByCall.where).toMatchObject(techFilter);
  });

  it('includes customer_number in nested customer select', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app)
      .get('/api/jobs')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.job.findMany.mock.calls[0][0];
    expect(findManyArgs.select.customer.select.customer_number).toBe(true);
  });

  it('includes scope_notes in jobListSelect (board card title)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('admin'));

    const findManyArgs = mockPrisma.job.findMany.mock.calls[0][0];
    expect(findManyArgs.select.scope_notes).toBe(true);
  });

  /**
   * The crew's CONTACT rides on the record, not on the picker roster.
   *
   * `GET /api/users/assignable` is gated on the `assign User` grant and no longer returns
   * `phone` at all - that is the privacy control this slice exists to add. The schedule
   * board's event editor offers call/text on the SAVED crew, and a viewer who owns the job
   * but may not change its crew must still get it, so the phone has to arrive with the job.
   * Drop `phone` from this select and the affordance silently disappears in production:
   * no error, no typecheck failure, because every frontend reader declares the key optional.
   */
  it('includes visits.assignees.user.phone in jobListSelect (schedule board crew contact)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('admin'));

    const findManyArgs = mockPrisma.job.findMany.mock.calls[0][0];
    const userSelect = findManyArgs.select.visits?.select?.assignees?.select?.user?.select;
    expect(userSelect).toMatchObject({ id: true, first_name: true, last_name: true, phone: true });
  });

  it('includes estimate.lead.commission_owner in jobListSelect (board editor off-board owner)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('admin'));

    const findManyArgs = mockPrisma.job.findMany.mock.calls[0][0];
    const estimateSelect = findManyArgs.select.estimate?.select;
    expect(estimateSelect).toBeDefined();
    const leadSelect = estimateSelect?.lead?.select;
    expect(leadSelect).toBeDefined();
    expect(leadSelect?.commission_owner?.select).toMatchObject({ id: true, first_name: true, last_name: true });
  });

  it('needs_invoice=true filters completed jobs without an active invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    await request(app).get('/api/jobs?needs_invoice=true').set(authHeader('admin'));
    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('COMPLETED');
    expect(where.NOT).toEqual({ invoices: { some: { status: { not: 'VOIDED' } } } });
  });

  // S8 (RATIFIED): the two monthly tiles no longer filter the DROPPED `Job.scheduled_start`
  // column - they compose a visits-set OR under `AND`, the identical pattern buildJobListWhere's
  // own date-range filter proves (never a bare `where.scheduled_start`, which is gone, and never
  // a bare `where.OR`/`where.visits` assignment, which would silently overwrite scopeWhere's own
  // row-scope OR - the RBAC-bypass this shape exists to avoid).
  it('completed/cancelled job stats are bounded to the current month via the visit set', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    await request(app).get('/api/jobs').set(authHeader('admin'));
    const completed = mockPrisma.job.count.mock.calls.find(
      (c: any) => c[0].where?.status === 'COMPLETED' && Array.isArray(c[0].where?.AND),
    );
    expect(completed).toBeDefined();
    const orClause = completed![0].where.AND[0].OR;
    expect(orClause).toBeInstanceOf(Array);
    const window = orClause[0].visits.some.scheduled_at;
    // Half-open on the ORG's calendar month: `[1st 00:00 org, next 1st 00:00 org)`. It was
    // `new Date(now.getFullYear(), now.getMonth(), 1)` - the SERVER's month, which is UTC in
    // production - so the tile counted on a different clock from both the Scheduled column
    // and the org-zone month range the tile's own click-through sends. `lt` rather than an
    // `lte` end-of-month instant because a DST month has an odd number of hours in it.
    expect(window.gte).toBeInstanceOf(Date);
    expect(window.lt).toBeInstanceOf(Date);
    expect(window.lte).toBeUndefined();
    // The default org zone is America/New_York, so a month begins at 04:00Z or 05:00Z, never
    // at 00:00Z - the assertion that actually distinguishes the org clock from UTC's.
    expect(window.gte.getUTCHours()).not.toBe(0);
    expect(window.gte.getUTCDate()).toBe(new Date(window.gte).getUTCDate());
    // The headline case this must not regress: a COMPLETED job with no LIVE visit still counts -
    // arm 1 excludes only a CANCELLED visit, never a COMPLETED one, from the "was scheduled this
    // month" question.
    expect(orClause[0].visits.some.status).toEqual({ not: 'CANCELLED' });

    const cancelled = mockPrisma.job.count.mock.calls.find(
      (c: any) => c[0].where?.status === 'CANCELLED' && Array.isArray(c[0].where?.AND),
    );
    expect(cancelled).toBeDefined();
    // A cancelled job's second OR arm counts ANY visit in the window regardless of that visit's
    // own status - a CANCELLED job can still hold a COMPLETED visit (cancel() never revives
    // finished trips), and this tile must still see it.
    expect(cancelled![0].where.AND[0].OR[1]).toEqual({
      status: 'CANCELLED',
      visits: { some: { scheduled_at: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }) } },
    });
  });

  // ── #106 grant-driven LIST scope ENFORCEMENT ──
  // The list where-clause is scoped from the role's READ grant (scopeWhereForReq), not a
  // hand-rolled `if (role === 'SALES')`. The TECHNICIAN/SALES filter tests above already
  // assert the byte-identical owner condition is produced. This proves the FAIL-CLOSED case
  // the ROUTE GUARD can't catch: a Team-conditioned read Job grant passes the subject-level
  // guard (a matching rule exists), but for a user with NO department the {{teamId}} token
  // resolves to null, so scopeWhereForReq returns MATCH_NOTHING — the controller must list
  // NOTHING (never the whole org), applied to BOTH the findMany AND the count + groupBy.
  it('a scoped user whose team-conditioned read grant resolves to null team lists nothing (fail-closed)', async () => {
    mockAuthAs('technician'); // TEST_USERS.technician has no department_id (null team)
    // Override: read Job conditioned on team — token {{teamId}} → null for this user.
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}', department_id: '{{teamId}}' } } } },
    ]);
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    const res = await request(app).get('/api/jobs').set(authHeader('technician'));

    // Route guard passes (subject-level rule exists); the controller scope fails closed.
    expect(res.status).toBe(200);
    const findManyWhere = mockPrisma.job.findMany.mock.calls[0][0].where;
    // MATCH_NOTHING = { id: { in: [] } } — the outermost spread guarantees nothing matches.
    expect(findManyWhere.id).toEqual({ in: [] });
    const countWhere = mockPrisma.job.count.mock.calls[0][0].where;
    expect(countWhere.id).toEqual({ in: [] });
    const groupByWhere = mockPrisma.job.groupBy.mock.calls[0][0].where;
    expect(groupByWhere.id).toEqual({ in: [] });
  });

  // ── Task 10 (generalized filter engine) — jobFacets wired via applyFilters ──

  it('ignores invalid status values (JobStatus enum validation preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs?status=GARBAGE').set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.status).toBeUndefined();
  });

  it('filters by multiple customer_id values (matches either)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/jobs?customer_id=${CUSTOMER_FIXTURE.id}&customer_id=00000000-0000-0000-0000-0000000000c9`)
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.customer_id).toEqual({
      in: [CUSTOMER_FIXTURE.id, '00000000-0000-0000-0000-0000000000c9'],
    });
  });

  // CORRECTION 2 — the brief's sketch had `column: 'scheduled_date'`, which is a DIFFERENT
  // model's column; the live Job model's column (and index) is `scheduled_start`.
  it('scheduled_after/scheduled_before ask the visit set, and never the retired scheduled_date', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?scheduled_after=2026-01-01T00:00:00.000Z&scheduled_before=2026-12-31T00:00:00.000Z')
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    const window = visitWindowsIn(call.where)[0]!;
    expect(window.scheduled_at.gte).toBeInstanceOf(Date);
    expect(window.scheduled_at.lte).toBeInstanceOf(Date);
    expect(call.where.scheduled_date).toBeUndefined();
  });

  // New facet (not present in the pre-Task-10 hand-rolled code) — added to match the Leads
  // convention (created_after/created_before -> created_at); the Job model has created_at.
  it('filters by created_after/created_before (created_at dateRange facet)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?created_after=2026-01-01T00:00:00.000Z&created_before=2026-12-31T00:00:00.000Z')
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.created_at.gte).toBeInstanceOf(Date);
    expect(call.where.created_at.lte).toBeInstanceOf(Date);
  });

  // Multi-visit S8 (D6): crew is reached THROUGH THE TRIPS. These three used to assert a
  // top-level `where.assignees`, which is a DEAD relation now that `job_assignees` is dropped -
  // the mocked seam happily accepted it while the real client would have 500'd the whole list.
  // The observable behaviour those shapes stand in for is covered end to end, against an
  // honouring fake that throws on the dead key, in job-list-crew-filter-visits.test.ts.
  it('department_id multi-select (no assigned_to, no role-scope) matches either department', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?department_id=dept-1&department_id=dept-2')
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      visits: { some: { assignees: { some: { user: { department_id: { in: ['dept-1', 'dept-2'] } } } } } },
    });
    expect(call.where).not.toHaveProperty('assignees');
  });

  // Both crew params merge into ONE `assignees.some` under a single `visits.some`, so the pair
  // asks "a trip crewed by this person, who is in one of these departments" - the pre-S8 meaning.
  it('assigned_to + department_id merge into ONE assignees.some under one visits.some', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/jobs?assigned_to=${TEST_USERS.sales.id}&department_id=dept-1&department_id=dept-2`)
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([
      {
        visits: {
          some: {
            assignees: {
              some: {
                user_id: TEST_USERS.sales.id,
                user: { department_id: { in: ['dept-1', 'dept-2'] } },
              },
            },
          },
        },
      },
    ]);
    expect(call.where).not.toHaveProperty('assignees');
  });

  // SECURITY (most important test in Task 10): scopeWhereForReq already narrows
  // `where.assignees` to the TECHNICIAN's own jobs (assignees.some.user_id: self —
  // see "TECHNICIAN auto-filters to own jobs" above). Passing a DIFFERENT user's id via
  // ?assigned_to must NOT widen or replace that row-scope restriction. Unlike Leads (which
  // no-ops the facet entirely when scope-guarded), Jobs preserves its pre-existing
  // AND-append behavior: the role-scope's `where.assignees` clause is left byte-for-byte
  // untouched, and the query-param filter is composed as a SEPARATE clause under
  // `where.AND` — so the two constraints AND together (additively narrowing) rather than
  // one overwriting the other. A naive port through the generic `relationSome` helper would
  // instead merge attacker input into the SAME `.some`, overwriting `user_id: self` with
  // `user_id: OTHER` — the RBAC bypass this test guards against.
  it("SECURITY: assigned_to query param cannot override a row-scoped role's own scope (AND-appended, not merged/overwritten)", async () => {
    mockAuthAs('technician');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/jobs?assigned_to=${TEST_USERS.sales.id}`)
      .set(authHeader('technician'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    // The role-scope's own restriction survives UNCHANGED — never overwritten by the
    // query-param value. It is an OR union since the technician-ownership spec widened `read Job`
    // to assigned-or-created; the property under test is that it is untouched, not its shape.
    expect(call.where.OR).toEqual([
      { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } },
      { created_by_id: TEST_USERS.technician.id },
    ]);
    // The attacker-supplied assigned_to is composed as a SEPARATE AND clause, additively
    // narrowing (never widening) visibility - the tech still can't see Sales's jobs. S8: it
    // reaches crew through the trips, like the row scope above; a top-level `assignees` key
    // would be a dead relation and a 500, not a narrower filter.
    expect(call.where.AND).toEqual([
      { visits: { some: { assignees: { some: { user_id: TEST_USERS.sales.id } } } } },
    ]);
    expect(call.where).not.toHaveProperty('assignees');
  });

  // WP2 (job sub-statuses filter axis) — sub_status_id is a plain scalar column on Job, so
  // it uses equalsOrIn like customer_id; it does not touch the assignees relation, so it
  // carries none of the RBAC hazard the crew filters do.
  it('filters by multiple sub_status_id values (matches either)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?sub_status_id=00000000-0000-0000-0000-0000000000d1&sub_status_id=00000000-0000-0000-0000-0000000000d2')
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.sub_status_id).toEqual({
      in: ['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2'],
    });
  });

  it('filters by a single sub_status_id (scalar equality, not wrapped in `in`)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/jobs?sub_status_id=00000000-0000-0000-0000-0000000000d1')
      .set(authHeader('admin'));

    const call = mockPrisma.job.findMany.mock.calls[0][0];
    expect(call.where.sub_status_id).toBe('00000000-0000-0000-0000-0000000000d1');
  });
});

// ─── POST /api/jobs (standard) ─────────────────────────

describe('POST /api/jobs — standard', () => {
  beforeEach(() => {
    // BUG #23 idempotent find-or-create: the estimate branch queries for a pre-existing job
    // before creating. Default to "none exists" so the create path runs as before.
    mockPrisma.job.findFirst.mockResolvedValue(null);
    // Transaction mock: execute the callback
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(JOB_FIXTURE),
        },
        // R6 (2026-07-22) — M4: the estimate branch keeps Estimate.job_id in sync with the new
        // job in the same transaction (see job.controller.ts create()).
        estimate: { update: vi.fn().mockResolvedValue({}) },
        // SERV10X-38 Task 6b — the estimate branch now copies estimate.line_items onto the
        // new job's JobLineItem rows inside this same transaction.
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      };
      return fn(txMock);
    });
  });

  /**
   * Job.lead_id provenance. Nothing else asserts that create() actually PERSISTS the column -
   * the forwarding tests all mock job.findFirst, so they would stay green even if create()
   * never wrote it and every new job silently lost its lead.
   */
  it('writes lead_id onto a job converted from a single estimate', async () => {
    mockAuthAs('admin');
    let captured: Record<string, unknown> | null = null;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            captured = args.data;
            return JOB_FIXTURE;
          }),
        },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON',
      lead_id: LEAD_FIXTURE.id,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
      deposit: { id: 'd1', status: 'PAID' },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.lead_id).toBe(LEAD_FIXTURE.id);
  });

  it('leaves lead_id null on a job created from a lead-less estimate', async () => {
    mockAuthAs('admin');
    let captured: Record<string, unknown> | null = null;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            captured = args.data;
            return JOB_FIXTURE;
          }),
        },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
    // A customer-anchored, lead-less estimate (R6 M5 relaxed lead_id to optional).
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON',
      lead_id: null,
      lead: null,
      customer_id: CUSTOMER_FIXTURE.id,
      deposit: { id: 'd1', status: 'PAID' },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.lead_id).toBeNull();
  });

  it('creates a standard job from approved estimate with PAID deposit', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
      deposit: { id: 'd1', status: 'PAID' },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
  });

  // R6 (2026-07-22) — M4: Estimate.job_id mirrors Job.estimate_id in reverse; this is the one
  // write site that sets Job.estimate_id, so it must keep the mirror in sync in the same tx.
  it('keeps Estimate.job_id in sync with the new job (R6 M4 write-time mirror)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON',
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
      deposit: { id: 'd1', status: 'PAID' },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    const estimateUpdate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(JOB_FIXTURE) },
        estimate: { update: estimateUpdate },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // The where carries the tenant guard too (project rule: every authed where spreads
    // tenantWhere) - the estimate id alone is enough for Prisma, not for the rule.
    expect(estimateUpdate).toHaveBeenCalledWith({
      where: { id: ESTIMATE_APPROVED_FIXTURE.id, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_FIXTURE.id },
    });
  });

  it('creates a standard job from approved estimate with NO deposit', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
      deposit: null,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('blocks job creation if the deposit invoice is still unpaid (SENT)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    // The kind=DEPOSIT invoice is the SOLE deposit document; SENT (unpaid) blocks job creation.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'dep-inv-1', status: 'SENT' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deposit/i);
  });

  it('allows job creation if the deposit invoice is VOIDED (waived)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'dep-inv-1', status: 'VOIDED' });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.$queryRaw.mockResolvedValue([{ next_val: 1 }]);
    mockPrisma.job.create.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.lead.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  // ── Deposit gate re-keyed to the kind=DEPOSIT Invoice (§5/§6) ──
  // The legacy Deposit-row tests above remain valid as the FALLBACK path (consulted only when
  // no kind=DEPOSIT invoice exists — invoice.findFirst defaults to null in beforeEach).

  it('blocks job creation when the kind=DEPOSIT invoice is SENT (pre-payment)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      // No legacy Deposit row — the gate must key on the deposit INVOICE.
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'dep-inv-1', status: 'SENT' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deposit/i);
  });

  it('allows job creation when the kind=DEPOSIT invoice is PAID', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'dep-inv-1', status: 'PAID' });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('allows job creation when the kind=DEPOSIT invoice is VOIDED (waived)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'dep-inv-1', status: 'VOIDED' });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('no deposit invoice + no legacy deposit ⇒ no gate (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    // invoice.findFirst → null (beforeEach default) AND deposit: null ⇒ ungated.
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('resolves service_location from the lead.service_location_id', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: 'loc-from-lead-2',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    // No body override; primary-location lookup returns a DIFFERENT id — the lead's wins.
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: 'primary-loc-1' });

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return JOB_FIXTURE; }),
        },
        // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
        estimate: { update: vi.fn().mockResolvedValue({}) },
        // SERV10X-38 Task 6b — estimate branch copies line_items onto the new job.
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.service_location_id).toBe('loc-from-lead-2');
  });

  it('returns 400 if estimate is not WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'SENT',
      deposit: null,
      lead: { customer_id: CUSTOMER_FIXTURE.id, customer: { id: CUSTOMER_FIXTURE.id }, assigned_to: null },
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/WON/);
  });

  it('returns 404 if estimate not found', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: 'a0000000-0000-0000-0000-000000000099' });

    expect(res.status).toBe(404);
  });

  // BUG #23 — find-or-create: an estimate that already has a job must NOT 409 with no job
  // returned. The estimate branch first queries for an existing job (idempotent find) and,
  // if found, returns it 200 in the same { job } shape — no allocate / create.
  it('returns 200 with the existing job when the estimate already has one (idempotent find)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: { customer_id: CUSTOMER_FIXTURE.id, customer: { id: CUSTOMER_FIXTURE.id }, assigned_to: null },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    // Idempotent pre-create find returns the already-existing job.
    mockPrisma.job.findFirst.mockResolvedValue(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.id).toBe(JOB_FIXTURE.id);
    // No new job is created when one already exists.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // BUG #23 — race fallback: if two creates race past the pre-find, the unique violation
  // (P2002) must re-query the existing job and return it 200, NOT a 409 with no job.
  it('returns 200 with the existing job when create races into a P2002 unique violation', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: { customer_id: CUSTOMER_FIXTURE.id, customer: { id: CUSTOMER_FIXTURE.id }, assigned_to: null },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    // Pre-find sees nothing; the create then races into a unique violation; the catch re-queries.
    mockPrisma.job.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(JOB_FIXTURE);
    mockPrisma.$transaction.mockRejectedValue({ code: 'P2002' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.id).toBe(JOB_FIXTURE.id);
  });

  it('TECHNICIAN cannot create standard job (403)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(403);
  });

  it('SALES cannot create standard job (403)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('sales'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(403);
  });

  it('returns 400 if estimate_id missing for standard job', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ is_urgent: false });

    expect(res.status).toBe(400);
  });

  it('returns 400 if required fields missing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  // ── #180: service_location_id ownership guard on the estimate branch ──

  it('returns 404 when the body service_location_id belongs to another customer (estimate branch)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    // Ownership lookup for the FOREIGN body id → null (not owned by this customer/org).
    mockPrisma.serviceLocation.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id, service_location_id: 'b0000000-0000-0000-0000-0000000000ff' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Service location not found or does not belong to customer');
  });

  it('returns 404 (not 500) for a nonexistent service_location_id, before the transaction (estimate branch)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValueOnce(null); // ghost id not found
    // Prove we never reach the write:
    mockPrisma.$transaction.mockRejectedValue(new Error('transaction must not run'));

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id, service_location_id: 'a0000000-0000-0000-0000-0000000000ee' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Service location not found or does not belong to customer');
  });

  it('accepts an owned body service_location_id and anchors the job to it (estimate branch)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: 'loc-from-lead-2',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
    });
    // 1st findFirst = ownership lookup (OWNED) ; 2nd = primary-location lookup (unused since override wins).
    mockPrisma.serviceLocation.findFirst
      .mockResolvedValueOnce({ id: LOCATION_FIXTURE.id })
      .mockResolvedValueOnce({ id: 'primary-loc-1' });

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return JOB_FIXTURE; }) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.service_location_id).toBe(LOCATION_FIXTURE.id);
  });

  it('copies job_type onto the job from the estimate at creation', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      job_type: 'HVAC Install',
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        job_type: 'HVAC Install (Lead)',
        customer: { id: CUSTOMER_FIXTURE.id },
      },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return JOB_FIXTURE; }),
        },
        // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
        estimate: { update: vi.fn().mockResolvedValue({}) },
        // SERV10X-38 Task 6b — estimate branch copies line_items onto the new job.
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // estimate.job_type takes precedence over lead.job_type
    expect(capturedData.job_type).toBe('HVAC Install');
  });

  it('falls back to lead.job_type when estimate.job_type is null', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      job_type: null,
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        job_type: 'Plumbing',
        customer: { id: CUSTOMER_FIXTURE.id },
      },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return JOB_FIXTURE; }),
        },
        // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
        estimate: { update: vi.fn().mockResolvedValue({}) },
        // SERV10X-38 Task 6b — estimate branch copies line_items onto the new job.
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.job_type).toBe('Plumbing');
  });

  it('sets job_type to null when both estimate and lead job_type are null', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      job_type: null,
      deposit: null,
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        job_type: null,
        customer: { id: CUSTOMER_FIXTURE.id },
      },
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return JOB_FIXTURE; }),
        },
        // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
        estimate: { update: vi.fn().mockResolvedValue({}) },
        // SERV10X-38 Task 6b — estimate branch copies line_items onto the new job.
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.job_type).toBeNull();
  });
});

// ─── POST /api/jobs — resolveScheduleJobNotifications ──────────────────────

describe('POST /api/jobs — resolveScheduleJobNotifications', () => {
  beforeEach(() => {
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(JOB_FIXTURE) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§5.1) — conversion stamping resolves tracked refs; no line_items in
        // these estimate mocks, so the lookup is a no-op returning [].
        priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      };
      return fn(txMock);
    });
  });

  it('calls resolveScheduleJobNotifications once with (estimateId, orgId) on a successful estimate→job conversion', async () => {
    const resolveSpy = vi
      .spyOn(resolveNotifs, 'resolveScheduleJobNotifications')
      .mockResolvedValue(undefined);

    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_APPROVED_FIXTURE,
      status: 'WON', // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal
      lead: {
        customer_id: CUSTOMER_FIXTURE.id,
        service_address_line1: '123 Main St',
        customer: { id: CUSTOMER_FIXTURE.id },
        assigned_to: TEST_USERS.sales.id,
      },
      deposit: null,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(ESTIMATE_APPROVED_FIXTURE.id, ALPHA_ORG_ID);
  });

  it('does NOT call resolveScheduleJobNotifications on a standalone job create (no estimate_id)', async () => {
    const resolveSpy = vi
      .spyOn(resolveNotifs, 'resolveScheduleJobNotifications')
      .mockResolvedValue(undefined);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      };
      return fn(txMock);
    });

    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

// ─── POST /api/jobs — create schema (one-of estimate | customer+location) ───

describe('POST /api/jobs — create schema (one-of estimate | customer+location)', () => {
  it('400 when neither estimate_id nor customer_id+service_location_id provided', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/jobs').set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
  });

  it('400 when customer_id given without service_location_id', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(400);
  });

  it('strips is_urgent / urgency_reason (no longer accepted fields)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE_2) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, is_urgent: true, urgency_reason: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
  });
});

// ─── POST /api/jobs — standalone (no estimate) ─────────
// DEC1: urgency is retired. A job is created EITHER from an approved estimate, OR standalone
// from a customer + location. These tests exercise the standalone (estimate-less) path.

describe('POST /api/jobs — standalone (no estimate)', () => {
  beforeEach(() => {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      };
      return fn(txMock);
    });
  });

  // Captures the data passed to tx.job.create (mirrors mockNewCustomerTx below).
  function mockStandaloneJobTx(onJob?: (data: any) => void) {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Scheduling-notifications PRD: a create carrying a scheduled_start also stamps the job's
        // once-per-job "scheduled announcement happened" guard in this same transaction.
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { onJob?.(args.data); return STANDALONE_JOB_FIXTURE; }),
          update: vi.fn().mockResolvedValue({}),
        },
        customer: { update: vi.fn().mockResolvedValue({}) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
  }

  it('admin can create a standalone job from customer + location', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Rekey 3 doors' });
    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
  });

  // #375: the job is created inside the $transaction; presentation (which loads tags via
  // tagAssignment.findMany) runs AFTER commit. A post-commit failure there used to fall through
  // to the outer catch and return an opaque 500 "Failed to create job" — stranding a job that
  // WAS created (a retry then said "already exists"). It must now stay 201 with a minimal payload.
  it('#375: a post-commit tag-load failure does NOT turn a committed job into a 500', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    // Post-commit presentJobDetail → withTags → loadTagsForEntity → tagAssignment.findMany throws.
    mockPrisma.tagAssignment.findMany.mockRejectedValueOnce(new Error('post-commit tag load boom'));

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Rekey' });

    expect(res.status).toBe(201);
    // Prove the post-commit tag path actually ran (so the rejection fired and safePresentJob
    // caught it) — otherwise this would be a false green.
    expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalled();
    expect(res.body.job.id).toBe(STANDALONE_JOB_FIXTURE.id);
    expect(res.body.job.job_number).toBe(STANDALONE_JOB_FIXTURE.job_number);
    // Minimal fallback payload — the full presentation (which would add tags) was skipped.
    expect(res.body.job.tags).toBeUndefined();
  });

  // BUG #20 — the standalone ownership query must NOT re-validate the customer org via a
  // nested `customer` hop (the customer is already org-validated one line above). The proven
  // pattern is `{ id, customer_id, is_active: { not: false } }` (see lib/service-location.ts).
  // The old hop was a valid-but-redundant `customer: { organization_id }` filter — not malformed;
  // dropping it is a cleanup, and the added is_active guard now excludes archived locations.
  it('queries the active service location by id+customer_id WITHOUT a nested customer org hop', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    const whereArg = mockPrisma.serviceLocation.findFirst.mock.calls[0][0].where;
    expect(whereArg).toEqual({
      id: LOCATION_FIXTURE.id,
      customer_id: CUSTOMER_FIXTURE.id,
      is_active: { not: false },
    });
    expect(whereArg.customer).toBeUndefined();
  });

  // Phase B (technician redesign): a strict technician no longer has `create Job` by default —
  // the standalone (on-site) create path is now an opt-in per-user toggle, not a role default.
  // So an un-granted tech is blocked at the route guard. The granted-path positive (a tech with
  // a per-user `create Job` allow override creates + is auto-assigned) lives in
  // phaseB-controllers-job-create-ownership.test.ts.
  // `create Job` went back to a TECHNICIAN role default in the technician-ownership spec, Part C -
  // it was a per-user toggle between Phase B and then. The guard that keeps this safe is no longer
  // the route: it is that the creator is AUTO-ASSIGNED (the row-scoped-creator branch below), so a
  // technician's own new job is theirs, and `created_by_id` keeps it theirs afterwards.
  it('TECHNICIAN CAN create a standalone job (role default), with no crew row of their own', async () => {
    mockAuthAs('technician');
    // #1996 security follow-up: the existing-customer branch now requires `read Customer` on
    // the linked customer before create/accretion (TECHNICIAN holds none by default). This test
    // is about crew auto-assignment, not that gate, so grant it here for a readable customer.
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
      { role: 'TECHNICIAN', action: 'read', subject: 'Customer' },
    ]);
    clearPermissionCache();
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let capturedAssignee: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
        jobAssignee: { createMany: vi.fn().mockImplementation((args: any) => { capturedAssignee = args.data; return {}; }) },
      }),
    );
    const res = await request(app).post('/api/jobs').set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });
    expect(res.status).toBe(201);
    // S8 (D6): there is no self-assign row any more - the table is gone, and a create path that
    // booked no visit has no trip for the creator to be on. Nothing is lost: TECHNICIAN's
    // `read Job` is OWN_OR_CREATED_JOB, so the creator reaches their own job through the
    // created_by_id arm. Asserting the ABSENCE keeps the change visible rather than silent.
    expect(capturedAssignee).toBeUndefined();
  });

  it('does NOT write is_urgent or urgency_reason', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return STANDALONE_JOB_FIXTURE; }) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
    await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });
    expect(capturedData.is_urgent).toBeUndefined();
    expect(capturedData.urgency_reason).toBeUndefined();
  });

  it('returns 404 if customer not found in org', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/customer/i);
  });

  it('returns 404 if service location not found / not the customer\'s', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/location/i);
  });

  it('SALES cannot create any job (no create Job grant)', async () => {
    mockAuthAs('sales');
    const res = await request(app).post('/api/jobs').set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });
    expect(res.status).toBe(403);
  });

  it('persists job_type on a standalone job', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return STANDALONE_JOB_FIXTURE; }) },
        customer: { update: vi.fn().mockResolvedValue({}) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Rekey', job_type: 'HVAC Service' });

    expect(res.status).toBe(201);
    expect(capturedData.job_type).toBe('HVAC Service');
  });

  it('updates the customer ad_source when supplied (Source is a customer attribute)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    const txCustomerUpdate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        customer: { update: txCustomerUpdate },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, ad_source: 'Referral' });

    expect(res.status).toBe(201);
    expect(txCustomerUpdate).toHaveBeenCalledWith({ where: { id: CUSTOMER_FIXTURE.id }, data: { ad_source: 'Referral' } });
  });

  it('accretes a new_location for an existing customer (no service_location_id)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    let capturedData: any;
    const txLocCreate = vi.fn().mockResolvedValue({ id: 'accreted-loc-id' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return STANDALONE_JOB_FIXTURE; }) },
        customer: { update: vi.fn().mockResolvedValue({}) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        new_location: { address_line1: '50 New St', city: 'Austin', state: 'TX', zip: '78701' },
        scope_notes: 'Install',
      });

    expect(res.status).toBe(201);
    expect(txLocCreate).toHaveBeenCalledTimes(1);
    expect(capturedData.service_location_id).toBe('accreted-loc-id');
  });

  it('400 when existing customer given with neither service_location_id nor new_location', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, scope_notes: 'x' });
    expect(res.status).toBe(400);
  });

  // #2041 decision 8 — new_location accretes a ServiceLocation onto the customer (a write), so it
  // must be gated the same way the ad_source/accreteContactMethods writes on this same path
  // already are: only when the requester can read the customer row. Job.service_location_id is
  // NOT NULL, so an unreadable customer + new_location (no explicit service_location_id) must be
  // refused, not silently skipped.
  describe('#2041 decision 8 — new_location accretion is gated on customer readability', () => {
    it('TECHNICIAN (default grants, no read Customer at all) + new_location -> 400, no accretion write', async () => {
      mockAuthAs('technician');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
      const txLocCreate = vi.fn();
      const txCustomerUpdate = vi.fn();
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
          customer: { update: txCustomerUpdate },
          serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
          orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
          stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          visit: {
            create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
            update: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
            aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
          },
          visitAssignee: {
            findMany: vi.fn().mockResolvedValue([]),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
        }),
      );

      const res = await request(app).post('/api/jobs').set(authHeader('technician'))
        .send({
          customer_id: CUSTOMER_FIXTURE.id,
          new_location: { address_line1: '50 New St', city: 'Austin', state: 'TX', zip: '78701' },
          scope_notes: 'Install',
        });

      expect(res.status).toBe(400);
      expect(txLocCreate).not.toHaveBeenCalled();
      expect(txCustomerUpdate).not.toHaveBeenCalled();
    });

    it('DISPATCHER (unconditioned read Customer) + new_location -> accretion unchanged', async () => {
      mockAuthAs('dispatcher');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
      let capturedData: any;
      const txLocCreate = vi.fn().mockResolvedValue({ id: 'accreted-loc-id' });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return STANDALONE_JOB_FIXTURE; }) },
          customer: { update: vi.fn().mockResolvedValue({}) },
          serviceLocation: { findFirst: vi.fn().mockResolvedValue(null), create: txLocCreate },
          orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
          stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          visit: {
            create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
            update: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
            aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
          },
          visitAssignee: {
            findMany: vi.fn().mockResolvedValue([]),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
        }),
      );

      const res = await request(app).post('/api/jobs').set(authHeader('dispatcher'))
        .send({
          customer_id: CUSTOMER_FIXTURE.id,
          new_location: { address_line1: '50 New St', city: 'Austin', state: 'TX', zip: '78701' },
          scope_notes: 'Install',
        });

      expect(res.status).toBe(201);
      expect(txLocCreate).toHaveBeenCalledTimes(1);
      expect(capturedData.service_location_id).toBe('accreted-loc-id');
    });
  });

  // #2041 findings 1/6 — the created job's OWN `service_location` (jobDetailSelect) is the SAME
  // customer's street address one key over from `customer`. Picking an EXISTING location by id
  // stays allowed for an unreadable customer (a read, not a write), but its address must be
  // redacted in the response exactly like `customer`'s contact block already is.
  describe('#2041 findings 1/6 — the created jobs sibling service_location is redacted too', () => {
    it('TECHNICIAN (no read Customer at all) + an existing service_location_id -> service_location address stripped', async () => {
      mockAuthAs('technician');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE); // no association possible, TECHNICIAN has zero Customer grants
      mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

      const res = await request(app).post('/api/jobs').set(authHeader('technician'))
        .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Rekey 3 doors' });

      expect(res.status).toBe(201);
      const location = res.body.job.service_location as Record<string, unknown>;
      expect(location).toBeTruthy();
      expect(location.id).toBe(LOCATION_FIXTURE.id); // id kept
      for (const key of ['address_line1', 'address_line2', 'city', 'state', 'zip']) {
        expect(key in location, `service_location.${key} must not be present`).toBe(false);
      }
    });

    it('green control: DISPATCHER (unconditioned read Customer) -> service_location address stays intact', async () => {
      mockAuthAs('dispatcher');
      mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
      mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

      const res = await request(app).post('/api/jobs').set(authHeader('dispatcher'))
        .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Rekey 3 doors' });

      expect(res.status).toBe(201);
      expect(res.body.job.service_location.address_line1).toBe(STANDALONE_JOB_FIXTURE.service_location.address_line1);
      expect(res.body.job.service_location.city).toBe(STANDALONE_JOB_FIXTURE.service_location.city);
    });
  });

  it('sets status=SCHEDULED when scheduled_start is provided', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let capturedData: any;
    mockStandaloneJobTx((data) => { capturedData = data; });

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        scheduled_start: '2026-07-01T09:00:00+00:00',
        scheduled_end: '2026-07-01T11:00:00+00:00',
      });

    expect(res.status).toBe(201);
    expect(capturedData.status).toBe('SCHEDULED');
  });

  it('does not set status when scheduled_start is omitted (schema default applies)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let capturedData: any;
    mockStandaloneJobTx((data) => { capturedData = data; });

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.status).toBeUndefined();
  });
});

describe('POST /api/jobs — standalone new_customer (inline create)', () => {
  beforeEach(() => {
    // Duplicate guard runs prisma.customer.findMany before the transaction.
    mockPrisma.customer.findMany.mockResolvedValue([]);
  });

  function mockNewCustomerTx(captured?: { onJob?: (data: any) => void; timeline?: ReturnType<typeof vi.fn> }) {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }) },
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation((args: any) => { captured?.onJob?.(args.data); return STANDALONE_JOB_FIXTURE; }) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: captured?.timeline ?? vi.fn().mockResolvedValue({}) },
      }),
    );
  }

  const NEW_CUSTOMER = {
    first_name: 'New', last_name: 'Client', email: 'new.client@example.com', phone: '5551112222',
    location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
  };

  it('creates a standalone job with an inline new_customer', async () => {
    mockAuthAs('admin');
    const captured: any = {};
    mockNewCustomerTx({ onJob: (d) => { captured.job = d; } });

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ new_customer: { ...NEW_CUSTOMER, ad_source: 'Google' }, scope_notes: 'Furnace install', job_type: 'HVAC Install' });

    expect(res.status).toBe(201);
    expect(captured.job.customer_id).toBe('new-cust-id');
    expect(captured.job.service_location_id).toBe('new-primary-loc-id');
    expect(captured.job.job_type).toBe('HVAC Install');
  });

  it('creates a standalone job with new_customer missing last_name + email (both optional)', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { create: (customerCreate = vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] })) },
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Furnace install',
      });

    expect(res.status).toBe(201);
    // Omitted email must persist as null, not crash on email.trim().
    const createArgs = customerCreate!.mock.calls[0][0];
    expect(createArgs.data.email ?? null).toBeNull();
  });

  it('creates a standalone job with new_customer email only, no phone (SERV10X-35)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }) },
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          email: 'new.client@example.com',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Furnace install',
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for new_customer with neither phone nor email (SERV10X-35)', async () => {
    mockAuthAs('admin');

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Furnace install',
      });

    expect(res.status).toBe(400);
  });

  it('creates a standalone job with new_customer company-only, no first_name (Chestnut regression)', async () => {
    mockAuthAs('admin');
    mockNewCustomerTx();

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        new_customer: {
          company_name: 'Chestnut', phone: '5551234567',
          location: { address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Replace the deadbolt',
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for new_customer with neither first_name nor company_name', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({
        new_customer: {
          phone: '5551234567',
          location: { address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Replace the deadbolt',
      });
    expect(res.status).toBe(400);
  });

  it('new_customer with a duplicate email/phone → 409 { error:"duplicate", existing }', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'dup-id', customer_number: 'C00042', first_name: 'Existing', last_name: 'Person',
      company_name: null, email: 'new.client@example.com', phone: '5551112222',
      is_active: true, archived_at: null, service_locations: [], phones: [], extra_emails: [],
    }]);

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ new_customer: NEW_CUSTOMER, scope_notes: 'x' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing.customer_number).toBe('C00042');
  });

  it('new_customer ?override=true bypasses the guard and writes a CUSTOMER_CREATED audit event', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'dup-id', customer_number: 'C00042', first_name: 'Existing', last_name: 'Person',
      company_name: null, email: 'new.client@example.com', phone: '5551112222',
      is_active: true, archived_at: null, service_locations: [], phones: [], extra_emails: [],
    }]);
    const timeline = vi.fn().mockResolvedValue({});
    mockNewCustomerTx({ timeline });

    const res = await request(app).post('/api/jobs?override=true').set(authHeader('admin'))
      .send({ new_customer: NEW_CUSTOMER, scope_notes: 'x' });

    expect(res.status).toBe(201);
    // CUSTOMER_CREATED audit + JOB CREATED = 2 timeline writes on the override path.
    const customerEvent = timeline.mock.calls.map((c) => c[0].data).find((d) => d.event_type === 'CUSTOMER_CREATED');
    expect(customerEvent).toMatchObject({
      entity_type: 'CUSTOMER', entity_id: 'new-cust-id',
      metadata: { duplicate_override: true, matched_customer_id: 'dup-id', matched_customer_number: 'C00042' },
    });
  });

  it('400 when both customer_id and new_customer are provided', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, new_customer: NEW_CUSTOMER, scope_notes: 'x' });
    expect(res.status).toBe(400);
  });

  it('does NOT create a lead or estimate row (job-only endpoint)', async () => {
    mockAuthAs('admin');
    mockNewCustomerTx();
    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ new_customer: NEW_CUSTOMER, scope_notes: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.lead).toBeUndefined();
    expect(res.body.estimate).toBeUndefined();
  });
});

describe('POST /api/jobs (existing-customer accretion — unified-client-creation §5.3)', () => {
  it('accretes a typed phone as a new secondary CustomerPhone on a standalone job (primary untouched)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    let txCustomerPhoneCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      txCustomerPhoneCreate = vi.fn();
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        customer: {
          update: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({ phone: CUSTOMER_FIXTURE.phone, email: null, phones: [], extra_emails: [] }),
        },
        customerPhone: { create: txCustomerPhoneCreate },
        customerEmail: { create: vi.fn() },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Replace the deadbolt', phone: '5559998888' });

    expect(res.status).toBe(201);
    expect(txCustomerPhoneCreate!).toHaveBeenCalledWith({
      data: { customer_id: CUSTOMER_FIXTURE.id, phone: '5559998888', is_primary: false },
    });
  });

  it('existing customer_id + a typed phone belonging to a DIFFERENT customer → 409 (cross-customer accretion guard)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // A DIFFERENT customer already owns 5559998888.
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'c0000000-0000-0000-0000-0000000000bb', customer_number: 'C00099',
      first_name: 'Other', last_name: null, company_name: null,
      email: null, phone: '5559998888', is_active: true, archived_at: null,
      service_locations: [], phones: [], extra_emails: [],
    }]);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Fix it', phone: '5559998888' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing.id).toBe('c0000000-0000-0000-0000-0000000000bb');
    // the linked customer is excluded from the cross-customer lookup
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.id).toEqual({ not: CUSTOMER_FIXTURE.id });
  });

  it('existing customer_id + cross-customer phone match, ?override=true → 201 (accrete anyway)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockPrisma.customer.findMany.mockResolvedValue([{
      id: 'c0000000-0000-0000-0000-0000000000bb', customer_number: 'C00099',
      first_name: 'Other', last_name: null, company_name: null,
      email: null, phone: '5559998888', is_active: true, archived_at: null,
      service_locations: [], phones: [], extra_emails: [],
    }]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        customer: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ phone: CUSTOMER_FIXTURE.phone, email: null, phones: [], extra_emails: [] }) },
        customerPhone: { create: vi.fn() },
        customerEmail: { create: vi.fn() },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn() },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/jobs?override=true')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, scope_notes: 'Fix it', phone: '5559998888' });

    expect(res.status).toBe(201);
  });
});

// ─── GET /api/jobs/:id ─────────────────────────────────

describe('GET /api/jobs/:id', () => {
  it('admin can get job detail', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(JOB_FIXTURE.id);
  });

  it('returns custom_fields on the detail payload (SRVW-114 slice 1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      custom_fields: { 'd0000000-0000-0000-0000-000000000001': 'PO-1234' },
    });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.custom_fields).toEqual({ 'd0000000-0000-0000-0000-000000000001': 'PO-1234' });
  });

  it('TECHNICIAN can get own job (crew membership)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      ...withCrew([TEST_USERS.technician.id]),
    });
    // GAP-1 — getById now gates via canAccessRow (scoped findFirst), not the role-literal
    // canAccessJob. The tech owns this job, so the scoped probe matches → 200.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });

  it('TECHNICIAN cannot get a job they are not on the crew of (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      ...withCrew(['other-tech-id']),
    });
    // GAP-1 — getById gates via canAccessRow (scoped findFirst). The tech does NOT own this job,
    // so the scoped probe finds nothing → 403. (Explicit null guards against vi.clearAllMocks
    // leaving a prior test's findFirst mock in place.)
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('SALES can read own-lead job (lead owner M2M)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
    });
    // GAP-1 — getById now gates via canAccessRow (scoped findFirst). SALES owns the parent lead,
    // so the scoped probe matches → 200.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('returns 404 if job not found', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/jobs/nonexistent-id')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('job detail includes dispatcher, technician department/role/phone, and invoice lifecycle fields', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // getById calls findUnique twice: [0] = access-check (minimal), [1] = full jobDetailSelect.
    const sel = mockPrisma.job.findUnique.mock.calls[1][0].select;
    expect(sel.dispatcher).toBeTruthy();
    // S8 (D6): the crew person shape rides on the VISITS relation now; the `assignees` WIRE key
    // is derived from it by the controller, so the payload the page reads is unchanged.
    expect(sel.assignees).toBeUndefined();
    const crewUser = sel.visits.select.assignees.select.user.select;
    expect(crewUser.department).toBeTruthy();
    expect(crewUser.phone).toBe(true);
    expect(crewUser.role).toBe(true);
    expect(sel.invoices.select.sent_at).toBe(true);
    expect(sel.invoices.select.paid_at).toBe(true);
    expect(sel.invoices.select.kind).toBe(true);
  });

  it('surfaces remaining_unbilled = estimate.total_amount − amount_invoiced', async () => {
    mockAuthAs('admin');
    // estimate.total_amount = 1062.5 (JOB_FIXTURE), amount_invoiced 300 ⇒ remaining 762.5.
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, amount_invoiced: 300 });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.remaining_unbilled).toBe(762.5);
  });
});

// ─── PATCH /api/jobs/:id ───────────────────────────────

describe('PATCH /api/jobs/:id', () => {
  beforeEach(() => {
    // update() now wraps in $transaction. Default the tx to delegate to mockPrisma so the
    // simple-edit happy-paths (which stub mockPrisma.job.update directly) keep working.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  });

  it('admin can update an unassigned job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, scope_notes: 'Updated notes' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Updated notes' });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalled();
  });

  describe('custom_fields (SRVW-114 slice 1)', () => {
    const DEF_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

    it('merges the patch onto the existing bag and persists it', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE,
        custom_fields: { 'other-def': 'kept' },
      });
      mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
        { id: DEF_ID, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
      ]);
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, custom_fields: args.data.custom_fields });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ custom_fields: { [DEF_ID]: 'PO-1234' } });

      expect(res.status).toBe(200);
      expect(captured.data.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'PO-1234' });
      expect(res.body.job.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'PO-1234' });
    });

    it('400s on an unknown definition id and never calls job.update', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
      mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ custom_fields: { [DEF_ID]: 'PO-1234' } });

      expect(res.status).toBe(400);
      expect(mockPrisma.job.update).not.toHaveBeenCalled();
    });

    it('400s on a non-string value against a TEXT definition', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
      mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
        { id: DEF_ID, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
      ]);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ custom_fields: { [DEF_ID]: 42 } });

      expect(res.status).toBe(400);
      expect(mockPrisma.job.update).not.toHaveBeenCalled();
    });

    it('does not require manage_lines Job - a technician on the crew can save it without pricing access', async () => {
      mockAuthAs('technician');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE,
        ...withCrew([TEST_USERS.technician.id]),
        created_by_id: 'someone-else',
      });
      mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
      mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
        { id: DEF_ID, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
      ]);
      mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, custom_fields: { [DEF_ID]: 'value' } });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('technician'))
        .send({ custom_fields: { [DEF_ID]: 'value' } });

      expect(res.status).toBe(200);
    });
  });

  it('admin can update job_type on an editable job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // status UNSCHEDULED
    let captured: any;
    mockPrisma.job.update.mockImplementation((args: any) => {
      captured = args;
      return Promise.resolve({ ...JOB_FIXTURE, job_type: 'HVAC Service' });
    });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ job_type: 'HVAC Service' });

    expect(res.status).toBe(200);
    expect(captured.data.job_type).toBe('HVAC Service');
  });

  it('allows updating an IN_PROGRESS job (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', scope_notes: 'test' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'test' });

    expect(res.status).toBe(200);
  });

  // ── #106 per-instance ENFORCEMENT (not just the subject-level route guard) ──
  // A TECHNICIAN has a CONDITIONAL `update Job` grant (OWN_JOB), so the route guard
  // (subject-level can('update','Job')) PASSES. The controller must then evaluate the
  // condition against the loaded row and 403 a job the tech is NOT on the crew of —
  // and must NOT call job.update. This is the #106 hole the base handler previously had.
  it('returns 403 + does NOT update when a scoped TECHNICIAN edits a job owned by another user', async () => {
    mockAuthAs('technician');
    // Row is owned by a DIFFERENT crew member, so the OWN_JOB condition cannot match.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      ...withCrew(['another-tech-id']),
    });
    // canAccessRow's scoped visibility probe: the job is not visible under the tech's OWN_JOB
    // scope → findFirst returns null → access denied (the SQL probe, not the loaded row).
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'sneaky edit' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // Spec A D3 (2026-07-21, main-app migration): `update Job` (OWN_JOB) became a TECHNICIAN role
  // default so a technician can add notes and line items on their own job in the main app. So a
  // technician on the crew CAN update their own job now — the un-owned/nested-team negative
  // cases below still prove the per-instance gate holds.
  it('allows a TECHNICIAN to update a job they are on the crew of (own-scoped role default)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, scope_notes: 'my edit' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'my edit' });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalled();
  });

  // ── #106 P1: NESTED Team/Location grant must NOT 500 on the base update ──
  // A role scoped to Job via a TEAM condition (assignees.some.user.department_id) carries a
  // NESTED to-one→to-many condition. The Wave 2 `can()` (CASL in-memory matcher) THROWS on it
  // ("equals does not supports comparison of arrays and objects") → caught → 500. The SQL-based
  // canAccessRow compiles the same fragment to a findFirst, so an un-owned row resolves to a
  // clean 403 (NOT 500) and never calls job.update.
  it('returns 403 (NOT 500) when a TEAM-scoped (nested grant) user updates an un-owned job', async () => {
    clearTokenCache(); // department-less cached technician from a prior test must not be served
    mockAuthAs('technician');
    // Give the technician a department so {{teamId}} substitutes to a real value (else the
    // grant fail-closes to MATCH_NOTHING and never reaches the nested-matcher throw).
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...TEST_USERS.technician,
      department_id: 'dept-9',
      organization: TEST_ORG,
    });
    // read + update Job both conditioned on the crew member's TEAM (nested user.department_id).
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
      { action: 'update', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // canAccessRow's scoped visibility probe: un-owned under the team scope → null.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'cross-team edit' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows a TEAM-scoped (nested grant) user to update a job inside their team (200)', async () => {
    clearTokenCache();
    mockAuthAs('technician');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...TEST_USERS.technician,
      department_id: 'dept-9',
      organization: TEST_ORG,
    });
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
      { action: 'update', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // Visible under the team scope → findFirst returns the row id → access granted.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, scope_notes: 'team edit' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'team edit' });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalled();
  });

  it('returns 404 if job not found', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/jobs/nonexistent-id')
      .set(authHeader('admin'))
      .send({ scope_notes: 'test' });

    expect(res.status).toBe(404);
  });

  it('can update scheduled job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', scope_notes: 'Updated' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Updated' });

    expect(res.status).toBe(200);
  });

  it('syncs the linked PlanVisit date when a visit-job is rescheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', source_plan_id: '00000000-0000-0000-0000-0000000000a1' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.planVisit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-07-15T09:00:00.000Z', scheduled_end: '2026-07-15T11:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_id: JOB_FIXTURE.id }),
        data: expect.objectContaining({ scheduled_date: new Date('2026-07-15T09:00:00.000Z') }),
      }),
    );
  });

  it('does NOT touch PlanVisit when a normal (non-plan) job is rescheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', source_plan_id: null });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-07-15T09:00:00.000Z', scheduled_end: '2026-07-15T11:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).not.toHaveBeenCalled();
  });

  // ── §10 location edit + decouple ──
  // update() now resolves the location via resolveOrAccreteLocation inside a $transaction,
  // logs JOB_LOCATION_CHANGED, and surfaces a cross-state tax_warning. The lead is NEVER touched.

  function wireUpdateTx(updated: any, locationFindFirst?: any, locationCreate?: any) {
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    const txTimeline = vi.fn().mockResolvedValue({});
    const txLocationFindFirst = locationFindFirst ?? vi.fn().mockResolvedValue(null);
    const txLocationCreate = locationCreate ?? vi.fn().mockResolvedValue({ id: 'new-loc-acc' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { update: txJobUpdate },
        serviceLocation: { findFirst: txLocationFindFirst, create: txLocationCreate },
        timelineEvent: { create: txTimeline },
        lead: { update: mockPrisma.lead.update },
      }),
    );
    return { txJobUpdate, txTimeline, txLocationFindFirst, txLocationCreate };
  }

  it('editing service_location_id by id re-points the job and logs JOB_LOCATION_CHANGED', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id, status: 'SCHEDULED', customer_id: CUSTOMER_FIXTURE.id, service_location: { state: 'TX' },
    });
    // resolveOrAccreteLocation's id-pick path reads serviceLocation.findFirst → the new loc (same state TX).
    const locFind = vi.fn().mockResolvedValue({ id: 'loc-new-1', state: 'TX' });
    const { txJobUpdate, txTimeline } = wireUpdateTx({ ...JOB_FIXTURE, service_location_id: 'loc-new-1' }, locFind);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: '11111111-1111-1111-1111-111111111111' });

    expect(res.status).toBe(200);
    expect(txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ service_location_id: 'loc-new-1' }) }),
    );
    expect(txTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'JOB_LOCATION_CHANGED' }) }),
    );
    // No tax_warning when the state is unchanged.
    expect(res.body.tax_warning).toBeUndefined();
  });

  it('a cross-state location edit surfaces a tax_warning signal', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id, status: 'SCHEDULED', customer_id: CUSTOMER_FIXTURE.id, service_location: { state: 'TX' },
    });
    const locFind = vi.fn().mockResolvedValue({ id: 'loc-ca-1', state: 'CA' });
    wireUpdateTx({ ...JOB_FIXTURE, service_location_id: 'loc-ca-1' }, locFind);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: '22222222-2222-2222-2222-222222222222' });

    expect(res.status).toBe(200);
    expect(res.body.tax_warning).toMatchObject({ old_state: 'TX', new_state: 'CA' });
  });

  it('accretes a new location from an address (serviceLocation.create called)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id, status: 'SCHEDULED', customer_id: CUSTOMER_FIXTURE.id, service_location: { state: 'TX' },
    });
    // Address-accrete path: no dedupe candidate → create.
    const locFind = vi.fn().mockResolvedValue(null);
    const locCreate = vi.fn().mockResolvedValue({ id: 'loc-accreted-9' });
    const { txJobUpdate } = wireUpdateTx({ ...JOB_FIXTURE, service_location_id: 'loc-accreted-9' }, locFind, locCreate);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ address: { address_line1: '900 New Rd', city: 'Dallas', state: 'TX', zip: '75201' } });

    expect(res.status).toBe(200);
    expect(locCreate).toHaveBeenCalled();
    expect(txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ service_location_id: 'loc-accreted-9' }) }),
    );
  });

  it('a location edit does NOT mutate the lead (forward-only decouple)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id, status: 'SCHEDULED', customer_id: CUSTOMER_FIXTURE.id, service_location: { state: 'TX' },
    });
    const locFind = vi.fn().mockResolvedValue({ id: 'loc-x', state: 'TX' });
    wireUpdateTx({ ...JOB_FIXTURE, service_location_id: 'loc-x' }, locFind);

    await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_location_id: '33333333-3333-3333-3333-333333333333' });

    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  it('customer_id is locked (stripped from the update payload)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id, status: 'SCHEDULED', customer_id: CUSTOMER_FIXTURE.id, service_location: { state: 'TX' },
    });
    // No location change → update() runs the simple path (still inside the tx wrapper).
    const { txJobUpdate } = wireUpdateTx({ ...JOB_FIXTURE, scope_notes: 'edited' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'edited', customer_id: 'c0000000-0000-0000-0000-000000009999' });

    expect(res.status).toBe(200);
    const updateData = txJobUpdate.mock.calls[0][0].data;
    expect(updateData.customer_id).toBeUndefined();
  });

  // R3b (2026-07-21) — cost model (D2/D8/D18).
  describe('cost model fields (R3b)', () => {
    it('writes labor_hours/overhead_mode/overhead_value for admin', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // status UNSCHEDULED
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, labor_hours: 4, overhead_mode: 'FIXED', overhead_value: 50 });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ labor_hours: 4, overhead_mode: 'FIXED', overhead_value: 50 });

      expect(res.status).toBe(200);
      expect(captured.data.labor_hours).toBe(4);
      expect(captured.data.overhead_mode).toBe('FIXED');
      expect(captured.data.overhead_value).toBe(50);
    });

    // Spec B1 (free-status-transitions) removes the UNSCHEDULED/SCHEDULED-only status gate
    // entirely — ordering constraints go, per the freedom principle. labor_hours are typically
    // logged AFTER the work is done, so they must stay editable on an IN_PROGRESS/COMPLETED job.
    it('allows editing labor_hours/overhead on an IN_PROGRESS job', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
      mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', labor_hours: 6 });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ labor_hours: 6 });

      expect(res.status).toBe(200);
      expect(mockPrisma.job.update).toHaveBeenCalled();
    });

    // Spec B1 removes the status gate for every field, not just cost fields — a non-cost field
    // (scope_notes) sent alongside labor_hours on an IN_PROGRESS job now succeeds too.
    it('also allows a non-cost field (scope_notes) on an IN_PROGRESS job when sent alongside labor_hours', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
      mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', scope_notes: 'edited', labor_hours: 6 });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scope_notes: 'edited', labor_hours: 6 });

      expect(res.status).toBe(200);
      expect(mockPrisma.job.update).toHaveBeenCalled();
    });

    it('clears an override back to org default by sending null for all three fields', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve(JOB_FIXTURE);
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ labor_hours: null, overhead_mode: null, overhead_value: null });

      expect(res.status).toBe(200);
      expect(captured.data.labor_hours).toBeNull();
      expect(captured.data.overhead_mode).toBeNull();
      expect(captured.data.overhead_value).toBeNull();
    });

    // DISPATCHER can update a Job unconditionally by default; every default role that can is
    // ALSO a pricing holder, so this simulates the guard's real target the same way Estimate's
    // does - a grant set with the "See financial data" grant withheld. SRVW-140 - the withheld
    // subject is `Pricing`, not `Invoice`: canSeePricing was repointed.
    it('returns 403 and does not write when the requester can update the Job but cannot see pricing', async () => {
      clearPermissionCache();
      mockAuthAs('dispatcher');
      (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject !== 'Pricing'),
      );
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('dispatcher'))
        .send({ labor_hours: 5 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('cost fields');
      expect(mockPrisma.job.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid overhead_mode at the Zod layer', async () => {
      mockAuthAs('admin');

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ overhead_mode: 'BOGUS' });

      expect(res.status).toBe(400);
    });
  });

  // E1/E2 (job-owns-tax-discount) - the job's own editable tax rate + discount (Items tab).
  describe('tax rate + discount (E1/E2, job-owns-tax-discount)', () => {
    // A job carrying one $1000 taxable line - enough subtotal for the discount-resolution math.
    const jobWithLines = (overrides: Record<string, unknown> = {}) => ({
      ...JOB_FIXTURE,
      customer: { ...JOB_FIXTURE.customer, tax_exempt: false },
      job_line_items: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      scopes: [],
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      ...overrides,
    });

    it('writes tax_rate for admin', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, tax_rate: 0.0625 });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ tax_rate: 0.0625 });

      expect(res.status).toBe(200);
      expect(captured.data.tax_rate).toBe(0.0625);
    });

    it('resolves discount_amount server-side from discount_type/discount_value against the CURRENT subtotal', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ discount_type: 'PERCENTAGE', discount_value: 10 });

      expect(res.status).toBe(200);
      expect(captured.data.discount_type).toBe('PERCENTAGE');
      expect(captured.data.discount_value).toBe(10);
      // 10% of the job's own $1000 subtotal, resolved server-side - never trusted from the client.
      expect(captured.data.discount_amount).toBe(100);
    });

    it('ignores a client-supplied discount_amount - it is always server-resolved', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ discount_type: 'FIXED_AMOUNT', discount_value: 50, discount_amount: 999999 });

      expect(res.status).toBe(200);
      expect(captured.data.discount_amount).toBe(50);
    });

    it('a FIXED_AMOUNT discount clamps to the current subtotal', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ discount_type: 'FIXED_AMOUNT', discount_value: 5000 });

      expect(res.status).toBe(200);
      expect(captured.data.discount_amount).toBe(1000);
    });

    it('clearing the discount (discount_type: null) resolves discount_amount back to 0', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines({
        discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100,
      }));
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ discount_type: null });

      expect(res.status).toBe(200);
      expect(captured.data.discount_type).toBeNull();
      expect(captured.data.discount_amount).toBe(0);
    });

    it('a PATCH that omits tax_rate/discount fields does not touch them', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, scope_notes: 'x' });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scope_notes: 'x' });

      expect(res.status).toBe(200);
      expect(captured.data.tax_rate).toBeUndefined();
      expect(captured.data.discount_type).toBeUndefined();
      expect(captured.data.discount_amount).toBeUndefined();
    });

    it('a tax-exempt customer PATCHing a nonzero tax_rate is clamped to 0', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines({
        customer: { ...JOB_FIXTURE.customer, tax_exempt: true },
      }));
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, tax_rate: 0 });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ tax_rate: 0.08 });

      expect(res.status).toBe(200);
      expect(captured.data.tax_rate).toBe(0);
    });

    // Mirrors the existing cost-field (labor_hours/overhead) pricing gate.
    it('returns 403 and does not write when the requester can update the Job but cannot see pricing', async () => {
      clearPermissionCache();
      mockAuthAs('dispatcher');
      (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject !== 'Pricing'),
      );
      mockPrisma.job.findUnique.mockResolvedValue(jobWithLines());

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('dispatcher'))
        .send({ tax_rate: 0.08 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('cost fields');
      expect(mockPrisma.job.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid discount_type at the Zod layer', async () => {
      mockAuthAs('admin');

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ discount_type: 'BOGUS' });

      expect(res.status).toBe(400);
    });
  });

  // SRVW-87 - PATCH is the EDIT door, not the scheduler. It derives status from the schedule it
  // writes, but ONLY between UNSCHEDULED and SCHEDULED: it must never demote a job that has moved
  // past SCHEDULED, and it must never spread milestoneClears(). See deriveStatusOnReschedule.
  describe('status derivation on reschedule (SRVW-87)', () => {
    it('promotes an UNSCHEDULED job to SCHEDULED when a scheduled_start is written', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, no schedule yet
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, status: 'SCHEDULED' });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: '2026-09-01T09:00:00.000Z', scheduled_end: '2026-09-01T11:00:00.000Z' });

      expect(res.status).toBe(200);
      expect(captured.data.status).toBe('SCHEDULED');
    });

    it('demotes a SCHEDULED job to UNSCHEDULED when the schedule is cleared', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE,
        status: 'SCHEDULED',
        scheduled_start: new Date('2026-09-01T09:00:00Z'),
        scheduled_end: new Date('2026-09-01T11:00:00Z'),
      });
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: null, scheduled_end: null });

      expect(res.status).toBe(200);
      expect(captured.data.status).toBe('UNSCHEDULED');
    });

    // Risk 1 (MONEY/REPORTING): copying assign()'s derivation wholesale would pair the status
    // write with milestoneClears('scheduled'), so correcting a typo in a COMPLETED job's date
    // would un-complete it and corrupt the COMPLETED-count KPI (job.controller.ts getStats).
    it('does not demote a COMPLETED job or clear its milestones when its date is corrected', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE,
        status: 'COMPLETED',
        scheduled_start: new Date('2026-09-01T09:00:00Z'),
        scheduled_end: new Date('2026-09-01T11:00:00Z'),
        on_site_at: new Date('2026-09-01T09:05:00Z'),
        started_at: new Date('2026-09-01T09:10:00Z'),
        completed_at: new Date('2026-09-01T10:45:00Z'),
      });
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, status: 'COMPLETED' });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: '2026-09-02T09:00:00.000Z', scheduled_end: '2026-09-02T11:00:00.000Z' });

      expect(res.status).toBe(200);
      expect(captured.data.status).toBeUndefined();
      for (const field of ['completed_at', 'on_site_at', 'started_at', 'en_route_at', 'cancelled_at']) {
        expect(field in captured.data).toBe(false);
      }
    });

    it('writes no status when the body does not touch scheduled_start', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE,
        status: 'UNSCHEDULED',
        scheduled_start: new Date('2026-09-01T09:00:00Z'),
        scheduled_end: new Date('2026-09-01T11:00:00Z'),
      });
      let captured: any;
      mockPrisma.job.update.mockImplementation((args: any) => {
        captured = args;
        return Promise.resolve({ ...JOB_FIXTURE, job_type: 'HVAC Service' });
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ job_type: 'HVAC Service' });

      expect(res.status).toBe(200);
      expect(captured.data.status).toBeUndefined();
    });
  });

  // SRVW-87 - PATCH now runs the same detectCrewConflicts assign() runs, so a PATCH-reschedule
  // can no longer silently double-book the job's crew. Gated on the window actually MOVING.
  describe('crew conflict detection on reschedule (SRVW-87)', () => {
    const crewedScheduled = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([TEST_USERS.technician.id]),
      scheduled_start: new Date('2026-09-01T09:00:00Z'),
      scheduled_end: new Date('2026-09-01T11:00:00Z'),
    };
    // Multi-visit S6 (B7): the conflict query now reads the other job's VISIT set, so the row it
    // gets back carries the overlapping trips rather than the Job.scheduled_start mirror. The 409
    // ENTRY is unchanged - the parent's id/number with the visit's times.
    const overlapping = [{
      id: 'conflict-job',
      job_number: 'J00002',
      visits: [{
        id: 'conflict-visit',
        scheduled_at: new Date('2026-09-02T09:30:00Z'),
        scheduled_end: new Date('2026-09-02T10:30:00Z'),
      }],
    }];

    // The force case queues a conflicting findMany that is deliberately never consumed, and
    // vi.clearAllMocks() drains calls but NOT the mockResolvedValueOnce queue - so without this
    // the leftover value would be served to the next test that reaches job.findMany.
    afterEach(() => {
      mockPrisma.job.findMany.mockReset();
    });

    it('returns 409 in the assign-shaped body when a crew member overlaps another job', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(crewedScheduled);
      mockPrisma.job.findMany.mockResolvedValueOnce(overlapping);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: '2026-09-02T09:00:00.000Z', scheduled_end: '2026-09-02T11:00:00.000Z' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Schedule conflict detected');
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0].number).toBe('J00002');
      expect(mockPrisma.job.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('scopes the conflict query to the caller org and excludes the job itself', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(crewedScheduled);
      mockPrisma.job.findMany.mockResolvedValueOnce(overlapping);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: '2026-09-02T09:00:00.000Z', scheduled_end: '2026-09-02T11:00:00.000Z' });

      expect(res.status).toBe(409);
      const conflictWhere = mockPrisma.job.findMany.mock.calls[0][0].where;
      expect(conflictWhere.organization_id).toBe(ALPHA_ORG_ID);
      expect(conflictWhere.id).toEqual({ not: JOB_FIXTURE.id });
    });

    it('force: true skips the conflict check', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(crewedScheduled);
      mockPrisma.job.findMany.mockResolvedValueOnce(overlapping);
      mockPrisma.job.update.mockResolvedValue({ ...crewedScheduled });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scheduled_start: '2026-09-02T09:00:00.000Z', scheduled_end: '2026-09-02T11:00:00.000Z', force: true });

      expect(res.status).toBe(200);
      expect(mockPrisma.job.update).toHaveBeenCalled();
      expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    });

    // Pins the three shipped frontend PATCH callers (JobDetailPage job_type + cost fields,
    // EditJobLocationDialog location) as unaffected: none of them sends a schedule field.
    it('never runs conflict detection when the body leaves the window unchanged', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(crewedScheduled);
      mockPrisma.job.update.mockResolvedValue({ ...crewedScheduled, scope_notes: 'x' });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({ scope_notes: 'x' });

      expect(res.status).toBe(200);
      expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    });
  });
});

// ─── DELETE /api/jobs/:id ──────────────────────────────

describe('DELETE /api/jobs/:id', () => {
  // Inventory P1 (§4.3): remove() is now tx-wrapped — SYNCED lines auto-return BEFORE the job
  // row (and its cascading lines) die. Delegate the tx surface to the shared spies so the
  // existing bare-mock assertions (job.delete) keep working.
  function wireDeleteTx(opts: { syncedLines?: any[]; items?: any[] } = {}) {
    const txJobLineFindMany = vi.fn().mockResolvedValue(opts.syncedLines ?? []);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        jobLineItem: { findMany: txJobLineFindMany },
        priceBookItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        job: { delete: mockPrisma.job.delete },
      }),
    );
    return { txJobLineFindMany };
  }

  it('admin can delete an unassigned job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [] });
    mockPrisma.job.delete.mockResolvedValue(JOB_FIXTURE);
    wireDeleteTx();

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Job deleted');
  });

  it('auto-returns a SYNCED line BEFORE the job row dies (QA-416)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [] });
    mockPrisma.job.delete.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.stockMovement.create.mockResolvedValue({});
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 12 });
    const { txJobLineFindMany } = wireDeleteTx({
      syncedLines: [{
        id: 'jli-0000-0000-0000-000000000001',
        quantity: 2,
        price_book_item_id: TRACKED_ITEM_FIXTURE.id,
        stock_location_id: INVENTORY_LOCATION_FIXTURE.id,
      }],
      items: [{ id: TRACKED_ITEM_FIXTURE.id, sku: TRACKED_ITEM_FIXTURE.sku, name: TRACKED_ITEM_FIXTURE.name, unit_cost: TRACKED_ITEM_FIXTURE.unit_cost }],
    });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Reversal candidates are the LINE-state-filtered rows (never the item's current flag).
    expect(txJobLineFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ job_id: JOB_FIXTURE.id, stock_status: 'SYNCED' }),
    }));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(2);
    expect(movement.job_id).toBe(JOB_FIXTURE.id);
    expect(movement.job_line_item_id).toBe('jli-0000-0000-0000-000000000001');
    expect(movement.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
    expect(movement.reference).toBe('J00001 deleted');
    // Movement inserted BEFORE the delete: the line FK must exist at insert; the delete's
    // SetNull then keeps the ledger row (QA-416 shape).
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.job.delete.mock.invocationCallOrder[0]);
  });

  it('allows deleting a SCHEDULED job with no invoice (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', invoices: [] });
    mockPrisma.job.delete.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    wireDeleteTx();

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('returns 400 if job has an invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [{ id: 'inv1', status: 'DRAFT' }] });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoice/i);
  });

  // TECHNICIAN holds `delete Job` since the technician-ownership spec, Part C - but conditioned on
  // `created_by_id`, so a job they did not create is still refused, now by the CONTROLLER's
  // per-instance check rather than the route guard. The creator's positive case (and the
  // invoice-bearing-job rule that still outranks it) lives in job-creator-control.test.ts.
  it('TECHNICIAN cannot delete a job they did not create (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, created_by_id: TEST_USERS.admin.id, invoices: [], ...withCrew([]) });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      ...withCrew([]),
    });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });

  // ── #106 per-instance ENFORCEMENT for delete ──
  // Prove the controller's per-instance delete check fires even when a role HAS a
  // conditional `delete Job` grant (so the subject-level route guard passes). We override
  // the TECHNICIAN grants with a conditional `delete Job` (OWN_JOB); a row owned by another
  // user must 403 from the CONTROLLER and must NOT call job.delete.
  it('returns 403 + does NOT delete when a scoped (conditional-delete) user targets a job owned by another user', async () => {
    mockAuthAs('technician');
    // Override default grants: give TECHNICIAN read + conditional delete on Job so the
    // route guard (subject-level) passes and execution reaches the controller.
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
      { action: 'delete', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    // Unassigned + no invoice would otherwise pass the status/invoice guards — the
    // ownership check must block first because the crew is someone else.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      invoices: [],
      ...withCrew(['another-tech-id']),
    });
    // canAccessRow's scoped probe: not visible under OWN_JOB → null → access denied.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });

  it('allows a scoped (conditional-delete) user to delete a job they own', async () => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
      { action: 'delete', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      invoices: [],
      ...withCrew([TEST_USERS.technician.id]),
    });
    // canAccessRow's scoped probe finds the row visible under OWN_JOB → access granted.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.delete.mockResolvedValue(JOB_FIXTURE);
    wireDeleteTx();

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.delete).toHaveBeenCalled();
  });

  // ── #106 P1: NESTED Team/Location grant must NOT 500 on the base delete ──
  // Same nested-condition hazard as update: a TEAM-conditioned delete Job grant
  // (assignees.some.user.department_id) threw 500 under the CASL matcher. canAccessRow
  // resolves it via SQL → un-owned row → clean 403, never calls job.delete.
  it('returns 403 (NOT 500) when a TEAM-scoped (nested grant) user deletes an un-owned job', async () => {
    clearTokenCache();
    mockAuthAs('technician');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...TEST_USERS.technician,
      department_id: 'dept-9',
      organization: TEST_ORG,
    });
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
      { action: 'delete', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [] });
    mockPrisma.job.findFirst.mockResolvedValue(null); // un-owned under team scope

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });

  it('allows a TEAM-scoped (nested grant) user to delete a job inside their team (200)', async () => {
    clearTokenCache();
    mockAuthAs('technician');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...TEST_USERS.technician,
      department_id: 'dept-9',
      organization: TEST_ORG,
    });
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
      { action: 'delete', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id }); // visible under team scope
    mockPrisma.job.delete.mockResolvedValue(JOB_FIXTURE);
    wireDeleteTx();

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.delete).toHaveBeenCalled();
  });

  it('returns 404 if job not found', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/jobs/nonexistent-id')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/jobs/:id/assign ─────────────────────────

describe('POST /api/jobs/:id/assign', () => {
  const techUser = {
    ...TEST_USERS.technician,
    email: 'tech@test.com',
    first_name: 'Test',
    last_name: 'Tech',
  };

  // assign() replaces the crew + updates the job inside a $transaction. Wire the tx client
  // so the controller's tx.jobAssignee.* + tx.job.update + tx.timelineEvent.create resolve.
  // currentCrew = what jobAssignee.findMany returns inside the tx (the existing crew to diff against).
  function wireAssignTx(updated: any, currentCrew: { user_id: string }[] = []) {
    // Default the (read-only, pre-tx) conflict queries to "no conflict" so a scheduled assign
    // succeeds. Tests that exercise a conflict override with mockResolvedValueOnce (takes priority).
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
    // S8 (D6): crew lands on the VISIT now, so these are the write spies that matter.
    const txVisitAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
    const txVisitAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    const txTimeline = vi.fn().mockResolvedValue({});
    const txPlanVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    // #1626: the trip writers, spied - "did this request book or move a trip?" is the other half
    // of "did it move the job", and a restatement must touch neither.
    const txVisitCreate = vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT);
    const txVisitUpdate = vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so these fakes
        // hold one - a job with no trip at all cannot hold crew and 400s by design (see
        // visit-crew.test.ts, which pins that case deliberately).
        visit: {
          findMany: vi.fn().mockResolvedValue([FIXTURE_CURRENT_VISIT]),
          create: txVisitCreate,
          update: txVisitUpdate,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
        // transaction, so the union it writes can never evict someone off another visit. Without
        // this delegate the read throws inside the tx and the route 500s opaquely.
        visitAssignee: {
          findMany: txVisitAssigneeFindMany,
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: txVisitAssigneeCreateMany,
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: { findMany: txJobAssigneeFindMany, createMany: txJobAssigneeCreateMany, deleteMany: txJobAssigneeDeleteMany },
        job: { update: txJobUpdate },
        timelineEvent: { create: txTimeline },
        planVisit: { updateMany: txPlanVisitUpdateMany },
      }),
    );
    return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txVisitAssigneeFindMany, txVisitAssigneeCreateMany, txJobUpdate, txTimeline, txPlanVisitUpdateMany, txVisitCreate, txVisitUpdate };
  }

  beforeEach(() => {
    // loadGrantsFor() calls rolePermission.findMany for the target user.
    // Default: return grants filtered by role so target ability is correctly resolved.
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) =>
        Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role))
    );
  });

  it('admin can assign a job to a crew member', async () => {
    // mockAuthAs sets up mockImplementation that returns correct user by ID
    // TEST_USERS.technician has role: TECHNICIAN and is_active: true
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('SCHEDULED');
  });

  it('syncs the linked PlanVisit date when a visit-job is rescheduled via assign (calendar drag)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, source_plan_id: '00000000-0000-0000-0000-0000000000a1' });
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2026-07-15T09:00:00.000Z', scheduled_end: '2026-07-15T11:00:00.000Z', force: true });

    expect(res.status).toBe(200);
    expect(tx.txPlanVisitUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_id: JOB_FIXTURE.id }),
        data: expect.objectContaining({ scheduled_date: new Date('2026-07-15T09:00:00.000Z') }),
      }),
    );
  });

  it('assigns a crew of two members', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.job.findMany.mockResolvedValueOnce([]); // no conflicts
    mockPrisma.lead.findMany.mockResolvedValueOnce([]);
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id, TEST_USERS.sales.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
    // S8 (D6): both added, and the write lands on the trip - visit_assignees, not the dead table.
    expect(tx.txVisitAssigneeCreateMany).toHaveBeenCalled();
    const createArg = tx.txVisitAssigneeCreateMany.mock.calls[0][0];
    expect(createArg.data.map((d: { user_id: string }) => d.user_id).sort()).toEqual([techUser.id, TEST_USERS.sales.id].sort());
    expect(tx.txJobAssigneeCreateMany).not.toHaveBeenCalled();
  });

  it('state 4: assignee_ids:[] + a time → SCHEDULED, 0 crew, JOB_SCHEDULED dispatched once, guard stamped', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, customer_scheduled_email_sent_at: null
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
    // Status derives from TIME, not crew → SCHEDULED even with empty crew
    expect(tx.txJobUpdate.mock.calls[0][0].data.status).toBe('SCHEDULED');
    // No crew members created
    expect(tx.txJobAssigneeCreateMany).not.toHaveBeenCalled();
    // Scheduling-notifications PRD: the announcement fires on the DATE, crew or no crew, and the
    // once-per-job guard is stamped in the same update (see automation-wiring.test.ts).
    expect(dispatchedType('JOB_SCHEDULED')).toHaveLength(1);
    expect(tx.txJobUpdate.mock.calls[0][0].data.customer_scheduled_email_sent_at).toBeInstanceOf(Date);
  });

  it('state 2: first-schedule with crew≥1 → SCHEDULED + JOB_SCHEDULED dispatch + flag stamped', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, flag null
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
    expect(tx.txJobUpdate.mock.calls[0][0].data.status).toBe('SCHEDULED');
    // Dispatch fired (the automation replacing "Service Scheduled") AND the flag stamped
    // in the same update — full payload shape covered in automation-wiring.test.ts.
    expect(dispatchedType('JOB_SCHEDULED')).toHaveLength(1);
    expect(tx.txJobUpdate.mock.calls[0][0].data.customer_scheduled_email_sent_at).toBeInstanceOf(Date);
  });

  it('accepts a DISPATCHER assignee (#366: all active users job-crew-eligible)', async () => {
    // #366: job-crew eligibility = ALL active org users (widened ASSIGNABLE_ROLES).
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.dispatcher.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
  });

  it('allows assigning a SALES user as job crew (Decision #4)', async () => {
    // Decision #4: SALES is now assignable to job crews.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.sales.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
  });

  it('allows assigning ADMIN as job crew (admin has manage all)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.admin.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    expect(res.status).toBe(200);
  });

  it('returns 400 if a crew member is inactive', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // Override to return inactive tech for all calls after auth
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === TEST_USERS.admin.id) return Promise.resolve({ ...TEST_USERS.admin, organization: TEST_ORG });
      return Promise.resolve({ ...TEST_USERS.technician, is_active: false, organization: TEST_ORG });
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/);
  });

  it('allows assigning a COMPLETED job (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    expect(res.status).toBe(200);
  });

  it('dispatches TECH_ASSIGNED for each newly-added crew member', async () => {
    // mockAuthAs sets up mockImplementation — TEST_USERS.technician has email: 'tech@test.com'
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2025-06-01T09:00:00Z', scheduled_end: '2025-06-01T11:00:00Z' });

    const assigned = dispatchedType('TECH_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ occurrenceKey: techUser.id, entity: { label: JOB_FIXTURE.job_number } });
  });

  it('dispatches TECH_UNASSIGNED for removed crew members and does NOT re-dispatch TECH_ASSIGNED for kept members', async () => {
    // current crew = [tech, sales]; new crew = [tech] → tech kept (no dispatch), sales removed (TECH_UNASSIGNED)
    mockAuthAs('admin');
    // The CURRENT crew is read from the pre-tx job.findUnique (existing.assignees), which is
    // also what the dispatch diff is computed against.
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, ...withCrew([techUser.id, TEST_USERS.sales.id]) });
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' }, [{ user_id: techUser.id }, { user_id: TEST_USERS.sales.id }]);
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TEST_USERS.sales.id, email: TEST_USERS.sales.email, first_name: TEST_USERS.sales.first_name, last_name: TEST_USERS.sales.last_name },
    ]);

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    // tech was already on the crew → no TECH_ASSIGNED
    expect(dispatchedType('TECH_ASSIGNED')).toHaveLength(0);
    // sales removed → TECH_UNASSIGNED
    const unassigned = dispatchedType('TECH_UNASSIGNED');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]).toMatchObject({ occurrenceKey: TEST_USERS.sales.id });
  });

  // Same shape as delete above: the grant exists now, scoped to jobs the technician created, so the
  // refusal moved from the route guard to the handler's per-instance check.
  it('TECHNICIAN cannot assign a job they did not create (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, created_by_id: TEST_USERS.admin.id, ...withCrew([]) });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      ...withCrew([]),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('technician'))
      .send({ assignee_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(403);
  });

  // ─── SCHEDULED / RESCHEDULED timeline events (A3) ────

  it('writes a SCHEDULED timeline event on first schedule', async () => {
    // JOB_FIXTURE has status: UNSCHEDULED and scheduled_start: null — first schedule
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2026-07-01T15:00:00.000Z', scheduled_end: '2026-07-01T17:00:00.000Z' });

    expect(res.status).toBe(200);
    const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(eventTypes).toContain('SCHEDULED');
    expect(eventTypes).not.toContain('RESCHEDULED');
    const scheduledCall = tx.txTimeline.mock.calls.find((c: any[]) => c[0].data.event_type === 'SCHEDULED');
    expect(scheduledCall![0].data.metadata).toEqual({ from: null, to: '2026-07-01T15:00:00.000Z' });
  });

  it('writes a RESCHEDULED timeline event when scheduled_start changes', async () => {
    // Job already has a scheduled_start set → changing it writes RESCHEDULED
    // S8 (RATIFIED, A5): scheduled_start is a computed projection off `visits[]` now, not a flat
    // column - the `visits` override below (replacing withCrew's own fixed 2026-10-01 stub) is
    // what makes `currentWindow.scheduled_start` actually resolve to the date this test intends.
    const JOB_SCHEDULED_FIXTURE = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([techUser.id]),
      visits: [{
        id: 'v0000000-0000-0000-0000-0000000000f1', visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-07-01T15:00:00.000Z'), scheduled_end: new Date('2026-07-01T17:00:00.000Z'),
        is_all_day: false, customer_email_sent_at: null, created_at: new Date('2026-06-01T00:00:00.000Z'),
        assignees: [{ user_id: techUser.id, user: { id: techUser.id, first_name: 'F', last_name: 'L' } }],
      }],
    };
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_SCHEDULED_FIXTURE);
    const tx = wireAssignTx({ ...JOB_SCHEDULED_FIXTURE, scheduled_start: new Date('2026-07-09T15:00:00.000Z') },
      [{ user_id: techUser.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id], scheduled_start: '2026-07-09T15:00:00.000Z', scheduled_end: '2026-07-09T17:00:00.000Z', force: true });

    expect(res.status).toBe(200);
    const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(eventTypes).toContain('RESCHEDULED');
    expect(eventTypes).not.toContain('SCHEDULED');
    const rescheduledCall = tx.txTimeline.mock.calls.find((c: any[]) => c[0].data.event_type === 'RESCHEDULED');
    expect(rescheduledCall![0].data.metadata).toEqual({ from: '2026-07-01T15:00:00.000Z', to: '2026-07-09T15:00:00.000Z' });
  });

  it('does NOT write SCHEDULED or RESCHEDULED when crew changes but time does not change', async () => {
    // Crew change only (same scheduled_start, no time change) → no scheduling timeline event
    // Job is already SCHEDULED with techUser on crew; we add a sales user, same time → timeChanged=false
    // S8 (RATIFIED, A5): scheduled_start is a computed projection off `visits[]` now - the
    // `visits` override below is what makes `currentWindow.scheduled_start` resolve to the SAME
    // instant the PATCH body sends, so `timeChanged` is genuinely false rather than an accident of
    // withCrew's own fixed stub date.
    const JOB_SCHEDULED_FIXTURE = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([techUser.id]),
      visits: [{
        id: 'v0000000-0000-0000-0000-0000000000f1', visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-07-01T15:00:00.000Z'), scheduled_end: new Date('2026-07-01T17:00:00.000Z'),
        is_all_day: false, customer_email_sent_at: null, created_at: new Date('2026-06-01T00:00:00.000Z'),
        assignees: [{ user_id: techUser.id, user: { id: techUser.id, first_name: 'F', last_name: 'L' } }],
      }],
    };
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_SCHEDULED_FIXTURE);
    const tx = wireAssignTx({ ...JOB_SCHEDULED_FIXTURE, ...withCrew([techUser.id, TEST_USERS.sales.id]) },
      [{ user_id: techUser.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id, TEST_USERS.sales.id], scheduled_start: '2026-07-01T15:00:00.000Z', scheduled_end: '2026-07-01T17:00:00.000Z', force: true });

    expect(res.status).toBe(200);
    const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(eventTypes).not.toContain('SCHEDULED');
    expect(eventTypes).not.toContain('RESCHEDULED');
  });

  // ─── #1626 / spec #1751 D9: crew ⟂ status, enforced on the SERVER ─────────
  //
  // The product rule, ratified verbatim:
  //
  //   "Adding a crew, no matter to which job or walkthrough, doesn't change the status. It
  //    doesn't move anything from completed to uncompleted or from scheduled to unscheduled.
  //    This applies both to jobs and walkthroughs."
  //
  // These are written as INVARIANTS over the whole JobStatus enum rather than as a COMPLETED
  // example, and they read the enum at runtime on purpose: adding a status to the schema adds a
  // case here automatically, and a status RETIRED from the schema (EN_ROUTE / ON_SITE, dropped by
  // design in multi-visit S4/D17) cannot be resurrected here by a copy-paste.
  //
  // Two shapes of body reach this door meaning "just add a technician", and both must behave:
  //  - the crew-only body, no schedule keys at all;
  //  - the RESTATED window, which is what a dialog seeded from the record posts on every save.
  //    That second one is #1626 itself: the server used to read any `scheduled_start` as "this
  //    job is being booked", so the client omitting the field was the only thing standing between
  //    a finished job and milestoneClears('scheduled').
  describe('crew-only assign preserves status and milestones (#1626)', () => {
    const NON_SCHEDULED_STATUSES = Object.values(JobStatus).filter((s) => s !== 'SCHEDULED');

    /** The milestone columns milestoneClears('scheduled') nulls. None may be written. */
    const MILESTONE_COLUMNS = ['started_at', 'completed_at', 'cancelled_at', 'cancelled_reason'];

    /**
     * A job at `status` whose ONE live trip is Oct 1, 09:00-11:00 and carries `techUser`.
     * `completed_at` is stamped whatever the status, so "the milestone survived" is assertable on
     * every case rather than only on COMPLETED.
     */
    function jobAt(status: string, over: Record<string, unknown> = {}) {
      return {
        ...JOB_FIXTURE,
        status,
        ...withCrew([techUser.id]),
        completed_at: new Date('2026-10-01T10:45:00.000Z'),
        ...over,
      };
    }

    function expectNoMilestoneWrite(data: Record<string, unknown>) {
      for (const column of MILESTONE_COLUMNS) expect(data).not.toHaveProperty(column);
    }

    it.each(NON_SCHEDULED_STATUSES)(
      'a crew-only assign on a %s job leaves the status and every milestone alone',
      async (status) => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue(jobAt(status));
        const tx = wireAssignTx(jobAt(status), [{ user_id: techUser.id }]);

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
          .set(authHeader('admin'))
          .send({ assignee_ids: [techUser.id, TEST_USERS.sales.id] });

        expect(res.status).toBe(200);
        const data = tx.txJobUpdate.mock.calls[0][0].data;
        expect(data.status).toBe(status);
        expectNoMilestoneWrite(data);
      },
    );

    it.each(NON_SCHEDULED_STATUSES)(
      'RESTATING the window of a %s job while adding crew leaves the status and every milestone alone',
      async (status) => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue(jobAt(status));
        const tx = wireAssignTx(jobAt(status), [{ user_id: techUser.id }]);

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
          .set(authHeader('admin'))
          .send({
            assignee_ids: [techUser.id, TEST_USERS.sales.id],
            // withCrew's stub trip, verbatim - exactly what a dialog seeded from the job posts
            // back when nobody touches the pickers.
            scheduled_start: '2026-10-01T09:00:00.000Z',
            scheduled_end: '2026-10-01T11:00:00.000Z',
            is_all_day: false,
            force: true,
          });

        expect(res.status).toBe(200);
        const data = tx.txJobUpdate.mock.calls[0][0].data;
        expect(data.status).toBe(status);
        expectNoMilestoneWrite(data);
      },
    );

    // The reported symptom, stated as itself: the row must still read COMPLETED and must still
    // carry the stamp that makes the dashboard's completed count true.
    it('adding a technician to a COMPLETED job leaves it COMPLETED with completed_at intact', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobAt('COMPLETED'));
      const tx = wireAssignTx(jobAt('COMPLETED'), [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id, TEST_USERS.sales.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          scheduled_end: '2026-10-01T11:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      const data = tx.txJobUpdate.mock.calls[0][0].data;
      expect(data.status).toBe('COMPLETED');
      // Not "completed_at is still the old Date" - the handler must not NAME the column at all,
      // which is the only way the stored stamp survives a Prisma update.
      expect(data).not.toHaveProperty('completed_at');
      expect(res.body.job.status).toBe('COMPLETED');
    });

    // The pickers edit HH:mm, so a stored start carrying seconds seeds as `:00`. Comparing raw
    // instants made that restatement look like a move for ever.
    it('a restatement rounded to the minute is still a restatement when the stored start carries seconds', async () => {
      const withSeconds = jobAt('COMPLETED');
      withSeconds.visits[0]!.scheduled_at = new Date('2026-10-01T09:00:37.000Z');
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(withSeconds);
      const tx = wireAssignTx(withSeconds, [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id, TEST_USERS.sales.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          scheduled_end: '2026-10-01T11:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      const data = tx.txJobUpdate.mock.calls[0][0].data;
      expect(data.status).toBe('COMPLETED');
      expectNoMilestoneWrite(data);
      const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
      expect(eventTypes).not.toContain('RESCHEDULED');
      expect(eventTypes).not.toContain('SCHEDULED');
    });

    // The other half of "it moved nothing": no trip is booked or re-dated either. Without this a
    // restatement on a job whose only trip has been completed would invent a fresh SCHEDULED one.
    it('a restatement books no trip and moves none', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobAt('COMPLETED'));
      const tx = wireAssignTx(jobAt('COMPLETED'), [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id, TEST_USERS.sales.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          scheduled_end: '2026-10-01T11:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      expect(tx.txVisitCreate).not.toHaveBeenCalled();
      expect(tx.txVisitUpdate).not.toHaveBeenCalled();
    });

    // A job holding a start with NO end - a state updateJobSchema deliberately permits a PATCH to
    // create. The pairing refine used to 400 the plain reassign that seeded from it.
    it('reassigns a job holding a start with no end instead of 400ing', async () => {
      const noEnd = jobAt('SCHEDULED');
      // withCrew's stub types the key as Date; the real column is nullable, which is exactly the
      // state under test.
      (noEnd.visits[0] as unknown as { scheduled_end: Date | null }).scheduled_end = null;
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(noEnd);
      const tx = wireAssignTx(noEnd, [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id, TEST_USERS.sales.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      // And it is a restatement, not a booking: the start it names is the one the job holds.
      expect(tx.txJobUpdate.mock.calls[0][0].data.status).toBe('SCHEDULED');
      expect(tx.txVisitUpdate).not.toHaveBeenCalled();
    });

    // Proof the feature was fixed, not disabled: a window that genuinely MOVES still books the
    // trip, still forces SCHEDULED, and still rewinds the milestones Spec B1 says it rewinds.
    it('a GENUINE reschedule of a COMPLETED job still books the trip, sets SCHEDULED and rewinds', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobAt('COMPLETED'));
      const tx = wireAssignTx({ ...jobAt('COMPLETED'), status: 'SCHEDULED' }, [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id],
          scheduled_start: '2026-10-08T09:00:00.000Z',
          scheduled_end: '2026-10-08T11:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      const data = tx.txJobUpdate.mock.calls[0][0].data;
      expect(data.status).toBe('SCHEDULED');
      expect(data.completed_at).toBeNull();
      expect(data.cancelled_at).toBeNull();
      expect(tx.txVisitUpdate).toHaveBeenCalled();
      const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
      expect(eventTypes).toContain('RESCHEDULED');
    });

    // Moving ONLY the end is a move too - and must not be readable as a restatement just because
    // the start held still.
    it('a changed END alone is a move', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(jobAt('COMPLETED'));
      const tx = wireAssignTx({ ...jobAt('COMPLETED'), status: 'SCHEDULED' }, [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          scheduled_end: '2026-10-01T14:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      expect(tx.txJobUpdate.mock.calls[0][0].data.status).toBe('SCHEDULED');
      expect(tx.txVisitUpdate).toHaveBeenCalled();
    });

    // The service-plan cascade rides the same const: a restatement must not re-date the PlanVisit
    // (nor, through revertPlanVisitOnUncomplete, reopen a consumed one).
    it('a restatement does not re-date the linked PlanVisit of a service-plan job', async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue(
        jobAt('COMPLETED', { source_plan_id: '00000000-0000-0000-0000-0000000000a1' }),
      );
      const tx = wireAssignTx(jobAt('COMPLETED'), [{ user_id: techUser.id }]);

      const res = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
        .set(authHeader('admin'))
        .send({
          assignee_ids: [techUser.id, TEST_USERS.sales.id],
          scheduled_start: '2026-10-01T09:00:00.000Z',
          scheduled_end: '2026-10-01T11:00:00.000Z',
          force: true,
        });

      expect(res.status).toBe(200);
      expect(tx.txPlanVisitUpdateMany).not.toHaveBeenCalled();
    });
  });

});

// ─── POST /api/jobs/:id/assign — conflict detection ────

describe('POST /api/jobs/:id/assign — conflict detection', () => {
  const techUser = {
    ...TEST_USERS.technician,
    email: 'tech@test.com',
    first_name: 'Test',
    last_name: 'Tech',
  };

  // Wire the assign $transaction (see note in the main assign block).
  function wireAssignTx(updated: any) {
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    // S8 (RATIFIED, A5): is_all_day/scheduled_end land HERE now (syncJobWindowOntoVisits'
    // tx.visit.update, moving the existing FIXTURE_CURRENT_VISIT) - the job-level mirror write is
    // dropped, so tests asserting the window/all-day flag assert this spy, not txJobUpdate.
    const txVisitUpdate = vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
        // transaction, so the union it writes can never evict someone off another visit. Without
        // this delegate the read throws inside the tx and the route 500s opaquely.
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        job: { update: txJobUpdate },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
        // Multi-visit S2: /assign keeps the job's one window in step with its visit set.
        // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so these fakes
        // hold one - a job with no trip at all cannot hold crew and 400s by design (see
        // visit-crew.test.ts, which pins that case deliberately).
        visit: {
          findMany: vi.fn().mockResolvedValue([FIXTURE_CURRENT_VISIT]),
          create: vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT),
          update: txVisitUpdate,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
      }),
    );
    return { txJobUpdate, txVisitUpdate };
  }

  beforeEach(() => {
    // loadGrantsFor() calls rolePermission.findMany for the target user.
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) =>
        Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role))
    );
  });

  it('returns 409 when a crew member has an overlapping scheduled job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // Cross-entity conflict: findMany for jobs returns a conflict, findMany for leads returns empty
    mockPrisma.job.findMany.mockResolvedValueOnce([{ id: 'conflict-job', job_number: 'J00002', visits: [{ id: 'conflict-visit', scheduled_at: new Date('2025-06-01T09:00:00Z'), scheduled_end: new Date('2025-06-01T11:00:00Z') }] }]);
    mockPrisma.lead.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T09:00:00Z',
        scheduled_end: '2025-06-01T11:00:00Z',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].number).toBe('J00002');
  });

  it('succeeds with force: true even when a conflict exists', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T09:00:00Z',
        scheduled_end: '2025-06-01T11:00:00Z',
        force: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    // conflict check skipped — findMany for conflicts should not have been called after findUnique
    // (findMany may be called for other queries, so we just verify the assign succeeded)
  });

  it('skips conflict check when no scheduled times are provided', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    expect(res.status).toBe(200);
    // No conflict check when no times provided
  });

  // #1626: the pairing refine used to reject this, and that was the defect - a job holding a
  // start with NO end (a state updateJobSchema deliberately permits a PATCH to create) could not
  // be reassigned at all, because the dialog seeded the start it could see and had no end to pair
  // with it. A lone start now resolves its end against the job's current window; only a lone END
  // is still nonsense, since there is nothing for it to be the end of.
  it('accepts a lone scheduled_start and resolves the end from the job current window', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T09:00:00Z',
      });

    expect(res.status).toBe(200);
  });

  it('still returns 400 for a scheduled_end with no scheduled_start', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_end: '2025-06-01T11:00:00Z',
      });

    expect(res.status).toBe(400);
  });

  it('does not return 409 when rescheduling a job to a slot that overlaps its own current schedule', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // No OTHER conflicts — self excluded by id: { not: id }
    mockPrisma.job.findMany.mockResolvedValueOnce([]);
    mockPrisma.lead.findMany.mockResolvedValueOnce([]);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T09:30:00Z',
        scheduled_end: '2025-06-01T10:30:00Z',
      });

    expect(res.status).toBe(200);
    // Conflict query must exclude the job being rescheduled
    expect(mockPrisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: JOB_FIXTURE.id } }),
      }),
    );
  });

  it('should assign job with is_all_day flag', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.job.findMany.mockResolvedValueOnce([]);
    mockPrisma.lead.findMany.mockResolvedValueOnce([]);
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED', is_all_day: true });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T00:00:00Z',
        scheduled_end: '2025-06-02T00:00:00Z',
        is_all_day: true,
      });

    expect(res.status).toBe(200);
    // S8 (RATIFIED, A5): is_all_day is no longer a job column - syncJobWindowOntoVisits writes it
    // onto the VISIT it moves/books, not job.update's data.
    expect(tx.txVisitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ is_all_day: true }),
      }),
    );
    expect(tx.txJobUpdate.mock.calls[0][0].data).not.toHaveProperty('is_all_day');
  });

  it('should auto-compute scheduled_end for all-day job when only start provided', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // computedEnd will be start + 24h, so conflict detection runs
    mockPrisma.job.findMany.mockResolvedValueOnce([]);
    mockPrisma.lead.findMany.mockResolvedValueOnce([]);
    const tx = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED', is_all_day: true });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [techUser.id],
        scheduled_start: '2025-06-01T00:00:00Z',
        is_all_day: true,
      });

    expect(res.status).toBe(200);
    // S8 (RATIFIED, A5): is_all_day/scheduled_end are no longer job columns - the auto-computed
    // 24h end lands on the VISIT syncJobWindowOntoVisits moves, via computedEnd.
    expect(tx.txVisitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          is_all_day: true,
          scheduled_end: new Date('2025-06-02T00:00:00Z'),
        }),
      }),
    );
    expect(tx.txJobUpdate.mock.calls[0][0].data).not.toHaveProperty('is_all_day');
    expect(tx.txJobUpdate.mock.calls[0][0].data).not.toHaveProperty('scheduled_end');
  });
});

// ─── POST /api/jobs/:id/assignees (crew-only REPLACE) ──

describe('POST /api/jobs/:id/assignees', () => {
  const techUser = {
    ...TEST_USERS.technician,
    email: 'tech@test.com',
    first_name: 'Test',
    last_name: 'Tech',
  };

  function wireAssigneesTx(updated: any, currentCrew: { user_id: string }[] = []) {
    const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
    // S8 (D6): crew lands on the VISIT now, so these are the write spies that matter.
    const txVisitAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
    const txVisitAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    const txTimeline = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so these fakes
        // hold one - a job with no trip at all cannot hold crew and 400s by design (see
        // visit-crew.test.ts, which pins that case deliberately).
        visit: {
          findMany: vi.fn().mockResolvedValue([FIXTURE_CURRENT_VISIT]),
          create: vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT),
          update: vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
        // transaction, so the union it writes can never evict someone off another visit. Without
        // this delegate the read throws inside the tx and the route 500s opaquely.
        visitAssignee: {
          findMany: txVisitAssigneeFindMany,
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: txVisitAssigneeCreateMany,
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: { findMany: txJobAssigneeFindMany, createMany: txJobAssigneeCreateMany, deleteMany: txJobAssigneeDeleteMany },
        job: { update: txJobUpdate, findUnique: vi.fn().mockResolvedValue(updated) },
        timelineEvent: { create: txTimeline },
      }),
    );
    return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txVisitAssigneeFindMany, txVisitAssigneeCreateMany, txJobUpdate, txTimeline };
  }

  beforeEach(() => {
    (prisma.rolePermission.findMany as any).mockImplementation(
      (args: { where: { organization_id: string; role: string } }) =>
        Promise.resolve(DEFAULT_GRANTS.filter(g => g.role === args.where.role))
    );
  });

  it('replaces the crew WITHOUT touching status or schedule', async () => {
    mockAuthAs('admin');
    // A scheduled job — its status/schedule must be left untouched by a crew-only replace.
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    const tx = wireAssigneesTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    expect(res.status).toBe(200);
    // S8 (D6): crew written - onto the trip.
    expect(tx.txVisitAssigneeCreateMany).toHaveBeenCalled();
    expect(tx.txJobAssigneeCreateMany).not.toHaveBeenCalled();
    // NEVER writes status or scheduling fields
    const updateArg = tx.txJobUpdate.mock.calls.length ? tx.txJobUpdate.mock.calls[0][0].data : {};
    expect(updateArg.status).toBeUndefined();
    expect(updateArg.scheduled_start).toBeUndefined();
    expect(updateArg.scheduled_end).toBeUndefined();
    expect(updateArg.customer_scheduled_email_sent_at).toBeUndefined();
  });

  it('does NOT dispatch JOB_SCHEDULED or JOB_RESCHEDULED (crew-only endpoint never touches scheduling)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    wireAssigneesTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [techUser.id] });

    expect(dispatchedType('JOB_SCHEDULED')).toHaveLength(0);
    expect(dispatchedType('JOB_RESCHEDULED')).toHaveLength(0);
  });

  it('accepts a DISPATCHER crew member (#366: all active users job-crew-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    const tx = wireAssigneesTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.dispatcher.id] });

    expect(res.status).toBe(200);
    expect(tx.txVisitAssigneeCreateMany).toHaveBeenCalled();
  });

  it('TECHNICIAN cannot set assignees on a job they did not create (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, created_by_id: TEST_USERS.admin.id, ...withCrew([]) });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      ...withCrew([]),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('technician'))
      .send({ assignee_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(403);
  });
});

// ─── POST /api/jobs/:id/unassign ───────────────────────

describe('POST /api/jobs/:id/unassign', () => {
  it('admin can unschedule a scheduled job (status UNSCHEDULED, crew KEPT)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', ...withCrew([TEST_USERS.technician.id]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/unassign`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('UNSCHEDULED');
    // UNSCHEDULE semantics: crew is NOT cleared (no assigned_to:null, no jobAssignee deletion).
    expect(updateCall.data.assigned_to).toBeUndefined();
  });

  it('clears schedule fields but keeps the crew on unassign', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/unassign`).set(authHeader('admin'));

    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    // S8 (RATIFIED, A5): scheduled_start/scheduled_end are DROPPED as job columns - there is
    // nothing left to null here. The live visits are cancelled separately (via visit.updateMany,
    // asserted by the cancellation test elsewhere in this file), and the response's computed
    // projection reads null off that once there is no live visit left.
    expect(updateCall.data).not.toHaveProperty('scheduled_start');
    expect(updateCall.data).not.toHaveProperty('scheduled_end');
    // crew untouched
    expect(updateCall.data.assignees).toBeUndefined();
    expect(mockPrisma.jobAssignee.deleteMany).not.toHaveBeenCalled();
  });

  it('allows unassigning an already-UNSCHEDULED job (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // status: UNSCHEDULED
    mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/unassign`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('flips the linked PlanVisit to CANCELLED when a service-plan visit-job is unscheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', source_plan_id: '00000000-0000-0000-0000-0000000000a1' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.planVisit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/unassign`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_id: JOB_FIXTURE.id }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
  });

  it('does NOT touch PlanVisit when a normal (non-plan) job is unscheduled', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', source_plan_id: null });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/unassign`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).not.toHaveBeenCalled();
  });
});

// ─── POST /api/jobs/:id/start ──────────────────────────

describe('POST /api/jobs/:id/start', () => {
  it('admin can start a scheduled job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', assigned_to: TEST_USERS.technician.id });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', started_at: new Date() });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'IN_PROGRESS', started_at: expect.any(Date) }),
      }),
    );
  });

  it('sets started_at on transition to IN_PROGRESS', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/start`).set(authHeader('admin'));

    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    expect(updateCall.data.started_at).toBeInstanceOf(Date);
  });

  it('allows starting a job that is not SCHEDULED (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  // Spec A D3 (2026-07-21, main-app migration): `start` (OWN_JOB) became a TECHNICIAN role
  // default — a pre-grant for Spec B1's Start button. `en_route` stays a per-user toggle (Spec A
  // D10 builds no en-route UI), so it is NOT asserted here as granted.
  it('allows a TECHNICIAN to start their own scheduled job (own-scoped role default)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalled();
  });

  it('still blocks a TECHNICIAN from starting a job they are not assigned to (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew(['someone-else']),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN cannot start a job they are not on the crew of (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew(['other-tech-id']),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('DISPATCHER can start a job they are not personally assigned to', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', started_at: new Date() });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });
});

// ─── POST /api/jobs/:id/complete ───────────────────────

describe('POST /api/jobs/:id/complete', () => {
  it('admin can complete an in-progress job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', assigned_to: TEST_USERS.technician.id });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'AC replaced successfully' });

    expect(res.status).toBe(200);
  });

  it('accepts completion without completion_notes (optional field)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', assigned_to: null });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('sets completed_at on completion', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', assigned_to: null });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    expect(updateCall.data.completed_at).toBeInstanceOf(Date);
  });

  it('backfills started_at when closing out a job that was never started', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', started_at: null, ...withCrew([]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    expect(updateCall.data.started_at).toBeInstanceOf(Date);
  });

  it('preserves the original started_at when a job was already started', async () => {
    mockAuthAs('admin');
    const originalStartedAt = new Date('2025-06-01T09:00:00Z');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      started_at: originalStartedAt,
      ...withCrew([]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    const updateCall = mockPrisma.job.update.mock.calls[0][0];
    expect(updateCall.data.started_at).toBe(originalStartedAt);
  });

  it('admin can complete a SCHEDULED job directly (close-out from any active status)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', ...withCrew([]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(200);
  });

  it('DISPATCHER can complete a job they are not personally assigned to', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('dispatcher'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(200);
  });

  it('allows completing a job that is UNSCHEDULED (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(200);
  });

  // Multi-visit S4 / D15: `complete Job` is no longer a TECHNICIAN role DEFAULT - it is seeded
  // into role_permissions at org creation only, so orgs provisioned before the change keep it and
  // new ones never get it. Whether the grant is present at all is covered end to end in
  // technician-complete-grant.test.ts. These two tests are about something else and still are:
  // given an org that HOLDS the grant, the OWN_JOB row-scope decides. The grant is therefore
  // seeded explicitly rather than left to mockAuthAs's DEFAULT_GRANTS - without it the 403 below
  // would pass because the technician has no `complete Job` at all, proving nothing about scope.
  const legacyTechnicianGrants = () => [
    ...DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
    {
      role: 'TECHNICIAN',
      action: 'complete',
      subject: 'Job',
      conditions: { assignees: { some: { user_id: '{{userId}}' } } },
    },
  ];

  it('TECHNICIAN can complete their own assigned job when the org carries the grant', async () => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      legacyTechnicianGrants(),
    );
    clearPermissionCache();
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('technician'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(200);
  });

  it('TECHNICIAN cannot complete a job they are not assigned to (403)', async () => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      legacyTechnicianGrants(),
    );
    clearPermissionCache();
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      ...withCrew(['other-tech-id']),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('technician'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

// ─── POST /api/jobs/:id/cancel ─────────────────────────

  it('flips the linked PlanVisit to COMPLETED when a service-plan visit-job is completed', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', assigned_to: TEST_USERS.technician.id, source_plan_id: '00000000-0000-0000-0000-0000000000a1' });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.planVisit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Plan visit done' });

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_id: JOB_FIXTURE.id }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('does NOT touch PlanVisit when a normal (non-plan) job is completed', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', assigned_to: TEST_USERS.technician.id, source_plan_id: null });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.planVisit.updateMany).not.toHaveBeenCalled();
  });

// ─── POST /api/jobs/:id/en-route ───────────────────────

describe('POST /api/jobs/:id/en-route', () => {
  it('admin can mark a scheduled job en route', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', ...withCrew([]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'EN_ROUTE' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('DISPATCHER can mark a job en route without being personally assigned to it', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      // customer.email: null — skips the (unmocked) en-route customer-notification email path;
      // this test is about the permission gate, not the notification.
      customer: { ...JOB_FIXTURE.customer, email: null },
      assignees: [{ user_id: TEST_USERS.technician.id, user: { first_name: 'Tech' } }],
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'EN_ROUTE' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  // Scheduling-notifications slice 07: the milestone is called "on the way" everywhere a user
  // reads it, and the timeline entry this route writes is read on the job's activity feed.
  it('writes a timeline entry that says the technician is on the way', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', ...withCrew([]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'EN_ROUTE' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: `Technician is on the way for job ${JOB_FIXTURE.job_number}`,
        }),
      }),
    );
  });

  it('tells the caller it failed to mark the job on the way when the read throws', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockRejectedValue(new Error('connection reset'));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to mark job on the way');
  });

  it('TECHNICIAN cannot mark en route a job they are not on the crew of (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      ...withCrew(['other-tech-id']),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ─── POST /api/jobs/:id/arrive ─────────────────────────

describe('POST /api/jobs/:id/arrive', () => {
  it('admin can mark an en-route job on-site (arrive)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'EN_ROUTE', ...withCrew([]) });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'ON_SITE' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('DISPATCHER can mark a job as arrived (on-site) without being personally assigned to it', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'EN_ROUTE',
      ...withCrew([TEST_USERS.technician.id]),
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'ON_SITE' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('TECHNICIAN cannot mark arrived a job they are not on the crew of (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'EN_ROUTE',
      ...withCrew(['other-tech-id']),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  // §8 cancel cascade: cancel() now loads the job's invoices, voids the OPEN ones inside a
  // $transaction, and surfaces the collected total for the admin's separate refund action.
  // Inventory P1 (§4.2): the same tx now also auto-returns SYNCED job lines (QA-413) and, per
  // voided invoice, its invoice-BORN synced lines — the tx surface gains the stock keys.
  function wireCancelTx(
    updated: any,
    opts: { jobSyncedLines?: any[]; invoiceSyncedLines?: any[]; items?: any[] } = {},
  ) {
    const txInvoiceUpdate = vi.fn().mockResolvedValue({});
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    const txTimeline = vi.fn().mockResolvedValue({});
    const txJobLineFindMany = vi.fn().mockResolvedValue(opts.jobSyncedLines ?? []);
    const txJobLineUpdateMany = vi.fn().mockResolvedValue({ count: (opts.jobSyncedLines ?? []).length });
    const txInvLineFindMany = vi.fn().mockResolvedValue(opts.invoiceSyncedLines ?? []);
    const txInvLineUpdateMany = vi.fn().mockResolvedValue({ count: (opts.invoiceSyncedLines ?? []).length });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: txInvoiceUpdate },
        job: { update: txJobUpdate },
        timelineEvent: { create: txTimeline },
        jobLineItem: { findMany: txJobLineFindMany, updateMany: txJobLineUpdateMany },
        invoiceLineItem: { findMany: txInvLineFindMany, updateMany: txInvLineUpdateMany },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
      }),
    );
    return { txInvoiceUpdate, txJobUpdate, txTimeline, txJobLineFindMany, txJobLineUpdateMany, txInvLineFindMany, txInvLineUpdateMany };
  }

  it('frees the linked PlanVisit (CANCELLED) when a service-plan visit-job is cancelled', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', invoices: [], source_plan_id: '00000000-0000-0000-0000-0000000000a1' });
    const txPlanVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'CANCELLED' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
        planVisit: { updateMany: txPlanVisitUpdateMany },
        // Inventory P1 (§4.2): cancel's auto-return pass — nothing SYNCED on a plan-visit job.
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Visit not needed' });

    expect(res.status).toBe(200);
    expect(txPlanVisitUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_id: JOB_FIXTURE.id }),
        data: { status: 'CANCELLED' },
      }),
    );
  });

  it('admin can cancel an unassigned job (no invoices)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, invoices: [] });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.collected_total).toBe(0);
    expect(res.body.refund_suggested).toBe(false);
  });

  it('can cancel a scheduled job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', invoices: [] });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No show' });

    expect(res.status).toBe(200);
  });

  it('can cancel an in-progress job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', invoices: [] });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Emergency' });

    expect(res.status).toBe(200);
  });

  it('voids the job OPEN invoices to amount_due 0 and surfaces the collected total for refund', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      invoices: [
        // OPEN/billable SENT invoice with $300 collected, $0 refunded → voided to 0.
        {
          id: 'inv-open-1',
          status: 'SENT',
          kind: 'STANDARD',
          amount_due: 700,
          total_amount: 1000,
          payments: [{ amount: 300, reference_number: null }],
          refunds: [],
        },
        // A DRAFT invoice is NOT voided (it is delete-able), and carries no collected money.
        {
          id: 'inv-draft-1',
          status: 'DRAFT',
          kind: 'STANDARD',
          amount_due: 500,
          total_amount: 500,
          payments: [],
          refunds: [],
        },
      ],
    });
    const { txInvoiceUpdate } = wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    // Only the SENT invoice is voided to status VOIDED + amount_due 0 (DRAFT is skipped).
    expect(txInvoiceUpdate).toHaveBeenCalledTimes(1);
    expect(txInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-open-1' },
        data: expect.objectContaining({ status: 'VOIDED', amount_due: 0 }),
      }),
    );
    expect(res.body.collected_total).toBe(300);
    expect(res.body.refund_suggested).toBe(true);
    expect(res.body.voided_invoice_ids).toEqual(['inv-open-1']);
  });

  it('auto-returns SYNCED job lines and restamps them UNSYNCED inside the cancel tx (QA-413)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', invoices: [] });
    mockPrisma.stockMovement.create.mockResolvedValue({});
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 12 });
    // The tx findMany answers the stock_status:'SYNCED'-filtered query — the UNSYNCED third
    // line never comes back from the DB, so exactly 2 returns move.
    const { txJobLineFindMany, txJobLineUpdateMany } = wireCancelTx(
      { ...JOB_FIXTURE, status: 'CANCELLED' },
      {
        jobSyncedLines: [
          { id: 'jli-0000-0000-0000-000000000001', quantity: 2, price_book_item_id: TRACKED_ITEM_FIXTURE.id, stock_location_id: INVENTORY_LOCATION_FIXTURE.id },
          { id: 'jli-0000-0000-0000-000000000002', quantity: 1.5, price_book_item_id: TRACKED_ITEM_FIXTURE.id, stock_location_id: INVENTORY_LOCATION_FIXTURE.id },
        ],
        items: [{ id: TRACKED_ITEM_FIXTURE.id, sku: TRACKED_ITEM_FIXTURE.sku, name: TRACKED_ITEM_FIXTURE.name, unit_cost: TRACKED_ITEM_FIXTURE.unit_cost }],
      },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(txJobLineFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ job_id: JOB_FIXTURE.id, stock_status: 'SYNCED' }),
    }));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(2);
    const first = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(first.type).toBe('return');
    expect(first.qty).toBe(2);
    expect(first.job_id).toBe(JOB_FIXTURE.id);
    expect(first.job_line_item_id).toBe('jli-0000-0000-0000-000000000001');
    expect(first.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
    expect(first.reference).toBe('J00001 cancelled');
    // Fractional Decimal qty passes through unrounded (QA-207).
    expect(mockPrisma.stockMovement.create.mock.calls[1][0].data.qty).toBe(1.5);
    // Post-return restamp: ledger and pills agree; cancel is terminal so UNSYNCED can never
    // silently re-deduct (sync-stock refuses CANCELLED jobs).
    expect(txJobLineUpdateMany).toHaveBeenCalledWith({
      where: { job_id: JOB_FIXTURE.id, stock_status: 'SYNCED' },
      data: { stock_status: 'UNSYNCED' },
    });
  });

  it('returns invoice-BORN synced lines of a cascade-voided invoice and restamps them (§4.2)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      invoices: [{
        id: 'inv-open-1',
        status: 'SENT',
        kind: 'STANDARD',
        amount_due: 100,
        total_amount: 100,
        payments: [],
        refunds: [],
      }],
    });
    mockPrisma.stockMovement.create.mockResolvedValue({});
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 8 });
    const { txInvLineFindMany, txInvLineUpdateMany, txJobLineUpdateMany } = wireCancelTx(
      { ...JOB_FIXTURE, status: 'CANCELLED' },
      {
        invoiceSyncedLines: [
          { id: 'ivl-0000-0000-0000-000000000001', quantity: 3, price_book_item_id: TRACKED_ITEM_FIXTURE.id, stock_location_id: INVENTORY_LOCATION_FIXTURE.id },
        ],
        items: [{ id: TRACKED_ITEM_FIXTURE.id, sku: TRACKED_ITEM_FIXTURE.sku, name: TRACKED_ITEM_FIXTURE.name, unit_cost: TRACKED_ITEM_FIXTURE.unit_cost }],
      },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    // Scope rule: only the voided invoice's SYNCED (= invoice-born) lines are candidates —
    // job-copied lines are NOT_TRACKED by §5.2 construction and stay silent.
    expect(txInvLineFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ invoice_id: 'inv-open-1', stock_status: 'SYNCED' }),
    }));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(3);
    expect(movement.job_id).toBe(JOB_FIXTURE.id);
    expect(movement.invoice_line_item_id).toBe('ivl-0000-0000-0000-000000000001');
    expect(movement.job_line_item_id).toBeNull();
    expect(movement.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
    expect(movement.reference).toBe('J00001 cancelled — invoice voided');
    expect(txInvLineUpdateMany).toHaveBeenCalledWith({
      where: { invoice_id: 'inv-open-1', stock_status: 'SYNCED' },
      data: { stock_status: 'UNSYNCED' },
    });
    // No SYNCED job lines in this scenario ⇒ the job-line restamp never fires.
    expect(txJobLineUpdateMany).not.toHaveBeenCalled();
  });

  it('excludes synthetic DEPOSIT-CREDIT payments from collected_total → 0, no refund suggested', async () => {
    // A STANDARD invoice whose ONLY payment is the synthetic deposit-credit transfer (a non-cash
    // credit, not new money). The real deposit cash lives on a separate estimate-anchored invoice
    // (job_id=null), so this credit row must NOT inflate the surfaced collected total.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      invoices: [
        {
          id: 'inv-credit-only',
          status: 'SENT',
          kind: 'STANDARD',
          amount_due: 0,
          total_amount: 300,
          payments: [{ amount: 300, reference_number: 'DEPOSIT-CREDIT' }],
          refunds: [],
        },
      ],
    });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.collected_total).toBe(0);
    expect(res.body.refund_suggested).toBe(false);
  });

  it('counts only the real payment when a STANDARD invoice mixes real cash + a deposit credit', async () => {
    // $200 real cash + $300 deposit-credit transfer → collected_total surfaces the $200 real cash.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      invoices: [
        {
          id: 'inv-mixed',
          status: 'SENT',
          kind: 'STANDARD',
          amount_due: 500,
          total_amount: 1000,
          payments: [
            { amount: 200, reference_number: null },
            { amount: 300, reference_number: 'DEPOSIT-CREDIT' },
          ],
          refunds: [],
        },
      ],
    });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.collected_total).toBe(200);
    expect(res.body.refund_suggested).toBe(true);
  });

  it('returns 400 if cancelled_reason is empty', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: '' });

    expect(res.status).toBe(400);
  });

  it('allows cancelling an already-COMPLETED job (cancellation is not terminal, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', invoices: [] });
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Error' });

    expect(res.status).toBe(200);
  });
});

// ─── POST /api/jobs/:id/reopen ─────────────────────────

describe('POST /api/jobs/:id/reopen', () => {
  it('admin reopens a COMPLETED job with no issued invoice → 200, IN_PROGRESS', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', invoices: [] });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('IN_PROGRESS');
    expect(mockPrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS', completed_at: null }) }),
    );
  });

  it('a DRAFT invoice does NOT block reopen', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', invoices: [{ status: 'DRAFT' }] });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('a VOIDED invoice does NOT block reopen', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', invoices: [{ status: 'VOIDED' }] });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('allows reopening even when an issued (SENT) invoice exists — job/invoice state are independent, Spec B1', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', invoices: [{ status: 'SENT' }] });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('allows reopening a job that is not COMPLETED (free status transitions, Spec B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', invoices: [] });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('returns 404 when the job is not found', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-admin (dispatcher)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(403);
  });

  it('returns 403 for a technician', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ─── POST /api/jobs/:id/status (SRVW-87) ───────────────
//
// One door that takes a target status and DISPATCHES into the existing verb handler, so every
// milestone stamp, timeline event, notification emit and automation dispatch still fires. It
// writes no status of its own.

describe('POST /api/jobs/:id/status', () => {
  const COMPLETED_ROW = {
    ...JOB_FIXTURE,
    status: 'COMPLETED',
    ...withCrew([]),
    source_plan_id: null,
    scheduled_start: new Date('2026-09-01T09:00:00Z'),
    on_site_at: new Date('2026-09-01T09:05:00Z'),
    started_at: new Date('2026-09-01T09:10:00Z'),
    completed_at: new Date('2026-09-01T10:45:00Z'),
  };

  // assign() writes through a transaction; mirror the wiring the /assign tests use.
  function wireAssignTx(updated: unknown) {
    mockPrisma.job.findMany.mockResolvedValue([]);
    const txJobUpdate = vi.fn().mockResolvedValue(updated);
    const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so these fakes
        // hold one - a job with no trip at all cannot hold crew and 400s by design (see
        // visit-crew.test.ts, which pins that case deliberately).
        visit: {
          findMany: vi.fn().mockResolvedValue([FIXTURE_CURRENT_VISIT]),
          create: vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT),
          update: vi.fn().mockResolvedValue(FIXTURE_CURRENT_VISIT),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
        // transaction, so the union it writes can never evict someone off another visit. Without
        // this delegate the read throws inside the tx and the route 500s opaquely.
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([{ user_id: TEST_USERS.technician.id }]),
          createMany: txJobAssigneeCreateMany,
          deleteMany: txJobAssigneeDeleteMany,
        },
        job: { update: txJobUpdate },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );
    return { txJobUpdate, txJobAssigneeCreateMany, txJobAssigneeDeleteMany };
  }

  afterEach(() => {
    mockPrisma.job.findMany.mockReset();
  });

  it('routes status=COMPLETED into complete()', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', ...withCrew([]), source_plan_id: null,
      started_at: new Date('2026-09-01T09:10:00Z'),
    });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    let captured: any;
    mockPrisma.job.update.mockImplementation((args: any) => {
      captured = args;
      return Promise.resolve({ ...JOB_FIXTURE, status: 'COMPLETED' });
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'COMPLETED', completion_notes: 'done' });

    expect(res.status).toBe(200);
    // Proof it went THROUGH complete() rather than writing status itself: the completed_at
    // stamp and the completion_notes are complete()'s work, not the dispatcher's.
    expect(captured.data.status).toBe('COMPLETED');
    expect(captured.data.completed_at).toBeInstanceOf(Date);
    expect(captured.data.completion_notes).toBe('done');
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'COMPLETED' }) }),
    );
  });

  it('403s when the caller lacks the target verb ability', async () => {
    clearPermissionCache();
    mockAuthAs('dispatcher');
    // Holds `read Job` (so the route gate passes) but NOT `cancel Job`.
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && !(g.action === 'cancel' && g.subject === 'Job')),
    );
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, ...withCrew([]), invoices: [] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('dispatcher'))
      .send({ status: 'CANCELLED', cancelled_reason: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('400s when SCHEDULED is requested with no window on the body, even though the job has one', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'UNSCHEDULED', ...withCrew([]),
      scheduled_start: new Date('2026-09-01T09:00:00Z'),
      scheduled_end: new Date('2026-09-01T11:00:00Z'),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SCHEDULED' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { field: string }) => d.field === 'scheduled_start')).toBe(true);
  });

  // The dangerous shape. If SCHEDULED inherited the job's own window, this body - which reads
  // like a label change - would reach assign()'s milestoneClears('scheduled') and null
  // completed_at/on_site_at/started_at, plus revert the linked PlanVisit. It must not.
  it('refuses to un-complete a COMPLETED job through a bare status=SCHEDULED body', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(COMPLETED_ROW);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SCHEDULED' });

    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // The deliberate other half: with an EXPLICIT window that actually MOVES the job this is
  // byte-identical to POST /:id/assign with the same body, milestone rewind included. That is
  // Spec B1's documented backward-move policy, not new capability - locked here so a later reader
  // does not "fix" it as a bug.
  //
  // #1626: the window below has to differ from COMPLETED_ROW's own (withCrew's stub trip sits at
  // 2026-10-01T09:00), because a RESTATEMENT of the stored window is no longer a move at all -
  // see the sibling test underneath. This test used to send exactly that stub instant and so
  // proved the rewind only by accident of the fixture.
  it('an EXPLICIT window that MOVES a COMPLETED job rewinds milestones exactly like POST /assign', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(COMPLETED_ROW);
    const { txJobUpdate } = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({
        status: 'SCHEDULED',
        scheduled_start: '2026-10-08T09:00:00.000Z',
        scheduled_end: '2026-10-08T11:00:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(txJobUpdate.mock.calls[0][0].data.status).toBe('SCHEDULED');
    expect(txJobUpdate.mock.calls[0][0].data.completed_at).toBeNull();
  });

  // #1626, through the OTHER door onto assign(): /status hands its body straight to assign(), so
  // the restatement rule has to hold here too or the guarantee is one route wide.
  it('an EXPLICIT window that RESTATES a COMPLETED job current window leaves it COMPLETED', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(COMPLETED_ROW);
    const { txJobUpdate } = wireAssignTx({ ...JOB_FIXTURE, status: 'COMPLETED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({
        status: 'SCHEDULED',
        // COMPLETED_ROW's own stub trip, to the second.
        scheduled_start: '2026-10-01T09:00:00.000Z',
        scheduled_end: '2026-10-01T11:00:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(txJobUpdate.mock.calls[0][0].data.status).toBe('COMPLETED');
    expect(txJobUpdate.mock.calls[0][0].data).not.toHaveProperty('completed_at');
  });

  it('SCHEDULED without assignee_ids preserves the job current crew', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'UNSCHEDULED',
      ...withCrew([TEST_USERS.technician.id]),
      source_plan_id: null,
    });
    const { txJobAssigneeDeleteMany } = wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({
        status: 'SCHEDULED',
        scheduled_start: '2026-10-01T09:00:00.000Z',
        scheduled_end: '2026-10-01T11:00:00.000Z',
      });

    expect(res.status).toBe(200);
    // assignee_ids is REPLACE semantics: defaulting it to [] would have removed the technician.
    expect(txJobAssigneeDeleteMany).not.toHaveBeenCalled();
    // validateCrew resolves every assignee_id, so a non-empty default is visible here.
    const lookedUpIds = (prisma.user.findUnique as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[0].where.id);
    expect(lookedUpIds).toContain(TEST_USERS.technician.id);
  });
});

// JobCharge is removed (entity-redesign §5 / Phase D): the invoice owns its lines
// (InvoiceLineItem). The /:id/charges routes no longer exist.

// ─── Notes ─────────────────────────────────────────────

describe('GET /api/jobs/:id/notes', () => {
  it('admin can get job notes', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([{
      id: 'n1',
      content: 'Note content',
      created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    }]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it('TECHNICIAN can get notes for own job (crew membership)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, ...withCrew([TEST_USERS.technician.id]) });
    // GAP-1 — getNotes now gates via canAccessRow (scoped findFirst); tech owns the job → matches.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.note.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });

  it('SALES can read notes (read-only, lead owner M2M)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } });
    // GAP-1 — getNotes now gates via canAccessRow (scoped findFirst); SALES owns the parent lead.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.note.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });
});

describe('GET /api/jobs/:id/notes?include_lead=true', () => {
  it('job notes include the originating lead\'s notes when include_lead=true', async () => {
    mockAuthAs('admin');
    // Access-check job
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // First note.findMany: JOB notes; Second: LEAD notes
    mockPrisma.note.findMany
      .mockResolvedValueOnce([
        {
          id: 'n-job-1',
          content: 'Job note',
          created_at: new Date('2026-01-25'),
          creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'n-wt-1',
          content: 'Walkthrough note',
          created_at: new Date('2026-01-20'),
          creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
        },
      ]);
    // Job lookup for lead_id — the direct pointer wins over the estimate hop.
    mockPrisma.job.findFirst.mockResolvedValue({
      lead_id: LEAD_FIXTURE.id,
      estimate: { lead_id: LEAD_FIXTURE.id },
    });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const sources = res.body.notes.map((n: { source: string }) => n.source);
    expect(sources).toContain('JOB');
    expect(sources).toContain('LEAD');
    expect(res.body.notes).toHaveLength(2);
    // Second note.findMany must have queried LEAD entity (parity with the attachment test)
    const secondNoteCall = mockPrisma.note.findMany.mock.calls[1][0];
    expect(secondNoteCall.where.entity_type).toBe('LEAD');
    expect(secondNoteCall.where.entity_id).toBe(LEAD_FIXTURE.id);
  });

  it('job notes backward-compat: no source key without include_lead', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValueOnce([
      {
        id: 'n-job-1',
        content: 'Job note',
        created_at: new Date('2026-01-25'),
        creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
      },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    // No source key
    expect(res.body.notes[0]).not.toHaveProperty('source');
    // Only one note.findMany call
    expect(mockPrisma.note.findMany.mock.calls).toHaveLength(1);
  });

  it('job notes: only job notes when the job has no lead at all', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, estimate_id: null, estimate: null });
    mockPrisma.note.findMany.mockResolvedValueOnce([]);
    // A from-scratch job: neither the direct pointer nor the estimate hop resolves.
    mockPrisma.job.findFirst.mockResolvedValue({ lead_id: null, estimate: null });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Only one note.findMany call (no lead lookup)
    expect(mockPrisma.note.findMany.mock.calls).toHaveLength(1);
  });

  it('job notes resolve the lead via Job.lead_id when the job has no estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, estimate_id: null, estimate: null });
    mockPrisma.note.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'n-lead-1',
          content: 'Lead note',
          created_at: new Date('2026-01-20'),
          creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
        },
      ]);
    // A multi-estimate job carries no estimate_id; lead_id still points home.
    mockPrisma.job.findFirst.mockResolvedValue({ lead_id: LEAD_FIXTURE.id, estimate: null });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: { source: string }) => n.source)).toEqual(['LEAD']);
  });
});

describe('POST /api/jobs/:id/notes', () => {
  it('admin can add note', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.note.create.mockResolvedValue({
      id: 'n1',
      content: 'New note',
      created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'New note' });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('New note');
  });

  it('SALES cannot add notes (403)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'Note' });

    expect(res.status).toBe(403);
  });
});

// ─── Timeline ──────────────────────────────────────────

describe('GET /api/jobs/:id/timeline', () => {
  it('admin can get timeline', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    // Spec B2 N6 — getTimeline now widens to this job's invoice events for a pricing-capable
    // requester (admin); no invoices on this job for this test.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([{
      id: 'e1',
      event_type: 'CREATED',
      description: 'Job created',
      metadata: null,
      created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    }]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/timeline`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  it('SALES can access timeline (lead owner M2M)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } });
    // GAP-1 — getTimeline now gates via canAccessRow (scoped findFirst); SALES owns the parent lead.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // Spec B2 N6 — SALES can see pricing (read Invoice), so getTimeline also queries this job's
    // invoices; none here.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/timeline`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });
});

// ─── Auth ──────────────────────────────────────────────

describe('Authentication checks', () => {
  it('GET /api/jobs returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
  });

  it('POST /api/jobs returns 401 unauthenticated', async () => {
    const res = await request(app).post('/api/jobs').send({ estimate_id: 'test' });
    expect(res.status).toBe(401);
  });

  it('GET /api/jobs/:id returns 401 unauthenticated', async () => {
    const res = await request(app).get(`/api/jobs/${JOB_FIXTURE.id}`);
    expect(res.status).toBe(401);
  });

  it('GET /api/jobs/stats returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/jobs/stats');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/jobs/stats ───────────────────────────────

describe('GET /api/jobs/stats', () => {
  it('returns counts per status', async () => {
    mockAuthAs('admin');
    mockPrisma.job.count
      .mockResolvedValueOnce(2)   // unassigned
      .mockResolvedValueOnce(3)   // scheduled
      .mockResolvedValueOnce(1)   // in_progress
      .mockResolvedValueOnce(10)  // completed
      .mockResolvedValueOnce(0);  // cancelled

    const res = await request(app).get('/api/jobs/stats').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      unassigned: 2,
      scheduled: 3,
      in_progress: 1, // S4 (D17): nothing left to fold in - EN_ROUTE/ON_SITE are VisitStatus now
      completed: 10,
      cancelled: 0,
    });
  });

  it('SALES passes route guard for stats (CASL conditional read Job)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const res = await request(app).get('/api/jobs/stats').set(authHeader('sales'));
    // SALES has conditional read Job grant — route guard passes.
    // Record-level enforcement (Task 11) will scope to own jobs.
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/jobs/:id/tags (polymorphic tag_assignments) ─────
// A well-formed uuid, NOT JOB_FIXTURE.id: that shared fixture is `j0000000-…` and `j` is not a
// hex digit, so it is not a valid uuid at all. The tag routes now reject a malformed `:id`
// before the controller runs (a real Postgres uuid column would throw P2023 on it), so these
// cases need an id that could actually exist. The job row is mocked; the value only has to parse.
const TAGGABLE_JOB_ID = 'ab000000-0000-0000-0000-000000000001';

describe('POST /api/jobs/:id/tags', () => {
  const TAG_ID = 'a0000000-0000-0000-0000-000000000001';

  it('attaches existing tag to a job by tag_id', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: TAGGABLE_JOB_ID });
    mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_ID, name: 'Urgent', color: '#EF4444' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: TAG_ID, entity_type: 'JOB', entity_id: TAGGABLE_JOB_ID });
    mockPrisma.tag.findUnique.mockResolvedValue({ id: TAG_ID, name: 'Urgent', color: '#EF4444' });

    const res = await request(app)
      .post(`/api/jobs/${TAGGABLE_JOB_ID}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_ID });

    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe('Urgent');
    expect(mockPrisma.tagAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tag_id: TAG_ID,
        entity_type: 'JOB',
        entity_id: TAGGABLE_JOB_ID,
      }),
    });
  });

  it('returns 409 if tag is already attached to the job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: TAGGABLE_JOB_ID });
    mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_ID, name: 'Urgent', color: '#EF4444' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_ID, entity_type: 'JOB', entity_id: TAGGABLE_JOB_ID });

    const res = await request(app)
      .post(`/api/jobs/${TAGGABLE_JOB_ID}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_ID });

    expect(res.status).toBe(409);
  });

  it('returns 404 when job not found in caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${TAGGABLE_JOB_ID}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_ID });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/jobs/:id/tags/:tagId', () => {
  const TAG_ID = 'a0000000-0000-0000-0000-000000000001';

  it('detaches a tag from a job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: TAGGABLE_JOB_ID });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_ID, entity_type: 'JOB', entity_id: TAGGABLE_JOB_ID });
    mockPrisma.tagAssignment.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/jobs/${TAGGABLE_JOB_ID}/tags/${TAG_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('returns 404 when the assignment is not present', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: TAGGABLE_JOB_ID });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/jobs/${TAGGABLE_JOB_ID}/tags/${TAG_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/jobs/export ──────────────────────────────

describe('GET /api/jobs/export', () => {
  it('returns all matching rows under the {jobs} envelope, unpaginated', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([JOB_FIXTURE]);

    const res = await request(app).get('/api/jobs/export').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    const args = mockPrisma.job.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
  });

  it('applies the status filter just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export?status=SCHEDULED').set(authHeader('admin'));

    expect(mockPrisma.job.findMany.mock.calls[0][0].where.status).toBe('SCHEDULED');
  });

  it('applies the exclude_plan_visits branch just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export?exclude_plan_visits=true').set(authHeader('admin'));

    expect(mockPrisma.job.findMany.mock.calls[0][0].where.source_plan_id).toBeNull();
  });

  it('scopes export to a TECHNICIAN\'s own jobs (row-scope respected)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export').set(authHeader('technician'));

    expect(mockPrisma.job.findMany.mock.calls[0][0].where.OR).toEqual([
      { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } },
      { created_by_id: TEST_USERS.technician.id },
    ]);
  });

  // JOB-B1 — unpaginated, capped at the defensive 50k row limit (NOT the list page size).
  it('is unpaginated with the defensive take: 50_000 cap (no skip)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export').set(authHeader('admin'));

    const args = mockPrisma.job.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(50_000);
  });

  // JOB-B3 — tenant isolation: the export where is org-scoped (tenantWhere) so cross-org rows
  // can never be returned.
  it('scopes the export to the requesting org (tenant isolation)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export').set(authHeader('admin'));

    expect(mockPrisma.job.findMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  // JOB-B5 — auth gate: an unauthenticated export request is rejected before the controller runs.
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/jobs/export');
    expect(res.status).toBe(401);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
  });

  // JOB-B6 — select parity: the export uses the SAME select as list() so every CSV column is
  // populated. Compare the select object the two handlers pass to findMany for the same query.
  it('uses the identical select as the list (column parity)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    await request(app).get('/api/jobs').set(authHeader('admin'));
    const listSelect = mockPrisma.job.findMany.mock.calls[0][0].select;

    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.job.findMany.mockResolvedValue([]);

    await request(app).get('/api/jobs/export').set(authHeader('admin'));
    const exportSelect = mockPrisma.job.findMany.mock.calls[0][0].select;

    expect(exportSelect).toEqual(listSelect);
  });
});

// ─── GET /api/jobs/:id/financials ──────────────────────

describe('GET /api/jobs/:id/financials', () => {
  const DEPOSIT_INVOICE = {
    id: 'inv-dep-1',
    invoice_number: 'I00001',
    kind: 'DEPOSIT',
    status: 'PAID',
    total_amount: '500',
    amount_due: '0',
    sent_at: new Date('2026-01-20'),
    paid_at: new Date('2026-01-21'),
    voided_at: null,
    payments: [
      {
        id: 'pay-1',
        amount: '500',
        method: 'CARD',
        paid_at: new Date('2026-01-21'),
        voided_at: null,
        reference_number: 'ch_dep',
      },
    ],
  };

  const FINAL_INVOICE = {
    id: 'inv-final-1',
    invoice_number: 'I00002',
    kind: 'STANDARD',
    status: 'SENT',
    total_amount: '1000',
    amount_due: '500',
    sent_at: new Date('2026-02-01'),
    paid_at: null,
    voided_at: null,
    payments: [
      {
        id: 'pay-2',
        amount: '200',
        method: 'CHECK',
        paid_at: new Date('2026-02-02'),
        voided_at: null,
        reference_number: 'CHK-100',
      },
    ],
  };

  it('financials returns deposit (via estimate) + final (via job_id) invoices and their payments', async () => {
    mockAuthAs('admin');
    // Access-check: admin always passes canAccessJob; estimate_id must be non-null for the OR clause
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: JOB_FIXTURE.estimate_id,
      ...withCrew([]),
      estimate: { lead: { lead_assignees: [] } },
    });
    let capturedInvoiceFindManyArgs: any;
    mockPrisma.invoice.findMany.mockImplementation((args: any) => {
      capturedInvoiceFindManyArgs = args;
      return Promise.resolve([DEPOSIT_INVOICE, FINAL_INVOICE]);
    });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    // Verify tenant-scoped OR clause covers both job_id and estimate_id
    const where = capturedInvoiceFindManyArgs.where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.OR).toEqual(expect.arrayContaining([
      { job_id: JOB_FIXTURE.id },
      { estimate_id: JOB_FIXTURE.estimate_id },
    ]));

    // final_invoice is the STANDARD non-voided one
    expect(res.body.final_invoice).not.toBeNull();
    expect(res.body.final_invoice.id).toBe(FINAL_INVOICE.id);

    // payments from both invoices, with invoice_kind attached
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(res.body.payments).toHaveLength(2);
    const depositPayment = res.body.payments.find((p: any) => p.invoice_kind === 'DEPOSIT');
    const finalPayment = res.body.payments.find((p: any) => p.invoice_kind === 'STANDARD');
    expect(depositPayment).toBeDefined();
    expect(finalPayment).toBeDefined();
    expect(depositPayment.invoice_number).toBe(DEPOSIT_INVOICE.invoice_number);
    expect(finalPayment.invoice_number).toBe(FINAL_INVOICE.invoice_number);

    // invoices array returned (without voided_at exposed)
    expect(Array.isArray(res.body.invoices)).toBe(true);
    expect(res.body.invoices).toHaveLength(2);
  });

  // ── Task 3.4 (spec §7.3): per-payment fee breakdown ──
  // The financials payments select must request the reconciled fee columns AND the manual
  // pick-list rebuild (payments.flatMap(...).map(...)) must carry them through — that hand-built
  // object is the easiest place for a new column to get silently dropped.
  it('financials serializes the fee breakdown for a reconciled CARD payment', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: JOB_FIXTURE.estimate_id,
      ...withCrew([]),
      estimate: { lead: { lead_assignees: [] } },
    });
    const reconciledDeposit = {
      ...DEPOSIT_INVOICE,
      payments: [
        {
          ...DEPOSIT_INVOICE.payments[0],
          stripe_fee_amount: '14.75',
          platform_fee_amount: '2.50',
          net_amount: '482.75',
        },
      ],
    };
    let capturedArgs: any;
    mockPrisma.invoice.findMany.mockImplementation((args: any) => {
      capturedArgs = args;
      return Promise.resolve([reconciledDeposit]);
    });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(capturedArgs.select.payments.select).toEqual(
      expect.objectContaining({
        stripe_fee_amount: true,
        platform_fee_amount: true,
        net_amount: true,
      }),
    );
    const payment = res.body.payments[0];
    expect(payment.stripe_fee_amount).toBe('14.75');
    expect(payment.platform_fee_amount).toBe('2.50');
    expect(payment.net_amount).toBe('482.75');
  });

  // net_amount is derived from Stripe's charge.amount — face + service fee + tip — while
  // Payment.amount is the face value only (D1/D10). PaymentsTab renders both through
  // PaymentFeeBreakdown, so without these two columns its Gross/-fees/Net column shows a Net
  // larger than the Gross above it, with nothing on screen accounting for the difference.
  it('financials serializes the service fee and tip so the PaymentsTab fee column adds up', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: JOB_FIXTURE.estimate_id,
      ...withCrew([]),
      estimate: { lead: { lead_assignees: [] } },
    });
    // Live staging row (payment 8b17c520-…, 2026-08-04): 533.13 face + 18.66 fee + 80.00 tip
    // = 631.79 charged; 631.79 − 20.98 − 2.36 = 608.45 landed.
    const feeBearingDeposit = {
      ...DEPOSIT_INVOICE,
      payments: [
        {
          ...DEPOSIT_INVOICE.payments[0],
          amount: '533.13',
          stripe_fee_amount: '20.98',
          platform_fee_amount: '2.36',
          net_amount: '608.45',
          service_fee_amount: '18.66',
          tip_amount: '80.00',
        },
      ],
    };
    let capturedArgs: any;
    mockPrisma.invoice.findMany.mockImplementation((args: any) => {
      capturedArgs = args;
      return Promise.resolve([feeBearingDeposit]);
    });

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(capturedArgs.select.payments.select).toEqual(
      expect.objectContaining({ service_fee_amount: true, tip_amount: true }),
    );
    const payment = res.body.payments[0];
    expect(payment.service_fee_amount).toBe('18.66');
    expect(payment.tip_amount).toBe('80.00');
  });

  it('financials with no estimate_id only queries by job_id (no estimate clause)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: null,
      ...withCrew([]),
      estimate: null,
    });
    let capturedArgs: any;
    mockPrisma.invoice.findMany.mockImplementation((args: any) => {
      capturedArgs = args;
      return Promise.resolve([FINAL_INVOICE]);
    });

    const res = await request(app)
      .get(`/api/jobs/${STANDALONE_JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // OR should only contain {job_id}, no estimate_id clause
    expect(capturedArgs.where.OR).toHaveLength(1);
    expect(capturedArgs.where.OR).toEqual([{ job_id: STANDALONE_JOB_FIXTURE.id }]);
  });

  it('voided STANDARD invoice is excluded from final_invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: null,
      ...withCrew([]),
      estimate: null,
    });
    mockPrisma.invoice.findMany.mockResolvedValue([
      { ...FINAL_INVOICE, voided_at: new Date('2026-02-10') },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${STANDALONE_JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.final_invoice).toBeNull();
  });

  it('returns 404 when job not found (tenant scoped)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/jobs/nonexistent-id/financials')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 when TECHNICIAN is not on the job crew', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: null,
      ...withCrew(['other-tech-id']),
      estimate: null,
    });
    // Ownership is now gated by canAccessRow (grant-driven scoped findFirst), not the loaded
    // row's assignees. A tech who doesn't own the job → the scoped lookup misses → 403.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/financials`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get(`/api/jobs/${JOB_FIXTURE.id}/financials`);
    expect(res.status).toBe(401);
  });

  it('B8: active STANDARD invoice carries tip, tax_rate, discount_amount, subtotal and line_items[]', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      estimate_id: null,
      ...withCrew([]),
      estimate: null,
    });

    const LINE_ITEM = {
      id: 'line-1',
      sequence: 1,
      description: 'Service call',
      quantity: 2,
      unit_price: '150.00',
      is_taxable: true,
      line_total: '300.00',
      discount_type: null,
      discount_value: null,
      discount_amount: '0.00',
      item_type: 'SERVICE',
      price_book_item_id: null,
    };

    const INVOICE_WITH_LINES = {
      id: 'inv-final-2',
      invoice_number: 'I00010',
      kind: 'STANDARD',
      status: 'DRAFT',
      total_amount: '324.00',
      amount_due: '324.00',
      sent_at: null,
      paid_at: null,
      voided_at: null,
      tip: '0.00',
      tax_rate: '0.08',
      discount_amount: '0.00',
      subtotal: '300.00',
      line_items: [LINE_ITEM],
      payments: [],
    };

    let capturedSelect: any;
    mockPrisma.invoice.findMany.mockImplementation((args: any) => {
      capturedSelect = args.select;
      return Promise.resolve([INVOICE_WITH_LINES]);
    });

    const res = await request(app)
      .get(`/api/jobs/${STANDALONE_JOB_FIXTURE.id}/financials`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    // Assert the Prisma select includes the new scalar fields
    expect(capturedSelect).toHaveProperty('tip', true);
    expect(capturedSelect).toHaveProperty('tax_rate', true);
    expect(capturedSelect).toHaveProperty('discount_amount', true);
    expect(capturedSelect).toHaveProperty('subtotal', true);

    // Assert line_items nested select is present with orderBy
    expect(capturedSelect).toHaveProperty('line_items');
    const liSelect = capturedSelect.line_items;
    expect(liSelect).toHaveProperty('orderBy');
    expect(liSelect.orderBy).toEqual({ sequence: 'asc' });
    expect(liSelect).toHaveProperty('select');
    const liFields = liSelect.select;
    expect(liFields).toHaveProperty('id', true);
    expect(liFields).toHaveProperty('sequence', true);
    expect(liFields).toHaveProperty('description', true);
    expect(liFields).toHaveProperty('quantity', true);
    expect(liFields).toHaveProperty('unit_price', true);
    expect(liFields).toHaveProperty('is_taxable', true);
    expect(liFields).toHaveProperty('line_total', true);
    expect(liFields).toHaveProperty('discount_type', true);
    expect(liFields).toHaveProperty('discount_value', true);
    expect(liFields).toHaveProperty('discount_amount', true);
    expect(liFields).toHaveProperty('item_type', true);
    expect(liFields).toHaveProperty('price_book_item_id', true);

    // The response body passes the new fields through
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];
    expect(inv).toHaveProperty('tip');
    expect(inv).toHaveProperty('tax_rate');
    expect(inv).toHaveProperty('discount_amount');
    expect(inv).toHaveProperty('subtotal');
    expect(Array.isArray(inv.line_items)).toBe(true);
    expect(inv.line_items).toHaveLength(1);
    const li = inv.line_items[0];
    expect(li.id).toBe('line-1');
    expect(li.sequence).toBe(1);
    expect(li.description).toBe('Service call');
    expect(li.quantity).toBe(2);
    expect(li).toHaveProperty('unit_price');
    expect(li).toHaveProperty('is_taxable');
    expect(li).toHaveProperty('line_total');
    expect(li).toHaveProperty('discount_type');
    expect(li).toHaveProperty('discount_value');
    expect(li).toHaveProperty('discount_amount');
    expect(li).toHaveProperty('item_type');
    expect(li).toHaveProperty('price_book_item_id');
  });
});

// ─── POST /api/jobs/:id/duplicate ──────────────────────
describe('POST /api/jobs/:id/duplicate', () => {
  const SOURCE_JOB = {
    id: JOB_FIXTURE.id,
    job_number: JOB_FIXTURE.job_number,
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    scope_notes: 'X',
    job_type: 'HVAC Install',
    estimated_duration: 120,
    ...withCrew([]),
    estimate: null,
  };

  it('duplicates a job into a fresh UNSCHEDULED job copying customer/location/scope/job_type', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(SOURCE_JOB);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return STANDALONE_JOB_FIXTURE;
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
    expect(capturedData.status).toBe('UNSCHEDULED');
    expect(capturedData.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(capturedData.job_type).toBe('HVAC Install');
    expect(capturedData.scope_notes).toBe('X');
    expect(capturedData.estimate_id).toBeUndefined();
    // job-owns-tax-discount (E1/E2) - a duplicate is a fresh standalone job: no service_location
    // relation loaded here ⇒ taxRateForState short-circuits to 0 without a DB round trip, and
    // discount is never copied (schema default).
    expect(capturedData.tax_rate).toBe(0);
    expect(capturedData.discount_type).toBeUndefined();
  });

  it("stamps tax_rate from the source job's service location, not copied from the source job", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({
      ...SOURCE_JOB,
      service_location: { state: 'TX' },
    });

    let capturedData: any;
    const txStateTaxRateFindFirst = vi.fn().mockResolvedValue({ tax_rate: 0.0625 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return STANDALONE_JOB_FIXTURE;
          }),
        },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: txStateTaxRateFindFirst },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
        // transaction, so the tx fake has to answer the visit + org delegates.
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    expect(capturedData.tax_rate).toBe(0.0625);
    expect(txStateTaxRateFindFirst).toHaveBeenCalledWith({ where: { state_code: 'TX' } });
  });

  it('returns 404 when job not found in org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});
