import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  BUILT_IN_LOST_REASONS,
  MAX_LOST_REASON_OPTIONS,
  deriveLostReasonCode,
} from '../lib/lostReasonOptions';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

/**
 * Decline-reasons slice B - the per-org estimate decline reason list and its CRUD.
 *
 * Three things this file exists to hold down, in order of how badly they fail:
 *
 *  1. TENANCY. Every read and every write spreads the caller's organization_id, and the WRITE's
 *     own `where` carries it - not just a read that happened to precede it. The assertions look
 *     at the arguments Prisma was handed rather than at a row that came back, because the
 *     mocked client will happily answer a query with no tenant clause at all; asserting on the
 *     RESULT would pass on unscoped code, which is the exact defect this is here to catch.
 *  2. AUTHORISATION. The four writes sit behind `update Organization`, a pair no default grant
 *     gives to SALES, DISPATCHER or TECHNICIAN. The read sits behind the deliberately coarser
 *     `read Estimate` - see the route file for why - so the non-admin cases below assert 403 on
 *     the writes and 200 on the read, which is the intended shape and not an oversight.
 *  3. MATERIALISATION (D3). "The org's rows if it has any, else the five built-ins" is only
 *     coherent if the first save writes ALL FIVE. A write path that persisted one row would
 *     leave the organisation with a one-item list and four built-ins silently gone, and every
 *     picker in slice C would then be missing them.
 */

const mockPrisma = prisma as unknown as {
  lostReasonOption: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const ROW = (over: Partial<{ id: string; code: string; label: string; is_active: boolean; sort_order: number }> = {}) => ({
  id: '7c000000-0000-0000-0000-0000000000a1',
  code: 'PRICE',
  label: 'Price',
  is_active: true,
  sort_order: 0,
  ...over,
});

/**
 * This controller only ever uses the CALLBACK form of $transaction, so a callback passthrough is
 * enough - but the array form is mirrored anyway (job-sub-status.test.ts's reason: a
 * callback-only passthrough throws on the array form, and the next handler added here might use
 * it).
 */
function installTransactionPassthrough() {
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  installTransactionPassthrough();
  // The default an un-customised organisation really has: no stored rows.
  mockPrisma.lostReasonOption.findMany.mockResolvedValue([]);
  mockPrisma.lostReasonOption.count.mockResolvedValue(0);
  mockPrisma.lostReasonOption.createMany.mockResolvedValue({ count: BUILT_IN_LOST_REASONS.length });
});

// ─── D7: the two sides of the product must offer the same words ─────────────

describe('the built-in labels', () => {
  /**
   * `frontend/src/constants/lostReasons.ts` states the same five code -> label pairs, because
   * the two builds share no module. Decision D7 says staff and customers must read the SAME
   * words - a staff member filtering the conversion report on "Went with a competitor" and a
   * homeowner picking that phrase have to mean one thing - so the two lists are pinned equal
   * here rather than trusted to a cross-reference comment. Slice C makes the backend list the
   * single source; until it does, this is what stops them drifting.
   */
  it('match the labels the frontend pickers already render', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'frontend', 'src', 'constants', 'lostReasons.ts'),
      'utf8',
    );
    // Anchored on the DECLARATIONS, not on the bare names: the module's own docstring mentions
    // both constants several lines above either of them, so a naive indexOf pair slices an empty
    // string and the comparison below passes on nothing at all.
    const from = src.indexOf('export const LOST_REASON_LABELS');
    const to = src.indexOf('export const LOST_REASON_OPTIONS');
    expect(from, 'LOST_REASON_LABELS not found - has the frontend constant been renamed?').toBeGreaterThan(-1);
    expect(to, 'LOST_REASON_OPTIONS not found - has the frontend constant been renamed?').toBeGreaterThan(from);
    const block = src.slice(from, to);

    const frontend = [...block.matchAll(/^\s*([A-Z_]+):\s*'([^']+)',/gm)].map((m) => ({
      code: m[1]!,
      label: m[2]!,
    }));

    expect(frontend).toEqual(BUILT_IN_LOST_REASONS.map((r) => ({ code: r.code, label: r.label })));
  });
});

describe('deriveLostReasonCode', () => {
  it('reads in the conversion report the way the five built-ins do', () => {
    expect(deriveLostReasonCode('Went with a designer')).toBe('WENT_WITH_A_DESIGNER');
  });

  it('folds case so two spellings of one reason collide instead of both appearing', () => {
    expect(deriveLostReasonCode('designer')).toBe(deriveLostReasonCode('Designer'));
  });

  it('refuses a label with nothing to derive a code from', () => {
    expect(deriveLostReasonCode('???')).toBeNull();
  });
});

