/**
 * Scheduling-notifications slice 08 - visit milestone skip stamps and the milestone log.
 *
 * PRD: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * ("Skip stamps and the milestone log"). Milestones stay stamps that can be skipped, and every
 * stamp leaves a trace: tapping a milestone with earlier ones unstamped stamps those with the SAME
 * instant and marks them skipped; a rewind clears the later columns and appends "reverted" rows
 * rather than deleting anything.
 *
 * Driven through the HTTP API against the real Express app with Prisma mocked, on the harness
 * visit-lifecycle.test.ts established: a table-aware transaction fake, so the visit write lands on
 * a stateful row and the response is what the writer actually wrote. Nothing here reaches for an
 * internal function's shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));

const mockPrisma = prisma as unknown as Record<string, any>;

const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';

function visitRow(over: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
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
    en_route_at: null,
    on_site_at: null,
    started_at: null,
    completed_at: null,
    // No skipped markers by default: a row from before any tap, so a marker in a response below
    // is proof the writer stated it rather than an echo of the fixture.
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    created_at: new Date('2026-08-20T10:00:00Z'),
    updated_at: new Date('2026-08-20T10:00:00Z'),
    assignees: [],
    ...over,
  };
}

/**
 * A stateful visit table behind both the pre-transaction read and the transactional write, plus
 * an append-only log table. The route answers with the row the writer returned, so every
 * assertion below reads the response or the log, never a mock's call list.
 */
function wire(rows: ReturnType<typeof visitRow>[]) {
  const table = rows.map((r) => ({ ...r }));
  const log: Record<string, unknown>[] = [];
  mockPrisma.job.findUnique.mockResolvedValue({
    id: JOB_FIXTURE.id,
    status: 'SCHEDULED',
    job_number: 'J00001',
    source_plan_id: null,
    assignees: [],
    service_location: null,
  });
  mockPrisma.visit.findFirst.mockImplementation(async (args: any) => {
    const row = table.find((r) => r.id === args?.where?.id);
    return row ? { ...row } : null;
  });
  const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => {
    const row = table.find((r) => r.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return row ? { ...row } : null;
  });
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        update: txVisitUpdate,
        findFirst: vi.fn().mockImplementation(async (args: any) => table.find((r) => r.id === args.where.id) ?? null),
        findMany: vi.fn().mockImplementation(async (args: any) => {
          const where = args?.where ?? {};
          return table.filter((r) => {
            if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
            if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
            if (where.status?.in && !where.status.in.includes(r.status)) return false;
            return true;
          });
        }),
      },
      visitMilestoneLog: {
        createMany: vi.fn().mockImplementation(async (args: any) => {
          const data = Array.isArray(args.data) ? args.data : [args.data];
          log.push(...data);
          return { count: data.length };
        }),
      },
      visitAssignee: { findMany: vi.fn().mockResolvedValue([]) },
      jobAssignee: { findMany: vi.fn().mockResolvedValue([]) },
      job: {
        update: vi.fn().mockResolvedValue(JOB_FIXTURE),
        findUnique: vi.fn().mockResolvedValue({ id: JOB_FIXTURE.id, status: 'SCHEDULED' }),
      },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
  return { table, log, txVisitUpdate };
}

