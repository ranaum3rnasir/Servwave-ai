/**
 * automation-wiring.test.ts — dispatchAutomationEvent() hooks in controllers.
 *
 * Verifies every automation event class fires post-commit with the right
 * type/entity/occurrenceKey — and does NOT fire on failure paths. Fixture
 * arrangements mirror the sibling notification-wiring suites
 * (job-assign-notifications / job-lifecycle-notifications /
 * invoice-notifications / estimates tests).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  JOB_FIXTURE,
  ESTIMATE_FIXTURE,
  ESTIMATE_SENT_FIXTURE,
  LEAD_FIXTURE,
  ALPHA_ORG_ID,
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

// Task 9: scheduleWalkthrough's reschedule branch calls rearmAnchoredWaits() directly
// (not through dispatchAutomationEvent) — mock it separately to assert the re-arm call.
// Safe to replace the whole module here: no controller in this file's app graph imports
// enrollment.ts directly except lead.controller.ts, and dispatch.ts (the OTHER real
// importer of enrollment.ts) is itself fully mocked above.
vi.mock('../services/automations/enrollment', () => ({
  rearmAnchoredWaits: vi.fn(),
}));
import { rearmAnchoredWaits } from '../services/automations/enrollment';
const mockRearm = rearmAnchoredWaits as ReturnType<typeof vi.fn>;

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as any;

const TECH_USER = TEST_USERS.technician;

function dispatched(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  // Walkthrough-as-entity redesign, PR-B2: default to "no active/scheduled visit" so tests
  // that don't exercise a specific visit state don't need to know findActiveWalkthrough/
  // findScheduledWalkthrough exist. Tests below override this per-scenario.
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.findMany.mockResolvedValue([]);
});

// ── job assign: TECH_ASSIGNED + JOB_SCHEDULED / JOB_RESCHEDULED ──────────────

/** S8 (D6): the trip a job-level crew statement lands on. */
const S8_FIXTURE_VISIT =
  {
    id: 'v0000000-0000-0000-0000-0000000000f1', job_id: JOB_FIXTURE.id, lead_id: null,
    visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: new Date('2026-06-01T09:00:00.000Z'),
    scheduled_end: new Date('2026-06-01T11:00:00.000Z'),
    is_all_day: false, created_at: new Date('2026-05-01T00:00:00.000Z'),
    en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
  };

