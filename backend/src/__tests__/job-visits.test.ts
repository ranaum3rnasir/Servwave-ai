/**
 * Multi-visit spec slice S2 - job visits on the job page.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> attachAbility ->
 * canDo -> validate -> controller -> service) with Prisma mocked, which is the seam the spec
 * names as the default for every behaviour in it. Nothing here reaches for an internal
 * function's shape, so splitting or renaming the visit service leaves these tests standing.
 *
 * The lead_id assertions are load-bearing rather than decorative: the S1 migration ships
 * `visits_exactly_one_parent CHECK (num_nonnulls(lead_id, job_id) = 1)`, which Prisma cannot
 * express and a fully-mocked Prisma cannot enforce. A write that sets both parents passes green
 * here and only fails against a real Postgres, so the written `data` shape is asserted directly.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { resolveJobScheduleWindow as computeJobScheduleWindow } from '../lib/job-schedule-projection';

// S7: the per-visit routes now feed the Automation Center. Mocked at the module boundary the way
// automation-wiring.test.ts does, so the assertions are about the EVENT this route emits and not
// about anything inside the engine.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;
// The whole lib/email module is mocked globally in setup.ts - these are those vi.fn()s.
import { sendJobScheduledEmail, sendJobRescheduledEmail, sendJobVisitCancelledEmail } from '../lib/email';
const mockScheduled = sendJobScheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockRescheduled = sendJobRescheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockCancelled = sendJobVisitCancelledEmail as unknown as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as Record<string, any>;

/** A job belonging to ORG_B - never reachable from an ALPHA_ORG caller. */
const OTHER_ORG_JOB_ID = 'j0000000-0000-0000-0000-0000000000b1';

/** The transaction the visit write and the D14 mirror share. */
function wireJobVisitTx() {
  const txVisitAggregate = vi.fn().mockResolvedValue({ _max: { visit_seq: null } });
  const txJobUpdate = vi.fn().mockResolvedValue(JOB_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        // The cancel writer's guard is an `updateMany` - without the delegate it is undefined on
        // this fake and the door 500s on a TypeError instead of exercising the guard.
        updateMany: mockPrisma.visit.updateMany,
        findMany: mockPrisma.visit.findMany,
        aggregate: txVisitAggregate,
      },
      // Multi-visit S3: the visit POST now writes crew in this same transaction. Without the
      // delegate the write throws INSIDE the tx and the route 500s opaquely.
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // S4: the derivation reads the job's CURRENT status on the TRANSACTION client rather than
      // trusting the caller's pre-transaction read, so the tx fake has to answer it.
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
  return { txVisitAggregate, txJobUpdate };
}

/**
 * THIS FILE'S CLOCK IS PINNED, and it has to be.
 *
 * The schedule projection under test is TIME-RELATIVE: `resolveNextJobVisit` keeps only visits
 * whose `scheduled_end` is after `new Date()`, and falls back to the earliest non-cancelled
 * visit when none qualifies. Half the fixtures below are absolute literals (`2026-09-05`,
 * `2026-09-01`) and half are computed off `Date.now()`. That mixture is a time bomb: on
 * 2026-09-01 at 15:30 UTC real time caught up with the `2026-09-01T13:00-15:30Z` fixture used
 * by "moves the mirror onto an EARLIER second visit", that visit stopped being upcoming, the
 * projection fell through to the later one, and the test began failing permanently. The
 * remaining `2026-09-05` fixtures were four days behind it.
 *
 * Pinning `now` to a fixed instant BEFORE every absolute fixture makes the whole file
 * deterministic for good, and leaves the `Date.now() ± N` cases meaning exactly what they meant
 * (they are relative to the pinned now, so "past" is still past and "future" still future).
 *
 * Only `Date` is faked. `setTimeout`/`setInterval` stay real, because supertest and express
 * drive genuine async here and swapping their timers out would hang the suite.
 *
 * PINNED AT MODULE SCOPE, NOT IN `beforeAll` — and that placement is load-bearing. Several
 * fixtures below are `const`s inside `describe` callbacks (`const past = new Date(Date.now() -
 * 5 * DAY)`), and describe callbacks run at COLLECTION time, before any `beforeAll` fires. Pin
 * in `beforeAll` and those consts are computed against the real clock while the assertions run
 * against the fake one, which silently inverts "past" and "future" and fails a different test
 * instead. Ask: is this value computed while the file is being read, or while a test is
 * running? Only the second kind is safe to set up in a hook.
 */
const PINNED_NOW = new Date('2026-08-25T09:00:00Z');

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(PINNED_NOW);

// Re-asserted per test so a global `restoreMocks`/timer reset between cases cannot quietly hand
// the clock back to real time mid-file.
beforeEach(() => {
  vi.setSystemTime(PINNED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

function visitRow(over: Record<string, unknown> = {}) {
  return {
    id: 'v0000000-0000-0000-0000-000000000001',
    // Multi-visit S6: the reschedule route reads the TRIP's own crew to scope its double-booking
    // warning (D21), so the row a `visit.findFirst` fake hands back has to carry the relation
    // the handler selects. Empty by default - the crew-bearing cases override it.
    assignees: [] as { user_id: string }[],
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    job_id: JOB_FIXTURE.id,
    purpose: 'WORK',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
    is_all_day: false,
    duration_minutes: 150,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    created_at: new Date('2026-08-20T10:00:00Z'),
    updated_at: new Date('2026-08-20T10:00:00Z'),
    ...over,
  };
}

/**
 * S8 (RATIFIED, A5) test helper: `visitRow()`'s `status` infers as a plain `string`, not the
 * Prisma `VisitStatus` literal union `resolveJobScheduleWindow` is typed against - this file's
 * fixtures build mocked rows, not real Prisma results, so a loose cast here is the pragmatic
 * seam rather than threading `as const` through every fixture in the file.
 */
function projectedSchedule(visits: ReturnType<typeof visitRow>[]) {
  return computeJobScheduleWindow(visits as never);
}

/**
 * Every `customer_email_sent_at` this request actually persisted, from whichever writer put it
 * there. The assertion these feed is about the ROW STATE - "does this trip now claim the customer
 * was told" - and deliberately not about which call shape wrote it, so moving the stamp between
 * the transaction and a post-commit write cannot make the test pass or fail for the wrong reason.
 */
function stampsWritten(...writers: any[]): unknown[] {
  return writers.flatMap((w) =>
    ((w?.mock?.calls ?? []) as any[][])
      .map((c) => c[0]?.data?.customer_email_sent_at)
      .filter((v) => v !== undefined),
  );
}

describe('POST /api/jobs/:id/visits - a job holds its own visits (S2)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    // Call history accumulates across tests otherwise, so `create.mock.calls[0]` would read the
    // PREVIOUS test's write and every assertion would pass or fail for the wrong reason.
    vi.clearAllMocks();
    // mockAuthAs installs a user.findUnique implementation that also resolves the caller's
    // ORGANIZATION - overriding it would drop the org to STARTER and 402 the whole router.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    tx = wireJobVisitTx();
  });

  it('books a visit parented on the job, not on a lead', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(201);
    expect(res.body.visit).toBeTruthy();

    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    // A NEW row, never an overwrite of an existing trip.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();

    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.job_id).toBe(JOB_FIXTURE.id);
    // D5's CHECK: exactly one parent. Invisible to the mock, so asserted here.
    expect(created.data.lead_id).toBeUndefined();
    expect(created.data.purpose).toBe('WORK');
    expect(created.data.organization_id).toBe(ALPHA_ORG_ID);
    expect(created.data.status).toBe('SCHEDULED');
    expect(new Date(created.data.scheduled_at).toISOString()).toBe('2026-09-05T13:00:00.000Z');
    expect(new Date(created.data.scheduled_end).toISOString()).toBe('2026-09-05T15:30:00.000Z');
  });
});

describe('POST /api/jobs/:id/visits - Job.scheduled_start mirrors the next upcoming visit (D14)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    tx = wireJobVisitTx();
  });

  it('writes the visit window onto the job, in the same transaction, without touching its history', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(201);

    // syncJobFromVisits still runs in the SAME transaction as the visit row (the span/status
    // re-derivation, S8 §4, is unaffected by this drop), and it no longer carries the schedule
    // mirror. The job's once-per-job "scheduled announcement happened" guard is the OTHER write
    // this first booking makes on the job row (scheduling-notifications PRD), and it rides the
    // same transaction as its own update rather than through the mirror's data fragment.
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    const updates = tx.txJobUpdate.mock.calls.map((c: any[]) => c[0].data);
    expect(updates.filter((d: any) => d.customer_scheduled_email_sent_at instanceof Date)).toHaveLength(1);
    const data = updates.find((d: any) => 'status' in d);
    expect(data).toBeDefined();
    // S8 (RATIFIED, A5): scheduled_start/scheduled_end are DROPPED as job columns - the wire key
    // is now a computed READ off `visits[]` (resolveJobScheduleWindow), asked here over the SAME
    // array `mockPrisma.visit.findMany` was primed with above (what a real re-read returns after
    // this write).
    const projected = projectedSchedule([visitRow()]);
    expect(projected.scheduled_start?.toISOString()).toBe('2026-09-05T13:00:00.000Z');
    expect(projected.scheduled_end?.toISOString()).toBe('2026-09-05T15:30:00.000Z');
    expect(data.status).toBe('SCHEDULED');

    // The failure D14 exists to prevent: assign() spreads milestoneClears('scheduled') whenever a
    // start is present, so a mirror routed through assign() (or reusing its data fragment) would
    // wipe visit 1's arrival and completion history and revive a cancelled job the moment the
    // office adds visit 3.
    expect(data).not.toHaveProperty('scheduled_start');
    expect(data).not.toHaveProperty('scheduled_end');
    expect(data).not.toHaveProperty('is_all_day');
    expect(data).not.toHaveProperty('en_route_at');
    expect(data).not.toHaveProperty('on_site_at');
    expect(data).not.toHaveProperty('started_at');
    expect(data).not.toHaveProperty('completed_at');
    expect(data).not.toHaveProperty('cancelled_at');
    expect(data).not.toHaveProperty('cancelled_reason');
    // The guard is its own write, never a passenger on the mirror's fragment.
    expect(data).not.toHaveProperty('customer_scheduled_email_sent_at');
  });
});

