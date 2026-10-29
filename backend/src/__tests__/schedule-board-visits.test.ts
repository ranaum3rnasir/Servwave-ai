/**
 * Multi-visit spec slice S6 - the schedule board reads visits.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> attachAbility ->
 * canDo -> validate -> controller) with Prisma mocked, the same seam every other visit suite
 * uses. Nothing here reaches for an internal function's shape, so splitting or renaming the
 * query builder leaves these tests standing.
 *
 * The rule under test lives in a `where` PREDICATE, so `mockResolvedValue` would be theatre -
 * it returns the fixture list whatever the query asked for, and deleting the predicate would
 * stay green. `seedJobTable` below is a findMany that actually HONOURS its where, so a job
 * whose visit falls outside the window is excluded by the fake for the same reason Postgres
 * would exclude it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { LIVE_VISIT_STATUSES } from '../lib/visit-status';
import { JOB_FIXTURE, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const DAY = 24 * 60 * 60 * 1000;
// Clock-relative so a fixed 2026 date cannot rot the fixture out of the board's window.
const NOW = Date.now();
const WINDOW_START = new Date(NOW - 1 * DAY);
const WINDOW_END = new Date(NOW + 6 * DAY);

type SeedVisit = {
  id: string;
  visit_seq: number;
  status: string;
  scheduled_at: Date | null;
  scheduled_end: Date | null;
  is_all_day?: boolean;
  customer_email_sent_at?: Date | null;
  assignees?: unknown[];
} & Partial<typeof AT_SERVICE_ADDRESS_COLUMNS> & { location?: unknown };

/**
 * The six visit-location columns as every fixture in this file holds them: NULL, meaning the trip
 * is at the job's own service address (visit-location slice 6). They ride to the client beside the
 * resolved `location_label` - payload weight the board does not read - which is why they appear in
 * the expected payload below as well as on the seed.
 */
const AT_SERVICE_ADDRESS_COLUMNS = {
  location_id: null,
  location_address_line1: null,
  location_address_line2: null,
  location_city: null,
  location_state: null,
  location_zip: null,
};

/**
 * A seeded visit as the TABLE holds it: the six location columns are on every row, and the row can
 * be joined to its `Location`.
 *
 * Defaulted here rather than written out per fixture so the only question left for `projectVisit`
 * is the one this file exists to ask - did the SELECT ask for them. `location_label` is resolved
 * from the relation, and `projectJobVisitLocations` omits the key entirely for a select that never
 * asked for it, so a fixture missing these keys would let `jobListSelect` drop
 * `...visitLocationSelect` with every assertion below still green.
 */
function seedVisit(v: SeedVisit): SeedVisit {
  return { ...AT_SERVICE_ADDRESS_COLUMNS, location: null, ...v };
}

type SeedJob = {
  id: string;
  job_number: string;
  organization_id: string;
  status: string;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  visits: SeedVisit[];
};

function jobRow(over: Partial<SeedJob> & { id: string; job_number: string }): SeedJob {
  const row = {
    organization_id: ALPHA_ORG_ID,
    status: 'SCHEDULED',
    scheduled_start: null,
    scheduled_end: null,
    visits: [],
    ...over,
  };
  return { ...row, visits: row.visits.map(seedVisit) };
}

/** Does one `{ gte?, lte? }` range accept this instant? */
function inRange(value: Date | null | undefined, range: any): boolean {
  if (!range) return true;
  if (value == null) return false;
  const t = new Date(value).getTime();
  if (range.gte && t < new Date(range.gte).getTime()) return false;
  if (range.lte && t > new Date(range.lte).getTime()) return false;
  if (range.lt && t >= new Date(range.lt).getTime()) return false;
  if (range.gt && t <= new Date(range.gt).getTime()) return false;
  return true;
}

/** Evaluate one `visits.some` clause against a job's seeded visit rows. */
function someVisitMatches(visits: SeedVisit[], some: any): boolean {
  return visits.some((v) => {
    if (some.scheduled_at !== undefined && !inRange(v.scheduled_at, some.scheduled_at)) return false;
    if (some.scheduled_end !== undefined && !inRange(v.scheduled_end, some.scheduled_end)) return false;
    if (some.status?.not !== undefined && v.status === some.status.not) return false;
    if (some.status?.in !== undefined && !some.status.in.includes(v.status)) return false;
    return true;
  });
}

/**
 * Evaluate ONE top-level `where` clause (or one arm of an `OR`) against a seeded job row.
 *
 * Only the keys this suite's queries actually emit: the job's own `status`, a `visits.some`
 * relation filter, and a nested `OR` of the same. Prisma ORs at the row level, so the fake has
 * to as well - otherwise a predicate that widens the window with a second arm would be read as
 * if only the first arm existed.
 */
function matchesJobClause(row: SeedJob, clause: any): boolean {
  if (!clause) return true;
  if (Array.isArray(clause.OR)) {
    if (!clause.OR.some((arm: any) => matchesJobClause(row, arm))) return false;
  }
  if (clause.status !== undefined) {
    if (typeof clause.status === 'string' && row.status !== clause.status) return false;
    if (clause.status?.in && !clause.status.in.includes(row.status)) return false;
    if (clause.status?.not !== undefined && row.status === clause.status.not) return false;
  }
  if (clause.visits?.some && !someVisitMatches(row.visits, clause.visits.some)) return false;
  return true;
}

/**
 * Project one visit row through a nested `select.visits.select`, the way Prisma does.
 *
 * Without this the fake hands the whole seeded row back whatever the query asked for, so
 * dropping a field from `jobListSelect.visits.select` leaves the payload assertions green - the
 * field is in the response because the FIXTURE has it, not because the query asked for it. A
 * nested relation select (`assignees: { select: {...} }`) is kept whole: the question this file
 * asks is which FIELDS the row carries, not how the relation underneath is shaped.
 */
