/**
 * MV-TZ-07 half (b), from the writer's end.
 *
 * Visit schedule timeline rows embed a raw UTC instant in their description - "Visit 2
 * scheduled for 2026-08-25T17:00:00.000Z" - and the job page's Activity panel prints that
 * description verbatim, so a bare Z string reached every viewer in every zone. The panel
 * now renders any instant left in a stored description on the org clock, but new rows
 * should not carry one at all: the structured metadata beside it is what a renderer is
 * meant to read, and it is already present and correct.
 *
 * The reschedule writer also omitted `from` entirely while the create writer sends
 * `from: null`. A renderer told to use the structured from/to had only half of it, and
 * ActivityPanel's guard read the absence as malformed and suppressed the schedule line -
 * so on J00234 only 3 of 11 rows rendered a time at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const mockPrisma = prisma as unknown as Record<string, any>;

const NEW_START = '2026-08-25T17:00:00.000Z';
const OLD_START = new Date('2026-08-23T13:00:00.000Z');

/** Any ISO-8601 UTC instant - the thing no description may carry. */
const ISO_UTC = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/;

function visitRow(over: Record<string, unknown> = {}) {
  return {
    id: 'v0000000-0000-0000-0000-000000000001',
    assignees: [] as { user_id: string }[],
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    job_id: JOB_FIXTURE.id,
    purpose: 'WORK',
    visit_seq: 2,
    status: 'SCHEDULED',
    scheduled_at: OLD_START,
    scheduled_end: new Date('2026-08-23T15:00:00.000Z'),
    is_all_day: false,
    duration_minutes: 120,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    en_route_at: null,
    on_site_at: null,
    started_at: null,
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    ...over,
  };
}

let txTimelineCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  txTimelineCreate = vi.fn().mockResolvedValue({});
  mockPrisma.job.findUnique.mockResolvedValue({
    ...JOB_FIXTURE, status: 'SCHEDULED', assignees: [], invoices: [], source_plan_id: null, customer: null,
  });
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.findFirst.mockResolvedValue(visitRow());
  mockPrisma.visit.create.mockResolvedValue(visitRow());
  mockPrisma.visit.update.mockResolvedValue(visitRow({ scheduled_at: new Date(NEW_START) }));
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } }),
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
      job: { update: vi.fn().mockResolvedValue(JOB_FIXTURE), findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: txTimelineCreate },
    }),
  );
});

/** The timeline row written with one of the schedule event types. */
function scheduleRow() {
  const call = txTimelineCreate.mock.calls.find(
    (c: any) => c[0]?.data?.event_type === 'SCHEDULED' || c[0]?.data?.event_type === 'RESCHEDULED',
  );
  return call?.[0].data as Record<string, any> | undefined;
}

describe('POST /api/jobs/:id/visits writes a timeline row a renderer can localise', () => {
  it('does not embed a raw UTC instant in the description', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START, scheduled_end: '2026-08-25T19:00:00.000Z' });

    expect(res.status).toBe(201);
    const row = scheduleRow();
    expect(row).toBeDefined();
    expect(row!.description).not.toMatch(ISO_UTC);
    // The number is what makes the row readable without a time in it.
    expect(row!.description).toContain('Visit');
  });

  it('still carries the instant in structured metadata', async () => {
    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START, scheduled_end: '2026-08-25T19:00:00.000Z' });

    const row = scheduleRow();
    expect(row!.metadata.to).toBe(NEW_START);
    expect(row!.metadata.from).toBeNull();
    expect(row!.metadata).toHaveProperty('visit_seq');
  });
});

describe('PATCH /api/jobs/:id/visits/:visitId writes both ends of the move', () => {
  it('names the previous time in `from` rather than omitting it', async () => {
    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/v0000000-0000-0000-0000-000000000001`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START, scheduled_end: '2026-08-25T19:00:00.000Z' });

    expect(res.status).toBe(200);
    const row = scheduleRow();
    expect(row).toBeDefined();
    // Absent is what suppressed the Activity panel's schedule line entirely.
    expect(row!.metadata.from).toBe(OLD_START.toISOString());
    expect(row!.metadata.to).toBe(NEW_START);
  });

  it('does not embed a raw UTC instant in the description', async () => {
    await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/v0000000-0000-0000-0000-000000000001`)
      .set(authHeader('admin'))
      .send({ scheduled_start: NEW_START, scheduled_end: '2026-08-25T19:00:00.000Z' });

    expect(scheduleRow()!.description).not.toMatch(ISO_UTC);
  });
});