describe('POST /api/jobs/:id/visits - a later visit does not steal the mirror (D14)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  // RELATIVE TO NOW, NOT HARDCODED — and that is load-bearing, not tidiness.
  //
  // The projection under test is NOT time-neutral: `resolveNextJobVisit` prefers UPCOMING visits
  // (`(scheduled_end ?? scheduled_at) > now`) and only falls back to the earliest of ALL when none
  // are upcoming. A fixture pinned to a wall-clock date therefore changes meaning the day it slips
  // into the past — it stops being a "which upcoming visit wins" case and silently becomes a
  // "nothing is upcoming" case, which is a different test.
  //
  // This block used to book 2026-09-01 and 2026-09-05. At 15:30Z on 2026-09-01 the first date
  // elapsed mid-afternoon and `moves the mirror onto an EARLIER second visit` went red on EVERY
  // branch in the repo — four unrelated PRs inside half an hour, and one PR that had passed at
  // 14:54 failing at 15:58 with no change to its own code. It would have stayed red for ever,
  // because a fixed date only gets older.
  //
  // Both trips here are deliberately in the future, which is what makes "the earlier of two
  // upcoming visits wins" the question actually being asked. The sibling `elapsed visit` block
  // below already computes its dates this way; this one now matches it.
  const iso = (d: Date) => d.toISOString();
  const DAYS = 24 * 60 * 60 * 1000;
  const HOURS = 60 * 60 * 1000;
  const visit1Start = new Date(Date.now() + 10 * DAYS);
  const visit1End = new Date(visit1Start.getTime() + 2.5 * HOURS);

  const VISIT_1 = visitRow({
    id: 'v0000000-0000-0000-0000-000000000001',
    visit_seq: 1,
    scheduled_at: visit1Start,
    scheduled_end: visit1End,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    // The job already holds visit 1, so it is SCHEDULED before this request.
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    tx = wireJobVisitTx();
  });

  it('moves the mirror onto an EARLIER second visit', async () => {
    // Five days out: still upcoming, but sooner than VISIT_1's ten.
    const earlierStart = new Date(Date.now() + 5 * DAYS);
    const earlierEnd = new Date(earlierStart.getTime() + 2.5 * HOURS);
    const earlier = visitRow({
      id: 'v0000000-0000-0000-0000-000000000002',
      visit_seq: 2,
      scheduled_at: earlierStart,
      scheduled_end: earlierEnd,
    });
    mockPrisma.visit.create.mockResolvedValue(earlier);
    mockPrisma.visit.findMany.mockResolvedValue([VISIT_1, earlier]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: iso(earlierStart), scheduled_end: iso(earlierEnd) });

    expect(res.status).toBe(201);
    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection,
    // asked over the same post-write visit set, is what now answers "which visit wins".
    expect(projectedSchedule([VISIT_1, earlier]).scheduled_start?.toISOString()).toBe(iso(earlierStart));
  });

  it('leaves the mirror on visit 1 when the new visit is LATER', async () => {
    // D14's stated failure: "Conflating them would silently hide every later visit from the board
    // until the repoint lands - a wrong-data window in prod." Repointing the board at visit 3
    // would drop visit 1 out of this week's date range while it is still the next trip.
    // Seventeen days out: later than VISIT_1's ten, and both still upcoming.
    const laterStart = new Date(Date.now() + 17 * DAYS);
    const laterEnd = new Date(laterStart.getTime() + 2.5 * HOURS);
    const later = visitRow({
      id: 'v0000000-0000-0000-0000-000000000003',
      visit_seq: 2,
      scheduled_at: laterStart,
      scheduled_end: laterEnd,
    });
    mockPrisma.visit.create.mockResolvedValue(later);
    mockPrisma.visit.findMany.mockResolvedValue([VISIT_1, later]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: iso(laterStart), scheduled_end: iso(laterEnd) });

    expect(res.status).toBe(201);
    const { data } = tx.txJobUpdate.mock.calls[0][0];
    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection
    // now answers "which visit wins", over the same post-write visit set.
    expect(projectedSchedule([VISIT_1, later]).scheduled_start?.toISOString()).toBe(iso(visit1Start));
    // S2 asserted the status key was ABSENT here, because the mirror only ever promoted
    // UNSCHEDULED -> SCHEDULED. S4's D12 makes Job.status a DERIVED cache recomputed on every
    // visit write, so restating SCHEDULED is now the correct behaviour, not a stray write. What
    // still matters is the VALUE: two live, unstarted visits derive SCHEDULED and nothing else.
    expect(data.status).toBe('SCHEDULED');
  });
});

describe('POST /api/jobs/:id/visits - an elapsed visit does not hold the mirror (D14)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  // Relative to the clock the request runs on, so this cannot rot into "the past" or "the
  // future" the way fixed 2026 dates would.
  const DAY = 24 * 60 * 60 * 1000;
  const past = new Date(Date.now() - 5 * DAY);
  const pastEnd = new Date(past.getTime() + 2 * 60 * 60 * 1000);
  const future = new Date(Date.now() + 5 * DAY);
  const futureEnd = new Date(future.getTime() + 2 * 60 * 60 * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    tx = wireJobVisitTx();
  });

  it('mirrors the newly booked upcoming visit, not the trip that already happened', async () => {
    // D14 (ii) says the mirror is the NEXT UPCOMING visit. S2 ships no way for a job visit to
    // leave SCHEDULED (cancel/complete are S4), so visit 1 sits there for ever once its date
    // passes - and "earliest live" would pin the D14a "Next Visit" hero and the board to it,
    // leaving the trip the office just booked visible nowhere but this tab.
    const elapsed = visitRow({
      id: 'v0000000-0000-0000-0000-000000000001',
      visit_seq: 1,
      scheduled_at: past,
      scheduled_end: pastEnd,
    });
    const booked = visitRow({
      id: 'v0000000-0000-0000-0000-000000000002',
      visit_seq: 2,
      scheduled_at: future,
      scheduled_end: futureEnd,
      created_at: new Date('2026-08-21T10:00:00Z'),
    });
    mockPrisma.visit.create.mockResolvedValue(booked);
    mockPrisma.visit.findMany.mockResolvedValue([elapsed, booked]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: future.toISOString(), scheduled_end: futureEnd.toISOString() });

    expect(res.status).toBe(201);
    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection
    // now answers "which visit wins".
    expect(projectedSchedule([elapsed, booked]).scheduled_start?.toISOString()).toBe(future.toISOString());
  });

  it('stays on the visit that is under way rather than jumping to the next one', async () => {
    // "Upcoming" is measured on the END, not the start: the crew is on site right now, and
    // handing the mirror to next week would drop today's job off today's board.
    const underWay = visitRow({
      id: 'v0000000-0000-0000-0000-000000000001',
      visit_seq: 1,
      scheduled_at: new Date(Date.now() - 60 * 60 * 1000),
      scheduled_end: new Date(Date.now() + 60 * 60 * 1000),
    });
    const booked = visitRow({
      id: 'v0000000-0000-0000-0000-000000000002',
      visit_seq: 2,
      scheduled_at: future,
      scheduled_end: futureEnd,
      created_at: new Date('2026-08-21T10:00:00Z'),
    });
    mockPrisma.visit.create.mockResolvedValue(booked);
    mockPrisma.visit.findMany.mockResolvedValue([underWay, booked]);

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: future.toISOString(), scheduled_end: futureEnd.toISOString() });

    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection
    // now answers "which visit wins".
    expect(projectedSchedule([underWay, booked]).scheduled_start?.toISOString()).toBe(underWay.scheduled_at.toISOString());
  });

  it('keeps the earliest elapsed visit when every live visit is in the past', async () => {
    // The mirror must never go blank - the read-time projection is still what the board, search
    // and reports read (via the wire key it computes). With nothing upcoming, the job keeps the
    // window it already had (the fallback: earliest non-cancelled visit).
    const elapsed = visitRow({ visit_seq: 1, scheduled_at: past, scheduled_end: pastEnd });
    mockPrisma.visit.create.mockResolvedValue(elapsed);
    mockPrisma.visit.findMany.mockResolvedValue([elapsed]);

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: past.toISOString(), scheduled_end: pastEnd.toISOString() });

    expect(projectedSchedule([elapsed]).scheduled_start?.toISOString()).toBe(past.toISOString());
  });
});

describe('POST /api/jobs/:id/visits - an all-day visit keeps its flag and its window', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    tx = wireJobVisitTx();
  });

  it('round-trips an all-day visit onto the job', async () => {
    // assign() is the ONLY writer of Job.is_all_day today and it derives end = start + 24h from
    // that flag, so a visit that could not carry the flag would silently collapse an all-day job
    // to a 60-minute one on the first visit-driven write.
    const allDay = visitRow({
      is_all_day: true,
      scheduled_at: new Date('2026-09-05T00:00:00Z'),
      scheduled_end: new Date('2026-09-06T00:00:00Z'),
    });
    mockPrisma.visit.create.mockResolvedValue(allDay);
    mockPrisma.visit.findMany.mockResolvedValue([allDay]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-05T00:00:00Z',
        scheduled_end: '2026-09-06T00:00:00Z',
        is_all_day: true,
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.visit.create.mock.calls[0][0].data.is_all_day).toBe(true);

    // S8 (RATIFIED, A5): is_all_day/scheduled_start/scheduled_end are DROPPED as job columns -
    // the wire keys are a computed read off the visit set instead of a job.update write.
    const projected = projectedSchedule([allDay]);
    expect(projected.is_all_day).toBe(true);
    expect(projected.scheduled_start?.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(projected.scheduled_end?.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it('clears the flag when the next visit is an ordinary timed one', async () => {
    const timed = visitRow({ is_all_day: false });
    mockPrisma.visit.create.mockResolvedValue(timed);
    mockPrisma.visit.findMany.mockResolvedValue([timed]);

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(mockPrisma.visit.create.mock.calls[0][0].data.is_all_day).toBe(false);
    expect(projectedSchedule([timed]).is_all_day).toBe(false);
  });
});

describe('POST /api/jobs/:id/visits - which rows are even candidates for the mirror', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  const OTHER_JOB_ID = 'j0000000-0000-0000-0000-0000000000c1';
  const OTHER_ORG_ID = '00000000-0000-0000-0000-0000000000b0';

  /**
   * A findMany that actually HONOURS its `where`, unlike mockResolvedValue.
   *
   * The candidate rule - live statuses only, this org, this job - is delegated to Prisma, and a
   * mock that ignores the where returns the fixture list whatever the query asked for, so
   * deleting any of those three predicates leaves every other test in this file green. This fake
   * is the smallest thing that can tell the difference.
   */
  function seedVisitTable(rows: ReturnType<typeof visitRow>[]) {
    mockPrisma.visit.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      return rows.filter((r) => {
        if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
        if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        return true;
      });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    tx = wireJobVisitTx();
  });

  it('never mirrors a cancelled trip, another job\'s trip, or another org\'s trip', async () => {
    const booked = visitRow({
      id: 'v0000000-0000-0000-0000-000000000009',
      visit_seq: 2,
      scheduled_at: new Date('2026-09-09T13:00:00Z'),
      scheduled_end: new Date('2026-09-09T15:30:00Z'),
    });
    // Each decoy sits EARLIER than the booked visit, so it would win the mirror the moment its
    // own predicate went missing.
    seedVisitTable([
      visitRow({
        id: 'v-cancelled',
        visit_seq: 1,
        status: 'CANCELLED',
        scheduled_at: new Date('2026-09-01T13:00:00Z'),
        scheduled_end: new Date('2026-09-01T15:30:00Z'),
      }),
      visitRow({
        id: 'v-other-job',
        job_id: OTHER_JOB_ID,
        scheduled_at: new Date('2026-09-02T13:00:00Z'),
        scheduled_end: new Date('2026-09-02T15:30:00Z'),
      }),
      visitRow({
        id: 'v-other-org',
        organization_id: OTHER_ORG_ID,
        scheduled_at: new Date('2026-09-03T13:00:00Z'),
        scheduled_end: new Date('2026-09-03T15:30:00Z'),
      }),
      booked,
    ]);
    mockPrisma.visit.create.mockResolvedValue(booked);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-09T13:00:00Z', scheduled_end: '2026-09-09T15:30:00Z' });

    expect(res.status).toBe(201);
    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection
    // now answers "which visit wins", over the SAME rows this job's own visit set actually
    // contains (the other-job/other-org decoys are excluded by construction, exactly as
    // seedVisitTable's own `where.job_id`/`where.organization_id` filter excludes them for the
    // real query). A cancelled trip winning would put the job back on a date the customer called
    // off, and re-arm BEFORE_JOB_START against it.
    const onThisJob = [
      visitRow({
        id: 'v-cancelled', visit_seq: 1, status: 'CANCELLED',
        scheduled_at: new Date('2026-09-01T13:00:00Z'), scheduled_end: new Date('2026-09-01T15:30:00Z'),
      }),
      booked,
    ];
    expect(projectedSchedule(onThisJob).scheduled_start?.toISOString()).toBe('2026-09-09T13:00:00.000Z');
  });
});

