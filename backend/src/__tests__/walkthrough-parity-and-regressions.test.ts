/**
 * Scoped assignee pool, slice 5 — PARITY WITH A DISPATCHER, AND PROOF NOTHING ELSE MOVED.
 * Plan: md_files/plans/permissions/2026-08-31-assignee-pool/05-lifecycle-holds-for-a-rep.md
 *
 * Companion to walkthrough-rep-lifecycle.test.ts, which asserts the rep's own lifecycle. This
 * file asserts the two claims that sit either side of it:
 *
 *   A. THE REP'S EXPERIENCE MATCHES A DISPATCHER'S on everything except naming other people —
 *      the conflict warning, the force override, the customer notification, the internal notices.
 *   B. NOTHING ELSE MOVED — a dispatcher still books on leads they are NOT assigned to, an
 *      admin is unchanged end to end, and the job crew picker is what it was for dispatchers
 *      and technicians.
 *
 * Every one of these is OUT OF SCOPE TO CHANGE. This file only pins them.
 *
 * ── HOW PARITY IS ASSERTED, AND WHY IT IS NOT A TAUTOLOGY ───────────────────────────────────
 *
 * "The customer's experience does not depend on who scheduled it" is a statement about TWO
 * runs, so it is asserted as one: `bookAs('sales')` and `bookAs('dispatcher')` execute the SAME
 * request against the SAME fixtures, and the outcomes are compared for EQUALITY after the actor
 * id is stripped. A one-sided assertion ("the rep gets a 409 too") cannot see a dispatcher whose
 * behaviour drifted; an equality can.
 *
 * ⚠️ THE TRAP IN AN EQUALITY IS THAT TWO EMPTIES ARE EQUAL. Every parity case therefore carries
 * a NON-VACUITY assertion first — the automation really fired, with this type, this entity and
 * this occurrence key; the email really went, to this address — and only then compares the two
 * runs. Verified by mutation: suppressing the automation block entirely leaves the equalities
 * green and reddens exactly the non-vacuity assertions, which is what they are for.
 *
 * ── NOTHING HERE CAN SEND A REAL EMAIL ──────────────────────────────────────────────────────
 *
 * Demo-org email is genuinely routable — real inboxes receive it. `../lib/email` and
 * `../services/automations/dispatch` are BOTH mocked globally in setup.ts, so the two customer
 * paths are asserted at their seams (`sendWalkthroughScheduledEmail`, `dispatchAutomationEvent`)
 * and no transport is reachable from this file. `emit` — the in-app internal notice — is mocked
 * locally for the same reason the job-crew suite mocks it: left real it writes through prisma
 * inside a swallow-everything try/catch, so it can neither be asserted nor be trusted to fail.
 *
 * ── THE ROW-SCOPE MOCKS ARE HONEST EVEN WHERE THEY ARE NOT CONSULTED ────────────────────────
 *
 * `canAccessRow` SHORT-CIRCUITS on an empty scope fragment (enforce.ts), and DISPATCHER's and
 * ADMIN's `read Lead` are unconditioned today — so their per-instance check never reaches
 * `lead.findFirst` at all. It is still wired through `mockScopedFindFirst` against a lead whose
 * assignee is the REP, never a blanket `mockResolvedValue({ id })`. The moment a condition is
 * added to DISPATCHER's `read Lead`, that fragment starts being evaluated for real, stops
 * matching this lead, and every case in Part B goes red — which is precisely the regression the
 * plan calls "the most likely thing to have broken". A blanket stub would sleep through it.
 *
 * DATES ARE COMPUTED FROM `Date.now()`. A fixture pinned to a wall-clock instant silently
 * changes which branch it exercises once that instant elapses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  ALPHA_ORG_ID,
  LEAD_FIXTURE,
  JOB_FIXTURE,
  mockAuthAs,
  authHeader,
  mockScopedFindFirst,
  mockRoleGrantsWithout,
  type TestUserKey,
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { sendWalkthroughScheduledEmail } from '../lib/email';
import { emit } from '../services/notifications/notificationService';

// The in-app internal notice. Real, it swallows every error by design (notificationService.ts
// step 2), so against a mocked prisma it neither writes nor complains — unmockable AND
// unassertable at once. Mocked here it becomes the seam "an internal notice was raised".
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue([]),
}));

const mockPrisma = prisma as unknown as Record<string, any>;
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;
const mockCustomerEmail = sendWalkthroughScheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockEmit = emit as unknown as ReturnType<typeof vi.fn>;

const REP = TEST_USERS.sales;
const DISPATCHER = TEST_USERS.dispatcher;
const ADMIN = TEST_USERS.admin;
/** An active, assignable, in-org user who is neither the rep nor the booker. */
const COLLEAGUE = TEST_USERS.technician;