function wireAssignTx(updatedJob: any, currentCrew: { user_id: string }[] = [], liveVisits: any[] = [S8_FIXTURE_VISIT]) {
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        // S8 (D6): the crew statement lands on the job's CURRENT trip, so it needs one.
        visit: {
          findMany: vi.fn().mockResolvedValue(liveVisits),
          create: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          update: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
      // S8 (D6): the crew delta the automation events read comes off THIS delegate now.
      visitAssignee: {
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
      job: { update: vi.fn().mockResolvedValue(updatedJob) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
}

describe('POST /api/jobs/:id/assign — automation events', () => {
  it('first schedule with a new tech → TECH_ASSIGNED (occurrence = tech id) + JOB_SCHEDULED, no re-arm', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, unscheduled
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

    const assigned = dispatched('TECH_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'job', id: JOB_FIXTURE.id, label: JOB_FIXTURE.job_number },
      occurrenceKey: TECH_USER.id,
    });

    const scheduled = dispatched('JOB_SCHEDULED');
    expect(scheduled).toHaveLength(1);
    expect(dispatched('JOB_RESCHEDULED')).toHaveLength(0);
    expect(mockRearm).not.toHaveBeenCalled();

    // The just-assigned tech's identity travels with TECH_ASSIGNED so
    // default-tech-assigned's `assigned_user` audience (not the live, growing
    // crew) can address them specifically — see recipients.ts.
    expect(assigned[0]).toMatchObject({
      eventPayload: {
        recipient: {
          id: TECH_USER.id,
          email: TECH_USER.email,
          first_name: TECH_USER.first_name,
          last_name: TECH_USER.last_name,
        },
      },
    });
  });

  // Scheduling-notifications PRD ("Job is scheduled fires on the date"): a shop that sets the
  // date on Monday and crews the job on Thursday must still tell the customer on Monday. The
  // crew is not a condition; a state-4 (no crew) first booking announces itself.
  it('first schedule with NO crew (state-4) → JOB_SCHEDULED IS dispatched, and nothing else', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, unscheduled
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-08-01T09:00:00Z',
        scheduled_end: '2026-08-01T11:00:00Z',
      });
    expect(res.status).toBe(200);

    expect(dispatched('JOB_SCHEDULED')).toHaveLength(1);
    expect(dispatched('JOB_RESCHEDULED')).toHaveLength(0);
    expect(dispatched('TECH_ASSIGNED')).toHaveLength(0);
  });

  // The PRD's user story 2, end to end on this door: date on Monday with nobody assigned, crew on
  // Thursday. Monday announces the job (the flipped state-4 case above); Thursday is a crew-only
  // write on an already-announced job, so it is the crew's event and never a second "scheduled".
  it('crewing an already-announced job on a later day → TECH_ASSIGNED only, no second JOB_SCHEDULED', async () => {
    mockAuthAs('admin');
    const thursday = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED' as const,
      visits: [{
        status: 'SCHEDULED', scheduled_at: new Date('2026-06-01T09:00:00Z'), scheduled_end: new Date('2026-06-01T11:00:00Z'),
        is_all_day: false, created_at: new Date('2026-05-01T00:00:00Z'),
        assignees: [],
      }],
      customer_scheduled_email_sent_at: new Date('2026-05-25T09:00:00Z'), // Monday's announcement
    };
    mockPrisma.job.findUnique.mockResolvedValue(thursday);
    wireAssignTx(thursday, []);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id] });
    expect(res.status).toBe(200);

    expect(dispatched('TECH_ASSIGNED')).toHaveLength(1);
    expect(dispatched('JOB_SCHEDULED')).toHaveLength(0);
    expect(dispatched('JOB_RESCHEDULED')).toHaveLength(0);
  });

  // The customer "scheduled" email gates on stampScheduledFlag, NOT on
  // isFirstScheduleWithCrew alone — i.e. it also requires the send-guard flag to
  // still be unset (job.controller.ts, Spec B1). A job that was backward-cleared
  // to UNSCHEDULED and re-forward-assigned satisfies isFirstScheduleWithCrew but
  // already carries the flag, and the hard-coded sender deliberately stayed
  // silent so the customer is not told "scheduled" twice. The dispatch has to
  // honour that same guard or the migrated automation re-emails them.
  it('re-assigning a job that already carries the scheduled-email flag → JOB_SCHEDULED is NOT dispatched', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, // UNSCHEDULED + unscheduled → isFirstScheduleWithCrew is true
      customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'), // …but already emailed
    });
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

    expect(dispatched('JOB_SCHEDULED')).toHaveLength(0);
    // The crew member still gets their own assignment event — only the
    // customer-facing "scheduled" announcement is suppressed.
    expect(dispatched('TECH_ASSIGNED')).toHaveLength(1);
  });

  it('moving an already-scheduled job → JOB_RESCHEDULED with the NEW start as occurrence + rearmAnchoredWaits', async () => {
    mockAuthAs('admin');
    // S8 (RATIFIED, A5): isReschedule now reads resolveJobScheduleWindow(existing.visits) -
    // the flat scheduled_start/scheduled_end fixture fields below no longer feed it at all, so
    // the visit entry must carry a real, matching, live window for `isReschedule` to resolve true.
    const fixture = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED' as const,
      assignees: [{ user_id: TECH_USER.id }],
      visits: [{
        status: 'SCHEDULED', scheduled_at: new Date('2026-06-01T09:00:00Z'), scheduled_end: new Date('2026-06-01T11:00:00Z'),
        is_all_day: false, created_at: new Date('2026-05-01T00:00:00Z'),
        assignees: [{ user_id: TECH_USER.id }],
      }],
      customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'),
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);
    wireAssignTx(fixture, [{ user_id: TECH_USER.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id], // unchanged crew
        scheduled_start: '2026-08-02T13:00:00Z',
        scheduled_end: '2026-08-02T15:00:00Z',
      });
    expect(res.status).toBe(200);

    const rescheduled = dispatched('JOB_RESCHEDULED');
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0].occurrenceKey).toBe(new Date('2026-08-02T13:00:00Z').toISOString());
    expect(dispatched('JOB_SCHEDULED')).toHaveLength(0);
    expect(dispatched('TECH_ASSIGNED')).toHaveLength(0);

    expect(mockRearm).toHaveBeenCalledTimes(1);
    expect(mockRearm).toHaveBeenCalledWith('job', JOB_FIXTURE.id);
  });

  // Narrowed to match the reschedule email gate exactly: a job whose customer
  // never got the original "scheduled" email (flag null — e.g. it was
  // originally scheduled with no crew, state-4) sends no "rescheduled" email
  // either, so JOB_RESCHEDULED must not dispatch.
  it('rescheduling a job whose customer never got the scheduled email (flag null) → JOB_RESCHEDULED is NOT dispatched', async () => {
    mockAuthAs('admin');
    const fixture = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED' as const,
      scheduled_start: new Date('2026-06-01T09:00:00Z'),
      scheduled_end: new Date('2026-06-01T11:00:00Z'),
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      customer_scheduled_email_sent_at: null,
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);
    wireAssignTx(fixture, [{ user_id: TECH_USER.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-08-02T13:00:00Z',
        scheduled_end: '2026-08-02T15:00:00Z',
      });
    expect(res.status).toBe(200);

    expect(dispatched('JOB_RESCHEDULED')).toHaveLength(0);
  });

  it('does NOT dispatch when the job is not found (404 path)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id] });
    expect(res.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  // The removed tech's identity (id/email/name) has to travel WITH the event —
  // by the time this fires they're already off the crew, so nothing downstream
  // can re-derive who they were from the job row.
  it('removing a tech (same schedule) → TECH_UNASSIGNED carries the removed user as eventPayload.recipient', async () => {
    mockAuthAs('admin');
    const fixture = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED' as const,
      scheduled_start: new Date('2026-06-01T09:00:00Z'),
      scheduled_end: new Date('2026-06-01T11:00:00Z'),
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'),
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TECH_USER.id, email: TECH_USER.email, first_name: TECH_USER.first_name, last_name: TECH_USER.last_name },
    ]);
    wireAssignTx(fixture, [{ user_id: TECH_USER.id }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [], // remove the only tech
        scheduled_start: '2026-06-01T09:00:00Z', // unchanged — isolate from JOB_RESCHEDULED
        scheduled_end: '2026-06-01T11:00:00Z',
      });
    expect(res.status).toBe(200);

    const unassigned = dispatched('TECH_UNASSIGNED');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'job', id: JOB_FIXTURE.id, label: JOB_FIXTURE.job_number },
      occurrenceKey: TECH_USER.id,
      eventPayload: {
        recipient: {
          id: TECH_USER.id,
          email: TECH_USER.email,
          first_name: TECH_USER.first_name,
          last_name: TECH_USER.last_name,
        },
      },
    });
  });

  it('does NOT dispatch TECH_UNASSIGNED when no one is removed', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNSCHEDULED, no crew
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id], scheduled_start: '2026-08-01T09:00:00Z', scheduled_end: '2026-08-01T11:00:00Z' });
    expect(res.status).toBe(200);
    expect(dispatched('TECH_UNASSIGNED')).toHaveLength(0);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/assignees — automation events', () => {
  it('adding + removing in the same call → TECH_ASSIGNED for the added id, TECH_UNASSIGNED (with recipient) for the removed one', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
    });
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TECH_USER.id, email: TECH_USER.email, first_name: TECH_USER.first_name, last_name: TECH_USER.last_name },
    ]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // S8 (D6): the crew statement lands on the job's CURRENT trip, so it needs one.
        visit: {
          findMany: vi.fn().mockResolvedValue([S8_FIXTURE_VISIT]),
          create: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          update: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        // S8 (D6): the crew delta the automation events read comes off THIS delegate now.
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([{ user_id: TECH_USER.id }]),
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([{ user_id: TECH_USER.id }]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        job: { findUnique: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [SALES_USER.id] }); // TECH_USER removed, SALES_USER added
    expect(res.status).toBe(200);

    const assigned = dispatched('TECH_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      occurrenceKey: SALES_USER.id,
      eventPayload: { recipient: { id: SALES_USER.id } },
    });
    const unassigned = dispatched('TECH_UNASSIGNED');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]).toMatchObject({
      occurrenceKey: TECH_USER.id,
      eventPayload: { recipient: { id: TECH_USER.id, email: TECH_USER.email } },
    });
  });

  // #361's notify.email:false is a per-request "don't email on THIS
  // assignment" toggle — preserved through the migration by suppressing the
  // TECH_ASSIGNED dispatch itself, not just the (now-deleted) hard-coded
  // sender. Removal notices are unaffected (matches today's behavior).
  it('notify.email:false suppresses the TECH_ASSIGNED dispatch for added crew (removal dispatch unaffected)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
    });
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: TECH_USER.id, email: TECH_USER.email, first_name: TECH_USER.first_name, last_name: TECH_USER.last_name },
    ]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // S8 (D6): the crew statement lands on the job's CURRENT trip, so it needs one.
        visit: {
          findMany: vi.fn().mockResolvedValue([S8_FIXTURE_VISIT]),
          create: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          update: vi.fn().mockResolvedValue(S8_FIXTURE_VISIT),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
        },
        // S8 (D6): the crew delta the automation events read comes off THIS delegate now.
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([{ user_id: TECH_USER.id }]),
          // S3: /assign now restates the named crew on the visit it booked or moved, so this
          // tx client needs the WRITE delegates too, not just the union read.
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        jobAssignee: {
          findMany: vi.fn().mockResolvedValue([{ user_id: TECH_USER.id }]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        job: { findUnique: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [SALES_USER.id], notify: { email: false } });
    expect(res.status).toBe(200);

    expect(dispatched('TECH_ASSIGNED')).toHaveLength(0);
    expect(dispatched('TECH_UNASSIGNED')).toHaveLength(1);
  });
});