describe('POST /api/jobs/:id/visits - visit numbers come from MAX, not from a count (D13)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.create.mockResolvedValue(visitRow({ visit_seq: 3 }));
    mockPrisma.visit.findMany.mockResolvedValue([visitRow({ visit_seq: 3 })]);
    tx = wireJobVisitTx();
  });

  it('numbers past a CANCELLED visit rather than reusing its number', async () => {
    // The job holds visit 1 (COMPLETED) and visit 2 (CANCELLED). A count would hand "Visit 2" to a
    // different trip - and that number has already been in a customer's inbox.
    tx.txVisitAggregate.mockResolvedValue({ _max: { visit_seq: 2 } });

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-20T13:00:00Z', scheduled_end: '2026-09-20T15:30:00Z' });

    expect(mockPrisma.visit.create.mock.calls[0][0].data.visit_seq).toBe(3);

    // The closest observable proxy for race-safety the mocked seam allows: the MAX is read on the
    // SAME transaction that writes the row. The lead-side twin reads it through the global client
    // from inside the transaction callback, so two concurrent POSTs there allocate the same number
    // and no unique constraint catches it.
    expect(tx.txVisitAggregate).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visit.aggregate).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/visits - a job in another org is invisible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    // The tenant-scoped probe finds nothing, which is exactly what `where: { id, ...tenantWhere }`
    // produces for a job belonging to another organization.
    mockPrisma.job.findUnique.mockResolvedValue(null);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    wireJobVisitTx();
  });

  it('404s and writes no row for another org\'s job', async () => {
    const res = await request(app)
      .post(`/api/jobs/${OTHER_ORG_JOB_ID}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(404);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    // The mock returns null whatever it is asked, so the 404 alone would survive a probe that
    // had lost its tenant clause. The clause itself is the thing under test.
    expect(mockPrisma.job.findUnique.mock.calls[0][0].where).toMatchObject({
      id: OTHER_ORG_JOB_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('POST /api/jobs/:id/visits - booking a visit needs the reschedule Job grant', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    tx = wireJobVisitTx();
  });

  it('403s a bare technician, who holds own-job update/start/arrive/complete but not reschedule', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('technician'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(tx.txJobUpdate).not.toHaveBeenCalled();
  });

  it('admits a dispatcher, who holds reschedule Job by default', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(201);
  });

  it('403s a technician GRANTED reschedule on a job that is not theirs', async () => {
    // The route gate only asks "may this principal ever reschedule". The row still has to be one
    // they may act on - the same per-instance check assign() applies - or a granted technician
    // could add visits to every job in the org.
    mockAuthAs('technician');
    (mockPrisma.rolePermission.findMany as any).mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g: any) => g.role === 'TECHNICIAN'),
      { role: 'TECHNICIAN', action: 'reschedule', subject: 'Job' },
    ]);
    clearPermissionCache();
    // The row-scoped probe finds nothing: this job is not one of theirs.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('technician'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T15:30:00Z' });

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });
});

describe('a visit window must be a real window', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(visitRow());
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    mockPrisma.visit.update.mockResolvedValue(visitRow());
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    tx = wireJobVisitTx();
  });

  // A zero-length visit is not a display nuisance: the mirror copies it onto the job, and
  // detectCrewConflicts overlaps with `scheduled_start < end AND scheduled_end > start`, which
  // can never match a zero-width block - so every double-booking check on that job passes.
  it('400s a booking whose end equals its start, and writes nothing', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-05T13:00:00Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(tx.txJobUpdate).not.toHaveBeenCalled();
  });

  it('400s a reschedule whose end is before its start, and moves nothing', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/v0000000-0000-0000-0000-000000000001`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-05T13:00:00Z', scheduled_end: '2026-09-04T13:00:00Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(tx.txJobUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/jobs/:id/visits/:visitId - reschedule moves the SAME row (D19)', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  const VISIT_1 = visitRow({ visit_seq: 1 });
  const MOVED = visitRow({
    visit_seq: 1,
    scheduled_at: new Date('2026-09-06T13:00:00Z'),
    scheduled_end: new Date('2026-09-06T15:30:00Z'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(VISIT_1);
    mockPrisma.visit.update.mockResolvedValue(MOVED);
    mockPrisma.visit.findMany.mockResolvedValue([MOVED]);
    tx = wireJobVisitTx();
  });

  it('rewrites the visit in place and re-mirrors the job', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(200);

    // D19: reschedule is the same row with a new time, never a new visit - the customer holds an
    // email referencing "Visit 1".
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    const updated = mockPrisma.visit.update.mock.calls[0][0];
    expect(updated.where.id).toBe(VISIT_1.id);
    expect(new Date(updated.data.scheduled_at).toISOString()).toBe('2026-09-06T13:00:00.000Z');
    expect(new Date(updated.data.scheduled_end).toISOString()).toBe('2026-09-06T15:30:00.000Z');
    // D13: the number never moves.
    expect(updated.data).not.toHaveProperty('visit_seq');

    // S8 (RATIFIED, A5): scheduled_start is DROPPED as a job column - the read-time projection
    // over the post-move visit set is what "re-mirrors the job" now.
    expect(projectedSchedule([MOVED]).scheduled_start?.toISOString()).toBe('2026-09-06T13:00:00.000Z');
  });

  it('404s a visit that belongs to another job or another org', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(404);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    // The 404 above is the mock's answer, not the scope rule's - a lookup that dropped `job_id`
    // or the tenant would also return null HERE while, against a real database, returning the
    // row. So the predicate is asserted directly, the same way the B1 CHECK is: without
    // `job_id`, PATCH /api/jobs/<A>/visits/<visit-of-B> rewrites job B's row and then mirrors
    // job A's window from job A's OWN visits - one office user silently editing another job's
    // schedule.
    expect(mockPrisma.visit.findFirst.mock.calls[0][0].where).toEqual({
      id: VISIT_1.id,
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('PATCH /api/jobs/:id/visits/:visitId - an omitted flag is not an edit', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  // The only way an all-day visit exists today: assign() wrote is_all_day=true and the S2
  // migration backfilled visit 1 from it. No dialog sends the field - ScheduleTimeFields has no
  // all-day control - so a schema DEFAULT turns "the user did not touch this" into an explicit
  // false, the mirror copies it onto the job, and a job the office booked for the whole day
  // drops out of the board's all-day strip and renders as a timed 24h block.
  const ALL_DAY = visitRow({
    is_all_day: true,
    scheduled_at: new Date('2026-09-05T00:00:00Z'),
    scheduled_end: new Date('2026-09-06T00:00:00Z'),
  });
  const MOVED = {
    ...ALL_DAY,
    scheduled_at: new Date('2026-09-06T00:00:00Z'),
    scheduled_end: new Date('2026-09-07T00:00:00Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(ALL_DAY);
    mockPrisma.visit.update.mockResolvedValue(MOVED);
    mockPrisma.visit.findMany.mockResolvedValue([MOVED]);
    tx = wireJobVisitTx();
  });

  it('keeps an all-day visit all-day when the request does not mention the flag', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${ALL_DAY.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T00:00:00Z', scheduled_end: '2026-09-07T00:00:00Z' });

    expect(res.status).toBe(200);
    // Invisible under the mocked seam unless asserted on the written payload: an absent key
    // leaves the stored flag alone, a written `false` destroys it.
    expect(mockPrisma.visit.update.mock.calls[0][0].data).not.toHaveProperty('is_all_day');
    // S8 (RATIFIED, A5): is_all_day is DROPPED as a job column - the read-time projection off the
    // post-write visit set (MOVED, still is_all_day:true since the write above left it alone) is
    // what keeps the job on the all-day strip now.
    expect(projectedSchedule([MOVED]).is_all_day).toBe(true);
  });

  it('still turns the flag off when the request says so explicitly', async () => {
    const timed = { ...MOVED, is_all_day: false };
    mockPrisma.visit.update.mockResolvedValue(timed);
    mockPrisma.visit.findMany.mockResolvedValue([timed]);

    await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${ALL_DAY.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z', is_all_day: false });

    expect(mockPrisma.visit.update.mock.calls[0][0].data.is_all_day).toBe(false);
  });
});

describe('PATCH /api/jobs/:id/visits/:visitId - pushing the current visit later hands the mirror on', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  const VISIT_1 = visitRow({
    id: 'v0000000-0000-0000-0000-000000000001',
    visit_seq: 1,
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
  });
  const VISIT_2 = visitRow({
    id: 'v0000000-0000-0000-0000-000000000002',
    visit_seq: 2,
    scheduled_at: new Date('2026-09-09T13:00:00Z'),
    scheduled_end: new Date('2026-09-09T15:30:00Z'),
    created_at: new Date('2026-08-21T10:00:00Z'),
  });
  const VISIT_1_MOVED = { ...VISIT_1, scheduled_at: new Date('2026-09-12T13:00:00Z'), scheduled_end: new Date('2026-09-12T15:30:00Z') };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(VISIT_1);
    mockPrisma.visit.update.mockResolvedValue(VISIT_1_MOVED);
    // The post-update live set: visit 1 has moved out to Sep 12, visit 2 is untouched on Sep 9.
    mockPrisma.visit.findMany.mockResolvedValue([VISIT_1_MOVED, VISIT_2]);
    tx = wireJobVisitTx();
  });

  it('mirrors visit 2, not the row that was just edited', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-12T13:00:00Z', scheduled_end: '2026-09-12T15:30:00Z' });

    expect(res.status).toBe(200);
    // S8 (RATIFIED, A5): scheduled_start/scheduled_end are DROPPED as job columns - the read-time
    // projection over the post-move visit set is what "hands the mirror on" to visit 2 now.
    const projected = projectedSchedule([VISIT_1_MOVED, VISIT_2]);
    expect(projected.scheduled_start?.toISOString()).toBe('2026-09-09T13:00:00.000Z');
    expect(projected.scheduled_end?.toISOString()).toBe('2026-09-09T15:30:00.000Z');
  });
});

describe('GET /api/jobs/:id/visits - sorted by time, labelled by creation order (D13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  });

  it('returns the job\'s visits in time order without renumbering them', async () => {
    // Booked 1, 2, 3 - but visit 3 was slotted in EARLIEST. Inserting an earlier trip must not
    // renumber a visit the customer has already been told about.
    mockPrisma.visit.findMany.mockResolvedValue([
      visitRow({ id: 'v-1', visit_seq: 1, scheduled_at: new Date('2026-09-05T13:00:00Z'), scheduled_end: new Date('2026-09-05T15:30:00Z'), created_at: new Date('2026-08-20T10:00:00Z') }),
      visitRow({ id: 'v-2', visit_seq: 2, scheduled_at: new Date('2026-09-09T13:00:00Z'), scheduled_end: new Date('2026-09-09T15:30:00Z'), created_at: new Date('2026-08-21T10:00:00Z') }),
      visitRow({ id: 'v-3', visit_seq: 3, scheduled_at: new Date('2026-09-01T13:00:00Z'), scheduled_end: new Date('2026-09-01T15:30:00Z'), created_at: new Date('2026-08-22T10:00:00Z') }),
    ]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.visits.map((v: any) => v.visit_seq)).toEqual([3, 1, 2]);
    expect(res.body.visits.map((v: any) => v.scheduled_at)).toEqual([
      '2026-09-01T13:00:00.000Z',
      '2026-09-05T13:00:00.000Z',
      '2026-09-09T13:00:00.000Z',
    ]);
    // What the page needs to render a row.
    const first = res.body.visits[0];
    expect(first).toMatchObject({
      id: 'v-3',
      visit_seq: 3,
      status: 'SCHEDULED',
      scheduled_end: '2026-09-01T15:30:00.000Z',
      is_all_day: false,
    });
  });

  it('404s a job in another org', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${OTHER_ORG_JOB_ID}/visits`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.job.findUnique.mock.calls[0][0].where).toMatchObject({
      id: OTHER_ORG_JOB_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('403s a technician reading the schedule of a job that is not theirs', async () => {
    // TECHNICIAN's `read Job` is CONDITIONAL (OWN_OR_CREATED_JOB), so the route gate - which is
    // subject-level - lets every technician through. Without the per-instance check, one
    // technician reads every crew's itinerary and per-visit notes for the whole org, while
    // GET /api/jobs/:id on the same row correctly 403s.
    mockAuthAs('technician');
    // The tenant probe finds the job: it IS in this org. The row-scope probe does not: the
    // technician is neither its assignee nor its creator.
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', assignees: [] });
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.visits).toBeUndefined();
  });
});

describe('POST /api/jobs/:id/assign - the one window the office books IS a visit', () => {
  // /assign is the OTHER writer of Job.scheduled_start (the hero tile, the board drag, the
  // Assign Technician dialog). D14 makes those three columns a write-through MIRROR of the visit
  // set, so a booking that writes them and no visit row leaves the two representations disagreeing
  // - and the next visit write, which recomputes the mirror from visits alone, silently deletes
  // the booking. Both entry points sit one click apart on the same page.
  function wireAssignTx() {
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const txJobUpdate = vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    const txVisitAggregate = vi.fn().mockResolvedValue({ _max: { visit_seq: null } });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
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
        // S4: the derivation reads the job's CURRENT status on the TRANSACTION client rather than
      // trusting the caller's pre-transaction read, so the tx fake has to answer it.
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: txVisitAggregate,
        },
      }),
    );
    return { txJobUpdate, txVisitAggregate };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    mockPrisma.visit.update.mockResolvedValue(visitRow());
  });

  it('books visit 1 when the job had none', async () => {
    // The reported failure: book Monday through the hero tile, then add Friday through the Visits
    // tab. Without a visit for Monday the mirror resolves over {Friday} alone and writes Friday
    // onto the job - Monday is gone from the board, from reports and from BEFORE_JOB_START, while
    // the customer holds an email for it.
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    const tx = wireAssignTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.job_id).toBe(JOB_FIXTURE.id);
    expect(created.data.purpose).toBe('WORK');
    // D5's CHECK: exactly one parent.
    expect(created.data.lead_id).toBeUndefined();
    expect(new Date(created.data.scheduled_at).toISOString()).toBe('2026-09-07T13:00:00.000Z');
    expect(new Date(created.data.scheduled_end).toISOString()).toBe('2026-09-07T15:30:00.000Z');
    expect(tx.txJobUpdate).toHaveBeenCalledTimes(1);
  });

  it('MOVES the next upcoming visit rather than minting a second one when the job is rescheduled', async () => {
    // D19: a reschedule is the same row with a new time. Minting a row here would hand a second
    // number to the same trip - and the customer already holds an email naming "Visit 1".
    const existing = visitRow({
      id: 'v0000000-0000-0000-0000-000000000001',
      visit_seq: 1,
      scheduled_at: new Date('2026-09-05T13:00:00Z'),
      scheduled_end: new Date('2026-09-05T15:30:00Z'),
    });
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-09-05T13:00:00Z'),
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([existing]);
    wireAssignTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    const updated = mockPrisma.visit.update.mock.calls[0][0];
    expect(updated.where.id).toBe(existing.id);
    expect(new Date(updated.data.scheduled_at).toISOString()).toBe('2026-09-06T13:00:00.000Z');
    expect(updated.data).not.toHaveProperty('visit_seq');
  });

  it('touches no visit on a crew-only assign, which carries no time at all', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-09-05T13:00:00Z'),
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    wireAssignTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [] });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/arrive and /start - the job-level verbs act on the job\'s current visit (S4 B9)', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const VISIT_1 = visitRow({
    id: 'v0000000-0000-0000-0000-000000000001',
    visit_seq: 1,
    scheduled_at: new Date(Date.now() + 5 * DAY),
    scheduled_end: new Date(Date.now() + 5 * DAY + 2.5 * HOUR),
  });
  const VISIT_2 = visitRow({
    id: 'v0000000-0000-0000-0000-000000000002',
    visit_seq: 2,
    scheduled_at: new Date(Date.now() + 12 * DAY),
    scheduled_end: new Date(Date.now() + 12 * DAY + 2.5 * HOUR),
    created_at: new Date(Date.now() - 20 * DAY),
  });

  /**
   * A visits table that HONOURS its where, seeded with three decoys.
   *
   * The whole rule of the job-level verbs lives in that predicate - this tenant, this job, LIVE
   * statuses only - and a mockResolvedValue returns its fixture list whatever the query asks, so
   * dropping `status: { in: LIVE_VISIT_STATUSES }` or `organization_id` left every assertion in
   * this describe green while, against a real database, the verb would stamp a trip the office
   * had already called off or one belonging to another tenant entirely. Each decoy is scheduled
   * EARLIER than visit 1, so any lost predicate hands the resolution to the decoy and the
   * `where.id` assertions below go red.
   */
  function seedJobVisits(rows: ReturnType<typeof visitRow>[]) {
    const table = [
      ...rows,
      visitRow({ id: 'v-cancelled', visit_seq: 0, status: 'CANCELLED', scheduled_at: new Date(Date.now() + 1 * DAY), scheduled_end: new Date(Date.now() + 1 * DAY + 2.5 * HOUR) }),
      visitRow({ id: 'v-other-org', organization_id: '00000000-0000-0000-0000-0000000000b0', scheduled_at: new Date(Date.now() + 2 * DAY), scheduled_end: new Date(Date.now() + 2 * DAY + 2.5 * HOUR) }),
      visitRow({ id: 'v-other-job', job_id: 'j0000000-0000-0000-0000-0000000000c1', scheduled_at: new Date(Date.now() + 3 * DAY), scheduled_end: new Date(Date.now() + 3 * DAY + 2.5 * HOUR) }),
    ];
    mockPrisma.visit.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      return table.filter((r) => {
        if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
        if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        return true;
      });
    });
    return table;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
    seedJobVisits([VISIT_1, VISIT_2]);
    mockPrisma.visit.update.mockResolvedValue(VISIT_1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the CURRENT visit when the shipped lifecycle bar posts /arrive', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // The truth moves to the visit underneath the old door: JobLifecycleBar, the copilot's
    // update_job_status and POST /:id/status all keep working unchanged, which is what keeps S5
    // out of S4.
    expect(mockPrisma.visit.update).toHaveBeenCalledTimes(1);
    const visitWrite = mockPrisma.visit.update.mock.calls[0][0];
    expect(visitWrite.where.id).toBe(VISIT_1.id);
    expect(visitWrite.data.status).toBe('ON_SITE');
    expect(visitWrite.data.on_site_at).toBeInstanceOf(Date);

    // S8 (RATIFIED): on_site_at is DROPPED from `jobs` entirely - S5 had already repointed the
    // lifecycle bar onto the visit set, leaving it with no reader anywhere, and this PR removes
    // the write too. Pinned as an absence, replacing the old "write is deliberately unchanged"
    // assertion this same comment used to make.
    expect(mockPrisma.job.update.mock.calls[0][0].data).not.toHaveProperty('on_site_at');
  });

  it('stamps the CURRENT visit when the bar posts /start', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visit.update.mock.calls[0][0].where.id).toBe(VISIT_1.id);
    expect(mockPrisma.visit.update.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
    expect(mockPrisma.visit.update.mock.calls[0][0].data.started_at).toBeInstanceOf(Date);
  });

  it('stamps the trip the crew is ON when it has run past its slot, not next week\'s', async () => {
    // The crew runs late: visit 1's window closed three hours ago and nobody has actioned it, and
    // visit 2 is next week. Resolving "the job's current visit" as the next UPCOMING one hands the
    // press to visit 2 - so the trip the technician is standing at stays SCHEDULED for ever while
    // next week's shows as already under way, and the per-visit history behind the customer's
    // "Visit 2" email records a start a week before it happened.
    const RAN_LATE = visitRow({
      id: 'v0000000-0000-0000-0000-00000000000a',
      visit_seq: 1,
      scheduled_at: new Date(Date.now() - 6 * HOUR),
      scheduled_end: new Date(Date.now() - 3 * HOUR),
    });
    const NEXT_WEEK = visitRow({
      id: 'v0000000-0000-0000-0000-00000000000b',
      visit_seq: 2,
      scheduled_at: new Date(Date.now() + 7 * DAY),
      scheduled_end: new Date(Date.now() + 7 * DAY + 2 * HOUR),
      created_at: new Date('2026-08-20T11:00:00Z'),
    });
    seedJobVisits([RAN_LATE, NEXT_WEEK]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visit.update.mock.calls[0][0].where.id).toBe(RAN_LATE.id);
    expect(mockPrisma.visit.update.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
  });

  it('never 500s on a job that has no visits at all', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    // S8 (RATIFIED): on_site_at is DROPPED from `jobs` - nothing writes it here any more.
    expect(mockPrisma.job.update.mock.calls[0][0].data).not.toHaveProperty('on_site_at');
  });
});

describe('POST /api/jobs/:id/complete - completing the JOB is a job-level fact (S4 B10, D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      started_at: new Date('2026-09-05T13:04:00Z'),
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.visit.findMany.mockResolvedValue([
      visitRow({ id: 'v-done', visit_seq: 1, status: 'COMPLETED' }),
      visitRow({
        id: 'v-open',
        visit_seq: 2,
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-12T13:00:00Z'),
        scheduled_end: new Date('2026-09-12T15:30:00Z'),
      }),
    ]);
  });

  it('closes the job without cascading onto its visits in either direction', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const jobData = mockPrisma.job.update.mock.calls[0][0].data;
    expect(jobData.status).toBe('COMPLETED');
    expect(jobData.completed_at).toBeInstanceOf(Date);

    // D19 gives the cascade to job CANCEL only. D7 is explicit that visit completion and job
    // completion are separate facts, so a job can be closed with a trip still on the books - and
    // the symmetric cascade is the natural over-reach while implementing the cancel one. This lock
    // is written BEFORE that cascade exists, deliberately.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/cancel - cancelling the JOB calls off its remaining trips (S4 B11, D19)', () => {
  const OTHER_JOB_ID = 'j0000000-0000-0000-0000-0000000000c1';
  const OTHER_ORG_ID = '00000000-0000-0000-0000-0000000000b0';

  /**
   * A seeded visits table whose updateMany actually HONOURS its where.
   *
   * The whole rule lives in that predicate - this job, this tenant, live statuses only - so a
   * mock that ignored the where and reported a count would report green for an implementation
   * that cancelled every visit in the org, or that overwrote a completed trip's history.
   */
  function seedVisits(rows: ReturnType<typeof visitRow>[]) {
    const table = rows;
    const updateMany = vi.fn().mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const hit = table.filter((r) => {
        if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
        if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        return true;
      });
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    });
    return { table, updateMany };
  }

  it('cancels the live visit, leaves the completed one as history, and touches nothing else', async () => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      invoices: [],
      source_plan_id: null,
    });

    const seeded = seedVisits([
      visitRow({
        id: 'v-done',
        visit_seq: 1,
        status: 'COMPLETED',
        completed_at: new Date('2026-07-20T16:00:00Z'),
      }),
      visitRow({
        id: 'v-open',
        visit_seq: 2,
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-12T13:00:00Z'),
      }),
      // Decoys: same org different job, and same job id in a different org. Either one moving
      // means the cascade lost a predicate.
      visitRow({ id: 'v-other-job', job_id: OTHER_JOB_ID, status: 'SCHEDULED' }),
      visitRow({ id: 'v-other-org', organization_id: OTHER_ORG_ID, status: 'SCHEDULED' }),
    ]);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'CANCELLED' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        visit: { updateMany: seeded.updateMany },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled the contract' });

    expect(res.status).toBe(200);

    const byId = Object.fromEntries(seeded.table.map((r) => [r.id, r]));
    // Exactly the live trip on THIS job moved.
    expect(byId['v-open'].status).toBe('CANCELLED');
    expect(byId['v-open'].cancelled_at).toBeInstanceOf(Date);
    expect(byId['v-open'].cancelled_reason).toBe('Customer cancelled the contract');
    // A completed trip is history: cancelling the job never rewrites what already happened, and
    // un-cancelling the job never revives what was called off.
    expect(byId['v-done'].status).toBe('COMPLETED');
    expect(byId['v-done'].completed_at).toEqual(new Date('2026-07-20T16:00:00Z'));
    expect(byId['v-other-job'].status).toBe('SCHEDULED');
    expect(byId['v-other-org'].status).toBe('SCHEDULED');
  });
});

describe('POST /api/jobs/:id/reopen - the service-plan slot comes back, the cancelled trips do not (S4 B12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'COMPLETED',
      job_number: 'J00001',
      source_plan_id: '00000000-0000-0000-0000-0000000000a1',
      invoices: [],
    });
    mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
    mockPrisma.planVisit.updateMany.mockResolvedValue({ count: 1 });
  });

  it('reverts the linked PlanVisit off COMPLETED so visits_remaining stops being permanently decremented', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // start() and arrive() both do this through clearsCompletion; reopen() never did, so a
    // reopened service-plan job left its PlanVisit COMPLETED for ever. Per-visit completion runs
    // this path far more often, which is why it is fixed here rather than filed.
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.planVisit.updateMany.mock.calls[0][0];
    expect(call.where.job_id).toBe(JOB_FIXTURE.id);
    expect(call.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(call.data).toEqual({ status: 'SCHEDULED', completed_at: null });
  });

  it('never revives the job\'s cancelled visits', async () => {
    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'))
      .send({});

    // D19: un-cancelling the job does not auto-revive its cancelled trips. This half needs no
    // production code and exists so nobody later adds a symmetric revive to pair with B11's
    // cascade.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/visits - booking the return trip does not un-start the job (D12, story 45)', () => {
  // The urgent workflow (CLAUDE.md): Lead -> Urgent Job, no estimate, no booking. The technician
  // goes NOW and presses Start, so the job carries started_at with no visit under it at all. The
  // office then books the return trip for a part - and the derivation, which only ever looked at
  // the visit set, answered SCHEDULED and wrote it over a job whose crew was on site.
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.create.mockResolvedValue(visitRow());
  });

  it('leaves a job started at job level IN_PROGRESS when its first visit is booked', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      started_at: new Date('2026-09-05T13:04:00Z'),
    });
    // The post-write set: one SCHEDULED trip, and nothing in it carries a start stamp - the work
    // that is under way was started before any visit existed.
    mockPrisma.visit.findMany.mockResolvedValue([visitRow({ status: 'SCHEDULED', started_at: null })]);
    const tx = wireJobVisitTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-12T13:00:00Z', scheduled_end: '2026-09-12T15:30:00Z' });

    expect(res.status).toBe(201);
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // Writing SCHEDULED here drops the job out of the board's in-flight colouring and out of the
    // in_progress KPI tile while the crew is standing in the customer's house.
    expect(jobData.status).not.toBe('SCHEDULED');
    expect(jobData.status).toBe('IN_PROGRESS');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/cancel - calling a trip off needs the ROW, not just the grant', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.visit.findFirst.mockResolvedValue({ id: VISIT_ID, job_id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow({ id: VISIT_ID })]);
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED', job_number: 'J00001' });
  });

  it('403s a technician GRANTED reschedule on a job that is not theirs', async () => {
    // `reschedule Job` is an OWN_JOB-scoped per-user capability and the route gate is
    // subject-level, so the grant alone says "may this principal EVER reschedule" - true for this
    // technician on every job in the org. Its three sibling visit routes (list, create,
    // reschedule) all ask the ROW as well. Without the same check here, one crew's technician can
    // call off another crew's trip - and if it was that job's last live visit the derivation
    // unschedules it and it drops off the dispatcher's board. PATCH on the very same row 403s.
    mockAuthAs('technician');
    (mockPrisma.rolePermission.findMany as any).mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g: any) => g.role === 'TECHNICIAN'),
      { role: 'TECHNICIAN', action: 'reschedule', subject: 'Job' },
    ]);
    clearPermissionCache();
    // The tenant probe finds the job; the row-scope probe does not.
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const tx = wireJobVisitTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/cancel`)
      .set(authHeader('technician'))
      .send({ cancelled_reason: 'not my trip' });

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(tx.txJobUpdate).not.toHaveBeenCalled();
  });

  it('admits a dispatcher, who holds reschedule Job by default', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.update.mockResolvedValue(visitRow({ id: VISIT_ID, status: 'CANCELLED' }));
    wireJobVisitTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/cancel`)
      .set(authHeader('dispatcher'))
      .send({ cancelled_reason: 'Customer rescheduled offline' });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledTimes(1);
  });
});

// ─── Q4 (multi-visit close-out) - a CANCELLED visit is immutable at the API ──────────────────
// Neither PATCH (reschedule) nor cancel nor the four milestone verbs ever read the visit's own
// `status` - none of them even selected the column - so a called-off trip could be moved, or
// re-cancelled with its reason silently overwritten. Worse: stampVisitMilestone also writes the
// visit's STATUS as well as its timestamp, so POSTing /start on a CANCELLED visit RESURRECTED it -
// a called-off trip came back IN_PROGRESS and reappeared on the dispatcher's board.
describe('a CANCELLED visit is immutable - every visit door refuses it with zero writes (Q4)', () => {
  const CANCELLED_VISIT = visitRow({
    status: 'CANCELLED',
    cancelled_at: new Date('2026-08-01T00:00:00Z'),
    cancelled_reason: 'Customer moved out',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockResolvedValue(CANCELLED_VISIT);
    mockPrisma.visit.findMany.mockResolvedValue([CANCELLED_VISIT]);
    wireJobVisitTx();
  });

  /** The row this test suite re-reads to prove NOTHING moved - every field PATCH/cancel/milestone can touch. */
  function assertVisitUntouched() {
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  }

  it('PATCH (reschedule) refuses with 409 and moves nothing', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
  });

  it('cancel refuses re-cancelling with 409, leaving the FIRST reason alone', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'a completely different reason' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
  });

  it('start refuses with 409 rather than resurrecting the trip as IN_PROGRESS', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
  });

  it('en-route refuses with 409 and dispatches no JOB_EN_ROUTE automation', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('arrive refuses with 409', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}/arrive`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
  });

  it('complete refuses with 409', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${CANCELLED_VISIT.id}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Visit is cancelled');
    assertVisitUntouched();
  });
});

