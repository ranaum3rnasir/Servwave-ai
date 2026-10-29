/**
 * Scoped assignee pool, slice 2 — the WALKTHROUGH half, stated through the real routes.
 * Plan: md_files/plans/permissions/2026-08-31-assignee-pool/02-server-refuses-foreign-assignee.md
 *
 * THE RULE, in one sentence: a requester who does not hold `assign User` may name only
 * THEMSELVES on a walkthrough, and the server says so with a 403.
 *
 * ── WHY THIS SUITE IS SHAPED THE WAY IT IS ──────────────────────────────────────────────
 *
 * EVERY DOOR, NOT ONE AND AN ARGUMENT. The claim slice 2 actually makes is "there is no
 * unguarded door", so all three walkthrough doors are driven from a TABLE rather than one
 * being written out and the other two reasoned about. The table is the complete set as of
 * this slice: `replaceVisitCrew` is the only writer of visit_assignees, and its
 * LEAD-parented call sites are exactly these three (lead.controller.ts:1758/1970/2909). A
 * fourth lead-side writer must be added to `DOORS`, or it ships untested.
 *
 * ITS JOB-PARENTED CALL SITES ARE *MOSTLY* THE CREW VALIDATOR'S HALF - not all of them, and
 * the difference is not academic. job.controller.ts's two direct calls and both branches of
 * `applyJobCrewStatementToVisit` do sit behind `validateCrew`, but
 * service-plan.controller.ts's `scheduleVisit` calls `replaceVisitCrew` on a job
 * visit with `[body.assigned_to]` and reaches NO pool validator at all. That door is
 * therefore covered by neither suite today; PR #1942 is routing it through `validateCrew`.
 * Read the sentence above as "the crew validator's half, minus one known hole", never as a
 * statement that every job-parented write is guarded.
 *
 * REFUSAL IS ASSERTED AGAINST THE WRITE, NOT ONLY THE STATUS. A handler that 403s after
 * having already written the performer rows is not enforcing anything, and a status-only
 * assertion cannot tell the two apart. Every refusal case asserts that `visitAssignee`
 * received no `createMany` and that no visit row was created.
 *
 * THE POSITIVE CASES ARE THE ONES THAT CAN ROT. A mis-wired mock turns a door into a
 * uniform 500 and every "is refused" assertion below would still be green while testing
 * nothing at all. Each door therefore has to produce its real success status (200/200/201)
 * from the same fixtures, which is what keeps the refusals meaningful.
 *
 * THE GRANT, NEVER THE ROLE. `mockRoleGrantsWithout('DISPATCHER', ['assign','User'])` builds
 * a DISPATCHER who is refused, and the SALES cases are a role that is refused by default.
 * Same role, opposite outcomes, decided only by the grant row — which is what a role-shaped
 * `role === 'DISPATCHER'` implementation cannot reproduce.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  ALPHA_ORG_ID,
  LEAD_FIXTURE,
  mockAuthAs,
  authHeader,
  mockScopedFindFirst,
  mockRoleGrantsWithout,
  type TestUserKey,
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { defineAbilityFor, type Grant } from '../lib/permissions/defineAbility';
import { validatePerformers } from '../services/walkthrough.service';

// WALKTHROUGH_SCHEDULED and the performer-assigned/removed notices travel through the
// automation dispatcher; mocked so a booking that legitimately succeeds does not reach for
// a mail transport.
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const mockPrisma = prisma as unknown as Record<string, any>;

/**
 * The refusal, spelled out. Pinned as a LITERAL rather than imported from the service: the
 * acceptance criterion is that the message states the rule in the user's terms, and a test
 * that imports the constant it is checking asserts only that a string equals itself.
 */
const SELF_ONLY = 'You can only put yourself on a walkthrough.';