// ── job complete / cancel ─────────────────────────────────────────────────────

describe('job lifecycle — automation events', () => {
  it('POST /:id/complete → JOB_COMPLETED', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      job_number: JOB_FIXTURE.job_number,
      source_plan_id: null,
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'COMPLETED', completed_at: new Date() });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });
    expect(res.status).toBe(200);

    const events = dispatched('JOB_COMPLETED');
    expect(events).toHaveLength(1);
    expect(events[0].entity).toMatchObject({ type: 'job', id: JOB_FIXTURE.id });
  });

  it('POST /:id/en-route → JOB_EN_ROUTE (occurrence = en_route_at ISO)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      // S8 (D6): the en-route handler reads the crew through the job's trips.
      visits: [{ assignees: [{ user_id: TECH_USER.id, user: { first_name: TECH_USER.first_name } }] }],
      job_number: JOB_FIXTURE.job_number,
      scheduled_start: new Date('2026-08-01T09:00:00Z'),
      customer: { id: CUSTOMER_FIXTURE.id, email: CUSTOMER_FIXTURE.email, first_name: 'Sarah', company_name: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    });
    mockPrisma.job.update.mockImplementation((args: { data: { en_route_at: Date } }) =>
      Promise.resolve({ ...JOB_FIXTURE, status: 'EN_ROUTE', en_route_at: args.data.en_route_at }),
    );

    const before = Date.now();
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);

    // en_route_at is stamped with `new Date()` inside the handler — assert it's
    // a genuine, current ISO timestamp rather than a value this test invented.
    const events = dispatched('JOB_EN_ROUTE');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'job', id: JOB_FIXTURE.id, label: JOB_FIXTURE.job_number },
    });
    const occurrenceTime = new Date(events[0].occurrenceKey).getTime();
    expect(occurrenceTime).toBeGreaterThanOrEqual(before);
    expect(occurrenceTime).toBeLessThanOrEqual(Date.now());
  });

  // The retired sender required a named technician to send at all
  // (`if (existing.customer?.email && enRouteTechFirstName)`), so a crewless
  // en-route emailed nobody. The default automation addresses the CUSTOMER, who
  // does have an address — without this gate it would send "we're on the way …
  // Who's coming: ." naming no one. Keep the sender's gate.
  it('does NOT dispatch JOB_EN_ROUTE when the job has no crew (nobody to name)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
      job_number: JOB_FIXTURE.job_number,
      scheduled_start: new Date('2026-08-01T09:00:00Z'),
      customer: { id: CUSTOMER_FIXTURE.id, email: CUSTOMER_FIXTURE.email, first_name: 'Sarah', company_name: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    });
    mockPrisma.job.update.mockImplementation((args: { data: { en_route_at: Date } }) =>
      Promise.resolve({ ...JOB_FIXTURE, status: 'EN_ROUTE', en_route_at: args.data.en_route_at }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200); // the transition itself still succeeds
    expect(dispatched('JOB_EN_ROUTE')).toHaveLength(0);
  });

  // This used to assert a 400 + no dispatch for a non-SCHEDULED job. That guard is
  // gone: staging deliberately removed the status-ordering gates so any transition
  // is reachable ("remove ordering guards so any status transition is reachable"),
  // and the hard-coded en-route sender it replaced is likewise unconditional on
  // staging today. Parity therefore means dispatching here, not suppressing —
  // suppressing would make the migrated automation QUIETER than the built-in.
  it('dispatches JOB_EN_ROUTE even from a non-SCHEDULED status (ordering guards were removed)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'UNSCHEDULED',
      // Crewed, so this isolates the STATUS dimension — the crew gate is covered
      // by its own test above.
      // S8 (D6): the en-route handler reads the crew through the job's trips.
      visits: [{ assignees: [{ user_id: TECH_USER.id, user: { first_name: TECH_USER.first_name } }] }],
      job_number: JOB_FIXTURE.job_number,
      scheduled_start: null,
      customer: { id: CUSTOMER_FIXTURE.id, email: CUSTOMER_FIXTURE.email, first_name: 'Sarah', company_name: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    });
    mockPrisma.job.update.mockImplementation((args: { data: { en_route_at: Date } }) =>
      Promise.resolve({ ...JOB_FIXTURE, status: 'EN_ROUTE', en_route_at: args.data.en_route_at }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);
    expect(dispatched('JOB_EN_ROUTE')).toHaveLength(1);
  });

  it('POST /:id/cancel → JOB_CANCELLED', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      invoices: [],
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'CANCELLED', assignees: [] }) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { findMany: vi.fn().mockResolvedValue([]) },
        // Inventory P1 (§4.2): cancel's auto-return pass — nothing SYNCED in this flow.
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { aggregate: mockPrisma.visit.aggregate, updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer asked' });
    expect(res.status).toBe(200);
    const events = dispatched('JOB_CANCELLED');
    expect(events).toHaveLength(1);
    // The cancellation reason is request-time text the live job row never
    // stores in a customer-facing way — carried as event.reason so a migrated
    // "job cancelled" automation can still tell the customer why.
    expect(events[0].eventPayload).toEqual({ mergeFields: { 'event.reason': 'Customer asked' } });
  });
});

