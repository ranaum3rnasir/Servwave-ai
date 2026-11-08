/**
 * Scheduling-notifications PRD, user story 1: the customer is emailed the moment a job is put on
 * the calendar, crew or no crew.
 *
 * POST /api/jobs with a scheduled_start (the /jobs/new form's "schedule now" toggle) is a THIRD
 * booking door beside POST /jobs/:id/assign and POST /jobs/:id/visits. It books visit 1 in the
 * create transaction (job-create-books-visit.test.ts) but never asked decideScheduleDispatch, so
 * the job landed SCHEDULED with a trip and no "Job is scheduled" enrollment, and because the
 * once-per-job guard stayed NULL the job's later moves through /assign fired nothing either: the
 * decision reads "never announced" and answers JOB_SCHEDULED for a job that already had a start,
 * which /assign's own rule then refuses. The customer was never told.
 *
 * The create door now states the same facts to the same decision as the other two doors and
 * takes its answer: JOB_SCHEDULED once, keyed to the visit it booked, and the guard stamped in
 * the same transaction as the trip - so a later crew change is "Technician is assigned" and a
 * later move is "Job is rescheduled", exactly as when the job was booked through /assign.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, CUSTOMER_FIXTURE, LOCATION_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as Record<string, any>;

const SCHEDULED_START = '2026-08-22T13:00:00.000Z';
const SCHEDULED_END = '2026-08-22T15:00:00.000Z';

let txVisitCreate: ReturnType<typeof vi.fn>;
let txJobUpdate: ReturnType<typeof vi.fn>;

function dispatched(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  txVisitCreate = vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 });
  txJobUpdate = vi.fn().mockResolvedValue(JOB_FIXTURE);
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.customer.findUnique?.mockResolvedValue(CUSTOMER_FIXTURE);
  mockPrisma.customer.findFirst?.mockResolvedValue(CUSTOMER_FIXTURE);
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(JOB_FIXTURE),
        update: txJobUpdate,
      },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      priceBookItem: { findMany: vi.fn().mockResolvedValue([]) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      visit: {
        create: txVisitCreate,
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }),
  );
});

describe('POST /api/jobs announces the trip it books', () => {
  it('dispatches JOB_SCHEDULED once, keyed to the visit it booked, for a job created WITH a scheduled_start', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        scheduled_start: SCHEDULED_START,
        scheduled_end: SCHEDULED_END,
      });

    expect(res.status).toBe(201);
    const scheduled = dispatched('JOB_SCHEDULED');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'job', id: JOB_FIXTURE.id, label: JOB_FIXTURE.job_number },
      // The occurrence is scoped to the trip this create booked, the same way the two other
      // doors scope theirs, so what it renders is this trip.
      visitId: 'v-new',
    });
    expect(dispatched('JOB_RESCHEDULED')).toHaveLength(0);
  });

  it('stamps the once-per-job guard in the create transaction, so a later move is a reschedule and not a second announcement', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        scheduled_start: SCHEDULED_START,
        scheduled_end: SCHEDULED_END,
      });

    expect(res.status).toBe(201);
    // /assign and /visits read this column as "the scheduling announcement already happened".
    // Left NULL, the next move through /assign states startBefore != null with the guard unset,
    // which the shared decision answers with nothing - the customer would never hear of the move.
    const stamps = txJobUpdate.mock.calls.filter(
      (c: any[]) => c[0].data?.customer_scheduled_email_sent_at instanceof Date,
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0][0].where).toMatchObject({ id: JOB_FIXTURE.id, organization_id: ALPHA_ORG_ID });
  });

  it('dispatches nothing and stamps nothing for a job created without a time', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
      });

    expect(res.status).toBe(201);
    // D16: no time, no trip, the job is UNSCHEDULED - there is nothing to announce, and the
    // guard must stay NULL so that the job's FIRST booking through /assign or /visits announces.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(txJobUpdate).not.toHaveBeenCalled();
  });
});
