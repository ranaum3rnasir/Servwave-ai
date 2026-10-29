/**
 * S8 §2b (RATIFIED, section-9 item #6, PREVIOUSLY ORPHANED) - the crew-only visit PATCH.
 *
 * `rescheduleJobVisitSchema` declared `scheduled_start`/`scheduled_end` with no `.optional()`,
 * unlike `is_all_day`/`assignee_ids` on that same schema - so there was no way to change only a
 * visit's crew: a crew-only PATCH 400'd and the caller had to re-send the unchanged window. This
 * fix was approved and travelled only by chat message - it never reached a contract on disk, so
 * the lane that was told about it correctly declined it as out of written scope, and it fell
 * through once already before landing here as a written contract item (contract 11, Step 2b).
 *
 * Two interactions #1706 already shipped must not regress, and both get their own test below:
 *  - the crew gate keys on whether the crew SET CHANGES (Q3), not on this door's history;
 *  - detectCrewConflicts must still run against the EFFECTIVE window (current values where
 *    omitted) - "window omitted" must never mean "skip the conflict check".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// This route dispatches through the Automation Center on a real move - mocked at the module
// boundary the way job-visits.test.ts / automation-wiring.test.ts do, so assertions here are
// about THIS route's own behaviour, never about the engine underneath it.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));

const mockPrisma = prisma as unknown as Record<string, any>;

const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';
const TECH_A = TEST_USERS.technician.id;
const TECH_B = TEST_USERS.dispatcher.id;

/** The visit this whole file PATCHes: crewed by TECH_A, scheduled 1:00-3:30pm on 2026-09-05. */
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
    customer_email_sent_at: null,
    assignees: [{ user_id: TECH_A, user: { id: TECH_A, first_name: 'Tech', last_name: 'A' } }],
    ...over,
  };
}

/** The transaction rescheduleVisit() writes through. */
function wireTx() {
  const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => ({ ...visitRow(), ...args.data }));
  const txJobUpdate = vi.fn().mockResolvedValue(JOB_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: { findMany: mockPrisma.visit.findMany, update: txVisitUpdate },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
  return { txVisitUpdate, txJobUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.job.findUnique.mockResolvedValue({
    id: JOB_FIXTURE.id,
    status: 'SCHEDULED',
    job_number: JOB_FIXTURE.job_number,
    visits: [{ assignees: [{ user_id: TECH_A }] }],
    customer: null,
    service_location: null,
  });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  // Conflict detection's two parallel queries - "no conflict" by default, overridden per test.
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.visit.findFirst.mockResolvedValue(visitRow());
  mockPrisma.visit.findMany.mockResolvedValue([visitRow()]);
});

