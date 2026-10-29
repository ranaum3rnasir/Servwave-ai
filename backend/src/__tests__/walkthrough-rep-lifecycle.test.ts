/**
 * Scoped assignee pool, slice 5 — THE REP'S OWN LIFECYCLE, through the real lead routes.
 * Plan: md_files/plans/permissions/2026-08-31-assignee-pool/05-lifecycle-holds-for-a-rep.md
 *
 * THE CLAIM THIS FILE MAKES EXECUTABLE: row scoping was ALREADY correct, so opening the
 * performer pool is the only change a rep needed to own a walkthrough end to end. The PRD
 * asserts that on inspection. Inspection is not a regression guard, so it is asserted here as
 * behaviour, at every verb of the lifecycle, by an assigned salesperson.
 *
 * ── WHAT EACH BLOCK IS FOR, AND WHY IT CANNOT PASS VACUOUSLY ────────────────────────────────
 *
 * 1. RESCHEDULE. The exemption for an unchanged roster is what lets a rep move a time without
 *    re-picking people. The trap is that a rep restating `[themselves]` passes for TWO reasons —
 *    the exemption AND the self-only allowance — so such a test proves nothing about the
 *    exemption. The discriminating pair here holds the REQUEST BODY fixed at `[colleague]` and
 *    varies only the roster already on the visit: restating it is 200, changing to it is 403.
 *    Only the exemption can produce that split.
 *
 * 2. SECOND VISIT. `POST /visits` deliberately passes NO current-roster argument — a new trip
 *    restates nothing — so it takes the STRICT path while `/walkthrough/schedule` does not. That
 *    divergence is asserted head-on (same body, same pre-state, two doors, 403 vs 200) rather
 *    than papered over, because a future "consistency" edit that hands `/visits` a current set
 *    would silently widen it.
 *
 * 3. UNSCHEDULE + CANCEL. The gates are NOT the same: unschedule is `schedule_walkthrough Lead`,
 *    cancel is `cancel Lead` — the same grant that gates cancelling the whole LEAD. Both are
 *    conditioned OWN_LEAD for SALES, so both work; the split is pinned by revoking `cancel Lead`
 *    and watching cancel 403 while unschedule still succeeds.
 *
 * 4. AUTHORITY SURVIVES THE LEAD CLOSING. The single most valuable block: it is the one that
 *    catches someone later "tidying up" SALES's grants by adding a status filter. The positives
 *    run against WON / LOST / CANCELLED leads and are evaluated through `mockScopedFindFirst`,
 *    which really applies the grant's condition fragment to the fixture row — so a `status`
 *    predicate turns them red. Verified by mutation: adding
 *    `status: { in: ['NEW','CONTACTED'] }` reddens exactly these nine cases and nothing else.
 *
 *    ⚠️ AND IT IS THE **READ** CONDITION THAT DECIDES, NOT THE VERB'S. Every lead-side
 *    walkthrough door calls `canAccessRow(req, 'Lead', …)`, which resolves `scopeWhereForReq` —
 *    the READ scope for the subject. The verb-scoped twin, `canActOnRow(…, action)`, is used
 *    only for `Job`; there is no `canActOnRow(req, 'Lead', …)` call site in the codebase. So
 *    SALES's `schedule_walkthrough` / `perform_walkthrough` / `cancel` Lead conditions are never
 *    evaluated per-instance: what actually enforces "this rep's own lead" at these doors is
 *    `read Lead`'s OWN_LEAD. All four are byte-identical today, so the behaviour is right and
 *    nothing here is a live defect — but a status filter added to the three verb grants would
 *    change NOTHING, while one added to `read Lead` alone would silently take the whole
 *    lifecycle away. The structural tripwire below therefore covers all four, and names which
 *    one the behavioural tests above are actually exercising.
 *
 * EVERY NEGATIVE IS THE ROW REFUSAL, HONESTLY EVALUATED. `lead.findFirst` — the query every
 * per-instance scope check runs — is wired with `mockScopedFindFirst`, never a blanket
 * `mockResolvedValue({ id })`. A blanket stub makes every scope check pass and every "is
 * refused" assertion in this file vacuous; helpers.ts documents that trap by name.
 *
 * AND EVERY REFUSAL IS ASSERTED AGAINST THE WRITE, not only the status: a handler that 403s
 * after writing is not enforcing anything, and a status-only assertion cannot tell them apart.
 *
 * DATES ARE COMPUTED FROM `Date.now()`. A fixture pinned to a wall-clock instant silently
 * changes which branch it exercises once that instant elapses; one such fixture took this
 * repo's CI red mid-afternoon.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
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
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// The walkthrough automations (customer copy + internal performer notices) travel through the
// dispatcher. Mocked so a booking that legitimately succeeds does not reach for a transport.
// NOTE this is a MOCK, not an assertion: notification behaviour is out of scope for slice 5.
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const mockPrisma = prisma as unknown as Record<string, any>;

/** The pool refusal, pinned as a literal — importing the constant would assert a string equals itself. */
const SELF_ONLY = 'You can only put yourself on a walkthrough.';
/** The row-scope refusal, which every door produces from `canAccessRow`. */
const ROW_REFUSAL = 'Insufficient permissions';

