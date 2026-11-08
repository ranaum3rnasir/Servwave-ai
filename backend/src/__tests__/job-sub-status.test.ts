import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { JobStatus } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { subStatusClears } from '../lib/job-sub-status';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// SRVW-113 - setSubStatus dispatches JOB_SUB_STATUS_ENTERED post-commit (#271); mocked here
// (mirroring jobs.test.ts) so the assertion is synchronous instead of racing setImmediate.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

/**
 * SRVW-112 - per-org job sub-statuses under the fixed JobStatus parents.
 *
 * Two tenancy checks, per the conductor directive: the catalog CRUD spreads tenantWhere(req) on
 * every read AND every write, and the job-side setter resolves the incoming sub_status_id inside
 * the caller's org before it is ever written as an FK.
 */

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  jobSubStatus: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  workflow: { updateMany: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  jobLineItem: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const SUB_A = '5a000000-0000-0000-0000-0000000000a1';
const SUB_B = '5a000000-0000-0000-0000-0000000000a2';

/**
 * Prisma's $transaction has TWO shapes and this file exercises both: the verb handlers pass a
 * CALLBACK, reorder() passes an ARRAY of promises. A callback-only passthrough throws on the
 * array form, so mirror the real dual signature.
 */
function installTransactionPassthrough() {
  // S8 (D6): a job-level crew statement lands on the job's CURRENT visit, so the job needs one -
  // otherwise /assign answers 400 (unexpressible) and the sub-status behaviour under test is
  // never reached. visit-crew.test.ts pins the visitless 400 case deliberately.
  (prisma as unknown as { visit: { findMany: ReturnType<typeof vi.fn> } }).visit.findMany.mockResolvedValue([
    {
      id: 'v0000000-0000-0000-0000-0000000000f1', job_id: JOB_FIXTURE.id, lead_id: null,
      visit_seq: 1, status: 'SCHEDULED',
      scheduled_at: new Date('2026-08-10T15:00:00.000Z'),
      scheduled_end: new Date('2026-08-10T17:00:00.000Z'),
      is_all_day: false, created_at: new Date('2026-08-01T00:00:00.000Z'),
      en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    },
  ]);
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

/** The one job.update call that actually writes a status (cancel also writes amount_invoiced). */
function statusUpdateCall() {
  return mockPrisma.job.update.mock.calls
    .map((c) => c[0] as { where?: unknown; data?: Record<string, unknown> })
    .find((a) => a?.data && 'status' in a.data);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  installTransactionPassthrough();
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
  mockPrisma.job.findMany.mockResolvedValue([]);
  // cancel()'s Inventory P1 stock-return check reads this unconditionally.
  mockPrisma.jobLineItem.findMany.mockResolvedValue([]);
  mockPrisma.jobSubStatus.findMany.mockResolvedValue([]);
  mockPrisma.jobSubStatus.count.mockResolvedValue(0);
});

// ─── Catalog CRUD: /api/job-sub-statuses ────────────────────────────────────

describe('GET /api/job-sub-statuses', () => {
  it('scopes findMany to the caller organization and orders by parent, sort_order, label', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/job-sub-statuses').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.jobSubStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }),
        orderBy: [{ parent: 'asc' }, { sort_order: 'asc' }, { label: 'asc' }],
      }),
    );
  });
});

describe('POST /api/job-sub-statuses', () => {
  it('stamps the caller organization_id and never trusts a body-supplied org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue(null);
    mockPrisma.jobSubStatus.count.mockResolvedValue(0);
    mockPrisma.jobSubStatus.create.mockResolvedValue({
      id: SUB_A, parent: 'IN_PROGRESS', label: 'Parts On Order', sort_order: 0,
    });

    const res = await request(app)
      .post('/api/job-sub-statuses')
      .set(authHeader('admin'))
      .send({ parent: 'IN_PROGRESS', label: 'Parts On Order', organization_id: ORG_B_ID });

    expect(res.status).toBe(201);
    const arg = mockPrisma.jobSubStatus.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.organization_id).toBe(ALPHA_ORG_ID);
    // Append index from the tenant-scoped count, not a client-supplied position.
    expect(arg.data.sort_order).toBe(0);
  });

  it('409s a duplicate label under the same parent in the same org, and never upserts', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue({ id: SUB_A, label: 'Parts On Order' });

    const res = await request(app)
      .post('/api/job-sub-statuses')
      .set(authHeader('admin'))
      .send({ parent: 'IN_PROGRESS', label: 'Parts On Order' });

    expect(res.status).toBe(409);
    expect(mockPrisma.jobSubStatus.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
    expect(mockPrisma.jobSubStatus.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/job-sub-statuses/:id', () => {
  it('404s a row owned by another org and writes nothing', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('orgB_admin'))
      .send({ label: 'Renamed' });

    expect(res.status).toBe(404);
    expect(mockPrisma.jobSubStatus.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_B_ID }) }),
    );
    expect(mockPrisma.jobSubStatus.update).not.toHaveBeenCalled();
  });

  it('scopes the WRITE, not just the preceding read, to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.findFirst
      .mockResolvedValueOnce({ id: SUB_A, parent: 'IN_PROGRESS', label: 'Parts On Order' })
      .mockResolvedValueOnce(null);
    mockPrisma.jobSubStatus.update.mockResolvedValue({
      id: SUB_A, parent: 'IN_PROGRESS', label: 'Parts Ordered', sort_order: 0,
    });

    const res = await request(app)
      .patch(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('admin'))
      .send({ label: 'Parts Ordered' });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobSubStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SUB_A, organization_id: ALPHA_ORG_ID }),
      }),
    );
  });
});