describe('POST /api/jobs/:id/visits/:visitId/cancel - whitespace is not a reason (Q4)', () => {
  const LIVE_VISIT = visitRow();

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT);
    mockPrisma.visit.findMany.mockResolvedValue([LIVE_VISIT]);
    wireJobVisitTx();
  });

  it('400s a whitespace-only cancelled_reason before it ever reaches the row', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${LIVE_VISIT.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('trims a padded reason before it is persisted or emailed', async () => {
    mockPrisma.visit.update.mockResolvedValue({ ...LIVE_VISIT, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${LIVE_VISIT.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: '  Parts on backorder  ' });

    expect(res.status).toBe(200);
    const written = mockPrisma.visit.updateMany.mock.calls[0][0].data;
    expect(written.cancelled_reason).toBe('Parts on backorder');
  });
});

// ─── S7 / B2 (D18, user story 45) ────────────────────────────────────────────
// Booking an ADDITIONAL trip on an in-flight job has to reach the automation engine as its own
// occurrence. Keyed on the job alone, visit 2's "scheduled" workflow is swallowed by the
// [workflow_id, dedupe_key] unique constraint as a duplicate of visit 1's.
describe('POST /api/jobs/:id/visits - "Job is scheduled" is the job\'s first scheduled start, once', () => {
  // Scheduling-notifications PRD: the event fires the first time the job gains a scheduled start,
  // from whichever door booked it, and never again for that job. Booking a further trip beside
  // one the job already holds is not that moment (and moving a trip is JOB_RESCHEDULED, below).
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    tx = wireJobVisitTx();
  });

  const book = (start: string, end: string) =>
    request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: start, scheduled_end: end });

  function anUnscheduledJob() {
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED', visits: [] });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    mockPrisma.visit.create.mockResolvedValue(visitRow());
  }

  it('the first visit on an unscheduled job dispatches JOB_SCHEDULED naming the visit the transaction created', async () => {
    anUnscheduledJob();

    const res = await book('2026-09-05T13:00:00Z', '2026-09-05T15:30:00Z');

    expect(res.status).toBe(201);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const ev = mockDispatch.mock.calls[0][0];
    expect(ev.type).toBe('JOB_SCHEDULED');
    expect(ev.entity).toMatchObject({ type: 'job', id: JOB_FIXTURE.id, label: 'J00001' });
    // The row the transaction returned, never a re-read: this is what makes the event and the
    // persisted trip the same row.
    expect(ev.visitId).toBe(res.body.visit.id);
  });

  it('the first visit stamps the job\'s once-per-job guard in the same transaction', async () => {
    anUnscheduledJob();

    const res = await book('2026-09-05T13:00:00Z', '2026-09-05T15:30:00Z');

    expect(res.status).toBe(201);
    const stamped = tx.txJobUpdate.mock.calls
      .map((c: any[]) => c[0])
      .filter((call: any) => call.data?.customer_scheduled_email_sent_at instanceof Date);
    expect(stamped).toHaveLength(1);
    expect(stamped[0].where).toMatchObject({ id: JOB_FIXTURE.id, organization_id: ALPHA_ORG_ID });
  });

  it('a second visit beside one the job already holds dispatches nothing and stamps nothing', async () => {
    const created = visitRow({ id: 'v0000000-0000-0000-0000-0000000000c2', visit_seq: 2 });
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      visits: [visitRow()],
      customer_scheduled_email_sent_at: new Date('2026-08-20T10:05:00Z'),
    });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow(), created]);
    mockPrisma.visit.create.mockResolvedValue(created);

    const res = await book('2026-09-09T13:00:00Z', '2026-09-09T15:30:00Z');

    expect(res.status).toBe(201);
    expect(mockDispatch).not.toHaveBeenCalled();
    const updates = tx.txJobUpdate.mock.calls.map((c: any[]) => c[0].data ?? {});
    expect(updates.some((d: any) => 'customer_scheduled_email_sent_at' in d)).toBe(false);
  });
});