const REP = TEST_USERS.sales;
/** A real, active, in-org user who is NOT the rep. */
const COLLEAGUE = TEST_USERS.technician;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.now();
const BOOKED_AT = new Date(NOW + 7 * DAY);
const MOVED_TO = new Date(NOW + 9 * DAY);
const SECOND_VISIT_AT = new Date(NOW + 11 * DAY);

const ACTIVE_VISIT_ID = 'v0000000-0000-0000-0000-0000000000a1';

/** The lead's live walkthrough, as `findActiveWalkthrough` returns it (assignees included). */
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

/**
 * `organization_id` and `lead_assignees` are both load-bearing: `canAccessRow` builds
 * `{ id, organization_id, ...scope }` and SALES's `read Lead` scope is
 * `lead_assignees: { some: { user_id } }`, so this row is what makes the per-instance check pass
 * HONESTLY (through matchesScopeWhere) rather than by a blanket stub.
 */
function leadRow(status: string, assigneeId: string = REP.id) {
  return {
    ...LEAD_FIXTURE,
    status,
    organization_id: ALPHA_ORG_ID,
    commission_owner_id: assigneeId,
    lead_assignees: [{ user_id: assigneeId }],
  };
}

let txVisitAssignee: {
  findMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
let txVisitUpdateMany: ReturnType<typeof vi.fn>;
let txLeadUpdateMany: ReturnType<typeof vi.fn>;

/**
 * One transaction shape covering all four doors: the union of the delegates they reach for.
 * The visit delegate DELEGATES to the module-level mocks so `visit.create` / `visit.update`
 * assertions read the same vi.fn() whichever door wrote.
 *
 * `visit.updateMany` is the unschedule/cancel writer (both go through a guarded `updateMany`,
 * never a bare `update`), and `lead.updateMany` serves BOTH `stampLeadClock` and
 * `transitionLeadStatus` — which is what lets the closed-lead block below distinguish "stamped a
 * clock" from "moved the status" by inspecting the `data` each call carried.
 */
function wireTx() {
  txVisitAssignee = {
    // THE ROSTER ALREADY ON THE ROW, answered per visit id — not a blanket `[]`.
    // `replaceVisitCrew` diffs the request against THIS read to decide who to delete
    // and who to insert, so a blanket empty makes `removed` empty for every case in the file and
    // a service that deleted the whole existing roster on a reschedule would pass every test
    // here. Verified by mutation: `const removed = [...currentIds]` (wipe everyone) reddens
    // nothing against a blanket stub and reddens the retention cases below against this one.
    findMany: vi.fn().mockImplementation(({ where }: { where: { visit_id: string } }) =>
      Promise.resolve(
        liveVisitOnTheLead && where.visit_id === liveVisitOnTheLead.id
          ? (liveVisitOnTheLead.assignees as { user_id: string }[]).map((a) => ({ user_id: a.user_id }))
          : [],
      ),
    ),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  txVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  txLeadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
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
        updateMany: txLeadUpdateMany,
        findUnique: mockPrisma.lead.findUnique,
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // The lead row lock the "still booked?" count takes first (fix pass, code review #1).
      $executeRaw: vi.fn().mockResolvedValue(1),
    })),
  );
}

/** Sign in, with grants answered PER ROLE so one role's rows are never handed to another. */
function signInAsRep() {
  mockAuthAs('sales');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  clearPermissionCache();
}

/** Put the requester on (or off) this lead, evaluating the scope fragment for real. */
function onLead(row: Record<string, unknown>) {
  mockPrisma.lead.findUnique.mockResolvedValue(row);
  mockPrisma.lead.update.mockResolvedValue(row);
  mockScopedFindFirst(mockPrisma.lead.findFirst, row);
}

