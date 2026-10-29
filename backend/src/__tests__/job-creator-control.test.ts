/**
 * PR 3 of the technician-ownership spec
 * (md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md).
 *
 * THE RULE: creation confers control. A user who creates a job has full control over it -
 * permanently, even after a dispatcher reassigns the work away from them. The rule only ever ADDS
 * access; higher-tier roles reach the same rows through their own org-wide grants.
 *
 * This file drives the rule through the ROUTES, not through the ability object, because the ability
 * object was never the thing that was wrong: `canDo(action,'Job')` is subject-level, and the
 * per-instance checks in the controllers were all keyed on the READ scope. With `read Job` widened
 * to "assigned OR created by me", a read-scoped per-instance check would have handed every assigned
 * technician the creator's whole surface. Only a request can show that.
 *
 * The three principals below are the whole design:
 *
 *   ASSIGNED_JOB  - assigned to the technician, created by someone else. Money is READABLE
 *                   (`read Pricing`), notes/tags/verbs work, and every creator-only route is 403.
 *   CREATED_JOB   - created by the technician and NOT assigned to them. This is the permanence
 *                   property: full control survives being taken off the job.
 *   FOREIGN_JOB   - another technician's job, neither assigned nor created. Closed entirely.
 *
 * Prisma is mocked (setup.ts), so `job.findFirst` - the query every per-instance scope check runs -
 * is wired through `mockScopedFindFirst`, which really evaluates the `where` fragment against the
 * fixture. Without it the mock would answer "visible" to every fragment and none of these tests
 * could fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, TAG_FIXTURE, mockScopedFindFirst } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const mockPrisma = prisma as unknown as Record<string, any>;

// A well-formed uuid, NOT JOB_FIXTURE.id: that shared fixture is `j0000000-…` and `j` is not a
// hex digit, so it is not a valid uuid at all. The tag routes now reject a malformed `:id`
// before the controller runs (a real Postgres uuid column would throw P2023 on it), so these
// cases need an id that could actually exist. The job row is mocked; the value only has to parse.
const JOB_ID = 'ab000000-0000-0000-0000-000000000001';
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000001';
/** The job's one trip - the per-visit crew door (slice 02) addresses it by id. */
const VISIT_ID = 'e0000000-0000-0000-0000-0000000000f1';
const TECH_ID = TEST_USERS.technician.id;
const OTHER_TECH_ID = '99999999-9999-9999-9999-999999999999';
/** A tag that exists but is NOT yet on the job - see the tagAssignment fixture below. */
const UNATTACHED_TAG_ID = 'dd000000-0000-0000-0000-000000000009';

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    job_number: 'J00001',
    source_plan_id: null,
    customer_id: 'cust-1',
    created_by_id: OTHER_TECH_ID,
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    customer: { tax_exempt: false, id: 'cust-1', first_name: 'A', last_name: 'B', company_name: null, email: null, phone: null },
    visits: [{ assignees: [{ user_id: TECH_ID }] }],
    estimate: null,
    job_line_items: [
      { id: LINE_ID, description: 'Labor', quantity: 1, unit_price: 250, unit_cost: 100, markup_percent: 150, line_total: 250, is_taxable: true, sort_order: 0, stock_status: null },
    ],
    invoices: [],
    scopes: [{ id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null }],
    scheduled_start: null,
    scheduled_end: null,
    is_all_day: false,
    service_location: { state: 'CA' },
    ...over,
  };
}

/** The technician is on the crew; somebody else made the job. */
const ASSIGNED_JOB = () => jobRow();
/** The technician made the job and has since been taken OFF the crew. Permanence. */
const CREATED_JOB = () => jobRow({ created_by_id: TECH_ID, visits: [] });
/** Another technician's job entirely. */
const FOREIGN_JOB = () => jobRow({ created_by_id: OTHER_TECH_ID, visits: [{ assignees: [{ user_id: OTHER_TECH_ID }] }] });

/** Point every job read at one fixture and let the scope checks really run against it. */
function useJob(job: Record<string, any>) {
  // A FRESH COPY per read. `mockResolvedValue` hands back the same object reference every call, and
  // the scope handlers mutate the array they are given (addScope pushes onto it), so one request's
  // write leaked into the next request's fixture - which made the reorder route reject a stale id
  // list two requests later. Cloning keeps each request independent, the way separate requests are.
  mockPrisma.job.findUnique.mockImplementation(() => Promise.resolve(structuredClone(job)));
  // Really evaluates the scope fragment - without it the mock says "visible" to every where and
  // none of the refusals below could fail. See matchesScopeWhere in helpers.ts.
  mockScopedFindFirst(mockPrisma.job.findFirst, { ...job, organization_id: ALPHA_ORG_ID });
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.job.update.mockResolvedValue(job);
}