// ─── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/lost-reason-options', () => {
  it('scopes findMany to the caller organization', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.lostReasonOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }),
        orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
      }),
    );
  });

  it('answers with the caller org, never a second tenant, for a different caller', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.lostReasonOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_B_ID }) }),
    );
  });

  it('falls back to the five built-ins for an organisation that has never saved (D3)', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lost_reason_options).toEqual(
      BUILT_IN_LOST_REASONS.map((r, i) => ({
        code: r.code,
        label: r.label,
        is_active: true,
        sort_order: i,
        is_builtin: true,
      })),
    );
  });

  it('serves the org rows once it has any, inactive ones included', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.findMany.mockResolvedValue([
      ROW({ code: 'PRICE', label: 'Too expensive', sort_order: 0 }),
      ROW({ id: 'r2', code: 'TIMING', label: 'Timing', is_active: false, sort_order: 1 }),
      ROW({ id: 'r3', code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', sort_order: 2 }),
    ]);

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('admin'));

    expect(res.status).toBe(200);
    // A deactivated reason has to stay VISIBLE here or an admin can never switch it back on.
    expect(res.body.lost_reason_options).toEqual([
      { code: 'PRICE', label: 'Too expensive', is_active: true, sort_order: 0, is_builtin: true },
      { code: 'TIMING', label: 'Timing', is_active: false, sort_order: 1, is_builtin: true },
      { code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', is_active: true, sort_order: 2, is_builtin: false },
    ]);
  });

  it('never returns a row id, so no client can key on one half the answers do not have', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.findMany.mockResolvedValue([ROW()]);

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('admin'));

    expect(res.body.lost_reason_options[0]).not.toHaveProperty('id');
  });
});

// ─── POST (create) ──────────────────────────────────────────────────────────

