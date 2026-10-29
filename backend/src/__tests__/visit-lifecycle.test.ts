/**
 * Multi-visit spec slice S4 - visit lifecycle.
 *
 * VisitStatus plus the four milestone timestamps live on the VISIT; Job.status is derived from
 * the visit set per D12 and written as a cache in the same transaction.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> attachAbility ->
 * canDo -> validate -> controller -> service) with Prisma mocked. Nothing here reaches for an
 * internal function's shape, so splitting or renaming the visit service leaves these standing.
 *
 * Two habits are load-bearing rather than decorative, and both are inherited from job-visits.test.ts:
 *  - the visit lookup's `where` is asserted DIRECTLY, because a mocked findFirst returns the row
 *    for any where at all, so a lookup that dropped `job_id` or the tenant looks identical here;
 *  - the job write's ABSENT keys are asserted, because the D16 collapse writes the job row on
 *    paths that never wrote it before and must not inherit assign()'s milestoneClears rewind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { resolveJobScheduleWindow } from '../lib/job-schedule-projection';

const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as Record<string, any>;

const VISIT_1_ID = 'v0000000-0000-0000-0000-000000000001';
const VISIT_2_ID = 'v0000000-0000-0000-0000-000000000002';

function visitRow(over: Record<string, unknown> = {}) {
  return {
    id: VISIT_1_ID,
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    job_id: JOB_FIXTURE.id,
    purpose: 'WORK',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
    is_all_day: false,
    duration_minutes: 150,
    en_route_at: null,
    on_site_at: null,
    started_at: null,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    created_at: new Date('2026-08-20T10:00:00Z'),
    updated_at: new Date('2026-08-20T10:00:00Z'),
    ...over,
  };
}

/**
 * The transaction the visit lifecycle write and the D12 derivation share.
 *
 * `visit.findMany` is the honouring fake from job-visits.test.ts:388 rather than a
 * mockResolvedValue: the derivation reads the job's WHOLE visit set, and a mock that ignored its
 * where would return the fixture list whatever the query asked for - so deleting the tenant or
 * the job_id predicate would leave every assertion in this file green.
 */
function wireLifecycleTx(rows: ReturnType<typeof visitRow>[]) {
  const table = [...rows];
  const txVisitFindMany = vi.fn().mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    return table.filter((r) => {
      if (where.organization_id !== undefined && r.organization_id !== where.organization_id) return false;
      if (where.job_id !== undefined && r.job_id !== where.job_id) return false;
      if (where.status?.in && !where.status.in.includes(r.status)) return false;
      return true;
    });
  });
  const txVisitUpdate = vi.fn().mockImplementation(async (args: any) => {
    const row = table.find((r) => r.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return row ?? visitRow(args.data);
  });
  const txVisitUpdateMany = vi.fn().mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    const row = table.find((r) => r.id === where.id);
    if (!row) return { count: 0 };
    if (where.status?.in && !where.status.in.includes(row.status)) return { count: 0 };
    Object.assign(row, args?.data ?? {});
    return { count: 1 };
  });
  const txJobUpdate = vi.fn().mockResolvedValue(JOB_FIXTURE);
  const txJobFindUnique = vi.fn().mockImplementation(async () => ({ id: JOB_FIXTURE.id, status: jobStatus.value }));
  const jobStatus = { value: 'SCHEDULED' as string };
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: txVisitUpdate,
        // Table-aware, and it honours an accept-set in the WHERE the way Postgres does. The cancel
        // writer's guard is an `updateMany`, so a blanket `{ count: 0 }` here made every cancel in
        // this file look like a lost race, and a blanket `{ count: 1 }` would let an UNGUARDED
        // writer through unnoticed - which is the defect the guard exists to prevent.
        updateMany: txVisitUpdateMany,
        findFirst: vi.fn().mockImplementation(async (args: any) => table.find((r) => r.id === args.where.id) ?? null),
        findMany: txVisitFindMany,
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { update: txJobUpdate, findUnique: txJobFindUnique },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // Scheduling-notifications slice 08: every milestone write appends to the log in this same
      // transaction. Its rows are asserted in visit-milestone-skip-stamps.test.ts, not here.
      visitMilestoneLog: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
  return { txVisitUpdate, txVisitUpdateMany, txVisitFindMany, txJobUpdate, txJobFindUnique, jobStatus, table };
}

