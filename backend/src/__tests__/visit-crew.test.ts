/**
 * Multi-visit spec slice S3 - crew per visit.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> attachAbility ->
 * canDo -> validate -> controller -> service) with Prisma mocked, which is the seam the spec
 * names as the default for every behaviour in it. Nothing here reaches for an internal
 * function's shape, so splitting or renaming replaceJobCrew / the visit service leaves these
 * standing.
 *
 * Two things in this file are load-bearing rather than decorative, and both exist because a
 * mocked Prisma cannot see the database:
 *
 *  (a) The job_assignees mock is STATEFUL and HONOURS its where. `job_assignees` is not a
 *      display list - OWN_JOB is `{ assignees: { some: { user_id } } }`, a stored JSONB
 *      row-scope gating a technician's read/update/start/arrive/complete on Job. A mock that
 *      returns a fixture regardless of what the write did proves nothing about which rows
 *      survived, and the failure mode here is a silent 403, never an error.
 *
 *  (b) The written `data` rows of visitAssignee.createMany are asserted directly.
 *      `visit_assignees.lead_id` going nullable and a job visit having no lead are BOTH
 *      invisible to the mocked seam, exactly as job-visits.test.ts argues for
 *      `visits_exactly_one_parent`. A row that stamped a lead_id onto a job-parented visit
 *      would pass green here and fail only against real Postgres.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, mockScopedFindFirst, JOB_FIXTURE, ALPHA_ORG_ID, ORG_B_ID, TEST_ORG, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

import { emit } from '../services/notifications/notificationService';

// Captured so the "you were removed from this job" dispatch can be asserted as an observable
// consequence rather than inferred from the crew rows.
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/**
 * PINNED AT MODULE SCOPE (mirrors job-visits.test.ts's PINNED_NOW - same file family, same
 * reason). "moving one visit does not fan the job union onto it" below books/moves visits dated
 * 2026-09-05..09 and depends on `resolveNextJobVisit`'s real UPCOMING-vs-ELAPSED split (S8, D14)
 * to pick which trip a bare `scheduled_start` touches. Left on the real clock, the fixture is a
 * time bomb: once the wall clock itself passes those dates the EARLIER of the two live visits
 * silently becomes "elapsed", so `resolveNextJobVisit` hands the later trip the mirror instead of
 * the one the request actually named, and the crew write fans onto the wrong trip - a defect in
 * the fixture, not in `syncJobWindowOntoVisits`/`resolveNextJobVisit` themselves. Only `Date` is
 * faked; `setTimeout`/`setInterval` stay real so supertest/express keep driving genuine async.
 */
const PINNED_NOW = new Date('2026-08-25T09:00:00Z');

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(PINNED_NOW);

afterAll(() => {
  vi.useRealTimers();
});

const mockPrisma = prisma as unknown as Record<string, any>;

// Crew members drawn from TEST_USERS so validateCrew's per-member `user.findUnique` (which
// mockAuthAs backs) resolves them as active, assignable, in-org people.
const TECH_A = TEST_USERS.technician.id;
const TECH_B = TEST_USERS.dispatcher.id;
/** The decoy: crewed on a DIFFERENT job's visit, so it must never enter this job's union. */
const TECH_C = TEST_USERS.sales.id;

const JOB_ID = JOB_FIXTURE.id;
const OTHER_JOB_ID = 'j0000000-0000-0000-0000-0000000000c9';
const VISIT_1 = 'e0000000-0000-0000-0000-000000000001';
const VISIT_3 = 'e0000000-0000-0000-0000-000000000003';
const OTHER_JOB_VISIT = 'e0000000-0000-0000-0000-0000000000c9';

/**
 * A STATEFUL job_assignees delegate: a tiny in-test store that honours the `where` of every
 * call the production writer makes. `findMany({where:{job_id}})`, `createMany` and
 * `deleteMany({where:{job_id,user_id:{in}}})` all move the same set, and the same set feeds the
 * `assignees` key the job detail read serves back - so a fixture cannot be returned that the
 * write did not produce.
 */
function jobCrewStore(jobId: string, initial: string[]) {
  const rows = new Set(initial);
  const delegate = {
    findMany: vi.fn(async ({ where }: any) =>
      where?.job_id === jobId ? [...rows].map((user_id) => ({ user_id })) : [],
    ),
    createMany: vi.fn(async ({ data }: any) => {
      const list = Array.isArray(data) ? data : [data];
      for (const row of list) if (row.job_id === jobId) rows.add(row.user_id);
      return { count: list.length };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      if (where?.job_id !== jobId) return { count: 0 };
      const ids: string[] = where.user_id?.in ?? [];
      for (const id of ids) rows.delete(id);
      return { count: ids.length };
    }),
  };
  return { rows, delegate };
}

type VisitCrewRow = { visit_id: string; job_id: string | null; user_id: string };

/**
 * A visit_assignees delegate that honours BOTH shapes of `where` the union read can take:
 * `{ visit: { job_id } }` (every crew row on a job, across its visits) and `{ visit_id }` (one
 * visit's crew). Seeding a row on ANOTHER job's visit is the whole point - a delegate that
 * returned its fixture regardless would let a union scoped by nothing look scoped by job.
 */
function visitCrewStore(seed: VisitCrewRow[], visitParent: Record<string, string> = {}) {
  const rows = [...seed];
  // A written row names only its visit. Which JOB that visit belongs to is a fact the database
  // holds and the mock has to be told, or a union read scoped `{ visit: { job_id } }` would miss
  // every row this test just wrote and the store would quietly stop proving anything.
  const parentOf = { ...visitParent, ...Object.fromEntries(seed.filter((r) => r.job_id).map((r) => [r.visit_id, r.job_id!])) };
  const matches = (r: VisitCrewRow, where: any) => {
    if (where?.visit?.job_id !== undefined && r.job_id !== where.visit.job_id) return false;
    if (where?.visit_id !== undefined && r.visit_id !== where.visit_id) return false;
    if (where?.user_id?.in !== undefined && !where.user_id.in.includes(r.user_id)) return false;
    return true;
  };
  const delegate = {
    findMany: vi.fn(async ({ where }: any) =>
      rows.filter((r) => matches(r, where)).map((r) => ({ user_id: r.user_id, visit_id: r.visit_id })),
    ),
    createMany: vi.fn(async ({ data }: any) => {
      const list = Array.isArray(data) ? data : [data];
      for (const row of list) {
        rows.push({ visit_id: row.visit_id, job_id: parentOf[row.visit_id] ?? null, user_id: row.user_id });
      }
      return { count: list.length };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          removed++;
        }
      }
      return { count: removed };
    }),
  };
  return { rows, delegate };
}

/**
 * Serve `prisma.job.findUnique` from the VISIT crew store, in whichever shape the caller's
 * select asks for: assign()/setAssignees read `visits.assignees.user_id`, jobDetailSelect reads
 * `visits.assignees.user`. Both come off the SAME set, or the read would be agreeing with a
 * fixture rather than with the write.
 *
 * S8 (D6): the job-level `assignees` relation is gone. The payload key of the same name is
 * DERIVED by the controller from these rows, which is exactly what the detail assertions below
 * exercise.
 */
function serveJobFromStore(store: { rows: VisitCrewRow[] }, over: Record<string, unknown> = {}) {
  const person = (id: string) => {
    const u = Object.values(TEST_USERS).find((t) => t.id === id);
    return {
      id,
      first_name: u?.first_name ?? 'Unknown',
      last_name: u?.last_name ?? 'User',
      role: u?.role ?? 'TECHNICIAN',
      phone: null,
      email: u?.email ?? null,
      avatar_path: null,
      department: null,
    };
  };
  mockPrisma.job.findUnique.mockImplementation(async ({ select }: any) => {
    const base = { ...JOB_FIXTURE, ...over };
    const onThisJob = store.rows.filter((r) => r.job_id === JOB_ID);
    const byVisit = new Map<string, string[]>();
    for (const r of onThisJob) byVisit.set(r.visit_id, [...(byVisit.get(r.visit_id) ?? []), r.user_id]);
    const wantsUser = Boolean(select?.visits?.select?.assignees?.select?.user);
    const visits = [...byVisit.entries()].map(([visit_id, users], i) => ({
      id: visit_id,
      visit_seq: i + 1,
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-09-05T13:00:00Z'),
      scheduled_end: new Date('2026-09-05T15:00:00Z'),
      is_all_day: false,
      // S8 (A5, RATIFIED): every visit here shares the SAME literal scheduled_at, so the
      // schedule projection's tie-break needs created_at whenever a job holds 2+ visits -
      // spaced by index so it is also a genuine, checkable creation order, not just a filler.
      created_at: new Date(new Date('2026-08-01T00:00:00Z').getTime() + i * 86_400_000),
      customer_email_sent_at: null,
      assignees: users.map((user_id) =>
        wantsUser ? { user_id, user: person(user_id) } : { user_id },
      ),
    }));
    return { ...base, visits };
  });
}