const ROW_REFUSAL = 'Insufficient permissions';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.now();
const BOOKED_AT = new Date(NOW + 7 * DAY);
const SECOND_VISIT_AT = new Date(NOW + 9 * DAY);

const LEAD_URL = `/api/leads/${LEAD_FIXTURE.id}`;
const ACTIVE_VISIT_ID = 'v0000000-0000-0000-0000-0000000000b1';
/** A different lead entirely — the one the clash below lives on. */
const OTHER_LEAD = { id: 'e0000000-0000-0000-0000-0000000000fe', lead_number: 'L00099' };

/**
 * THE LEAD IN EVERY CASE BELOW: assigned to the REP and to nobody else. That single fixture is
 * what makes this file's two halves the same experiment — for the rep it is "their own lead",
 * and for the dispatcher and the admin it is "a lead they are not assigned to".
 */
function repsLead(status = 'CONTACTED') {
  return {
    ...LEAD_FIXTURE,
    status,
    organization_id: ALPHA_ORG_ID,
    commission_owner_id: REP.id,
    lead_assignees: [{ user_id: REP.id }],
  };
}

/** The lead's live walkthrough, as `findActiveWalkthrough` returns it. */
function liveVisit(crew: string[] = [REP.id]) {
  return {
    id: ACTIVE_VISIT_ID,
    organization_id: ALPHA_ORG_ID,
    lead_id: LEAD_FIXTURE.id,
    job_id: null,
    purpose: 'WALKTHROUGH',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: BOOKED_AT,
    scheduled_end: new Date(BOOKED_AT.getTime() + 60 * MINUTE),
    duration_minutes: 60,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    assignees: crew.map((user_id) => ({ user_id })),
  };
}

let txVisitAssignee: {
  findMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
let txVisitUpdateMany: ReturnType<typeof vi.fn>;

/** The union of the delegates the five lead doors reach for inside `$transaction`. */
function wireTx() {
  txVisitAssignee = {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  txVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        updateMany: txVisitUpdateMany,
        findMany: mockPrisma.visit.findMany,
        aggregate: mockPrisma.visit.aggregate,
        // Unschedule/cancel ask "is another walkthrough still booked?" before reverting the lead
        // (visits slice 03). Unset here = none, so these doors revert exactly as they always did.
        count: mockPrisma.visit.count,
      },
      visitAssignee: txVisitAssignee,
      lead: {
        update: mockPrisma.lead.update,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: mockPrisma.lead.findUnique,
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // The lead row lock the "still booked?" count takes first (fix pass, code review #1).
      $executeRaw: vi.fn().mockResolvedValue(1),
    })),
  );
}

/**
 * The whole world, identical on every run. Called AFTER `signIn` so its `visit.aggregate` and
 * `user.findUnique` wiring is the one in force (mockAuthAs installs its own defaults for both).
 */
function wireWorld(leadRow: Record<string, unknown> = repsLead()) {
  mockPrisma.lead.findUnique.mockResolvedValue(leadRow);
  mockPrisma.lead.update.mockResolvedValue(leadRow);
  // Honest, not blanket — see the file header.
  mockScopedFindFirst(mockPrisma.lead.findFirst, leadRow);
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  // Conflict detection's two parallel reads. Empty = nobody is double-booked.
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
  mockPrisma.visit.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...liveVisit([]), id: 'v-new', ...data }),
  );
  mockPrisma.visit.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ ...liveVisit([]), id: where.id, ...data }),
  );
  mockPrisma.visit.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  // The customer notice reads the org row for its timezone and wordmark. Stubbed identically for
  // every actor, so a difference in the rendered email could only come from the actor.
  mockPrisma.organization.findUnique.mockResolvedValue({
    name: 'Northwind Services', logo_url: null, brand_color: null, timezone: 'America/Chicago',
  });
  wireTx();
}

