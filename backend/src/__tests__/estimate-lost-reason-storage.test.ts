/**
 * SRVW-285 slice A — the guard that used to be Postgres's job.
 *
 * `estimates.lost_reason` was the `LostReason` enum and is now TEXT, so that a later slice can
 * store an organisation's own reason code ("designer", "quality") which an enum can never hold.
 * Nothing user-facing moves in that slice. What DOES move is where the rule lives.
 *
 * Until the widening, two independent things refused a value outside the five: the application,
 * and the database. If a validator had ever been loosened, mistyped or bypassed, Postgres still
 * rejected the write with a 22P02 and the bad value never landed. THAT SECOND GUARD IS GONE. A
 * TEXT column accepts 'designer', 'price', 'PRICE ', '' and a 4KB paragraph with equal enthusiasm.
 * From here, the only thing keeping the estimates conversion report grouping on five stable codes
 * instead of on whatever a client happened to POST is the validation in estimate.controller.ts.
 *
 * So this file is not about the migration, which changed no behaviour and no row. It is about
 * pinning down the behaviour the migration stopped being able to rely on, across ALL THREE paths
 * that can write the column:
 *
 *   1. PATCH  /api/estimates/:id/status         (status: 'DECLINED')  — staff, reason REQUIRED
 *   2. POST   /api/estimates/:id/decline-internal                     — staff, reason REQUIRED
 *   3. POST   /api/estimates/:id/decline?token= — the unauthenticated public page, reason OPTIONAL
 *
 * Paths 1 and 2 REFUSE an unrecognised code with a 400. Path 3 SILENTLY IGNORES it and still
 * declines, which is deliberate and predates this slice: a customer holding a stale page must
 * never be left unable to decline because of a value they did not choose. Both halves of that
 * asymmetry are asserted here, because "unknown input is rejected" and "unknown input is dropped"
 * are equally easy to get backwards once the database stops having an opinion.
 *
 * ── WHY THE FIVE CODES ARE WRITTEN OUT AS LITERALS BELOW ──
 *
 * The obvious way to write these cases is `it.each(Object.values(LostReason))`. That test CANNOT
 * FAIL in the way that matters. It would draw its expectations from the very enum the controller
 * validates against, so narrowing the accepted set — dropping a member, swapping
 * `z.nativeEnum(LostReason)` for `z.enum(['PRICE'])` — would narrow the test's own case list in
 * the same motion and it would stay green over a route that had quietly stopped accepting four of
 * the five. A shared source of truth is exactly what a test must not share with its subject.
 *
 * So the five codes are spelled out here as an independent statement of the contract. If a future
 * change means one of these literals is genuinely no longer accepted, this file is SUPPOSED to go
 * red and make somebody say so out loud — in particular, slice B/C may only ever ADD codes to the
 * per-organisation list. These five are the built-ins every org falls back to, and history already
 * references them.
 *
 * Prisma is fully mocked (setup.ts), so every assertion reads the ARGUMENTS the controller handed
 * Prisma rather than a stored row. That is the right level here: the column is now unconstrained
 * TEXT, so there is no database behaviour left to exercise — whatever the handler decides to write
 * IS what would land.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

/**
 * The five built-in codes, deliberately hardcoded — see the header. Order is the order both
 * pickers offer them in (frontend/src/constants/lostReasons.ts), which is also the enum's
 * declaration order, so a reader comparing the two files is comparing like with like.
 */
const BUILT_IN_CODES = ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER'] as const;

/**
 * Values that must never reach the column. Each is a shape that the enum used to make impossible
 * at the database level and that TEXT now accepts happily:
 *
 *   - a plausible future org-specific code, which is the ENTIRE POINT of the widening and so the
 *     one most likely to be waved through by a loosened validator;
 *   - the right word in the wrong case, the classic client bug, and the one that would silently
 *     split a conversion-report group in two ('price' and 'PRICE' as separate rows);
 *   - the right word with padding, same consequence;
 *   - free prose, which belongs in `lost_reason_note` and nowhere near this column;
 *   - the empty string, which is not "no reason" (that is NULL) and renders as a blank hole.
 */
const REJECTED_VALUES: ReadonlyArray<readonly [string, string]> = [
  ['an org-specific code slice B has not built yet', 'DESIGNER'],
  ['the right word in the wrong case', 'price'],
  ['a known code with padding', ' PRICE '],
  ['free prose that belongs in the note column', 'They went with someone else.'],
  ['the empty string', ''],
];

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;

/** What the route handed `estimate.update`, or undefined if it never opened the transaction. */
interface Captured {
  data?: Record<string, unknown>;
}

