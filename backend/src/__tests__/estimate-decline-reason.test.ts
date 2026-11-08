/**
 * SRVW-285 slice 1 — the customer's end of the public decline.
 *
 * `POST /api/estimates/:id/decline` has accepted an optional `lost_reason` since R4; what this
 * slice adds is the free-text comment beside it (`lost_reason_note`) and the frontend that
 * actually sends either. So the interesting assertions here are NOT "the happy path stores the
 * thing" — they are the four edges that a reason-capture feature gets wrong:
 *
 *   1. SKIPPING MUST COST NOTHING. Declining with neither reason nor comment has to produce the
 *      byte-identical write the route produced before this slice existed. That is asserted by
 *      pinning the EXACT KEY SET of the `estimate.update` data — `['status','declined_at']`, no
 *      more — rather than by asserting `lost_reason_note === null`, because the latter passes
 *      just as happily on an implementation that writes an unwanted `null` column into every
 *      decline. A key-set assertion is the only shape that can see an ADDITION.
 *
 *   2. AN EMPTY COMMENT IS `null`, NEVER `''`. A whitespace-only box is a customer who typed
 *      nothing, and an empty string renders as a blank hole on whatever surface later shows it.
 *
 *   3. AN UNKNOWN `lost_reason` IS STILL SILENTLY IGNORED. That is the route's pre-existing
 *      contract (the manual enum-membership check, deliberately kept). Tightening it to a 400 in
 *      this slice would turn a stale/rogue client into a customer who cannot decline at all.
 *
 *   4. AN OVER-LONG COMMENT IS HANDLED BY AN EXPLICIT RULE. It is truncated at a named cap, not
 *      left to reach Postgres and not 400-ed — a validation error here abandons the DECLINE, and
 *      losing the status is strictly worse than losing the comment. Same reasoning that makes the
 *      reason optional in the first place.
 *
 * Prisma is fully mocked (setup.ts), so every assertion below reads the ARGUMENTS the controller
 * handed Prisma. That is the right level: the column is nullable TEXT with no default, so there is
 * no database behaviour left to test — only what the handler decides to write.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { LOST_REASON_NOTE_MAX, estimateDetailSelect } from '../controllers/estimate.controller';
import { ESTIMATE_SENT_FIXTURE, ALPHA_ORG_ID } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const TOKEN = ESTIMATE_SENT_FIXTURE.public_token;
const DECLINE_URL = `/api/estimates/${ESTIMATE_ID}/decline?token=${TOKEN}`;

/** What the controller handed Prisma inside the transaction, captured per test. */
interface CapturedWrites {
  updateData: Record<string, unknown> | undefined;
  timeline: { event_type: string; metadata?: Record<string, unknown> | null }[];
  depositVoided: boolean;
}

/**
 * Arms the public-decline happy path and returns the captured writes.
 *
 * `voidedCount` drives the kind=DEPOSIT invoice branch — 1 by default precisely SO THAT the
 * skip-path test below exercises the deposit voiding it claims is unchanged, rather than
 * asserting it over a path where no deposit existed.
 */
function armDecline(voidedCount = 1): CapturedWrites {
  const captured: CapturedWrites = { updateData: undefined, timeline: [], depositVoided: false };

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
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          captured.updateData = data;
          return Promise.resolve({ id: ESTIMATE_ID, status: 'DECLINED' });
        }),
      },
      invoice: {
        updateMany: vi.fn().mockImplementation(() => {
          captured.depositVoided = voidedCount > 0;
          return Promise.resolve({ count: voidedCount });
        }),
      },
      timelineEvent: {
        create: vi.fn().mockImplementation(({ data }: { data: CapturedWrites['timeline'][number] }) => {
          captured.timeline.push(data);
          return Promise.resolve({});
        }),
      },
    }),
  );

  // Fire-and-forget notification lookup — null keeps it a no-op.
  mockPrisma.estimate.findUnique.mockResolvedValue(null);

  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/estimates/:id/decline — the reason picker', () => {
  it('persists a known lost_reason and writes no note key when none was sent', async () => {
    const captured = armDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason: 'PRICE' });

    expect(res.status).toBe(200);
    expect(captured.updateData?.lost_reason).toBe('PRICE');
    // Absent, not null: a decline that carried no comment must not stamp the column at all.
    expect(captured.updateData).not.toHaveProperty('lost_reason_note');
  });

  it('persists the reason AND the comment together', async () => {
    const captured = armDecline();

    const res = await request(app)
      .post(DECLINE_URL)
      .send({ lost_reason: 'PRICE', lost_reason_note: 'Found the same scope cheaper nearby.' });

    expect(res.status).toBe(200);
    expect(captured.updateData?.lost_reason).toBe('PRICE');
    expect(captured.updateData?.lost_reason_note).toBe('Found the same scope cheaper nearby.');
  });

  it('accepts a comment with NO reason', async () => {
    // The comment box is always visible, so "typed a sentence, picked nothing" is a real and
    // common shape — not an edge case.
    const captured = armDecline();

    const res = await request(app)
      .post(DECLINE_URL)
      .send({ lost_reason_note: 'The designer was not the right fit for us.' });

    expect(res.status).toBe(200);
    expect(captured.updateData?.lost_reason_note).toBe('The designer was not the right fit for us.');
    expect(captured.updateData).not.toHaveProperty('lost_reason');
  });

  it('trims surrounding whitespace off a real comment', async () => {
    const captured = armDecline();

    await request(app).post(DECLINE_URL).send({ lost_reason_note: '   too expensive   ' });

    expect(captured.updateData?.lost_reason_note).toBe('too expensive');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '     '],
    ['newlines and tabs only', '\n\t  \r\n'],
  ])('stores nothing at all for %s — never an empty string', async (_label, note) => {
    const captured = armDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason_note: note });

    expect(res.status).toBe(200);
    expect(captured.updateData).not.toHaveProperty('lost_reason_note');
    // Stated twice on purpose: the key-set check above is what catches an added `null`, and this
    // one names the actual defect — `''` reaching the column.
    expect(captured.updateData?.lost_reason_note).not.toBe('');

    // And the SAME rule one level down. The conditional spread above omits the column for any
    // falsy value, so `''` and `undefined` are indistinguishable there — but the timeline
    // metadata writes the value straight through (`?? null`), where `''` survives and `undefined`
    // does not. That is the only place an empty-string leak is observable, so it is the only
    // place this can be pinned.
    const declined = captured.timeline.find((t) => t.event_type === 'DECLINED');
    expect(declined?.metadata?.lost_reason_note).toBeNull();
  });
});