// The lead the sales rep is assigned to. `organization_id` and `lead_assignees` are both
// load-bearing: `canAccessRow` builds `{ id, organization_id, ...scope }` and the SALES
// `read Lead` scope is `lead_assignees: { some: { user_id } }`, so this row is what makes
// the per-instance check pass HONESTLY (via matchesScopeWhere) instead of by a blanket stub.
const LEAD_ROW = {
  ...LEAD_FIXTURE,
  status: 'CONTACTED',
  organization_id: ALPHA_ORG_ID,
};

// The lead's live walkthrough — the row POST /walkthrough/performers replaces the crew of.
const ACTIVE_VISIT = {
  id: 'v0000000-0000-0000-0000-0000000000a1',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-09-01T14:00:00Z'),
  duration_minutes: 60,
  customer_email_sent_at: null,
  assignees: [] as { user_id: string }[],
};

// A real, active, in-org user who is NOT the sales rep — the "colleague" of the ruling.
const COLLEAGUE = TEST_USERS.technician;
// Well-formed uuid that names nobody.
const UNKNOWN_ID = '00000000-0000-0000-0000-0000000000ff';
// A real in-org user who is deactivated — the second existing 400.
const INACTIVE_ID = '00000000-0000-0000-0000-0000000000fe';

let txVisitAssignee: {
  findMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

/**
 * One transaction shape covering all three doors: the union of the delegates they reach for.
 * The visit delegate DELEGATES to the module-level mocks so `visit.create` assertions read the
 * same vi.fn() whichever door wrote.
 */
function wireTx() {
  txVisitAssignee = {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        aggregate: mockPrisma.visit.aggregate,
      },
      visitAssignee: txVisitAssignee,
      lead: {
        update: vi.fn().mockResolvedValue(LEAD_ROW),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(LEAD_ROW),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

/** Resolve every TEST_USER by id, plus the two eligibility decoys. */
function wireUserLookup() {
  mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
    if (args.where.id === INACTIVE_ID) {
      return Promise.resolve({
        ...TEST_USERS.technician,
        id: INACTIVE_ID,
        is_active: false,
        organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} },
      });
    }
    const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
    return Promise.resolve(
      match
        ? { ...match, phone: null, organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} } }
        : null,
    );
  });
}

function signIn(userKey: TestUserKey) {
  mockAuthAs(userKey);
  // mockAuthAs installs its own user.findUnique (auth + org resolution); ours is a superset,
  // so it goes back on AFTER.
  wireUserLookup();
  // Grants are answered per ROLE, so a performer-eligibility lookup for some other role does
  // not get handed the caller's rows.
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  clearPermissionCache();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
  // The per-instance scope probe REALLY evaluates the fragment. A blanket
  // `mockResolvedValue({ id })` here would make every scope check pass and is exactly the
  // trap helpers.ts documents.
  mockScopedFindFirst(mockPrisma.lead.findFirst, LEAD_ROW);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
  mockPrisma.visit.create.mockResolvedValue({ ...ACTIVE_VISIT, id: 'v-new', visit_seq: 1 });
  mockPrisma.visit.update.mockResolvedValue({ ...ACTIVE_VISIT });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  wireTx();
});

// ─── The three doors ────────────────────────────────────────────────────────────────────

type Door = {
  name: string;
  okStatus: number;
  /** Door-specific pre-state: whether the lead already holds a live walkthrough. */
  prepare: () => void;
  send: (userKey: TestUserKey, ids: string[]) => request.Test;
};

const DOORS: Door[] = [
  {
    name: 'POST /api/leads/:id/walkthrough/schedule',
    okStatus: 200,
    prepare: () => { mockPrisma.visit.findFirst.mockResolvedValue(null); },
    send: (userKey, performer_ids) =>
      request(app)
        .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
        .set(authHeader(userKey))
        .send({
          walkthrough_scheduled_at: '2026-09-04T14:00:00Z',
          performer_ids,
          walkthrough_duration_minutes: 60,
        }),
  },
  {
    name: 'POST /api/leads/:id/walkthrough/performers',
    okStatus: 200,
    // Performer-only REPLACE needs a live visit to replace the crew OF.
    prepare: () => { mockPrisma.visit.findFirst.mockResolvedValue({ ...ACTIVE_VISIT }); },
    send: (userKey, performer_ids) =>
      request(app)
        .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
        .set(authHeader(userKey))
        .send({ performer_ids }),
  },
  {
    name: 'POST /api/leads/:id/visits',
    okStatus: 201,
    prepare: () => { mockPrisma.visit.findFirst.mockResolvedValue(null); },
    send: (userKey, assignee_ids) =>
      request(app)
        .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
        .set(authHeader(userKey))
        .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 60, assignee_ids }),
  },
];