describe('POST /api/lost-reason-options', () => {
  it('stamps the caller organization_id and never trusts a body-supplied org', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockResolvedValue(
      ROW({ id: 'new', code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', sort_order: 5 }),
    );

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Went with a designer', organization_id: ORG_B_ID });

    // `.strict()` refuses the smuggled key outright rather than quietly ignoring it.
    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });

  it('writes the caller org onto the row, and appends at the end of the list', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockResolvedValue(
      ROW({ id: 'new', code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', sort_order: 5 }),
    );

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Went with a designer' });

    expect(res.status).toBe(201);
    const arg = mockPrisma.lostReasonOption.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.organization_id).toBe(ALPHA_ORG_ID);
    expect(arg.data.code).toBe('WENT_WITH_A_DESIGNER');
    // Append index from the tenant-scoped count, not a client-supplied position.
    expect(arg.data.sort_order).toBe(5);
    expect(res.body.lost_reason_option).toEqual({
      code: 'WENT_WITH_A_DESIGNER',
      label: 'Went with a designer',
      is_active: true,
      sort_order: 5,
      is_builtin: false,
    });
  });

  it('takes the org from the authenticated user, so a second tenant writes into its own list', async () => {
    // The pair above proves the schema REFUSES a smuggled organization_id. This proves the other
    // half: the value actually written is read off the session, not off anything the request
    // could influence - so relaxing `.strict()` later cannot quietly turn into a cross-tenant
    // write.
    mockAuthAs('orgB_admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockResolvedValue(ROW({ id: 'new', code: 'QUALITY', label: 'Quality', sort_order: 5 }));

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('orgB_admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(201);
    const arg = mockPrisma.lostReasonOption.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.organization_id).toBe(ORG_B_ID);
  });

  it('materialises all five built-ins first when the organisation has none (D3)', async () => {
    mockAuthAs('admin');
    // Zero before, five after - the count the controller re-reads once it has materialised.
    mockPrisma.lostReasonOption.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockResolvedValue(
      ROW({ id: 'new', code: 'QUALITY', label: 'Quality', sort_order: 5 }),
    );

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(201);
    const seeded = mockPrisma.lostReasonOption.createMany.mock.calls[0][0] as {
      data: { organization_id: string; code: string; label: string; sort_order: number }[];
      skipDuplicates?: boolean;
    };
    // ALL FIVE, or the org is left with a list that has silently lost four reasons.
    expect(seeded.data).toEqual(
      BUILT_IN_LOST_REASONS.map((r, i) => ({
        organization_id: ALPHA_ORG_ID,
        code: r.code,
        label: r.label,
        sort_order: i,
      })),
    );
    // Two admins saving at once both see a count of zero; the unique key must make the loser a
    // skip rather than a 500 and a doubled list.
    expect(seeded.skipDuplicates).toBe(true);
    // And the new reason lands AFTER them.
    expect((mockPrisma.lostReasonOption.create.mock.calls[0][0] as { data: { sort_order: number } }).data.sort_order).toBe(5);
  });

  it('does not re-seed an organisation that already has rows', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(6);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockResolvedValue(ROW({ id: 'new', code: 'QUALITY', label: 'Quality', sort_order: 6 }));

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(201);
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
  });

  it('409s a duplicate code in the same org, scoped, and never upserts', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(ROW({ code: 'QUALITY', label: 'Quality' }));

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(409);
    expect(mockPrisma.lostReasonOption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });

  /**
   * The race the pre-check above cannot close, and the everyday way to hit it is a double-click
   * on Add.
   *
   * The pre-check and the insert share a transaction, which makes the write atomic but NOT
   * serialisable: under READ COMMITTED both requests read "no collision" in their own snapshot,
   * both insert, and the loser comes back P2002 on (organization_id, code). It used to fall into
   * the generic catch and answer 500 - a server fault for a request that lost a race against a
   * list that now holds exactly the reason the admin asked for. It answers with the pre-check's
   * own 409, word for word, so the admin cannot tell which of the two refused them.
   */
  it('409s with the same message when the insert loses the race and comes back P2002', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    // The pre-check passes: at the instant this request read, the code really was free.
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['organization_id', 'code'] },
      }),
    );

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(409);
    // Pinned to the pre-check's wording rather than to a regex, because "the same 409" is the
    // whole point - two paths drifting apart is how one of them starts reading like a fault.
    expect(res.body.error).toBe('That decline reason already exists');
  });

  it('still 500s when the insert fails for any other reason', async () => {
    // The P2002 backstop must not become a catch-all that reports a real database fault as a
    // duplicate - the admin would retype the reason for ever.
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(null);
    mockPrisma.lostReasonOption.create.mockRejectedValue(
      Object.assign(new Error('connection pool timeout'), { code: 'P2024' }),
    );

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Quality' });

    expect(res.status).toBe(500);
  });

  it('409s a built-in it would collide with, on an un-saved org, without materialising anything', async () => {
    // Same rule as update() and reorder(): a refused request leaves the organisation exactly as
    // unconfigured as it was, rather than seeding five rows on its way to saying no.
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'Price' });

    expect(res.status).toBe(409);
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });

  it('400s a label with no letters or digits, before touching the database', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: '???' });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
  });

  it('400s a blank label even when it is made of spaces', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: '     ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });

  it('400s a label past the cap', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'x'.repeat(61) });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });

  it('refuses to grow the list past the ceiling', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(MAX_LOST_REASON_OPTIONS);

    const res = await request(app)
      .post('/api/lost-reason-options')
      .set(authHeader('admin'))
      .send({ label: 'One too many' });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
  });
});

// ─── PATCH (rename / deactivate / restore) ──────────────────────────────────