describe('POST /api/estimates/:id/decline — skipping costs nothing', () => {
  it('declines with NEITHER reason nor comment exactly as it did before this slice', async () => {
    const captured = armDecline(1);

    const res = await request(app).post(DECLINE_URL).send({});

    expect(res.status).toBe(200);

    // ── The write is byte-identical to the pre-slice one ──────────────────────
    // Sorted key-set equality, not a property spot-check: this is the assertion that fails if
    // either new column is written on a decline that asked for neither.
    expect(Object.keys(captured.updateData ?? {}).sort()).toEqual(['declined_at', 'status']);
    expect(captured.updateData?.status).toBe('DECLINED');
    expect(captured.updateData?.declined_at).toBeInstanceOf(Date);

    // ── Same deposit-invoice voiding ─────────────────────────────────────────
    expect(captured.depositVoided).toBe(true);
    const eventTypes = captured.timeline.map((t) => t.event_type);
    expect(eventTypes).toContain('DECLINED');
    expect(eventTypes).toContain('DEPOSIT_VOIDED');

    // ── Same notification ────────────────────────────────────────────────────
    const call = mockEmit.mock.calls.find((c) => c[0].verb === 'estimate.declined');
    expect(call).toBeDefined();
    expect(call![0].actorId).toBeNull();
    expect(call![0].object.id).toBe(ESTIMATE_ID);
    expect(call![0].data.lost_reason).toBeNull();
  });

  it('declines with no body at all — the shape the page posted before this slice', async () => {
    // handleDecline used to POST with a Content-Type header and NO body. Anything that makes the
    // note mandatory-in-practice (a required field, a non-optional schema key) fails here.
    const captured = armDecline(0);

    const res = await request(app).post(DECLINE_URL).set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(Object.keys(captured.updateData ?? {}).sort()).toEqual(['declined_at', 'status']);
  });
});