function projectVisit(v: SeedVisit, select: any): Record<string, unknown> {
  if (!select) return v as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (!select[key]) continue;
    if (key in v) out[key] = (v as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * A job.findMany that HONOURS its where - the whole point of this file.
 *
 * It evaluates the org, the status filter, the `scheduled_start` mirror range (still the only
 * range key the filter engine emits before this slice) and any `{ visits: { some } }` clause
 * pushed under AND. It also applies the nested `select.visits.where` AND the nested
 * `select.visits.select`, because the payload's visit array is both filtered and projected by
 * Prisma at that same seam.
 */
function seedJobTable(rows: SeedJob[]) {
  mockPrisma.job.findMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    const visitSelectWhere = args?.select?.visits?.where;
    const visitSelectFields = args?.select?.visits?.select;
    return rows
      .filter((r) => {
        if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
        if (where.status !== undefined) {
          if (typeof where.status === 'string' && r.status !== where.status) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
        }
        if (where.scheduled_start !== undefined && !inRange(r.scheduled_start, where.scheduled_start)) return false;
        if (where.scheduled_end !== undefined && !inRange(r.scheduled_end, where.scheduled_end)) return false;
        if ((where.visits as any)?.some && !someVisitMatches(r.visits, (where.visits as any).some)) return false;
        for (const clause of (where.AND ?? []) as any[]) {
          if (!matchesJobClause(r, clause)) return false;
        }
        return true;
      })
      .map((r) => ({
        ...r,
        visits: (visitSelectWhere
          ? r.visits.filter((v) => someVisitMatches([v], visitSelectWhere))
          : r.visits
        ).map((v) => projectVisit(v, visitSelectFields)),
      }));
  });
}

/** JOB-A: visit 1 five days BEFORE the window, visit 2 INSIDE it. The mirror holds visit 1. */
const JOB_A = jobRow({
  id: 'j0000000-0000-0000-0000-0000000000a1',
  job_number: 'J00041',
  scheduled_start: new Date(NOW - 6 * DAY),
  scheduled_end: new Date(NOW - 6 * DAY + 2 * 60 * 60 * 1000),
  visits: [
    {
      id: 'v1',
      visit_seq: 1,
      status: 'COMPLETED',
      scheduled_at: new Date(NOW - 6 * DAY),
      scheduled_end: new Date(NOW - 6 * DAY + 2 * 60 * 60 * 1000),
    },
    {
      id: 'v2',
      visit_seq: 2,
      status: 'SCHEDULED',
      scheduled_at: new Date(NOW + 2 * DAY),
      scheduled_end: new Date(NOW + 2 * DAY + 2 * 60 * 60 * 1000),
    },
  ],
});

/**
 * JOB-B: its only visit is AFTER the window, but its mirror still sits inside it - exactly the
 * divergence unassign() and PATCH leave behind today. A board reading the mirror shows it.
 */
const JOB_B = jobRow({
  id: 'j0000000-0000-0000-0000-0000000000b1',
  job_number: 'J00042',
  scheduled_start: new Date(NOW + 2 * DAY),
  scheduled_end: new Date(NOW + 2 * DAY + 60 * 60 * 1000),
  visits: [
    {
      id: 'v3',
      visit_seq: 1,
      status: 'SCHEDULED',
      scheduled_at: new Date(NOW + 20 * DAY),
      scheduled_end: new Date(NOW + 20 * DAY + 60 * 60 * 1000),
    },
  ],
});

/** JOB-C: no visits at all, mirror inside the window. */
const JOB_C = jobRow({
  id: 'j0000000-0000-0000-0000-0000000000c1',
  job_number: 'J00043',
  scheduled_start: new Date(NOW + 3 * DAY),
  scheduled_end: new Date(NOW + 3 * DAY + 60 * 60 * 1000),
  visits: [],
});

/** JOB-D: exactly one visit, inside the window, CANCELLED. A called-off trip is not on the board. */
const JOB_D = jobRow({
  id: 'j0000000-0000-0000-0000-0000000000d1',
  job_number: 'J00044',
  scheduled_start: null,
  scheduled_end: null,
  visits: [
    {
      id: 'v4',
      visit_seq: 1,
      status: 'CANCELLED',
      scheduled_at: new Date(NOW + 2 * DAY),
      scheduled_end: new Date(NOW + 2 * DAY + 60 * 60 * 1000),
    },
  ],
});

/**
 * JOB-E: exactly one visit, inside the window, COMPLETED. The board deliberately asks for
 * COMPLETED work and paints it faded, so a live-only filter would delete today's finished cards.
 */
const JOB_E = jobRow({
  id: 'j0000000-0000-0000-0000-0000000000e1',
  job_number: 'J00045',
  status: 'COMPLETED',
  scheduled_start: null,
  scheduled_end: null,
  visits: [
    {
      id: 'v5',
      visit_seq: 1,
      status: 'COMPLETED',
      scheduled_at: new Date(NOW + 1 * DAY),
      scheduled_end: new Date(NOW + 1 * DAY + 60 * 60 * 1000),
    },
  ],
});

/**
 * Every `visits.some` the emitted `where` contains, however it is nested under AND/OR. The
 * suite asks what the query MEANS, not how the builder happened to arrange its clauses - a
 * literal `toContainEqual` on `where.AND` reddens the moment a second arm is added, which is
 * exactly the implementation-shaped assertion this file's header disclaims.
 */
function collectVisitSomes(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (node.visits?.some) out.push(node.visits.some);
  for (const list of [node.AND, node.OR, node.NOT]) {
    for (const child of (Array.isArray(list) ? list : list ? [list] : [])) collectVisitSomes(child, out);
  }
  return out;
}

function boardRequest() {
  return request(app)
    .get('/api/jobs')
    .query({
      status: 'SCHEDULED',
      scheduled_after: WINDOW_START.toISOString(),
      scheduled_before: WINDOW_END.toISOString(),
      limit: 500,
    })
    .set(authHeader('dispatcher'));
}