/**
 * The lead's live walkthrough, as every door's pre-transaction read sees it — AND as the write
 * inside the transaction reads it back. One setter drives both, so the two can never disagree
 * about who is already on the trip; a fixture whose pre-state and post-state describe different
 * worlds is how a roster-wipe hides.
 */
let liveVisitOnTheLead: (Record<string, unknown> & { id: string; assignees: { user_id: string }[] }) | null = null;
function withLiveVisit(visit: Record<string, unknown> | null) {
  liveVisitOnTheLead = visit as (Record<string, unknown> & { id: string; assignees: { user_id: string }[] }) | null;
  mockPrisma.visit.findFirst.mockResolvedValue(visit);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  signInAsRep();
  onLead(leadRow('CONTACTED'));
  withLiveVisit(null);
  // Conflict detection reads these two. Empty = no clash; the conflict block below overrides.
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
  mockPrisma.visit.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...liveVisit([]), id: 'v-new', ...data }),
  );
  mockPrisma.visit.update.mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
    Promise.resolve({ ...liveVisit([]), id: where.id, ...data }),
  );
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  wireTx();
});

// ─── Request builders — the four lifecycle doors ────────────────────────────────────────────

const LEAD_URL = `/api/leads/${LEAD_FIXTURE.id}`;

const schedule = (performer_ids: string[], at: Date, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`${LEAD_URL}/walkthrough/schedule`)
    .set(authHeader('sales'))
    .send({
      walkthrough_scheduled_at: at.toISOString(),
      performer_ids,
      walkthrough_duration_minutes: 60,
      ...extra,
    });

const bookAdditionalVisit = (assignee_ids: string[], at: Date) =>
  request(app)
    .post(`${LEAD_URL}/visits`)
    .set(authHeader('sales'))
    .send({ scheduled_at: at.toISOString(), duration_minutes: 60, assignee_ids });

const unschedule = () =>
  request(app).post(`${LEAD_URL}/walkthrough/unschedule`).set(authHeader('sales')).send({});

const cancelWalkthrough = (cancelled_reason: string) =>
  request(app).post(`${LEAD_URL}/walkthrough/cancel`).set(authHeader('sales')).send({ cancelled_reason });

/** Nothing was written. The half of a refusal a status code cannot demonstrate. */
function expectNothingWritten() {
  expect(txVisitAssignee.createMany).not.toHaveBeenCalled();
  expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  expect(txVisitUpdateMany).not.toHaveBeenCalled();
}

// ─── 1. Reschedule, without re-picking performers ───────────────────────────────────────────

