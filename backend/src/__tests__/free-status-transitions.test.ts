import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { JobStatus } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  planVisit: { updateMany: ReturnType<typeof vi.fn> };
  jobAssignee: { createMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ALL_STATUSES = Object.values(JobStatus);

// Every status ACTION and the payload it needs. Ordering is no longer a precondition for any
// of them, so each must accept a job in every one of the seven statuses.
// B-11: the originally-shown matrix omitted assign (the Scheduled node's only endpoint) and
// reopen (two guards removed) — both added below alongside the POST actions.
const ACTIONS: { path: string; body?: object }[] = [
  { path: 'assign', body: { assignee_ids: [] } },
  { path: 'arrive' },
  { path: 'start' },
  { path: 'complete', body: { completion_notes: 'done' } },
  { path: 'cancel', body: { cancelled_reason: 'customer cancelled' } },
  { path: 'en-route' },
  { path: 'unassign' },
  { path: 'reopen' },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
  // cancel/delete's Inventory P1 stock-sync return-check reads this unconditionally.
  (mockPrisma as unknown as { jobLineItem: { findMany: ReturnType<typeof vi.fn> } }).jobLineItem.findMany.mockResolvedValue([]);
  // SRVW-87 - the SCHEDULED rows of the /status matrix route into assign()'s conflict check.
  // Defensive: the matrix fixture has an empty crew, so detectCrewConflicts early-returns before
  // reaching findMany - but setup.ts leaves job.findMany with no default, so this stops a future
  // crewed fixture from silently 500ing (which `!== 400` would happily pass).
  mockPrisma.job.findMany.mockResolvedValue([]);
  // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so the matrix job has
  // one. Without it /assign answers 400 for an unrelated reason (crew is unexpressible on a
  // visitless job - pinned deliberately in visit-crew.test.ts) and this matrix would read that
  // as an ordering guard coming back.
  (mockPrisma as unknown as { visit: { findMany: ReturnType<typeof vi.fn> } }).visit.findMany.mockResolvedValue([
    {
      id: 'v0000000-0000-0000-0000-0000000000f1', job_id: JOB_FIXTURE.id, lead_id: null,
      visit_seq: 1, status: 'SCHEDULED',
      scheduled_at: new Date('2026-08-10T15:00:00.000Z'),
      scheduled_end: new Date('2026-08-10T17:00:00.000Z'),
      is_all_day: false, created_at: new Date('2026-08-01T00:00:00.000Z'),
      en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    },
  ]);
});

