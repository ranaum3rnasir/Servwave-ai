/**
 * Visits-and-task-categories slice 03 - one scheduler card per lead walkthrough visit.
 *
 * The board draws a lead's walkthroughs off `GET /api/leads?walkthrough_after&walkthrough_before`,
 * and until this slice that payload carried only the flat "current walkthrough" projection - one
 * time per lead - so a second trip in the same week, or the next trip after a past uncompleted one,
 * never reached the board. Driven through the real Express app with Prisma mocked (the house seam).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, LEAD_FIXTURE, TEST_USERS, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/automations/enrollment', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  rearmAnchoredWaits: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as unknown as Record<string, any>;
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;

const BEN = { user_id: 'u-ben', user: { id: 'u-ben', first_name: 'Ben', last_name: 'Ortiz', phone: null } };
const DANA = { user_id: 'u-dana', user: { id: 'u-dana', first_name: 'Dana', last_name: 'Whitfield', phone: null } };

/** A lead visit row the way the lead list select reads it. */
function visitRow(over: Record<string, unknown>) {
  return {
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-28T15:00:00.000Z'),
    scheduled_end: new Date('2026-09-28T16:00:00.000Z'),
    is_all_day: false,
    duration_minutes: 60, completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-09-01T00:00:00.000Z'),
    canceller: null, assignees: [BEN],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  (prisma.estimate.findMany as any).mockResolvedValue([]);
});

async function boardList(visits: unknown[]) {
  mockAuthAs('admin');
  mockPrisma.lead.findMany.mockResolvedValue([{ ...LEAD_FIXTURE, status: 'CONTACTED', visits }]);
  mockPrisma.lead.count.mockResolvedValue(1);
  const res = await request(app)
    .get('/api/leads')
    .set(authHeader('admin'))
    .query({ walkthrough_after: '2026-09-27T00:00:00.000Z', walkthrough_before: '2026-10-04T00:00:00.000Z' });
  expect(res.status).toBe(200);
  return res.body.leads[0];
}

describe('GET /api/leads (the scheduler window) - every live walkthrough visit', () => {
  it('returns both walkthroughs of a lead booked twice in one week, each with its own crew', async () => {
    const lead = await boardList([
      visitRow({ id: 'v-1', visit_seq: 1, assignees: [BEN] }),
      visitRow({
        id: 'v-2', visit_seq: 2,
        scheduled_at: new Date('2026-09-30T15:00:00.000Z'),
        scheduled_end: new Date('2026-09-30T16:30:00.000Z'),
        assignees: [DANA],
      }),
    ]);

    expect(lead.walkthrough_visits).toEqual([
      expect.objectContaining({
        id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: '2026-09-28T15:00:00.000Z', scheduled_end: '2026-09-28T16:00:00.000Z',
        assignees: [BEN],
      }),
      expect.objectContaining({
        id: 'v-2', visit_seq: 2, status: 'SCHEDULED',
        scheduled_at: '2026-09-30T15:00:00.000Z', scheduled_end: '2026-09-30T16:30:00.000Z',
        assignees: [DANA],
      }),
    ]);
  });

  it('a past walkthrough nobody completed does not hide the next one', async () => {
    const lead = await boardList([
      visitRow({ id: 'v-past', visit_seq: 1, scheduled_at: new Date('2026-09-21T15:00:00.000Z'), scheduled_end: new Date('2026-09-21T16:00:00.000Z') }),
      visitRow({ id: 'v-next', visit_seq: 2, scheduled_at: new Date('2026-09-30T15:00:00.000Z'), scheduled_end: new Date('2026-09-30T16:00:00.000Z'), assignees: [DANA] }),
    ]);
    expect(lead.walkthrough_visits.map((v: { id: string }) => v.id)).toEqual(['v-past', 'v-next']);
    // The flat projection is unchanged for its other readers: still the earliest live trip.
    expect(lead.walkthrough_scheduled_at).toBe('2026-09-21T15:00:00.000Z');
  });

  it('keeps a completed walkthrough and drops a cancelled one', async () => {
    const lead = await boardList([
      visitRow({ id: 'v-done', visit_seq: 1, status: 'COMPLETED', completed_at: new Date('2026-09-28T16:00:00.000Z') }),
      visitRow({ id: 'v-cx', visit_seq: 2, status: 'CANCELLED', cancelled_at: new Date('2026-09-29T12:00:00.000Z') }),
      visitRow({ id: 'v-3', visit_seq: 3, scheduled_at: new Date('2026-10-01T15:00:00.000Z'), scheduled_end: null, duration_minutes: 90 }),
    ]);
    expect(lead.walkthrough_visits).toEqual([
      expect.objectContaining({ id: 'v-done', status: 'COMPLETED' }),
      // A row with no stored end ends at its start plus its own duration.
      expect.objectContaining({ id: 'v-3', scheduled_end: '2026-10-01T16:30:00.000Z' }),
    ]);
  });
});