describe('POST /api/jobs/:id/assign - the job-level door keys on the same visit', () => {
  // The two doors must key identically or the same trip enrols twice: once from /assign with no
  // visit id and once from the visit route with one.
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockResolvedValue(visitRow());
    mockPrisma.visit.update.mockResolvedValue(visitRow());
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
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

  it('first-booking through /assign dispatches JOB_SCHEDULED carrying the visit it booked', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: ['00000000-0000-0000-0000-000000000004'],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
      });

    expect(res.status).toBe(200);
    const scheduled = mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === 'JOB_SCHEDULED');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].visitId).toBe(visitRow().id);
  });
});

// ─── S7 / B3 (D10, D13, cycle 4 - the #1522 class) ───────────────────────────
// The emailed visit and the persisted visit must be the SAME row. Every assertion here
// cross-checks a send argument against the write the transaction actually made, because
// "the sender was called" is exactly the test that let #1522 through.
//
// The job fixture is SPREAD rather than hand-rolled: createVisit's select now reads customer and
// service_location for the email body, and an undefined customer makes the send report
// `{ status: 'skipped', reason: 'no_recipient' }` instead of throwing - so a bare `{ id, status }`
// fixture would leave this whole describe green while asserting nothing.
describe('POST /api/jobs/:id/visits - per-visit customer email', () => {
  let tx: ReturnType<typeof wireJobVisitTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    // The fake HONOURS the write: the row handed back is the row that was written, so an
    // assertion comparing the send against the persisted row cannot pass by coincidence.
    mockPrisma.visit.create.mockImplementation(async (args: any) => ({
      ...visitRow({ id: 'v0000000-0000-0000-0000-0000000000c2' }),
      ...args.data,
    }));
    mockScheduled.mockResolvedValue({ status: 'sent' });
    tx = wireJobVisitTx();
    tx.txVisitAggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
  });

  function book(body: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-09T13:00:00Z', scheduled_end: '2026-09-09T15:30:00Z', ...body });
  }

  it('mails the trip it just wrote, names it by its persisted visit_seq, and stamps the row once it has gone', async () => {
    const res = await book({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    const sent = mockScheduled.mock.calls[0][0];
    const written = mockPrisma.visit.create.mock.calls[0][0].data;

    // D13: the number the customer reads is the number on the row.
    expect(written.visit_seq).toBe(2);
    expect(sent.visitSeq).toBe(written.visit_seq);
    // The SAME Date the transaction wrote, not a second reading of the request.
    expect(sent.scheduledStart).toBe(written.scheduled_at);
    expect(sent.to).toBe(JOB_FIXTURE.customer.email);
    expect(sent.jobNumber).toBe('J00001');
    // The reply anchor stays on the JOB: repointing it at the visit forks the customer's reply
    // thread per trip and orphans tokens already sitting in inboxes.
    expect(sent.record.entityType).toBe('job');
    expect(sent.record.entityId).toBe(JOB_FIXTURE.id);
    // The emailed row IS the stamped row: whichever writer records it, it is scoped to the id the
    // transaction returned, and the send that earned it is the one asserted above.
    expect(stampsWritten(mockPrisma.visit.create, mockPrisma.visit.update, mockPrisma.visit.updateMany))
      .toEqual([expect.any(Date)]);
    expect(mockPrisma.visit.updateMany.mock.calls[0][0].where).toMatchObject({
      id: res.body.visit.id,
      organization_id: ALPHA_ORG_ID,
    });
    // The caller is handed the stamped state, not a row that still reads "never announced".
    expect(res.body.visit.customer_email_sent_at).toBeTruthy();
  });

  it('a typed recipient overrides the saved address without writing it back', async () => {
    await book({ notify: { notify_customer: true, notify_recipient_email: 'ops@acme.test' } });
    expect(mockScheduled.mock.calls[0][0].to).toBe('ops@acme.test');
  });

  it('no address anywhere reports no_recipient on the 201 rather than a silent success', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      customer: { ...JOB_FIXTURE.customer, email: null },
    });

    const res = await book({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(res.body.notify).toEqual({ status: 'skipped', reason: 'no_recipient' });
    expect(mockScheduled).not.toHaveBeenCalled();
    // And the row must not claim otherwise. The stamp is the ONLY thing that answers "has this
    // customer ever been told about this trip": the visits card prints "Customer notified" off
    // it, and the next move reads it to choose between the scheduled and rescheduled templates.
    // Stamped on a send that never left, both of those lie - the customer's FIRST contact about
    // the trip would be a notice that it has been rescheduled.
    expect(stampsWritten(mockPrisma.visit.create, mockPrisma.visit.update, mockPrisma.visit.updateMany)).toEqual([]);
  });

  it('carries notify_cc_emails through to the send instead of stripping them', async () => {
    await book({
      notify: { notify_customer: true, notify_cc_emails: ['a@b.test', 'c@d.test'] },
    });
    expect(mockScheduled.mock.calls[0][0].cc).toEqual(['a@b.test', 'c@d.test']);
  });

  it('still 201s with the visit written when the send fails - the send is post-commit and never fatal', async () => {
    mockScheduled.mockResolvedValue({ status: 'failed', error: 'provider down' });

    const res = await book({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    expect(res.body.notify).toEqual({ status: 'failed', error: 'provider down' });
    // Same rule as the skipped case: the trip is booked, and nothing was told to anyone.
    expect(stampsWritten(mockPrisma.visit.create, mockPrisma.visit.update, mockPrisma.visit.updateMany)).toEqual([]);
  });
});

// ─── S7 / B4 (D10, D19, and the #1550 class) ─────────────────────────────────
// Which template a MOVE sends is decided by a fact about the row - has this trip ever been
// announced - and never by a status. #1550 shipped because the discriminator was
// `status === 'SCHEDULED'`; job status is derived and UNORDERED (D12/D17) and VisitStatus reads
// reassuringly, so neither is evidence about what the customer has been told.
describe('PATCH /api/jobs/:id/visits/:visitId - the move email', () => {
  function wireRescheduleTx() {
    const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => ({
      ...visitRow(),
      ...args.data,
      id: args.where.id,
      visit_seq: 2,
    }));
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: txVisitUpdate,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 2 } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
    return { txVisitUpdate };
  }

  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockScheduled.mockResolvedValue({ status: 'sent' });
    mockRescheduled.mockResolvedValue({ status: 'sent' });
  });

  function move(body: Record<string, unknown> = {}) {
    return request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-11T13:00:00Z', scheduled_end: '2026-09-11T15:30:00Z', ...body });
  }

  it('sends the RESCHEDULED template for a trip the customer has already been told about', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: new Date('2026-09-01T10:00:00Z') }),
    );
    const tx = wireRescheduleTx();

    const res = await move({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockScheduled).not.toHaveBeenCalled();
    const sent = mockRescheduled.mock.calls[0][0];
    const written = tx.txVisitUpdate.mock.calls[0][0].data;
    expect(sent.newScheduledStart).toBe(written.scheduled_at);
    expect(sent.visitSeq).toBe(2);
  });

  it('still sends RESCHEDULED with the visit IN_PROGRESS on a COMPLETED job - status is not evidence', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED' });
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({
        id: VISIT_ID,
        visit_seq: 2,
        status: 'IN_PROGRESS',
        customer_email_sent_at: new Date('2026-09-01T10:00:00Z'),
      }),
    );
    wireRescheduleTx();

    const res = await move({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('a trip booked silently and later moved with notify ticked is a FIRST announce, and stamps the flag', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: null }),
    );
    const tx = wireRescheduleTx();

    const res = await move({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(
      stampsWritten(tx.txVisitUpdate, mockPrisma.visit.update, mockPrisma.visit.updateMany),
    ).toEqual([expect.any(Date)]);
  });

  it('a first announce whose send FAILS leaves the trip unannounced, so the next try is not a "rescheduled"', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: null }),
    );
    mockScheduled.mockResolvedValue({ status: 'failed', error: 'provider down' });
    const tx = wireRescheduleTx();

    const res = await move({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(res.body.notify).toEqual({ status: 'failed', error: 'provider down' });
    // The trip moved; the customer still knows nothing about it. Stamping here would make the
    // NEXT ticked move send "your visit has been rescheduled" as the customer's first word on it.
    expect(
      stampsWritten(tx.txVisitUpdate, mockPrisma.visit.update, mockPrisma.visit.updateMany),
    ).toEqual([]);
  });

  it('D21: the rejected 409 attempt sends nothing, and the force retry sends exactly once', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: new Date('2026-09-01T10:00:00Z') }),
    );
    // The trip has to carry crew or there is nobody whose calendar could clash.
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({
        id: VISIT_ID,
        visit_seq: 2,
        customer_email_sent_at: new Date('2026-09-01T10:00:00Z'),
        assignees: [{ user_id: '00000000-0000-0000-0000-000000000004', user: { first_name: 'Test', last_name: 'Tech' } }],
      }),
    );
    wireRescheduleTx();
    mockPrisma.job.findMany.mockResolvedValue([
      {
        id: 'j0000000-0000-0000-0000-0000000000d9',
        job_number: 'J00099',
        visits: [{ id: 'v-clash', scheduled_at: new Date('2026-09-11T13:00:00Z'), scheduled_end: new Date('2026-09-11T15:00:00Z') }],
      },
    ]);

    const rejected = await move({ notify: { notify_customer: true } });
    expect(rejected.status).toBe(409);
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(mockScheduled).not.toHaveBeenCalled();

    const retried = await move({ force: true, notify: { notify_customer: true } });
    expect(retried.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
  });
});