describe('POST /api/jobs/:id/assign - a job-level crew replace does not evict another visit\'s crew', () => {
  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;

  beforeEach(() => {
    // Call history accumulates across tests otherwise, so `deleteMany.mock.calls[0]` would read
    // the PREVIOUS test's write.
    vi.clearAllMocks();
    clearPermissionCache();
    // mockAuthAs installs a user.findUnique implementation that also resolves the caller's
    // ORGANIZATION - overriding it would drop the org to STARTER and 402 the whole router.
    mockAuthAs('admin');

    // The job already carries both people at job level; TECH_A is on visit 1 and TECH_B on
    // visit 3. TECH_C is the decoy, crewed on a DIFFERENT job's visit.
    crew = jobCrewStore(JOB_ID, [TECH_A, TECH_B]);
    visitCrew = visitCrewStore([
      { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
      { visit_id: VISIT_3, job_id: JOB_ID, user_id: TECH_B },
      { visit_id: OTHER_JOB_VISIT, job_id: OTHER_JOB_ID, user_id: TECH_C },
    ]);

    serveJobFromStore(visitCrew, { status: 'SCHEDULED', scheduled_start: new Date('2026-09-05T13:00:00Z') });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  });

  it('keeps a technician who is on another visit of the same job', async () => {
    // The board drag: the dispatcher moves visit 1 and the Assign dialog POSTs visit 1's crew
    // only. A whole-job REPLACE would compute `removed` = everyone not in that array - i.e.
    // visit 3's crew - and delete their job_assignees rows. Because OWN_JOB is
    // `{ assignees: { some: { user_id } } }` those techs silently lose read/update/start/
    // arrive on a job they are genuinely crewed on: no error, no log, and the next per-visit
    // write puts the rows back, so the symptom flaps.
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A],
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
      });

    expect(res.status).toBe(200);

    const detail = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(detail.status).toBe(200);
    const ids = (detail.body.job.assignees as Array<{ user: { id: string } }>).map((a) => a.user.id);

    expect(ids).toContain(TECH_A);
    expect(ids).toContain(TECH_B);
    // The decoy proves the union read is scoped by JOB, not merely "whatever the mock held".
    expect(ids).not.toContain(TECH_C);
  });
});

/**
 * The transaction shared by the visit write, the crew write and the D14 mirror. Returns the
 * visitAssignee spies so the WRITTEN row shape can be read straight off them.
 */
function wireJobVisitTx(seed: VisitCrewRow[] = [], jobCrew: string[] = []) {
  const crew = jobCrewStore(JOB_ID, jobCrew);
  const visitCrew = visitCrewStore(seed, { [VISIT_1]: JOB_ID, [VISIT_3]: JOB_ID });
  const txJobUpdate = vi.fn().mockResolvedValue(JOB_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: visitCrew.delegate,
      jobAssignee: crew.delegate,
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
  return { crew, visitCrew, txJobUpdate };
}

describe('POST /api/jobs/:id/visits - a job visit carries its own crew', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue({
      id: VISIT_1, job_id: JOB_ID, lead_id: null, visit_seq: 1,
      scheduled_at: new Date('2026-09-05T13:00:00Z'), created_at: new Date('2026-08-20T10:00:00Z'),
    });
    tx = wireJobVisitTx();
  });

  it('writes crew rows keyed on the visit, carrying no lead', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
        assignee_ids: [TECH_A],
      });

    expect(res.status).toBe(201);

    expect(tx.visitCrew.delegate.createMany).toHaveBeenCalledTimes(1);
    const rows = tx.visitCrew.delegate.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([{ visit_id: VISIT_1, user_id: TECH_A, organization_id: ALPHA_ORG_ID }]);
    // Load-bearing, not decorative: `visit_assignees.lead_id` going nullable and a job visit
    // having no lead are BOTH invisible under the mocked seam. A row that stamped a lead_id onto
    // a job-parented visit passes green here and fails only against real Postgres.
    expect(rows[0]).not.toHaveProperty('lead_id');
  });
});

describe('POST /api/jobs/:id/visits - booking a visit with crew grows the job-assignee union', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    // A job with NO crew at all: nobody has been assigned at job level.
    tx = wireJobVisitTx([], []);
    serveJobFromStore(tx.visitCrew, { status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue({
      id: VISIT_1, job_id: JOB_ID, lead_id: null, visit_seq: 1,
      scheduled_at: new Date('2026-09-05T13:00:00Z'), created_at: new Date('2026-08-20T10:00:00Z'),
    });
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
  });

  it('lets the newly crewed technician reach the job', async () => {
    // Asserted through the job DETAIL payload rather than by counting Prisma calls, because that
    // payload is the public interface every union reader sits behind: TeamCard, AssignJobDialog's
    // seeding, copilot's currentCrew, and - the one that bites - the CASL OWN_JOB row-scope. A
    // visit_assignees row with no matching job_assignees row means the tech is on the trip and
    // invisible: the job is absent from their list and GET /api/jobs/:id 403s for them.
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
        assignee_ids: [TECH_B],
      });

    expect(res.status).toBe(201);

    const detail = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(detail.status).toBe(200);
    const ids = (detail.body.job.assignees as Array<{ user: { id: string } }>).map((a) => a.user.id);
    expect(ids).toContain(TECH_B);
  });
});

describe('Job visit routes - setting crew needs `assign Job`, not merely `reschedule Job`', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('technician');
    // A technician who holds `reschedule Job` as a PER-USER capability (its ownCondition is
    // OWN_JOB) but not `assign Job` on this row: assign is CREATED_BY_ME for TECHNICIAN by
    // default, and somebody else created this job.
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'reschedule', subject: 'Job', effect: 'allow' },
    ]);
    // Prisma is mocked, so a blanket findFirst -> {id} would make EVERY per-instance scope check
    // pass and turn the refusal below into a vacuous assertion. This one really evaluates the
    // scope fragment against the row.
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      // S8 (D6): OWN_JOB is `{ visits: { some: { assignees: { some: { user_id } } } } }`, so the
      // fixture row has to carry the ownership one relation level deeper too.
      visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    });

    tx = wireJobVisitTx([{ visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A }], [TECH_A]);
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_1, assignees: [{ user_id: TECH_A }] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue({
      id: VISIT_3, job_id: JOB_ID, lead_id: null, visit_seq: 2,
      scheduled_at: new Date('2026-09-06T13:00:00Z'), created_at: new Date('2026-08-20T10:00:00Z'),
    });
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
  });

  it('still lets a reschedule-only grantee move a visit', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('technician'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(200);
  });

  it('refuses the same grantee a visit that names crew', async () => {
    // The visit routes are gated `canDo('reschedule','Job')` by S2's deliberate design, and that
    // gate is SUBJECT-level. Hanging crew off them with no second check silently widens what every
    // reschedule-only grantee can do - which is precisely the gate job.routes.ts's S2 comment says
    // must not be routed around.
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('technician'))
      .send({
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
        assignee_ids: [TECH_A],
      });

    expect(res.status).toBe(403);
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('refuses the same grantee a PATCH that names crew, while the bare move still succeeds', async () => {
    // The asymmetry that matters is between the two ACTIONS, never between the two HTTP verbs.
    // Crew reaching the DB through the PATCH while the POST checks `assign Job` would just be the
    // same hole with a different method on it.
    const moved = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('technician'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });
    expect(moved.status).toBe(200);

    const withCrew = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('technician'))
      .send({
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
        assignee_ids: [TECH_B],
      });

    expect(withCrew.status).toBe(403);
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
  });
});