/** Sign in, with grants answered PER ROLE so one role's rows are never handed to another. */
function signIn(who: TestUserKey) {
  mockAuthAs(who);
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  clearPermissionCache();
}

/** The automation events raised by the request just made, oldest first. */
const automations = () =>
  (mockDispatch.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
/** The in-app internal notices raised by the request just made. */
const notices = () =>
  (mockEmit.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
/** The customer emails sent directly by the request just made. */
const customerEmails = () =>
  (mockCustomerEmail.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);

/** Strip the one field that is ALLOWED to differ between two actors doing the same thing. */
const withoutActor = (events: Record<string, unknown>[]) =>
  events.map(({ actorId, ...rest }) => rest);

/**
 * One booking, from a clean world. `pre` runs after the fixtures are laid down, so a case can
 * change exactly one thing (a clash, a live visit) and leave everything else identical.
 */
async function bookAs(
  who: TestUserKey,
  body: Record<string, unknown> = {},
  pre: () => void = () => {},
) {
  vi.clearAllMocks();
  clearPermissionCache();
  signIn(who);
  wireWorld();
  pre();
  const res = await request(app)
    .post(`${LEAD_URL}/walkthrough/schedule`)
    .set(authHeader(who))
    .send({
      walkthrough_scheduled_at: BOOKED_AT.toISOString(),
      performer_ids: [REP.id],
      walkthrough_duration_minutes: 60,
      ...body,
    });
  return { res, automations: automations(), notices: notices(), emails: customerEmails() };
}

/** The one clash both actors are shown: the REP is already out on another lead's walkthrough. */
const repIsAlreadyBusy = () => {
  mockPrisma.visit.findMany.mockResolvedValue([
    { id: 'v-other', scheduled_at: BOOKED_AT, duration_minutes: 60, lead: OTHER_LEAD },
  ]);
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PART A — the rep's experience matches a dispatcher's
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the customer notification does not depend on who scheduled it (stories 11, 34)', () => {
  it('raises the SAME customer-facing automation, whoever booked', async () => {
    const rep = await bookAs('sales');
    const dispatcher = await bookAs('dispatcher');

    expect(rep.res.status).toBe(200);
    expect(dispatcher.res.status).toBe(200);

    // NON-VACUITY FIRST. Two runs that both notified nobody would satisfy the equality below,
    // so the customer-facing event is named, counted and read here before anything is compared.
    const repCustomerCopy = rep.automations.filter((e) => e.type === 'WALKTHROUGH_SCHEDULED');
    expect(repCustomerCopy).toHaveLength(1);
    expect(repCustomerCopy[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      // Keyed on the slot, which is what makes a repeated save idempotent for the customer.
      occurrenceKey: BOOKED_AT.toISOString(),
      actorId: REP.id,
    });

    // …and now the parity claim itself: same events, same order, same payloads.
    expect(withoutActor(rep.automations)).toEqual(withoutActor(dispatcher.automations));
    // The actor is the ONLY difference, and it really is populated on both sides — a handler
    // that stopped recording who booked would pass the equality above with two nulls.
    expect(rep.automations.map((e) => e.actorId)).toEqual([REP.id, REP.id]);
    expect(dispatcher.automations.map((e) => e.actorId)).toEqual([DISPATCHER.id, DISPATCHER.id]);
  });

  it('sends the customer the SAME email on the direct-send path, whoever booked', async () => {
    // `notify_customer: true` is the explicit tick, which sends immediately instead of through
    // the workflow engine. It is the path a rep is most likely to use, and the one where an
    // actor could leak into what the customer reads.
    const rep = await bookAs('sales', { notify_customer: true });
    const dispatcher = await bookAs('dispatcher', { notify_customer: true });

    expect(rep.emails).toHaveLength(1);
    expect(rep.emails[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      to: LEAD_FIXTURE.customer.email,
      customerName: 'John Doe',
      // The PERFORMER is named to the customer, never the booker. Both runs name the rep
      // because both booked the rep, which is the point: the customer is told who is coming.
      performerName: 'Test Sales',
      companyName: 'Northwind Services',
      timezone: 'America/Chicago',
      scheduledDate: BOOKED_AT,
    });

    // Not "equal apart from the actor" — EQUAL. The customer's email carries no actor at all,
    // and this is the assertion that says so.
    expect(rep.emails).toEqual(dispatcher.emails);
    expect(rep.res.body.notify).toEqual({ status: 'sent' });
    expect(dispatcher.res.body.notify).toEqual({ status: 'sent' });
  });

  it('stamps the trip as announced, and suppresses the workflow copy, whoever booked', async () => {
    // The other half of the direct send: the customer must not be mailed twice for one action,
    // and the trip must record that it was announced. Both are outcomes of the SEND, so an
    // actor-dependent stamp would be a customer-visible difference on the NEXT booking.
    const rep = await bookAs('sales', { notify_customer: true });
    const repStamps = (mockPrisma.visit.updateMany.mock.calls as unknown[][]).map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const dispatcher = await bookAs('dispatcher', { notify_customer: true });
    const dispatcherStamps = (mockPrisma.visit.updateMany.mock.calls as unknown[][]).map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );

    expect(repStamps).toHaveLength(1);
    expect(repStamps[0].customer_email_sent_at).toBeInstanceOf(Date);
    expect(dispatcherStamps).toHaveLength(1);
    expect(dispatcherStamps[0].customer_email_sent_at).toBeInstanceOf(Date);

    // The explicit tick suppresses the workflow's own customer copy for this occurrence, for
    // both actors. The internal performer notice is a different audience and survives — asserted
    // by the length, which would be 0 if the whole block had been suppressed instead.
    expect(rep.automations.map((e) => e.type)).toEqual(['WALKTHROUGH_PERFORMER_ASSIGNED']);
    expect(dispatcher.automations.map((e) => e.type)).toEqual(['WALKTHROUGH_PERFORMER_ASSIGNED']);
  });
});