// ─── S7 / B5 (D16, D19, user story 39) ───────────────────────────────────────
// Cancelling a visit unschedules THAT TRIP. It does not cancel the job, so the copy must not say
// it does - even when this was the job's last live trip and syncJobFromVisits derives the job to
// UNSCHEDULED in the same transaction.
describe('POST /api/jobs/:id/visits/:visitId/cancel - the customer is told the TRIP is off', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  function wireCancelTx() {
    // The cancel writer's guard is an `updateMany` carrying the whole payload; `update` runs after
    // it with an empty `data`, purely to re-read the row the door answers with. Both are fed from
    // ONE stored row, so the response reflects what the guarded write actually did - and a writer
    // that dropped its accept-set would be visible here rather than waved through.
    const stored: Record<string, unknown> = { ...visitRow({ id: VISIT_ID, visit_seq: 2 }) };
    const txVisitUpdateMany = vi.fn().mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (where.id !== stored.id) return { count: 0 };
      if (where.status?.in && !where.status.in.includes(stored.status)) return { count: 0 };
      Object.assign(stored, args?.data ?? {});
      return { count: 1 };
    });
    const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => {
      Object.assign(stored, args.data ?? {});
      return { ...stored };
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: txVisitUpdate,
          updateMany: txVisitUpdateMany,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 2 } }),
        },
        visitAssignee: { findMany: vi.fn().mockResolvedValue([]) },
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
    return { txVisitUpdate, txVisitUpdateMany };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, scheduled_at: new Date('2026-09-11T13:00:00Z') }),
    );
    mockCancelled.mockResolvedValue({ status: 'sent' });
  });

  function callOff(body: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Parts delayed', ...body });
  }

  it('mails the cancelled trip, naming it and its reason, anchored on the job', async () => {
    // One live trip left, so the derivation takes the job to UNSCHEDULED in the same transaction.
    mockPrisma.visit.findMany.mockResolvedValue([visitRow({ id: VISIT_ID, visit_seq: 2, status: 'CANCELLED' })]);
    const tx = wireCancelTx();

    const res = await callOff({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    const written = tx.txVisitUpdateMany.mock.calls[0][0].data;
    expect(written.status).toBe('CANCELLED');
    // D13: the number the customer already holds survives the cancel.
    expect(written).not.toHaveProperty('visit_seq');

    expect(mockCancelled).toHaveBeenCalledTimes(1);
    const sent = mockCancelled.mock.calls[0][0];
    expect(sent.visitSeq).toBe(2);
    expect(sent.reason).toBe('Parts delayed');
    expect(sent.jobNumber).toBe('J00001');
    expect(sent.to).toBe(JOB_FIXTURE.customer.email);
    expect(sent.record.entityType).toBe('job');
    expect(sent.record.entityId).toBe(JOB_FIXTURE.id);
    // The trip is off; the job is not. Cancelling the job is a different action entirely (D16).
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockRescheduled).not.toHaveBeenCalled();
  });

  it('sends nothing and still 200s when notify is omitted', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([]);
    wireCancelTx();

    const res = await callOff();

    expect(res.status).toBe(200);
    expect(mockCancelled).not.toHaveBeenCalled();
  });

  it('cancelling the job LAST live trip still sends the per-visit copy, not a job-cancelled one', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([]);
    wireCancelTx();

    const res = await callOff({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockCancelled).toHaveBeenCalledTimes(1);
    expect(mockCancelled.mock.calls[0][0].visitSeq).toBe(2);
  });
});