// ─── Q3 (multi-visit close-out) - the gate keys on the crew SET changing ─────────────────────
// `assignee_ids.length > 0` had two defects in opposite directions: `[]` on a crewed visit skipped
// the gate and wiped the crew (length 0), and a reschedule-only grantee RESTATING the visit's
// unchanged crew was false-403'd (length > 0) - VisitScheduleDialog sends `assignee_ids` on every
// save the picker is shown for, whether or not the user touched it. All four cases below are named
// verbatim in the close-out contract.
describe('PATCH /api/jobs/:id/visits/:visitId - the assign gate keys on the crew SET (Q3)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('technician');
    // Reschedule-only, exactly as the sibling describe above: holds `reschedule Job` but not
    // `assign Job` on this row (assign is CREATED_BY_ME for TECHNICIAN by default, and someone
    // else created this job).
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'reschedule', subject: 'Job', effect: 'allow' },
    ]);
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      visits: [{ assignees: [{ user_id: TECH_A }] }],
    });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findMany.mockResolvedValue([]);
    // The visit CURRENTLY carries TECH_A alone.
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_1, status: 'SCHEDULED', assignees: [{ user_id: TECH_A }] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    tx = wireJobVisitTx([{ visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A }], [TECH_A]);
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
  });

  function move(assignee_ids?: string[]) {
    return request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('technician'))
      .send({
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
        ...(assignee_ids !== undefined ? { assignee_ids } : {}),
      });
  }

  it('1. a reschedule-only grantee sending [] on a crewed visit is 403d, and the crew is left alone', async () => {
    const res = await move([]);

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(tx.visitCrew.delegate.deleteMany).not.toHaveBeenCalled();
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(tx.visitCrew.rows.filter((r) => r.visit_id === VISIT_1).map((r) => r.user_id)).toEqual([TECH_A]);
  });

  it('2. a reschedule-only grantee restating the SAME crew succeeds - restating is not a change', async () => {
    const res = await move([TECH_A]);

    expect(res.status).toBe(200);
  });

  it('3. a reschedule-only grantee restating a DIFFERENT crew is 403d - that IS a change', async () => {
    const res = await move([TECH_B]);

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('4. an assign-holder sending [] succeeds and empties the crew', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await move([]);

    expect(res.status).toBe(200);
    expect(tx.visitCrew.rows.filter((r) => r.visit_id === VISIT_1)).toHaveLength(0);
  });
});