describe('internal notices fire as they do today (story 34)', () => {
  it('raises the SAME performer notice, whoever booked', async () => {
    const rep = await bookAs('sales');
    const dispatcher = await bookAs('dispatcher');

    const repAssigned = rep.automations.filter((e) => e.type === 'WALKTHROUGH_PERFORMER_ASSIGNED');
    expect(repAssigned).toHaveLength(1);
    expect(repAssigned[0]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      entity: { type: 'lead', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      // Keyed per PERSON, so adding a second performer later notifies only the addition.
      occurrenceKey: REP.id,
      // The notice carries the person being told, resolved through the performer validator.
      eventPayload: { recipient: expect.objectContaining({ id: REP.id }) },
    });

    expect(withoutActor(repAssigned)).toEqual(
      withoutActor(dispatcher.automations.filter((e) => e.type === 'WALKTHROUGH_PERFORMER_ASSIGNED')),
    );
  });

  it('raises the SAME in-app notice, whoever booked', async () => {
    const rep = await bookAs('sales');
    const dispatcher = await bookAs('dispatcher');

    expect(rep.notices).toHaveLength(1);
    expect(rep.notices[0]).toMatchObject({
      verb: 'lead.walkthrough_scheduled',
      organizationId: ALPHA_ORG_ID,
      object: { type: 'LEAD', id: LEAD_FIXTURE.id, label: LEAD_FIXTURE.lead_number },
      entity: { performer_ids: [REP.id], commission_owner_id: REP.id },
      actorId: REP.id,
    });

    // Identical apart from the actor — which the recipient resolver downstream reads precisely
    // so the person who did the thing is not notified about it. Same notice, different reader.
    expect(withoutActor(rep.notices)).toEqual(withoutActor(dispatcher.notices));
    expect(dispatcher.notices[0].actorId).toBe(DISPATCHER.id);
  });
});