// ─── S7 / B6 (D23, the SRVW-243 rule per visit) ──────────────────────────────
// An explicit tick REPLACES the workflow for this occurrence rather than joining it. Two
// reasons, both from assign()'s comment: a workflow's send_window can defer delivery by hours,
// which is not what someone who just pressed "notify the customer" asked for; and an org holding
// the seeded default would otherwise mail the customer twice for one gesture. Only THIS
// occurrence is suppressed - the workflow stays enabled for every untick.
describe('the notify tick and the per-visit automation are alternatives, never both', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  function wireTx() {
    const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => ({
      ...visitRow({ id: VISIT_ID, visit_seq: 2 }),
      ...args.data,
    }));
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: txVisitUpdate,
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
    return { txVisitUpdate };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockImplementation(async (args: any) => ({
      ...visitRow({ id: VISIT_ID }),
      ...args.data,
    }));
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: new Date('2026-09-01T10:00:00Z') }),
    );
    mockScheduled.mockResolvedValue({ status: 'sent' });
    mockRescheduled.mockResolvedValue({ status: 'sent' });
    wireTx();
  });

  const book = (body: Record<string, unknown> = {}) =>
    request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-09T13:00:00Z', scheduled_end: '2026-09-09T15:30:00Z', ...body });

  const move = (body: Record<string, unknown> = {}) =>
    request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-11T13:00:00Z', scheduled_end: '2026-09-11T15:30:00Z', ...body });

  it('POST with the tick sends directly and suppresses THIS occurrence of JOB_SCHEDULED', async () => {
    const res = await book({ notify: { notify_customer: true } });
    expect(res.status).toBe(201);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('POST with notify omitted sends nothing and leaves the workflow to fire, keyed on the visit', async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({ type: 'JOB_SCHEDULED', visitId: res.body.visit.id });
  });

  // Q1: the third state. Bare `!notifyCustomer` was true for both "omitted" (fire, above) and
  // "explicitly declined" (must NOT fire - the caller said not to tell the customer, and letting
  // the workflow do it anyway is exactly what the decline was supposed to prevent).
  it('POST with notify_customer:false sends nothing AND dispatches no automation', async () => {
    const res = await book({ notify: { notify_customer: false } });
    expect(res.status).toBe(201);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('PATCH with the tick sends directly and suppresses THIS occurrence of JOB_RESCHEDULED', async () => {
    const res = await move({ notify: { notify_customer: true } });
    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('PATCH with notify_customer:false sends nothing AND dispatches no automation', async () => {
    const res = await move({ notify: { notify_customer: false } });
    expect(res.status).toBe(200);
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('PATCH with notify omitted dispatches JOB_RESCHEDULED with the visit id and a BARE new-start occurrence key', async () => {
    const res = await move();
    expect(res.status).toBe(200);
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const ev = mockDispatch.mock.calls[0][0];
    expect(ev.type).toBe('JOB_RESCHEDULED');
    expect(ev.visitId).toBe(VISIT_ID);
    // Unwidened - B1's contract. stopIf.ts and terminalStale.ts read this as an ISO timestamp and
    // silently kill the run on a mismatch.
    expect(ev.occurrenceKey).toBe('2026-09-11T13:00:00.000Z');
  });

  it('a PATCH with no notify key at all still returns the visit on a 200 - the standing contract', async () => {
    const res = await move();
    expect(res.status).toBe(200);
    expect(res.body.visit.id).toBe(VISIT_ID);
    expect(res.body).not.toHaveProperty('notify');
  });
});

// ─── S7 / B6b - the sibling audit row ────────────────────────────────────────
// The three schedule-changing visit writers wrote NO timeline row at all, while the lead-side
// twin has always written one. That matters beyond tidiness: #1550 was PROVED from prod data
// because a sibling timeline writer two lines from the send had recorded RESCHEDULED while the
// email said "Scheduled". The row and the send take their wording from the SAME hoisted const,
// so they agree by construction and a future investigator has the same evidence trail.
describe('per-visit timeline rows agree with the email that went out', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  function wireTx() {
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    // One stored row behind both writers: the cancel guard is an `updateMany` carrying the
    // payload, and `update` re-reads afterwards for the response - see wireCancelTx above.
    const stored: Record<string, unknown> = { ...visitRow({ id: VISIT_ID, visit_seq: 2 }) };
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: vi.fn().mockImplementation(async (args: any) => {
            Object.assign(stored, args.data ?? {});
            return { ...stored };
          }),
          updateMany: vi.fn().mockImplementation(async (args: any) => {
            const where = args?.where ?? {};
            if (where.id !== stored.id) return { count: 0 };
            if (where.status?.in && !where.status.in.includes(stored.status)) return { count: 0 };
            Object.assign(stored, args?.data ?? {});
            return { count: 1 };
          }),
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: txTimelineCreate },
      }),
    );
    return { txTimelineCreate };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.create.mockImplementation(async (args: any) => ({
      ...visitRow({ id: VISIT_ID }),
      ...args.data,
    }));
  });

  it('booking writes a SCHEDULED row naming the trip', async () => {
    const tx = wireTx();
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-09T13:00:00Z', scheduled_end: '2026-09-09T15:30:00Z' });

    expect(res.status).toBe(201);
    expect(tx.txTimelineCreate).toHaveBeenCalledTimes(1);
    const row = tx.txTimelineCreate.mock.calls[0][0].data;
    expect(row.entity_type).toBe('JOB');
    expect(row.entity_id).toBe(JOB_FIXTURE.id);
    expect(row.event_type).toBe('SCHEDULED');
    expect(row.description).toContain('Visit 2');
    expect(row.metadata).toMatchObject({ visit_id: VISIT_ID, visit_seq: 2, to: '2026-09-09T13:00:00.000Z' });
  });

  it('moving an announced trip writes RESCHEDULED - the SAME word its email uses', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: new Date('2026-09-01T10:00:00Z') }),
    );
    const tx = wireTx();

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-11T13:00:00Z', scheduled_end: '2026-09-11T15:30:00Z' });

    expect(res.status).toBe(200);
    const row = tx.txTimelineCreate.mock.calls[0][0].data;
    expect(row.event_type).toBe('RESCHEDULED');
    expect(row.description).toContain('Visit 2');
  });

  it('moving a NEVER-announced trip writes SCHEDULED, matching the template that would be sent', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: null }),
    );
    const tx = wireTx();

    await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-11T13:00:00Z', scheduled_end: '2026-09-11T15:30:00Z' });

    expect(tx.txTimelineCreate.mock.calls[0][0].data.event_type).toBe('SCHEDULED');
  });

  it('cancelling writes VISIT_CANCELLED with the reason, and does not claim the JOB was cancelled', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, scheduled_at: new Date('2026-09-11T13:00:00Z') }),
    );
    const tx = wireTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Parts delayed' });

    expect(res.status).toBe(200);
    const row = tx.txTimelineCreate.mock.calls[0][0].data;
    expect(row.event_type).toBe('VISIT_CANCELLED');
    expect(row.description).toContain('Visit 2');
    expect(row.description).toContain('Parts delayed');
    expect(row.description).not.toContain('Job J00001 cancelled');
  });
});