describe('POST /api/jobs/:id/visits - an ineligible or out-of-org crew member is refused', () => {
  const OTHER_ORG_USER = '00000000-0000-0000-0000-0000000000e1';
  const INACTIVE_USER = '00000000-0000-0000-0000-0000000000e2';
  const CORRUPT_ROLE_USER = '00000000-0000-0000-0000-0000000000e3';
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    // mockAuthAs's user.findUnique resolves any TEST_USERS id and IGNORES the tenant clause, so
    // the out-of-org case below would pass against it for the wrong reason. This one honours
    // `organization_id` - which is the whole point of validateCrew spreading tenantWhere on its
    // per-member lookup - while still attaching the caller's ORGANIZATION, without which the
    // whole gated router 402s.
    const directory = [
      ...Object.values(TEST_USERS),
      { id: OTHER_ORG_USER, role: 'TECHNICIAN', is_active: true, email: 'x@orgb.com', first_name: 'Out', last_name: 'OfOrg', organization_id: ORG_B_ID },
      { id: INACTIVE_USER, role: 'TECHNICIAN', is_active: false, email: 'gone@test.com', first_name: 'Left', last_name: 'Company', organization_id: ALPHA_ORG_ID },
      { id: CORRUPT_ROLE_USER, role: 'VIEWER', is_active: true, email: 'v@test.com', first_name: 'View', last_name: 'Only', organization_id: ALPHA_ORG_ID },
    ];
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      const match = directory.find((u) => u.id === where.id);
      if (!match) return null;
      if (where.organization_id !== undefined && match.organization_id !== where.organization_id) return null;
      return { ...match, organization: TEST_ORG };
    });

    tx = wireJobVisitTx([], []);
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, lead_id: null, visit_seq: 1 });
  });

  const book = (assignee_ids: string[]) =>
    request(app)
      .post(`/api/jobs/${JOB_ID}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z', assignee_ids });

  it('404s a user belonging to another organization, writing nothing', async () => {
    // The tenancy case. Without it a visit on this org's job carries crew from another tenant.
    const res = await book([OTHER_ORG_USER]);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('400s an inactive in-org user, writing nothing', async () => {
    const res = await book([INACTIVE_USER]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot assign job to an inactive technician');
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('400s a user whose role is not assignable, writing nothing', async () => {
    // Every value of the Role enum is assignable today, so this branch is only reachable through a
    // corrupt/unknown role value - which is exactly what assignableRoles.ts says isAssignable is
    // still there to reject, and what a future role added to the enum would look like.
    const res = await book([CORRUPT_ROLE_USER]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This user is not eligible to be assigned as job crew');
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });
});

/**
 * S3 arms a latent 500 that has been unreachable until now.
 *
 * detectCrewConflicts asks the shared `visits` table for every SCHEDULED visit crewed with the
 * people being assigned, then reports each as a WALKTHROUGH conflict by dereferencing the row's
 * lead. Job-parented visits carry no lead (D5: exactly one parent), and until this slice they
 * carried no crew either, so the query could never match one. Giving job visits crew makes the
 * match reachable on the ordinary daily flow - a tech crewed on a job visit, then assigned to any
 * other job in an overlapping window - and the dereference throws inside assign()'s try/catch,
 * which turns D21's "warn, never block" into a blanket 500.
 *
 * The mock therefore HONOURS its where and is seeded with a job-parented DECOY. A findMany that
 * returned its fixture regardless would prove nothing about the predicate, which is the entire
 * behaviour under test here.
 */
describe('POST /api/jobs/:id/assign - a crewed job visit warns, and never crashes the assign', () => {
  const CONFLICT_LEAD_ID = 'l0000000-0000-0000-0000-000000000001';
  const OTHER_LEAD_ID = 'l0000000-0000-0000-0000-000000000002';
  const WINDOW_START = '2026-09-05T13:00:00Z';
  const WINDOW_END = '2026-09-05T15:30:00Z';

  type SeedVisit = {
    id: string;
    lead_id: string | null;
    lead: { id: string; lead_number: string } | null;
    scheduled_at: string;
    user_ids: string[];
  };

  /**
   * Serve prisma.visit.findMany from a seeded fixture, applying the crew-conflict predicates the
   * production query actually sends. The `lead_id` arm is what this cycle is about: it is absent
   * today, so the decoy survives and reaches the lead dereference.
   */
  function seedConflictVisits(seed: SeedVisit[]) {
    mockPrisma.visit.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      // Only the conflict detector filters by crew. Every other visit read on this path (the
      // window sync, the D14 mirror) is job-scoped and gets nothing seeded.
      if (!where.assignees) return [];
      const wanted: string[] = where.assignees.some?.user_id?.in ?? [];
      return seed
        .filter((v) => v.user_ids.some((u) => wanted.includes(u)))
        .filter((v) => (where.status ? v.lead_id !== undefined : true))
        .filter((v) => {
          const leadPredicate = where.lead_id;
          if (leadPredicate === undefined) return true;
          if ('not' in leadPredicate && leadPredicate.not === null) return v.lead_id !== null;
          return true;
        })
        .map((v) => ({
          id: v.id,
          scheduled_at: new Date(v.scheduled_at),
          duration_minutes: 60,
          lead: v.lead,
        }));
    });
  }

  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    crew = jobCrewStore(JOB_ID, []);
    visitCrew = visitCrewStore([], { [VISIT_1]: JOB_ID });
    serveJobFromStore(visitCrew, { status: 'UNSCHEDULED', scheduled_start: null });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.visit.create.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  });

  it('warns about the lead walkthrough only, ignoring the job-parented visit in the same window', async () => {
    seedConflictVisits([
      // The decoy: a job visit, crewed with the same tech, right inside the requested window.
      { id: OTHER_JOB_VISIT, lead_id: null, lead: null, scheduled_at: '2026-09-05T13:30:00Z', user_ids: [TECH_A] },
      // A genuine lead walkthrough clash in the window.
      {
        id: 'e0000000-0000-0000-0000-0000000000d1',
        lead_id: CONFLICT_LEAD_ID,
        lead: { id: CONFLICT_LEAD_ID, lead_number: 'L00001' },
        scheduled_at: '2026-09-05T14:00:00Z',
        user_ids: [TECH_A],
      },
      // A lead walkthrough the day after: matched by crew, excluded by the overlap math.
      {
        id: 'e0000000-0000-0000-0000-0000000000d2',
        lead_id: OTHER_LEAD_ID,
        lead: { id: OTHER_LEAD_ID, lead_number: 'L00002' },
        scheduled_at: '2026-09-06T14:00:00Z',
        user_ids: [TECH_A],
      },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: WINDOW_START, scheduled_end: WINDOW_END });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({ type: 'walkthrough', id: CONFLICT_LEAD_ID, number: 'L00001' });
  });

  it('assigns cleanly when the only overlap is a job-parented visit', async () => {
    seedConflictVisits([
      { id: OTHER_JOB_VISIT, lead_id: null, lead: null, scheduled_at: '2026-09-05T13:30:00Z', user_ids: [TECH_A] },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: WINDOW_START, scheduled_end: WINDOW_END });

    expect(res.status).toBe(200);
    // S8 (D6): the crew landed on the trip this call booked, which is where it lives now.
    expect(visitCrew.rows.filter((r) => r.job_id === JOB_ID).map((r) => r.user_id)).toEqual([TECH_A]);
  });
});

// ─── Q7 (multi-visit close-out) - the over-warn is DELIBERATE; the lead arm had a real gap ────
describe('detectCrewConflicts - crew and window are independent visits, on purpose (Q7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, id: JOB_ID, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.lead.findMany.mockResolvedValue([]);
  });

  // Q7 (RATIFIED, Option 1): DO NOT TIGHTEN THIS. The crew clause (`visits:{some:{assignees:...}}`)
  // and the window clause (`visits:{some:{...overlap}}`) are two SEPARATE filters under AND, so a
  // job clashes when ANY visit carries the person and ANY visit overlaps - not necessarily the
  // SAME visit. This is load-bearing: elsewhere in this file the job-level crew union is the
  // fallback for a trip that carries no crew of its own, so a same-visit match would UNDER-warn on
  // exactly those jobs. Under D21 (warn, never block) an over-warn costs a dismissed dialog; an
  // under-warn costs a double-booked technician. If this test ever goes red because someone
  // "tightened" the query, that is the regression, not this test.
  it('still warns when the crew match and the window overlap land on DIFFERENT visits of the same job', async () => {
    const OTHER_JOB_ID = 'j0000000-0000-0000-0000-0000000000d9';
    mockPrisma.job.findMany.mockResolvedValueOnce([
      {
        id: OTHER_JOB_ID,
        job_number: 'J00099',
        // The production select's nested `visits.where` is the OVERLAP filter alone, so this is
        // the row Prisma would hand back for "visit 2 overlaps the window" - and it is CREWLESS.
        // Visit 1, which actually carries Alice, does not satisfy the overlap filter and is not
        // part of this nested array at all. The job still matched the outer WHERE because SOME
        // visit (visit 1) carries the crew and SOME visit (visit 2) overlaps.
        visits: [{ id: 'v-visit-2', scheduled_at: new Date('2026-09-05T14:00:00Z'), scheduled_end: new Date('2026-09-05T16:00:00Z') }],
      },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T17:00:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({ type: 'job', id: OTHER_JOB_ID, number: 'J00099' });
  });

  // Q7's real asymmetry: the job arm matches `status: { not: 'CANCELLED' }` on the overlapping
  // visit, so a crew member EN_ROUTE/ON_SITE/IN_PROGRESS on another job still clashes - but the
  // lead arm matched `status: 'SCHEDULED'` only, so the identical situation on a WALKTHROUGH never
  // raised a conflict.
  it('a walkthrough that has moved past SCHEDULED (ON_SITE) still clashes', async () => {
    const LEAD_ID = 'l0000000-0000-0000-0000-0000000000e1';
    mockPrisma.job.findMany.mockResolvedValueOnce([]);
    mockPrisma.visit.findMany.mockImplementationOnce(async (args: any) => {
      const status = args?.where?.status;
      const matches =
        status === undefined ? true
        : typeof status === 'string' ? status === 'ON_SITE'
        : Array.isArray(status?.in) && status.in.includes('ON_SITE');
      if (!matches) return [];
      return [{
        id: 'wt-onsite-1',
        scheduled_at: new Date('2026-09-05T14:00:00Z'),
        duration_minutes: 60,
        lead: { id: LEAD_ID, lead_number: 'L00050' },
      }];
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T17:00:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({ type: 'walkthrough', id: LEAD_ID, number: 'L00050' });
  });
});

// ─── Q6 (multi-visit close-out) - the 409 body names who is double-booked ────────────────────
describe('detectCrewConflicts - the conflict entry names who is double-booked (Q6)', () => {
  const OTHER_JOB_ID = 'j0000000-0000-0000-0000-0000000000f1';

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, id: JOB_ID, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.lead.findMany.mockResolvedValue([]);
  });

  it('names ONLY the crew member who is actually on the clashing visit, out of several candidates', async () => {
    mockPrisma.job.findMany.mockResolvedValueOnce([
      {
        id: OTHER_JOB_ID,
        job_number: 'J00088',
        customer: { first_name: 'Jane', last_name: 'Smith', company_name: null },
        visits: [{
          id: 'v-clash-1',
          scheduled_at: new Date('2026-09-05T14:00:00Z'),
          scheduled_end: new Date('2026-09-05T16:00:00Z'),
          // Only Alice is on THIS visit, even though both Alice and Bob were checked.
          assignees: [{ user_id: TECH_A, user: { first_name: 'Alice', last_name: 'Ng' } }],
        }],
      },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A, TECH_B], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T17:00:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    // Every existing key, byte-identical, PLUS the two Q6 additions - the full shape, not a subset.
    expect(res.body.conflicts[0]).toEqual({
      type: 'job',
      id: OTHER_JOB_ID,
      number: 'J00088',
      start: '2026-09-05T14:00:00.000Z',
      end: '2026-09-05T16:00:00.000Z',
      crew: [{ id: TECH_A, name: 'Alice Ng' }],
      customer_name: 'Jane Smith',
    });
  });

  it('names every clashing member on a multi-member clash', async () => {
    mockPrisma.job.findMany.mockResolvedValueOnce([
      {
        id: OTHER_JOB_ID,
        job_number: 'J00088',
        customer: { first_name: 'Jane', last_name: 'Smith', company_name: null },
        visits: [{
          id: 'v-clash-1',
          scheduled_at: new Date('2026-09-05T14:00:00Z'),
          scheduled_end: new Date('2026-09-05T16:00:00Z'),
          assignees: [
            { user_id: TECH_A, user: { first_name: 'Alice', last_name: 'Ng' } },
            { user_id: TECH_B, user: { first_name: 'Bob', last_name: 'Lee' } },
          ],
        }],
      },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A, TECH_B], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T17:00:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.conflicts[0].crew).toEqual([
      { id: TECH_A, name: 'Alice Ng' },
      { id: TECH_B, name: 'Bob Lee' },
    ]);
  });

  it('names the double-booked performer and the lead customer on a walkthrough clash', async () => {
    const LEAD_ID = 'l0000000-0000-0000-0000-0000000000f2';
    mockPrisma.job.findMany.mockResolvedValueOnce([]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([{
      id: 'wt-1',
      scheduled_at: new Date('2026-09-05T14:00:00Z'),
      duration_minutes: 60,
      assignees: [{ user_id: TECH_A, user: { first_name: 'Alice', last_name: 'Ng' } }],
      lead: {
        id: LEAD_ID,
        lead_number: 'L00077',
        // A company account: company_name wins when there is no first/last (same convention
        // notifyCustomerOfSchedule's outgoing email uses).
        customer: { first_name: null, last_name: null, company_name: 'Acme HVAC' },
      },
    }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T17:00:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.conflicts[0]).toMatchObject({
      type: 'walkthrough',
      id: LEAD_ID,
      number: 'L00077',
      crew: [{ id: TECH_A, name: 'Alice Ng' }],
      customer_name: 'Acme HVAC',
    });
  });
});

/**
 * D6 has no visible effect until the collection endpoint actually serves the crew. Everything on
 * the frontend side of this slice depends on this shape, so it is asserted through the HTTP
 * response rather than the service's return value.
 */
describe('GET /api/jobs/:id/visits - each visit carries its own crew, by name', () => {
  const VISIT_2 = 'e0000000-0000-0000-0000-000000000002';

  function visitRow(over: Record<string, unknown>) {
    return {
      id: VISIT_1,
      organization_id: ALPHA_ORG_ID,
      lead_id: null,
      job_id: JOB_ID,
      purpose: 'JOB',
      visit_seq: 1,
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-09-05T13:00:00Z'),
      scheduled_end: new Date('2026-09-05T15:00:00Z'),
      is_all_day: false,
      duration_minutes: 120,
      completed_at: null,
      notes: null,
      cancelled_at: null,
      cancelled_reason: null,
      created_at: new Date('2026-08-20T10:00:00Z'),
      updated_at: new Date('2026-08-20T10:00:00Z'),
      assignees: [],
      ...over,
    };
  }

  const person = (id: string) => {
    const u = Object.values(TEST_USERS).find((t) => t.id === id)!;
    return { id, first_name: u.first_name, last_name: u.last_name };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  });

  /**
   * Model Prisma's PROJECTION, not just its rows: a relation comes back only when the query asked
   * for it, and each of its rows carries only the FIELDS the nested select named. Without this the
   * fixture would hand `assignees` - nested `user` and all - to a findMany that never asked for
   * either, and the test would pass against a service that had stopped selecting them, proving
   * nothing. That is the projection-shaped version of a mock that ignores its where, and the nested
   * half matters as much as the outer one: the job side selects `user` deliberately where the lead
   * twin selects `user_id` alone, and a payload of bare ids makes crewMemberName() dereference
   * `member.user.first_name` on undefined and blank the whole Visits card.
   */
  function seedVisits(rows: Record<string, unknown>[]) {
    mockPrisma.visit.findMany.mockImplementation(async (args: any) => {
      const crewQuery = args?.include?.assignees ?? args?.select?.assignees;
      if (!crewQuery) return rows.map(({ assignees: _drop, ...rest }: any) => rest);
      const fields = crewQuery?.select;
      return rows.map(({ assignees, ...rest }: any) => ({
        ...rest,
        assignees: ((assignees ?? []) as Record<string, unknown>[]).map((a) =>
          fields ? Object.fromEntries(Object.entries(a).filter(([key]) => fields[key])) : a,
        ),
      }));
    });
  }

  it('serves each visit its own crew with names, earliest visit first', async () => {
    // Deliberately returned LATEST first, so the S2 ordering rule is still being proved rather
    // than accidentally satisfied by the fixture order.
    seedVisits([
      visitRow({
        id: VISIT_2,
        visit_seq: 2,
        scheduled_at: new Date('2026-09-09T13:00:00Z'),
        scheduled_end: new Date('2026-09-09T15:00:00Z'),
        assignees: [{ user_id: TECH_C, user: person(TECH_C) }],
      }),
      visitRow({
        assignees: [
          { user_id: TECH_A, user: person(TECH_A) },
          { user_id: TECH_B, user: person(TECH_B) },
        ],
      }),
    ]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/visits`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.visits.map((v: any) => v.id)).toEqual([VISIT_1, VISIT_2]);

    const first = res.body.visits[0];
    expect(Array.isArray(first.assignees)).toBe(true);
    expect(first.assignees.map((a: any) => a.user_id).sort()).toEqual([TECH_A, TECH_B].sort());
    // Names, not bare UUIDs: the job page has no flat crew projection to join against, unlike the
    // lead page, so the id-only shape the lead twin serves would render as raw UUIDs.
    expect(first.assignees[0].user).toMatchObject({
      id: first.assignees[0].user_id,
      first_name: expect.any(String),
      last_name: expect.any(String),
    });

    // Visit 2 names only its own crew - the crew is per visit, not per job.
    expect(res.body.visits[1].assignees.map((a: any) => a.user_id)).toEqual([TECH_C]);
  });
});

