/**
 * SRVW-285 slice C - the per-organisation list reaches both pickers.
 *
 * Slices A and B built the halves: A widened `estimates.lost_reason` from the `LostReason` enum
 * to TEXT, and B gave each organisation a curated list and a settings screen. Between them they
 * left a gap that was visible from the product - an admin could add "Went with a designer",
 * and absolutely nothing offered it to anybody. This slice closes it, and what follows pins the
 * two things that closing it changes.
 *
 * ── 1. WHAT THE WRITE PATHS CHECK AGAINST ──
 *
 * Decision D10: until slice A, Postgres itself refused anything outside the five whatever the
 * application did, and TEXT retired that second guard. `estimate-lost-reason-storage.test.ts`
 * exists to hold the remaining one in place and still does; it asserts the five built-ins land
 * verbatim and that junk is refused. THIS file asserts the other half of D10 - that slice C
 * replaced WHAT those checks consult (the organisation's list) and never WHETHER they run. So a
 * code the org added is storable, and a code the org retired is not, on all three paths D9
 * enumerates. A change that widened the guard to "any string" would leave that file green and
 * this one red, which is the split the two are for.
 *
 * ── 2. WHAT THE CUSTOMER IS TOLD ──
 *
 * Decision D6: the public estimate page is unauthenticated, so the list reaches it through its
 * own token-scoped route rather than by widening the estimate payload. The assertions below are
 * as much about what that route withholds - `is_active`, `sort_order`, ids, counts - as about
 * what it returns. A customer learns the words they may pick between and nothing about how the
 * business curates them.
 *
 * The codes and labels here are written out as literals rather than imported from
 * `lib/lostReasonOptions`, for the reason that file's own sibling test spells out: a test that
 * draws its expectations from its subject cannot fail in the way that matters.
 *
 * Prisma is fully mocked (setup.ts), so the assertions read the ARGUMENTS the controller handed
 * Prisma. For the tenancy case that is the only honest level: a mocked client answers a query
 * with no tenant clause perfectly happily, so asserting on the returned rows would pass on
 * unscoped code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID, ORG_B_ID, TEST_USERS, mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  lostReasonOption: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const TOKEN = ESTIMATE_SENT_FIXTURE.public_token;

/** The five every organisation falls back to, spelled out - see the header. */
const BUILT_IN_CODES = ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER'] as const;

/**
 * The reason a cabinet business would add, and the whole point of the feature: a category the
 * five-value enum had no home for. Written as the code the settings screen would derive from the
 * label "Went with a designer".
 */
const ADDED = { code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer' };

/**
 * A curated organisation: it has materialised its list, renamed nothing, switched TIMING off and
 * added one of its own. `sort_order` is deliberately not 0,1,2… so that an implementation which
 * re-sorted by code or by label would come back in a different order than asserted.
 */
const CURATED_ROWS = [
  { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0 },
  { code: 'TIMING', label: 'Timing', is_active: false, sort_order: 10 },
  { code: ADDED.code, label: ADDED.label, is_active: true, sort_order: 20 },
  { code: 'OTHER', label: 'Other', is_active: true, sort_order: 30 },
];

interface Captured {
  data?: Record<string, unknown>;
}

/** An organisation that has never opened the settings screen: no rows at all (D3). */
function armUnsavedOrg() {
  mockPrisma.lostReasonOption.findMany.mockResolvedValue([]);
}

function armCuratedOrg() {
  mockPrisma.lostReasonOption.findMany.mockResolvedValue(CURATED_ROWS);
}

/** The estimate the public routes resolve from `?token=`. */
function armPublicEstimate() {
  mockPrisma.estimate.findFirst.mockResolvedValue({
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    organization_id: ALPHA_ORG_ID,
    lead: { commission_owner_id: null },
  });
}

function armStaff(): Captured {
  const captured: Captured = {};

  mockPrisma.estimate.findUnique.mockResolvedValue({
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    created_by: TEST_USERS.admin.id,
    public_token: TOKEN,
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'ESTIMATED' },
    job: null,
    invoices: [],
  });

  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: {
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          captured.data = args.data;
          return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, ...args.data });
        }),
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    }),
  );

  return captured;
}

function armPublicDecline(): Captured {
  const captured: Captured = {};
  armPublicEstimate();

  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: {
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          captured.data = args.data;
          return Promise.resolve({ id: ESTIMATE_ID, status: 'DECLINED' });
        }),
      },
      invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );

  mockPrisma.estimate.findUnique.mockResolvedValue(null);
  return captured;
}

const REASONS_URL = `/api/estimates/${ESTIMATE_ID}/decline-reasons?token=${TOKEN}`;
const DECLINE_URL = `/api/estimates/${ESTIMATE_ID}/decline?token=${TOKEN}`;

function patchStatus(body: Record<string, unknown>) {
  mockAuthAs('admin');
  return request(app).patch(`/api/estimates/${ESTIMATE_ID}/status`).set(authHeader('admin')).send(body);
}

function declineInternal(body: Record<string, unknown>) {
  mockAuthAs('admin');
  return request(app).post(`/api/estimates/${ESTIMATE_ID}/decline-internal`).set(authHeader('admin')).send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.estimate.count.mockReset();
  mockPrisma.estimate.count.mockResolvedValue(0);
  armUnsavedOrg();
});

// ═══════════════════════════════════════════════════════════════════
// D6 — the customer's own route
// ═══════════════════════════════════════════════════════════════════