/** The REAL shipped defaults for the role - the grant table is the deliverable of this PR. */
function useDefaultTechnicianGrants() {
  setCachedGrants(
    ALPHA_ORG_ID,
    'TECHNICIAN',
    DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN').map(({ action, subject, conditions }) => ({
      action,
      subject,
      conditions: conditions ?? null,
    })) as never,
  );
}

type Route = { name: string; method: string; path: string; body?: Record<string, unknown> };

// Everything the creator controls and the assignee does not. One table, driven identically.
const CREATOR_ONLY: Route[] = [
  { name: 'POST   /:id/line-items',         method: 'post',   path: `/api/jobs/${JOB_ID}/line-items`,               body: { description: 'Labor', quantity: 1, unit_price: 100 } },
  { name: 'PATCH  /:id/line-items/reorder', method: 'patch',  path: `/api/jobs/${JOB_ID}/line-items/reorder`,       body: { order: [LINE_ID] } },
  { name: 'PATCH  /:id/line-items/:lineId', method: 'patch',  path: `/api/jobs/${JOB_ID}/line-items/${LINE_ID}`,    body: { quantity: 2 } },
  { name: 'DELETE /:id/line-items/:lineId', method: 'delete', path: `/api/jobs/${JOB_ID}/line-items/${LINE_ID}` },
  { name: 'POST   /:id/scopes',             method: 'post',   path: `/api/jobs/${JOB_ID}/scopes`,                   body: { title: 'Permit fee', flat_price: 300 } },
  { name: 'PATCH  /:id/scopes/reorder',     method: 'patch',  path: `/api/jobs/${JOB_ID}/scopes/reorder`,           body: { order: [SCOPE_ID] } },
  { name: 'PATCH  /:id/scopes/:idx',        method: 'patch',  path: `/api/jobs/${JOB_ID}/scopes/0`,                 body: { is_taxable: false } },
  { name: 'DELETE /:id/scopes/:idx',        method: 'delete', path: `/api/jobs/${JOB_ID}/scopes/0` },
  { name: 'POST   /:id/assign',             method: 'post',   path: `/api/jobs/${JOB_ID}/assign`,                   body: { assignee_ids: [TECH_ID] } },
  { name: 'POST   /:id/assignees',          method: 'post',   path: `/api/jobs/${JOB_ID}/assignees`,                body: { assignee_ids: [] } },
  // Slice 02: the per-visit twin of /assignees - the board's lane swap re-crews the DRAGGED trip
  // through it. Same `assign Job` gate, so it follows creation exactly as /assignees does.
  { name: 'POST   /:id/visits/:visitId/assignees', method: 'post', path: `/api/jobs/${JOB_ID}/visits/${VISIT_ID}/assignees`, body: { assignee_ids: [] } },
  { name: 'POST   /:id/dispatcher',         method: 'post',   path: `/api/jobs/${JOB_ID}/dispatcher`,               body: { dispatcher_id: null } },
  { name: 'POST   /:id/unassign',           method: 'post',   path: `/api/jobs/${JOB_ID}/unassign` },
  { name: 'DELETE /:id',                    method: 'delete', path: `/api/jobs/${JOB_ID}` },
];

// The assignee half: the work surface, which creation does not gate.
const ASSIGNEE_SURFACE: Route[] = [
  { name: 'GET    /:id/line-items',  method: 'get',    path: `/api/jobs/${JOB_ID}/line-items` },
  { name: 'POST   /:id/notes',       method: 'post',   path: `/api/jobs/${JOB_ID}/notes`,                  body: { content: 'called the customer' } },
  { name: 'POST   /:id/tags',        method: 'post',   path: `/api/jobs/${JOB_ID}/tags`,                   body: { tag_id: UNATTACHED_TAG_ID } },
  { name: 'DELETE /:id/tags/:tagId', method: 'delete', path: `/api/jobs/${JOB_ID}/tags/${TAG_FIXTURE.id}` },
  // POST /:id/complete left this list with multi-visit S4 (D15/D7a): closing the JOB stopped being
  // a technician role default, so a technician on the default grant set 403s here for a reason that
  // has nothing to do with creation. What a technician closes is their own VISIT.
  { name: 'POST   /:id/start',       method: 'post',   path: `/api/jobs/${JOB_ID}/start` },
  { name: 'POST   /:id/arrive',      method: 'post',   path: `/api/jobs/${JOB_ID}/arrive` },
];

