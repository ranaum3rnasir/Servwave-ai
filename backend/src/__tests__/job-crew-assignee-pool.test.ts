/**
 * Slice 2 of the scoped-assignee-pool plan, JOB CREW half.
 * (md_files/plans/permissions/2026-08-31-assignee-pool/02-server-refuses-foreign-assignee.md)
 *
 * THE RULE, in one sentence: a requester who does NOT hold `assign User` may name only
 * themselves as a job's crew, and the server answers 403.
 *
 * This suite is the executable form of that product ruling, which is why it is driven through
 * the REAL routes with supertest (authenticate -> attachAbility -> canDo -> validate ->
 * controller) rather than by calling `validateCrew` directly. Nothing here reaches for the
 * validator's shape, so moving the check inside it, splitting it, or renaming it leaves these
 * standing - and, more to the point, a test that called the validator directly could not prove
 * the claim actually being made, which is "there is no unguarded door".
 *
 * ── WHY THE PRINCIPALS ARE BUILT THE WAY THEY ARE ────────────────────────────────────────────
 *
 * The non-holder here is a DISPATCHER with `assign User` stripped (`mockRoleGrantsWithout`), not
 * a SALES user. That is deliberate and it is the only honest choice: slice 1 defaults the grant
 * to DISPATCHER and TECHNICIAN, and SALES holds no job write permission at all, so a SALES
 * request is refused by the ROUTE gate long before the pool rule is consulted - it would look
 * like this suite passed while testing nothing. A dispatcher missing one grant is precisely the
 * configuration an org produces by switching "assign crew and performers other than yourself"
 * off in the Roles screen, i.e. the real shape of a non-holder on these doors.
 *
 * The grant is read off the ABILITY, never off `req.user.role` - which is why stripping one row
 * from a DISPATCHER's defaults is enough to flip every assertion below. A role-shaped
 * implementation would keep answering "dispatcher, so allowed" and every refusal here would go
 * red; that is the mutation this file is designed to catch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  mockAuthAs,
  mockRoleGrantsWithout,
  mockScopedFindFirst,
  authHeader,
  JOB_FIXTURE,
  ALPHA_ORG_ID,
  TEST_USERS,
} from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));

/**
 * The ONE lever that can drive `validateCrew`'s third argument to `undefined` through a real
 * route - see "the strict default" describe below for why that state has to be reachable at all.
 * Off by default, so every other case in this file runs against the real helper.
 */
const crewLever = vi.hoisted(() => ({ suppressCurrentCrew: false }));
vi.mock('../lib/job-crew', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/job-crew')>();
  return {
    ...actual,
    jobCrewIds: (job: Parameters<typeof actual.jobCrewIds>[0]) =>
      (crewLever.suppressCurrentCrew ? undefined : actual.jobCrewIds(job)) as string[],
  };
});

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = JOB_FIXTURE.id;
const VISIT_ID = 'e0000000-0000-0000-0000-000000000001';

/** The requester in every non-holder case below. */
const SELF = TEST_USERS.dispatcher.id;
/** Somebody else - an active, assignable, in-org user, so ONLY the pool rule can refuse them. */
const COLLEAGUE = TEST_USERS.technician.id;
/** A second colleague, for the "self + colleague" case. */
const OTHER = TEST_USERS.sales.id;
/**
 * An id no user has. A self-only requester naming it must be told 403 (the pool rule), NOT 404
 * ('User not found') - otherwise these doors answer a different status for a real id than for a
 * fake one, and a rep's browser session becomes a user-id oracle. This is what forces the pool
 * check to be the validator's FIRST step rather than a filter after the per-member loop.
 */
const GHOST = '00000000-0000-0000-0000-0000000000ee';

/** The refusal. Stated literally: it is a user-facing string, and the twins must not share one. */
const SELF_ONLY = 'You can only assign yourself as job crew.';

const WINDOW = { scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:00:00Z' };

function visitRow(crew: string[], over: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    organization_id: ALPHA_ORG_ID,
    job_id: JOB_ID,
    lead_id: null,
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:00:00Z'),
    is_all_day: false,
    created_at: new Date('2026-08-01T00:00:00Z'),
    customer_email_sent_at: null,
    assignees: crew.map((user_id) => ({ user_id, user: { first_name: 'A', last_name: 'B' } })),
    ...over,
  };
}