describe("GET /api/estimates/:id/decline-reasons - the words the customer may choose", () => {
  it('answers an organisation that has never saved a list with the five built-ins', async () => {
    armPublicEstimate();

    const res = await request(app).get(REASONS_URL);

    expect(res.status).toBe(200);
    expect(res.body.decline_reasons.map((r: { code: string }) => r.code)).toEqual([...BUILT_IN_CODES]);
  });

  it("answers a curated organisation with ITS words, in the order the admin arranged", async () => {
    armPublicEstimate();
    armCuratedOrg();

    const res = await request(app).get(REASONS_URL);

    expect(res.status).toBe(200);
    expect(res.body.decline_reasons).toEqual([
      { code: 'PRICE', label: 'Price' },
      { code: ADDED.code, label: ADDED.label },
      { code: 'OTHER', label: 'Other' },
    ]);
  });

  it('never offers a reason the admin switched off', async () => {
    armPublicEstimate();
    armCuratedOrg();

    const res = await request(app).get(REASONS_URL);

    // TIMING is in CURATED_ROWS with is_active: false. A customer must not be able to pick a word
    // the business retired - and D4 keeps the row rather than deleting it precisely so that
    // estimates already declined under it stay readable, which is a different surface.
    expect(res.body.decline_reasons.map((r: { code: string }) => r.code)).not.toContain('TIMING');
  });

  it('returns the words and NOTHING else - no is_active, no sort_order, no id', async () => {
    armPublicEstimate();
    armCuratedOrg();

    const res = await request(app).get(REASONS_URL);

    // Asserted as the exact key set rather than as four `not.toHaveProperty` lines, so a field
    // added to the row later cannot leak through a test that only knew to forbid the old ones.
    for (const reason of res.body.decline_reasons) {
      expect(Object.keys(reason).sort()).toEqual(['code', 'label']);
    }
  });

  it('reads the list belonging to the ESTIMATE\'s organisation', async () => {
    armPublicEstimate();

    await request(app).get(REASONS_URL);

    // The route is unauthenticated and `unscopedRequest` marks it cross-tenant for RLS, so the
    // organisation has to come off the row the token resolved and be passed explicitly. Asserting
    // on the argument, not on the answer: the mock would return ORG_B's rows just as readily.
    expect(mockPrisma.lostReasonOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ALPHA_ORG_ID } }),
    );
    expect(mockPrisma.lostReasonOption.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ORG_B_ID } }),
    );
  });

  it('404s a token that does not match the estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}/decline-reasons?token=not-the-token`);

    expect(res.status).toBe(404);
    // Never reached the list at all - a wrong token must not be a way to enumerate any org's
    // vocabulary, and a 404 that still ran the query would be a timing signal.
    expect(mockPrisma.lostReasonOption.findMany).not.toHaveBeenCalled();
  });

  it('400s when no token is supplied', async () => {
    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}/decline-reasons`);

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.findMany).not.toHaveBeenCalled();
  });

  it('needs no session - the token is the whole credential', async () => {
    armPublicEstimate();

    // No Authorization header anywhere in this file's public cases, but stated once explicitly:
    // the customer has no account, and a route that had drifted behind `authenticate` would 401
    // here while every other assertion above still passed.
    const res = await request(app).get(REASONS_URL);

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// D9/D10 — a reason the organisation ADDED is storable on all three paths
// ═══════════════════════════════════════════════════════════════════

describe('a reason the organisation added is storable', () => {
  it('PATCH /status stores it', async () => {
    armCuratedOrg();
    const captured = armStaff();

    const res = await patchStatus({ status: 'DECLINED', lost_reason: ADDED.code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(ADDED.code);
  });

  it('POST /decline-internal stores it', async () => {
    armCuratedOrg();
    const captured = armStaff();

    const res = await declineInternal({ lost_reason: ADDED.code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(ADDED.code);
  });

  it('POST /decline (the customer) stores it', async () => {
    armCuratedOrg();
    const captured = armPublicDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason: ADDED.code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(ADDED.code);
  });
});

// ═══════════════════════════════════════════════════════════════════
// D4/D8 — a reason the organisation RETIRED is not newly assignable
// ═══════════════════════════════════════════════════════════════════

describe('a reason the organisation switched off is not newly assignable', () => {
  it('PATCH /status refuses it, and writes nothing', async () => {
    armCuratedOrg();
    const captured = armStaff();

    // TIMING is a BUILT-IN, and it would have been accepted by the enum check this replaced.
    // That is the case worth pinning: the guard now follows the org's curation rather than the
    // five codes that happen to be compiled in.
    const res = await patchStatus({ status: 'DECLINED', lost_reason: 'TIMING' });

    expect(res.status).toBe(400);
    expect(captured.data).toBeUndefined();
  });

  it('POST /decline-internal refuses it, and writes nothing', async () => {
    armCuratedOrg();
    const captured = armStaff();

    const res = await declineInternal({ lost_reason: 'TIMING' });

    expect(res.status).toBe(400);
    expect(captured.data).toBeUndefined();
  });

  it('does not name the organisation\'s other reasons in the refusal', async () => {
    armCuratedOrg();
    armStaff();

    const res = await declineInternal({ lost_reason: 'TIMING' });

    // The message says the reason is not offered and stops there. Listing the alternatives would
    // turn a 400 into a directory of the org's vocabulary for anyone who can reach the route.
    expect(res.body.error).not.toContain(ADDED.code);
    expect(res.body.error).not.toContain(ADDED.label);
  });

  it('POST /decline (the customer) DROPS it and still declines (D8)', async () => {
    armCuratedOrg();
    const captured = armPublicDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason: 'TIMING', lost_reason_note: 'no rush' });

    // The asymmetry with the two staff paths above is deliberate and predates this slice: a
    // customer holding a page whose option was deactivated mid-session must still be able to
    // decline. They lose the reason, never the decline - and never the comment either.
    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('DECLINED');
    expect(captured.data?.lost_reason).toBeUndefined();
    expect(captured.data?.lost_reason_note).toBe('no rush');
  });
});
