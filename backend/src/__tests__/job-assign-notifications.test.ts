/**
 * job-assign-notifications.test.ts
 *
 * TDD for Task 3.1: emit() hook wired into the job assign / setAssignees endpoints.
 *
 * Strategy:
 *   - vi.mock('../services/notifications/notificationService') captures emit calls.
 *   - Three scenarios on assign():
 *       1. addedIds.length > 0          → dispatch.job_assigned  (entity.assignee_ids = addedIds)
 *       2. removedIds.length > 0, !add  → dispatch.job_unassigned (entity.assignee_ids = removedIds)
 *       3. timeChanged && addedIds == 0 → dispatch.job_rescheduled (entity.assignee_ids = kept crew)
 *   - One scenario on setAssignees():
 *       4. addedIds.length > 0          → dispatch.job_assigned
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  TEST_ORG,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  JOB_FIXTURE,
  ALPHA_ORG_ID,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Test fixtures ───────────────────────────────────────────────────────────

const TECH_USER = {
  ...TEST_USERS.technician,
  email: 'tech@test.com',
  first_name: 'Test',
  last_name: 'Tech',
};

const TECH2_ID = '00000000-0000-0000-0000-000000000099';
const TECH2_USER = {
  id: TECH2_ID,
  email: 'tech2@test.com',
  first_name: 'Tech',
  last_name: 'Two',
  role: 'TECHNICIAN' as const,
  is_active: true,
  organization_id: ALPHA_ORG_ID,
};

// A SCHEDULED job fixture for reschedule/removal tests.
const SCHEDULED_JOB_FIXTURE = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  scheduled_start: new Date('2026-06-01T09:00:00Z'),
  scheduled_end: new Date('2026-06-01T11:00:00Z'),
  assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
  customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wire the $transaction mock used by assign().
 * Returns tx spy handles so individual tests can assert on them.
 */
/**
 * `currentCrew` must AGREE with the crew on the job fixture the handler pre-reads. From S3 the
 * added/removed diff that drives the timeline events and the dispatches is the one replaceJobCrew
 * actually computed inside this transaction (under the union, the request's omissions are not the
 * same thing as a removal), so a fake that says "nobody is on this job" while the fixture says
 * otherwise now silently produces an empty diff.
 */
/**
 * `visits` describes the job's TRIPS, and it is not optional decoration for a job that is already
 * on the calendar. From S3 a scheduled, crewed job always has at least one visit carrying that
 * crew - the migration folds it there, and every booking made since lands it there - so wiring
 * "this job has no visits and nobody is on any of them" describes a row the database cannot hold,
 * and it is the exact input that hides a removal regression: the union read comes back empty, so
 * whatever ordering the handler uses, the request's omissions look like removals. The
 * visit_assignees delegate is therefore STATEFUL, so what the union reads is what the visit write
 * left behind rather than a fixture.
 */
function wireAssignTx(
  updatedJob: any,
  currentCrew: { user_id: string }[] = [],
  visits: { liveVisits?: any[]; crew?: { visit_id: string; user_id: string }[] } = {},
) {
  // Conflict queries default to "no conflict".
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);

  const liveVisits = visits.liveVisits ?? [];
  const visitRows = [...(visits.crew ?? [])];
  const visitIdsOfJob = new Set(liveVisits.map((v) => v.id));
  const matchesVisit = (r: { visit_id: string; user_id: string }, where: any) => {
    if (where?.visit?.job_id !== undefined && !visitIdsOfJob.has(r.visit_id)) return false;
    if (where?.visit_id !== undefined && r.visit_id !== where.visit_id) return false;
    if (where?.user_id?.in !== undefined && !where.user_id.in.includes(r.user_id)) return false;
    return true;
  };

  const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
  const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobUpdate = vi.fn().mockResolvedValue(updatedJob);
  const txTimeline = vi.fn().mockResolvedValue({});
  const txPlanVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        visit: {
          findMany: vi.fn().mockResolvedValue(liveVisits),
          create: vi.fn().mockResolvedValue({ id: 'v0000000-0000-0000-0000-0000000000ff' }),
          update: vi.fn().mockResolvedValue({}),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
      // transaction, so the union it writes can never evict someone off another visit. Without
      // this delegate the read throws inside the tx and the route 500s opaquely.
      visitAssignee: {
        findMany: vi.fn(async ({ where }: any) =>
          visitRows.filter((r) => matchesVisit(r, where)).map((r) => ({ user_id: r.user_id, visit_id: r.visit_id })),
        ),
        // S3: /assign now lands the crew change on the visit it booked or moved, so this tx
        // client needs the WRITE delegates too, not just the union read - and they have to MOVE
        // the same rows the read serves, or the read would be answering from a fixture.
        createMany: vi.fn(async ({ data }: any) => {
          const list = Array.isArray(data) ? data : [data];
          for (const row of list) visitRows.push({ visit_id: row.visit_id, user_id: row.user_id });
          return { count: list.length };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
          let removed = 0;
          for (let i = visitRows.length - 1; i >= 0; i--) {
            if (matchesVisit(visitRows[i]!, where)) {
              visitRows.splice(i, 1);
              removed++;
            }
          }
          return { count: removed };
        }),
      },
      jobAssignee: {
        findMany: txJobAssigneeFindMany,
        createMany: txJobAssigneeCreateMany,
        deleteMany: txJobAssigneeDeleteMany,
      },
      job: { update: txJobUpdate },
      timelineEvent: { create: txTimeline },
      planVisit: { updateMany: txPlanVisitUpdateMany },
    }),
  );

  return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txJobUpdate, txTimeline };
}

