/**
 * MV-BOARD-15, section 4.3 of the multi-visit QA run: a job could advertise a time on its
 * own page and be invisible everywhere else.
 *
 * POST /api/jobs writes scheduled_start straight onto the job row and flips it to
 * SCHEDULED, and made no visit. J00239 on staging is the result: its own page reads chip
 * "Scheduled" and hero "Aug 22, 9:00 AM / in 2 days", its Visits tab reads "No visits
 * booked yet", it paints no card on the board week, it returns 0 rows from the board's own
 * date-range query, and it is absent from the Unscheduled bucket because its status is
 * SCHEDULED. Booking a visit by hand makes it appear immediately.
 *
 * That is a missed-appointment class defect: the job looks scheduled to whoever opens it
 * and does not exist to anyone working the board.
 *
 * The create path's own comment said "D16 forbids inventing an untimed one" - which is
 * true, and is exactly why the fix is conditional. A create carrying a scheduled_start is
 * TIMED, so booking visit 1 for it breaks no rule; a create without one still makes no
 * visit and the job is correctly UNSCHEDULED.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, CUSTOMER_FIXTURE, LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const SCHEDULED_START = '2026-08-22T13:00:00.000Z';
const SCHEDULED_END = '2026-08-22T15:00:00.000Z';

let txVisitCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  txVisitCreate = vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 });
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.customer.findUnique?.mockResolvedValue(CUSTOMER_FIXTURE);
  mockPrisma.customer.findFirst?.mockResolvedValue(CUSTOMER_FIXTURE);
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(JOB_FIXTURE),
        update: vi.fn().mockResolvedValue(JOB_FIXTURE),
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

describe('POST /api/jobs books the trip it says it booked', () => {
  it('creates visit 1 for a job created WITH a scheduled_start', async () => {
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
    expect(txVisitCreate).toHaveBeenCalledTimes(1);
    const data = txVisitCreate.mock.calls[0][0].data;
    expect(data.scheduled_at).toEqual(new Date(SCHEDULED_START));
    expect(data.job_id).toBe(JOB_FIXTURE.id);
    // visits_exactly_one_parent: a job visit carries no lead.
    expect(data.lead_id ?? null).toBeNull();
  });

  it('makes NO visit for a job created without a time', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
      });

    expect(res.status).toBe(201);
    // D16 forbids inventing an untimed visit - the job is correctly UNSCHEDULED and shows
    // up in the Unscheduled bucket, which is where a job with no time belongs.
    expect(txVisitCreate).not.toHaveBeenCalled();
  });
});
