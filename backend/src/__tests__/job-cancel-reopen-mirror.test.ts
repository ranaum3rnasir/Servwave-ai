/**
 * Section 4.2 of the multi-visit QA run: job-level cancel and reopen write the job row by
 * hand and never re-sync D14's schedule mirror, so Job.scheduled_start keeps pointing at
 * the trip the same request just called off.
 *
 * Proved on staging: POST /api/jobs/c83d4f42-.../cancel left scheduled_start at
 * 2026-09-23 13:00 UTC, the cancel RESPONSE BODY returned that stale value, and the job
 * page hero is served it directly - so a dispatcher reading a cancelled job saw a real
 * appointment on it. It only cleared when an unrelated visit write happened to run the
 * sync. Confirmed twice, on J00270 as well.
 *
 * The reopen variant is worse because the job is not obviously dead: J00260 after cancel
 * then reopen read IN_PROGRESS while scheduled_start still said 2026-09-21T13:00Z and its
 * only visit was CANCELLED. reopen() also wrote only status, subStatusClears and
 * completed_at, so cancelled_at and cancelled_reason survived it - a reopened job read In
 * Progress while still carrying a full cancellation record, and any report keyed on
 * cancelled_at counted it as cancelled.
 *
 * S8 (RATIFIED, A5), UPDATE: the fix above was a WRITE (clear the mirror in the same
 * statement). The mirror itself is now DROPPED - scheduled_start/scheduled_end/is_all_day are
 * a computed projection of `job.visits[]`, read fresh on every response. So the two tests
 * below no longer look for a "clearing write" (there is none to find); they assert the
 * ORDER cancel() now guarantees instead (the visit is cancelled BEFORE the final job re-read,
 * so the projection cannot see a stale pre-cancellation visit set) and that the RESPONSE BODY
 * itself never shows a cancelled trip's time, which is the same guarantee section 4.2 asked
 * for, proved a different way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

/** The trip the mirror points at, and the one the request is about to call off. */
const BOOKED_START = new Date('2026-09-23T13:00:00.000Z');
const BOOKED_END = new Date('2026-09-23T15:00:00.000Z');

const cancelledJob = {
  ...JOB_FIXTURE,
  status: 'CANCELLED',
  scheduled_start: BOOKED_START,
  scheduled_end: BOOKED_END,
  cancelled_at: new Date('2026-09-01T10:00:00.000Z'),
  cancelled_reason: 'Customer postponed',
  completed_at: null,
  invoices: [],
  source_plan_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
});

describe('POST /api/jobs/:id/cancel re-syncs the schedule mirror', () => {
  it('never writes scheduled_start/scheduled_end (DROPPED, S8) and cancels the visit BEFORE the final job re-read', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'SCHEDULED', invoices: [], source_plan_id: null,
    });

    const txJobUpdate = vi.fn().mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'CANCELLED',
      // The visit as it exists AFTER the cancellation below - jobDetailSelect's own nested
      // select, which is what this call's `select:` actually asks for on a real DB.
      visits: [{
        id: 'v1', status: 'CANCELLED', scheduled_at: BOOKED_START, scheduled_end: BOOKED_END,
        is_all_day: false, created_at: new Date('2026-08-01T00:00:00.000Z'), assignees: [],
      }],
    });
    const visitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: txJobUpdate },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        visit: { updateMany: visitUpdateMany },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    const data = txJobUpdate.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
    // S8 (RATIFIED): the columns are gone - there is nothing left to null here. Asserting their
    // ABSENCE (rather than that they equal null) is what would have caught a regression that
    // tried to write a now-nonexistent Prisma field.
    expect(data).not.toHaveProperty('scheduled_start');
    expect(data).not.toHaveProperty('scheduled_end');
    // The ORDER fix: the visit-cancelling `visit.updateMany` must run BEFORE the final
    // `job.update` whose `select` re-reads `visits[]` for the response - reordered exactly
    // because the response's computed projection would otherwise see the pre-cancellation set.
    expect(visitUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(txJobUpdate.mock.invocationCallOrder[0]);
    // End to end: the RESPONSE never shows a real appointment on a job that was just cancelled -
    // the same guarantee section 4.2 asked for, now proved against the actual JSON body rather
    // than an internal write.
    expect(res.body.job.scheduled_start).toBeNull();
    expect(res.body.job.scheduled_end).toBeNull();
  });
});

describe('POST /api/jobs/:id/reopen', () => {
  /** The job.update call that carries the reopen's own intent, not the mirror re-sync after it. */
  function reopenWrite() {
    const call = mockPrisma.job.update.mock.calls.find(
      (c: any) => c[0]?.data?.status === 'IN_PROGRESS',
    );
    return call?.[0].data as Record<string, unknown> | undefined;
  }

  it('clears the cancellation record it is undoing', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(cancelledJob);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const data = reopenWrite();
    expect(data).toBeDefined();
    expect(data!.completed_at).toBeNull();
    // Without these a reopened job reads In Progress while still carrying a full
    // cancellation record, and any report keyed on cancelled_at counts it as cancelled.
    expect(data!.cancelled_at).toBeNull();
    expect(data!.cancelled_reason).toBeNull();
  });

  it('does not leave the mirror pointing at a cancelled trip', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(cancelledJob);
    // J00260's shape: the job comes back, but its only trip stays CANCELLED - the
    // job-level cancel deliberately does not revive them (D19).
    const cancelledVisit = {
      id: 'v1', job_id: JOB_FIXTURE.id, status: 'CANCELLED', visit_seq: 1,
      scheduled_at: BOOKED_START, scheduled_end: BOOKED_END, is_all_day: false,
      en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
      created_at: new Date('2026-08-01T00:00:00.000Z'), assignees: [],
    };
    mockPrisma.visit.findMany.mockResolvedValue([cancelledVisit]);
    // S8 (RATIFIED, A5): reopen()'s own `job.update` (the one `presentJobDetail` is built from)
    // has to carry the SAME visit set for this test to mean anything - jobDetailSelect's real
    // `select` would return exactly this shape on a real DB. `syncJobFromVisits`'s OWN
    // `job.update` call re-derives status/span off the mocked `visit.findMany` above, but that
    // is NOT the row this response is built from (reopen() never re-reads after the sync call).
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE, status: 'IN_PROGRESS', visits: [cancelledVisit] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // S8 (RATIFIED): no explicit "clearing write" exists any more to search for - the wire keys
    // are a computed projection. Assert the RESPONSE directly: an all-cancelled visit set must
    // never project a real appointment onto a job that was just reopened.
    expect(res.body.job.scheduled_start).toBeNull();
    expect(res.body.job.scheduled_end).toBeNull();
    // The re-sync must not overrule the human who just reopened the job: deriving off an
    // all-cancelled visit set would answer UNSCHEDULED and undo the reopen in the same request.
    // reopen() calls prisma.job.update exactly twice - its own explicit write (asserted by
    // reopenWrite() above) and syncJobFromVisits' status/span re-derivation, called with
    // `deriveStatus: false` specifically so this second write never carries a `status` key.
    expect(mockPrisma.job.update.mock.calls.length).toBe(2);
    expect(mockPrisma.job.update.mock.calls[1][0].data.status).toBeUndefined();
  });
});