/**
 * Wire the $transaction mock used by setAssignees().
 * setAssignees() reads back the job at the end via tx.job.findUnique.
 */
function wireSetAssigneesTx(updatedJob: any, currentCrew: { user_id: string }[] = []) {
  const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
  const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobFindUnique = vi.fn().mockResolvedValue(updatedJob);
  const txTimeline = vi.fn().mockResolvedValue({});

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        // S8 (D6): the crew statement lands on the job's CURRENT visit, so it needs one.
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
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
      // S8 (D6): the crew delta the notifications read comes off THIS delegate now.
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue(currentCrew),
        // S3: /assign now restates the named crew on the visit it booked or moved, so this
        // tx client needs the WRITE delegates too, not just the union read.
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: txJobAssigneeFindMany,
        createMany: txJobAssigneeCreateMany,
        deleteMany: txJobAssigneeDeleteMany,
      },
      job: { findUnique: txJobFindUnique },
      timelineEvent: { create: txTimeline },
    }),
  );

  return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txJobFindUnique, txTimeline };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  // Deposit-gate default: no deposit invoice present.
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // loadGrantsFor() used by the canDo middleware.
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // mockAuthAs already sets up findUnique + userPermissionOverride defaults.
});

// ── Regression guard for #271 ────────────────────────────────────────────────
// Notification emits MUST fire post-commit, never inside a $transaction. Passing a
// tx client to emit() silently drops the notification in prod (filterByAccess reads
// on the global prisma connection while the caller's txn holds the row). Fail loudly
// if any emit in any test carries a tx.
afterEach(() => {
  for (const call of mockEmit.mock.calls) {
    expect(
      (call[0] as { tx?: unknown }).tx,
      `emit('${(call[0] as { verb?: string }).verb}') must be called post-commit, without a tx client (#271)`,
    ).toBeUndefined();
  }
});

// ─── POST /api/jobs/:id/assign → dispatch.job_assigned ──────────────────────