describe('POST /api/jobs/:id/visits/:visitId/start - starting a visit starts its job (D7, D12)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  const VISIT_1 = visitRow({
    id: VISIT_1_ID,
    visit_seq: 1,
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
  });
  const VISIT_2 = visitRow({
    id: VISIT_2_ID,
    visit_seq: 2,
    scheduled_at: new Date('2026-09-12T13:00:00Z'),
    scheduled_end: new Date('2026-09-12T15:30:00Z'),
    created_at: new Date('2026-08-20T11:00:00Z'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
    });
    tx = wireLifecycleTx([VISIT_1, VISIT_2]);
  });

  it('stamps the visit and derives the job IN_PROGRESS in the same transaction', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);

    // The lookup's scope rule, asserted directly: the mock returns the row for ANY where, so a
    // handler that dropped `job_id` or the tenant would look identical from the response alone -
    // while against a real database it would let one job's URL start another job's visit.
    expect(mockPrisma.visit.findFirst.mock.calls[0][0].where).toEqual({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });

    expect(tx.txVisitUpdate).toHaveBeenCalledTimes(1);
    const visitWrite = tx.txVisitUpdate.mock.calls[0][0];
    expect(visitWrite.where.id).toBe(VISIT_1_ID);
    expect(visitWrite.data.status).toBe('IN_PROGRESS');
    expect(visitWrite.data.started_at).toBeInstanceOf(Date);
    // D13: the number never moves, and a lifecycle write is not a reschedule.
    expect(visitWrite.data).not.toHaveProperty('visit_seq');
    expect(visitWrite.data).not.toHaveProperty('scheduled_at');
    expect(visitWrite.data).not.toHaveProperty('lead_id');

    // D12: IN_PROGRESS is "any visit started", derived and written as a cache in the SAME
    // transaction as the visit row.
    expect(tx.txJobUpdate).toHaveBeenCalledTimes(1);
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    expect(jobData.status).toBe('IN_PROGRESS');
    expect(jobData.started_at).toBeInstanceOf(Date);
  });
});