// ── estimate send / approve ───────────────────────────────────────────────────

describe('estimate lifecycle — automation events', () => {
  const DRAFT = {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: 1062.5,
    public_token: null,
    valid_until: null,
    customer_id: null,
    // SERV10X-61 §5.6 - send()/mark-sent now refuse a zero-line-item estimate; a sendable fixture needs _count.
    _count: { line_items: 2 },
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'estimate-lifecycle@example.com' } },
    deposit: null,
    send_config: null,
  };
  const SENT = { ...ESTIMATE_FIXTURE, status: 'SENT', sent_at: new Date(), public_token: 'tok', valid_until: new Date(), send_config: null, deposit: null };

  function wireSendTx(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result), findUnique: vi.fn().mockResolvedValue(result) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { aggregate: mockPrisma.visit.aggregate, updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  }

  it('first send → ESTIMATE_SENT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(DRAFT);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    wireSendTx(SENT);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: ['CHECK'] });
    expect(res.status).toBe(200);

    const events = dispatched('ESTIMATE_SENT');
    expect(events).toHaveLength(1);
    expect(events[0].entity).toMatchObject({ type: 'estimate', id: ESTIMATE_FIXTURE.id });
  });

  it('re-send of an already-sent estimate → ESTIMATE_SENT NOT dispatched again', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...DRAFT, status: 'SENT', sent_at: new Date(), public_token: 'tok' });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    wireSendTx(SENT);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: ['CHECK'] });
    expect(res.status).toBe(200);
    expect(dispatched('ESTIMATE_SENT')).toHaveLength(0);
  });

  // R4 (2026-07-21) — mark-sent shares commitFirstSend with send()'s first-send branch and is
  // unconditionally a first send (DRAFT-only), so it must fire the same event — otherwise an
  // Automation Center rule keyed on ESTIMATE_SENT silently never triggers for an estimate
  // delivered outside the app.
  it('mark-sent (delivered outside the app) → ESTIMATE_SENT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(DRAFT);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    wireSendTx(SENT);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });
    expect(res.status).toBe(200);

    const events = dispatched('ESTIMATE_SENT');
    expect(events).toHaveLength(1);
    expect(events[0].entity).toMatchObject({ type: 'estimate', id: ESTIMATE_FIXTURE.id });
  });

  it('record-payment fully covering the deposit → ESTIMATE_APPROVED + INVOICE_PAID (door parity)', async () => {
    mockAuthAs('admin');
    const EST_ID = ESTIMATE_FIXTURE.id;
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: EST_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 500,
      public_token: 'tok',
      valid_until: null,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa' }, commission_owner_id: TEST_USERS.sales.id },
      send_config: null,
    });
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: EST_ID });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500, invoice_number: 'I00050' }),
          update: vi.fn().mockResolvedValue({}),
        },
        payment: { create: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue({ id: EST_ID, estimate_number: ESTIMATE_FIXTURE.estimate_number, status: 'WON', lead_id: ESTIMATE_FIXTURE.lead_id, lead: { commission_owner_id: TEST_USERS.sales.id } }) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${EST_ID}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, deposit_percentage: 50, payment_method: 'CHECK' });
    expect(res.status).toBe(200);

    expect(dispatched('ESTIMATE_APPROVED')).toHaveLength(1);
    const paid = dispatched('INVOICE_PAID');
    expect(paid).toHaveLength(1);
    expect(paid[0].entity).toMatchObject({ type: 'invoice', id: 'dep-inv-1', label: 'I00050' });
  });

  it('public approval (no deposit) → ESTIMATE_APPROVED', async () => {
    const SENT_NO_DEPOSIT = {
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      organization_id: ALPHA_ORG_ID,
      total_amount: 1062.5,
      valid_until: new Date('2027-12-31'),
      snapshot_terms: null,
      signature_data: null,
      invoices: [],
      send_config: { deposit_required: false, payment_methods: [] },
      organization: { id: ALPHA_ORG_ID, stripe_account_id: null, accepted_payment_methods: ['CHECK'] },
      lead: { commission_owner_id: TEST_USERS.sales.id },
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(SENT_NO_DEPOSIT);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...SENT_NO_DEPOSIT, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue(null); // fire-and-forget email path

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,xyz' });
    expect([200, 201]).toContain(res.status);

    const events = dispatched('ESTIMATE_APPROVED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'estimate', id: ESTIMATE_SENT_FIXTURE.id },
      actorId: null,
    });
  });
});