// ─── The move email names the crew that is actually going ────────────────────
// One PATCH can move a trip AND re-crew it - VisitScheduleDialog posts assignee_ids on every
// save when the picker is shown - so the crew read BEFORE the transaction is the OUTGOING one.
// "Technician: Alice" on a trip Bob is now taking is the same class of defect as #1550: the copy
// and the row disagree about what happened.
describe('PATCH /api/jobs/:id/visits/:visitId - a crew swap in the same request', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockRescheduled.mockResolvedValue({ status: 'sent' });
    // The trip currently carries Alice, who is being taken off it by this very request.
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({
        id: VISIT_ID,
        visit_seq: 2,
        customer_email_sent_at: new Date('2026-09-01T10:00:00Z'),
        assignees: [
          { user_id: '00000000-0000-0000-0000-0000000000a1', user: { first_name: 'Alice', last_name: 'Ng' } },
        ],
      }),
    );
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: vi.fn().mockImplementation(async (args: any) => ({
            ...visitRow(),
            ...args.data,
            id: args.where.id,
            visit_seq: 2,
          })),
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 2 } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('tells the customer who is coming NOW, not the crew the same request took off the trip', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-11T13:00:00Z',
        scheduled_end: '2026-09-11T15:30:00Z',
        force: true,
        assignee_ids: [TEST_USERS.technician.id],
        notify: { notify_customer: true },
      });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockRescheduled.mock.calls[0][0].technicianName).toBe('Test Tech');
    expect(mockRescheduled.mock.calls[0][0].technicianName).not.toContain('Alice');
  });

  it('keeps naming the trip crew when the request does not mention crew at all', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-11T13:00:00Z',
        scheduled_end: '2026-09-11T15:30:00Z',
        force: true,
        notify: { notify_customer: true },
      });

    expect(res.status).toBe(200);
    expect(mockRescheduled.mock.calls[0][0].technicianName).toBe('Alice Ng');
  });
});

// ─── S7 / D19, user story 39 - the OTHER door that calls a trip off ──────────
// "Move to Unscheduled" on a single-trip job cancels that job's live visits (B4), which is a
// cancelled trip by any other name: the card leaves the board and nobody is coming. The board's
// confirm offers the same opt-out the reschedule confirm does, so this route has to carry it or
// the tick is discarded in silence - a success toast over a customer who is still waiting in.
describe('POST /api/jobs/:id/unassign - the customer can be told the trip is off', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED', source_plan_id: null });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.visit.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.visit.findMany.mockResolvedValue([
      visitRow({ id: VISIT_ID, visit_seq: 1, scheduled_at: new Date('2026-09-11T13:00:00Z') }),
    ]);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockCancelled.mockResolvedValue({ status: 'sent' });
  });

  function unschedule(body: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/unassign`)
      .set(authHeader('admin'))
      .send(body);
  }

  it('mails the trip it just called off, naming it, and reports the outcome', async () => {
    const res = await unschedule({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockCancelled).toHaveBeenCalledTimes(1);
    const sent = mockCancelled.mock.calls[0][0];
    expect(sent.visitSeq).toBe(1);
    expect(sent.jobNumber).toBe('J00001');
    expect(sent.to).toBe(JOB_FIXTURE.customer.email);
    expect(sent.record.entityType).toBe('job');
    expect(res.body.notify).toEqual({ status: 'sent' });
    // The job is unscheduled, not cancelled - the copy must not claim otherwise (D16).
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockRescheduled).not.toHaveBeenCalled();
  });

  it('a typed recipient and a composed message ride along', async () => {
    await unschedule({
      notify: {
        notify_customer: true,
        notify_recipient_email: 'ops@acme.test',
        notify_cc_emails: ['a@b.test'],
        notify_message: 'Sorry - we have to move this one.',
      },
    });

    const sent = mockCancelled.mock.calls[0][0];
    expect(sent.to).toBe('ops@acme.test');
    expect(sent.cc).toEqual(['a@b.test']);
    expect(sent.message).toBe('Sorry - we have to move this one.');
  });

  it('omitting notify preserves the silence this gesture has always had', async () => {
    const res = await unschedule();

    expect(res.status).toBe(200);
    expect(mockCancelled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
  });

  it('a job with no live trip left to call off mails nobody, whatever the tick says', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await unschedule({ notify: { notify_customer: true } });

    expect(res.status).toBe(200);
    expect(mockCancelled).not.toHaveBeenCalled();
  });
});

// ─── S7 / D18's other half - the workflow has to render the RIGHT trip ───────
// The enrollment is visit-scoped now, but what the SEND_EMAIL step renders is not: context.ts's
// job branch resolves {{job.scheduled_date}} through Job.scheduled_start, which under D14 is the
// mirror of the NEXT UPCOMING visit. Add visit 3 for September to a job whose visit 2 sits in
// August and the customer is told visit 3 is on the August date. The trip that caused the
// occurrence travels with it, as the merge-field overrides the engine already carries per event.
describe('a per-visit automation renders the trip that triggered it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    // The job mirror points at the EARLIER trip - the one that did not move.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-08-25T13:00:00Z'),
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    wireJobVisitTx();
  });

  it('booking a later trip enrols with THAT trip date, not the job mirror', async () => {
    const created = visitRow({
      id: 'v0000000-0000-0000-0000-0000000000c3',
      visit_seq: 3,
      scheduled_at: new Date('2026-09-10T13:00:00Z'),
    });
    mockPrisma.visit.findMany.mockResolvedValue([visitRow(), created]);
    mockPrisma.visit.create.mockResolvedValue(created);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_start: '2026-09-10T13:00:00Z',
        scheduled_end: '2026-09-10T15:30:00Z',
        assignee_ids: [TEST_USERS.technician.id],
      });

    expect(res.status).toBe(201);
    const ev = mockDispatch.mock.calls[0][0];
    // The org zone (the fixture org has none, so America/New_York), never the server's UTC.
    expect(ev.eventPayload.mergeFields['job.scheduled_date']).toBe('Thu, Sep 10');
    expect(ev.eventPayload.mergeFields['job.scheduled_time']).toBe('9:00 AM');
    // And the crew going on THIS trip, not the job-level union.
    expect(ev.eventPayload.mergeFields['technician.names']).toBe('Test Tech');
  });

  it('moving one trip enrols the reschedule with the moved slot', async () => {
    const VISIT_ID = 'v0000000-0000-0000-0000-0000000000c2';
    mockPrisma.visit.findFirst.mockResolvedValue(
      visitRow({ id: VISIT_ID, visit_seq: 2, customer_email_sent_at: new Date('2026-09-01T10:00:00Z') }),
    );
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: vi.fn().mockImplementation(async (args: any) => ({
            ...visitRow({ id: VISIT_ID, visit_seq: 2 }),
            ...args.data,
          })),
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 2 } }),
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-14T18:00:00Z', scheduled_end: '2026-09-14T20:00:00Z' });

    expect(res.status).toBe(200);
    const ev = mockDispatch.mock.calls[0][0];
    expect(ev.type).toBe('JOB_RESCHEDULED');
    expect(ev.eventPayload.mergeFields['job.scheduled_date']).toBe('Mon, Sep 14');
    expect(ev.eventPayload.mergeFields['job.scheduled_time']).toBe('2:00 PM');
  });
});
