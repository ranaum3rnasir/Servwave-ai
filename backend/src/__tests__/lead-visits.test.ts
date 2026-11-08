/**
 * Multi-visit spec slice S1 - the tracer bullet.
 *
 * Cycle ordering from the spec's Testing Decisions, hardest-won first:
 *   1. A parent holds multiple live visits at once - the invariant being lifted.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> authorize -> validate
 * -> controller -> service) with Prisma mocked, which is the seam 191 of the backend's 327 test
 * files already use. Nothing here reaches for an internal function's shape, so splitting or
 * renaming the visit service leaves these tests standing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  mockAuthAs, authHeader, LEAD_FIXTURE, TEST_USERS, ALPHA_ORG_ID,
  withLeadStatusSync,
} from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
// The whole lib/email module is mocked globally in setup.ts - these are those vi.fn()s.
import { sendWalkthroughScheduledEmail, sendWalkthroughRescheduledEmail } from '../lib/email';

const mockPrisma = prisma as unknown as Record<string, any>;
const mockWtScheduled = sendWalkthroughScheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockWtRescheduled = sendWalkthroughRescheduledEmail as unknown as ReturnType<typeof vi.fn>;

const EXISTING_VISIT = {
  id: 'v0000000-0000-0000-0000-000000000001',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  job_id: null,
  purpose: 'WALKTHROUGH',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-09-01T14:00:00Z'),
  duration_minutes: 60,
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

function wireVisitTx() {
  mockPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn(withLeadStatusSync({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        // The seq allocator reads MAX(visit_seq) through `tx`, never the module-level client -
        // see the "allocated inside the transaction" block below for why that is load-bearing.
        // Delegating to the same vi.fn() keeps every existing `visit.aggregate` expectation valid.
        aggregate: mockPrisma.visit.aggregate,
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // Spec #1751 D2: the walkthrough booking clock is a CONDITIONAL write of its own
      // (stampLeadClock -> lead.updateMany), so a double wiring only `update` 500s the door.
      lead: { update: vi.fn().mockResolvedValue(LEAD_FIXTURE), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

describe('POST /api/leads/:id/visits - a lead holds several live visits (S1)', () => {
  beforeEach(() => {
    // Call history accumulates across tests otherwise, so `create.mock.calls[0]` would read the
    // PREVIOUS test's write and every seq assertion would pass or fail for the wrong reason.
    vi.clearAllMocks();
    // mockAuthAs installs a user.findUnique implementation that also resolves the caller's
    // ORGANIZATION - overriding it here would drop the org to STARTER and 402 the whole router.
    // It resolves any TEST_USERS id, which is what validatePerformers needs too.
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.job.findMany.mockResolvedValue([]);
    wireVisitTx();
  });

  it('books a SECOND live visit while the first stays scheduled, instead of overwriting it', async () => {
    // The lead already holds one live visit - the exact state the old one-active-row rule made
    // unreachable, because scheduling always reused that row.
    mockPrisma.visit.findMany.mockResolvedValue([EXISTING_VISIT]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-2', visit_seq: 2 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 90,
        assignee_ids: [TEST_USERS.technician.id],
      });

    expect(res.status).toBe(201);

    // The load-bearing assertion: a NEW row was written...
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    // ...and the visit already on the lead was never touched.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();

    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.lead_id).toBe(LEAD_FIXTURE.id);
    expect(created.data.job_id).toBeUndefined();
    expect(created.data.purpose).toBe('WALKTHROUGH');
    expect(created.data.status).toBe('SCHEDULED');
  });

  it('numbers the new visit in creation order, so an existing "Visit 1" keeps its label', async () => {
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-2', visit_seq: 2 });

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 60, assignee_ids: [] });

    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.visit_seq).toBe(2);
  });

  it('numbers past a CANCELLED visit rather than reusing its number', async () => {
    // D13/D19: cancelled rows are kept as history, and the customer may hold an email naming
    // "Visit 2" - so seq 2 must never be handed to a different trip.
    // MAX(visit_seq) = 2, contributed by the CANCELLED row - it keeps its number.
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 2 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-3', visit_seq: 3 });

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-06T14:00:00Z', duration_minutes: 60, assignee_ids: [] });

    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.visit_seq).toBe(3);
  });

  it('gives a lead with no visits yet the first number', async () => {
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, visit_seq: 1 });

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 60, assignee_ids: [] });

    const created = mockPrisma.visit.create.mock.calls[0][0];
    expect(created.data.visit_seq).toBe(1);
  });
});

/**
 * Multi-visit S3, the lead-side twin of the job-side crew-conflict guard.
 *
 * detectPerformerConflicts excludes THIS lead's own visits with `lead_id: { not: leadId }` and
 * then names the lead of every survivor. On Prisma 6 a `not` predicate on a nullable column keeps
 * NULL rows, so a job-parented visit (D5: no lead) passes that filter - and until S3 job visits
 * carried no crew, so `assignees.some` could never match one. Crew per visit makes it reachable
 * on the ordinary daily flow, and the dereference turns D21's advisory 409 into a 500.
 *
 * The mock HONOURS its where, with a job-parented decoy AND a same-lead decoy seeded, because the
 * behaviour under test lives entirely in the predicate.
 */