// ── invoice send / paid ───────────────────────────────────────────────────────

describe('invoice lifecycle — automation events', () => {
  const INVOICE_ID = 'f0000000-0000-0000-0000-00000000000f';

  function buildInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00073',
      status: 'SENT',
      kind: 'STANDARD',
      total_amount: 1268,
      amount_due: 1268,
      organization_id: ALPHA_ORG_ID,
      customer_id: CUSTOMER_FIXTURE.id,
      estimate: null,
      customer: { ...CUSTOMER_FIXTURE },
      job: {
        id: JOB_FIXTURE.id,
        job_number: JOB_FIXTURE.job_number,
        customer: { ...CUSTOMER_FIXTURE },
        estimate: { lead: { commission_owner_id: TEST_USERS.sales.id } },
      },
      ...overrides,
    };
  }

  it('recordPayment paying in FULL → INVOICE_PAID', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: 'I00073' }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_new', amount: 1268, method: 'CHECK', paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });
    expect(res.status).toBe(201);

    const events = dispatched('INVOICE_PAID');
    expect(events).toHaveLength(1);
    expect(events[0].entity).toMatchObject({ type: 'invoice', id: INVOICE_ID, label: 'I00073' });
  });

  it('recordPayment fully paying a DEPOSIT invoice → INVOICE_PAID + ESTIMATE_APPROVED (parity with Stripe door)', async () => {
    mockAuthAs('admin');
    const EST_ID = 'e0000000-0000-0000-0000-0000000000de';
    mockPrisma.invoice.findUnique.mockResolvedValue(
      buildInvoice({
        kind: 'DEPOSIT',
        estimate: { id: EST_ID, estimate_number: 'E00200', lead_id: 'l1', lead: { commission_owner_id: TEST_USERS.sales.id } },
      }),
    );
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: 'I00073' }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_new', amount: 1268, method: 'CHECK', paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });
    expect(res.status).toBe(201);

    expect(dispatched('INVOICE_PAID')).toHaveLength(1);
    const approved = dispatched('ESTIMATE_APPROVED');
    expect(approved).toHaveLength(1);
    expect(approved[0].entity).toMatchObject({ type: 'estimate', id: EST_ID, label: 'E00200' });
  });

  it('recordPayment PARTIAL → INVOICE_PAID NOT dispatched', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: 'I00073' }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_new', amount: 100, method: 'CHECK', paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 100, method: 'CHECK' });
    expect(res.status).toBe(201);
    expect(dispatched('INVOICE_PAID')).toHaveLength(0);
  });
});

