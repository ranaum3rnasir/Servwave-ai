/**
 * jobs-bulk-actions.test.ts (SRVW-104)
 *
 * POST /api/jobs/bulk-status and POST /api/jobs/bulk-assign - per-id loop through the EXISTING
 * verb handlers (start/complete/cancel/arrive/setAssignees), never a bare prisma.job.updateMany.
 * setup.ts's job mock (:311-322) has no `updateMany` key, so any updateMany in the implementation
 * TypeErrors in every case below - that is the harness itself enforcing the no-updateMany
 * directive, which is why there is no `.not.toHaveBeenCalled()` guard here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// dispatchAutomationEvent is already globally mocked in setup.ts (fire-and-forget, real would
// leak across tests) - imported directly here for assertions, same as jobs.test.ts.
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as any;

function emitCalls(verb: string) {
  return mockEmit.mock.calls.filter((c: any[]) => c[0].verb === verb);
}
function dispatchCalls(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

const ID_A = 'a0000000-0000-0000-0000-00000000000a';
const ID_B = 'a0000000-0000-0000-0000-00000000000b';
const ID_C = 'a0000000-0000-0000-0000-00000000000c';
const FOREIGN_ID = 'a0000000-0000-0000-0000-0000000000ff';
const MISSING_ID = 'a0000000-0000-0000-0000-0000000000ee';

/** S8: the one trip a job-level crew statement lands on in these fixtures. */
const FIXTURE_VISIT = {
  id: 'v0000000-0000-0000-0000-0000000000f1',
  job_id: null as string | null,
  lead_id: null,
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-10-01T09:00:00.000Z'),
  scheduled_end: new Date('2026-10-01T11:00:00.000Z'),
  is_all_day: false,
  created_at: new Date('2026-09-01T00:00:00.000Z'),
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
  assignees: [] as { user_id: string }[],
};

function jobRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...JOB_FIXTURE,
    id,
    job_number: `J-${id.slice(-4)}`,
    assignees: [],
    // S8 (D6): crew lives on the trips; the payload key is derived from them.
    visits: [FIXTURE_VISIT],
    invoices: [],
    source_plan_id: null,
    ...overrides,
  };
}

/**
 * Wire the $transaction mock used by setAssignees().
 *
 * `visitAssignee.findMany` is listed because replaceJobCrew reads the job's per-visit crew
 * inside the transaction to build the union. It is a fixture concern only: the production
 * route was never broken, the fake had simply stopped modelling the tx client the route uses.
 * The spy is returned so a caller can assert on the union read.
 */
function wireSetAssigneesTx() {
  const visitAssigneeFindMany = vi.fn().mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: mockPrisma.jobAssignee.createMany,
        deleteMany: mockPrisma.jobAssignee.deleteMany,
      },
      visitAssignee: {
        findMany: visitAssigneeFindMany,
        // S8 (D6): the crew statement lands on the trip, so the WRITE delegates are needed too.
        createMany: mockPrisma.visitAssignee.createMany,
        deleteMany: mockPrisma.visitAssignee.deleteMany,
      },
      // S8 (D6): resolveCurrentJobVisit reads the job's trips on the tx client.
      visit: { findMany: vi.fn().mockResolvedValue([FIXTURE_VISIT]) },
      timelineEvent: { create: mockPrisma.timelineEvent.create },
      job: { findUnique: mockPrisma.job.findUnique },
    }),
  );
  return { visitAssigneeFindMany };
}

/** Wire the $transaction mock used by cancel(). */
function wireCancelTx() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      invoice: { update: mockPrisma.invoice.update },
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
      visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      timelineEvent: { create: mockPrisma.timelineEvent.create },
      job: { update: mockPrisma.job.update },
      planVisit: { updateMany: vi.fn() },
      logisticOrder: { updateMany: vi.fn() },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.jobAssignee.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.jobAssignee.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
});

// ─── POST /api/jobs/bulk-status ─────────────────────────────────────────────