describe('the double-booking warning and its override are the dispatcher\'s (stories 9, 10)', () => {
  it('warns BOTH with the same 409 and the same conflict list', async () => {
    const rep = await bookAs('sales', {}, repIsAlreadyBusy);
    const dispatcher = await bookAs('dispatcher', {}, repIsAlreadyBusy);

    expect(rep.res.status).toBe(409);
    expect(dispatcher.res.status).toBe(409);
    // Non-vacuity: there really is a conflict in there, and it names the OTHER lead the rep is
    // out on. A detector that returned [] would answer 200 and never reach this assertion.
    expect(rep.res.body.conflicts).toEqual([
      {
        type: 'walkthrough',
        id: OTHER_LEAD.id,
        number: OTHER_LEAD.lead_number,
        start: BOOKED_AT.toISOString(),
        end: new Date(BOOKED_AT.getTime() + 60 * MINUTE).toISOString(),
      },
    ]);
    // The whole envelope, not just the status: the FE retry path reads `conflicts` verbatim.
    expect(rep.res.body).toEqual(dispatcher.res.body);

    // A warning is not a booking. Neither actor wrote, and neither told the customer anything —
    // a 409 that had already dispatched would be a customer-visible difference of the worst kind.
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(rep.automations).toEqual([]);
    expect(dispatcher.automations).toEqual([]);
  });

  it('lets BOTH override it with force and book anyway', async () => {
    const rep = await bookAs('sales', { force: true }, repIsAlreadyBusy);
    const dispatcher = await bookAs('dispatcher', { force: true }, repIsAlreadyBusy);

    expect(rep.res.status).toBe(200);
    expect(dispatcher.res.status).toBe(200);
    // …and the override really books, rather than answering 200 having done nothing.
    expect(mockPrisma.visit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lead_id: LEAD_FIXTURE.id, scheduled_at: BOOKED_AT }),
    });
    // The customer is told about a forced booking exactly as about an unforced one.
    expect(withoutActor(rep.automations)).toEqual(withoutActor(dispatcher.automations));
    expect(rep.automations.map((e) => e.type)).toContain('WALKTHROUGH_SCHEDULED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PART B — nothing else moved
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The five lead-side doors, driven for a booker who is NOT on the lead's assignee set. The lead
 * is the REP's throughout (see `repsLead`), so "covering for a rep" is literally what this is.
 */
const doors = [
  {
    name: 'schedules the walkthrough',
    ok: 200,
    live: null as string[] | null,
    send: (who: TestUserKey, performers: string[]) =>
      request(app).post(`${LEAD_URL}/walkthrough/schedule`).set(authHeader(who)).send({
        walkthrough_scheduled_at: BOOKED_AT.toISOString(),
        performer_ids: performers,
        walkthrough_duration_minutes: 60,
      }),
  },
  {
    name: 'replaces the performer set',
    ok: 200,
    live: [REP.id],
    send: (who: TestUserKey, performers: string[]) =>
      request(app).post(`${LEAD_URL}/walkthrough/performers`).set(authHeader(who)).send({
        performer_ids: performers,
      }),
  },
  {
    name: 'books an additional visit',
    ok: 201,
    live: [REP.id],
    send: (who: TestUserKey, performers: string[]) =>
      request(app).post(`${LEAD_URL}/visits`).set(authHeader(who)).send({
        scheduled_at: SECOND_VISIT_AT.toISOString(),
        duration_minutes: 60,
        assignee_ids: performers,
      }),
  },
  {
    name: 'unschedules the walkthrough',
    ok: 200,
    live: [REP.id],
    send: (who: TestUserKey) =>
      request(app).post(`${LEAD_URL}/walkthrough/unschedule`).set(authHeader(who)).send({}),
  },
  {
    name: 'cancels the walkthrough',
    ok: 200,
    live: [REP.id],
    send: (who: TestUserKey) =>
      request(app).post(`${LEAD_URL}/walkthrough/cancel`).set(authHeader(who)).send({
        cancelled_reason: 'Covering for the rep',
      }),
  },
] as const;

describe.each([
  ['a DISPATCHER', 'dispatcher' as TestUserKey, DISPATCHER.id],
  ['an ADMIN', 'admin' as TestUserKey, ADMIN.id],
])('%s on a lead they are NOT assigned to (stories 17, 18)', (_label, who, whoId) => {
  beforeEach(() => {
    signIn(who);
    wireWorld();
  });

  it.each(doors.map((d) => [d.name, d] as const))(
    'still %s',
    async (_name, door) => {
      mockPrisma.visit.findFirst.mockResolvedValue(door.live ? liveVisit([...door.live]) : null);

      // Names the REP, not themselves — booking work for somebody else is the whole job.
      const res = await door.send(who, [REP.id]);

      expect(res.status).toBe(door.ok);
    },
  );

  it('names a colleague freely — the pool rule leaves a grant holder alone', async () => {
    // The refusal a self-only requester gets is 403 with the pool message. A holder gets neither.
    const res = await request(app)
      .post(`${LEAD_URL}/walkthrough/schedule`)
      .set(authHeader(who))
      .send({
        walkthrough_scheduled_at: BOOKED_AT.toISOString(),
        performer_ids: [REP.id, COLLEAGUE.id],
        walkthrough_duration_minutes: 60,
      });

    expect(res.status).toBe(200);
    // …and both names were really written, so this cannot pass on a door that dropped the set.
    expect(txVisitAssignee.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ user_id: REP.id }),
          expect.objectContaining({ user_id: COLLEAGUE.id }),
        ]),
      }),
    );
    // …and the booker is not silently added to the roster they wrote. "Assign" means naming
    // OTHER people; a door that seeded the actor in would put a dispatcher on every walkthrough.
    const written = (txVisitAssignee.createMany.mock.calls[0][0].data as { user_id: string }[])
      .map((d) => d.user_id);
    expect(written).not.toContain(whoId);
  });
});