describe('GET /api/jobs - the board window is a question about visits (S6, B1)', () => {
  beforeEach(() => {
    // Call history accumulates across tests otherwise, so `findMany.mock.calls[0]` would read
    // the PREVIOUS test's query and every assertion would pass for the wrong reason.
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  });

  it('returns a job whose SECOND visit falls in the window, and no job whose visits do not', async () => {
    seedJobTable([JOB_A, JOB_B, JOB_C]);

    const res = await boardRequest();

    expect(res.status).toBe(200);
    const numbers = res.body.jobs.map((j: any) => j.job_number);
    expect(numbers).toContain('J00041');
    expect(numbers).not.toContain('J00042');
    expect(numbers).not.toContain('J00043');
  });

  it('asks the question of the visit set, not of the job mirror', async () => {
    seedJobTable([JOB_A, JOB_B, JOB_C]);

    await boardRequest();

    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    // Deliberately NOT a literal match on the emitted clause: the arrangement of AND/OR is the
    // query builder's business and restructuring it must not redden a test. The two properties
    // that MATTER are asserted instead - the window is measured on the visit's own time, and the
    // `Job.scheduled_start` mirror is not consulted at all.
    const windows = collectVisitSomes(where);
    expect(windows.length).toBeGreaterThan(0);
    for (const some of windows) {
      expect(some.scheduled_at).toEqual({ gte: WINDOW_START, lte: WINDOW_END });
    }
    expect(where).not.toHaveProperty('scheduled_start');
  });
});

describe('GET /api/jobs - a cancelled trip is not on the board (S6, B2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  });

  it('excludes a job whose only in-window visit is CANCELLED, and keeps a COMPLETED one', async () => {
    seedJobTable([JOB_A, JOB_D, JOB_E]);

    const res = await request(app)
      .get('/api/jobs')
      .query({
        status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
        scheduled_after: WINDOW_START.toISOString(),
        scheduled_before: WINDOW_END.toISOString(),
        limit: 500,
      })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const numbers = res.body.jobs.map((j: any) => j.job_number);
    expect(numbers).not.toContain('J00044');
    // Not `status: { in: LIVE_VISIT_STATUSES }` - that list excludes COMPLETED.
    expect(numbers).toContain('J00045');
    expect(numbers).toContain('J00041');
  });

  it('carries the cancelled guard in the predicate it sends', async () => {
    seedJobTable([JOB_A, JOB_D, JOB_E]);

    await boardRequest();

    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(collectVisitSomes(where)).toContainEqual(
      expect.objectContaining({ status: { not: 'CANCELLED' } }),
    );
  });
});

describe('GET /api/jobs - a cancelled job is still findable by date (S6, B8)', () => {
  /**
   * A job called off with its trips: the row keeps its mirror and the visits keep their times
   * (D19 - a cancelled row is history, never deleted). It is the ONLY shape 263 staging rows
   * have, and the office list, the CSV export and the copilot job tool all reach it through the
   * same `scheduled_after`/`scheduled_before` window the board uses.
   */
  const CANCELLED_JOB = jobRow({
    id: 'j0000000-0000-0000-0000-0000000000g1',
    job_number: 'J00050',
    status: 'CANCELLED',
    scheduled_start: new Date(NOW + 2 * DAY),
    scheduled_end: new Date(NOW + 2 * DAY + 60 * 60 * 1000),
    visits: [
      {
        id: 'v10',
        visit_seq: 1,
        status: 'CANCELLED',
        scheduled_at: new Date(NOW + 2 * DAY),
        scheduled_end: new Date(NOW + 2 * DAY + 60 * 60 * 1000),
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    seedJobTable([CANCELLED_JOB, JOB_A, JOB_D]);
  });

  it('answers "which jobs did we cancel this week" with the cancelled job, not with nothing', async () => {
    const res = await request(app)
      .get('/api/jobs')
      .query({
        status: 'CANCELLED',
        scheduled_after: WINDOW_START.toISOString(),
        scheduled_before: WINDOW_END.toISOString(),
      })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j: any) => j.job_number)).toEqual(['J00050']);
  });

  it('keeps the called-off trip off the BOARD, which never asks for cancelled work', async () => {
    const res = await boardRequest();

    expect(res.status).toBe(200);
    const numbers = res.body.jobs.map((j: any) => j.job_number);
    expect(numbers).not.toContain('J00050');
    // JOB-D is a LIVE job whose only in-window trip was called off - still hidden (B2).
    expect(numbers).not.toContain('J00044');
    expect(numbers).toContain('J00041');
  });
});

