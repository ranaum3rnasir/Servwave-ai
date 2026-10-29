/**
 * The crew notices of the per-visit crew door, POST /api/jobs/:id/visits/:visitId/assignees
 * (visits-and-task-categories slice 02, verifier defect D2).
 *
 * The door re-crews ONE trip, so what it tells people has to be about that trip:
 *  (a) the TECH_ASSIGNED / TECH_UNASSIGNED occurrence names the visit, so the email renders that
 *      visit's own date rather than the job's current one;
 *  (b) the occurrence is keyed per visit, so being added to a job's SECOND trip is not swallowed
 *      as a duplicate of the first;
 *  (c) taking someone off one trip while they are still on another live trip of the job is not
 *      "removed from the job": no TECH_UNASSIGNED email, and the in-app notice names the visit.
 *
 * The job-level door (/assignees) is unchanged, and the last case below holds it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { emit } from '../services/notifications/notificationService';
import { renderTemplate } from '../services/notifications/templates';
import { buildDedupeKey } from '../services/automations/dedupe';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

const mockPrisma = prisma as unknown as Record<string, any>;
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const JOB_ID = JOB_FIXTURE.id;
const V1 = 'e0000000-0000-0000-0000-000000000001';
const V2 = 'e0000000-0000-0000-0000-000000000002';
const V3 = 'e0000000-0000-0000-0000-000000000003';
const TECH_A = TEST_USERS.technician.id;
const TECH_B = TEST_USERS.dispatcher.id;
const TECH_C = TEST_USERS.sales.id;

type Trip = { id: string; visit_seq: number; status: string; scheduled_at: Date; crew: string[] };

/**
 * A job with its trips, served to every read the door makes, with a crew store the transaction
 * really writes - so the notices are asserted against what the write did.
 */
function wireJob(trips: Trip[]) {
  const crewOf = new Map(trips.map((t) => [t.id, new Set(t.crew)]));
  const visitsPayload = () =>
    trips.map((t) => ({
      id: t.id,
      visit_seq: t.visit_seq,
      status: t.status,
      scheduled_at: t.scheduled_at,
      scheduled_end: new Date(t.scheduled_at.getTime() + 2 * 3_600_000),
      is_all_day: false,
      created_at: new Date('2026-08-01T00:00:00Z'),
      customer_email_sent_at: null,
      assignees: [...crewOf.get(t.id)!].map((user_id) => ({
        user_id,
        user: { id: user_id, first_name: 'Crew', last_name: 'Member', phone: null },
      })),
    }));
  mockPrisma.job.findUnique.mockImplementation(async () => ({ ...JOB_FIXTURE, status: 'SCHEDULED', visits: visitsPayload() }));
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.visit.findMany.mockImplementation(async () => visitsPayload());
  mockPrisma.visit.findFirst.mockImplementation(async ({ where }: any) => {
    const t = trips.find((x) => x.id === where?.id && where?.job_id === JOB_ID);
    return t ? { ...visitsPayload().find((v) => v.id === t.id) } : null;
  });
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  const visitAssignee = {
    findMany: vi.fn(async ({ where }: any) => [...(crewOf.get(where.visit_id) ?? [])].map((user_id) => ({ user_id }))),
    createMany: vi.fn(async ({ data }: any) => {
      for (const row of Array.isArray(data) ? data : [data]) crewOf.get(row.visit_id)?.add(row.user_id);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      for (const id of where.user_id?.in ?? []) crewOf.get(where.visit_id)?.delete(id);
      return { count: 1 };
    }),
  };
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      visitAssignee,
      visit: { findMany: mockPrisma.visit.findMany },
      job: { findUnique: mockPrisma.job.findUnique },
      timelineEvent: { create: txTimelineCreate },
    }),
  );
}

/** The job timeline the door writes inside its transaction. */
let txTimelineCreate: ReturnType<typeof vi.fn>;
const timeline = (eventType: string) =>
  txTimelineCreate.mock.calls.map((c: any[]) => c[0].data).filter((d: any) => d.event_type === eventType);

const recrew = (visitId: string, assignee_ids: string[]) =>
  request(app)
    .post(`/api/jobs/${JOB_ID}/visits/${visitId}/assignees`)
    .set(authHeader('admin'))
    .send({ assignee_ids });

const dispatched = (type: string) =>
  mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === type);
const emitted = (verb: string) =>
  (emit as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.verb === verb);

// Sep 29 and Sep 30 2026, 09:00 in New York.
const SEP_29 = new Date('2026-09-29T13:00:00Z');
const SEP_30 = new Date('2026-09-30T13:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  txTimelineCreate = vi.fn().mockResolvedValue({});
});