describe('POST /api/jobs/:id/assign — notification hooks', () => {
  it('emits dispatch.job_assigned with the added tech id when crew member is added', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, no current assignees

    // mockAuthAs wires user.findUnique for TEST_USERS by id.
    // TECH_USER.id === TEST_USERS.technician.id → already handled.
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-08-01T09:00:00Z',
        scheduled_end: '2026-08-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    // emit should have been called at least once with job_assigned.
    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_assigned',
    );
    expect(assignedCall).toBeDefined();
    const assignedArgs = assignedCall![0];
    expect(assignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(assignedArgs.object.type).toBe('JOB');
    expect(assignedArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(assignedArgs.object.label).toBe(JOB_FIXTURE.job_number);
    expect(assignedArgs.organizationId).toBe(ALPHA_ORG_ID);
    expect(assignedArgs.actorId).toBe(TEST_USERS.admin.id);
  });

  it('emits dispatch.job_unassigned with the removed tech id when a crew member is removed', async () => {
    // Existing crew = [TECH_USER, TECH2_USER]; new crew = [TECH_USER] → TECH2 is removed.
    mockAuthAs('admin');
    const fixture = {
      ...SCHEDULED_JOB_FIXTURE,
      assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }], visits: [{ assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }] }],
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);

    // user.findUnique must resolve TECH2 too.
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === TECH2_ID) return Promise.resolve({ ...TECH2_USER, organization: TEST_ORG });
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
    });

    // The post-migration shape of an already-scheduled crewed job: one live visit carrying both.
    const VISIT_1 = 'v0000000-0000-0000-0000-000000000001';
    wireAssignTx(
      { ...fixture, assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }] },
      [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }],
      {
        liveVisits: [{
          id: VISIT_1, job_id: JOB_FIXTURE.id, visit_seq: 1, status: 'SCHEDULED',
          scheduled_at: new Date('2026-06-01T09:00:00Z'),
          scheduled_end: new Date('2026-06-01T11:00:00Z'),
          created_at: new Date('2026-05-20T10:00:00Z'),
        }],
        crew: [
          { visit_id: VISIT_1, user_id: TECH_USER.id },
          { visit_id: VISIT_1, user_id: TECH2_ID },
        ],
      },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        // Keep TECH_USER, drop TECH2.
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-06-01T09:00:00Z', // same time → timeChanged=false
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_unassigned',
    );
    expect(unassignedCall).toBeDefined();
    const unassignedArgs = unassignedCall![0];
    expect(unassignedArgs.entity.assignee_ids).toContain(TECH2_ID);
    expect(unassignedArgs.object.id).toBe(JOB_FIXTURE.id);
  });

  it('emits dispatch.job_rescheduled to current (kept) assignees when only the time changes', async () => {
    // Existing crew = [TECH_USER]; new crew = [TECH_USER] (no add/remove); time changes.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    // S8 (D6): a scheduled, crewed job HAS a trip carrying that crew - wiring "no visits" would
    // describe a row the database cannot hold, and the wholesale-replace branch would then report
    // the kept technician as newly added, suppressing the reschedule notice under test.
    wireAssignTx(
      { ...SCHEDULED_JOB_FIXTURE, scheduled_start: new Date('2026-09-01T09:00:00Z') },
      [{ user_id: TECH_USER.id }],
      {
        liveVisits: [
          {
            id: 'v0000000-0000-0000-0000-0000000000f1', job_id: JOB_FIXTURE.id, lead_id: null,
            visit_seq: 1, status: 'SCHEDULED',
            scheduled_at: new Date('2026-06-01T09:00:00Z'),
            scheduled_end: new Date('2026-06-01T11:00:00Z'),
            is_all_day: false, created_at: new Date('2026-05-01T00:00:00Z'),
            en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
          },
        ],
        crew: [{ visit_id: 'v0000000-0000-0000-0000-0000000000f1', user_id: TECH_USER.id }],
      },
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-09-01T09:00:00Z', // new time → timeChanged=true
        scheduled_end: '2026-09-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    const rescheduledCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_rescheduled',
    );
    expect(rescheduledCall).toBeDefined();
    const rescheduledArgs = rescheduledCall![0];
    // addedIds is empty → recipients are the kept (current) crew.
    expect(rescheduledArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(rescheduledArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(rescheduledArgs.data).toHaveProperty('scheduled_start');
    expect(rescheduledArgs.actorId).toBe(TEST_USERS.admin.id);
  });

  it('does NOT emit dispatch.job_rescheduled when techs are added (assign, not reschedule)', async () => {
    // Adding a tech to a SCHEDULED job → job_assigned, but NOT job_rescheduled.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE); // already has TECH_USER
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === TECH2_ID) return Promise.resolve({ ...TECH2_USER, organization: TEST_ORG });
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
    });
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE, assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }], visits: [{ assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }] }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id, TECH2_ID],
        scheduled_start: '2026-06-01T09:00:00Z', // same time
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);
    const rescheduledCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_rescheduled',
    );
    expect(rescheduledCall).toBeUndefined();
  });
});

// ─── POST /api/jobs/:id/assignees → dispatch.job_assigned ───────────────────

describe('POST /api/jobs/:id/assignees (setAssignees) — notification hook', () => {
  it('emits dispatch.job_assigned when a crew member is added via the crew-only endpoint', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // no current assignees
    wireSetAssigneesTx({ ...JOB_FIXTURE, assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id] });

    expect(res.status).toBe(200);

    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_assigned',
    );
    expect(assignedCall).toBeDefined();
    const assignedArgs = assignedCall![0];
    expect(assignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(assignedArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(assignedArgs.object.label).toBe(JOB_FIXTURE.job_number);
  });

  it('emits dispatch.job_unassigned when a crew member is removed via the crew-only endpoint', async () => {
    mockAuthAs('admin');
    const fixture = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      customer: JOB_FIXTURE.customer,
      service_location: JOB_FIXTURE.service_location,
      scope_notes: null,
      scheduled_start: new Date('2026-06-01T09:00:00Z'),
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);
    wireSetAssigneesTx({ ...fixture, assignees: [], visits: [{ assignees: [] }] }, [{ user_id: TECH_USER.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [] }); // remove all

    expect(res.status).toBe(200);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_unassigned',
    );
    expect(unassignedCall).toBeDefined();
    const unassignedArgs = unassignedCall![0];
    expect(unassignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
  });
});