function tap(verb: 'en-route' | 'arrive' | 'start' | 'complete') {
  return request(app)
    .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/${verb}`)
    .set(authHeader('admin'))
    .send({});
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Pin the clock (Date only, so supertest's sockets keep working) and step it between taps. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('skip stamps - tapping ahead stamps the earlier milestones with the same instant', () => {
  it('Start work on a SCHEDULED visit stamps on-the-way and on-site as skipped, started as tapped, all at one instant', async () => {
    wire([visitRow()]);

    const res = await tap('start');

    expect(res.status).toBe(200);
    const visit = res.body.visit;
    expect(visit.status).toBe('IN_PROGRESS');
    // One identical instant for all three stamps: a report reading "on the way -> on site" off
    // these columns sees zero minutes, and the markers below are what tell it to exclude them.
    expect(visit.started_at).toBeTruthy();
    expect(visit.en_route_at).toBe(visit.started_at);
    expect(visit.on_site_at).toBe(visit.started_at);
    // The markers ride the API response so a reader can tell a tap from a skip without the log.
    expect(visit.en_route_skipped).toBe(true);
    expect(visit.on_site_skipped).toBe(true);
    expect(visit.started_skipped).toBe(false);
  });
});

describe('sequential taps - every milestone tapped in order is a real tap', () => {
  it('Mark on the way, Mark on site, Start work produce three distinct instants and no skipped markers', async () => {
    wire([visitRow()]);

    clockAt('2026-09-05T13:00:00Z');
    expect((await tap('en-route')).status).toBe(200);
    clockAt('2026-09-05T13:20:00Z');
    expect((await tap('arrive')).status).toBe(200);
    clockAt('2026-09-05T13:25:00Z');
    const res = await tap('start');

    expect(res.status).toBe(200);
    const visit = res.body.visit;
    expect(visit.en_route_at).toBe('2026-09-05T13:00:00.000Z');
    expect(visit.on_site_at).toBe('2026-09-05T13:20:00.000Z');
    expect(visit.started_at).toBe('2026-09-05T13:25:00.000Z');
    expect(visit.en_route_skipped).toBe(false);
    expect(visit.on_site_skipped).toBe(false);
    expect(visit.started_skipped).toBe(false);
  });
});

describe('skip stamps - Complete from on-the-way', () => {
  it('stamps on-site and started as skipped with the completion instant, leaving the real on-the-way tap alone', async () => {
    wire([visitRow({ status: 'EN_ROUTE', en_route_at: new Date('2026-09-05T13:00:00Z'), en_route_skipped: false })]);

    clockAt('2026-09-05T15:10:00Z');
    const res = await tap('complete');

    expect(res.status).toBe(200);
    const visit = res.body.visit;
    expect(visit.status).toBe('COMPLETED');
    expect(visit.completed_at).toBe('2026-09-05T15:10:00.000Z');
    expect(visit.on_site_at).toBe('2026-09-05T15:10:00.000Z');
    expect(visit.started_at).toBe('2026-09-05T15:10:00.000Z');
    expect(visit.on_site_skipped).toBe(true);
    expect(visit.started_skipped).toBe(true);
    // The tap that really happened keeps its own instant and is not re-marked.
    expect(visit.en_route_at).toBe('2026-09-05T13:00:00.000Z');
    expect(visit.en_route_skipped).toBe(false);
  });
});

/** A trip completed straight off a real on-site tap: started was skipped by that Complete. */
function completedOffOnSite() {
  return visitRow({
    status: 'COMPLETED',
    en_route_at: new Date('2026-09-05T13:00:00Z'),
    en_route_skipped: false,
    on_site_at: new Date('2026-09-05T13:20:00Z'),
    on_site_skipped: false,
    started_at: new Date('2026-09-05T15:10:00Z'),
    started_skipped: true,
    completed_at: new Date('2026-09-05T15:10:00Z'),
  });
}

describe('rewind - tapping an earlier milestone clears the later columns and their skipped markers', () => {
  it('Mark on site on a completed visit re-stamps on-site and clears started and completed, marker included', async () => {
    wire([completedOffOnSite()]);

    clockAt('2026-09-05T15:30:00Z');
    const res = await tap('arrive');

    expect(res.status).toBe(200);
    const visit = res.body.visit;
    expect(visit.status).toBe('ON_SITE');
    expect(visit.on_site_at).toBe('2026-09-05T15:30:00.000Z');
    expect(visit.on_site_skipped).toBe(false);
    expect(visit.started_at).toBeNull();
    expect(visit.completed_at).toBeNull();
    // A rewound milestone reads "never happened", not "skipped": the marker goes with the column.
    expect(visit.started_skipped).toBe(false);
    // Nothing earlier moves.
    expect(visit.en_route_at).toBe('2026-09-05T13:00:00.000Z');
    expect(visit.en_route_skipped).toBe(false);
  });
});

describe('the milestone log - every tap, skip and rewind leaves a row with who and when', () => {
  it('Start work on a SCHEDULED visit appends one tapped row and two skipped rows, all at the tap instant, with the actor', async () => {
    const { log } = wire([visitRow()]);

    clockAt('2026-09-05T13:25:00Z');
    const res = await tap('start');

    expect(res.status).toBe(200);
    const rows = log.map((r) => ({ milestone: r.milestone, kind: r.kind }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { milestone: 'en_route', kind: 'skipped' },
        { milestone: 'on_site', kind: 'skipped' },
        { milestone: 'started', kind: 'tapped' },
      ]),
    );
    expect(log).toHaveLength(3);
    for (const row of log) {
      expect(row.visit_id).toBe(VISIT_ID);
      // Org-scoped like the visit table, so the same tenant policy reaches it.
      expect(row.organization_id).toBe(ALPHA_ORG_ID);
      expect(row.actor_id).toBe(TEST_USERS.admin.id);
      expect((row.occurred_at as Date).toISOString()).toBe('2026-09-05T13:25:00.000Z');
    }
  });
});

describe('the milestone log - a rewind appends, it never deletes', () => {
  it('Mark on site on a completed visit appends one reverted row per cleared milestone and a tapped row, nothing removed', async () => {
    const { log } = wire([completedOffOnSite()]);

    clockAt('2026-09-05T15:30:00Z');
    const res = await tap('arrive');

    expect(res.status).toBe(200);
    const rows = log.map((r) => ({ milestone: r.milestone, kind: r.kind }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { milestone: 'on_site', kind: 'tapped' },
        { milestone: 'started', kind: 'reverted' },
        { milestone: 'completed', kind: 'reverted' },
      ]),
    );
    // Exactly those three: on-the-way was earlier and stamped, so it is neither skipped nor
    // reverted, and nothing that was already null gets a reverted row.
    expect(log).toHaveLength(3);
    for (const row of log) {
      expect(row.actor_id).toBe(TEST_USERS.admin.id);
      expect((row.occurred_at as Date).toISOString()).toBe('2026-09-05T15:30:00.000Z');
    }
  });

  it('a rewind on a visit whose later milestones were never stamped appends no reverted rows', async () => {
    const { log } = wire([visitRow({ status: 'EN_ROUTE', en_route_at: new Date('2026-09-05T13:00:00Z'), en_route_skipped: false })]);

    clockAt('2026-09-05T13:05:00Z');
    const res = await tap('en-route');

    expect(res.status).toBe(200);
    expect(log.map((r) => ({ milestone: r.milestone, kind: r.kind }))).toEqual([{ milestone: 'en_route', kind: 'tapped' }]);
  });
});

describe('the job-level door - POST /api/jobs/:id/start stamps the current visit through the same writer', () => {
  it('appends the tap and its skips for the job\'s current visit, with the actor', async () => {
    // A dispatcher rather than the admin the file defaults to, so the actor on the rows is
    // proven to be whoever pressed the door and not a constant.
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      started_at: null,
      assignees: [],
      invoices: [],
      source_plan_id: null,
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS' });
    // The job-level verbs write on the GLOBAL client: the current-visit resolver reads the live
    // set from it, and the writer appends the log to it.
    mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
    mockPrisma.visit.update.mockImplementation(async (args: any) => ({ ...visitRow(), ...args.data }));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    clockAt('2026-09-05T13:25:00Z');
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
    const written = (mockPrisma.visitMilestoneLog.createMany.mock.calls as any[]).flatMap((c) => c[0].data);
    expect(written.map((r: any) => ({ milestone: r.milestone, kind: r.kind }))).toEqual(
      expect.arrayContaining([
        { milestone: 'en_route', kind: 'skipped' },
        { milestone: 'on_site', kind: 'skipped' },
        { milestone: 'started', kind: 'tapped' },
      ]),
    );
    expect(written).toHaveLength(3);
    for (const row of written) {
      expect(row.visit_id).toBe(VISIT_ID);
      expect(row.organization_id).toBe(ALPHA_ORG_ID);
      expect(row.actor_id).toBe(TEST_USERS.dispatcher.id);
      expect((row.occurred_at as Date).toISOString()).toBe('2026-09-05T13:25:00.000Z');
    }
  });
});