/** The job every door below reads, carrying ONE live trip whose crew is `crew`. */
function jobRow(crew: string[], over: Record<string, unknown> = {}) {
  return {
    ...JOB_FIXTURE,
    id: JOB_ID,
    status: 'SCHEDULED',
    created_by_id: null,
    customer: { ...JOB_FIXTURE.customer, email: null },
    visits: [visitRow(crew)],
    ...over,
  };
}

/**
 * Every delegate the crew write paths reach for. Returned so a success case can show the write
 * actually happened rather than inferring it from a 200.
 */
function wireTx() {
  const visitAssignee = {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const jobAssignee = {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const txJobUpdate = vi.fn().mockImplementation(async () => jobRow([]));
  const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => ({ ...visitRow([]), ...args.data }));
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: txVisitUpdate,
        findMany: mockPrisma.visit.findMany,
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee,
      jobAssignee,
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
  return { visitAssignee, jobAssignee, txJobUpdate, txVisitUpdate };
}

/** The reads shared by every door, for a job whose current crew is `crew`. */
function wireReads(crew: string[], jobOver: Record<string, unknown> = {}) {
  mockPrisma.job.findUnique.mockResolvedValue(jobRow(crew, jobOver));
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  // Conflict detection's two parallel reads - "nobody is double-booked" for every case here.
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.visit.findFirst.mockResolvedValue(visitRow(crew));
  mockPrisma.visit.findMany.mockResolvedValue([visitRow(crew)]);
  mockPrisma.visit.create.mockResolvedValue({
    id: VISIT_ID, job_id: JOB_ID, lead_id: null, visit_seq: 1,
    scheduled_at: new Date('2026-09-05T13:00:00Z'), created_at: new Date('2026-08-01T00:00:00Z'),
  });
  mockPrisma.visit.update.mockResolvedValue(visitRow(crew));
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
}

/** A DISPATCHER who does NOT hold `assign User` - the org that switched the grant off. */
function asNonHolder() {
  mockAuthAs('dispatcher');
  mockRoleGrantsWithout('DISPATCHER', ['assign', 'User']);
}

/** A DISPATCHER with the defaults slice 1 ships - the grant holder. */
function asHolder() {
  mockAuthAs('dispatcher');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 1 - POST /api/jobs/:id/assign
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/assign - the assignee pool', () => {
  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  it('lets a non-holder crew themselves', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [SELF], ...WINDOW });

    expect(res.status).toBe(200);
  });

  it('refuses a non-holder naming a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], ...WINDOW });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    // The refusal is not merely a status: nothing was written. A check placed after the write
    // would still answer 403 here.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a non-holder naming themselves ALONGSIDE a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [SELF, COLLEAGUE], ...WINDOW });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
  });

  it('answers 403, not 404, when a non-holder names an id no user has', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [GHOST], ...WINDOW });

    // 404 'User not found' here would make the door an enumeration oracle: a real colleague's id
    // and a fabricated one would answer differently. The pool rule must be asked FIRST.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
  });

  it('lets a grant HOLDER crew anyone, unchanged', async () => {
    asHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE, OTHER], ...WINDOW });

    expect(res.status).toBe(200);
  });

  it('still refuses an ineligible member with the UNCHANGED 400, for a holder', async () => {
    // The pool rule must not have swallowed the eligibility rule, nor moved its status. A holder
    // passes the pool and is then refused by the per-member loop exactly as before.
    asHolder();
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === COLLEAGUE
        ? { id: COLLEAGUE, role: 'TECHNICIAN', is_active: false, email: null, first_name: 'T', last_name: 'A', phone: null }
        : { ...TEST_USERS.dispatcher, organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} } },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], ...WINDOW });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot assign job to an inactive technician');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DEAD-TRIP HOLE - "unchanged at the union" is not "no write"