describe('POST /api/jobs/bulk-status', () => {
  it('action=start updates every id, reproduces the single-job side effects, and does exactly one write per id', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'start' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([ID_A, ID_B]);
    expect(res.body.failed).toEqual([]);

    const startedEvents = mockPrisma.timelineEvent.create.mock.calls.filter(
      (c: any[]) => c[0].data.event_type === 'STARTED',
    );
    expect(startedEvents).toHaveLength(2);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.job.update.mock.calls) {
      expect(call[0].data.status).toBe('IN_PROGRESS');
      expect(call[0].data.started_at).toBeInstanceOf(Date);
      expect(call[0].data.completed_at).toBeNull();
      expect(call[0].data.cancelled_at).toBeNull();
      expect(call[0].data.cancelled_reason).toBeNull();
    }

    expect(emitCalls('job.started')).toHaveLength(2);
  });

  it('spreads tenantWhere on every read and every write, and actually performs them', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'complete' });

    expect(res.status).toBe(200);

    expect(mockPrisma.job.findUnique.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(2);

    const orgId = TEST_USERS.admin.organization_id;
    for (const call of mockPrisma.job.findUnique.mock.calls) {
      expect(call[0].where.organization_id).toBe(orgId);
    }
    for (const call of mockPrisma.job.update.mock.calls) {
      expect(call[0].where.organization_id).toBe(orgId);
    }
  });

  it('a cross-org id lands in failed and is never mutated while the rest of the batch succeeds', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(null); // FOREIGN_ID misses tenantWhere
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, FOREIGN_ID], action: 'start' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([ID_A]);
    expect(res.body.failed).toEqual([{ id: FOREIGN_ID, error: 'Job not found' }]);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
  });

  it('a technician gets per-instance denial on an unassigned job and success on an assigned one, in the same batch', async () => {
    mockAuthAs('technician');
    // canAccessRow('Job') for TECHNICIAN resolves OWN_JOB via findFirst (conditional read grant).
    mockPrisma.job.findFirst
      .mockResolvedValueOnce(null) // ID_A: not assigned to this technician
      .mockResolvedValueOnce({ id: ID_B }); // ID_B: assigned
    mockPrisma.job.findUnique.mockResolvedValueOnce(
      jobRow(ID_B, { assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ ...FIXTURE_VISIT, assignees: [{ user_id: TEST_USERS.technician.id }] }] }),
    );
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_B));

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('technician'))
      .send({ ids: [ID_A, ID_B], action: 'start' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([ID_B]);
    expect(res.body.failed).toEqual([{ id: ID_A, error: 'Insufficient permissions' }]);
  });

  it('403s the whole request when the caller lacks the verb capability', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('technician'))
      .send({ ids: [ID_A, ID_B], action: 'cancel', cancelled_reason: 'no longer needed' });

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('rejects an empty ids array, more than 100 ids, duplicate ids, and cancel without a reason', async () => {
    mockAuthAs('admin');

    const empty = await request(app).post('/api/jobs/bulk-status').set(authHeader('admin')).send({ ids: [], action: 'start' });
    expect(empty.status).toBe(400);

    const tooMany = await request(app).post('/api/jobs/bulk-status').set(authHeader('admin')).send({
      ids: Array.from({ length: 101 }, (_, i) => `a0000000-0000-0000-0000-${String(i).padStart(12, '0')}`),
      action: 'start',
    });
    expect(tooMany.status).toBe(400);

    const dup = await request(app).post('/api/jobs/bulk-status').set(authHeader('admin')).send({ ids: [ID_A, ID_A], action: 'start' });
    expect(dup.status).toBe(400);

    const noReason = await request(app).post('/api/jobs/bulk-status').set(authHeader('admin')).send({ ids: [ID_A], action: 'cancel' });
    expect(noReason.status).toBe(400);

    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('action=cancel applies the identical invoice-void cascade per id AND reports the voided invoices in the response', async () => {
    mockAuthAs('admin');
    wireCancelTx();
    const invoiceA = { id: 'inv-a', status: 'SENT', kind: 'STANDARD', amount_due: 100, total_amount: 100, payments: [], refunds: [] };
    const invoiceB = { id: 'inv-b', status: 'SENT', kind: 'STANDARD', amount_due: 100, total_amount: 100, payments: [], refunds: [] };
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A, { invoices: [invoiceA] }))
      .mockResolvedValueOnce(jobRow(ID_B, { invoices: [invoiceB] }));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));
    mockPrisma.invoice.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'cancel', cancelled_reason: 'customer cancelled' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.invoice.update.mock.calls) {
      expect(call[0].data.status).toBe('VOIDED');
      expect(call[0].data.amount_due).toBe(0);
    }
    const voidedEvents = mockPrisma.timelineEvent.create.mock.calls.filter(
      (c: any[]) => c[0].data.event_type === 'INVOICE_VOIDED',
    );
    expect(voidedEvents).toHaveLength(2);
    const cancelledEvents = mockPrisma.timelineEvent.create.mock.calls.filter(
      (c: any[]) => c[0].data.event_type === 'CANCELLED',
    );
    expect(cancelledEvents).toHaveLength(2);
    for (const call of cancelledEvents) {
      expect(call[0].data.metadata.reason).toBe('customer cancelled');
    }
    expect(res.body.voided_invoice_ids).toEqual(expect.arrayContaining(['inv-a', 'inv-b']));
    expect(res.body.voided_invoice_ids).toHaveLength(2);
  });

  it('fires the customer-visible automation dispatch exactly once per id, never more', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B))
      .mockResolvedValueOnce(jobRow(ID_C));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B, ID_C], action: 'complete' });

    expect(res.status).toBe(200);
    const completedDispatches = dispatchCalls('JOB_COMPLETED');
    expect(completedDispatches).toHaveLength(3);
    const distinctIds = new Set(completedDispatches.map((d: any) => d.entity.id));
    expect(distinctIds.size).toBe(3);
    expect(emitCalls('job.completed')).toHaveLength(3);

    vi.clearAllMocks();
    mockAuthAs('admin');
    wireCancelTx();
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A, { invoices: [] }))
      .mockResolvedValueOnce(jobRow(ID_B, { invoices: [] }));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const cancelRes = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'cancel', cancelled_reason: 'dup fires check' });

    expect(cancelRes.status).toBe(200);
    expect(dispatchCalls('JOB_CANCELLED')).toHaveLength(2);
  });

  it('action=arrive and action=start dispatch NO automation event at all', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const arriveRes = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'arrive' });
    expect(arriveRes.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B));
    mockPrisma.job.update.mockResolvedValue(jobRow(ID_A));

    const startRes = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], action: 'start' });
    expect(startRes.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects en_route as an unknown action', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [ID_A], action: 'en_route' });

    expect(res.status).toBe(400);
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
  });
});