/**
 * User story 10's other half: crew per visit is only real if a visit's crew can be CHANGED, and
 * changed for that visit alone. The stateful stores are load-bearing here - the assertion is about
 * which rows survived a replace scoped to one visit, which a fixture-returning mock cannot show.
 */
describe('PATCH /api/jobs/:id/visits/:visitId - crew is replaced on that visit alone', () => {
  const VISIT_2 = 'e0000000-0000-0000-0000-000000000002';
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    tx = wireJobVisitTx(
      [
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_B },
        { visit_id: VISIT_2, job_id: JOB_ID, user_id: TECH_A },
      ],
      [TECH_A, TECH_B],
    );
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_1, assignees: [{ user_id: TECH_A }] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
  });

  const crewOf = (visitId: string) =>
    tx.visitCrew.rows.filter((r) => r.visit_id === visitId).map((r) => r.user_id).sort();

  it('replaces visit 1 crew, leaves visit 2 alone, and grows the union without pruning', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
        assignee_ids: [TECH_A, TECH_C],
      });

    expect(res.status).toBe(200);

    // Scoped to ONE row: visit 1 now holds exactly A and C.
    expect(crewOf(VISIT_1)).toEqual([TECH_A, TECH_C].sort());
    // ...and visit 2's crew is untouched by a write aimed at visit 1.
    expect(crewOf(VISIT_2)).toEqual([TECH_A]);

    // S8 (D6): the union is no longer a stored table - it is the set reachable across the job's
    // visits, which is exactly what OWN_JOB now selects on. C reaches the job because they are on
    // visit 1...
    const union = new Set(tx.visitCrew.rows.filter((r) => r.job_id === JOB_ID).map((r) => r.user_id));
    expect([...union]).toContain(TECH_C);
    // ...and B, dropped from visit 1, is genuinely off the job now, because visit 1 was the only
    // trip they were on. That is the honest consequence of crew living on the visit: there is no
    // second, job-level row left to keep them.
    expect([...union]).not.toContain(TECH_B);
  });
});

/**
 * A SEPARATE behaviour from the replace above, and it gets its own cycle because it is the one
 * that would silently destroy data: this is the exact body both VisitScheduleDialog trees send on
 * a plain drag-to-reschedule today. validate() REPLACES req.body with the parse result, so a
 * `.default([])` on assignee_ids would turn "the request did not mention crew" into "the crew is
 * now empty" - the identical trap the is_all_day comment on this very schema already documents.
 * A ratchet against that default ever being added.
 */
describe('PATCH /api/jobs/:id/visits/:visitId - omitting crew leaves the crew exactly as it was', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    tx = wireJobVisitTx(
      [
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_B },
      ],
      [TECH_A, TECH_B],
    );
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_1, assignees: [{ user_id: TECH_A }] });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.update.mockResolvedValue({
      id: VISIT_1, job_id: JOB_ID, visit_seq: 1,
      scheduled_at: new Date('2026-09-06T13:00:00Z'),
    });
  });

  it('moves the window and keeps both crew members', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(200);
    const moved = mockPrisma.visit.update.mock.calls[0][0];
    expect(moved.data.scheduled_at).toEqual(new Date('2026-09-06T13:00:00Z'));

    expect(tx.visitCrew.rows.filter((r) => r.visit_id === VISIT_1).map((r) => r.user_id).sort())
      .toEqual([TECH_A, TECH_B].sort());
    expect(tx.visitCrew.delegate.deleteMany).not.toHaveBeenCalled();
  });

  // Slice 02 (D1): this time-only body is what confirming a Plan Mode draft of a visit card sends.
  // Moving visit 1 must leave EVERY visit's crew alone - the job-level /assign it replaced moved
  // the job's next visit and stated crew job-wide, which emptied a sibling trip's crew.
  it('writes no crew row on any visit of the job', async () => {
    const VISIT_2 = 'e0000000-0000-0000-0000-000000000002';
    tx.visitCrew.rows.push({ visit_id: VISIT_2, job_id: JOB_ID, user_id: TECH_C });
    const before = tx.visitCrew.rows.map((r) => `${r.visit_id}:${r.user_id}`).sort();

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/visits/${VISIT_1}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(200);
    expect(tx.visitCrew.rows.map((r) => `${r.visit_id}:${r.user_id}`).sort()).toEqual(before);
    expect(tx.visitCrew.delegate.createMany).not.toHaveBeenCalled();
  });
});

/**
 * D6 must be true for NEW data too, not only for the rows the migration folded.
 *
 * POST /:id/assign is the Assign Technician dialog, the most-used scheduling surface in the
 * product. It already writes job-level crew and already books or moves a visit through
 * syncJobWindowOntoVisits - but nothing bridges them, so every booking made there produces a
 * crewless visit sitting beside a populated Team card: the two representations of one fact
 * disagreeing on the same page. This is the going-forward half of the migration's step 2, whose
 * rule (job-level crew lands on the job's FIRST visit) is exactly what is applied here to the one
 * visit the window sync touched.
 */