describe('POST /api/leads/:id/visits - a performer on a job visit warns, and never crashes', () => {
  const OTHER_LEAD_ID = 'l0000000-0000-0000-0000-0000000000e1';
  const JOB_VISIT_ID = 'v0000000-0000-0000-0000-0000000000e9';

  type SeedVisit = {
    id: string;
    lead_id: string | null;
    lead: { id: string; lead_number: string } | null;
    scheduled_at: string;
    user_ids: string[];
  };

  function seedConflictVisits(seed: SeedVisit[]) {
    mockPrisma.visit.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      // Only the conflict detector filters by crew; the seq/list reads on this path are
      // lead-scoped and must get nothing seeded, or they would renumber off the decoys.
      if (!where.assignees) return [];
      const wanted: string[] = where.assignees.some?.user_id?.in ?? [];
      return seed
        .filter((v) => v.user_ids.some((u) => wanted.includes(u)))
        .filter((v) => {
          const p = where.lead_id;
          // `{ not: <id> }` keeps NULLs, exactly as Prisma does on a nullable column - that
          // fidelity is the whole point of this fixture.
          if (p && 'not' in p) return p.not === null ? v.lead_id !== null : v.lead_id !== p.not;
          return true;
        })
        .filter((v) => {
          const nested = where.NOT?.lead_id;
          return nested === undefined ? true : v.lead_id !== nested;
        })
        .map((v) => ({
          id: v.id,
          scheduled_at: new Date(v.scheduled_at),
          duration_minutes: 60,
          lead: v.lead,
        }));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-new', visit_seq: 2 });
    wireVisitTx();
  });

  it('books the visit when the only overlap is a job-parented visit the performer is crewed on', async () => {
    seedConflictVisits([
      // The job visit: crewed with the performer, inside the requested window, no lead at all.
      { id: JOB_VISIT_ID, lead_id: null, lead: null, scheduled_at: '2026-09-04T14:15:00Z', user_ids: [TEST_USERS.technician.id] },
      // The same lead's own other visit - already excluded, and it must stay excluded.
      {
        id: 'v0000000-0000-0000-0000-0000000000e2',
        lead_id: LEAD_FIXTURE.id,
        lead: { id: LEAD_FIXTURE.id, lead_number: 'L00009' },
        scheduled_at: '2026-09-04T14:30:00Z',
        user_ids: [TEST_USERS.technician.id],
      },
    ]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 90,
        assignee_ids: [TEST_USERS.technician.id],
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
  });

  it('still warns about a genuine clash on a DIFFERENT lead, alongside the job visit', async () => {
    seedConflictVisits([
      { id: JOB_VISIT_ID, lead_id: null, lead: null, scheduled_at: '2026-09-04T14:15:00Z', user_ids: [TEST_USERS.technician.id] },
      {
        id: 'v0000000-0000-0000-0000-0000000000e3',
        lead_id: OTHER_LEAD_ID,
        lead: { id: OTHER_LEAD_ID, lead_number: 'L00042' },
        scheduled_at: '2026-09-04T14:30:00Z',
        user_ids: [TEST_USERS.technician.id],
      },
    ]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 90,
        assignee_ids: [TEST_USERS.technician.id],
      });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({ type: 'walkthrough', id: OTHER_LEAD_ID, number: 'L00042' });
  });
});

// ─── Multi-visit close-out - detectPerformerConflicts reads the job's VISITS, not its mirror ──
// The job arm used to match against Job.scheduled_start/scheduled_end, which by D14 only ever
// holds the job's NEXT upcoming visit - so booking a lead walkthrough against a technician busy on
// that job's SECOND or THIRD trip (a window the mirror does not hold) silently produced no
// conflict. Repointed onto the visits relation, mirroring job.controller.ts's detectCrewConflicts.
describe('POST /api/leads/:id/visits - the job arm reads the VISIT window, not the job mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.findMany.mockResolvedValue([]);
    // Overrides the PRECEDING describe block's `seedConflictVisits` mockImplementation on this
    // same delegate - vi.clearAllMocks() wipes call history but not implementations, so without
    // this a leaked walkthrough fixture from the last test that ran there bleeds into this one's
    // conflicts array.
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-new', visit_seq: 2 });
    wireVisitTx();
  });

  it('clashes against a job\'s SECOND visit - a window the Job.scheduled_start mirror never held', async () => {
    mockPrisma.job.findMany.mockResolvedValueOnce([{
      id: 'j-other-1',
      job_number: 'J00077',
      // The production select no longer reads Job.scheduled_start/scheduled_end at all - only the
      // nested, overlap-filtered `visits` array (this job's SECOND trip, the one actually
      // clashing) feeds the entry below.
      visits: [{ id: 'v-job-2', scheduled_at: new Date('2026-09-04T14:15:00Z'), scheduled_end: new Date('2026-09-04T15:15:00Z') }],
    }]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 90,
        assignee_ids: [TEST_USERS.technician.id],
      });

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({
      type: 'job',
      id: 'j-other-1',
      number: 'J00077',
      start: '2026-09-04T14:15:00.000Z',
      end: '2026-09-04T15:15:00.000Z',
    });
  });
});