describe('the rep reschedules a walkthrough they booked (story 6)', () => {
  it('moves the time of the SAME visit, restating the roster the form showed them', async () => {
    withLiveVisit(liveVisit([REP.id]));

    const res = await schedule([REP.id], MOVED_TO);

    expect(res.status).toBe(200);
    // A reschedule EDITS the live row — booking a second one instead would double-book the
    // customer while reporting success, which no status assertion would notice.
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).toHaveBeenCalledWith({
      where: { id: ACTIVE_VISIT_ID },
      data: expect.objectContaining({
        status: 'SCHEDULED',
        scheduled_at: MOVED_TO,
        // #1699: the end must move WITH the start, or a walkthrough moved later finishes
        // before it begins.
        scheduled_end: new Date(MOVED_TO.getTime() + 60 * MINUTE),
      }),
    });
  });

  // ── The discriminating pair. Same requester, same door, SAME REQUEST BODY. Only the roster
  // already on the visit differs. If the rep's success above came from the self-only allowance
  // rather than the unchanged-set exemption, the first of these would 403; if the exemption
  // stretched to cover a CHANGE, the second would 200.

  it('RESTATING a colleague roster is permitted — this is the exemption, not the self allowance', async () => {
    withLiveVisit(liveVisit([COLLEAGUE.id]));

    const res = await schedule([COLLEAGUE.id], MOVED_TO);

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalledWith({
      where: { id: ACTIVE_VISIT_ID },
      data: expect.objectContaining({ scheduled_at: MOVED_TO }),
    });
    // …and the colleague is still on the trip afterwards. A 200 is not retention: the door could
    // answer 200 having deleted the roster it just let through, and "reschedule without
    // re-picking performers" would then mean "reschedule and lose them".
    expect(txVisitAssignee.deleteMany).not.toHaveBeenCalled();
  });

  it('KEEPS an existing multi-performer roster across the move (story 35 — not a data change)', async () => {
    // The retention claim at its widest: two people were on this trip before the rep touched the
    // time, and both are on it after. Asserted on the WRITE, because the response body is
    // rendered from a mocked re-read and would show whatever the fixture says regardless.
    withLiveVisit(liveVisit([COLLEAGUE.id, TEST_USERS.dispatcher.id]));

    const res = await schedule([COLLEAGUE.id, TEST_USERS.dispatcher.id], MOVED_TO);

    expect(res.status).toBe(200);
    // Nobody removed, nobody re-inserted — the set the visit already carried is the set it keeps.
    expect(txVisitAssignee.deleteMany).not.toHaveBeenCalled();
    expect(txVisitAssignee.createMany).not.toHaveBeenCalled();
  });

  it('CHANGING to that same colleague roster is refused — identical body, different pre-state', async () => {
    withLiveVisit(liveVisit([REP.id]));

    const res = await schedule([COLLEAGUE.id], MOVED_TO);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(SELF_ONLY);
    expectNothingWritten();
  });

  it('refuses the reschedule on a lead the rep is NOT assigned to, with the ROW refusal', async () => {
    // The rep names THEMSELVES, so the pool rule cannot be what refused: only the row scope can
    // produce this status and this string. `lead.findFirst` really evaluates the fragment here,
    // so a scope check that got defanged turns this red while leaving the rest of the file green.
    onLead(leadRow('CONTACTED', TEST_USERS.admin.id));
    withLiveVisit(liveVisit([REP.id]));

    const res = await schedule([REP.id], MOVED_TO);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROW_REFUSAL);
    expectNothingWritten();
  });

  // ── Conflict detection is OUT OF SCOPE TO CHANGE (PRD story 9/10, slice 5 "nothing else
  // moved"). These two assert it is untouched for a rep, and nothing here modifies it.

  it('still warns the rep with a 409 when the new slot clashes (untouched)', async () => {
    withLiveVisit(liveVisit([REP.id]));
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: 'v-other', scheduled_at: MOVED_TO, duration_minutes: 60,
        lead: { id: 'e0000000-0000-0000-0000-0000000000ff', lead_number: 'L00099' },
      },
    ]);

    const res = await schedule([REP.id], MOVED_TO);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Schedule conflict detected');
    expect(res.body.conflicts).toHaveLength(1);
    expectNothingWritten();
  });

  it('lets the rep override that warning with force, exactly as a dispatcher can (untouched)', async () => {
    withLiveVisit(liveVisit([REP.id]));
    mockPrisma.visit.findMany.mockResolvedValue([
      {
        id: 'v-other', scheduled_at: MOVED_TO, duration_minutes: 60,
        lead: { id: 'e0000000-0000-0000-0000-0000000000ff', lead_number: 'L00099' },
      },
    ]);

    const res = await schedule([REP.id], MOVED_TO, { force: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.update).toHaveBeenCalled();
  });
});

// ─── 2. A second visit on the same lead ─────────────────────────────────────────────────────

