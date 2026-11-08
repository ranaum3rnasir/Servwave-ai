/**
 * The lead's status follows its walkthrough visits (walkthrough lead-statuses PRD 6 and 12.2,
 * items 1-8 and 11).
 *
 * Driven through the real HTTP routes with Prisma replaced by a small in-memory world: the lead's
 * status, its visit rows and the timeline are real state that the handlers read and write, so the
 * assertions are about what a person would see (the status, and the History row with its `from`,
 * `to` and wording), not about which mock was called. The one rule under test is
 * `walkthroughDrivenStatus`; the doors are only the ways a visit changes.
 *
 * The concurrency claims (two parallel completions, lock order) are Postgres behaviour and live in
 * lead-walkthrough-status.integration.test.ts against a real database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));
vi.mock('../services/automations/enrollment', () => ({
  rearmAnchoredWaits: vi.fn(),
  enrollEntity: vi.fn(),
  cancelEnrollmentsForEntity: vi.fn(),
}));

const mockPrisma = prisma as unknown as Record<string, any>;
const LEAD_ID = LEAD_FIXTURE.id;

type VisitRow = Record<string, any> & { id: string; lead_id: string; status: string };
let leadStatus: string;
let visits: VisitRow[];
let timeline: Array<Record<string, any>>;
let leadUpdateManyCalls: Array<{ where: any; data: any }>;

const visitId = (n: number) => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function visitRow(n: number, status: string, over: Record<string, unknown> = {}): VisitRow {
  return {
    id: visitId(n),
    organization_id: ALPHA_ORG_ID,
    lead_id: LEAD_ID,
    job_id: null,
    purpose: 'WALKTHROUGH',
    visit_seq: n,
    status,
    scheduled_at: new Date(Date.UTC(2031, 0, 10 + n, 15)),
    scheduled_end: new Date(Date.UTC(2031, 0, 10 + n, 16)),
    duration_minutes: 60,
    completed_at: status === 'COMPLETED' ? new Date(Date.UTC(2031, 0, 1)) : null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    notes: null,
    created_at: new Date(Date.UTC(2030, 11, n)),
    assignees: [],
    ...over,
  };
}

const LIVE = ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'];

function matches(row: VisitRow, where: any): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.organization_id !== undefined && row.organization_id !== where.organization_id) return false;
  if (where.lead_id !== undefined && row.lead_id !== where.lead_id) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'string') { if (row.status !== where.status) return false; }
    else if (where.status.in && !where.status.in.includes(row.status)) return false;
  }
  return true;
}

const earliest = (rows: VisitRow[]) =>
  [...rows].sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime() || a.created_at.getTime() - b.created_at.getTime())[0] ?? null;

/** The History rows that record a status move (not the visit's own "Walkthrough scheduled" rows). */
const statusMoves = () => timeline.filter((e) => e.event_type === 'STATUS_CHANGE');