// ─── S7 / B7 (D3 - a visit is a visit) ───────────────────────────────────────
// The lead visit route takes the SAME nested notify object the three job-visit routes now take,
// and routes through the SAME sender the legacy walkthrough door uses. Not a lead-side fork.
describe('POST /api/leads/:id/visits - per-visit customer email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([EXISTING_VISIT]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    // The fake HONOURS the write, so an assertion comparing the send against the persisted row
    // cannot pass by coincidence.
    mockPrisma.visit.create.mockImplementation(async (args: any) => ({
      ...EXISTING_VISIT,
      id: 'v0000000-0000-0000-0000-0000000000e2',
      ...args.data,
    }));
    mockWtScheduled.mockResolvedValue({ status: 'sent' });
    wireVisitTx();
  });

  function book(body: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 90, ...body });
  }

  it('mails the trip it just wrote and stamps the row once the send has gone', async () => {
    const res = await book({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(mockWtScheduled).toHaveBeenCalledTimes(1);
    const sent = mockWtScheduled.mock.calls[0][0];
    const written = mockPrisma.visit.create.mock.calls[0][0].data;

    expect(written.visit_seq).toBe(2);
    expect(sent.visitSeq).toBe(written.visit_seq);
    expect(sent.scheduledDate).toBe(written.scheduled_at);
    expect(sent.to).toBe(LEAD_FIXTURE.customer.email);
    // The emailed row IS the stamped row: the stamp is scoped to the id the transaction
    // returned, and only lands because the send above actually went.
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledTimes(1);
    const stamp = mockPrisma.visit.updateMany.mock.calls[0][0];
    expect(stamp.where).toMatchObject({ id: res.body.visit.id, organization_id: ALPHA_ORG_ID });
    expect(stamp.data.customer_email_sent_at).toBeInstanceOf(Date);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('a send that never left does not stamp the row as announced', async () => {
    // The composer invites exactly this: "No email address on file - type one below to send".
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      customer: { ...LEAD_FIXTURE.customer, email: null },
    });

    const res = await book({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(res.body.notify).toEqual({ status: 'skipped', reason: 'no_recipient' });
    // The flag means "the customer WAS told about this trip". Written on the intent instead of
    // the outcome, the lead's visits card reports a notification nobody received.
    const stamps = [
      ...mockPrisma.visit.create.mock.calls,
      ...mockPrisma.visit.update.mock.calls,
      ...mockPrisma.visit.updateMany.mock.calls,
    ].map((c: any[]) => c[0]?.data?.customer_email_sent_at).filter((v: unknown) => v !== undefined);
    expect(stamps).toEqual([]);
  });

  it('notify omitted sends nothing and still writes the timeline row', async () => {
    const res = await book();

    expect(res.status).toBe(201);
    expect(mockWtScheduled).not.toHaveBeenCalled();
    expect(mockWtRescheduled).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create.mock.calls[0][0].data.customer_email_sent_at).toBeUndefined();
  });

  it('the legacy walkthrough door is untouched: it still takes FLAT notify keys and sends', async () => {
    // send_email is a DIFFERENT, older flag on that endpoint - it gates the whole automation
    // block including the internal performer notices. The two must not be conflated.
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({
        walkthrough_scheduled_at: '2026-09-04T14:00:00Z',
        performer_ids: [TEST_USERS.technician.id],
        notify_customer: true,
      });

    expect(res.status).toBe(200);
    expect(mockWtScheduled).toHaveBeenCalledTimes(1);
    // The legacy door names no trip - byte-identical copy to what it has always sent.
    expect(mockWtScheduled.mock.calls[0][0].visitSeq).toBeUndefined();
  });
});

// ─── Row scope on the nested visit collection ────────────────────────────────
// Both route gates here are SUBJECT-level (`canDo('read'|'schedule_walkthrough','Lead')`), and
// both of those grants are CONDITIONAL for the roles that hold them - SALES books walkthroughs on
// OWN_LEAD, TECHNICIAN reads leads on OWN_WALKTHROUGH. Without a per-instance check the nested
// collection is strictly weaker than the row it hangs off: GET /api/leads/:id and the sibling
// /walkthrough/schedule door both 403 the same caller on the same lead.
describe('a lead visit route is no weaker than the lead it hangs off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([EXISTING_VISIT]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-2', visit_seq: 2 });
    mockWtScheduled.mockResolvedValue({ status: 'sent' });
    wireVisitTx();
    // The tenant probe FINDS the lead - it really is in this org. The row-scope probe does not:
    // this caller is not on it.
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.findFirst.mockResolvedValue(null);
  });

  it('403s a salesperson booking a visit on a lead that is not theirs, and mails nobody', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('sales'))
      .send({
        scheduled_at: '2026-09-04T14:00:00Z',
        duration_minutes: 60,
        assignee_ids: [],
        notify: { notify_customer: true, notify_recipient_email: 'attacker@example.test' },
      });

    expect(res.status).toBe(403);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    // The write being refused is only half of it: this door now sends customer mail from the
    // org's own sending domain, to an address the request chose.
    expect(mockWtScheduled).not.toHaveBeenCalled();
  });

  it('403s a technician listing the visits of a lead that is not theirs', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.visits).toBeUndefined();
  });
});