// ─── The per-visit lead doors ─────────────────────────────────────────────────
//
// Dragging, re-crewing or unscheduling ONE walkthrough card must address THAT trip. The legacy
// /walkthrough/* doors act on the lead's CURRENT (earliest live) trip, so dragging the Sep 30 card
// would have moved Sep 28. The visit store below honours every `where` the doors send - id, lead
// and organization - so "the other lead's visit" and "another org's visit" are genuinely absent
// rather than asserted absent.

const LEAD_ID = LEAD_FIXTURE.id;
const OTHER_LEAD_ID = 'e0000000-0000-0000-0000-0000000000c9';
const V1 = '0e000000-0000-4000-8000-000000000001';
const V2 = '0e000000-0000-4000-8000-000000000002';
const V_CANCELLED = '0e000000-0000-4000-8000-000000000003';
const V_DONE = '0e000000-0000-4000-8000-000000000004';
const V_OTHER_LEAD = '0e000000-0000-4000-8000-0000000000c9';
const V_OTHER_ORG = '0e000000-0000-4000-8000-0000000000b2';

const PERFORMER_A = TEST_USERS.technician.id;
const PERFORMER_B = TEST_USERS.dispatcher.id;

type StoredVisit = {
  id: string; lead_id: string; organization_id: string; visit_seq: number; status: string;
  scheduled_at: Date | null; location_id: string | null; customer_email_sent_at: Date | null;
  assignees: { user_id: string }[];
};