function send(route: Route, user: 'admin' | 'dispatcher' | 'technician') {
  const req = (request(app) as any)[route.method](route.path).set(authHeader(user));
  return route.body === undefined ? req : req.send(route.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('technician');
  useDefaultTechnicianGrants();

  // Handler plumbing, deliberately complete. The authorization assertions below check for SUCCESS,
  // not merely for the absence of a 403 - a 500 from an unmocked write, or a 404 from a handler
  // that re-reads inside its transaction, would otherwise read as "not refused" and the positive
  // half of every creator claim would be vacuous. Review caught exactly that on five routes.
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mockPrisma) : Promise.all(arg as Promise<unknown>[]),
  );
  // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so the job needs one -
  // otherwise /assign and /assignees answer 400 (unexpressible) and the AUTHORIZATION question
  // these cases are actually asking never gets reached.
  mockPrisma.visit.findMany.mockResolvedValue([
    {
      id: VISIT_ID, job_id: JOB_ID, lead_id: null, visit_seq: 1,
      status: 'SCHEDULED', scheduled_at: new Date('2026-10-01T09:00:00.000Z'),
      scheduled_end: new Date('2026-10-01T11:00:00.000Z'), is_all_day: false,
      created_at: new Date('2026-09-01T00:00:00.000Z'),
      en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    },
  ]);
  // The per-visit crew door's own read of the trip it names (scoped to this job and tenant).
  mockPrisma.visit.findFirst.mockResolvedValue({
    id: VISIT_ID, status: 'SCHEDULED', scheduled_at: new Date('2026-10-01T09:00:00.000Z'), assignees: [],
  });
  mockPrisma.visitAssignee.findMany.mockResolvedValue([]);
  mockPrisma.visitAssignee.createMany?.mockResolvedValue?.({ count: 1 });
  mockPrisma.visitAssignee.deleteMany?.mockResolvedValue?.({ count: 0 });
  mockPrisma.jobLineItem.findMany.mockResolvedValue([]);
  mockPrisma.jobLineItem.create.mockResolvedValue({ id: LINE_ID, job_id: JOB_ID, sequence: 1 });
  mockPrisma.jobLineItem.update.mockResolvedValue({ id: LINE_ID, job_id: JOB_ID });
  mockPrisma.jobLineItem.updateMany?.mockResolvedValue?.({ count: 1 });
  mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.jobLineItem.aggregate?.mockResolvedValue?.({ _max: { sequence: 0 } });
  mockPrisma.tag.findFirst?.mockResolvedValue?.(TAG_FIXTURE);
  mockPrisma.tag.findUnique?.mockResolvedValue?.(TAG_FIXTURE);
  // Attach state is per-tag so BOTH tag routes can succeed in the same fixture: TAG_FIXTURE is
  // already on the job (DELETE has something to remove, else 404) while UNATTACHED_TAG_ID is not
  // (POST has something to add, else 409). Neither 4xx is an authorization result, and letting one
  // stand would have hidden the authorization answer behind a fixture gap.
  mockPrisma.tagAssignment.findUnique.mockImplementation(
    ({ where }: { where: { tag_id_entity_type_entity_id: { tag_id: string } } }) =>
      Promise.resolve(
        where.tag_id_entity_type_entity_id.tag_id === TAG_FIXTURE.id
          ? { tag_id: TAG_FIXTURE.id, entity_type: 'JOB', entity_id: JOB_ID }
          : null,
      ),
  );
  mockPrisma.tagAssignment.findMany?.mockResolvedValue?.([]);
  mockPrisma.tagAssignment.delete?.mockResolvedValue?.({});
  mockPrisma.tagAssignment.create?.mockResolvedValue?.({});
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.note.create?.mockResolvedValue?.({ id: 'note-1', content: 'x', created_at: new Date() });
});

// ══ 1. ASSIGNED, NOT CREATOR ════════════════════════════════════════════════════════════════
describe('a technician assigned to a job somebody else created', () => {
  beforeEach(() => useJob(ASSIGNED_JOB()));

  it.each(ASSIGNEE_SURFACE)('may $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status, `${route.name} -> ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(400);
  });

  // `read Pricing` is new for TECHNICIAN in this PR. Before it, the line-item list came back with
  // the money keys stripped and `billing: null` - a materials list. Prices, totals, cost and
  // margin are all one grant, so one route proves the whole surface.
  it('sees the money: unit price, unit cost, margin and the billing totals', async () => {
    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect(res.body.lines[0]).toHaveProperty('unit_price');
    expect(res.body.lines[0]).toHaveProperty('unit_cost');
    expect(res.body.lines[0]).toHaveProperty('markup_percent');
    expect(res.body.billing).not.toBeNull();
  });

  it.each(CREATOR_ONLY)('is refused $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status, route.name).toBe(403);
  });

  // Every money field on PATCH /:id, not just the tax/discount three. `labor_hours`,
  // `overhead_mode` and `overhead_value` are the JOB COST MODEL - the margin side of exactly the
  // surface the spec says follows creation - and until this PR their only guard was canSeePricing,
  // which happened to be fail-closed for technicians because the role had no `read Pricing`. This
  // PR grants it, so that accident is gone and they need the same creator gate as the rest.
  it.each([
    { tax_rate: 0.0875 },
    { discount_type: 'PERCENTAGE' },
    { discount_value: 10 },
    { labor_hours: 40 },
    { overhead_mode: 'PERCENTAGE' },
    { overhead_value: 99 },
  ])('is refused %o on PATCH /:id', async (body) => {
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it.each([
    { scope_notes: 'bring a ladder' },
    { job_type: 'HVAC' },
    { estimated_duration: 90 },
  ])('may still PATCH the harmless field %o', async (body) => {
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(200);
  });
});