describe('PATCH /api/jobs/:id/visits/:visitId - crew-only PATCH (S8 §2b)', () => {
  it('succeeds and moves nothing but crew when only assignee_ids is sent', async () => {
    const tx = wireTx();

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_B] });

    expect(res.status).toBe(200);
    expect(tx.txVisitUpdate).toHaveBeenCalledTimes(1);
    // The write is a no-op on time - it restates the visit's CURRENT window rather than a
    // caller-supplied one, exactly the "omitted = unchanged" contract is_all_day/assignee_ids
    // already carry on this schema.
    const written = tx.txVisitUpdate.mock.calls[0][0].data;
    expect(written.scheduled_at.toISOString()).toBe('2026-09-05T13:00:00.000Z');
    expect(written.scheduled_end.toISOString()).toBe('2026-09-05T15:30:00.000Z');
    // is_all_day was never mentioned in the body either - still absent, not forced to false.
    expect(written).not.toHaveProperty('is_all_day');
  });

  it('succeeds and leaves crew alone when only a window is sent', async () => {
    const tx = wireTx();

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z' });

    expect(res.status).toBe(200);
    const written = tx.txVisitUpdate.mock.calls[0][0].data;
    expect(written.scheduled_at.toISOString()).toBe('2026-09-06T13:00:00.000Z');
    expect(written.scheduled_end.toISOString()).toBe('2026-09-06T15:30:00.000Z');
    // No crew write at all - replaceVisitCrew is only called when assignee_ids
    // is present in the body, which it is not here.
  });

  // The interaction that must not regress: "window omitted" must never mean "skip the
  // conflict check" - a crew-only PATCH that books a double-booked person at the visit's
  // EXISTING time still has to raise its 409.
  it('still 409s a crew-only PATCH whose incoming crew is double-booked at the visit\'s EXISTING window', async () => {
    const tx = wireTx();
    // TECH_B is crewed on another job's visit that overlaps THIS visit's current 1:00-3:30pm
    // window (2:00-4:00pm on the same day) - a real clash, discoverable only if the conflict
    // check runs against the visit's CURRENT time rather than skipping because none was sent.
    mockPrisma.job.findMany.mockResolvedValueOnce([{
      id: 'other-job',
      job_number: 'J00099',
      visits: [{
        id: 'other-visit',
        scheduled_at: new Date('2026-09-05T14:00:00Z'),
        scheduled_end: new Date('2026-09-05T16:00:00Z'),
      }],
    }]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_B] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    expect(tx.txVisitUpdate).not.toHaveBeenCalled();
  });

  // endAfterStart still applies when BOTH fields are supplied - only an omitted field
  // is exempt, never an inverted pair.
  it('rejects an inverted window when both fields are supplied, crew-only body or not', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-09-06T15:00:00Z', scheduled_end: '2026-09-06T13:00:00Z' });

    expect(res.status).toBe(400);
  });

  it('accepts a body with neither scheduled_start nor scheduled_end without 400ing on the schema', async () => {
    wireTx();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A, TECH_B] });

    expect(res.status).not.toBe(400);
  });

  // ─── #1626 / spec #1751 D9: the walkthrough-visit twin of the /assign guarantee ──────
  //
  // The product rule is stated for BOTH parents: "Adding a crew, no matter to which job or
  // walkthrough, doesn't change the status." /assign needed a fix to honour it (see
  // jobs.test.ts). THIS door was already safe, and this test is here to keep it that way rather
  // than to change anything: rescheduleVisitRow writes only window columns, and syncJobFromVisits
  // routes its status through deriveJobStatus, which returns `undefined` - "write nothing" - for a
  // human-set COMPLETED or CANCELLED. Job.completed_at has no writer on this path at all.
  it('a crew-only PATCH on a COMPLETED job writes no status and no milestone clear', async () => {
    const completedVisit = visitRow({ status: 'COMPLETED', completed_at: new Date('2026-09-05T15:20:00Z') });
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'COMPLETED',
      started_at: new Date('2026-09-05T13:05:00Z'),
      job_number: JOB_FIXTURE.job_number,
      visits: [{ assignees: [{ user_id: TECH_A }] }],
      customer: null,
      service_location: null,
    });
    mockPrisma.visit.findFirst.mockResolvedValue(completedVisit);
    mockPrisma.visit.findMany.mockResolvedValue([completedVisit]);
    const tx = wireTx();

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A, TECH_B] });

    expect(res.status).toBe(200);
    const written = tx.txJobUpdate.mock.calls[0][0].data;
    // deriveJobStatus refuses to touch a human-set COMPLETED, so the key is absent entirely -
    // writing the current value back would still clear a dispatcher's sub-status.
    expect(written).not.toHaveProperty('status');
    for (const column of ['completed_at', 'cancelled_at', 'cancelled_reason']) {
      expect(written).not.toHaveProperty(column);
    }
    // The visit's own history is untouched too - a crew statement is not a lifecycle move.
    const visitWritten = tx.txVisitUpdate.mock.calls[0][0].data;
    for (const column of ['status', 'completed_at', 'started_at', 'en_route_at', 'on_site_at']) {
      expect(visitWritten).not.toHaveProperty(column);
    }
  });

  // Q3 (#1706), unaffected by S8 §2b: restating the SAME crew never trips the `assign Job` gate,
  // even reschedule-only. Confirms the crew-only PATCH did not accidentally widen that check.
  it('restating the unchanged crew alongside an omitted window is a 200, not a 403', async () => {
    const tx = wireTx();
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_A] });

    expect(res.status).toBe(200);
    expect(tx.txVisitUpdate).toHaveBeenCalledTimes(1);
  });
});