/** Nothing was written. The half of a refusal a status code cannot demonstrate. */
function expectNoPerformerWrite() {
  expect(txVisitAssignee.createMany).not.toHaveBeenCalled();
  expect(mockPrisma.visit.create).not.toHaveBeenCalled();
}

describe.each(DOORS)('$name — the assignee pool', (door) => {
  beforeEach(() => door.prepare());

  it('lets a sales rep on their own lead name THEMSELVES', async () => {
    signIn('sales');

    const res = await door.send('sales', [TEST_USERS.sales.id]);

    expect(res.status).toBe(door.okStatus);
    expect(txVisitAssignee.createMany).toHaveBeenCalled();
  });

  it('refuses a sales rep on a lead they are NOT assigned to, with the ROW refusal', async () => {
    // The PAIR of the positive above, and the reason that positive is worth anything. SALES holds
    // its walkthrough grants conditioned OWN_LEAD, so the per-instance probe is what decides this
    // door - and `lead.findFirst` really evaluates the fragment here (mockScopedFindFirst), so a
    // scope check that got defanged turns this red while leaving every other case in the file
    // green. The rep names THEMSELVES, so the pool rule cannot be what refused: only the row scope
    // can produce this status and this string.
    signIn('sales');
    mockScopedFindFirst(mockPrisma.lead.findFirst, {
      ...LEAD_ROW,
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await door.send('sales', [TEST_USERS.sales.id]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expectNoPerformerWrite();
  });

  it('refuses a sales rep naming a colleague ALONE, with 403 and the rule', async () => {
    signIn('sales');

    const res = await door.send('sales', [COLLEAGUE.id]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });

  it('refuses a sales rep naming a colleague ALONGSIDE THEMSELVES', async () => {
    // The case a "does the set contain me?" implementation gets wrong: the requester IS in
    // the set, and the request must still be refused.
    signIn('sales');

    const res = await door.send('sales', [TEST_USERS.sales.id, COLLEAGUE.id]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });

  it('accepts an EMPTY list from a self-only requester (Ran: no minimum-length rule here)', async () => {
    signIn('sales');

    const res = await door.send('sales', []);

    expect(res.status).toBe(door.okStatus);
  });

  it('leaves a DISPATCHER naming anyone exactly as it was', async () => {
    signIn('dispatcher');

    const res = await door.send('dispatcher', [COLLEAGUE.id, TEST_USERS.sales.id]);

    expect(res.status).toBe(door.okStatus);
    expect(txVisitAssignee.createMany).toHaveBeenCalled();
  });

  it('refuses a DISPATCHER whose org revoked the grant — the ability decides, not the role', async () => {
    // Same role, same lead, same body as the case above. Only the grant row differs, so an
    // implementation that tested `role === 'DISPATCHER'` passes that test and fails this one.
    signIn('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['assign', 'User']);

    const res = await door.send('dispatcher', [COLLEAGUE.id]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });

  it('still lets that revoked DISPATCHER name themselves', async () => {
    signIn('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['assign', 'User']);

    const res = await door.send('dispatcher', [TEST_USERS.dispatcher.id]);

    expect(res.status).toBe(door.okStatus);
  });

  // ── The existing eligibility refusals are NOT reclassified ──────────────────────────
  //
  // Slice 2 adds one status to these validators and changes none. Asserted through a
  // grant HOLDER, because for a non-holder the pool check fires first (see below).

  it('keeps "performer not found" at 400 for a grant holder', async () => {
    signIn('dispatcher');

    const res = await door.send('dispatcher', [UNKNOWN_ID]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Performer not found or inactive');
  });

  it('keeps "inactive performer" at 400 for a grant holder', async () => {
    signIn('dispatcher');

    const res = await door.send('dispatcher', [INACTIVE_ID]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Performer not found or inactive');
  });

  it('answers a self-only requester 403 for an id that does not exist, never 400', async () => {
    // The pool check is the FIRST step deliberately: a 400-vs-403 split by whether the id
    // resolves would turn this door into an "does this person work here" oracle for a role
    // that deliberately cannot read the staff directory (PRD story 27).
    signIn('sales');

    const res = await door.send('sales', [UNKNOWN_ID]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });
});

// ─── The unchanged-set escape, THROUGH THE ROUTES ───────────────────────────────────────
//
// The unit cases in the next block state the VALIDATOR's contract. These state that PRODUCTION
// actually supplies the current roster: `scheduleWalkthrough` and `setPerformers` each hoist
// their `findActiveWalkthrough` read above the validator for no other reason, and nothing else
// in this file would notice if that hoist were undone - the unit cases below pass the third
// argument themselves, which is precisely the argument production has to produce. Drop it at
// either door and the validator sees `undefined`, takes the strict path, and 403s a rep for
// moving the time of a trip they do not personally staff.
//
// The requester is the SALES rep assigned to the lead (so the row scope passes) holding no
// `assign User`; the live visit is staffed by a COLLEAGUE and NOT by them. Restating that roster
// is a reschedule they must be allowed to make; changing it is not.

describe('the restatement exemption, through the real lead routes', () => {
  // The row `findActiveWalkthrough` returns. This is the whole fixture: the colleague's id has to
  // come back from the READ, not from the request body, or the exemption is never exercised.
  const COLLEAGUE_CREWED = { ...ACTIVE_VISIT, assignees: [{ user_id: COLLEAGUE.id }] };

  beforeEach(() => {
    signIn('sales');
    mockPrisma.visit.findFirst.mockResolvedValue({ ...COLLEAGUE_CREWED });
  });

  it('lets a self-only rep RESCHEDULE a walkthrough staffed by a colleague', async () => {
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('sales'))
      .send({
        walkthrough_scheduled_at: '2026-09-08T14:00:00Z',
        performer_ids: [COLLEAGUE.id],
        walkthrough_duration_minutes: 60,
      });

    expect(res.status).toBe(200);
  });

  it('refuses that same rep CHANGING the roster at the schedule door', async () => {
    // Same requester, same live visit, same door - only the resulting SET differs. Adding
    // themselves to a colleague's roster is still authoring a set they may not author, so the
    // exemption must not stretch to cover it.
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('sales'))
      .send({
        walkthrough_scheduled_at: '2026-09-08T14:00:00Z',
        performer_ids: [COLLEAGUE.id, TEST_USERS.sales.id],
        walkthrough_duration_minutes: 60,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });

  it('lets a self-only rep RESTATE a colleague roster at the performers door', async () => {
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('sales'))
      .send({ performer_ids: [COLLEAGUE.id] });

    expect(res.status).toBe(200);
  });

  it('refuses that same rep CHANGING the roster at the performers door', async () => {
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/performers`)
      .set(authHeader('sales'))
      .send({ performer_ids: [COLLEAGUE.id, TEST_USERS.sales.id] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });

  it('gives POST /visits NO exemption to inherit - a new trip restates nothing', async () => {
    // `createVisit` deliberately calls the validator with two arguments: a brand-new trip replaces
    // no roster, so there is nothing to restate and the strict path is correct. The lead's live
    // walkthrough carries the colleague, which is exactly the state that would let a mistaken
    // "reuse the lead's current performers as the current set" reading open this door.
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('sales'))
      .send({ scheduled_at: '2026-09-08T14:00:00Z', duration_minutes: 60, assignee_ids: [COLLEAGUE.id] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNoPerformerWrite();
  });
});

// ─── The unchanged-set escape ───────────────────────────────────────────────────────────
//
// A non-holder who RESTATES a roster they did not change must not be refused, or a sales rep
// rescheduling a visit a dispatcher crewed gets a 403 for touching the time. Prior art and
// the same reasoning: task.controller.ts's `sameSet` guard on update.
//
// Driven against `validatePerformers` directly because the third argument is how a caller
// TELLS it the current set, and the strict default (argument omitted) is the property that
// stops a door opening by forgetting to pass it.

describe('validatePerformers — restating an unchanged roster', () => {
  function reqAs(userKey: TestUserKey, grants: Grant[]): Request {
    const user = TEST_USERS[userKey];
    return {
      user: { ...user },
      ability: defineAbilityFor({ id: user.id, role: user.role }, grants, []),
    } as unknown as Request;
  }

  const SALES_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'SALES') as unknown as Grant[];

  beforeEach(() => {
    signIn('sales');
  });

  it('permits a non-holder restating the SAME foreign roster (order and duplicates aside)', async () => {
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(
      req,
      [COLLEAGUE.id, TEST_USERS.dispatcher.id],
      [TEST_USERS.dispatcher.id, COLLEAGUE.id],
    );

    expect(result.ok).toBe(true);
  });

  it('refuses the same non-holder ADDING a name to that roster', async () => {
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(
      req,
      [COLLEAGUE.id, TEST_USERS.dispatcher.id, TEST_USERS.admin.id],
      [TEST_USERS.dispatcher.id, COLLEAGUE.id],
    );

    expect(result).toEqual({ ok: false, status: 403, error: SELF_ONLY });
  });

  it('refuses the same non-holder REMOVING a name from that roster', async () => {
    // Dropping a colleague is still a change to a set they may not author. The pool rule is
    // about the resulting set, and `[dispatcher]` is not `[self]`.
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(
      req,
      [TEST_USERS.dispatcher.id],
      [TEST_USERS.dispatcher.id, COLLEAGUE.id],
    );

    expect(result).toEqual({ ok: false, status: 403, error: SELF_ONLY });
  });

  it('PERMITS a wipe of a foreign roster — the recorded cost of the empty-list ruling', async () => {
    // Pinned because it is the one place the empty-list allowance is visibly expensive: a
    // self-only requester may hand-make a request that takes a dispatcher's crew OFF a visit,
    // even though they could not have put them on it. Ran's call, and the PRD names the cost
    // ("data quality on a hand-made request; access is unaffected either way") - so this is a
    // deliberate consequence, not a gap. Changing it means re-opening that decision, and this
    // test is what makes such a change deliberate instead of incidental.
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(req, [], [COLLEAGUE.id]);

    expect(result.ok).toBe(true);
  });

  it('is STRICT when the current set is not supplied at all — a door cannot open by forgetting', async () => {
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(req, [COLLEAGUE.id]);

    expect(result).toEqual({ ok: false, status: 403, error: SELF_ONLY });
  });

  it('still runs per-member eligibility on an unchanged restatement', async () => {
    // The unchanged-set escape is an escape from the POOL rule only. A roster carrying an id
    // that no longer resolves is still a 400 — otherwise "unchanged" would become a way to
    // re-persist a deactivated person.
    const req = reqAs('sales', SALES_GRANTS);

    const result = await validatePerformers(req, [INACTIVE_ID], [INACTIVE_ID]);

    expect(result).toEqual({ ok: false, status: 400, error: 'Performer not found or inactive' });
  });

  it('lets a GRANT HOLDER through with no current set supplied', async () => {
    const holder = reqAs('dispatcher', [
      ...(DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER') as unknown as Grant[]),
    ]);

    const result = await validatePerformers(holder, [COLLEAGUE.id, TEST_USERS.sales.id]);

    expect(result.ok).toBe(true);
  });
});