describe('POST /api/estimates/:id/decline — the pre-existing unknown-reason contract', () => {
  it.each([
    ['a value outside the enum', 'DESIGNER'],
    ['the right word in the wrong case', 'price'],
    ['an empty string', ''],
  ])('ignores %s rather than 400-ing', async (_label, reason) => {
    const captured = armDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason: reason });

    expect(res.status).toBe(200);
    expect(captured.updateData).not.toHaveProperty('lost_reason');
    // The decline itself still lands — that is the whole point of not tightening this.
    expect(captured.updateData?.status).toBe('DECLINED');
  });

  it('still keeps a comment sent alongside an unknown reason', async () => {
    // Dropping the reason must not drop the sentence the customer actually wrote.
    const captured = armDecline();

    await request(app)
      .post(DECLINE_URL)
      .send({ lost_reason: 'NOT_A_REASON', lost_reason_note: 'We postponed the whole project.' });

    expect(captured.updateData).not.toHaveProperty('lost_reason');
    expect(captured.updateData?.lost_reason_note).toBe('We postponed the whole project.');
  });

  it('rejects a malformed body shape, as the R4 schema already did', async () => {
    // The one thing the schema DOES refuse: a non-string. Kept so the slice cannot be read as
    // "the schema stopped validating".
    armDecline();

    const res = await request(app).post(DECLINE_URL).send({ lost_reason: { code: 'PRICE' } });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/estimates/:id/decline — the over-long comment rule', () => {
  it('truncates at the cap instead of 400-ing or letting the column error', async () => {
    const captured = armDecline();
    const overLong = 'x'.repeat(LOST_REASON_NOTE_MAX + 500);

    const res = await request(app).post(DECLINE_URL).send({ lost_reason_note: overLong });

    // Not 400: a validation failure here abandons the decline, which is the outcome this whole
    // slice is built to avoid.
    expect(res.status).toBe(200);
    expect((captured.updateData?.lost_reason_note as string).length).toBe(LOST_REASON_NOTE_MAX);
    expect(captured.updateData?.status).toBe('DECLINED');
  });

  it('stores a comment sitting exactly ON the cap whole', async () => {
    // Pins the boundary from the other side, so `>` can never be quietly swapped for `>=`.
    const captured = armDecline();
    const exact = 'y'.repeat(LOST_REASON_NOTE_MAX);

    await request(app).post(DECLINE_URL).send({ lost_reason_note: exact });

    expect(captured.updateData?.lost_reason_note).toBe(exact);
  });

  it('trims BEFORE measuring, so padding alone cannot trigger truncation', async () => {
    // `'  ' + cap-length text` is over the cap as received and exactly on it once trimmed. An
    // implementation that truncates first loses two real characters off the end.
    const captured = armDecline();
    const body = 'z'.repeat(LOST_REASON_NOTE_MAX);

    await request(app).post(DECLINE_URL).send({ lost_reason_note: `  ${body}  ` });

    expect(captured.updateData?.lost_reason_note).toBe(body);
  });
});

describe('POST /api/estimates/:id/decline — what the business can see', () => {
  it('records the reason and the note on the DECLINED timeline event, as decline-internal does', async () => {
    // declineInternal stamps `metadata: { method: 'internal', lost_reason }`. The public route
    // carried no metadata at all, so a staff member had no trace of WHY beyond the column. This
    // is parity with the internal path, not a new surface.
    const captured = armDecline(0);

    await request(app)
      .post(DECLINE_URL)
      .send({ lost_reason: 'COMPETITOR', lost_reason_note: 'Another bid came in lower.' });

    const declined = captured.timeline.find((t) => t.event_type === 'DECLINED');
    expect(declined?.metadata).toEqual({
      method: 'public',
      lost_reason: 'COMPETITOR',
      lost_reason_note: 'Another bid came in lower.',
    });
  });

  it('leaves both metadata fields null on a skipped decline', async () => {
    const captured = armDecline(0);

    await request(app).post(DECLINE_URL).send({});

    const declined = captured.timeline.find((t) => t.event_type === 'DECLINED');
    expect(declined?.metadata).toEqual({ method: 'public', lost_reason: null, lost_reason_note: null });
  });
});

describe('POST /api/estimates/:id/decline — the public response stays as thin as it was', () => {
  it('never returns the reason or the note to the customer-facing page', async () => {
    // `estimatePublicSelect` deliberately omits lost_reason. The page has no use for either field
    // and echoing them back would put one customer's words into a payload served on a token URL.
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      organization_id: ALPHA_ORG_ID,
      lead: { commission_owner_id: null },
    });

    let selectedKeys: string[] = [];
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation(({ select }: { select: Record<string, unknown> }) => {
            selectedKeys = Object.keys(select ?? {});
            return Promise.resolve({ id: ESTIMATE_ID, status: 'DECLINED' });
          }),
        },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(DECLINE_URL)
      .send({ lost_reason: 'TIMING', lost_reason_note: 'Revisiting next spring.' });

    expect(res.status).toBe(200);
    expect(selectedKeys).not.toContain('lost_reason');
    expect(selectedKeys).not.toContain('lost_reason_note');
    expect(res.body.estimate).not.toHaveProperty('lost_reason');
    expect(res.body.estimate).not.toHaveProperty('lost_reason_note');
  });
});

describe('estimateDetailSelect — the staff side can actually read the answer', () => {
  /**
   * The counterweight to the test directly above, and the reason it exists as its own case.
   *
   * This slice's first cut wrote `lost_reason_note` and selected it nowhere: the column filled
   * up and no surface in the product could show it. Every suite stayed green, because a write
   * with no reader breaks no assertion — the exact false-green shape this codebase keeps
   * producing. The staff rail in `EstimateWorkspacePage` renders both fields off THIS select,
   * so trimming either key here silently blanks that row, and a frontend test cannot catch it
   * because the frontend never sees the real select.
   *
   * Asserted on the exported object rather than through a request: `getById` is one of six
   * handlers shaped by this select, so pinning the select pins all six at once.
   */
  it('selects both the reason and the note, so the workspace rail has something to render', () => {
    expect(estimateDetailSelect).toHaveProperty('lost_reason', true);
    expect(estimateDetailSelect).toHaveProperty('lost_reason_note', true);
  });
});