// ── lead created ──────────────────────────────────────────────────────────────

describe('lead creation — automation events', () => {
  it('POST /api/leads with an existing customer → LEAD_CREATED (the emit-gap path)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);

    const createdLead = {
      id: 'e0000000-0000-0000-0000-00000000009e',
      lead_number: 'L00099',
      customer_id: CUSTOMER_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      status: 'NEW',
      service_request: 'Water heater',
      commission_owner_id: null,
      customer: CUSTOMER_FIXTURE,
      service_location: LOCATION_FIXTURE,
      lead_assignees: [],
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { update: vi.fn().mockResolvedValue({}) },
        lead: { create: vi.fn().mockResolvedValue(createdLead) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id }) },
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
      }),
    );
    mockPrisma.lead.findUnique.mockResolvedValue(createdLead);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    mockPrisma.tag.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'Water heater' });

    expect(res.status).toBe(201);
    const events = dispatched('LEAD_CREATED');
    expect(events).toHaveLength(1);
    expect(events[0].entity.type).toBe('lead');
    expect(events[0].entity.label).toBe('L00099');
  });

  it('POST /api/leads with an existing customer AND assigned_to → LEAD_CREATED + LEAD_ASSIGNED (occ = owner id)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);

    const createdLead = {
      id: 'e0000000-0000-0000-0000-00000000009f',
      lead_number: 'L00100',
      customer_id: CUSTOMER_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      status: 'NEW',
      service_request: 'Water heater',
      commission_owner_id: TEST_USERS.sales.id,
      commission_owner: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales', email: 'sales@test.com' },
      customer: CUSTOMER_FIXTURE,
      service_location: LOCATION_FIXTURE,
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { update: vi.fn().mockResolvedValue({}) },
        lead: { create: vi.fn().mockResolvedValue(createdLead) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id }) },
        visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
      }),
    );
    mockPrisma.lead.findUnique.mockResolvedValue(createdLead);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    mockPrisma.tag.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_request: 'Water heater',
        assigned_to: TEST_USERS.sales.id,
      });

    expect(res.status).toBe(201);
    expect(dispatched('LEAD_CREATED')).toHaveLength(1);
    const assigned = dispatched('LEAD_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: createdLead.id, label: createdLead.lead_number },
      occurrenceKey: TEST_USERS.sales.id,
    });
  });
});

// ── walkthrough scheduled / rescheduled / performer-assigned (Task 9) ──────────

const SALES_USER = TEST_USERS.sales;

/** Wire the $transaction mock used by scheduleWalkthrough(). */
function wireScheduleWalkthroughTx(updated: any) {
  // detectPerformerConflicts runs whenever any performer is added/kept-with-time-change.
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      visit: { aggregate: mockPrisma.visit.aggregate,
        create: vi.fn().mockResolvedValue({ id: 'wt-new-1' }),
        update: vi.fn().mockResolvedValue({ id: 'wt-active-1' }),
      },
      lead: { update: vi.fn().mockResolvedValue(updated), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

/** Wire the $transaction mock used by setPerformers(). */
function wireSetPerformersTx(updated: any) {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([{ user_id: TECH_USER.id }]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      lead: { findUnique: vi.fn().mockResolvedValue(updated) },
    }),
  );
}

