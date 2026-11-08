/**
 * walkthrough-scheduled-end.test.ts - #1699
 *
 * The lead-side visit writers set `scheduled_at` and `duration_minutes` but never
 * `scheduled_end`, so a rescheduled walkthrough keeps the end from its PREVIOUS time. Move one
 * later and the row now says it finishes before it starts.
 *
 * The schema states the invariant these pin outright (schema.prisma, `duration_minutes`):
 * "Every S2 write sets both from the same span." The job-shaped writers - createJobVisit,
 * rescheduleVisitRow - already do; only the two lead-shaped ones diverge.
 *
 * Driven through the HTTP API with Prisma mocked, the same seam the rest of the visit suite uses,
 * so these survive a rename or a split of the service functions underneath.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID, withLeadStatusSync } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as any;
const TECH_ID = TEST_USERS.technician.id;

/** The row the reschedule cases move: 13:00-14:00 UTC, exactly L00206's shape on staging. */
const LIVE_VISIT = {
  id: 'v0000000-0000-0000-0000-000000000001',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  job_id: null,
  purpose: 'WALKTHROUGH',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-09-01T13:00:00Z'),
  scheduled_end: new Date('2026-09-01T14:00:00Z'),
  duration_minutes: 60,
  is_all_day: false,
  completed_at: null,
  notes: null,
  cancelled_at: null,
  cancelled_reason: null,
  cancelled_by: null,
  customer_email_sent_at: null,
  created_at: new Date('2026-08-20T10:00:00Z'),
  updated_at: new Date('2026-08-20T10:00:00Z'),
  assignees: [],
};

function wireTx() {
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        aggregate: mockPrisma.visit.aggregate,
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // Spec #1751 D2: the walkthrough booking clock is a CONDITIONAL write of its own
      // (stampLeadClock -> lead.updateMany), so a double wiring only `update` 500s the door.
      lead: { update: vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

/** The span an end must agree with, expressed the way a reader would re-derive it. */
function expectSpan(data: any, startISO: string, minutes: number) {
  expect(data.scheduled_at.toISOString()).toBe(new Date(startISO).toISOString());
  expect(data.duration_minutes).toBe(minutes);
  expect(data.scheduled_end).toBeInstanceOf(Date);
  expect(data.scheduled_end.getTime() - data.scheduled_at.getTime()).toBe(minutes * 60_000);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 0 } });
  mockPrisma.visit.create.mockResolvedValue({ ...LIVE_VISIT, id: 'v-new', visit_seq: 1 });
  mockPrisma.visit.update.mockResolvedValue(LIVE_VISIT);
  mockPrisma.lead.findUnique.mockResolvedValue({
    ...LEAD_FIXTURE,
    status: 'CONTACTED',
    visit_assignees: [],
  });
  wireTx();
});

function scheduleWalkthrough(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
    .set(authHeader('admin'))
    .send({
      walkthrough_scheduled_at: '2026-09-01T15:00:00Z',
      performer_ids: [TECH_ID],
      walkthrough_duration_minutes: 60,
      ...body,
    });
}

describe('POST /api/leads/:id/walkthrough/schedule - the end moves with the start (#1699)', () => {
  it('rewrites scheduled_end when an existing walkthrough is rescheduled', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT);

    const res = await scheduleWalkthrough();

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledTimes(1);
    expectSpan(mockPrisma.visit.update.mock.calls[0][0].data, '2026-09-01T15:00:00Z', 60);
  });

  // The reported failure, stated as the thing a customer would notice rather than as a field
  // comparison: a visit whose end precedes its start.
  it('a walkthrough moved LATER does not end before it starts', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT);

    await scheduleWalkthrough({ walkthrough_scheduled_at: '2026-09-01T15:00:00Z' });

    const { data } = mockPrisma.visit.update.mock.calls[0][0];
    expect(data.scheduled_end.getTime()).toBeGreaterThan(data.scheduled_at.getTime());
  });

  it('carries a changed duration into the end, not just a changed start', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT);

    await scheduleWalkthrough({ walkthrough_duration_minutes: 150 });

    expectSpan(mockPrisma.visit.update.mock.calls[0][0].data, '2026-09-01T15:00:00Z', 150);
  });

  // The create branch of the same function: a first-ever walkthrough must not be born with a
  // null end, because that is the state a later reschedule then reads back as "unchanged".
  it('a first-time walkthrough is created with both ends of its span', async () => {
    const res = await scheduleWalkthrough({ walkthrough_duration_minutes: 90 });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    expectSpan(mockPrisma.visit.create.mock.calls[0][0].data, '2026-09-01T15:00:00Z', 90);
  });
});

describe('POST /api/leads/:id/visits - a booked trip carries its own end (#1699)', () => {
  it('writes scheduled_end alongside duration_minutes on the new row', async () => {
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 90,
        assignee_ids: [TECH_ID],
      });

    expect(res.status).toBe(201);
    expectSpan(mockPrisma.visit.create.mock.calls[0][0].data, '2026-09-04T14:00:00Z', 90);
  });
});