/**
 * The lead-side visit number must be allocated on the TRANSACTION client.
 *
 * `nextVisitSeqForLead` reached for the module-level `prisma` from inside
 * `prisma.$transaction(async (tx) => ...)`. With DB_TENANT_GUARD=on that global is the
 * tenant-guard Proxy, and every one of its model ops opens a transaction of its own - so the
 * aggregate asked the pool for a SECOND connection while the outer interactive transaction was
 * still holding the first. On a roomy pool it gets one and nobody notices. On the deployed
 * staging service it does not, and the request dies with Prisma P2024 after the pool timeout:
 *
 *   P2024 Timed out fetching a new connection from the connection pool
 *     at nextVisitSeqForLead (services/walkthrough.service.ts)
 *     at createVisit (controllers/lead.controller.ts)
 *
 * Every route that books a lead walkthrough was a 500 - the API, the legacy door and the
 * Walkthrough tab alike - while the job-side twin was fine, because `nextVisitSeqForJob` takes
 * `tx`. The job allocator's own docstring had already named this as the lead side's outstanding
 * follow-up; it was a deadlock as well as the race it predicted.
 *
 * These tests pin the shape rather than the symptom, because the suite mocks Prisma and a mock
 * pool never runs dry: the allocation must be visible on the transaction client, and the request
 * must survive the global client being unable to serve it at all.
 */
describe('POST /api/leads/:id/visits - the visit number is allocated inside the transaction', () => {
  let txAggregate: ReturnType<typeof vi.fn>;

  function wireTxWithAggregate() {
    txAggregate = vi.fn().mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn(withLeadStatusSync({
        visit: {
          create: mockPrisma.visit.create,
          update: mockPrisma.visit.update,
          findMany: mockPrisma.visit.findMany,
          aggregate: txAggregate,
        },
        visitAssignee: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        // Spec #1751 D2: the walkthrough booking clock is a CONDITIONAL write of its own
        // (stampLeadClock -> lead.updateMany), so a double wiring only `update` 500s the door.
        lead: { update: vi.fn().mockResolvedValue(LEAD_FIXTURE), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      })),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([EXISTING_VISIT]);
    mockPrisma.visit.create.mockResolvedValue({ ...EXISTING_VISIT, id: 'v-2', visit_seq: 2 });
    wireTxWithAggregate();
  });

  it('reads MAX(visit_seq) through the transaction client, never the module-level one', async () => {
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 60, assignee_ids: [] });

    expect(res.status).toBe(201);
    // The allocation happened on `tx`...
    expect(txAggregate).toHaveBeenCalledTimes(1);
    // ...and the global client was never asked for a second connection mid-transaction.
    expect(mockPrisma.visit.aggregate).not.toHaveBeenCalled();
  });

  it('still books the visit when the global client cannot hand out a connection', async () => {
    // Exactly what the guarded global does on a saturated pool. If the allocator still reaches
    // for it, this rejection is the deployed 500 reproduced in-process.
    const poolExhausted = Object.assign(
      new Error('Timed out fetching a new connection from the connection pool'),
      { code: 'P2024', name: 'PrismaClientKnownRequestError' },
    );
    mockPrisma.visit.aggregate.mockRejectedValue(poolExhausted);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 60, assignee_ids: [] });

    expect(res.status).toBe(201);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visit.create.mock.calls[0][0].data.visit_seq).toBe(2);
  });
});