// ══ 2. CREATOR, UNSCHEDULED - the permanence property ════════════════════════════════════════
describe('the creator of a job who has since been taken off the crew', () => {
  beforeEach(() => useJob(CREATED_JOB()));

  it('can still read it, though no assignment connects them to it any more', async () => {
    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it.each(CREATOR_ONLY)('keeps $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status, `${route.name} -> ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(400);
  });

  it.each([
    { tax_rate: 0.0875 },
    { discount_type: 'PERCENTAGE' },
    { discount_value: 10 },
    { labor_hours: 40 },
    { overhead_mode: 'PERCENTAGE' },
    { overhead_value: 99 },
  ])('keeps %o on PATCH /:id', async (body) => {
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(200);
  });

  // `update Job` is the ONE grant this PR leaves on OWN_JOB (Part C's table says keep), and notes /
  // tags / sub-status are what it gates after PR 2's split - so on the grant table alone an
  // unassigned creator looks locked out of their own job's notes. They are not, and the reason is
  // worth stating rather than discovering: `addNote`'s per-instance gate is `canAccessRow`, which
  // derives from the READ grant, and read is the one this PR widened to assigned-OR-created.
  //
  // So permanence holds here too, but through a different mechanism than every other row above,
  // and the grant condition and the enforced condition disagree. Pinned so that "notes follow the
  // read scope" is a recorded property rather than an accident: anyone who later tightens addNote
  // to `canActOnRow(req, …, 'update')` will turn this red and be forced to widen `update Job`
  // alongside it, instead of silently taking notes away from creators.
  it('can still add a note - notes ride the read scope, not `update Job`\'s condition', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/notes`)
      .set(authHeader('technician'))
      .send({ content: 'called the customer' });
    expect(res.status).toBe(201);
  });

  // The delete grant is creator-conditioned, but the pre-existing integrity rule outranks it.
  it('still cannot delete it once it carries an invoice', async () => {
    useJob({ ...CREATED_JOB(), invoices: [{ id: 'inv-1', status: 'VOIDED' }] });
    const res = await request(app).delete(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(400);
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });
});

// ══ 3. SOMEBODY ELSE'S JOB ═════════════════════════════════════════════════════════════════
describe("a technician who neither created nor was assigned the job", () => {
  beforeEach(() => useJob(FOREIGN_JOB()));

  // Tag row-scope fix (2026-08-05): this suite originally found and deliberately left open a hole
  // here - `POST /:id/tags` / `DELETE /:id/tags/:tagId` had NO per-instance check at all, so any
  // technician holding the bare (subject-level) `update Job` grant could tag any job in the org.
  // Closed by tag.controller.ts's ensureRowScopeAccess (canAccessRow, same helper every other
  // per-instance check in this file already goes through), so the tag routes now behave exactly
  // like the rest of ASSIGNEE_SURFACE - no special-case exclusion needed any more.
  it.each([...ASSIGNEE_SURFACE, ...CREATOR_ONLY])(
    'cannot reach $name',
    async (route) => {
      const res = await send(route, 'technician');
      expect([403, 404], `${route.name} -> ${res.status}`).toContain(res.status);
    },
  );
});

// ══ 4. REGRESSION: the org-wide roles are untouched ═════════════════════════════════════════
describe('DISPATCHER and ADMIN are unaffected by the split', () => {
  it.each(['admin', 'dispatcher'] as const)('%s keeps every job route on a job they neither made nor were assigned', async (user) => {
    mockAuthAs(user);
    useJob(FOREIGN_JOB());
    for (const route of [...ASSIGNEE_SURFACE, ...CREATOR_ONLY]) {
      const res = await send(route, user);
      expect(res.status, `${route.name} for ${user} -> ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(400);
    }
  });

  it.each(['admin', 'dispatcher'] as const)('%s keeps the money fields on PATCH /:id', async (user) => {
    mockAuthAs(user);
    useJob(FOREIGN_JOB());
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader(user)).send({ tax_rate: 0.0875 });
    expect(res.status).toBe(200);
  });
});