function seed(status: string, rows: VisitRow[] = []) {
  leadStatus = status;
  visits = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  timeline = [];
  leadUpdateManyCalls = [];
  seed('CONTACTED');

  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  mockPrisma.lead.findUnique.mockImplementation(async () => ({ ...LEAD_FIXTURE, status: leadStatus, organization_id: ALPHA_ORG_ID }));
  mockPrisma.lead.findFirst.mockImplementation(async () => ({ id: LEAD_ID, status: leadStatus }));
  mockPrisma.lead.update.mockImplementation(async () => ({ ...LEAD_FIXTURE, status: leadStatus }));
  // Postgres's own semantics for the guarded status write: the WHERE decides, not the caller.
  mockPrisma.lead.updateMany.mockImplementation(async ({ where, data }: any) => {
    leadUpdateManyCalls.push({ where, data });
    if (where.status?.in && !where.status.in.includes(leadStatus)) return { count: 0 };
    if (where.status?.notIn && where.status.notIn.includes(leadStatus)) return { count: 0 };
    if (data.status !== undefined) leadStatus = data.status;
    return { count: 1 };
  });
  mockPrisma.timelineEvent.create.mockImplementation(async ({ data }: any) => { timeline.push(data); return data; });

  mockPrisma.visit.findFirst.mockImplementation(async ({ where }: any) =>
    earliest(visits.filter((v) => matches(v, where))),
  );
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockImplementation(async () => ({ _max: { visit_seq: Math.max(0, ...visits.map((v) => v.visit_seq)) || null } }));
  mockPrisma.visit.count.mockImplementation(async ({ where }: any) => visits.filter((v) => matches(v, where)).length);
  mockPrisma.visit.create.mockImplementation(async ({ data }: any) => {
    const row = visitRow(visits.length + 1, data.status ?? 'SCHEDULED', { ...data, id: visitId(visits.length + 1) });
    visits.push(row);
    return row;
  });
  mockPrisma.visit.update.mockImplementation(async ({ where, data }: any) => {
    const row = visits.find((v) => v.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
  mockPrisma.visit.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = visits.filter((v) => matches(v, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });
  mockPrisma.visitAssignee.findMany.mockResolvedValue([]);
  mockPrisma.visitAssignee.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.visitAssignee.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });
});

const SCHEDULE_BODY = { walkthrough_scheduled_at: '2031-02-01T15:00:00.000Z', performer_ids: [], send_email: false };
const addVisit = (at = '2031-03-01T15:00:00.000Z') =>
  request(app).post(`/api/leads/${LEAD_ID}/visits`).set(authHeader('admin')).send({ scheduled_at: at, duration_minutes: 60, assignee_ids: [] });
const schedule = () =>
  request(app).post(`/api/leads/${LEAD_ID}/walkthrough/schedule`).set(authHeader('admin')).send(SCHEDULE_BODY);
const complete = () => request(app).post(`/api/leads/${LEAD_ID}/walkthrough/complete`).set(authHeader('admin')).send({});
const cancel = () =>
  request(app).post(`/api/leads/${LEAD_ID}/walkthrough/cancel`).set(authHeader('admin')).send({ cancelled_reason: 'Customer asked' });
const unschedule = () => request(app).post(`/api/leads/${LEAD_ID}/walkthrough/unschedule`).set(authHeader('admin')).send({});
const unscheduleVisit = (n: number) =>
  request(app).post(`/api/leads/${LEAD_ID}/visits/${visitId(n)}/unschedule`).set(authHeader('admin')).send({});

/** One History row for one move, with the exact from, to and wording. */
function expectOneMove(from: string, to: string, description: string) {
  const moves = statusMoves();
  expect(moves).toHaveLength(1);
  expect(moves[0].metadata).toMatchObject({ from, to });
  expect(moves[0].description).toBe(description);
}