describe('POST /api/jobs/:id/visits/:visitId/complete - the last visit finishing is not the job finishing (D7)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  const ONLY_VISIT = visitRow({
    id: VISIT_1_ID,
    status: 'IN_PROGRESS',
    started_at: new Date('2026-09-05T13:04:00Z'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      assignees: [],
    });
    tx = wireLifecycleTx([ONLY_VISIT]);
    tx.jobStatus.value = 'IN_PROGRESS';
  });

  it('stamps the visit COMPLETED and leaves the job IN_PROGRESS, neither completed nor unscheduled', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);

    const visitWrite = tx.txVisitUpdate.mock.calls[0][0];
    expect(visitWrite.data.status).toBe('COMPLETED');
    expect(visitWrite.data.completed_at).toBeInstanceOf(Date);

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // D12's two negatives, and the whole reason this behaviour is written second. The job's ONLY
    // visit just left the live set, so a derivation that checked "no live visits" before it
    // checked "any visit started" would answer UNSCHEDULED and silently demote a job that was
    // just worked - the #1550 class, on the column the board, the filters, jobs-report, the
    // dashboard KPIs and the automation triggers all read.
    expect(jobData.status).toBe('IN_PROGRESS');
    expect(jobData.status).not.toBe('COMPLETED');
    expect(jobData.status).not.toBe('UNSCHEDULED');

    // D7: completing the last visit does NOT auto-complete the job, and the collapse must not
    // inherit assign()'s milestoneClears rewind either. Job.completed_at stays an explicitly-set
    // job-level fact.
    expect(Object.keys(jobData)).not.toContain('completed_at');
    expect(Object.keys(jobData)).not.toContain('cancelled_at');
    expect(Object.keys(jobData)).not.toContain('cancelled_reason');

    // S8 (RATIFIED, A5): the forward mirror is DROPPED - nothing writes scheduled_start/
    // scheduled_end/is_all_day here any more. D16's collapse (no live visit remains) is now the
    // read-time projection's job: with the last live visit gone, resolveJobScheduleWindow falls
    // back to the earliest NON-CANCELLED visit (still this one, since it is COMPLETED not
    // CANCELLED) rather than nulling - a completed job stays non-blank on the board.
    expect(jobData).not.toHaveProperty('scheduled_start');
    expect(jobData).not.toHaveProperty('scheduled_end');
    expect(jobData).not.toHaveProperty('is_all_day');
  });

  it('holds the job IN_PROGRESS when the only visit is completed straight off ON_SITE', async () => {
    // The two-click path the card actually offers: On site -> Complete. VISIT_ACTIONS lists
    // Complete as reachable from EN_ROUTE and ON_SITE, so a trip can finish having never carried
    // a started_at at all - and a derivation keyed only on that stamp then sees an empty live set
    // with nothing started and answers UNSCHEDULED, dropping the job that was just worked off the
    // board and out of every in-flight query. The guard above cannot see this: it seeds a visit
    // whose started_at is already set.
    tx = wireLifecycleTx([visitRow({ id: VISIT_1_ID, status: 'ON_SITE', on_site_at: new Date('2026-09-05T13:02:00Z'), started_at: null })]);
    tx.jobStatus.value = 'SCHEDULED';
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'ON_SITE',
      assignees: [],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    expect(jobData.status).not.toBe('UNSCHEDULED');
    expect(jobData.status).toBe('IN_PROGRESS');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/cancel - the row is kept and the job unschedules (D16, D19)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  const ONLY_VISIT = visitRow({ id: VISIT_1_ID, status: 'SCHEDULED' });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
    });
    tx = wireLifecycleTx([ONLY_VISIT]);
  });

  it('keeps the row, records who called it off, and collapses the job to UNSCHEDULED', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduled offline' });

    expect(res.status).toBe(200);

    // D19: rows are NEVER deleted - the customer holds an email naming "Visit 1", and the trip
    // having been called off is part of the job's history.
    expect(mockPrisma.visit.delete).not.toHaveBeenCalled();
    expect(mockPrisma.visit.deleteMany).not.toHaveBeenCalled();

    // The cancel writes through the GUARDED updateMany - its target was resolved before the
    // transaction opened, so the accept-set is re-tested in the WHERE. `txVisitUpdate` still runs
    // afterwards, but only to re-read the row the door answers with.
    const visitWrite = tx.txVisitUpdateMany.mock.calls[0][0];
    expect(visitWrite.where.id).toBe(VISIT_1_ID);
    expect(visitWrite.where.status.in).not.toContain('CANCELLED');
    expect(visitWrite.data.status).toBe('CANCELLED');
    expect(visitWrite.data.cancelled_at).toBeInstanceOf(Date);
    expect(visitWrite.data.cancelled_reason).toBe('Customer rescheduled offline');
    expect(visitWrite.data.cancelled_by).toBe('00000000-0000-0000-0000-000000000001');
    // D13: a cancelled visit still consumes its number.
    expect(visitWrite.data).not.toHaveProperty('visit_seq');

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // D16: unscheduled means NO LIVE VISITS. The job is not cancelled - only a dispatcher
    // cancelling the JOB does that.
    expect(jobData.status).toBe('UNSCHEDULED');
    // S8 (RATIFIED, A5): the forward mirror is DROPPED - nothing writes scheduled_start/
    // scheduled_end/is_all_day here any more. The job's only visit is now CANCELLED, so the
    // read-time projection (resolveJobScheduleWindow) has no non-cancelled visit to fall back to
    // either - the response correctly shows null, computed on read rather than written here.
    expect(jobData).not.toHaveProperty('scheduled_start');
    expect(jobData).not.toHaveProperty('scheduled_end');
    expect(jobData).not.toHaveProperty('is_all_day');

    // The collapse writes the job row on a path that never wrote it before, so it must not
    // inherit assign()'s milestoneClears rewind: a job that was on site last week does not lose
    // that history because next week's trip was called off.
    expect(Object.keys(jobData)).not.toContain('started_at');
    expect(Object.keys(jobData)).not.toContain('en_route_at');
    expect(Object.keys(jobData)).not.toContain('on_site_at');
    expect(Object.keys(jobData)).not.toContain('completed_at');
    expect(Object.keys(jobData)).not.toContain('cancelled_at');
    expect(Object.keys(jobData)).not.toContain('cancelled_reason');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/cancel - a called-off trip stops counting as work (D12, D16)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  it('collapses a job to UNSCHEDULED when the ONE visit that had started is cancelled', async () => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      assignees: [],
    });
    // The trip the crew started and the office then called off. Its start stamp SURVIVES the
    // cancel - the row is history (D19) and cancelWalkthroughRow never rewinds it.
    tx = wireLifecycleTx([
      visitRow({ id: VISIT_1_ID, status: 'IN_PROGRESS', started_at: new Date('2026-09-05T13:04:00Z') }),
    ]);
    tx.jobStatus.value = 'IN_PROGRESS';

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer sent the crew away' });

    expect(res.status).toBe(200);
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // A derivation that reads the stamp off a CANCELLED row pins the job IN_PROGRESS for ever:
    // there is no live visit left to schedule it and no route that can un-start a visit, so the
    // board shows a job under way whose only trip was called off.
    expect(jobData.status).not.toBe('IN_PROGRESS');
    expect(jobData.status).toBe('UNSCHEDULED');
  });
});