function wireVisitStore() {
  const rows: StoredVisit[] = [
    { id: V1, lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID, visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-09-28T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [{ user_id: PERFORMER_A }] },
    { id: V2, lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID, visit_seq: 2, status: 'SCHEDULED', scheduled_at: new Date('2026-09-30T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [{ user_id: PERFORMER_B }] },
    { id: V_CANCELLED, lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID, visit_seq: 3, status: 'CANCELLED', scheduled_at: new Date('2026-10-01T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [] },
    { id: V_DONE, lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID, visit_seq: 4, status: 'COMPLETED', scheduled_at: new Date('2026-09-20T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [] },
    { id: V_OTHER_LEAD, lead_id: OTHER_LEAD_ID, organization_id: ALPHA_ORG_ID, visit_seq: 1, status: 'SCHEDULED', scheduled_at: new Date('2026-09-29T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [] },
    { id: V_OTHER_ORG, lead_id: LEAD_ID, organization_id: ORG_B_ID, visit_seq: 9, status: 'SCHEDULED', scheduled_at: new Date('2026-09-29T15:00:00Z'), location_id: null, customer_email_sent_at: null, assignees: [] },
  ];
  const matches = (r: StoredVisit, where: any = {}) =>
    (where.id === undefined || r.id === where.id)
    && (where.lead_id === undefined || r.lead_id === where.lead_id)
    && (where.organization_id === undefined || r.organization_id === where.organization_id)
    && (where.status?.in === undefined || where.status.in.includes(r.status));
  mockPrisma.visit.findFirst.mockImplementation(async ({ where }: any) => {
    const hits = rows.filter((r) => matches(r, where));
    // findActiveWalkthrough orders by time - the earliest live trip is the legacy doors' target.
    hits.sort((a, b) => (a.scheduled_at?.getTime() ?? 0) - (b.scheduled_at?.getTime() ?? 0));
    return hits[0] ?? null;
  });
  mockPrisma.visit.update.mockImplementation(async ({ where, data }: any) => ({ ...rows.find((r) => r.id === where.id), ...data }));
  // The guarded lifecycle writers (unschedule/cancel) re-test the status in their WHERE; the store
  // applies the write, so a later read - the live-visit count included - sees what it did.
  mockPrisma.visit.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hits = rows.filter((r) => matches(r, where));
    for (const r of hits) Object.assign(r, data);
    return { count: hits.length };
  });
  mockPrisma.visit.count.mockImplementation(async ({ where }: any) => rows.filter((r) => matches(r, where)).length);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visitAssignee.findMany.mockImplementation(async ({ where }: any) =>
    rows.find((r) => r.id === where.visit_id)?.assignees ?? []);
  mockPrisma.visitAssignee.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.visitAssignee.deleteMany.mockResolvedValue({ count: 1 });
  return rows;
}

function wireLeadDoor() {
  mockAuthAs('admin');
  mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  // The status rule reads the lead's status under the row lock: the same row the door loaded.
  mockPrisma.lead.findFirst.mockImplementation((args: unknown) => mockPrisma.lead.findUnique(args));
  mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
}

/** The store the current test's doors read and write (set in each beforeEach). */
let rows: StoredVisit[] = [];
/** Every lead STATUS the doors wrote, in order (transitionLeadStatus writes through updateMany). */
const statusWrites = () =>
  mockPrisma.lead.updateMany.mock.calls.map((c: any[]) => c[0]?.data?.status).filter(Boolean);
const movedIds = () => mockPrisma.visit.update.mock.calls.map((c: any[]) => c[0].where.id);
const dispatched = (type: string) => mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === type);

describe('PATCH /api/leads/:id/visits/:visitId - reschedule ONE walkthrough', () => {
  const body = {
    walkthrough_scheduled_at: '2026-10-02T17:00:00.000Z',
    performer_ids: [PERFORMER_B],
    walkthrough_duration_minutes: 90,
  };

  beforeEach(() => {
    wireVisitStore();
    wireLeadDoor();
  });

  it('moves the named trip and leaves the earlier one where it was', async () => {
    const res = await request(app).patch(`/api/leads/${LEAD_ID}/visits/${V2}`).set(authHeader('admin')).send(body);
    expect(res.status).toBe(200);
    expect(movedIds()).toEqual([V2]);
    const data = mockPrisma.visit.update.mock.calls[0][0].data;
    expect(data.scheduled_at.toISOString()).toBe('2026-10-02T17:00:00.000Z');
    expect(data.scheduled_end.toISOString()).toBe('2026-10-02T18:30:00.000Z');
  });

  it('runs the "walkthrough rescheduled" automation keyed to that trip, at its new time', async () => {
    await request(app).patch(`/api/leads/${LEAD_ID}/visits/${V2}`).set(authHeader('admin')).send(body);
    const [ev] = dispatched('WALKTHROUGH_RESCHEDULED');
    expect(ev).toMatchObject({ visitId: V2, occurrenceKey: '2026-10-02T17:00:00.000Z', entity: { type: 'lead', id: LEAD_ID } });
  });

  it('404s a visit of another lead and a visit of another organization', async () => {
    for (const visitId of [V_OTHER_LEAD, V_OTHER_ORG]) {
      const res = await request(app).patch(`/api/leads/${LEAD_ID}/visits/${visitId}`).set(authHeader('admin')).send(body);
      expect(res.status).toBe(404);
    }
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('409s a cancelled or completed trip rather than bringing it back', async () => {
    for (const visitId of [V_CANCELLED, V_DONE]) {
      const res = await request(app).patch(`/api/leads/${LEAD_ID}/visits/${visitId}`).set(authHeader('admin')).send(body);
      expect(res.status).toBe(409);
    }
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('is gated like /walkthrough/schedule: a technician without schedule_walkthrough is refused', async () => {
    mockAuthAs('technician');
    const res = await request(app).patch(`/api/leads/${LEAD_ID}/visits/${V2}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(403);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('the legacy door still moves the lead\'s earliest live trip', async () => {
    const res = await request(app).post(`/api/leads/${LEAD_ID}/walkthrough/schedule`).set(authHeader('admin')).send(body);
    expect(res.status).toBe(200);
    expect(movedIds()).toEqual([V1]);
  });
});

describe('POST /api/leads/:id/visits/:visitId/performers - re-crew ONE walkthrough', () => {
  beforeEach(() => {
    wireVisitStore();
    wireLeadDoor();
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  });

  it('replaces only the named trip\'s crew, and the notices name that trip', async () => {
    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/visits/${V2}/performers`)
      .set(authHeader('admin'))
      .send({ performer_ids: [PERFORMER_A] });
    expect(res.status).toBe(200);
    const created = mockPrisma.visitAssignee.createMany.mock.calls.flatMap((c: any[]) => c[0].data);
    expect(created).toEqual([expect.objectContaining({ visit_id: V2, user_id: PERFORMER_A })]);
    const deleted = mockPrisma.visitAssignee.deleteMany.mock.calls.map((c: any[]) => c[0].where);
    expect(deleted).toEqual([{ visit_id: V2, user_id: { in: [PERFORMER_B] } }]);
    expect(dispatched('WALKTHROUGH_PERFORMER_ASSIGNED')).toEqual([expect.objectContaining({ visitId: V2, occurrenceKey: PERFORMER_A })]);
    expect(dispatched('WALKTHROUGH_PERFORMER_REMOVED')).toEqual([expect.objectContaining({ visitId: V2, occurrenceKey: PERFORMER_B })]);
  });

  it('404s another lead\'s trip, 409s a cancelled one', async () => {
    const other = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V_OTHER_LEAD}/performers`).set(authHeader('admin')).send({ performer_ids: [] });
    expect(other.status).toBe(404);
    const cancelled = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V_CANCELLED}/performers`).set(authHeader('admin')).send({ performer_ids: [] });
    expect(cancelled.status).toBe(409);
    expect(mockPrisma.visitAssignee.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visitAssignee.deleteMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/visits/:visitId/unschedule - take ONE walkthrough off the board', () => {
  beforeEach(() => {
    rows = wireVisitStore();
    wireLeadDoor();
  });

  it('unschedules the named trip only', async () => {
    const res = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V2}/unschedule`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const writes = mockPrisma.visit.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(writes).toEqual([expect.objectContaining({ where: expect.objectContaining({ id: V2 }), data: expect.objectContaining({ status: 'CANCELLED' }) })]);
  });

  // Conductor ruling on deviation 3: taking ONE walkthrough off the board must not send the lead
  // back to CONTACTED while another walkthrough is still booked - per-visit cards make that the
  // common case. Only when no live walkthrough remains does the lead fall back, as it always did.
  it('with another walkthrough still booked, the lead keeps its status and visit 1 is untouched', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    const res = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V2}/unschedule`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(statusWrites()).toEqual([]);
    expect(rows.find((r) => r.id === V1)).toMatchObject({ status: 'SCHEDULED', scheduled_at: new Date('2026-09-28T15:00:00Z') });

    // ...and the board's lead list still draws visit 1.
    mockPrisma.lead.findMany.mockResolvedValue([{ ...LEAD_FIXTURE, status: 'ESTIMATED', visits: rows.filter((r) => r.lead_id === LEAD_ID && r.organization_id === ALPHA_ORG_ID) }]);
    mockPrisma.lead.count.mockResolvedValue(1);
    const list = await request(app).get('/api/leads').set(authHeader('admin'))
      .query({ walkthrough_after: '2026-09-27T00:00:00.000Z', walkthrough_before: '2026-10-04T00:00:00.000Z' });
    const live = list.body.leads[0].walkthrough_visits.filter((v: { status: string }) => v.status === 'SCHEDULED');
    expect(live.map((v: { id: string }) => v.id)).toEqual([V1]);
  });

  it('unscheduling the LAST booked walkthrough moves the lead only then, and an earlier finished visit makes it Walkthrough Completed', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'WALKTHROUGH_SCHEDULED' });
    await request(app).post(`/api/leads/${LEAD_ID}/visits/${V2}/unschedule`).set(authHeader('admin'));
    expect(statusWrites()).toEqual([]);
    const res = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V1}/unschedule`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    // The store also holds a COMPLETED visit (V_DONE), so the walkthrough is done.
    expect(statusWrites()).toEqual(['WALKTHROUGH_COMPLETED']);
  });

  it('an Estimate Sent lead is not moved when its last booked walkthrough is unscheduled', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    await request(app).post(`/api/leads/${LEAD_ID}/visits/${V2}/unschedule`).set(authHeader('admin'));
    const res = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V1}/unschedule`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(statusWrites()).toEqual([]);
  });

  it('the lead-level /walkthrough/unschedule door follows the same rule', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
    const res = await request(app).post(`/api/leads/${LEAD_ID}/walkthrough/unschedule`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    // It took the lead's CURRENT trip (visit 1); visit 2 is still booked.
    expect(rows.find((r) => r.id === V1)!.status).toBe('CANCELLED');
    expect(statusWrites()).toEqual([]);
  });
});

describe('POST /api/leads/:id/walkthrough/cancel - one of several walkthroughs', () => {
  beforeEach(() => {
    rows = wireVisitStore();
    wireLeadDoor();
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED' });
  });

  it('keeps the lead\'s status while another walkthrough is booked, and the notice names the cancelled trip', async () => {
    const res = await request(app).post(`/api/leads/${LEAD_ID}/walkthrough/cancel`).set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduling' });
    expect(res.status).toBe(200);
    expect(statusWrites()).toEqual([]);
    // Rendered from the trip that was called off, not from the lead's now-current trip (visit 2).
    expect(dispatched('WALKTHROUGH_CANCELLED')).toEqual([expect.objectContaining({ visitId: V1 })]);
  });

  it('cancelling the last booked walkthrough leaves the Estimate Sent lead where it is', async () => {
    rows.find((r) => r.id === V2)!.status = 'COMPLETED';
    await request(app).post(`/api/leads/${LEAD_ID}/walkthrough/cancel`).set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduling' });
    expect(statusWrites()).toEqual([]);
  });

  it('cancelling the last booked walkthrough of a Walkthrough Scheduled lead with a finished visit gives Walkthrough Completed', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'WALKTHROUGH_SCHEDULED' });
    rows.find((r) => r.id === V2)!.status = 'COMPLETED';
    await request(app).post(`/api/leads/${LEAD_ID}/walkthrough/cancel`).set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer rescheduling' });
    expect(statusWrites()).toEqual(['WALKTHROUGH_COMPLETED']);
  });

  it('404s another organization\'s trip, 409s a cancelled one', async () => {
    const other = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V_OTHER_ORG}/unschedule`).set(authHeader('admin'));
    expect(other.status).toBe(404);
    const cancelled = await request(app).post(`/api/leads/${LEAD_ID}/visits/${V_CANCELLED}/unschedule`).set(authHeader('admin'));
    expect(cancelled.status).toBe(409);
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });
});