// ─── #1626 / spec #1751 D9: a restated window is not a move ──────────────────
//
// The product rule, ratified verbatim: "Adding a crew, no matter to which job or walkthrough,
// doesn't change the status. It doesn't move anything from completed to uncompleted or from
// scheduled to unscheduled."
//
// The status half lives in jobs.test.ts. THIS file owns the announcement half, because the mail
// and the in-app notice are what a technician actually experiences: a job that has not moved must
// not tell its crew it has. The genuine-move test above is the other side of the same coin - it
// stays green, so these prove the feature was narrowed rather than switched off.
describe('POST /api/jobs/:id/assign — a restated window announces nothing (#1626)', () => {
  const VISIT_ID = 'v0000000-0000-0000-0000-0000000000f1';

  /** A SCHEDULED, crewed job whose one live trip really carries the window under test. */
  function jobOnTrip(startIso: string, endIso: string) {
    return {
      ...JOB_FIXTURE,
      status: 'SCHEDULED' as const,
      customer_scheduled_email_sent_at: new Date('2026-05-01T00:00:00Z'),
      assignees: [{ user_id: TECH_USER.id }],
      visits: [{
        id: VISIT_ID, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date(startIso), scheduled_end: new Date(endIso),
        is_all_day: false, customer_email_sent_at: null,
        created_at: new Date('2026-05-01T00:00:00Z'),
        assignees: [{ user_id: TECH_USER.id }],
      }],
    };
  }

  function tripFixture(startIso: string, endIso: string) {
    return {
      liveVisits: [{
        id: VISIT_ID, job_id: JOB_FIXTURE.id, lead_id: null, visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date(startIso), scheduled_end: new Date(endIso),
        is_all_day: false, created_at: new Date('2026-05-01T00:00:00Z'),
        en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
      }],
      crew: [{ visit_id: VISIT_ID, user_id: TECH_USER.id }],
    };
  }

  const rescheduledEmits = () =>
    mockEmit.mock.calls.filter((c: any[]) => c[0].verb === 'dispatch.job_rescheduled');

  it('restating the job own window fires no crew notification and no RESCHEDULED timeline row', async () => {
    mockAuthAs('admin');
    const job = jobOnTrip('2026-06-01T09:00:00Z', '2026-06-01T11:00:00Z');
    mockPrisma.job.findUnique.mockResolvedValue(job);
    const tx = wireAssignTx(job, [{ user_id: TECH_USER.id }], tripFixture('2026-06-01T09:00:00Z', '2026-06-01T11:00:00Z'));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-06-01T09:00:00Z',
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);
    expect(rescheduledEmits()).toHaveLength(0);
    const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(eventTypes).not.toContain('RESCHEDULED');
    expect(eventTypes).not.toContain('SCHEDULED');
  });

  // The seconds trap. `isoToOrgTime` formats HH:mm, so a stored start of 09:00:37 seeds the
  // pickers as 09:00 and comes back as 09:00:00 - which, compared as a raw instant, is a 37-second
  // "move" that mailed the crew and wrote a RESCHEDULED row every single time.
  it('a minute-rounded restatement of a stored start carrying SECONDS announces nothing', async () => {
    mockAuthAs('admin');
    const job = jobOnTrip('2026-06-01T09:00:37Z', '2026-06-01T11:00:37Z');
    mockPrisma.job.findUnique.mockResolvedValue(job);
    const tx = wireAssignTx(job, [{ user_id: TECH_USER.id }], tripFixture('2026-06-01T09:00:37Z', '2026-06-01T11:00:37Z'));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-06-01T09:00:00Z',
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);
    expect(rescheduledEmits()).toHaveLength(0);
    const eventTypes = tx.txTimeline.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(eventTypes).not.toContain('RESCHEDULED');
  });

  // The body with no schedule keys at all. `timeChanged` used to be
  // `(current ?? null) !== (newStart ?? null)`, which reads a scheduled job plus a crew-only body
  // as `X !== null` = CHANGED - so removing one technician told everyone still on the job that it
  // had been rescheduled.
  it('a crew-only body on a scheduled job fires no crew reschedule notification', async () => {
    mockAuthAs('admin');
    const job = jobOnTrip('2026-06-01T09:00:00Z', '2026-06-01T11:00:00Z');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...job,
      assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }],
      visits: [{ ...job.visits[0]!, assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }] }],
    });
    mockPrisma.user.findMany.mockResolvedValue([
      { id: TECH2_ID, email: TECH2_USER.email, first_name: TECH2_USER.first_name, last_name: TECH2_USER.last_name },
    ]);
    wireAssignTx(job, [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }], {
      ...tripFixture('2026-06-01T09:00:00Z', '2026-06-01T11:00:00Z'),
      crew: [
        { visit_id: VISIT_ID, user_id: TECH_USER.id },
        { visit_id: VISIT_ID, user_id: TECH2_ID },
      ],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id] });

    expect(res.status).toBe(200);
    expect(rescheduledEmits()).toHaveLength(0);
    // ...but the person actually dropped is still told.
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'dispatch.job_unassigned')).toBe(true);
  });
});