/** Arms a staff route against a SENT estimate the admin may act on, and captures the write. */
function armStaff(): Captured {
  const captured: Captured = {};

  mockPrisma.estimate.findUnique.mockResolvedValue({
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    created_by: TEST_USERS.admin.id,
    public_token: 'live-token',
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

/** Arms the unauthenticated public decline and captures the write. */
function armPublic(): Captured {
  const captured: Captured = {};

  mockPrisma.estimate.findFirst.mockResolvedValue({
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    organization_id: ALPHA_ORG_ID,
    lead: { commission_owner_id: null },
  });

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

  // Fire-and-forget notification lookup — null keeps it a no-op.
  mockPrisma.estimate.findUnique.mockResolvedValue(null);

  return captured;
}

const PUBLIC_URL = `/api/estimates/${ESTIMATE_ID}/decline?token=${ESTIMATE_SENT_FIXTURE.public_token}`;

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
});

// ═══════════════════════════════════════════════════════
// The five built-ins still land, unchanged, on every path
// ═══════════════════════════════════════════════════════

describe('every built-in code still stores VERBATIM now the column is TEXT', () => {
  // Verbatim is the load-bearing word. The estimates conversion report groups on this column as
  // an opaque string, so any normalisation a handler might be tempted to add — trimming,
  // upper-casing, mapping through a lookup — would re-bucket historical rows against new ones.
  // `toBe` on the exact literal is what makes "the report is byte-identical" testable.

  it.each(BUILT_IN_CODES)('PATCH /status stores %s', async (code) => {
    const captured = armStaff();

    const res = await patchStatus({ status: 'DECLINED', lost_reason: code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(code);
  });

  it.each(BUILT_IN_CODES)('POST /decline-internal stores %s', async (code) => {
    const captured = armStaff();

    const res = await declineInternal({ lost_reason: code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(code);
  });

  it.each(BUILT_IN_CODES)('the public decline stores %s', async (code) => {
    const captured = armPublic();

    const res = await request(app).post(PUBLIC_URL).send({ lost_reason: code });

    expect(res.status).toBe(200);
    expect(captured.data?.lost_reason).toBe(code);
  });
});

// ═══════════════════════════════════════════════════════
// Staff paths: refuse, exactly as the enum used to
// ═══════════════════════════════════════════════════════

describe('PATCH /api/estimates/:id/status — an unrecognised code is still a 400', () => {
  it.each(REJECTED_VALUES)('refuses %s', async (_label, value) => {
    const captured = armStaff();

    const res = await patchStatus({ status: 'DECLINED', lost_reason: value });

    expect(res.status).toBe(400);
    // The write must not have happened at all. Asserting only on the status code would pass on an
    // implementation that 400s AFTER writing, which is the failure mode that actually corrupts
    // the column.
    expect(captured.data).toBeUndefined();
  });

  it('still refuses a move to DECLINED carrying no reason at all', async () => {
    // Kept beside the unknown-value cases because the two rules are a pair: the reason is
    // REQUIRED here, and it must be one of the five. A refactor that relaxed either would be
    // caught by one of these two.
    const captured = armStaff();

    const res = await patchStatus({ status: 'DECLINED' });

    expect(res.status).toBe(400);
    expect(captured.data).toBeUndefined();
  });
});

describe('POST /api/estimates/:id/decline-internal — an unrecognised code is still a 400', () => {
  it.each(REJECTED_VALUES)('refuses %s', async (_label, value) => {
    const captured = armStaff();

    const res = await declineInternal({ lost_reason: value });

    expect(res.status).toBe(400);
    expect(captured.data).toBeUndefined();
  });

  it('still refuses a decline carrying no reason at all', async () => {
    const captured = armStaff();

    const res = await declineInternal({});

    expect(res.status).toBe(400);
    expect(captured.data).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// Public path: drop the value, keep the decline
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/decline — the public route drops instead of refusing', () => {
  it.each(REJECTED_VALUES)('ignores %s but still declines', async (_label, value) => {
    const captured = armPublic();

    const res = await request(app).post(PUBLIC_URL).send({ lost_reason: value });

    // Not a 400. A customer holding a page whose option was retired mid-session must still be
    // able to decline; losing the STATUS is strictly worse than losing the reason.
    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('DECLINED');
    // Absent, not null: the rejected value must not be laundered into an explicit null write
    // either, or a skipped decline and a rejected one stop being distinguishable.
    expect(captured.data).not.toHaveProperty('lost_reason');
  });
});
