/**
 * assign-notify-options.test.ts (#361)
 *
 * The Workiz-style assign popover lets the user choose notification channels.
 * Backend contract:
 *   - POST /api/jobs/:id/assignees accepts optional notify { in_app?, email? }:
 *       in_app:false → suppress the dispatch.job_assigned emit for added crew ONLY
 *       email:false  → suppress the added-crew assignment email ONLY
 *       removal notices (dispatch.job_unassigned + unassigned email) stay unconditional
 *   - POST /api/leads/:id/assign accepts optional notify { in_app? }:
 *       in_app:false → suppress the lead.assigned emit ONLY
 *       lead.reassigned_away to the previous owner stays unconditional
 *   - notify omitted → today's behavior exactly (backward compat for SchedulePage etc.)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  JOB_FIXTURE,
  LEAD_FIXTURE,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// TECH_ASSIGNED/TECH_UNASSIGNED now travel through dispatchAutomationEvent rather
// than a hard-coded sender — mocked here (mirroring automation-wiring.test.ts).
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as any;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emitCall(verb: string) {
  return mockEmit.mock.calls.find((c: any[]) => c[0].verb === verb);
}

function dispatchedType(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

/** Wire the $transaction mock used by setAssignees(). */
function wireSetAssigneesTx(updatedJob: any, currentCrew: { user_id: string }[] = []) {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      // S8 (D6): the crew statement lands on the job's CURRENT visit, so the tx client needs the
      // `visit` delegate - a write to a delegate a hand-listed tx fake omits throws INSIDE the
      // transaction and the route 500s with no useful message.
      visit: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'v0000000-0000-0000-0000-0000000000f1', job_id: JOB_FIXTURE.id, lead_id: null,
            visit_seq: 1, status: 'SCHEDULED',
            scheduled_at: new Date('2026-10-01T09:00:00.000Z'),
            scheduled_end: new Date('2026-10-01T11:00:00.000Z'),
            is_all_day: false, created_at: new Date('2026-09-01T00:00:00.000Z'),
            en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
          },
        ]),
        create: vi.fn().mockResolvedValue({ id: 'v0000000-0000-0000-0000-0000000000f1', visit_seq: 1 }),
        update: vi.fn().mockResolvedValue({ id: 'v0000000-0000-0000-0000-0000000000f1', visit_seq: 1 }),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
      },
      // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
      // transaction, so the union it writes can never evict someone off another visit. Without
      // this delegate the read throws inside the tx and the route 500s opaquely.
      visitAssignee: {
        // S8 (D6): the crew that is really on the trip - the delta the notifications read comes
        // off THIS delegate now, not the dropped job-level one.
        findMany: vi.fn().mockResolvedValue(currentCrew),
        // S3: /assign now restates the named crew on the visit it booked or moved, so this
        // tx client needs the WRITE delegates too, not just the union read.
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue(currentCrew),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { findUnique: vi.fn().mockResolvedValue(updatedJob) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
}

/** Wire the $transaction mock used by lead assign(). */
function wireLeadAssignTx(updatedLead: any) {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      leadAssignee: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      lead: { update: vi.fn().mockResolvedValue(updatedLead) },
    }),
  );
}

/** Flush the post-response fire-and-forget email path. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
});

// ─── POST /api/jobs/:id/assignees — notify options ──────────────────────────

describe('POST /api/jobs/:id/assignees — notify options (#361)', () => {
  it('notify.in_app:false suppresses dispatch.job_assigned but STILL dispatches TECH_ASSIGNED', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // no current crew
    wireSetAssigneesTx({ ...JOB_FIXTURE, assignees: [{ user_id: TEST_USERS.technician.id }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.technician.id], notify: { in_app: false } });

    expect(res.status).toBe(200);
    await flush();

    expect(emitCall('dispatch.job_assigned')).toBeUndefined();
    expect(dispatchedType('TECH_ASSIGNED')).toHaveLength(1);
  });

  it('notify.email:false suppresses the TECH_ASSIGNED dispatch but STILL emits dispatch.job_assigned; removal path unaffected', async () => {
    mockAuthAs('admin');
    // Current crew = [sales]; new crew = [technician] → tech added, sales removed.
    // S8 (D6): the PRE-read crew is the union across the job's trips.
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ ...JOB_FIXTURE, visits: [{ assignees: [{ user_id: TEST_USERS.sales.id }] }] });
    wireSetAssigneesTx(
      { ...JOB_FIXTURE, assignees: [{ user_id: TEST_USERS.technician.id }] },
      [{ user_id: TEST_USERS.sales.id }],
    );
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TEST_USERS.sales.id, email: TEST_USERS.sales.email, first_name: TEST_USERS.sales.first_name, last_name: TEST_USERS.sales.last_name },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.technician.id], notify: { email: false } });

    expect(res.status).toBe(200);
    await flush();

    // Added-member dispatch suppressed; in-app emit still fires.
    expect(dispatchedType('TECH_ASSIGNED')).toHaveLength(0);
    expect(emitCall('dispatch.job_assigned')).toBeDefined();
    // Removal notices are unconditional.
    expect(emitCall('dispatch.job_unassigned')).toBeDefined();
    const unassigned = dispatchedType('TECH_UNASSIGNED');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]).toMatchObject({ eventPayload: { recipient: { id: TEST_USERS.sales.id } } });
  });

  it('notify omitted → both the emit and the TECH_ASSIGNED dispatch fire (backward compat)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireSetAssigneesTx({ ...JOB_FIXTURE, assignees: [{ user_id: TEST_USERS.technician.id }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TEST_USERS.technician.id] });

    expect(res.status).toBe(200);
    await flush();

    expect(emitCall('dispatch.job_assigned')).toBeDefined();
    expect(dispatchedType('TECH_ASSIGNED')).toHaveLength(1);
  });
});

// ─── POST /api/leads/:id/assign — notify options ────────────────────────────

describe('POST /api/leads/:id/assign — notify options (#361)', () => {
  it('notify.in_app:false suppresses lead.assigned but lead.reassigned_away still fires', async () => {
    mockAuthAs('admin');
    // LEAD_FIXTURE's current owner is TEST_USERS.sales → reassigning away from sales.
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    wireLeadAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.technician.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.technician.id, notify: { in_app: false } });

    expect(res.status).toBe(200);
    expect(emitCall('lead.assigned')).toBeUndefined();
    const away = emitCall('lead.reassigned_away');
    expect(away).toBeDefined();
    expect(away![0].entity.previous_owner_id).toBe(TEST_USERS.sales.id);
  });

  it('notify omitted → lead.assigned fires (backward compat)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    wireLeadAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.technician.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.technician.id });

    expect(res.status).toBe(200);
    const assigned = emitCall('lead.assigned');
    expect(assigned).toBeDefined();
    expect(assigned![0].entity.commission_owner_id).toBe(TEST_USERS.technician.id);
  });
});