describe('POST /api/jobs/:id/assign - the crew it names lands on the visit it books or moves', () => {
  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;
  const NEW_VISIT = 'e0000000-0000-0000-0000-0000000000f1';

  function wire(liveVisits: Record<string, unknown>[], seed: VisitCrewRow[], jobCrew: string[]) {
    crew = jobCrewStore(JOB_ID, jobCrew);
    visitCrew = visitCrewStore(seed, { [VISIT_1]: JOB_ID, [NEW_VISIT]: JOB_ID });
    serveJobFromStore(visitCrew, {
      status: jobCrew.length ? 'SCHEDULED' : 'UNSCHEDULED',
      scheduled_start: jobCrew.length ? new Date('2026-09-05T13:00:00Z') : null,
    });
    mockPrisma.visit.findMany.mockResolvedValue(liveVisits);
    mockPrisma.visit.create.mockResolvedValue({ id: NEW_VISIT, job_id: JOB_ID, visit_seq: 1 });
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  }

  const crewOf = (visitId: string) =>
    visitCrew.rows.filter((r) => r.visit_id === visitId).map((r) => r.user_id).sort();

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
  });

  it('crews the visit it just created on a first booking', async () => {
    wire([], [], []);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A, TECH_B],
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expect(crewOf(NEW_VISIT)).toEqual([TECH_A, TECH_B].sort());
  });

  it('lands a newly named tech on the SAME visit row it moved, keeping its visit_seq', async () => {
    wire(
      [{
        id: VISIT_1, job_id: JOB_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'),
        scheduled_end: new Date('2026-09-05T15:00:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      }],
      [{ visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A }],
      [TECH_A],
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A, TECH_C],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
        force: true,
      });

    expect(res.status).toBe(200);
    // D19: the same row moved, so the crew change lands on that row's crew.
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(crewOf(VISIT_1)).toEqual([TECH_A, TECH_C].sort());
  });

  it('refuses a crew-only assign on a job with no trip at all', async () => {
    // S8 (D6 + D16), and this is a PRODUCT CHANGE rather than a refactor: with job_assignees gone
    // there is nowhere for a crew statement to live except a trip, and D16 forbids inventing an
    // untimed one (deriveJobStatusFromVisits would then answer SCHEDULED for a job with no date).
    // The old behaviour - 200, write nothing - is no longer honest, so it 400s and says why.
    wire([], [], []);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visit/i);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(visitCrew.delegate.createMany).not.toHaveBeenCalled();
  });
});

/**
 * The union already keeps the ROW (proved further up this file). What it does not yet keep is the
 * STORY told about that row: assign() and setAssignees() compute their notification diff from the
 * request body against the pre-read job, entirely independently of replaceJobCrew - which computes
 * the real delta, returns it, and has nobody consuming it. So a technician kept on the job
 * precisely because they are on another of its visits is told they were removed from it.
 *
 * Cosmetic in severity, staff-visible in effect, and it needs its own cycle because of an ordering
 * constraint: the PRE-read diff is also what scopes conflict detection, which must run before the
 * write, so the two diffs cannot simply be merged.
 */
describe('POST /api/jobs/:id/assign - nobody kept by the union is told they were removed', () => {
  const VISIT_2 = 'e0000000-0000-0000-0000-000000000002';
  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;
  let timelineCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    // A and B both hold job-level rows (the union). A is on visit 1, B on visit 2.
    crew = jobCrewStore(JOB_ID, [TECH_A, TECH_B]);
    visitCrew = visitCrewStore(
      [
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_2, job_id: JOB_ID, user_id: TECH_B },
      ],
      { [VISIT_1]: JOB_ID, [VISIT_2]: JOB_ID },
    );
    timelineCreate = vi.fn().mockResolvedValue({});

    serveJobFromStore(visitCrew, { status: 'SCHEDULED', scheduled_start: new Date('2026-09-05T13:00:00Z') });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: VISIT_1, job_id: JOB_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'),
        scheduled_end: new Date('2026-09-05T15:00:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      },
    ]);
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: timelineCreate },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  });

  it('writes no CREW_MEMBER_REMOVED and dispatches no unassign for a member the union kept', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A],
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
        force: true,
      });

    expect(res.status).toBe(200);
    // B's row survived - that is the union doing its job.
    expect([...crew.rows]).toContain(TECH_B);

    const removedEvents = timelineCreate.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.event_type === 'CREW_MEMBER_REMOVED');
    expect(removedEvents).toHaveLength(0);

    const unassigns = (emit as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e?.verb === 'dispatch.job_unassigned');
    expect(unassigns).toHaveLength(0);
  });
});

/**
 * The other half of the union rule, and the half that regressed: `job_assignees` holds a row iff
 * the last job-level crew write named the user OR they are still on one of the job's visits. When
 * NEITHER holds any more, the row must go.
 *
 * The case is the single-visit job - which is what the migration's step 2 produces for every
 * existing crewed job, and what the Assign dialog produces going forward - so it is the shape most
 * rows in the database are actually in. Removing a technician there is the most ordinary thing the
 * dispatcher does with this dialog.
 *
 * `job_assignees` is not a display list: OWN_JOB is `{ assignees: { some: { user_id } } }`, a
 * stored row-scope gating read/update/start/arrive/complete on Job, so a row left behind is a
 * technician who still holds a job nobody has them on, still receives its notifications and is
 * still told nothing. Asserted through the job detail payload, the timeline and the dispatch -
 * never by counting Prisma calls - so the ordering inside the transaction stays free to change.
 */
describe('POST /api/jobs/:id/assign - dropping a technician from the only visit removes them from the job', () => {
  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;
  let timelineCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    // The exact post-migration shape: both techs at job level, both on the job's ONE visit.
    crew = jobCrewStore(JOB_ID, [TECH_A, TECH_B]);
    visitCrew = visitCrewStore(
      [
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_B },
      ],
      { [VISIT_1]: JOB_ID },
    );
    timelineCreate = vi.fn().mockResolvedValue({});

    serveJobFromStore(visitCrew, { status: 'SCHEDULED', scheduled_start: new Date('2026-09-05T13:00:00Z') });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: VISIT_1, job_id: JOB_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'),
        scheduled_end: new Date('2026-09-05T15:00:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      },
    ]);
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_1, job_id: JOB_ID, visit_seq: 1 });

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: timelineCreate },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  });

  it('drops their job row, records the removal and tells them', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A],
        scheduled_start: '2026-09-05T13:00:00Z',
        scheduled_end: '2026-09-05T15:30:00Z',
      });

    expect(res.status).toBe(200);

    // B is off the visit the office just re-crewed...
    expect(visitCrew.rows.filter((r) => r.visit_id === VISIT_1).map((r) => r.user_id)).toEqual([TECH_A]);

    // ...so nothing keeps their job-level row, and the row-scope goes with it.
    const detail = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(detail.status).toBe(200);
    const ids = (detail.body.job.assignees as Array<{ user: { id: string } }>).map((a) => a.user.id);
    expect(ids).toEqual([TECH_A]);

    const removedEvents = timelineCreate.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.event_type === 'CREW_MEMBER_REMOVED');
    expect(removedEvents).toHaveLength(1);

    const unassigns = (emit as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e?.verb === 'dispatch.job_unassigned');
    expect(unassigns).toHaveLength(1);
    expect(unassigns[0].entity.assignee_ids).toEqual([TECH_B]);
  });
});

/**
 * User story 10, stated the other way round: "the two techs who pour concrete are not
 * automatically the ones who come back to finish."
 *
 * /assign carries a JOB-level crew statement - and the dialog seeds it from `job.assignees`, which
 * from S3 is the UNION over every visit. Restating that union verbatim on the one visit the window
 * sync touched books the finish crew onto the pour trip: a fact the request never asserted and the
 * dispatcher is never shown. It is the same fan-out the migration's step 2 avoids with
 * `JOIN LATERAL ... LIMIT 1`, and it compounds - every later Assign press re-seeds from the union
 * and re-fans, and from S4/S7 the per-visit crew decides who may start the visit and who is
 * emailed about it.
 *
 * What the request genuinely states is the CHANGE against the crew the dialog was showing, so that
 * is what lands on the visit: people newly named join the trip being booked, people dropped leave
 * it, and everyone else's visit membership is not the office's statement to make from here.
 */