describe('PATCH /api/lost-reason-options/:code', () => {
  it('scopes the WRITE, not just a preceding read, to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(ROW({ label: 'Too expensive' }));

    const res = await request(app)
      .patch('/api/lost-reason-options/PRICE')
      .set(authHeader('admin'))
      .send({ label: 'Too expensive' });

    expect(res.status).toBe(200);
    expect(mockPrisma.lostReasonOption.updateMany).toHaveBeenCalledWith({
      where: { code: 'PRICE', organization_id: ALPHA_ORG_ID },
      data: { label: 'Too expensive' },
    });
    expect(res.body.lost_reason_option.label).toBe('Too expensive');
  });

  it('404s a code this org does not own and writes nothing', async () => {
    // Org B renaming a reason only Alpha has: the scoped updateMany matches no row.
    mockAuthAs('orgB_admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/lost-reason-options/WENT_WITH_A_DESIGNER')
      .set(authHeader('orgB_admin'))
      .send({ label: 'Stolen' });

    expect(res.status).toBe(404);
    expect(mockPrisma.lostReasonOption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_B_ID }) }),
    );
  });

  it('materialises the built-ins before renaming one, for an org that has never saved (D3)', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(ROW({ code: 'COMPETITOR', label: 'Lost to a rival' }));

    const res = await request(app)
      .patch('/api/lost-reason-options/COMPETITOR')
      .set(authHeader('admin'))
      .send({ label: 'Lost to a rival' });

    expect(res.status).toBe(200);
    const seeded = mockPrisma.lostReasonOption.createMany.mock.calls[0][0] as { data: unknown[] };
    expect(seeded.data).toHaveLength(BUILT_IN_LOST_REASONS.length);
  });

  it('404s an unknown code on an un-saved org WITHOUT leaving five rows behind it', async () => {
    // A rejected request must not materialise the list as a side effect - an org that refused a
    // bad PATCH is exactly as unconfigured afterwards as it was before.
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);

    const res = await request(app)
      .patch('/api/lost-reason-options/NOT_A_REASON')
      .set(authHeader('admin'))
      .send({ label: 'Nope' });

    expect(res.status).toBe(404);
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to deactivate "Other", and writes nothing (D5)', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);

    const res = await request(app)
      .patch('/api/lost-reason-options/OTHER')
      .set(authHeader('admin'))
      .send({ is_active: false });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
    // No vendor or company name reaches the customer-facing error surface.
    expect(res.body.error).toMatch(/has to stay available/);
  });

  it('still lets "Other" be renamed', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(ROW({ code: 'OTHER', label: 'Something else' }));

    const res = await request(app)
      .patch('/api/lost-reason-options/OTHER')
      .set(authHeader('admin'))
      .send({ label: 'Something else' });

    expect(res.status).toBe(200);
    expect(res.body.lost_reason_option.label).toBe('Something else');
  });

  it('deactivates a built-in rather than deleting it (D4)', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lostReasonOption.findFirst.mockResolvedValue(ROW({ code: 'TIMING', label: 'Timing', is_active: false }));

    const res = await request(app)
      .patch('/api/lost-reason-options/TIMING')
      .set(authHeader('admin'))
      .send({ is_active: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.lostReasonOption.updateMany).toHaveBeenCalledWith({
      where: { code: 'TIMING', organization_id: ALPHA_ORG_ID },
      data: { is_active: false },
    });
    expect(res.body.lost_reason_option.is_active).toBe(false);
  });

  it('400s an empty body rather than reporting a change that never happened', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/lost-reason-options/PRICE')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('404s a malformed code without reaching the database', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/lost-reason-options/not-a-code')
      .set(authHeader('admin'))
      .send({ label: 'Nope' });

    expect(res.status).toBe(404);
    expect(mockPrisma.lostReasonOption.count).not.toHaveBeenCalled();
  });
});

// ─── POST /reorder ──────────────────────────────────────────────────────────

