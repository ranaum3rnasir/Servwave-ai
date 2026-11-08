import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { JobStatus } from '@prisma/client';
import { changesSchedule, deriveStatusOnReschedule } from '../controllers/job.controller';
import { mockAuthAs, authHeader, JOB_FIXTURE, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

describe('changesSchedule — which PATCH bodies count as a reschedule', () => {
  const existing = {
    scheduled_start: new Date('2026-03-01T09:00:00Z'),
    scheduled_end: new Date('2026-03-01T11:00:00Z'),
    is_all_day: false,
  };

  it('is false for a body that touches no schedule field', () => {
    expect(changesSchedule({ scope_notes: 'bring a ladder' }, existing)).toBe(false);
  });

  it('is false when the schedule fields are present but identical', () => {
    // A client that round-trips the whole job object must not be treated as rescheduling.
    expect(changesSchedule({
      scheduled_start: '2026-03-01T09:00:00.000Z',
      scheduled_end: '2026-03-01T11:00:00.000Z',
      is_all_day: false,
    }, existing)).toBe(false);
  });

  it('is true when the start moves', () => {
    expect(changesSchedule({ scheduled_start: '2026-03-02T09:00:00.000Z' }, existing)).toBe(true);
  });

  it('is true when the end moves', () => {
    expect(changesSchedule({ scheduled_end: '2026-03-01T13:00:00.000Z' }, existing)).toBe(true);
  });

  it('is true when all-day is toggled', () => {
    expect(changesSchedule({ is_all_day: true }, existing)).toBe(true);
  });

  it('is true when a schedule field is cleared', () => {
    expect(changesSchedule({ scheduled_start: null }, existing)).toBe(true);
  });

  it('is true on a job that has no schedule yet and is being given one', () => {
    expect(changesSchedule(
      { scheduled_start: '2026-03-01T09:00:00.000Z' },
      { scheduled_start: null, scheduled_end: null, is_all_day: false },
    )).toBe(true);
  });
});

// SRVW-87 - the exhaustive contract for PATCH's status derivation. PATCH deliberately does NOT
// reuse assign()'s `scheduled_start ? 'SCHEDULED' : existing.status`, because assign() pairs that
// with milestoneClears('scheduled') + revertPlanVisitOnUncomplete. Only two of the 21 cells below
// write a status at all; the other 19 leave the job exactly where it is.
describe('deriveStatusOnReschedule - only promotes UNSCHEDULED and only demotes SCHEDULED', () => {
  const WHEN = new Date('2026-03-02T09:00:00Z');

  // Column order: [ start untouched, start written, start cleared ]. Hard-coded on purpose -
  // this table is the specification, not a restatement of the implementation's branches.
  const EXPECTED: Record<string, (JobStatus | undefined)[]> = {
    UNSCHEDULED: [undefined, 'SCHEDULED', undefined],
    SCHEDULED: [undefined, undefined, 'UNSCHEDULED'],
    // EN_ROUTE and ON_SITE left this table with multi-visit S4 (D17) - they are VisitStatus
    // values now. Their rows were all-undefined anyway, so nothing about the rule changed.
    IN_PROGRESS: [undefined, undefined, undefined],
    COMPLETED: [undefined, undefined, undefined],
    CANCELLED: [undefined, undefined, undefined],
  };

  const CASES: { label: string; startTouched: boolean; nextStart: Date | null }[] = [
    { label: 'the body does not touch scheduled_start', startTouched: false, nextStart: WHEN },
    { label: 'the body writes a scheduled_start', startTouched: true, nextStart: WHEN },
    { label: 'the body clears scheduled_start', startTouched: true, nextStart: null },
  ];

  it('covers every JobStatus value', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(JobStatus).sort());
  });

  for (const status of Object.values(JobStatus)) {
    CASES.forEach((testCase, column) => {
      const expected = EXPECTED[status][column];
      it(`${status} + ${testCase.label} -> ${expected ?? 'no status write'}`, () => {
        expect(deriveStatusOnReschedule(status, testCase.startTouched, testCase.nextStart)).toBe(expected);
      });
    });
  }
});

describe('PATCH /api/jobs/:id — reschedule guard (integration)', () => {
  const mockPrisma = prisma as unknown as {
    job: {
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const jobRow = {
    id: JOB_FIXTURE.id,
    status: 'SCHEDULED',
    customer_id: 'cust-1',
    source_plan_id: null,
    service_location: { state: 'CA' },
    // S8 (D6): the job's crew is reached through its trips.
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    estimate: null,
    scheduled_start: new Date('2026-03-01T09:00:00Z'),
    scheduled_end: new Date('2026-03-01T11:00:00Z'),
    is_all_day: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow);
    // canAccessRow's own per-instance visibility probe — separate from findUnique above.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // update() wraps its write in $transaction; without this the callback never runs.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
    // SRVW-87 - jobRow is CREWED and the dispatcher case below moves a real window, so PATCH now
    // runs detectCrewConflicts for real. setup.ts declares job.findMany as a bare vi.fn() with no
    // default, so without this stub it resolves undefined and the conflict mapper TypeErrors into
    // update()'s outer catch, turning that 200 into a 500. Default to "no conflicts" so the
    // dispatcher case stays a GENUINE 200 through a real (empty) conflict query.
    mockPrisma.job.findMany.mockResolvedValue([]);
  });

  it('403s a technician (no reschedule toggle) who tries to move scheduled_start', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scheduled_start: '2026-03-02T09:00:00.000Z' });

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('allows a technician to edit a non-schedule field (scope_notes) without the toggle', async () => {
    mockAuthAs('technician');
    mockPrisma.job.update.mockResolvedValue({ ...jobRow, scope_notes: 'bring a ladder' });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'bring a ladder' });

    expect(res.status).toBe(200);
  });

  it('allows a DISPATCHER (unconditional grant) to move scheduled_start', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.update.mockResolvedValue({ ...jobRow, scheduled_start: new Date('2026-03-02T09:00:00Z') });

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: '2026-03-02T09:00:00.000Z', scheduled_end: '2026-03-02T11:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalled();
  });

  // SRVW-87 - the mirror of the case above. This file is the one place the crewed-reschedule
  // contract is already exercised, so the new 409 belongs beside it: same dispatcher, same crewed
  // job, same window move, but the crew member is busy elsewhere at the new time.
  it('409s a DISPATCHER whose crewed job collides at the new time', async () => {
    mockAuthAs('dispatcher');
    // Multi-visit S6 (B7): the conflict query reads the other job's VISIT set now.
    mockPrisma.job.findMany.mockResolvedValueOnce([{
      id: 'conflict-job',
      job_number: 'J00002',
      visits: [{
        id: 'conflict-visit',
        scheduled_at: new Date('2026-03-02T09:30:00Z'),
        scheduled_end: new Date('2026-03-02T10:30:00Z'),
      }],
    }]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ scheduled_start: '2026-03-02T09:00:00.000Z', scheduled_end: '2026-03-02T11:00:00.000Z' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});