describe('POST /api/jobs/:id/assign - moving one visit does not fan the job union onto it', () => {
  const VISIT_POUR = 'e0000000-0000-0000-0000-00000000000a';
  const VISIT_FINISH = 'e0000000-0000-0000-0000-00000000000b';
  let crew: ReturnType<typeof jobCrewStore>;
  let visitCrew: ReturnType<typeof visitCrewStore>;

  const crewOf = (visitId: string) =>
    visitCrew.rows.filter((r) => r.visit_id === visitId).map((r) => r.user_id).sort();

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    // The spec's concrete-install job: A pours on the 5th, B comes back to finish on the 8th.
    // job_assignees already holds both - syncJobCrewUnion grew it when visit 2 was booked - so the
    // Assign dialog seeds its crew picker with both names.
    crew = jobCrewStore(JOB_ID, [TECH_A, TECH_B]);
    visitCrew = visitCrewStore(
      [
        { visit_id: VISIT_POUR, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_FINISH, job_id: JOB_ID, user_id: TECH_B },
      ],
      { [VISIT_POUR]: JOB_ID, [VISIT_FINISH]: JOB_ID },
    );

    serveJobFromStore(visitCrew, { status: 'SCHEDULED', scheduled_start: new Date('2026-09-05T13:00:00Z') });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: VISIT_POUR, job_id: JOB_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'),
        scheduled_end: new Date('2026-09-05T15:00:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      },
      {
        id: VISIT_FINISH, job_id: JOB_ID, visit_seq: 2, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-08T13:00:00Z'),
        scheduled_end: new Date('2026-09-08T15:00:00Z'),
        created_at: new Date('2026-08-20T10:05:00Z'),
      },
    ]);
    mockPrisma.visit.update.mockResolvedValue({ id: VISIT_POUR, job_id: JOB_ID, visit_seq: 1 });

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        jobAssignee: crew.delegate,
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      }),
    );
  });

  it('leaves the pour crew alone when the office only moves its time', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        // Exactly what AssignJobDialog posts: the crew it was seeded with, unchanged.
        assignee_ids: [TECH_A, TECH_B],
        scheduled_start: '2026-09-05T14:00:00Z',
        scheduled_end: '2026-09-05T16:30:00Z',
      });

    expect(res.status).toBe(200);

    // The trip that moved still has only the tech who is on it...
    expect(crewOf(VISIT_POUR)).toEqual([TECH_A]);
    // ...and the visit nobody touched is untouched.
    expect(crewOf(VISIT_FINISH)).toEqual([TECH_B]);
    // The union - now derived across the trips rather than stored - is unchanged, so both still
    // reach the job.
    expect([...new Set(visitCrew.rows.filter((r) => r.job_id === JOB_ID).map((r) => r.user_id))].sort())
      .toEqual([TECH_A, TECH_B].sort());
  });

  it('puts a newly named technician on the trip being booked, and only that trip', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_A, TECH_B, TECH_C],
        scheduled_start: '2026-09-05T14:00:00Z',
        scheduled_end: '2026-09-05T16:30:00Z',
        force: true,
      });

    expect(res.status).toBe(200);

    expect(crewOf(VISIT_POUR)).toEqual([TECH_A, TECH_C].sort());
    expect(crewOf(VISIT_FINISH)).toEqual([TECH_B]);
    expect([...new Set(visitCrew.rows.filter((r) => r.job_id === JOB_ID).map((r) => r.user_id))].sort())
      .toEqual([TECH_A, TECH_B, TECH_C].sort());
  });
});

// ─── Multi-visit S8 (behaviour 6) ─────────────────────────────────────────────────────────────
// `job_assignees` is dropped, so the job payload's `assignees` key becomes the visit-derived
// UNION. The WIRE KEY DOES NOT CHANGE - that is what keeps eventPeople.ts -> eventAdapters'
// sharedJobFields placing board cards in technician lanes, and keeps TeamCard, jobsColumns,
// insights.ts and the copilot tool handlers working untouched.
describe('S8 - the job payload assignees key is the visit-derived union', () => {
  const U1 = TEST_USERS.technician.id;
  const U2 = TEST_USERS.dispatcher.id;
  const U3 = TEST_USERS.sales.id;
  const U4 = TEST_USERS.admin.id;

  function person(id: string) {
    return { id, first_name: 'F', last_name: 'L', role: 'TECHNICIAN', phone: null, email: null, avatar_path: null, department: null };
  }
  function jobVisit(seq: number, crew: string[], status = 'SCHEDULED') {
    return {
      id: `${JOB_ID}-v${seq}`,
      visit_seq: seq,
      status,
      scheduled_at: new Date('2026-09-01T14:00:00Z'),
      scheduled_end: new Date('2026-09-01T16:00:00Z'),
      is_all_day: false,
      // S8 (A5, RATIFIED): every visit here shares the SAME literal scheduled_at, so the
      // schedule projection's tie-break needs created_at whenever two-or-more visits are seeded.
      created_at: new Date(new Date('2026-08-01T00:00:00Z').getTime() + seq * 86_400_000),
      customer_email_sent_at: null,
      assignees: crew.map((u) => ({ user_id: u, user: person(u) })),
    };
  }

  function seedDetail(visits: ReturnType<typeof jobVisit>[]) {
    mockPrisma.job.findUnique.mockImplementation(async (args: any) =>
      args?.select?.id && Object.keys(args.select).length === 1
        ? { id: JOB_ID }
        : { ...JOB_FIXTURE, id: JOB_ID, visits, dispatcher: null, estimate: null, invoices: [], sub_status: null },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
  });

  it('dedupes the crew across visits and never selects the job-level relation', async () => {
    seedDetail([jobVisit(1, [U1, U2]), jobVisit(2, [U2, U3])]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const ids = (res.body.job.assignees as { user: { id: string } }[]).map((a) => a.user.id);
    expect([...ids].sort()).toEqual([U1, U2, U3].sort());
    expect(ids.filter((i) => i === U2)).toHaveLength(1);

    const detailCall = mockPrisma.job.findUnique.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => Object.keys(a.select).length > 1);
    expect(detailCall.select).not.toHaveProperty('assignees');
  });

  it('keeps a technician crewed only on a CANCELLED visit in the union', async () => {
    // syncJobCrewUnion's documented ANY-STATUS rule, and the row scope from behaviour 1, which
    // has no status filter either - so the payload must not narrow what the scope admits.
    seedDetail([jobVisit(1, [U1]), jobVisit(2, [U4], 'CANCELLED')]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const ids = (res.body.job.assignees as { user: { id: string } }[]).map((a) => a.user.id);
    expect(ids).toContain(U4);
  });
});

// ─── Multi-visit S8 (behaviour 8) ─────────────────────────────────────────────────────────────
// `job_assignees` is dropped, so a job-level crew statement has nowhere to land except a VISIT.
//
// THE HONEST CONSEQUENCE, named here because it is a product change and not a refactor: a crew
// statement on a job with NO trip at all stops being expressible. D16 forbids the alternative -
// an untimed live visit to hold the crew would make deriveJobStatusFromVisits answer SCHEDULED
// for a job with no date. It ships as a tested 400, not a silent no-op.
describe('S8 - a job-level crew statement lands on the current visit', () => {
  const CURRENT_VISIT = VISIT_3;

  function wire(visits: Array<{ id: string; status?: string; scheduled_at: Date | null }>, seed: VisitCrewRow[] = []) {
    const visitCrew = visitCrewStore(seed, { [VISIT_1]: JOB_ID, [VISIT_3]: JOB_ID });
    const rows = visits.map((v) => ({
      id: v.id,
      job_id: JOB_ID,
      lead_id: null,
      visit_seq: v.id === VISIT_1 ? 1 : 3,
      status: v.status ?? 'SCHEDULED',
      scheduled_at: v.scheduled_at,
      scheduled_end: v.scheduled_at ? new Date(v.scheduled_at.getTime() + 3600_000) : null,
      is_all_day: false,
      created_at: new Date('2026-08-01T00:00:00Z'),
      en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    }));
    mockPrisma.visit.findMany.mockResolvedValue(rows);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: vi.fn().mockResolvedValue(rows),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 3 } }),
        },
        visitAssignee: visitCrew.delegate,
        jobAssignee: mockPrisma.jobAssignee,
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
    return visitCrew;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, id: JOB_ID, visits: [], dispatcher: null, estimate: null, invoices: [], sub_status: null });
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
  });

  it('writes the stated crew onto the job current visit and never touches the dead table', async () => {
    // resolveCurrentJobVisit's rule: the trip that has BEGUN beats one that has not. Visit 3 is
    // under way; visit 1 is still ahead. So visit 3 is where a job-level statement lands, and
    // visit 1 must be left alone - a job can have several trips with different crews.
    const visitCrew = wire(
      [
        { id: VISIT_1, status: 'SCHEDULED', scheduled_at: new Date('2099-01-01T13:00:00Z') },
        { id: CURRENT_VISIT, status: 'IN_PROGRESS', scheduled_at: new Date('2026-08-01T13:00:00Z') },
      ],
      [
        { visit_id: CURRENT_VISIT, job_id: JOB_ID, user_id: TECH_C },
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_C },
      ],
    );
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, id: JOB_ID, dispatcher: null, estimate: null, invoices: [], sub_status: null,
      visits: [{ assignees: [{ user_id: TECH_C }] }],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A, TECH_B] });

    expect(res.status).toBe(200);
    expect(visitCrew.rows.filter((r) => r.visit_id === CURRENT_VISIT).map((r) => r.user_id).sort())
      .toEqual([TECH_A, TECH_B].sort());
    // The other trip is untouched - the statement is a delta on ONE visit, not a whole-job replace.
    expect(visitCrew.rows.filter((r) => r.visit_id === VISIT_1).map((r) => r.user_id)).toEqual([TECH_C]);

    expect(mockPrisma.jobAssignee.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.jobAssignee.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a crew statement on a job with no trip, and writes nothing', async () => {
    const visitCrew = wire([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visit|trip|schedule/i);
    expect(visitCrew.rows).toHaveLength(0);
    expect(mockPrisma.jobAssignee.createMany).not.toHaveBeenCalled();
  });

  it('still accepts /assign with a window on a visitless job, because that call books the trip', async () => {
    const visitCrew = wire([]);
    mockPrisma.visit.create.mockResolvedValue({ id: CURRENT_VISIT, job_id: JOB_ID, visit_seq: 1 });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A], scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:00:00Z' });

    expect(res.status).toBe(200);
    expect(visitCrew.rows.map((r) => r.user_id)).toContain(TECH_A);
  });
});