describe('POST /api/leads/:id/walkthrough/schedule — automation events', () => {
  const SCHEDULE_BODY = {
    walkthrough_scheduled_at: '2026-08-01T09:00:00Z',
    performer_ids: [TECH_USER.id],
    walkthrough_duration_minutes: 60,
    send_email: true, // send_email now also gates the dispatch (see the send_email:false test below)
  };

  it('first schedule (CONTACTED) → WALKTHROUGH_SCHEDULED (occ = time) + one WALKTHROUGH_PERFORMER_ASSIGNED (with recipient) per added performer, no re-arm', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      visit_assignees: [],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(SCHEDULE_BODY);
    expect(res.status).toBe(200);

    const scheduled = dispatched('WALKTHROUGH_SCHEDULED');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      occurrenceKey: new Date(SCHEDULE_BODY.walkthrough_scheduled_at).toISOString(),
    });
    expect(dispatched('WALKTHROUGH_RESCHEDULED')).toHaveLength(0);

    // The just-assigned performer's identity travels with the event so
    // default-walkthrough-performer-assigned's `assigned_user` audience (not the
    // live, growing performer set) can address them specifically.
    const assigned = dispatched('WALKTHROUGH_PERFORMER_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      occurrenceKey: TECH_USER.id,
      eventPayload: {
        recipient: {
          id: TECH_USER.id,
          email: TECH_USER.email,
          first_name: TECH_USER.first_name,
          last_name: TECH_USER.last_name,
        },
      },
    });

    expect(mockRearm).not.toHaveBeenCalled();
  });

  // Narrowed to match hasPerformers (lead.controller.ts) exactly — a state-4 (no
  // performers) schedule sent no customer email today, so it must not dispatch either.
  it('first schedule with NO performers (state-4) → WALKTHROUGH_SCHEDULED is NOT dispatched', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      visit_assignees: [],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ ...SCHEDULE_BODY, performer_ids: [] });
    expect(res.status).toBe(200);

    expect(dispatched('WALKTHROUGH_SCHEDULED')).toHaveLength(0);
  });

  // send_email:false used to suppress the WHOLE fire-and-forget email block (customer
  // scheduled email AND both performer diff emails, added AND removed) — the dispatch
  // must be suppressed the same way, or the migration starts sending where the org
  // explicitly opted out.
  it('send_email:false suppresses WALKTHROUGH_SCHEDULED and WALKTHROUGH_PERFORMER_ASSIGNED dispatch entirely', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      visit_assignees: [],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ ...SCHEDULE_BODY, send_email: false });
    expect(res.status).toBe(200);

    expect(dispatched('WALKTHROUGH_SCHEDULED')).toHaveLength(0);
    expect(dispatched('WALKTHROUGH_PERFORMER_ASSIGNED')).toHaveLength(0);
  });

  it('send_email:false ALSO suppresses WALKTHROUGH_PERFORMER_REMOVED for a performer dropped in the same reschedule', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-07-01T09:00:00Z'),
      customer_email_sent_at: null,
      assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }] }],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({
        walkthrough_scheduled_at: '2026-08-02T13:00:00Z',
        performer_ids: [TECH_USER.id],
        walkthrough_duration_minutes: 60,
        send_email: false,
      });
    expect(res.status).toBe(200);

    expect(dispatched('WALKTHROUGH_PERFORMER_REMOVED')).toHaveLength(0);
  });

  it('reschedule (WALKTHROUGH_SCHEDULED, same performer, new time) → WALKTHROUGH_RESCHEDULED (occ = new time) + rearmAnchoredWaits, no re-assign dispatch', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-07-01T09:00:00Z'),
      customer_email_sent_at: null,
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ ...SCHEDULE_BODY, walkthrough_scheduled_at: '2026-08-02T13:00:00Z' });
    expect(res.status).toBe(200);

    const rescheduled = dispatched('WALKTHROUGH_RESCHEDULED');
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0].occurrenceKey).toBe(new Date('2026-08-02T13:00:00Z').toISOString());
    expect(dispatched('WALKTHROUGH_SCHEDULED')).toHaveLength(0);
    expect(dispatched('WALKTHROUGH_PERFORMER_ASSIGNED')).toHaveLength(0); // performer unchanged — nothing ADDED

    expect(mockRearm).toHaveBeenCalledTimes(1);
    expect(mockRearm).toHaveBeenCalledWith('lead', LEAD_FIXTURE.id);
  });

  it('does NOT dispatch or re-arm when the lead is not found (404 path)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(SCHEDULE_BODY);
    expect(res.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRearm).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/walkthrough/performers — automation events', () => {
  it('adding a new performer to an existing set → ONE WALKTHROUGH_PERFORMER_ASSIGNED for the added id only', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date(),
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
    });
    wireSetPerformersTx({
      ...LEAD_FIXTURE,
      visit_assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }],
    });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TECH_USER.id, SALES_USER.id] });
    expect(res.status).toBe(200);

    const assigned = dispatched('WALKTHROUGH_PERFORMER_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      occurrenceKey: SALES_USER.id,
      eventPayload: { recipient: { id: SALES_USER.id } },
    });
    // Kept performer must NOT be re-dispatched.
    expect(assigned.some((e: any) => e.occurrenceKey === TECH_USER.id)).toBe(false);
  });

  it('does NOT dispatch WALKTHROUGH_PERFORMER_ASSIGNED when no performer is newly added (pure removal), but DOES dispatch WALKTHROUGH_PERFORMER_REMOVED with the removed user as eventPayload.recipient', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date(),
      assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }] }],
    });
    wireSetPerformersTx({
      ...LEAD_FIXTURE,
      visit_assignees: [{ user_id: TECH_USER.id }],
    });
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: SALES_USER.id, email: SALES_USER.email, first_name: SALES_USER.first_name, last_name: SALES_USER.last_name },
    ]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [TECH_USER.id] });
    expect(res.status).toBe(200);

    expect(dispatched('WALKTHROUGH_PERFORMER_ASSIGNED')).toHaveLength(0);
    const removed = dispatched('WALKTHROUGH_PERFORMER_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      occurrenceKey: SALES_USER.id,
      eventPayload: { recipient: { id: SALES_USER.id, email: SALES_USER.email } },
    });
  });
});

