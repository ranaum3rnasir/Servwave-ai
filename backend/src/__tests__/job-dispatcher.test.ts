import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  TEST_ORG,
  mockAuthAs,
  authHeader,
  JOB_FIXTURE,
  ALPHA_ORG_ID,
  mockScopedFindFirst,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

// Existence read shape (setDispatcher's tenant-scoped findUnique).
const JOB_ROW = { id: JOB_FIXTURE.id, job_number: JOB_FIXTURE.job_number, dispatcher_id: null };

// setDispatcher runs tx.job.update + tx.timelineEvent.create + tx.job.findUnique (detail re-read).
function wireDispatcherTx(updated: unknown) {
  const txJobUpdate = vi.fn().mockResolvedValue(updated);
  const txTimeline = vi.fn().mockResolvedValue({});
  const txJobFindUnique = vi.fn().mockResolvedValue(updated);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: { update: txJobUpdate, findUnique: txJobFindUnique },
      timelineEvent: { create: txTimeline },
    }),
  );
  return { txJobUpdate, txTimeline, txJobFindUnique };
}

// ─── POST /api/jobs/:id/dispatcher ─────────────────────

describe('POST /api/jobs/:id/dispatcher', () => {
  it('admin sets a DISPATCHER-role user as dispatcher (200, update + {job} response)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: TEST_USERS.dispatcher.id });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(tx.txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_FIXTURE.id },
        data: { dispatcher_id: TEST_USERS.dispatcher.id },
      }),
    );
  });

  it('admin sets an ADMIN-role user as dispatcher (ADMIN is dispatcher-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: TEST_USERS.admin.id });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.admin.id });

    expect(res.status).toBe(200);
    expect(tx.txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dispatcher_id: TEST_USERS.admin.id } }),
    );
  });

  it('admin clears the dispatcher with dispatcher_id: null', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, dispatcher_id: TEST_USERS.dispatcher.id });
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: null });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: null });

    expect(res.status).toBe(200);
    expect(tx.txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dispatcher_id: null } }),
    );
    // No target-user eligibility lookup on clear — user.findUnique only served authenticate.
  });

  it('rejects a SALES-role target (400, not dispatcher-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.sales.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eligible/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a TECHNICIAN-role target (400, not dispatcher-eligible)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.technician.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eligible/);
  });

  it('rejects an inactive DISPATCHER target (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        if (args.where.id === TEST_USERS.dispatcher.id) {
          return Promise.resolve({ ...TEST_USERS.dispatcher, is_active: false, organization: TEST_ORG });
        }
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown/cross-tenant target user (tenant-scoped lookup)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    const strangerId = '00000000-0000-0000-0000-777777777777';

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: strangerId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    // Tenancy: the target lookup carries organization_id from tenantWhere(req).
    const targetLookup = (prisma.user.findUnique as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0]?.where?.id === strangerId,
    );
    expect(targetLookup).toBeDefined();
    expect(targetLookup![0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('returns 404 when the job is not found in the tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    // Tenancy: the job read carries organization_id from tenantWhere(req).
    const jobLookup = mockPrisma.job.findUnique.mock.calls[0][0];
    expect(jobLookup.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  // TECHNICIAN holds `assign Job` since the technician-ownership spec, Part C, conditioned on
  // `created_by_id` - so this route is no longer closed to the role outright, only to jobs the
  // technician did not create. The refusal moved from the route guard into the handler's
  // per-instance check; the shape of the test is what changed, not the outcome for this caller.
  it('returns 403 for a TECHNICIAN caller on a job they did not create', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      created_by_id: TEST_USERS.admin.id,
      assignees: [],
    });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      assignees: [],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('technician'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(403);
  });

  it('returns 400 when dispatcher_id is missing (Zod)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when dispatcher_id is not a uuid (Zod)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('writes a JOB timeline event with the org id when the dispatcher changes', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW); // dispatcher_id: null → change
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: TEST_USERS.dispatcher.id });

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(tx.txTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ALPHA_ORG_ID,
          entity_type: 'JOB',
          entity_id: JOB_FIXTURE.id,
          event_type: 'DISPATCHER_CHANGED',
        }),
      }),
    );
  });

  it('does NOT write a timeline event when the value did not change', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, dispatcher_id: TEST_USERS.dispatcher.id });
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: TEST_USERS.dispatcher.id });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(200);
    expect(tx.txTimeline).not.toHaveBeenCalled();
  });

  // #585 — dispatcher changes on a lead-originated job also land on the LEAD timeline.
  it('mirrors a DISPATCHER_CHANGED event onto the originating lead', async () => {
    mockAuthAs('admin');
    const leadId = '00000000-0000-0000-0000-0000000000aa';
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, estimate: { lead_id: leadId } });
    const tx = wireDispatcherTx({ ...JOB_FIXTURE, dispatcher_id: TEST_USERS.dispatcher.id });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/dispatcher`)
      .set(authHeader('admin'))
      .send({ dispatcher_id: TEST_USERS.dispatcher.id });

    expect(res.status).toBe(200);
    // The JOB event is still written.
    expect(tx.txTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entity_type: 'JOB', event_type: 'DISPATCHER_CHANGED' }),
      }),
    );
    // AND the mirrored LEAD event.
    expect(tx.txTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'LEAD',
          entity_id: leadId,
          event_type: 'DISPATCHER_CHANGED',
          organization_id: ALPHA_ORG_ID,
        }),
      }),
    );
  });
});