describe('(a) the crew emails name the visit that was re-crewed', () => {
  it('TECH_ASSIGNED carries the visit, so the email renders that visit\'s own date', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [TECH_A] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [] },
    ]);

    expect((await recrew(V2, [TECH_C])).status).toBe(200);

    expect(dispatched('TECH_ASSIGNED').map((e: any) => [e.occurrenceKey, e.visitId])).toEqual([[TECH_C, V2]]);
    // ...and states that visit's own date, not the job's current visit's (Sep 29).
    expect(dispatched('TECH_ASSIGNED')[0].eventPayload.mergeFields['job.scheduled_date']).toBe('Wed, Sep 30');
  });

  it('TECH_UNASSIGNED carries the visit too, when the person is off the job altogether', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [TECH_A] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [TECH_C] },
    ]);

    await recrew(V2, []);

    expect(dispatched('TECH_UNASSIGNED').map((e: any) => [e.occurrenceKey, e.visitId])).toEqual([[TECH_C, V2]]);
    expect(dispatched('TECH_UNASSIGNED')[0].eventPayload.mergeFields['job.scheduled_date']).toBe('Wed, Sep 30');
  });
});

describe('(b) the occurrence is per visit, so a second trip is not swallowed as a duplicate', () => {
  it('adding one person to two trips of the job mints two distinct dedupe keys', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [] },
    ]);

    expect((await recrew(V1, [TECH_C])).status).toBe(200);
    expect((await recrew(V2, [TECH_C])).status).toBe(200);

    const keys = dispatched('TECH_ASSIGNED').map((e: any) =>
      buildDedupeKey('TECH_ASSIGNED', e.entity.id, e.occurrenceKey, e.visitId),
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('(c) off one trip, still on another live trip of the job', () => {
  beforeEach(() => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [TECH_B] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [TECH_B, TECH_C] },
    ]);
  });

  it('sends no "removed from the job" email', async () => {
    expect((await recrew(V2, [TECH_C])).status).toBe(200);

    expect(dispatched('TECH_UNASSIGNED')).toEqual([]);
  });

  it('tells them in-app they were removed from THAT visit, naming it and its date, not the job', async () => {
    await recrew(V2, [TECH_C]);

    const notices = emitted('dispatch.job_unassigned');
    expect(notices).toHaveLength(1);
    expect(notices[0].entity.assignee_ids).toEqual([TECH_B]);
    const { title } = renderTemplate(notices[0].verb, { ...notices[0].data, object_label: notices[0].object.label });
    expect(title).toContain('Visit 2');
    expect(title).toContain('Wed, Sep 30');
    expect(title).not.toMatch(/unassigned from you/);
  });

  it('a person whose only other trip is CANCELLED is off the job: today\'s job-level notices', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'CANCELLED', scheduled_at: SEP_29, crew: [TECH_B] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [TECH_B] },
    ]);

    await recrew(V2, []);

    expect(dispatched('TECH_UNASSIGNED').map((e: any) => e.occurrenceKey)).toEqual([TECH_B]);
    const [notice] = emitted('dispatch.job_unassigned');
    expect(renderTemplate(notice.verb, { ...notice.data, object_label: notice.object.label }).title)
      .toMatch(/unassigned from you/);
  });
});

describe('the job-level door is unchanged', () => {
  it('POST /:id/assignees still dispatches job-keyed occurrences with no visit', async () => {
    wireJob([{ id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [TECH_A] }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_C] });

    expect(res.status).toBe(200);
    expect(dispatched('TECH_ASSIGNED').map((e: any) => e.visitId)).toEqual([undefined]);
    expect(dispatched('TECH_UNASSIGNED').map((e: any) => [e.occurrenceKey, e.visitId])).toEqual([[TECH_A, undefined]]);
  });
});

// Code review #8: the job timeline said "added to job J00001" for somebody who was already on the
// job through a sibling trip - they joined a TRIP, not the job. The entry now names the trip.
describe('(d) the job timeline names the trip when the person was already on the job', () => {
  it('already on another trip: "added to Visit 2 of job ..."; new to the job: "added to job ..."', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'SCHEDULED', scheduled_at: SEP_29, crew: [TECH_A] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [] },
    ]);

    expect((await recrew(V2, [TECH_A, TECH_C])).status).toBe(200);

    const added = timeline('CREW_MEMBER_ADDED').map((d: any) => d.description);
    const nameOf = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`;
    expect(added).toEqual(expect.arrayContaining([
      `${nameOf(TEST_USERS.technician)} added to Visit 2 of job ${JOB_FIXTURE.job_number}`,
      `${nameOf(TEST_USERS.sales)} added to job ${JOB_FIXTURE.job_number}`,
    ]));
    expect(added).toHaveLength(2);
  });

  it('a sibling trip that was cancelled does not count: the person is new to the job', async () => {
    wireJob([
      { id: V1, visit_seq: 1, status: 'CANCELLED', scheduled_at: SEP_29, crew: [TECH_A] },
      { id: V2, visit_seq: 2, status: 'SCHEDULED', scheduled_at: SEP_30, crew: [] },
    ]);

    expect((await recrew(V2, [TECH_A])).status).toBe(200);

    expect(timeline('CREW_MEMBER_ADDED').map((d: any) => d.description)).toEqual([
      `${TEST_USERS.technician.first_name} ${TEST_USERS.technician.last_name} added to job ${JOB_FIXTURE.job_number}`,
    ]);
  });
});