describe('DELETE /api/job-sub-statuses/:id', () => {
  it('deletes through a tenant-scoped deleteMany and 404s when nothing matched', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.jobSubStatus.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SUB_A, organization_id: ALPHA_ORG_ID }),
      }),
    );
  });

  it('204s when a row was deleted', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  // SRVW-113 - trigger_config is JSONB with no FK, so a delete must disable (not orphan) any
  // workflow whose config still points at the deleted id. A published WorkflowVersion.definition
  // also freezes a copy, so this touches the live Workflow row only - never rewrites history.
  it('disables workflows watching the deleted sub-status, in the same transaction as the delete', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.workflow.updateMany).toHaveBeenCalledWith({
      where: {
        organization_id: ALPHA_ORG_ID,
        trigger_type: 'JOB_SUB_STATUS_ENTERED',
        trigger_config: { path: ['sub_status_id'], equals: SUB_A },
      },
      data: { is_enabled: false },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('does not touch any workflow when nothing was deleted (404)', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/job-sub-statuses/${SUB_A}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.workflow.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/job-sub-statuses/reorder', () => {
  it('400s when any id fails to resolve inside the org and parent, and writes nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.findMany.mockResolvedValue([{ id: SUB_A }]);

    const res = await request(app)
      .post('/api/job-sub-statuses/reorder')
      .set(authHeader('admin'))
      .send({ parent: 'IN_PROGRESS', ordered_ids: [SUB_A, SUB_B] });

    expect(res.status).toBe(400);
    expect(mockPrisma.jobSubStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parent: 'IN_PROGRESS', organization_id: ALPHA_ORG_ID }),
      }),
    );
    expect(mockPrisma.jobSubStatus.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes sort_order by array index, each write scoped to the org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobSubStatus.findMany.mockResolvedValue([{ id: SUB_A }, { id: SUB_B }]);

    const res = await request(app)
      .post('/api/job-sub-statuses/reorder')
      .set(authHeader('admin'))
      .send({ parent: 'IN_PROGRESS', ordered_ids: [SUB_B, SUB_A] });

    expect(res.status).toBe(204);
    expect(mockPrisma.jobSubStatus.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.jobSubStatus.update).toHaveBeenNthCalledWith(1, {
      where: { id: SUB_B, organization_id: ALPHA_ORG_ID },
      data: { sort_order: 0 },
    });
    expect(mockPrisma.jobSubStatus.update).toHaveBeenNthCalledWith(2, {
      where: { id: SUB_A, organization_id: ALPHA_ORG_ID },
      data: { sort_order: 1 },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

// ─── The job write path: POST /api/jobs/:id/sub-status ──────────────────────

describe('POST /api/jobs/:id/sub-status', () => {
  it('404s a sub_status_id owned by another org and never writes the FK', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: null,
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: SUB_A });

    expect(res.status).toBe(404);
    expect(mockPrisma.jobSubStatus.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SUB_A, organization_id: ALPHA_ORG_ID }),
      }),
    );
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('400s when the sub-status parent differs from the job current status', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: null,
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue({
      id: SUB_A, label: 'Ready For Office Review', parent: 'COMPLETED',
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: SUB_A });

    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('writes sub_status_id and a JOB_SUB_STATUS_CHANGED timeline event when the parent matches', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: null,
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue({
      id: SUB_A, label: 'Parts On Order', parent: 'IN_PROGRESS',
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: SUB_A });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: JOB_FIXTURE.id, organization_id: ALPHA_ORG_ID }),
        data: { sub_status_id: SUB_A },
      }),
    );
    const event = mockPrisma.timelineEvent.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.event_type === 'JOB_SUB_STATUS_CHANGED');
    expect(event).toBeDefined();
    expect(event!.metadata).toEqual({ from: null, to: SUB_A });
    // TimelineEvent.description is a non-null String column - it must be written, not defaulted.
    expect(typeof event!.description).toBe('string');
    expect((event!.description as string).length).toBeGreaterThan(0);
  });

  // SRVW-113 - "entered" must mean a deliberate label, so this dispatches
  // JOB_SUB_STATUS_ENTERED with occurrenceKey = sub_status_id.
  it('dispatches JOB_SUB_STATUS_ENTERED when a sub-status is deliberately set', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: null,
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValue({
      id: SUB_A, label: 'Parts On Order', parent: 'IN_PROGRESS',
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: SUB_A });

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'JOB_SUB_STATUS_ENTERED',
        organizationId: ALPHA_ORG_ID,
        entity: { type: 'job', id: JOB_FIXTURE.id, label: JOB_FIXTURE.job_number },
        occurrenceKey: SUB_A,
      }),
    );
  });

  it('clears the field with no catalog lookup when sub_status_id is null', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: SUB_A,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobSubStatus.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sub_status_id: null } }),
    );
    const event = mockPrisma.timelineEvent.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.event_type === 'JOB_SUB_STATUS_CHANGED');
    expect(event!.metadata).toEqual({ from: SUB_A, to: null });
    expect(event!.description).toContain('cleared');
  });

  // The clear path must NEVER dispatch "entered" - it is the absence of a label, not a new one.
  it('does not dispatch JOB_SUB_STATUS_ENTERED when clearing the label', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: SUB_A,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('admin'))
      .send({ sub_status_id: null });

    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'JOB_SUB_STATUS_ENTERED' }),
    );
  });

  it('403s a caller who fails the per-instance canAccessRow check', async () => {
    // A technician holds `update Job` with the OWN_JOB condition, so canAccessRow actually runs
    // its scoped probe (an admin short-circuits to true and would never reach it).
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'IN_PROGRESS', sub_status_id: null,
    });
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/sub-status`)
      .set(authHeader('technician'))
      .send({ sub_status_id: null });

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

// ─── Parent/child integrity across the 8 status-writing verbs ───────────────

/**
 * ONE case per verb, both halves together: the verb that MOVES the status must null a
 * now-invalid sub_status_id, and the same verb fired at a job already AT its target status must
 * not write the key at all (the fence against over-clearing).
 */
const VERBS: { path: string; body?: object; movingFrom: JobStatus; nonMovingFrom: JobStatus; nonMovingBody?: object }[] = [
  { path: 'unassign', movingFrom: 'IN_PROGRESS', nonMovingFrom: 'UNSCHEDULED' },
  // en-route and arrive are NOT in this matrix from multi-visit S4: EN_ROUTE and ON_SITE retired
  // from JobStatus (D17), so neither verb moves the job's status at all any more and there is no
  // status change to invalidate a sub_status. Their milestone now lands on the VISIT.
  { path: 'start', movingFrom: 'SCHEDULED', nonMovingFrom: 'IN_PROGRESS' },
  { path: 'complete', movingFrom: 'IN_PROGRESS', nonMovingFrom: 'COMPLETED' },
  { path: 'cancel', body: { cancelled_reason: 'customer cancelled' }, movingFrom: 'IN_PROGRESS', nonMovingFrom: 'CANCELLED' },
  { path: 'reopen', movingFrom: 'COMPLETED', nonMovingFrom: 'IN_PROGRESS' },
  // assign derives its target from the BODY: a scheduled_start makes it SCHEDULED, its absence
  // keeps existing.status. So the two halves differ by body, not by source status.
  {
    path: 'assign',
    body: { assignee_ids: [], scheduled_start: '2026-08-10T15:00:00.000Z', scheduled_end: '2026-08-10T17:00:00.000Z' },
    movingFrom: 'IN_PROGRESS',
    nonMovingFrom: 'IN_PROGRESS',
    nonMovingBody: { assignee_ids: [] },
  },
];

describe('status verbs clear a now-invalid sub_status_id', () => {
  for (const verb of VERBS) {
    it(`POST /${verb.path} nulls sub_status_id when the status moves and leaves it alone when it does not`, async () => {
      // Half 1 - the status MOVES, so the sub-status can no longer be valid.
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status: verb.movingFrom, assignees: [], invoices: [], source_plan_id: null,
      });

      const moved = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/${verb.path}`)
        .set(authHeader('admin'))
        .send(verb.body ?? {});

      expect(moved.status).toBeLessThan(400);
      expect(statusUpdateCall()?.data).toMatchObject({ sub_status_id: null });

      // Half 2 - the same verb against a job already AT its target writes no sub_status_id key.
      vi.clearAllMocks();
      installTransactionPassthrough();
      mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
      mockPrisma.job.findMany.mockResolvedValue([]);
      mockPrisma.jobLineItem.findMany.mockResolvedValue([]);
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status: verb.nonMovingFrom, assignees: [], invoices: [], source_plan_id: null,
      });

      const stayed = await request(app)
        .post(`/api/jobs/${JOB_FIXTURE.id}/${verb.path}`)
        .set(authHeader('admin'))
        .send(verb.nonMovingBody ?? verb.body ?? {});

      expect(stayed.status).toBeLessThan(400);
      expect(statusUpdateCall()?.data).not.toHaveProperty('sub_status_id');
    });
  }
});

describe('subStatusClears', () => {
  it('returns {} for an unchanged status and { sub_status_id: null } for a changed one', () => {
    for (const current of Object.values(JobStatus)) {
      for (const next of Object.values(JobStatus)) {
        expect(subStatusClears(current, next)).toEqual(
          current === next ? {} : { sub_status_id: null },
        );
      }
    }
  });
});