describe('the row scope in THIS file is really evaluated', () => {
  // The control for the two suites above. They pass today WITHOUT `lead.findFirst` ever being
  // called, because an unconditioned scope short-circuits in `canAccessRow`. This case runs the
  // same wiring for a principal whose scope is NOT empty and shows it refuses — so "dispatcher
  // and admin succeed" is a statement about their grants, not about a defanged stub.
  it('refuses a SALES user on this same lead once it belongs to somebody else', async () => {
    signIn('sales');
    wireWorld({ ...repsLead(), commission_owner_id: ADMIN.id, lead_assignees: [{ user_id: ADMIN.id }] });

    const res = await request(app)
      .post(`${LEAD_URL}/walkthrough/schedule`)
      .set(authHeader('sales'))
      .send({
        walkthrough_scheduled_at: BOOKED_AT.toISOString(),
        performer_ids: [REP.id],
        walkthrough_duration_minutes: 60,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROW_REFUSAL);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });
});

// ── The job crew picker, for the two roles slice 1 defaulted the grant to ────────────────────

const ROSTER = '/api/users/assignable';

/** Whole user rows, narrowed only by the `where.id` the handler chooses — never by this stub. */
const ROSTER_ROWS = [DISPATCHER, ADMIN, COLLEAGUE].map((u) => ({
  id: u.id, first_name: u.first_name, last_name: u.last_name, role: u.role,
  email: u.email, phone: '+15555550100', avatar_path: null, department_id: null, department: null,
  is_active: true, has_login: true,
}));

function stubRoster() {
  mockPrisma.user.findMany.mockImplementation(
    (args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        typeof args.where?.id === 'string'
          ? ROSTER_ROWS.filter((r) => r.id === args.where.id)
          : ROSTER_ROWS,
      ),
  );
}

describe('the job crew picker is unchanged for dispatchers and technicians (stories 19, 33)', () => {
  beforeEach(() => {
    stubRoster();
  });

  it.each([['dispatcher' as TestUserKey], ['technician' as TestUserKey]])(
    'offers a %s the whole org pool',
    async (who) => {
      signIn(who);

      const res = await request(app).get(`${ROSTER}?purpose=jobCrew`).set(authHeader(who));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(ROSTER_ROWS.length);
      // The pool was never narrowed — which is a different claim from "three rows came back",
      // and the one that survives a stub returning three rows for any query at all.
      expect(mockPrisma.user.findMany.mock.calls[0][0].where.id).toBeUndefined();
    },
  );

  it('narrows a TECHNICIAN stripped of `assign User` to their own row', async () => {
    // The control that makes the pair above load-bearing: without it, a handler that ignored the
    // pool entirely would answer the whole roster to everyone and both cases would still pass.
    signIn('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['assign', 'User']);

    const res = await request(app).get(`${ROSTER}?purpose=jobCrew`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(COLLEAGUE.id);
  });

  it('lets a TECHNICIAN crew a colleague onto a job they created, and really writes them', async () => {
    // Slice 1's contested decision — TECHNICIAN holds `assign User` by default, because a
    // technician who created a job can add colleagues to its crew TODAY and omitting them would
    // be a silent removal. The write is asserted, not just the 200: a door that accepted the
    // request and dropped the colleague would look identical from the status line.
    signIn('technician');
    const visit = {
      id: 'v0000000-0000-0000-0000-0000000000c1',
      organization_id: ALPHA_ORG_ID, job_id: JOB_FIXTURE.id, lead_id: null, visit_seq: 1,
      status: 'SCHEDULED', scheduled_at: new Date(NOW + DAY), scheduled_end: new Date(NOW + DAY + 60 * MINUTE),
      is_all_day: false, created_at: new Date(NOW - DAY), customer_email_sent_at: null,
      assignees: [] as { user_id: string }[],
    };
    const job = {
      ...JOB_FIXTURE, organization_id: ALPHA_ORG_ID, status: 'SCHEDULED', created_by_id: COLLEAGUE.id,
      customer: { ...JOB_FIXTURE.customer, email: null }, visits: [visit],
    };
    mockPrisma.job.findUnique.mockResolvedValue(job);
    // `assign Job` is conditioned CREATED_BY_ME for a technician, so this fragment IS consulted.
    mockScopedFindFirst(mockPrisma.job.findFirst, job);
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.visit.findFirst.mockResolvedValue(visit);
    mockPrisma.visit.findMany.mockResolvedValue([visit]);
    mockPrisma.visit.update.mockResolvedValue(visit);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    const crewWrite = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        visit: {
          create: mockPrisma.visit.create,
          update: vi.fn().mockResolvedValue(visit),
          findMany: mockPrisma.visit.findMany,
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
        visitAssignee: crewWrite,
        jobAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
        job: { update: vi.fn().mockResolvedValue(job), findUnique: mockPrisma.job.findUnique },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('technician'))
      .send({ assignee_ids: [COLLEAGUE.id, DISPATCHER.id] });

    expect(res.status).toBe(200);
    expect(crewWrite.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ user_id: COLLEAGUE.id }),
          expect.objectContaining({ user_id: DISPATCHER.id }),
        ]),
      }),
    );
  });

  it('keeps `assign User` on exactly DISPATCHER and TECHNICIAN among the seeded roles', () => {
    // The standing guard on slice 1's default. Behavioural cases prove the grant WORKS; this one
    // names the decision, so that removing a row from TECHNICIAN fails with one legible line
    // instead of scattering 403s across the job suites. It is not a substitute for them — it
    // would still pass against a server that ignored the grant entirely.
    const holders = DEFAULT_GRANTS
      .filter((g) => g.action === 'assign' && g.subject === 'User')
      .map((g) => g.role)
      .sort();

    expect(holders).toEqual(['DISPATCHER', 'TECHNICIAN']);
    // SALES deliberately holds nothing here — that absence IS the feature, and a well-meaning
    // "fix the picker" row added to SALES would undo the whole PRD.
    expect(holders).not.toContain('SALES');
  });
});