describe('POST /api/lost-reason-options/reorder', () => {
  /** The org's five, dragged into a new order - the only shape the page ever sends. */
  const REORDERED = ['TIMING', 'PRICE', 'OTHER', 'COMPETITOR', 'NO_RESPONSE'];

  it('writes sort_order by array index, each write scoped to the org', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(REORDERED.length);
    mockPrisma.lostReasonOption.findMany.mockResolvedValue(REORDERED.map((code) => ({ code })));
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: REORDERED });

    expect(res.status).toBe(204);
    // Asserted for EVERY row rather than spot-checked on the first two: the contract is that the
    // list comes out holding 0..n-1 with no position used twice, and a spot-check of the front of
    // the array is exactly what let a partial body look correct here.
    expect(mockPrisma.lostReasonOption.updateMany).toHaveBeenCalledTimes(REORDERED.length);
    REORDERED.forEach((code, i) => {
      expect(mockPrisma.lostReasonOption.updateMany).toHaveBeenNthCalledWith(i + 1, {
        where: { code, organization_id: ALPHA_ORG_ID },
        data: { sort_order: i },
      });
    });
  });

  /**
   * The third of the three rules on `ordered_codes`, and the one that was missing.
   *
   * Membership and duplicates were both checked; COMPLETENESS was not. So ['TIMING','PRICE']
   * against a five-reason org renumbered those two to 0 and 1 and left the other three sitting
   * on 0, 1 and 2 - two pairs of rows sharing a position, with the order between each pair then
   * decided by list()'s `code` tie-break instead of by the admin's drag. The page always sends
   * the whole list so no user could reach it, but this file's own happy path used to send two
   * codes against a five-row org and assert the collision as though it were the contract.
   */
  it('400s a partial list rather than renumbering part of the org and colliding with the rest', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: ['TIMING', 'PRICE'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/all 5 decline reasons/i);
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('400s when any code fails to resolve inside the org, and writes nothing', async () => {
    // A code belonging to another tenant resolves to nothing under the scoped read, so a
    // cross-tenant reorder cannot even partially apply. The body is deliberately COMPLETE - five
    // codes for a five-row org - so that it is the resolving read that refuses it and not the
    // completeness check above; a two-code body would now 400 either way and prove nothing about
    // tenancy. The message is asserted for that reason too.
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(5);
    mockPrisma.lostReasonOption.findMany.mockResolvedValue(
      ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE'].map((code) => ({ code })),
    );

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'SOMEONE_ELSES_REASON'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown decline reason/i);
    expect(mockPrisma.lostReasonOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('materialises the built-ins before the first reorder (D3)', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);
    mockPrisma.lostReasonOption.findMany.mockResolvedValue(
      BUILT_IN_LOST_REASONS.map((r) => ({ code: r.code })),
    );
    mockPrisma.lostReasonOption.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: [...BUILT_IN_LOST_REASONS].reverse().map((r) => r.code) });

    expect(res.status).toBe(204);
    expect(mockPrisma.lostReasonOption.createMany).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown code on an un-saved org without materialising anything', async () => {
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);

    // FIVE codes, four of them real, because an un-saved org resolves to the five built-ins:
    // a shorter body would be refused by the completeness check and this test would go green
    // without the unknown-code branch ever running.
    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'NOT_A_REASON'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown decline reason/i);
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('measures completeness against the built-ins an un-saved org still reads as', async () => {
    // The org has no rows, so "the whole list" is the five built-ins, not zero. Without that the
    // completeness check would read `total = 0` and refuse every first-ever reorder.
    mockAuthAs('admin');
    mockPrisma.lostReasonOption.count.mockResolvedValue(0);

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: ['PRICE', 'TIMING', 'COMPETITOR'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/all 5 decline reasons/i);
    expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });

  it('400s a list with the same code twice', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lost-reason-options/reorder')
      .set(authHeader('admin'))
      .send({ ordered_codes: ['PRICE', 'PRICE'] });

    expect(res.status).toBe(400);
    expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Authorisation ──────────────────────────────────────────────────────────

describe('authorisation', () => {
  /**
   * SALES, DISPATCHER and TECHNICIAN each carry `read Organization` in defaultGrants and none of
   * them carries `update Organization`, so all three are refused every write. A non-admin
   * reaching this CRUD would be able to rewrite the words a customer sees on the public estimate
   * page and to re-bucket the conversion report for the whole company.
   */
  for (const role of ['sales', 'dispatcher', 'technician'] as const) {
    describe(role, () => {
      it('cannot add a reason', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .post('/api/lost-reason-options')
          .set(authHeader(role))
          .send({ label: 'Mine now' });
        expect(res.status).toBe(403);
        expect(mockPrisma.lostReasonOption.create).not.toHaveBeenCalled();
        expect(mockPrisma.lostReasonOption.createMany).not.toHaveBeenCalled();
      });

      it('cannot rename or deactivate one', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .patch('/api/lost-reason-options/PRICE')
          .set(authHeader(role))
          .send({ label: 'Mine now' });
        expect(res.status).toBe(403);
        expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
      });

      it('cannot reorder the list', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .post('/api/lost-reason-options/reorder')
          .set(authHeader(role))
          .send({ ordered_codes: ['OTHER', 'PRICE'] });
        expect(res.status).toBe(403);
        expect(mockPrisma.lostReasonOption.updateMany).not.toHaveBeenCalled();
      });
    });
  }

  /**
   * The READ is deliberately wider - `read Estimate`, the same asymmetry job sub-statuses and
   * lead statuses carry. Slice C points the STAFF decline dialog at this route, and a SALES rep
   * declining their own estimate has `read Estimate` and no `update Organization`; gating the
   * list behind the write grant would hand that rep an empty picker. Asserted so a later tighten
   * is a deliberate decision rather than a quiet regression.
   */
  it('lets a non-admin who can read an estimate read the list', async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/lost-reason-options').set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.lost_reason_options).toHaveLength(BUILT_IN_LOST_REASONS.length);
  });

  it('refuses an unauthenticated caller outright', async () => {
    const res = await request(app).get('/api/lost-reason-options');
    expect(res.status).toBe(401);
  });
});