describe('the rep books a SECOND visit on the same lead (story 7)', () => {
  it('creates an additional trip and leaves the live one alone', async () => {
    withLiveVisit(liveVisit([REP.id]));
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await bookAdditionalVisit([REP.id], SECOND_VISIT_AT);

    expect(res.status).toBe(201);
    // "Additional", not "reschedule": the existing row is untouched and the new one takes the
    // next seq. A door that collapsed onto the live visit would still answer 201.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lead_id: LEAD_FIXTURE.id,
        purpose: 'WALKTHROUGH',
        visit_seq: 2,
        status: 'SCHEDULED',
        scheduled_at: SECOND_VISIT_AT,
      }),
    });
    expect(txVisitAssignee.createMany).toHaveBeenCalled();
  });

  it('behaves identically on the FIRST booking through this door — no live visit needed', async () => {
    withLiveVisit(null);

    const res = await bookAdditionalVisit([REP.id], SECOND_VISIT_AT);

    expect(res.status).toBe(201);
    expect(mockPrisma.visit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ visit_seq: 1, scheduled_at: SECOND_VISIT_AT }),
    });
  });

  it('DIVERGES from the schedule door on the strict path — same body, same pre-state, two doors', async () => {
    // `createVisit` calls the validator with TWO arguments where `scheduleWalkthrough` passes
    // three: a brand-new trip replaces no roster, so there is nothing to restate and the strict
    // path is correct. Asserted as a comparison rather than in isolation, because the failure
    // mode worth catching is a future "consistency" edit that hands /visits a current set and
    // silently opens it. If that lands, the second half of this test goes green and it fails.
    withLiveVisit(liveVisit([COLLEAGUE.id]));

    const atScheduleDoor = await schedule([COLLEAGUE.id], MOVED_TO);
    expect(atScheduleDoor.status).toBe(200);

    vi.clearAllMocks();
    signInAsRep();
    onLead(leadRow('CONTACTED'));
    withLiveVisit(liveVisit([COLLEAGUE.id]));
    wireTx();

    const atVisitsDoor = await bookAdditionalVisit([COLLEAGUE.id], MOVED_TO);
    expect(atVisitsDoor.status).toBe(403);
    expect(atVisitsDoor.body.error).toBe(SELF_ONLY);
    expectNothingWritten();
  });

  it('refuses the additional visit on a lead the rep is NOT assigned to, with the ROW refusal', async () => {
    onLead(leadRow('CONTACTED', TEST_USERS.admin.id));

    const res = await bookAdditionalVisit([REP.id], SECOND_VISIT_AT);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROW_REFUSAL);
    expectNothingWritten();
  });
});

// ─── 3. Unschedule and cancel — the rest of the lifecycle ───────────────────────────────────

describe('the rep unschedules and cancels on their own lead (story 12)', () => {
  beforeEach(() => {
    withLiveVisit(liveVisit([REP.id]));
  });

  it('unschedules: the live visit is taken out of the schedule', async () => {
    const res = await unschedule();

    expect(res.status).toBe(200);
    expect(txVisitUpdateMany).toHaveBeenCalledWith({
      // Guarded on the live set in the WHERE, not on the pre-transaction read — that is what
      // makes a lost race a truthful `count: 0` instead of a clobbered completion.
      where: { id: ACTIVE_VISIT_ID, status: { in: expect.arrayContaining(['SCHEDULED']) } },
      data: expect.objectContaining({ status: 'CANCELLED', cancelled_reason: 'Unscheduled' }),
    });
  });

  it('cancels: the reason and the canceller are recorded against the visit', async () => {
    const res = await cancelWalkthrough('Customer went with another vendor');

    expect(res.status).toBe(200);
    expect(txVisitUpdateMany).toHaveBeenCalledWith({
      where: { id: ACTIVE_VISIT_ID, status: { in: expect.arrayContaining(['SCHEDULED']) } },
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancelled_reason: 'Customer went with another vendor',
        cancelled_by: REP.id,
      }),
    });
  });

  it('refuses BOTH verbs on a lead the rep is not assigned to, with the ROW refusal', async () => {
    onLead(leadRow('CONTACTED', TEST_USERS.admin.id));

    const un = await unschedule();
    expect(un.status).toBe(403);
    expect(un.body.error).toBe(ROW_REFUSAL);

    const cx = await cancelWalkthrough('any reason');
    expect(cx.status).toBe(403);
    expect(cx.body.error).toBe(ROW_REFUSAL);

    expectNothingWritten();
  });

  it('CANCEL SITS BEHIND A DIFFERENT GRANT than schedule — revoking `cancel Lead` splits them', async () => {
    // Found by reading the routes, pinned here so nobody has to read them again:
    //   POST /walkthrough/unschedule -> canDo('schedule_walkthrough', 'Lead')
    //   POST /walkthrough/cancel     -> canDo('cancel', 'Lead')   <-- the LEAD cancel grant
    // SALES holds both, each conditioned OWN_LEAD, so the lifecycle is whole by default. But an
    // org that takes "cancel a lead" off a sales role ALSO takes away cancelling a walkthrough,
    // and the two verbs stop moving together. That coupling is real behaviour, not a typo, and
    // this test is what makes changing it a decision.
    mockRoleGrantsWithout('SALES', ['cancel', 'Lead']);

    const cx = await cancelWalkthrough('Customer went with another vendor');
    expect(cx.status).toBe(403);
    expect(cx.body.error).toBe(ROW_REFUSAL);
    expect(txVisitUpdateMany).not.toHaveBeenCalled();

    const un = await unschedule();
    expect(un.status).toBe(200);
    expect(txVisitUpdateMany).toHaveBeenCalled();
  });
});