//
// `jobCrewIds` is the union across EVERY visit with NO status filter (lib/job-crew.ts says so
// deliberately: the row scope has none either). So a job whose only trip is COMPLETED or CANCELLED
// still reports that trip's crew, and handing that union to `validateCrew` as "the roster this
// request would be replacing" declares a colleague's name a RESTATEMENT on a job that has no
// roster left to restate.
//
// That is only a paperwork complaint until the request also moves the window. Then
// syncJobWindowOntoVisits finds no live trip and CREATES one, and applyJobCrewStatementToVisit
// takes the stated crew WHOLESALE on a created visit (`isNewVisit`) rather than as a delta. The
// exemption therefore bought a caller allowed to name only themselves a brand-new SCHEDULED trip
// on a new date, crewed by a colleague, who is then notified about it.
//
// The fix is one clause at the call site - the union is offered only when a LIVE trip exists, and
// otherwise the third argument is omitted, which is the strict path. THE PAIR BELOW IS THE POINT:
// the refusal alone would also be satisfied by "refuse whenever a COMPLETED visit is present", so
// the positive states the same request against a LIVE trip and still expects 200. Only a rule
// keyed on the LIVE trip passes both.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/assign - a job whose only trip is dead', () => {
  /** A window that genuinely MOVES: the dead trip sits at 2026-09-05, this books 2026-09-12. */
  const MOVED = { scheduled_start: '2026-09-12T13:00:00Z', scheduled_end: '2026-09-12T15:00:00Z' };

  it('refuses a non-holder restating the crew of a COMPLETED-only job while moving the window', async () => {
    asNonHolder();
    // The job's ONLY trip is finished, and the colleague is on it. `jobCrewIds` still answers
    // [COLLEAGUE] here - that is the whole trap.
    wireReads([COLLEAGUE], { visits: [visitRow([COLLEAGUE], { status: 'COMPLETED' })] });
    // No LIVE trip for syncJobWindowOntoVisits to move, so it would create one.
    mockPrisma.visit.findMany.mockResolvedValue([]);
    const { visitAssignee } = wireTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], ...MOVED });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    // Not merely a status. Offering the dead trip's union as the current set answered 200 here and
    // wrote the colleague onto an invented trip, so the assertion that matters is that no write
    // was reached at all.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(visitAssignee.createMany).not.toHaveBeenCalled();
  });

  it('still lets a non-holder restate the crew when the trip being moved is LIVE', async () => {
    // The identical request, differing only in the trip's status. This is a real restatement -
    // the roster exists, the request changes nobody, and the crew lands on the trip by DELTA - so
    // it must keep working, or every non-holder loses plain reschedule on jobs they do not staff.
    asNonHolder();
    wireReads([COLLEAGUE]);
    wireTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], ...MOVED });

    expect(res.status).toBe(200);
  });

  it('refuses through the /status door, which fills the crew from the same union', async () => {
    // POST /:id/status never names a crew: with `assignee_ids` omitted it reads the job and hands
    // `jobCrewIds(existing)` to assign(), so the non-holder reaches the same write having typed
    // nobody's name. Guarded only because the rule lives at assign()'s call to validateCrew.
    asNonHolder();
    wireReads([COLLEAGUE], { visits: [visitRow([COLLEAGUE], { status: 'COMPLETED' })] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    const { visitAssignee } = wireTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('dispatcher'))
      .send({ status: 'SCHEDULED', ...MOVED });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(visitAssignee.createMany).not.toHaveBeenCalled();
  });

  it('leaves a grant HOLDER booking a new trip on a COMPLETED-only job untouched', async () => {
    // Without this the three refusals above are equally satisfied by a rule that 403s every
    // dead-trip job, and the clause could be mutated into `validateCrew(req, assignee_ids)`
    // unconditionally - which would break the holder path - while staying green.
    asHolder();
    wireReads([COLLEAGUE], { visits: [visitRow([COLLEAGUE], { status: 'COMPLETED' })] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    wireTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], ...MOVED });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 2 - POST /api/jobs/:id/assignees (crew-only REPLACE)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/assignees - the assignee pool', () => {
  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  it('lets a non-holder crew themselves', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [SELF] });

    expect(res.status).toBe(200);
  });

  it('refuses a non-holder naming a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
  });

  it('refuses a non-holder naming themselves alongside a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [SELF, COLLEAGUE] });

    expect(res.status).toBe(403);
  });

  it('lets a grant holder name anyone', async () => {
    asHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE, OTHER] });

    expect(res.status).toBe(200);
  });

  it('accepts an EMPTY crew from a non-holder', async () => {
    // Ran's recorded call: no minimum-length rule at the API. `[]` names nobody, so the pool
    // question does not arise - the deliberate divergence from the task validator.
    asNonHolder();
    wireReads([SELF]);
    wireTx();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [] });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 2b - POST /api/jobs/:id/visits/:visitId/assignees (crew-only REPLACE on one trip, slice 02)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/visits/:visitId/assignees - the assignee pool', () => {
  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  const send = (assignee_ids: string[]) =>
    request(app)
      .post(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids });

  it('lets a non-holder crew themselves', async () => {
    asNonHolder();
    expect((await send([SELF])).status).toBe(200);
  });

  it('refuses a non-holder naming a colleague', async () => {
    asNonHolder();
    const res = await send([COLLEAGUE]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
  });

  it('lets a non-holder restate the trip\'s own crew - the current set is the TRIP\'s', async () => {
    asNonHolder();
    wireReads([COLLEAGUE]);
    wireTx();
    expect((await send([COLLEAGUE])).status).toBe(200);
  });

  it('lets a grant holder name anyone', async () => {
    asHolder();
    expect((await send([COLLEAGUE, OTHER])).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE STRICT DEFAULT - `validateCrew` called with TWO arguments
//
// `currentCrewIds` is optional, and OMITTING IT APPLIES THE RULE IN FULL: an undefined current
// set means "I cannot vouch that this is a restatement". That branch has no natural route today,
// because all four call sites in job.controller.ts pass a set - but it is not dead code. PR #1942
// calls `validateCrew(req, [assigned_to])` from the service-plan controller, and the entire point
// of making the parameter optional is that such a caller lands on the STRICT path rather than a
// silently permissive one. Nothing else in this file would notice the difference: rewriting the
// guard as `currentCrewIds !== undefined && crewSetChanged(...)` - the permissive reading, and the
// obvious "simplification" - leaves all 27 cases above green and turns only the second case here
// red.
//
// `validateCrew` is module-private, so the undefined has to arrive through the door. Suppressing
// `jobCrewIds` is the only lever that produces it; the FIRST case below is the control that runs
// with the lever off, so the pair reads as one statement about the argument rather than one about
// the mock.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('validateCrew - omitting the current crew is the strict path', () => {
  beforeEach(() => {
    // The job is already crewed by the colleague, so `[COLLEAGUE]` is a RESTATEMENT - the one
    // request whose answer depends entirely on whether the current set reached the validator.
    wireReads([COLLEAGUE]);
    wireTx();
  });

  afterEach(() => {
    crewLever.suppressCurrentCrew = false;
  });

  it('exempts a non-holder restating the crew when the current set IS supplied', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(200);
  });

  it('refuses the SAME restatement when no current set is supplied at all', async () => {
    asNonHolder();
    crewLever.suppressCurrentCrew = true;

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 3 - POST /api/jobs/:id/visits
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/visits - the assignee pool', () => {
  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  it('lets a non-holder book a trip for themselves', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('dispatcher'))
      .send({ ...WINDOW, assignee_ids: [SELF] });

    expect(res.status).toBe(201);
  });

  it('refuses a non-holder booking a trip for a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('dispatcher'))
      .send({ ...WINDOW, assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a non-holder naming themselves alongside a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('dispatcher'))
      .send({ ...WINDOW, assignee_ids: [SELF, COLLEAGUE] });

    expect(res.status).toBe(403);
  });

  it('lets a grant holder book a trip for anyone', async () => {
    asHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('dispatcher'))
      .send({ ...WINDOW, assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 4 - PATCH /api/jobs/:id/visits/:visitId
//
// The three-state door, and the one where getting the rule wrong breaks plain
// drag-to-reschedule. `assignee_ids` omitted = unchanged; `[]` = a real change to empty; a
// repeated array = a restatement the dialog sends on EVERY save whether or not the picker was
// touched. Only the middle one is a crew statement, so only it may be refused.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/jobs/:id/visits/:visitId - the assignee pool', () => {
  beforeEach(() => {
    wireReads([COLLEAGUE]);
    wireTx();
  });

  it('lets a non-holder DRAG a trip crewed by other people (assignee_ids omitted)', async () => {
    // The regression this door is most exposed to. The visit is crewed by a colleague and the
    // request never mentions crew, so no pool question is being asked. A check that ran on every
    // request - or one that read the visit's stored crew instead of the request's - would 403
    // every reschedule of every trip a non-holder does not personally staff.
    asNonHolder();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:00:00Z' });

    expect(res.status).toBe(200);
  });

  it('lets a non-holder RESTATE the unchanged crew of a trip staffed by someone else', async () => {
    // VisitScheduleDialog re-sends `assignee_ids` on every save. Restating a set is not naming
    // anybody new, so it must pass - the same exemption `sameSet` gives the task doors.
    asNonHolder();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE], scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:00:00Z' });

    expect(res.status).toBe(200);
  });

  it('refuses a non-holder ADDING a colleague to the crew', async () => {
    asNonHolder();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE, OTHER] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets a non-holder take a trip over for themselves', async () => {
    asNonHolder();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [SELF] });

    expect(res.status).toBe(200);
  });

  it('lets a grant holder re-crew a trip with anyone', async () => {
    asHolder();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('dispatcher'))
      .send({ assignee_ids: [COLLEAGUE, OTHER] });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 5 - POST /api/jobs/:id/status (SCHEDULED dispatches into assign())
//
// Exercised because it reaches the crew write WITHOUT calling validateCrew itself: it inherits
// the check from assign(). A rule written at the call sites instead of inside the validator
// would leave this door - and bulk-assign below - open.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/status - the assignee pool reaches the dispatching door', () => {
  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  it('refuses a non-holder naming a colleague through the status door', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('dispatcher'))
      .send({ status: 'SCHEDULED', assignee_ids: [COLLEAGUE], ...WINDOW });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
  });

  it('lets a non-holder schedule with themselves through the status door', async () => {
    asNonHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('dispatcher'))
      .send({ status: 'SCHEDULED', assignee_ids: [SELF], ...WINDOW });

    expect(res.status).toBe(200);
  });

  it('leaves a grant HOLDER scheduling anyone through the status door untouched', async () => {
    // The holder half of this door. Without it the two cases above are satisfied by a status
    // handler that refuses EVERY crew list, so a mutation breaking the holder path here - the
    // dispatch into assign() dropping its crew, say - would ship green.
    asHolder();
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('dispatcher'))
      .send({ status: 'SCHEDULED', assignee_ids: [COLLEAGUE, OTHER], ...WINDOW });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 6 - POST /api/jobs/bulk-assign
//
// This door answers 200 whatever happens: runJobVerbBatch catches each sub-handler's non-2xx
// and reports it per row. Asserting `res.status` here would pass against a completely unguarded
// implementation, so every assertion reads `failed[]`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/bulk-assign - the assignee pool', () => {
  // This is the ONE job door whose body is uuid-validated (`bulkAssignJobsSchema`), so it cannot
  // use JOB_FIXTURE's non-hex id. The mocked reads answer for whatever id arrives.
  const BULK_JOB_ID = 'a0000000-0000-0000-0000-00000000000a';

  beforeEach(() => {
    wireReads([]);
    wireTx();
  });

  it('reports the refusal per row when a non-holder names a colleague', async () => {
    asNonHolder();
    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('dispatcher'))
      .send({ ids: [BULK_JOB_ID], assignee_ids: [COLLEAGUE] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed).toEqual([{ id: BULK_JOB_ID, error: SELF_ONLY }]);
  });

  it('lets a non-holder bulk-assign themselves', async () => {
    asNonHolder();
    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('dispatcher'))
      .send({ ids: [BULK_JOB_ID], assignee_ids: [SELF] });

    expect(res.body.failed).toEqual([]);
    expect(res.body.updated).toEqual([BULK_JOB_ID]);
  });

  it('lets a grant holder bulk-assign anyone', async () => {
    asHolder();
    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('dispatcher'))
      .send({ ids: [BULK_JOB_ID], assignee_ids: [COLLEAGUE] });

    expect(res.body.failed).toEqual([]);
    expect(res.body.updated).toEqual([BULK_JOB_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE REGRESSION GUARD ON SLICE 1
//
// The single most important assertion in this file. Slice 1 defaults `assign User` to TECHNICIAN
// precisely so that a technician who created a job keeps the ability to add colleagues to its
// crew - a capability they have today. The two grants compose: `assign Job` scoped
// CREATED_BY_ME says WHICH jobs, `assign User` (org-wide) says WHOSE names. Dropping TECHNICIAN
// from slice 1's defaults would turn this green suite red, which is the point.
//
// `job.findFirst` is wired through `mockScopedFindFirst` here rather than a blanket
// `mockResolvedValue({ id })`, because this case turns entirely on a row scope: a blanket mock
// makes `created_by_id` irrelevant and the negative case below vacuous.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a TECHNICIAN and the crew of a job they created', () => {
  const TECH = TEST_USERS.technician.id;

  beforeEach(() => {
    mockAuthAs('technician');
    wireReads([]);
    wireTx();
  });

  it('can still add a colleague to the crew of a job they created', async () => {
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TECH,
      visits: [{ assignees: [] }],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('technician'))
      .send({ assignee_ids: [TECH, TEST_USERS.dispatcher.id] });

    expect(res.status).toBe(200);
  });

  it('still cannot re-crew a job somebody else created', async () => {
    // The row scope, not the pool rule: `assign Job` is conditioned CREATED_BY_ME, so this is
    // refused before the pool question arises. Present so the case above cannot pass merely
    // because the scope check was defanged.
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      visits: [{ assignees: [] }],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('technician'))
      .send({ assignee_ids: [TECH, TEST_USERS.dispatcher.id] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });
});