describe('free status transitions — every action accepts every status', () => {
  for (const action of ACTIONS) {
    for (const status of ALL_STATUSES) {
      it(`POST /${action.path} accepts a ${status} job`, async () => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue({
          ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
        });

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/${action.path}`)
          .set(authHeader('admin'))
          .send(action.body ?? {});

        // The point of the test: never a 400. A 4xx here means an ordering guard came back.
        expect(res.status).not.toBe(400);
      });
    }
  }

  // B-11: PATCH update and DELETE use a different HTTP method and hit /:id directly, so they
  // don't fit the POST /:id/:action shape above — same "never 400 by status" assertion.
  for (const status of ALL_STATUSES) {
    it(`PATCH / accepts a ${status} job`, async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({});

      expect(res.status).not.toBe(400);
    });

    it(`DELETE / accepts a ${status} job with no invoices`, async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
      });
      mockPrisma.job.delete.mockResolvedValue({ ...JOB_FIXTURE, status });

      const res = await request(app)
        .delete(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'));

      expect(res.status).not.toBe(400);
    });
  }

  // SRVW-87 - the single set-status door adds no ordering guard either: every TARGET status is
  // reachable from every SOURCE status. Note what this matrix canNOT tell you - it only asserts
  // `!== 400`, so an un-completion would pass silently. The two cases that matter (a bare
  // status=SCHEDULED on a COMPLETED job 400s; an explicit window rewinds milestones) are pinned
  // by their own assertions in jobs.test.ts, deliberately not here.
  for (const target of ALL_STATUSES) {
    for (const source of ALL_STATUSES) {
      it(`POST /status accepts target ${target} from a ${source} job`, async () => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue({
          ...JOB_FIXTURE, status: source, assignees: [], invoices: [], source_plan_id: null,
        });

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
          .set(authHeader('admin'))
          .send({
            status: target,
            // The explicit window satisfies the SCHEDULED branch's requirement; the verb schemas
            // that do not declare these fields strip them.
            scheduled_start: '2026-09-01T09:00:00.000Z',
            scheduled_end: '2026-09-01T11:00:00.000Z',
            completion_notes: 'done',
            cancelled_reason: 'test',
          });

        expect(res.status).not.toBe(400);
      });
    }
  }
});

describe('integrity guards survive — these are NOT ordering constraints', () => {
  it('still refuses to delete a job that has a non-voided invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'UNSCHEDULED', invoices: [{ status: 'SENT' }],
    });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoice/i);
  });

  it('still refuses to invoice a service-plan visit job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'COMPLETED', source_plan_id: 'plan-1', invoices: [],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan/i);
  });
});

describe('EN_ROUTE and ON_SITE are no longer job statuses (S4 B13, D17)', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [],
      invoices: [],
      source_plan_id: null,
    });
  });

  it('refuses EN_ROUTE as a target of POST /:id/status', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'EN_ROUTE' });

    // A validation failure naming the field, not a 200 and not an opaque 500. Being on the way is
    // a property of the TRIP now, and the /:id/en-route ROUTE survives to say so - only the
    // status-dispatch target goes.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('status');
  });

  it('never lets a retired ON_SITE facet value reach the jobs query', async () => {
    mockPrisma.job.findMany.mockResolvedValue([]);
    (mockPrisma as unknown as { job: { count: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> } })
      .job.count.mockResolvedValue(0);
    (mockPrisma as unknown as { job: { groupBy: ReturnType<typeof vi.fn> } }).job.groupBy.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/jobs?status=ON_SITE')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The jobs facet's documented contract is to DROP an invalid enum literal rather than 400 -
    // `status` is a strict Prisma enum column and an unguarded `{ in: [...] }` would throw a
    // validation error (a 500) instead. What matters after the narrowing is that ON_SITE is now
    // one of those dropped values, so a stale saved filter or a stale board query degrades to
    // "no status filter" rather than emptying the board with a 500.
    for (const call of mockPrisma.job.findMany.mock.calls) {
      expect(JSON.stringify(call[0]?.where ?? {})).not.toContain('ON_SITE');
    }
  });

  it('still routes IN_PROGRESS through start(), and starts the job\'s current visit with it', async () => {
    // The table HONOURS the where, and carries a called-off decoy booked EARLIER than the real
    // trip: the rule under test is the predicate (this tenant, this job, live statuses only), and
    // a mock that ignored it would report green for a verb that revived a cancelled visit.
    const table = [
      {
        id: VISIT_ID,
        organization_id: '00000000-0000-0000-0000-000000000001',
        job_id: JOB_FIXTURE.id,
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-05T13:00:00Z'),
        scheduled_end: new Date('2026-09-05T15:30:00Z'),
        created_at: new Date('2026-08-20T10:00:00Z'),
      },
      {
        id: 'v-cancelled',
        organization_id: '00000000-0000-0000-0000-000000000001',
        job_id: JOB_FIXTURE.id,
        status: 'CANCELLED',
        scheduled_at: new Date('2026-09-01T13:00:00Z'),
        scheduled_end: new Date('2026-09-01T15:30:00Z'),
        created_at: new Date('2026-08-20T09:00:00Z'),
      },
      {
        id: 'v-other-org',
        organization_id: '00000000-0000-0000-0000-0000000000b0',
        job_id: JOB_FIXTURE.id,
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-08-31T13:00:00Z'),
        scheduled_end: new Date('2026-08-31T15:30:00Z'),
        created_at: new Date('2026-08-20T08:00:00Z'),
      },
    ];
    (mockPrisma as unknown as { visit: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } })
      .visit.findMany.mockImplementation(async (args: any) => table.filter((r) => {
        const where = args?.where ?? {};
        if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
        if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        return true;
      }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'IN_PROGRESS' });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
    const visitUpdate = (mockPrisma as unknown as { visit: { update: ReturnType<typeof vi.fn> } }).visit.update;
    expect(visitUpdate.mock.calls[0][0].where.id).toBe(VISIT_ID);
    expect(visitUpdate.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
  });
});