describe('the derivation never overwrites a human-set COMPLETED or CANCELLED job (D12)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  const VISIT_1 = visitRow({ id: VISIT_1_ID, status: 'SCHEDULED' });
  const VISIT_2 = visitRow({
    id: VISIT_2_ID,
    visit_seq: 2,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-12T13:00:00Z'),
    scheduled_end: new Date('2026-09-12T15:30:00Z'),
    created_at: new Date('2026-08-20T11:00:00Z'),
  });

  function arrange(humanStatus: 'COMPLETED' | 'CANCELLED') {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: humanStatus,
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
    });
    tx = wireLifecycleTx([visitRow({ ...VISIT_1 }), visitRow({ ...VISIT_2 })]);
    tx.jobStatus.value = humanStatus;
  }

  it('cancelling the last live visit on a COMPLETED job collapses the mirror and leaves the status alone', async () => {
    arrange('COMPLETED');
    // Both trips called off, so the live set empties and the collapse fires - the branch most
    // likely to hit a finished job, because a job whose last visit just ended is the job most
    // likely to be COMPLETED.
    tx.table[1].status = 'CANCELLED';

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // The mirror collapses; the human-set status does not move. Writing UNSCHEDULED here would
    // demote a finished job on the column the board, the filters, jobs-report, the dashboard KPIs
    // and the automation triggers all read - reporting corruption, not a cosmetic badge.
    expect(Object.keys(jobData)).not.toContain('status');
    // S8 (RATIFIED, A5): the forward mirror is DROPPED - nothing writes scheduled_start/
    // scheduled_end here any more. Both visits are now CANCELLED, so the read-time projection
    // has no non-cancelled visit to fall back to either - the response correctly shows null.
    expect(jobData).not.toHaveProperty('scheduled_start');
    expect(jobData).not.toHaveProperty('scheduled_end');
  });

  it('cancelling the last live visit on a CANCELLED job leaves the status alone', async () => {
    arrange('CANCELLED');
    tx.table[1].status = 'CANCELLED';

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(Object.keys(tx.txJobUpdate.mock.calls[0][0].data)).not.toContain('status');
  });

  it('starting a visit on a COMPLETED job does not silently reopen it', async () => {
    arrange('COMPLETED');
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_2_ID,
      job_id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_2_ID}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // The visit really did start - the stamp lands and the job's started_at mirror follows.
    expect(tx.txVisitUpdate.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    expect(jobData.started_at).toBeInstanceOf(Date);
    // But the job's own status is a human-set fact. Deriving IN_PROGRESS here would reopen a job
    // somebody closed, through a door nobody pressed.
    expect(Object.keys(jobData)).not.toContain('status');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/cancel - one trip off the books is not the whole job (spec cycle 3)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      assignees: [],
    });
    tx = wireLifecycleTx([
      visitRow({ id: VISIT_1_ID, visit_seq: 1 }),
      visitRow({
        id: VISIT_2_ID,
        visit_seq: 2,
        scheduled_at: new Date('2026-09-12T13:00:00Z'),
        scheduled_end: new Date('2026-09-12T15:30:00Z'),
        is_all_day: false,
        created_at: new Date('2026-08-20T11:00:00Z'),
      }),
    ]);
  });

  it('cancels visit 1 only, and hands the mirror to visit 2 rather than nulling it', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Parts delayed' });

    expect(res.status).toBe(200);

    // Visit 2 is untouched: exactly one row moved, and it was the one named in the URL.
    expect(tx.txVisitUpdate).toHaveBeenCalledTimes(1);
    expect(tx.txVisitUpdate.mock.calls[0][0].where.id).toBe(VISIT_1_ID);

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // S8 (RATIFIED, A5): the forward mirror is DROPPED - nothing writes scheduled_start/
    // scheduled_end/is_all_day here any more, so they are asserted ABSENT from the write.
    expect(jobData).not.toHaveProperty('scheduled_start');
    expect(jobData).not.toHaveProperty('scheduled_end');
    expect(jobData).not.toHaveProperty('is_all_day');
    // The read-time replacement for "hands the mirror to visit 2": tx.table is the STATEFUL
    // store the visit write above just mutated in place (visit 1 now CANCELLED, visit 2
    // untouched) - resolveJobScheduleWindow, the real production projection, is asked the exact
    // question the old mirror write used to answer, over the exact post-write set. A collapse
    // implemented as "if the cancelled visit was the mirror, null the columns" gets this wrong;
    // only re-resolving over the whole POST-WRITE LIVE set gets it right, and only a two-visit
    // fixture can tell the two apart.
    const projected = resolveJobScheduleWindow(tx.table as never);
    expect(projected.scheduled_start?.toISOString()).toBe('2026-09-12T13:00:00.000Z');
    expect(projected.scheduled_end?.toISOString()).toBe('2026-09-12T15:30:00.000Z');
    expect(projected.is_all_day).toBe(false);
    // Losing one of two trips does not unschedule the job.
    expect(jobData.status).toBe('SCHEDULED');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/start - only crew on THAT visit may start it (D7a)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  // Technician A is crew on visit 1 and never makes a request; the acting technician (TEST_USERS
  // .technician) is crew on visit 2 only.
  const TECH_A = '00000000-0000-0000-0000-0000000000a1';
  const TECH_B = '00000000-0000-0000-0000-000000000004';

  function arrange(actor: 'admin' | 'dispatcher' | 'technician') {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs(actor);
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      // The S3 union across every visit, holding BOTH technicians. This is what makes the test
      // able to tell a job-level check from a visit-level one: the job-level predicate passes for
      // either technician, so without this fixture the test would pass against both
      // implementations and prove nothing.
      assignees: [{ user_id: TECH_A }, { user_id: TECH_B }],
    });
    mockPrisma.visit.findFirst.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === VISIT_1_ID) return { id: VISIT_1_ID, job_id: JOB_FIXTURE.id, assignees: [{ user_id: TECH_A }] };
      if (id === VISIT_2_ID) return { id: VISIT_2_ID, job_id: JOB_FIXTURE.id, assignees: [{ user_id: TECH_B }] };
      return null;
    });
    tx = wireLifecycleTx([
      visitRow({ id: VISIT_1_ID, visit_seq: 1 }),
      visitRow({
        id: VISIT_2_ID,
        visit_seq: 2,
        scheduled_at: new Date('2026-09-12T13:00:00Z'),
        scheduled_end: new Date('2026-09-12T15:30:00Z'),
        created_at: new Date('2026-08-20T11:00:00Z'),
      }),
    ]);
  }

  it('lets the technician crewed on visit 2 start visit 2', async () => {
    arrange('technician');
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_2_ID}/start`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(200);
    expect(tx.txVisitUpdate.mock.calls[0][0].where.id).toBe(VISIT_2_ID);
  });

  it('refuses that same technician on visit 1, which is another crew\'s trip', async () => {
    arrange('technician');
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/start`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(tx.txVisitUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin start visit 1 on the crew\'s behalf', async () => {
    arrange('admin');
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/start`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('lets a dispatcher on no visit at all start visit 1', async () => {
    arrange('dispatcher');
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/start`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('does not strip the job-assignee union when a visit completes', async () => {
    arrange('admin');
    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/complete`)
      .set(authHeader('admin'))
      .send({});

    // job_assignees is not a display list: OWN_JOB is `{ assignees: { some: { user_id } } }`, a
    // STORED row scope gating read/update/start/arrive/complete. A lifecycle write that pruned the
    // union would take a technician's access away the moment their trip finished - a silent 403,
    // not an error. S4 is the first slice that can reach that branch at all.
    expect(mockPrisma.jobAssignee.deleteMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/visits/:visitId/en-route - the default technician may mark their own trip on the way (scheduling-notifications slice 10)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  // Same two-crew fixture as the D7a start block above: technician A is crew on visit 1 and never
  // makes a request; the acting technician (TEST_USERS.technician) is crew on visit 2 only. The
  // job-level union holds BOTH, so the test can tell the visit-level crew check from a job-level
  // one exactly as the start block does.
  const TECH_A = '00000000-0000-0000-0000-0000000000a1';
  const TECH_B = '00000000-0000-0000-0000-000000000004';

  function arrange() {
    vi.clearAllMocks();
    clearPermissionCache();
    // No grant override: the technician holds exactly what DEFAULT_GRANTS seeds into a fresh org.
    // The route is gated by canDo('en_route', 'Job'), so this is the whole claim of user story
    // 24: the default role may take the first step of a visit without an admin toggling anything.
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [{ user_id: TECH_A }, { user_id: TECH_B }],
    });
    mockPrisma.visit.findFirst.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === VISIT_1_ID) return { id: VISIT_1_ID, job_id: JOB_FIXTURE.id, assignees: [{ user_id: TECH_A }] };
      if (id === VISIT_2_ID) return { id: VISIT_2_ID, job_id: JOB_FIXTURE.id, assignees: [{ user_id: TECH_B }] };
      return null;
    });
    tx = wireLifecycleTx([
      visitRow({ id: VISIT_1_ID, visit_seq: 1 }),
      visitRow({
        id: VISIT_2_ID,
        visit_seq: 2,
        scheduled_at: new Date('2026-09-12T13:00:00Z'),
        scheduled_end: new Date('2026-09-12T15:30:00Z'),
        created_at: new Date('2026-08-20T11:00:00Z'),
      }),
    ]);
  }

  it('lets the technician crewed on visit 2 mark visit 2 on the way, with only the default grants', async () => {
    arrange();
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_2_ID}/en-route`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(200);
    const visitWrite = tx.txVisitUpdate.mock.calls[0][0];
    expect(visitWrite.where.id).toBe(VISIT_2_ID);
    expect(visitWrite.data.status).toBe('EN_ROUTE');
  });

  it('still refuses that technician on visit 1, another crew\'s trip', async () => {
    arrange();
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/en-route`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(tx.txVisitUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/visits/:visitId/arrive - on site is a fact about the trip (D12, D17)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  function arrange(rows: ReturnType<typeof visitRow>[]) {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: [],
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      assignees: [],
    });
    tx = wireLifecycleTx(rows);
  }

  it('stamps the visit ON_SITE and leaves the job SCHEDULED', async () => {
    arrange([visitRow({ id: VISIT_1_ID })]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/arrive`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const visitWrite = tx.txVisitUpdate.mock.calls[0][0];
    expect(visitWrite.data.status).toBe('ON_SITE');
    expect(visitWrite.data.on_site_at).toBeInstanceOf(Date);

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // S8 (RATIFIED): on_site_at is DROPPED from `jobs` entirely - S5 had already repointed the
    // lifecycle bar off it, leaving it with no reader anywhere, so this test (which used to
    // assert the write, and said so in its own comment) now asserts its absence instead.
    expect(jobData).not.toHaveProperty('on_site_at');
    // NOT 'ON_SITE' - that value is retiring from JobStatus and lives on VisitStatus (D17). NOT
    // 'IN_PROGRESS' either: D12 says IN_PROGRESS is "any visit STARTED", and arriving is not
    // starting. A tech on site therefore leaves the job reading SCHEDULED, which is a deliberate,
    // spec-mandated change to what the board colours in flight, visible on the visit chip instead.
    expect(jobData.status).toBe('SCHEDULED');
  });

  // S8 (RATIFIED): en_route_at/on_site_at DROPPED from `jobs` - there is no job-level "earliest
  // across the set" to mirror any more. This test's ORIGINAL question ("does the job read the
  // right on-site stamp") is moot at the job level; the visit's OWN on_site_at (asserted on the
  // per-visit write in the test above) is the only place this fact lives now.
  it('never writes on_site_at to the job row, even with a second visit already on record', async () => {
    arrange([
      visitRow({
        id: VISIT_2_ID,
        visit_seq: 2,
        status: 'COMPLETED',
        on_site_at: new Date('2026-08-01T14:00:00Z'),
        completed_at: new Date('2026-08-01T16:00:00Z'),
        scheduled_at: new Date('2026-08-01T13:00:00Z'),
        scheduled_end: new Date('2026-08-01T16:00:00Z'),
      }),
      visitRow({ id: VISIT_1_ID, visit_seq: 1 }),
    ]);

    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/arrive`)
      .set(authHeader('admin'))
      .send({});

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    expect(jobData).not.toHaveProperty('on_site_at');
  });
});

describe('POST /api/jobs/:id/visits/:visitId/en-route - the stamp and the automation agree (D18)', () => {
  let tx: ReturnType<typeof wireLifecycleTx>;

  function arrange(crew: { user_id: string }[]) {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'SCHEDULED',
      job_number: 'J00001',
      source_plan_id: null,
      assignees: crew,
    });
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: VISIT_1_ID,
      job_id: JOB_FIXTURE.id,
      assignees: crew,
    });
    tx = wireLifecycleTx([visitRow({ id: VISIT_1_ID })]);
  }

  it('stamps the visit EN_ROUTE, mirrors it, and fires JOB_EN_ROUTE keyed on that same instant', async () => {
    arrange([{ user_id: '00000000-0000-0000-0000-000000000004' }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const visitWrite = tx.txVisitUpdate.mock.calls[0][0];
    expect(visitWrite.data.status).toBe('EN_ROUTE');
    expect(visitWrite.data.en_route_at).toBeInstanceOf(Date);

    const jobData = tx.txJobUpdate.mock.calls[0][0].data;
    // S8 (RATIFIED): en_route_at is DROPPED from `jobs` entirely - nothing writes it here any
    // more. The occurrenceKey assertion below still reads the PERSISTED VISIT stamp
    // (visitWrite.data.en_route_at), so the #1522 guarantee this test exists for is unaffected.
    expect(jobData).not.toHaveProperty('en_route_at');
    // Being on the way is a fact about the trip; the job is still SCHEDULED (D12/D17).
    expect(jobData.status).toBe('SCHEDULED');

    // The emitted key must BE the persisted stamp, not a second new Date() taken microseconds
    // later - that is exactly how a dedupe key stops matching the row it claims to describe
    // (#1522's idiom).
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.type).toBe('JOB_EN_ROUTE');
    // The ENTITY stays the parent job - context.ts's bundle loader has no 'visit' case, and D18
    // asks for the OCCURRENCE to name the visit, not the entity.
    expect(dispatched.entity).toEqual({ type: 'job', id: JOB_FIXTURE.id, label: 'J00001' });
    // S7 (D18): two crews leaving for two trips on one job are two occurrences. The visit id
    // rides the DEDUPE key only; the occurrence key stays the bare ISO stamp, because stopIf.ts
    // and terminalStale.ts read it as a timestamp and silently kill the run on a mismatch.
    expect(dispatched.visitId).toBe(VISIT_1_ID);
    expect(dispatched.occurrenceKey).toBe(visitWrite.data.en_route_at.toISOString());
    expect(dispatched.occurrenceKey).not.toContain(VISIT_1_ID);
  });

  it('does not fire the automation when the visit has no crew', async () => {
    arrange([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // The crew gate the job-level enRoute() already applies: the default automation tells the
    // customer WHO is on the way, so dispatching with an empty crew emails a notification naming
    // nobody.
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// Scheduling-notifications slice 07: the milestone is called "on the way" everywhere a user
// reads it, and a 500 body reaches the UI verbatim through extractApiError.
describe('POST /api/jobs/:id/visits/:visitId/en-route - failure copy speaks the way the app does', () => {
  it('never says "en route" when the milestone write fails', async () => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockRejectedValue(new Error('connection reset'));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_1_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update visit');
  });
});