// ─── POST /api/jobs/bulk-assign ─────────────────────────────────────────────

describe('POST /api/jobs/bulk-assign', () => {
  it('replaces crew on every id without touching status or schedule', async () => {
    mockAuthAs('admin');
    wireSetAssigneesTx();
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A)) // existing lookup, no crew
      .mockResolvedValueOnce(jobRow(ID_A, { assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ ...FIXTURE_VISIT, assignees: [{ user_id: TEST_USERS.technician.id }] }] })) // tx re-read
      .mockResolvedValueOnce(jobRow(ID_B))
      .mockResolvedValueOnce(jobRow(ID_B, { assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ ...FIXTURE_VISIT, assignees: [{ user_id: TEST_USERS.technician.id }] }] }));
    mockPrisma.user.findUnique.mockResolvedValue({
      id: TEST_USERS.technician.id, role: 'TECHNICIAN', is_active: true,
      email: TEST_USERS.technician.email, first_name: TEST_USERS.technician.first_name, last_name: TEST_USERS.technician.last_name,
    });

    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], assignee_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([ID_A, ID_B]);
    // S8 (D6): the crew write lands on the trip - visit_assignees, not the dropped table.
    expect(mockPrisma.visitAssignee.createMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.jobAssignee.createMany).not.toHaveBeenCalled();
    const addedEvents = mockPrisma.timelineEvent.create.mock.calls.filter(
      (c: any[]) => c[0].data.event_type === 'CREW_MEMBER_ADDED',
    );
    expect(addedEvents).toHaveLength(2);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();

    const techAssigned = dispatchCalls('TECH_ASSIGNED');
    expect(techAssigned).toHaveLength(2);
  });

  it('with notify.email false suppresses the TECH_ASSIGNED dispatch for the whole batch', async () => {
    mockAuthAs('admin');
    wireSetAssigneesTx();
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_A, { assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ ...FIXTURE_VISIT, assignees: [{ user_id: TEST_USERS.technician.id }] }] }))
      .mockResolvedValueOnce(jobRow(ID_B))
      .mockResolvedValueOnce(jobRow(ID_B, { assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ ...FIXTURE_VISIT, assignees: [{ user_id: TEST_USERS.technician.id }] }] }));
    mockPrisma.user.findUnique.mockResolvedValue({
      id: TEST_USERS.technician.id, role: 'TECHNICIAN', is_active: true,
      email: TEST_USERS.technician.email, first_name: TEST_USERS.technician.first_name, last_name: TEST_USERS.technician.last_name,
    });

    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], assignee_ids: [TEST_USERS.technician.id], notify: { email: false } });

    expect(res.status).toBe(200);
    // S8 (D6): the crew write lands on the trip - visit_assignees, not the dropped table.
    expect(mockPrisma.visitAssignee.createMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.jobAssignee.createMany).not.toHaveBeenCalled();
    expect(dispatchCalls('TECH_ASSIGNED')).toHaveLength(0);
  });

  it('reports validateCrew rejection per row and isolates a not-found id instead of aborting', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_B));
    mockPrisma.user.findUnique.mockResolvedValue({
      id: TEST_USERS.technician.id, role: 'TECHNICIAN', is_active: false,
      email: TEST_USERS.technician.email, first_name: TEST_USERS.technician.first_name, last_name: TEST_USERS.technician.last_name,
    });

    const res = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, ID_B], assignee_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed).toEqual([
      { id: ID_A, error: 'Cannot assign job to an inactive technician' },
      { id: ID_B, error: 'Cannot assign job to an inactive technician' },
    ]);
    expect(mockPrisma.jobAssignee.createMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAuthAs('admin');
    wireSetAssigneesTx();
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobRow(ID_A))
      .mockResolvedValueOnce(jobRow(ID_A, { assignees: [] }))
      .mockResolvedValueOnce(null);

    const res2 = await request(app)
      .post('/api/jobs/bulk-assign')
      .set(authHeader('admin'))
      .send({ ids: [ID_A, MISSING_ID], assignee_ids: [] });

    expect(res2.status).toBe(200);
    expect(res2.body.updated).toEqual([ID_A]);
    expect(res2.body.failed).toEqual([{ id: MISSING_ID, error: 'Job not found' }]);
  });
});