describe('booking a visit', () => {
  it('moves a New lead to Walkthrough Scheduled and does not stamp contacted_at (/walkthrough/schedule)', async () => {
    seed('NEW');
    const res = await schedule();

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expectOneMove('NEW', 'WALKTHROUGH_SCHEDULED', 'Lead moved to Walkthrough Scheduled: a walkthrough was booked');
    expect(leadUpdateManyCalls.some((c) => 'contacted_at' in c.data)).toBe(false);
  });

  it('asks the database to move the lead only from the four early statuses, so a concurrent Estimate Sent or Won is never overwritten', async () => {
    seed('CONTACTED');
    await schedule();

    const statusWrite = leadUpdateManyCalls.find((c) => c.data.status === 'WALKTHROUGH_SCHEDULED')!;
    expect(statusWrite.where.status.in).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED']);
    expect(statusWrite.where.status.notIn).toBeUndefined();
  });

  it('moves a Contacted lead to Walkthrough Scheduled (/walkthrough/schedule)', async () => {
    seed('CONTACTED');
    await schedule();

    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expectOneMove('CONTACTED', 'WALKTHROUGH_SCHEDULED', 'Lead moved to Walkthrough Scheduled: a walkthrough was booked');
  });

  it('moves a New lead to Walkthrough Scheduled through POST /visits too, with no contacted_at', async () => {
    seed('NEW');
    const res = await addVisit();

    expect(res.status).toBe(201);
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expectOneMove('NEW', 'WALKTHROUGH_SCHEDULED', 'Lead moved to Walkthrough Scheduled: a walkthrough was booked');
    expect(leadUpdateManyCalls.some((c) => 'contacted_at' in c.data)).toBe(false);
  });

  it('adding a visit to a Walkthrough Completed lead moves it back to Walkthrough Scheduled', async () => {
    seed('WALKTHROUGH_COMPLETED', [visitRow(1, 'COMPLETED')]);
    const res = await addVisit();

    expect(res.status).toBe(201);
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expectOneMove('WALKTHROUGH_COMPLETED', 'WALKTHROUGH_SCHEDULED', 'Lead moved back to Walkthrough Scheduled: another walkthrough was booked');
  });

  it('adding a second visit to a Walkthrough Scheduled lead changes nothing and writes no status row', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    await addVisit();

    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(statusMoves()).toHaveLength(0);
  });
});

describe('rescheduling a visit', () => {
  it('changes no status and writes no extra History row (PATCH /visits/:visitId)', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    const res = await request(app)
      .patch(`/api/leads/${LEAD_ID}/visits/${visitId(1)}`)
      .set(authHeader('admin'))
      .send(SCHEDULE_BODY);

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(statusMoves()).toHaveLength(0);
    expect(timeline.map((e) => e.event_type)).toEqual(['WALKTHROUGH_RESCHEDULED']);
  });

  it('changes no status on /walkthrough/schedule when the lead already holds an open visit', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    await schedule();

    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(statusMoves()).toHaveLength(0);
  });
});

describe('completing a visit', () => {
  it('with two open visits: completing one keeps Walkthrough Scheduled, completing the other gives Walkthrough Completed', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED'), visitRow(2, 'SCHEDULED')]);

    const first = await complete();
    expect(first.status).toBe(200);
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(statusMoves()).toHaveLength(0);

    const second = await complete();
    expect(second.status).toBe(200);
    expect(leadStatus).toBe('WALKTHROUGH_COMPLETED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'Lead moved to Walkthrough Completed: the walkthrough is done');
  });

  it('with one open visit: completing it gives Walkthrough Completed', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    await complete();

    expect(leadStatus).toBe('WALKTHROUGH_COMPLETED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'Lead moved to Walkthrough Completed: the walkthrough is done');
  });
});

describe('cancelling or unscheduling the last open visit', () => {
  it('/walkthrough/cancel with a finished visit gives Walkthrough Completed', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'COMPLETED'), visitRow(2, 'SCHEDULED')]);
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('WALKTHROUGH_COMPLETED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'Lead moved to Walkthrough Completed: the remaining walkthrough was cancelled');
  });

  it('/walkthrough/cancel with nothing finished gives Contacted', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    await cancel();

    expect(leadStatus).toBe('CONTACTED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'CONTACTED', 'Lead moved back to Contacted: its walkthrough was cancelled');
  });

  it('/walkthrough/unschedule with nothing finished gives Contacted', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    const res = await unschedule();

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('CONTACTED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'CONTACTED', 'Lead moved back to Contacted: its walkthrough was cancelled');
  });

  it('/visits/:visitId/unschedule with nothing finished gives Contacted', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    const res = await unscheduleVisit(1);

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('CONTACTED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'CONTACTED', 'Lead moved back to Contacted: its walkthrough was cancelled');
  });

  it('/visits/:visitId/unschedule with a finished visit gives Walkthrough Completed', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'COMPLETED'), visitRow(2, 'SCHEDULED')]);
    await unscheduleVisit(2);

    expect(leadStatus).toBe('WALKTHROUGH_COMPLETED');
    expectOneMove('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'Lead moved to Walkthrough Completed: the remaining walkthrough was cancelled');
  });

  it('removing one of two open visits leaves the lead Walkthrough Scheduled', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED'), visitRow(2, 'SCHEDULED')]);
    await unscheduleVisit(1);

    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(statusMoves()).toHaveLength(0);
  });
});