describe('POST /api/leads/:id/walkthrough/schedule — WALKTHROUGH_PERFORMER_REMOVED', () => {
  it('a reschedule that drops a performer dispatches WALKTHROUGH_PERFORMER_REMOVED for them', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1', status: 'SCHEDULED', scheduled_at: new Date('2026-07-01T09:00:00Z'),
      customer_email_sent_at: null,
      assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }, { user_id: SALES_USER.id }] }],
    });
    wireScheduleWalkthroughTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: SALES_USER.id, email: SALES_USER.email, first_name: SALES_USER.first_name, last_name: SALES_USER.last_name },
    ]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({
        walkthrough_scheduled_at: '2026-08-02T13:00:00Z',
        performer_ids: [TECH_USER.id],
        walkthrough_duration_minutes: 60,
        send_email: true,
      });
    expect(res.status).toBe(200);

    const removed = dispatched('WALKTHROUGH_PERFORMER_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      occurrenceKey: SALES_USER.id,
      eventPayload: { recipient: { id: SALES_USER.id } },
    });
  });
});

// ── lead assign / walkthrough completed / walkthrough cancelled (Task 10) ──────

/** Wire the $transaction mock used by lead.assign(). */
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

describe('POST /api/leads/:id/assign — automation events', () => {
  it('assigning an owner → LEAD_ASSIGNED (occurrence = the assigned user id)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, commission_owner_id: null });
    wireLeadAssignTx({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.dispatcher.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: TEST_USERS.dispatcher.id });
    expect(res.status).toBe(200);

    const events = dispatched('LEAD_ASSIGNED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      occurrenceKey: TEST_USERS.dispatcher.id,
    });
  });

  it('clearing the owner (assigned_to: null) → NO LEAD_ASSIGNED', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, commission_owner_id: TEST_USERS.sales.id });
    wireLeadAssignTx({ ...LEAD_FIXTURE, commission_owner_id: null });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: null });
    expect(res.status).toBe(200);

    expect(dispatched('LEAD_ASSIGNED')).toHaveLength(0);
  });
});

describe('POST /api/leads/:id/walkthrough/complete — automation events', () => {
  it('completes a scheduled walkthrough → WALKTHROUGH_COMPLETED (no occurrenceKey)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.visit.update.mockResolvedValue({});
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    // Spec #1751 D3: the monotonic completion clock is a CONDITIONAL write of its own
    // (stampLeadClock -> lead.updateMany), whose `count` the writer reads. An unresolved mock
    // returns undefined and destructuring it 500s the door.
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);

    const events = dispatched('WALKTHROUGH_COMPLETED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
    });
    expect(events[0].occurrenceKey).toBeUndefined();
  });
});

describe('POST /api/leads/:id/walkthrough/cancel — automation events', () => {
  it('cancels a scheduled walkthrough → WALKTHROUGH_CANCELLED (no occurrenceKey)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.visit.findFirst.mockResolvedValue({ id: 'wt-scheduled-1', status: 'SCHEDULED' });
    mockPrisma.visit.update.mockResolvedValue({});
    mockPrisma.visit.create.mockResolvedValue({ id: 'wt-rebooked-1' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduled' });
    expect(res.status).toBe(200);

    const events = dispatched('WALKTHROUGH_CANCELLED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      eventPayload: { mergeFields: { 'event.reason': 'Customer rescheduled' } },
    });
    expect(events[0].occurrenceKey).toBeUndefined();
  });
});