// ─── 4. Authority survives the lead closing ─────────────────────────────────────────────────

describe.each(['WON', 'LOST', 'CANCELLED'])(
  'the rep keeps booking on a %s lead (story 8 — Ran: authority survives the lead closing)',
  (closedStatus) => {
    beforeEach(() => {
      onLead(leadRow(closedStatus));
    });

    it('books through /walkthrough/schedule exactly as on an open lead', async () => {
      // The condition this door actually consults is SALES's `read Lead` scope (canAccessRow
      // resolves the READ scope — see the ⚠️ note in the file header). It is conditioned on the
      // ASSIGNEE SET and carries NO status filter, which is the whole of Ran's ruling.
      // `mockScopedFindFirst` applies that real fragment to this closed-lead row, so a status
      // predicate appearing in it turns this red: a value filter stops matching (403), and a
      // shape `matchesScopeWhere` refuses to guess at throws rather than silently passing (500).
      const res = await schedule([REP.id], MOVED_TO);

      expect(res.status).toBe(200);
      expect(mockPrisma.visit.create).toHaveBeenCalled();
      expect(txVisitAssignee.createMany).toHaveBeenCalled();
    });

    it('books through /visits exactly as on an open lead', async () => {
      const res = await bookAdditionalVisit([REP.id], SECOND_VISIT_AT);

      expect(res.status).toBe(201);
      expect(mockPrisma.visit.create).toHaveBeenCalled();
    });

    it('does NOT resurrect the closed lead by booking on it (D5 — no status is pulled backward)', async () => {
      const res = await schedule([REP.id], MOVED_TO);

      // NON-VACUITY FIRST. "No status was written" is trivially true of a request that was
      // refused, so without this line any change that 403s the closed lead leaves this case
      // green — and it is the only case in this block that would not have noticed.
      expect(res.status).toBe(200);

      // Both `stampLeadClock` and `transitionLeadStatus` write through lead.updateMany, so the
      // question is not WHETHER it was called but WHAT it carried: a booking may stamp the
      // first-booked clock and must never write a `status`.
      const statusWrites = (txLeadUpdateMany.mock.calls as unknown[][]).filter(
        (call) => 'status' in (call[0] as { data: Record<string, unknown> }).data,
      );
      expect(statusWrites).toEqual([]);
    });

    it('cancels the walkthrough on the closed lead too — the whole lifecycle survives', async () => {
      withLiveVisit(liveVisit([REP.id]));

      const res = await cancelWalkthrough('No longer needed');

      expect(res.status).toBe(200);
      expect(txVisitUpdateMany).toHaveBeenCalled();
    });

    it('still refuses a rep who is NOT assigned to that closed lead', async () => {
      // The pair that makes the four positives above mean something: "closed leads are open to
      // everyone" would pass all of them and fail this one.
      onLead(leadRow(closedStatus, TEST_USERS.admin.id));

      const res = await schedule([REP.id], MOVED_TO);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(ROW_REFUSAL);
      expectNothingWritten();
    });
  },
);

describe("SALES's lead-lifecycle grants carry no status filter", () => {
  it('states the ruling structurally, as a legible companion to the behaviour above', () => {
    // The route tests are the real guard; this one exists so that when a status filter IS added,
    // one failure names the cause in a single line instead of leaving a reader to work out why
    // booking on a WON lead started 403ing. Not a substitute for them: it would still pass if the
    // server refused a foreign performer id, or refused the closed lead for any other reason.
    //
    // `read` is in this list and is the one the doors actually consult (⚠️ file header). The other
    // three are here because they are what a reader — and the PRD — take to be the carriers of
    // Ran's ruling, so a status filter added to any of the four should be a deliberate act.
    const lifecycleGrants = DEFAULT_GRANTS.filter(
      (g) =>
        g.role === 'SALES' &&
        g.subject === 'Lead' &&
        ['read', 'schedule_walkthrough', 'perform_walkthrough', 'cancel'].includes(g.action),
    );

    expect(lifecycleGrants.map((g) => g.action).sort()).toEqual([
      'cancel', 'perform_walkthrough', 'read', 'schedule_walkthrough',
    ]);
    for (const grant of lifecycleGrants) {
      // The assignee set, and nothing else. `lead_assignees` alone IS "authority survives the
      // lead closing" — a second key here is a narrowing, whatever it is called.
      expect(Object.keys(grant.conditions ?? {})).toEqual(['lead_assignees']);
    }
  });
});