describe('regression: an Estimate Sent lead is never pulled back by a visit', () => {
  it('booking and then cancelling a visit leaves it Estimate Sent', async () => {
    seed('ESTIMATED');

    const booked = await addVisit();
    expect(booked.status).toBe(201);
    expect(leadStatus).toBe('ESTIMATED');

    const cancelled = await cancel();
    expect(cancelled.status).toBe(200);
    expect(leadStatus).toBe('ESTIMATED');
    expect(statusMoves()).toHaveLength(0);
  });

  it('unscheduling and completing leave it Estimate Sent too', async () => {
    seed('ESTIMATED', [visitRow(1, 'SCHEDULED'), visitRow(2, 'SCHEDULED')]);
    await unscheduleVisit(1);
    await complete();

    expect(leadStatus).toBe('ESTIMATED');
    expect(statusMoves()).toHaveLength(0);
  });
});

describe('visit changes never move a Won, Lost or Cancelled lead', () => {
  for (const closed of ['WON', 'LOST', 'CANCELLED']) {
    it(`${closed}: booking, adding, completing, unscheduling and cancelling change nothing`, async () => {
      seed(closed, [visitRow(1, 'SCHEDULED'), visitRow(2, 'SCHEDULED'), visitRow(3, 'SCHEDULED')]);

      expect((await schedule()).status).toBe(200);
      expect((await addVisit()).status).toBe(201);
      expect((await complete()).status).toBe(200);
      expect((await unscheduleVisit(3)).status).toBe(200);
      expect((await cancel()).status).toBe(200);

      expect(leadStatus).toBe(closed);
      expect(statusMoves()).toHaveLength(0);
    });
  }
});

describe('the lead-exit doors are left alone', () => {
  it('marking a Walkthrough Scheduled lead lost cancels its visits and ends at Lost, with one move', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED'), visitRow(2, 'COMPLETED')]);
    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Went elsewhere' });

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('LOST');
    expect(visits[0].status).toBe('CANCELLED');
    expect(statusMoves()).toHaveLength(1);
    expect(statusMoves()[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'LOST' });
  });

  it('cancelling a Walkthrough Scheduled lead cancels its visits and ends at Cancelled, with one move', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'SCHEDULED')]);
    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Duplicate' });

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('CANCELLED');
    expect(visits[0].status).toBe('CANCELLED');
    expect(statusMoves()).toHaveLength(1);
    expect(statusMoves()[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'CANCELLED' });
  });

  it('a bare Lost on the PATCH door is refused and writes nothing; the status menu closes the lead through mark-lost, which cancels the visits and leaves Lost', async () => {
    seed('WALKTHROUGH_SCHEDULED', [visitRow(1, 'COMPLETED'), visitRow(2, 'SCHEDULED')]);

    // Closing a lead always asks why (PRD D11), so the PATCH door refuses a status with no reason.
    const bare = await request(app).patch(`/api/leads/${LEAD_ID}`).set(authHeader('admin')).send({ status: 'LOST' });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe('Please give a reason.');
    expect(leadStatus).toBe('WALKTHROUGH_SCHEDULED');
    expect(visits[1].status).toBe('SCHEDULED');
    expect(statusMoves()).toHaveLength(0);

    // The menu's Lost opens the Mark Lost dialog, which posts here with the reason.
    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Went elsewhere' });

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('LOST');
    expect(visits[1].status).toBe('CANCELLED');
    expect(statusMoves().map((m) => m.metadata.to)).toEqual(['LOST']);
  });
});