describe('GET /api/jobs - the list payload carries the visit set (S6, B3)', () => {
  const V1_AT = new Date(NOW + 1 * DAY);
  const V1_END = new Date(NOW + 1 * DAY + 60 * 60 * 1000);
  const V2_AT = new Date(NOW + 3 * DAY);
  const V2_END = new Date(NOW + 3 * DAY + 90 * 60 * 1000);

  /** One job, two live trips and one called-off trip on the same job. */
  const FANNED = jobRow({
    id: 'j0000000-0000-0000-0000-0000000000f1',
    job_number: 'J00046',
    scheduled_start: V1_AT,
    scheduled_end: V1_END,
    visits: [
      {
        id: 'v1',
        visit_seq: 1,
        status: 'SCHEDULED',
        scheduled_at: V1_AT,
        scheduled_end: V1_END,
        is_all_day: false,
        customer_email_sent_at: null,
        assignees: [{ user_id: 'u1', user: { id: 'u1', first_name: 'Dana', last_name: 'Reed' } }],
      },
      {
        id: 'v2',
        visit_seq: 2,
        status: 'SCHEDULED',
        scheduled_at: V2_AT,
        scheduled_end: V2_END,
        is_all_day: false,
        customer_email_sent_at: null,
        assignees: [],
      },
      {
        id: 'v9',
        visit_seq: 3,
        status: 'CANCELLED',
        scheduled_at: V2_AT,
        scheduled_end: V2_END,
        is_all_day: false,
        customer_email_sent_at: null,
        assignees: [],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    seedJobTable([FANNED]);
  });

  it('returns each live visit on the row so the board can fan a job out into cards', async () => {
    const res = await boardRequest();

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].visits).toEqual([
      {
        id: 'v1',
        visit_seq: 1,
        status: 'SCHEDULED',
        scheduled_at: V1_AT.toISOString(),
        scheduled_end: V1_END.toISOString(),
        is_all_day: false,
        // S7: the board rows carry the per-visit send receipt too - see the case below.
        customer_email_sent_at: null,
        // Visit-location slice 6: where THIS trip is, already resolved. `null` is the answer for
        // every fixture here - all three are at the job's service address - and it is the answer
        // the board reads as "paint the job's address, as always". The key is PRESENT rather than
        // absent because the response is ENTITLED to make the statement: the select asked, and
        // `projectJobVisitLocations` omits the key for one that did not. Drop
        // `...visitLocationSelect` from `jobListSelect` and these three rows lose the key.
        location_label: null,
        // The six columns ride along beside the resolved label. Nothing on the board reads them -
        // they are payload weight, pinned here because this assertion is the payload's exact
        // shape and a silent widening is the thing it exists to catch.
        ...AT_SERVICE_ADDRESS_COLUMNS,
        assignees: [{ user_id: 'u1', user: { id: 'u1', first_name: 'Dana', last_name: 'Reed' } }],
      },
      {
        id: 'v2',
        visit_seq: 2,
        status: 'SCHEDULED',
        scheduled_at: V2_AT.toISOString(),
        scheduled_end: V2_END.toISOString(),
        is_all_day: false,
        customer_email_sent_at: null,
        location_label: null,
        ...AT_SERVICE_ADDRESS_COLUMNS,
        assignees: [],
      },
      // S8 (D6): the CANCELLED trip travels too. The row's `visits` is now the SOURCE of the
      // derived `assignees` wire key, and a technician crewed only on a called-off trip must
      // still appear there - the OWN_JOB row scope admits them, so the payload must not hide
      // them. The board is unaffected: eventAdapters.ts filters CANCELLED in code.
      {
        id: 'v9',
        visit_seq: 3,
        status: 'CANCELLED',
        scheduled_at: V2_AT.toISOString(),
        scheduled_end: V2_END.toISOString(),
        is_all_day: false,
        customer_email_sent_at: null,
        location_label: null,
        ...AT_SERVICE_ADDRESS_COLUMNS,
        assignees: [],
      },
    ]);
  });

  /**
   * The select-shape half of the same guarantee, stated the way the `customer_email_sent_at` case
   * above states its own: `jobListSelect` names its visit fields, so the location reaches the
   * board only because it is asked for BY NAME.
   *
   * The RELATION specifically. The six columns alone cannot resolve a company location - the name
   * and the street are on the `Location` row - so a select carrying only them would answer `null`
   * for a showroom booking, which reads exactly like a trip at the customer's own address.
   */
  it('asks for the location RELATION, without which it could not say where a trip is', async () => {
    await boardRequest();

    const visitSelect = mockPrisma.job.findMany.mock.calls[0][0].select.visits.select;
    expect(visitSelect.location).toBeTruthy();
    expect(visitSelect.location_id).toBe(true);
  });

  /**
   * S7 (user story 40). jobListSelect names its visit fields explicitly, so unlike the per-job
   * visits route - which uses `include` with no select and ships every column automatically - a
   * new column NEVER reaches the board without being added here. That asymmetry is the trap: the
   * job page renders the receipt while the board's rows silently lack the field.
   */
  it('carries the per-visit customer_email_sent_at, which the named select would otherwise drop', async () => {
    const TOLD_AT = new Date(NOW - 2 * DAY);
    seedJobTable([{
      ...FANNED,
      visits: [{ ...FANNED.visits[0]!, customer_email_sent_at: TOLD_AT }],
    }]);

    const res = await boardRequest();

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].visits[0].customer_email_sent_at).toBe(TOLD_AT.toISOString());
    expect(mockPrisma.job.findMany.mock.calls[0][0].select.visits.select.customer_email_sent_at).toBe(true);
  });

  it('asks Prisma for EVERY trip, cancelled ones included', async () => {
    // S6 filtered CANCELLED out here; S8 removed that filter deliberately, because the same
    // relation now feeds the job's derived `assignees` key and the row scope that gates it. A
    // status filter on the payload would let a technician the API admits vanish from the crew
    // list - or, read the other way, offer a card the API then refuses.
    await boardRequest();

    expect(mockPrisma.job.findMany.mock.calls[0][0].select.visits.where).toBeUndefined();
  });
});

