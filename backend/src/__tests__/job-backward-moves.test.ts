import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  planVisit: { updateMany: ReturnType<typeof vi.fn> };
  // S4: the three job-level milestone verbs stamp the job's CURRENT visit through the same writer
  // the per-visit routes use, and /arrive re-derives the job's status from the resulting set.
  visit: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
});

const completedJob = {
  ...JOB_FIXTURE,
  status: 'COMPLETED',
  completed_at: new Date('2026-03-05'),
  started_at: new Date('2026-03-05'),
  on_site_at: new Date('2026-03-05'),
  scheduled_start: new Date('2026-03-05'),
  assignees: [],
  invoices: [],
  source_plan_id: null,
};

describe('backward moves clear later timestamps', () => {
  it('On Site on a completed job clears started_at and completed_at', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    // S4 (D12/D17): ON_SITE left JobStatus, so the job never reads ON_SITE. What it DOES read is
    // re-derived from the visit set, because this write is erasing the completed_at that
    // justified COMPLETED - leaving `status` alone here would strand a job reading Completed with
    // no completion timestamp, on the column the board, the filters, jobs-report and the
    // dashboard KPIs all read. This fixture holds no visits, so the honest answer is UNSCHEDULED.
    expect(data.status).not.toBe('COMPLETED');
    expect(data.status).toBe('UNSCHEDULED');
    // S8 (RATIFIED, A5): on_site_at is DROPPED from `jobs` - arrive() no longer writes it at the
    // job level (it stamps the VISIT's own on_site_at via stampCurrentJobVisitMilestone). Assert
    // its ABSENCE here rather than a stale "was written" expectation.
    expect(data).not.toHaveProperty('on_site_at');
    expect(data.started_at).toBeNull();
    expect(data.completed_at).toBeNull();
  });

  it('Start on a completed job clears completed_at but not on_site_at', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/start`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.completed_at).toBeNull();
    expect(data).not.toHaveProperty('on_site_at');
  });

  it('NEVER clears scheduled_start on any backward move', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty('scheduled_start');
    expect(data).not.toHaveProperty('scheduled_end');
  });

  it('un-cancels a cancelled job moved to any milestone', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...completedJob, status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Customer away',
    });
    // D19: cancelling the job called its trips off, and un-cancelling does not revive them - so
    // the revived job holds no live visit.
    mockPrisma.visit.findMany.mockResolvedValue([
      { id: 'v-1', status: 'CANCELLED', started_at: null, scheduled_at: new Date('2026-03-05T09:00:00Z'), scheduled_end: new Date('2026-03-05T11:00:00Z'), created_at: new Date('2026-03-01T00:00:00Z') },
    ]);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.cancelled_at).toBeNull();
    expect(data.cancelled_reason).toBeNull();
    // The half that makes this an un-cancel rather than an erasure. Clearing the two cancellation
    // columns while leaving `status` at CANCELLED gives a job that still reads Cancelled on the
    // board and in every status query, with the reason it was cancelled deleted - and nothing
    // re-derives it, because the derivation refuses to overwrite a human-set CANCELLED and this
    // handler never calls it.
    expect(data.status).not.toBe('CANCELLED');
    expect(data.status).toBe('UNSCHEDULED');
  });

  it('rewinds the visit it stamps, so the correction is not resurrected by the next visit write', async () => {
    // A technician mis-clicks Start: the visit carries started_at and so does the job. The
    // dispatcher corrects it with On Site (Spec B1 - free backward movement).
    //
    // Stamping the visit ON_SITE while LEAVING its started_at is what makes the correction a
    // no-op: D12 reads IN_PROGRESS off that stamp, so the job derives IN_PROGRESS again here, and
    // the next syncJobFromVisits - any visit added, moved, cancelled or driven on this job -
    // re-mirrors the surviving stamp back onto Job.started_at. There is no route that can un-start
    // a visit, so the dispatcher can never undo it.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...completedJob, status: 'IN_PROGRESS', completed_at: null,
    });
    const visit = {
      id: 'v-1',
      organization_id: '00000000-0000-0000-0000-000000000001',
      job_id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      scheduled_at: new Date('2026-03-05T09:00:00Z'),
      scheduled_end: new Date('2026-03-05T11:00:00Z'),
      en_route_at: null,
      on_site_at: null,
      started_at: new Date('2026-03-05T09:04:00Z'),
      completed_at: null,
      created_at: new Date('2026-03-01T00:00:00Z'),
    };
    mockPrisma.visit.findMany.mockResolvedValue([visit]);
    mockPrisma.visit.update.mockImplementation(async (args: any) => {
      Object.assign(visit, args.data);
      return visit;
    });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    const visitWrite = mockPrisma.visit.update.mock.calls[0]![0];
    expect(visitWrite.where.id).toBe('v-1');
    expect(visitWrite.data.status).toBe('ON_SITE');
    expect(visitWrite.data.started_at).toBeNull();
    expect(visitWrite.data.completed_at).toBeNull();

    // And the job follows the rewound set rather than the stamp that was just dropped.
    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.started_at).toBeNull();
    expect(data.status).toBe('SCHEDULED');
  });

  it('reverts the linked PlanVisit when completion is cleared', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...completedJob, source_plan_id: 'plan-1' });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    // complete() cascades the visit to COMPLETED; without this the visit stays consumed and
    // servicePlans/derive.ts keeps visits_remaining decremented forever.
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SCHEDULED', completed_at: null } }),
    );
  });

  it('does not touch PlanVisit for a job with no source plan', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    expect(mockPrisma.planVisit.updateMany).not.toHaveBeenCalled();
  });

  it('writes a timeline event BEFORE clearing, so the audit trail has no holes', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalled();
    const timelineCallOrder = mockPrisma.timelineEvent.create.mock.invocationCallOrder[0];
    const updateCallOrder = mockPrisma.job.update.mock.invocationCallOrder[0];
    expect(timelineCallOrder).toBeLessThan(updateCallOrder);
  });

  it('preserves the signature and completion notes when re-completing with an empty body', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...completedJob, signature_data: 'data:image/png;base64,AAA', completion_notes: 'Replaced compressor',
    });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/complete`).set(authHeader('admin')).send({});

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.signature_data).toBeUndefined();   // undefined = leave the stored value alone
    expect(data.completion_notes).toBeUndefined();
  });
});