// ─── Multi-visit S8 (D19) ─────────────────────────────────────────────────────────────────────
// A job-level crew statement must land on a trip that is still LIVE. D19 keeps a completed or
// called-off visit forever, as history - "who did yesterday's work" and "who we told the customer
// was coming, before we called it off" are both answers the row is holding. A statement that
// resolves onto one of those rewrites history AND leaves the upcoming trip with the old crew, so
// the dispatcher's drag appears to do nothing while a technician is silently told they were
// dropped from a job they are still on.
//
// Its twin, stampCurrentJobVisitMilestone, has always pre-filtered to LIVE_VISIT_STATUSES.
describe('S8 - a job-level crew statement never lands on a finished or called-off trip', () => {
  const PAST_TRIP = VISIT_1;
  const UPCOMING_TRIP = VISIT_3;

  /** The tx `visit.findMany` HONOURS `where.status.in`, or the live filter is invisible here. */
  function wireTrips(pastStatus: 'COMPLETED' | 'CANCELLED') {
    const visitCrew = visitCrewStore(
      [
        { visit_id: PAST_TRIP, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: UPCOMING_TRIP, job_id: JOB_ID, user_id: TECH_A },
      ],
      { [PAST_TRIP]: JOB_ID, [UPCOMING_TRIP]: JOB_ID },
    );
    const rows = [
      {
        id: PAST_TRIP, job_id: JOB_ID, lead_id: null, visit_seq: 1, status: pastStatus,
        scheduled_at: new Date('2026-08-01T13:00:00Z'), scheduled_end: new Date('2026-08-01T15:00:00Z'),
        is_all_day: false, created_at: new Date('2026-07-01T00:00:00Z'),
        en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
      },
      {
        id: UPCOMING_TRIP, job_id: JOB_ID, lead_id: null, visit_seq: 2, status: 'SCHEDULED',
        scheduled_at: new Date('2099-01-05T13:00:00Z'), scheduled_end: new Date('2099-01-05T15:00:00Z'),
        is_all_day: false, created_at: new Date('2026-07-02T00:00:00Z'),
        en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
      },
    ];
    const honourStatus = vi.fn(async (args: any) => {
      const wanted: string[] | undefined = args?.where?.status?.in;
      return wanted ? rows.filter((r) => wanted.includes(r.status)) : rows;
    });
    mockPrisma.visit.findMany.mockImplementation(honourStatus);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: honourStatus,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 2 } }),
        },
        visitAssignee: visitCrew.delegate,
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, id: JOB_ID, dispatcher: null, estimate: null, invoices: [], sub_status: null,
      visits: [{ assignees: [{ user_id: TECH_A }] }],
    });
    return visitCrew;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
  });

  it('moves the UPCOMING trip and leaves a COMPLETED one as the record of who did that work', async () => {
    const visitCrew = wireTrips('COMPLETED');

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_B] });

    expect(res.status).toBe(200);
    expect(visitCrew.rows.filter((r) => r.visit_id === UPCOMING_TRIP).map((r) => r.user_id)).toEqual([TECH_B]);
    expect(visitCrew.rows.filter((r) => r.visit_id === PAST_TRIP).map((r) => r.user_id)).toEqual([TECH_A]);
  });

  it('skips a CANCELLED trip the same way', async () => {
    const visitCrew = wireTrips('CANCELLED');

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_B] });

    expect(res.status).toBe(200);
    expect(visitCrew.rows.filter((r) => r.visit_id === UPCOMING_TRIP).map((r) => r.user_id)).toEqual([TECH_B]);
    expect(visitCrew.rows.filter((r) => r.visit_id === PAST_TRIP).map((r) => r.user_id)).toEqual([TECH_A]);
  });
});

/**
 * visits-and-task-categories slice 02: the scheduler draws one card per trip, each carrying that
 * trip's own crew, so its lane swap and its editor's Save crew re-crew THAT trip. The job-level
 * door (/assignees) lands its statement on the job's CURRENT visit, which is visit 1 even when
 * the card that was dragged is visit 2. This is the per-visit twin: the same `assign Job` gate,
 * the same crew notices, addressed to the named visit.
 */
describe('POST /api/jobs/:id/visits/:visitId/assignees - re-crews the named visit alone', () => {
  const VISIT_2 = 'e0000000-0000-0000-0000-000000000002';
  let visitCrew: ReturnType<typeof visitCrewStore>;
  let timelineCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');

    // A is on visit 1 (the job's current trip), B on visit 2.
    visitCrew = visitCrewStore(
      [
        { visit_id: VISIT_1, job_id: JOB_ID, user_id: TECH_A },
        { visit_id: VISIT_2, job_id: JOB_ID, user_id: TECH_B },
      ],
      { [VISIT_1]: JOB_ID, [VISIT_2]: JOB_ID },
    );
    timelineCreate = vi.fn().mockResolvedValue({});
    serveJobFromStore(visitCrew, { status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockImplementation(async ({ where }: any) =>
      where?.id === VISIT_2 && where?.job_id === JOB_ID
        ? {
            id: VISIT_2, status: 'SCHEDULED', scheduled_at: new Date('2026-09-07T13:00:00Z'),
            assignees: visitCrew.rows.filter((r) => r.visit_id === VISIT_2).map((r) => ({ user_id: r.user_id })),
          }
        : null,
    );
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: VISIT_1, job_id: JOB_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'), scheduled_end: new Date('2026-09-05T15:00:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      },
    ]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visitAssignee: visitCrew.delegate,
        visit: { findMany: mockPrisma.visit.findMany },
        job: { findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: timelineCreate },
      }),
    );
  });

  const crewOf = (visitId: string) =>
    visitCrew.rows.filter((r) => r.visit_id === visitId).map((r) => r.user_id).sort();
  const emitted = (verb: string) =>
    (emit as any).mock.calls.map((c: any[]) => c[0]).filter((e: any) => e?.verb === verb);

  it('replaces visit 2\'s crew and leaves the current visit\'s crew alone', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits/${VISIT_2}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_C] });

    expect(res.status).toBe(200);
    expect(crewOf(VISIT_2)).toEqual([TECH_C]);
    expect(crewOf(VISIT_1)).toEqual([TECH_A]);
  });

  it('tells the person swapped in and the person swapped out, exactly as the job-level door does', async () => {
    await request(app)
      .post(`/api/jobs/${JOB_ID}/visits/${VISIT_2}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_C] });

    expect(emitted('dispatch.job_assigned').map((e: any) => e.entity.assignee_ids)).toEqual([[TECH_C]]);
    expect(emitted('dispatch.job_unassigned').map((e: any) => e.entity.assignee_ids)).toEqual([[TECH_B]]);
    const events = timelineCreate.mock.calls.map((c: any[]) => c[0]?.data?.event_type);
    expect(events).toEqual(expect.arrayContaining(['CREW_MEMBER_ADDED', 'CREW_MEMBER_REMOVED']));
    // A crew change is not a move: nothing here may read as the visit being rescheduled.
    expect(events).not.toContain('RESCHEDULED');
  });

  it('404s a visit that is not on this job, writing nothing', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits/${OTHER_JOB_VISIT}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_C] });

    expect(res.status).toBe(404);
    expect(visitCrew.delegate.createMany).not.toHaveBeenCalled();
    expect(visitCrew.delegate.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a cancelled visit, writing nothing', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_2, status: 'CANCELLED', scheduled_at: null, assignees: [] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/visits/${VISIT_2}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_C] });

    expect(res.status).toBe(409);
    expect(visitCrew.delegate.createMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/visits/:visitId/assignees - a malformed visit id (security review L2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'SCHEDULED', visits: [] });
    // What Postgres does with a non-uuid bound to a uuid column: the query throws (P2023).
    mockPrisma.visit.findFirst.mockRejectedValue(
      Object.assign(new Error('Inconsistent column data: Error creating UUID'), { code: 'P2023' }),
    );
  });

  it('answers "Visit not found" before any read, rather than failing the query', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/not-a-visit-id/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Visit not found' });
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.visit.findFirst).not.toHaveBeenCalled();
  });
});