describe('POST /api/jobs/:id/unassign - removing a job from the board leaves no live trip (S6, B4)', () => {
  const JOB_ID = JOB_FIXTURE.id;

  const twoLiveVisits: SeedVisit[] = [
    {
      id: 'v1',
      visit_seq: 1,
      status: 'SCHEDULED',
      scheduled_at: new Date(NOW + 1 * DAY),
      scheduled_end: new Date(NOW + 1 * DAY + 60 * 60 * 1000),
    },
    {
      id: 'v2',
      visit_seq: 2,
      status: 'SCHEDULED',
      scheduled_at: new Date(NOW + 3 * DAY),
      scheduled_end: new Date(NOW + 3 * DAY + 60 * 60 * 1000),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_ID,
      status: 'SCHEDULED',
      job_number: 'J00047',
      source_plan_id: null,
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.visit.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  });

  it('cancels every live trip on the job, and the job then leaves the board window', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/unassign`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job_id: JOB_ID,
          organization_id: ALPHA_ORG_ID,
          status: { in: [...LIVE_VISIT_STATUSES] },
        }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );

    // D16: unscheduled means no live visits. The board asks the visit set, so the surviving
    // rows are what decides whether the card is gone - assert the observable consequence.
    seedJobTable([
      jobRow({
        id: JOB_ID,
        job_number: 'J00047',
        status: 'UNSCHEDULED',
        visits: twoLiveVisits.map((v) => ({ ...v, status: 'CANCELLED' })),
      }),
    ]);
    const board = await boardRequest();
    expect(board.body.jobs.map((j: any) => j.job_number)).not.toContain('J00047');
  });
});

describe('PATCH /api/jobs/:id - a reschedule moves the trip, not just the mirror (S6, B5)', () => {
  const JOB_ID = JOB_FIXTURE.id;
  const T0 = new Date(NOW + 1 * DAY);
  const T1 = new Date(NOW + 4 * DAY);
  const T1_END = new Date(T1.getTime() + 2 * 60 * 60 * 1000);

  let txVisitUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_ID,
      status: 'SCHEDULED',
      customer_id: JOB_FIXTURE.customer_id,
      source_plan_id: null,
      service_location: { state: 'TX' },
      assignees: [],
      estimate: null,
      scheduled_start: T0,
      scheduled_end: new Date(T0.getTime() + 60 * 60 * 1000),
      is_all_day: false,
      customer: { tax_exempt: false },
      job_line_items: [],
      scopes: null,
      discount_type: null,
      discount_value: null,
      custom_fields: null,
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);

    txVisitUpdate = vi.fn().mockResolvedValue({ id: 'v1' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v1', visit_seq: 1 }),
          update: txVisitUpdate,
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'v1',
              visit_seq: 1,
              status: 'SCHEDULED',
              scheduled_at: T0,
              scheduled_end: new Date(T0.getTime() + 60 * 60 * 1000),
              created_at: new Date(NOW - 10 * DAY),
            },
          ]),
          findFirst: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
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
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  });

  it('moves the job\'s live visit onto the new window, on the transaction client', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: T1.toISOString(), scheduled_end: T1_END.toISOString() });

    expect(res.status).toBe(200);
    expect(txVisitUpdate).toHaveBeenCalledTimes(1);
    // The whole write is one transaction, so a visit moved on the module-level client would be
    // outside it - committed even when the job update rolls back.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(txVisitUpdate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ scheduled_at: T1, scheduled_end: T1_END }),
    );
  });

  it('puts the job in the board window it was moved to, and takes it out of the old one', async () => {
    await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: T1.toISOString(), scheduled_end: T1_END.toISOString() });

    // Seeded from what the PATCH ACTUALLY wrote, not from the test's own expectation - a
    // handler that never moved the trip leaves this undefined and the case cannot pass by
    // restating its fixture. The mirror is left at T0 on purpose: the board must not read it.
    const written = txVisitUpdate.mock.calls[0][0].data;
    const moved = jobRow({
      id: JOB_ID,
      job_number: 'J00048',
      scheduled_start: T0,
      scheduled_end: new Date(T0.getTime() + 60 * 60 * 1000),
      visits: [{
        id: 'v1',
        visit_seq: 1,
        status: 'SCHEDULED',
        scheduled_at: written.scheduled_at,
        scheduled_end: written.scheduled_end,
      }],
    });
    seedJobTable([moved]);

    const around = async (centre: Date) =>
      request(app)
        .get('/api/jobs')
        .query({
          status: 'SCHEDULED',
          scheduled_after: new Date(centre.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          scheduled_before: new Date(centre.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        })
        .set(authHeader('dispatcher'));

    const atT1 = await around(T1);
    expect(atT1.body.jobs.map((j: any) => j.job_number)).toContain('J00048');
    const atT0 = await around(T0);
    expect(atT0.body.jobs.map((j: any) => j.job_number)).not.toContain('J00048');
  });
});

describe('GET /api/leads - a cancelled walkthrough is not on the board either (S6, B6)', () => {
  type SeedLead = {
    id: string;
    lead_number: string;
    organization_id: string;
    lead_assignees?: Array<{ user_id: string }>;
    visits: Array<SeedVisit & { assignees?: Array<{ user_id: string }> }>;
  };

  /** Does ONE visit satisfy a `visits: { some: ... }` predicate? */
  function visitMatches(v: SeedLead['visits'][number], some: any): boolean {
    if (some.scheduled_at !== undefined && !inRange(v.scheduled_at, some.scheduled_at)) return false;
    if (some.status?.not !== undefined && v.status === some.status.not) return false;
    if (some.assignees?.some?.user_id !== undefined) {
      const wanted = some.assignees.some.user_id;
      if (!(v.assignees ?? []).some((a: { user_id: string }) => a.user_id === wanted)) return false;
    }
    return true;
  }

  /**
   * Does a lead satisfy a `where`? Honours the shapes this door composes: the tenant key, a
   * `visits.some` clause (the TECHNICIAN's OWN_WALKTHROUGH row scope), a `lead_assignees.some`
   * clause (SALES's OWN_LEAD), and `AND` / `OR` lists of the same - each clause evaluated on its
   * own, the way Postgres evaluates two separate EXISTS, so a merged and a composed predicate are
   * told apart by the result and not only by the shape.
   */
  function leadMatches(r: SeedLead, where: any): boolean {
    if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
    const some = where.visits?.some;
    if (some && !r.visits.some((v) => visitMatches(v, some))) return false;
    const own = where.lead_assignees?.some?.user_id;
    if (own !== undefined && !(r.lead_assignees ?? []).some((a) => a.user_id === own)) return false;
    for (const clause of (where.AND as any[] | undefined) ?? []) if (!leadMatches(r, clause)) return false;
    if (Array.isArray(where.OR) && !where.OR.some((c: any) => leadMatches(r, c))) return false;
    return true;
  }

  function seedLeadTable(rows: SeedLead[]) {
    mockPrisma.lead.findMany.mockImplementation(async (args: any) =>
      rows.filter((r) => leadMatches(r, args?.where ?? {})));
  }

  const IN_WINDOW = new Date(NOW + 2 * DAY);
  const BEFORE_WINDOW = new Date(NOW - 5 * DAY);
  const TECH = TEST_USERS.technician.id;
  const OTHER_TECH = '00000000-0000-0000-0000-0000000000f4';

  const LEAD_A: SeedLead = {
    id: 'l0000000-0000-0000-0000-0000000000a1',
    lead_number: 'L00010',
    organization_id: ALPHA_ORG_ID,
    visits: [{
      id: 'w1', visit_seq: 1, status: 'SCHEDULED',
      scheduled_at: IN_WINDOW, scheduled_end: null,
      assignees: [{ user_id: TECH }],
    }],
  };

  const LEAD_B: SeedLead = {
    id: 'l0000000-0000-0000-0000-0000000000b1',
    lead_number: 'L00011',
    organization_id: ALPHA_ORG_ID,
    visits: [{
      id: 'w2', visit_seq: 1, status: 'CANCELLED',
      scheduled_at: IN_WINDOW, scheduled_end: null,
      assignees: [{ user_id: TECH }],
    }],
  };

  /** The L00137 shape: the tech's OWN trip is before the window, the SIBLING trip is inside it. */
  const LEAD_SIBLING_IN_WINDOW: SeedLead = {
    id: 'l0000000-0000-0000-0000-0000000000c1',
    lead_number: 'L00137',
    organization_id: ALPHA_ORG_ID,
    visits: [
      { id: 'w3', visit_seq: 1, status: 'SCHEDULED', scheduled_at: BEFORE_WINDOW, scheduled_end: null, assignees: [{ user_id: TECH }] },
      { id: 'w4', visit_seq: 2, status: 'SCHEDULED', scheduled_at: IN_WINDOW, scheduled_end: null, assignees: [{ user_id: OTHER_TECH }] },
    ],
  };

  /** A lead this tech is on NO trip of - both trips inside the window. */
  const LEAD_NOT_ATTACHED: SeedLead = {
    id: 'l0000000-0000-0000-0000-0000000000d1',
    lead_number: 'L00138',
    organization_id: ALPHA_ORG_ID,
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    visits: [
      { id: 'w5', visit_seq: 1, status: 'SCHEDULED', scheduled_at: IN_WINDOW, scheduled_end: null, assignees: [{ user_id: OTHER_TECH }] },
      { id: 'w6', visit_seq: 2, status: 'SCHEDULED', scheduled_at: new Date(NOW + 3 * DAY), scheduled_end: null, assignees: [] },
    ],
  };

  function leadBoardRequest(who: 'dispatcher' | 'technician' | 'sales', window = { start: WINDOW_START, end: WINDOW_END }) {
    return request(app)
      .get('/api/leads')
      .query({
        walkthrough_after: window.start.toISOString(),
        walkthrough_before: window.end.toISOString(),
      })
      .set(authHeader(who));
  }

  const numbers = (res: any) => res.body.leads.map((l: any) => l.lead_number).sort();

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    seedLeadTable([LEAD_A, LEAD_B, LEAD_SIBLING_IN_WINDOW, LEAD_NOT_ATTACHED]);
  });

  it('leaves out a lead whose only in-window walkthrough was called off', async () => {
    mockAuthAs('dispatcher');

    const res = await leadBoardRequest('dispatcher');

    expect(res.status).toBe(200);
    expect(numbers(res)).toEqual(['L00010', 'L00137', 'L00138']);
  });

  // Visits slice 03, parity with jobs (job.controller composes its window under AND too): the
  // window asks "is ANY live trip of this lead in view?", the row scope asks "is this tech on ANY
  // trip of it?", and the two are separate questions. Merged into one `some`, a tech whose own
  // trip fell outside the week lost the lead - and with it the sibling trip's card - until they
  // switched to Month view.
  it('a technician on ONE trip of a lead sees its other trip when only that one is in the window', async () => {
    mockAuthAs('technician');

    const res = await leadBoardRequest('technician');

    expect(res.status).toBe(200);
    expect(numbers(res)).toEqual(['L00010', 'L00137']);
  });

  it('keeps the technician\'s own-walkthrough row scope untouched, beside the window', async () => {
    mockAuthAs('technician');

    await leadBoardRequest('technician');

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    // The stored OWN_WALKTHROUGH scope lives on this exact key. Losing it is an RBAC bypass.
    expect(where.visits).toEqual({ some: { assignees: { some: { user_id: TECH } } } });
    expect(where.AND).toContainEqual({
      visits: { some: { scheduled_at: { gte: WINDOW_START, lte: WINDOW_END }, status: { not: 'CANCELLED' } } },
    });
  });

  it('a technician on NO trip of a lead never gets it, whatever the window', async () => {
    mockAuthAs('technician');
    const windows = [
      { start: WINDOW_START, end: WINDOW_END },
      { start: new Date(NOW - 30 * DAY), end: new Date(NOW + 30 * DAY) },
      { start: new Date(NOW + 2 * DAY), end: new Date(NOW + 3 * DAY) },
    ];
    for (const window of windows) {
      const res = await leadBoardRequest('technician', window);
      expect(res.status).toBe(200);
      expect(numbers(res)).not.toContain('L00138');
    }
  });

  it('a salesperson\'s own-lead scope composes with the window the same way', async () => {
    mockAuthAs('sales');

    const res = await leadBoardRequest('sales');

    expect(res.status).toBe(200);
    expect(numbers(res)).toEqual(['L00138']);
    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    expect(where.lead_assignees).toEqual({ some: { user_id: TEST_USERS.sales.id } });
    expect(where.visits).toBeUndefined();
  });
});

describe('the crew warning sees another job\'s SECOND visit (S6, B7, D21)', () => {
  const EDITED_JOB_ID = JOB_FIXTURE.id;
  const OTHER_JOB_ID = 'j0000000-0000-0000-0000-00000000c001';
  const TECH_ID = TEST_USERS.technician.id;

  // The window being booked.
  const NEW_START = new Date(NOW + 4 * DAY);
  const NEW_END = new Date(NEW_START.getTime() + 2 * 60 * 60 * 1000);

  /**
   * OTHER-JOB: visit 1 far away (which is all the Job.scheduled_start mirror ever held) and
   * visit 2 overlapping the window being booked, crewed with the same technician.
   */
  const OTHER_JOB = jobRow({
    id: OTHER_JOB_ID,
    job_number: 'J00099',
    status: 'SCHEDULED',
    scheduled_start: new Date(NOW - 20 * DAY),
    scheduled_end: new Date(NOW - 20 * DAY + 60 * 60 * 1000),
    visits: [
      {
        id: 'ov1', visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date(NOW - 20 * DAY),
        scheduled_end: new Date(NOW - 20 * DAY + 60 * 60 * 1000),
      },
      {
        id: 'ov2', visit_seq: 2, status: 'SCHEDULED',
        scheduled_at: new Date(NEW_START.getTime() + 30 * 60 * 1000),
        scheduled_end: new Date(NEW_START.getTime() + 90 * 60 * 1000),
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: EDITED_JOB_ID,
      status: 'SCHEDULED',
      customer_id: JOB_FIXTURE.customer_id,
      source_plan_id: null,
      service_location: { state: 'TX' },
      // S8 (D6): the edited job's own crew is read through its trips.
      visits: [{ assignees: [{ user_id: TECH_ID }] }],
      estimate: null,
      scheduled_start: new Date(NOW + 1 * DAY),
      scheduled_end: new Date(NOW + 1 * DAY + 60 * 60 * 1000),
      is_all_day: false,
      customer: { tax_exempt: false },
      job_line_items: [],
      scopes: null,
      discount_type: null,
      discount_value: null,
      custom_fields: null,
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: EDITED_JOB_ID });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    seedJobTable([OTHER_JOB]);
  });

  it('409s on a clash with a trip the mirror never held, naming the PARENT and the VISIT\'s times', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${EDITED_JOB_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START.toISOString(), scheduled_end: NEW_END.toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    // Byte-stable with the shape the frontend retry path reads: the PARENT's id and number,
    // the VISIT's start and end - PLUS Q6's additive `crew`/`customer_name`. Both are empty/null
    // here because this fixture's OTHER_JOB carries no `customer` and its visits carry no
    // `assignees` at all - conflictingCrew/conflictCustomerName degrade to `[]`/`null` rather than
    // throwing on an older-shaped fixture, which is exactly what is under test on this row.
    expect(res.body.conflicts).toEqual([
      {
        type: 'job',
        id: OTHER_JOB_ID,
        number: 'J00099',
        start: new Date(NEW_START.getTime() + 30 * 60 * 1000).toISOString(),
        end: new Date(NEW_START.getTime() + 90 * 60 * 1000).toISOString(),
        crew: [],
        customer_name: null,
      },
    ]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('warns, never blocks: force pushes the same booking through (D21)', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
        visit: {
          create: vi.fn().mockResolvedValue({ id: 'v1', visit_seq: 1 }),
          update: vi.fn().mockResolvedValue({ id: 'v1' }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/jobs/${EDITED_JOB_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START.toISOString(), scheduled_end: NEW_END.toISOString(), force: true });

    expect(res.status).toBe(200);
  });
});

describe('the per-visit reschedule warns about a double-booking too (S6, B9, D21)', () => {
  const DRAGGED_JOB_ID = JOB_FIXTURE.id;
  const VISIT_ID = 'dv0000000-0000-0000-0000-00000000000d';
  const OTHER_JOB_ID = 'j0000000-0000-0000-0000-00000000c002';
  const TECH_ID = TEST_USERS.technician.id;

  const NEW_START = new Date(NOW + 4 * DAY);
  const NEW_END = new Date(NEW_START.getTime() + 2 * 60 * 60 * 1000);

  /** Another job the SAME technician is already crewed on, overlapping the window being dragged into. */
  const OTHER_JOB = jobRow({
    id: OTHER_JOB_ID,
    job_number: 'J00099',
    status: 'SCHEDULED',
    scheduled_start: new Date(NEW_START.getTime() + 30 * 60 * 1000),
    scheduled_end: new Date(NEW_START.getTime() + 90 * 60 * 1000),
    visits: [{
      id: 'ov1', visit_seq: 1, status: 'SCHEDULED',
      scheduled_at: new Date(NEW_START.getTime() + 30 * 60 * 1000),
      scheduled_end: new Date(NEW_START.getTime() + 90 * 60 * 1000),
    }],
  });

  function txStub() {
    return {
      job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
      visit: {
        create: vi.fn().mockResolvedValue({ id: VISIT_ID, visit_seq: 1 }),
        update: vi.fn().mockResolvedValue({ id: VISIT_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
      },
      visitAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
      jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: DRAGGED_JOB_ID,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_ID }],
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: DRAGGED_JOB_ID });
    // The dragged TRIP carries its own crew - that is who will actually be at the new time.
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_ID,
      assignees: [{ user_id: TECH_ID }],
    });
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txStub()));
    seedJobTable([OTHER_JOB]);
  });

  const drag = (body: Record<string, unknown> = {}) =>
    request(app)
      .patch(`/api/jobs/${DRAGGED_JOB_ID}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START.toISOString(), scheduled_end: NEW_END.toISOString(), ...body });

  it('409s instead of silently double-booking the crew, and writes nothing', async () => {
    const res = await drag();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    // Byte-stable with the 409 body the frontend retry path already reads for /assign, PLUS
    // Q6's additive `crew`/`customer_name` - empty/null here since this fixture's OTHER_JOB
    // carries no `customer` and its visit carries no `assignees`.
    expect(res.body.conflicts).toEqual([
      {
        type: 'job',
        id: OTHER_JOB_ID,
        number: 'J00099',
        start: new Date(NEW_START.getTime() + 30 * 60 * 1000).toISOString(),
        end: new Date(NEW_START.getTime() + 90 * 60 * 1000).toISOString(),
        crew: [],
        customer_name: null,
      },
    ]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('warns, never blocks: force moves the trip anyway (D21)', async () => {
    const res = await drag({ force: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('moves a trip with no clash without asking for force', async () => {
    seedJobTable([]);

    const res = await drag();

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

/**
 * The list FILTER's day boundary, as opposed to the board's instant window above.
 *
 * The two callers share `scheduled_after`/`scheduled_before` but speak different languages:
 * the board sends full ISO instants (`useScheduleData.ts` converts its org-zone window
 * through `toInstant`), while a filter chip sends bare org-zone 'YYYY-MM-DD' days. Reading a
 * bare day with `new Date(day)` made it midnight UTC, so the inclusive "to" day became an
 * EXCLUSIVE bound at that day's start - "Today" was a zero-width window that could never
 * match, and both edges sat on UTC's midnight rather than the org's (8:00 PM the previous
 * evening in America/New_York, which is what the Scheduled COLUMN renders on).
 *
 * Fixtures are pinned to real dates here rather than clock-relative, because the whole
 * subject is which calendar day an instant lands on.
 */
describe('GET /api/jobs - a bare day filter is an ORG day, and its "to" day is inclusive', () => {
  const ORG_DAY = '2026-08-24';

  // 5:00 PM on the org clock (America/New_York, UTC-4 in August) on the "to" day itself.
  // This is the reported repro: J00312's visit, which "Today" reported 0 of 0 results for.
  const AFTERNOON_OF_TO_DAY = jobRow({
    id: 'job-tz-1', job_number: 'J00312',
    visits: [{ id: 'v-tz-1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-08-24T21:00:00.000Z'), scheduled_end: null }],
  });

  // 9:00 PM org time on Aug 23 - the day BEFORE the range. It is already 2026-08-24 in UTC,
  // so a UTC-anchored `gte` wrongly let it in.
  const EVENING_BEFORE = jobRow({
    id: 'job-tz-2', job_number: 'J00233',
    visits: [{ id: 'v-tz-2', visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-08-24T01:00:00.000Z'), scheduled_end: null }],
  });

  // 1:00 AM org time on Aug 25 - the day AFTER the range, and genuinely outside it.
  const MORNING_AFTER = jobRow({
    id: 'job-tz-3', job_number: 'J00399',
    visits: [{ id: 'v-tz-3', visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-08-25T05:00:00.000Z'), scheduled_end: null }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('dispatcher');
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.job.groupBy.mockResolvedValue([]);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    // No org row -> getOrgTimezone falls back to DEFAULT_TIMEZONE (America/New_York).
    mockPrisma.organization.findUnique.mockResolvedValue(null);
  });

  function dayFilterRequest(from: string, to: string) {
    return request(app)
      .get('/api/jobs')
      .query({ scheduled_after: from, scheduled_before: to, limit: 500 })
      .set(authHeader('dispatcher'));
  }

  it('the "Today" preset returns the job it names, instead of 0 of 0', async () => {
    seedJobTable([AFTERNOON_OF_TO_DAY, EVENING_BEFORE, MORNING_AFTER]);

    const res = await dayFilterRequest(ORG_DAY, ORG_DAY);

    expect(res.status).toBe(200);
    const numbers = res.body.jobs.map((j: any) => j.job_number);
    expect(numbers).toContain('J00312');
    expect(numbers).not.toContain('J00233');
    expect(numbers).not.toContain('J00399');
  });

  it('keeps the LAST day of a multi-day range, which the old bound dropped', async () => {
    seedJobTable([AFTERNOON_OF_TO_DAY, EVENING_BEFORE]);

    // "This week" as the acceptance run saw it: Aug 23 - Aug 24. Both jobs are in it.
    const res = await dayFilterRequest('2026-08-23', ORG_DAY);

    expect(res.status).toBe(200);
    const numbers = res.body.jobs.map((j: any) => j.job_number);
    expect(numbers).toContain('J00312');
    expect(numbers).toContain('J00233');
  });

  it('sends a half-open window - gte the org day start, lt the NEXT org day start', async () => {
    seedJobTable([AFTERNOON_OF_TO_DAY]);

    await dayFilterRequest(ORG_DAY, ORG_DAY);

    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(collectVisitSomes(where)).toContainEqual(
      expect.objectContaining({
        scheduled_at: {
          gte: new Date('2026-08-24T04:00:00.000Z'),
          lt: new Date('2026-08-25T04:00:00.000Z'),
        },
      }),
    );
  });

  it('cuts on the ORG zone, not UTC and not the server clock', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'Asia/Manila' });
    seedJobTable([AFTERNOON_OF_TO_DAY]);

    await dayFilterRequest(ORG_DAY, ORG_DAY);

    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    // Manila is UTC+8, so its Aug 24 begins on the previous UTC day - the offset points the
    // opposite way from New York's, which a fixed-direction fix would get wrong.
    expect(collectVisitSomes(where)).toContainEqual(
      expect.objectContaining({
        scheduled_at: {
          gte: new Date('2026-08-23T16:00:00.000Z'),
          lt: new Date('2026-08-24T16:00:00.000Z'),
        },
      }),
    );
  });

  it('CONSTRAINT: a full ISO instant window is passed through exactly as before', async () => {
    seedJobTable([AFTERNOON_OF_TO_DAY]);

    const after = '2026-08-24T04:00:00.000Z';
    const before = '2026-08-25T03:59:59.999Z';
    await dayFilterRequest(after, before);

    const where = mockPrisma.job.findMany.mock.calls[0][0].where;
    // Still gte/lte on the given instants - no `lt`, no org-zone reinterpretation. This is
    // the schedule board's path and it passed the whole org-zone QA campaign unchanged.
    expect(collectVisitSomes(where)).toContainEqual(
      expect.objectContaining({
        scheduled_at: { gte: new Date(after), lte: new Date(before) },
      }),
    );
  });

  it('resolves the org zone at most ONCE per request, however many bounds need it', async () => {
    seedJobTable([AFTERNOON_OF_TO_DAY]);

    // Both the visit window and the stats tiles' month window ask for the zone, and the list
    // carries a second dateRange facet (`created`) that can ask for it too. The board
    // repaints on every navigation, so these must collapse to one `organization` read.
    await request(app)
      .get('/api/jobs')
      .query({
        scheduled_after: ORG_DAY, scheduled_before: ORG_DAY,
        created_after: '2026-08-01', created_before: ORG_DAY,
        limit: 500,
      })
      .set(authHeader('dispatcher'));

    const zoneReads = mockPrisma.organization.findUnique.mock.calls
      .filter((c: any) => c[0]?.select?.timezone);
    expect(zoneReads).toHaveLength(1);
  });
});
