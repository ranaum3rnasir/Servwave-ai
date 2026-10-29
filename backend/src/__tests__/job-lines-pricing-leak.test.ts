/**
 * Job-lines pricing leak (Phase B §E follow-up, stage 4/6 of the line-items-calculator work).
 *
 * unit_cost/markup_percent are cost/margin data on a JobLineItem — the SAME class of figure
 * (estimate total_amount, per-line unit_price/line_total, invoice total_amount/amount_due) that
 * job.controller.ts's canSeePricing()/stripJobPricingForRequester() already gate behind `read
 * Invoice`. Before this fix, job-lines.controller.ts had NO pricing gate at all: a requester who
 * can `update` Job — e.g. a technician an admin opted into "Edit own jobs" (OWN_JOB-scoped),
 * WITHOUT also granting `read Invoice` — saw unit_cost/markup_percent on every line-items
 * response, AND could silently persist their own unit_cost/markup_percent submissions via
 * addLine/updateLine.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts), grants via setCachedGrants —
 * mirrors job-lines.test.ts's harness (same controller/routes) for the mock shapes (jobRow,
 * existingLine, mockPrisma accessor, OWN_JOB grant), and phaseB-job-pricing-leak2.test.ts's
 * canSeePricing precedent for the ABSENT-vs-visible assertion style.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, TRACKED_ITEM_FIXTURE } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  jobLineItem: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: {
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// The scope handlers (add/update/delete/reorder) now wrap their read-validate-write in
// prisma.$transaction with a fresh tx.job.findUnique read (race-safety fix) — mirrors
// job-lines.test.ts's identical helper. Since job.findUnique.mockResolvedValue(...) below
// returns the SAME row for every call, the tx's "fresh" read sees identical scopes to the guard
// load in every test here — this file isn't testing the race, just that pricing-leak stripping
// still behaves correctly now that the write path goes through a transaction.
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        job: {
          findUnique: mockPrisma.job.findUnique,
          update: mockPrisma.job.update,
        },
        // P1: addLine/updateLine are tx-wrapped for the stock movements — same delegation
        // convention as job-lines.test.ts keeps every pre-P1 assertion here green.
        jobLineItem: {
          create: mockPrisma.jobLineItem.create,
          update: mockPrisma.jobLineItem.update,
        },
        priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: {
          upsert: mockPrisma.stockBalance.upsert,
          updateMany: mockPrisma.stockBalance.updateMany,
          findUnique: mockPrisma.stockBalance.findUnique,
        },
        organization: { findUnique: mockPrisma.organization.findUnique },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';

// Mirrors job-lines.test.ts / defaultGrants.ts's OWN_JOB condition exactly.
const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };

// Grants a technician `read` + `update` + `manage_lines` Job (own-scope) WITHOUT `read Invoice` -
// the exact "opted into job-line management, but not into seeing pricing" shape from Phase B (an
// admin grants "Edit own jobs" per-user; that grant does NOT imply read Invoice).
//
// `manage_lines Job` joined this set with the technician-ownership split (PR 2), which moved the
// line-item and scope routes off `update Job`. The two are granted together, under the same
// condition, exactly as the real grants pair them - this file is about the PRICING strip, not
// about the gate, so it holds whichever actions get it through the door.
function grantTechUpdateJobWithoutInvoiceRead() {
  setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
    { action: 'read', subject: 'Job', conditions: OWN_JOB },
    { action: 'update', subject: 'Job', conditions: OWN_JOB },
    { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);
}

// An existing line with NO cost data recorded (unit_cost/markup_percent null) — the shape used
// by the "silently dropped, never persisted" tests, where the assertion is that a low-priv
// submission leaves them null/unset (i.e. nothing new was written).
function existingLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    job_id: JOB_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    stock_status: 'NOT_TRACKED',
    stock_location_id: null,
    ...over,
  };
}

// A line WITH real (non-null) cost data — used for the response-STRIP tests. Stripping an
// already-null field would prove nothing; this confirms the strip actually removes real data.
function existingLineWithCost(over: Record<string, unknown> = {}) {
  return existingLine({ unit_cost: 500, markup_percent: 50, ...over });
}

// The owner-chain + billing-input shape job-lines.controller's loadGuardedJob loads. Mirrors
// job-lines.test.ts's jobRow exactly.
function jobRow({
  sourcePlanId = null as string | null,
  techId = TEST_USERS.technician.id as string,
  salesId = TEST_USERS.sales.id as string,
  jobLineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  invoices = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  scopes = null as unknown[] | null,
} = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    source_plan_id: sourcePlanId,
    job_number: 'J00001',
    customer: { tax_exempt: false },
    assignees: [{ user_id: techId }],
    estimate: { lead: { lead_assignees: [{ user_id: salesId }] } },
    job_line_items: jobLineItems,
    invoices,
    scopes,
  };
}

// A scope-of-work fixture WITH real (non-null) internal_cost — mirrors existingLineWithCost's
// "stripping an already-null field would prove nothing" rationale above.
function scopeFixtureWithCost(over: Record<string, unknown> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000001',
    title: 'Permit fee',
    body: '',
    flat_price: 300,
    is_taxable: true,
    internal_cost: 150,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  // P1 stock defaults — untracked catalog + warn-mode org keep pre-P1 tests movement-free.
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/jobs/:id/line-items — list
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/jobs/:id/line-items — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets unit_cost/markup_percent ABSENT', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLineWithCost()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow's scoped lookup

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    const line = res.body.lines[0];
    expect(line.unit_cost).toBeUndefined();
    expect(line.markup_percent).toBeUndefined();
    // D13b (Spec A) widened this strip to sell price too — a price-blind requester sees a
    // materials list (description/quantity/item type), no money at all.
    expect(line.unit_price).toBeUndefined();
    expect(line.line_total).toBeUndefined();
    // Work detail is preserved.
    expect(line.description).toBe('AC Unit');
  });

  it('DISPATCHER (read Invoice) sees unit_cost/markup_percent on the list response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLineWithCost()] }));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const line = res.body.lines[0];
    expect(line.unit_cost).toBe(500);
    expect(line.markup_percent).toBe(50);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/:id/line-items — add
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/jobs/:id/line-items — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets unit_cost/markup_percent ABSENT on the add response', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.jobLineItem.create.mockResolvedValue({
      id: 'new-line-id', job_id: JOB_ID, sequence: 1, description: 'Compressor', quantity: 1,
      unit_price: 500, unit_cost: 300, markup_percent: 40, is_taxable: true, line_total: 500,
      discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
      price_book_item_id: null,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500 });

    expect(res.status).toBe(201);
    expect(res.body.line.unit_cost).toBeUndefined();
    expect(res.body.line.markup_percent).toBeUndefined();
    expect(res.body.line.description).toBe('Compressor');
  });

  it('DISPATCHER (read Invoice) sees unit_cost/markup_percent on the add response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.jobLineItem.create.mockResolvedValue({
      id: 'new-line-id', job_id: JOB_ID, sequence: 1, description: 'Compressor', quantity: 1,
      unit_price: 500, unit_cost: 300, markup_percent: 40, is_taxable: true, line_total: 500,
      discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
      price_book_item_id: null,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('dispatcher'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500, unit_cost: 300, markup_percent: 40 });

    expect(res.status).toBe(201);
    expect(res.body.line.unit_cost).toBe(300);
    expect(res.body.line.markup_percent).toBe(40);
  });

  it('a low-privilege submission of unit_cost/markup_percent is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500, unit_cost: 300, markup_percent: 40 });

    expect(res.status).toBe(201);
    // The create() call itself must never have received the submitted cost fields — the
    // persistence boundary, not just the response, must drop them.
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(createArg.data.unit_cost).toBeUndefined();
    expect(createArg.data.markup_percent).toBeUndefined();

    // Re-fetch as a requester who CAN see pricing: build the "actually persisted" row from the
    // SAME data Prisma's create() received (only keys present in that call would ever reach the
    // DB) and confirm they read back null/unset — proving the technician's submission never
    // persisted, not merely that their own (stripped) response hid it.
    const persistedLine = {
      id: 'new-line-id', job_id: JOB_ID, sequence: 1,
      description: createArg.data.description,
      quantity: Number(createArg.data.quantity),
      unit_price: Number(createArg.data.unit_price),
      unit_cost: createArg.data.unit_cost ?? null,
      markup_percent: createArg.data.markup_percent ?? null,
      is_taxable: createArg.data.is_taxable,
      line_total: Number(createArg.data.line_total),
      discount_type: null, discount_value: null, discount_amount: 0,
      item_type: createArg.data.item_type, price_book_item_id: createArg.data.price_book_item_id ?? null,
    };
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [persistedLine] }));

    const listRes = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('dispatcher'));
    expect(listRes.status).toBe(200);
    expect(listRes.body.lines[0].unit_cost).toBeNull();
    expect(listRes.body.lines[0].markup_percent).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/jobs/:id/line-items/:lineId — edit
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/jobs/:id/line-items/:lineId — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets unit_cost/markup_percent ABSENT on the update response', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLineWithCost()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.jobLineItem.update.mockResolvedValue(existingLineWithCost({ quantity: 3, line_total: 3000 }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.line.unit_cost).toBeUndefined();
    expect(res.body.line.markup_percent).toBeUndefined();
  });

  it('DISPATCHER (read Invoice) sees unit_cost/markup_percent on the update response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLineWithCost()] }));
    mockPrisma.jobLineItem.update.mockResolvedValue(existingLineWithCost({ quantity: 3, line_total: 3000 }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.line.unit_cost).toBe(500);
    expect(res.body.line.markup_percent).toBe(50);
  });

  it('a low-privilege submission of unit_cost/markup_percent is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.jobLineItem.update.mockResolvedValue(existingLine({ quantity: 3, line_total: 3000 }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3, unit_cost: 999, markup_percent: 55 });

    expect(res.status).toBe(200);
    // The update() call itself must never have received the submitted cost fields.
    const updateArg = mockPrisma.jobLineItem.update.mock.calls[0][0];
    expect(updateArg.data.unit_cost).toBeUndefined();
    expect(updateArg.data.markup_percent).toBeUndefined();

    // Re-fetch as a requester who CAN see pricing: the pre-existing null cost fields were never
    // overwritten by the low-priv PATCH — only what update() ACTUALLY received (no unit_cost/
    // markup_percent keys) would ever reach the DB.
    const persistedLine = existingLine({
      quantity: 3,
      line_total: 3000,
      unit_cost: updateArg.data.unit_cost ?? null,
      markup_percent: updateArg.data.markup_percent ?? null,
    });
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [persistedLine] }));

    const listRes = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('dispatcher'));
    expect(listRes.status).toBe(200);
    expect(listRes.body.lines[0].unit_cost).toBeNull();
    expect(listRes.body.lines[0].markup_percent).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET/POST/PATCH /api/jobs/:id/scopes — pricing leak (Stage 5/6 follow-up)
// internal_cost on a Job scope-of-work block (Job.scopes, scopes.ts) is the SAME class of
// cost/margin figure as unit_cost/markup_percent above, gated by the SAME canSeePricing check.
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/jobs/:id/scopes — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets internal_cost ABSENT', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow's scoped lookup

    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].internal_cost).toBeUndefined();
    // D13b (Spec A) widened this strip to sell price too (stripScopeMoney, not stripScopeCost).
    expect(res.body.scopes[0].flat_price).toBeUndefined();
    // Work detail is preserved.
    expect(res.body.scopes[0].title).toBe('Permit fee');
  });

  it('DISPATCHER (read Invoice) sees internal_cost on the list response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost()] }));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.scopes[0].internal_cost).toBe(150);
  });
});

describe('POST /api/jobs/:id/scopes — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets internal_cost ABSENT on the add response', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(201);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].internal_cost).toBeUndefined();
    expect(res.body.scopes[0].title).toBe('Permit fee');
  });

  it('DISPATCHER (read Invoice) sees internal_cost on the add response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('dispatcher'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(201);
    expect(res.body.scopes[0].internal_cost).toBe(150);
  });

  it('a low-privilege submission of internal_cost is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(201);
    // The job.update() call itself must never have received the technician's submitted
    // internal_cost — the persistence boundary, not just the response, must drop it.
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes).toHaveLength(1);
    expect(updateArg.data.scopes[0].internal_cost).toBeNull();
    // D13b (Spec A): a price-blind submitter can't set a price on a brand-new scope either —
    // it persists null, not the 300 they submitted (see updateScope's PATCH sibling below for
    // the case where a PRE-EXISTING price must survive untouched instead of being nulled).
    expect(updateArg.data.scopes[0].flat_price).toBeNull();
    // Work detail is still saved.
    expect(updateArg.data.scopes[0].title).toBe('Permit fee');
  });
});

describe('PATCH /api/jobs/:id/scopes/:idx — pricing leak', () => {
  it('requester granted update Job but NOT read Invoice gets internal_cost ABSENT on the update response', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ flat_price: 500 });

    expect(res.status).toBe(200);
    expect(res.body.scopes[0].internal_cost).toBeUndefined();
  });

  it('DISPATCHER (read Invoice) sees internal_cost on the update response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost()] }));
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('dispatcher'))
      .send({ flat_price: 500 });

    expect(res.status).toBe(200);
    expect(res.body.scopes[0].internal_cost).toBe(150);
  });

  it('a low-privilege submission of internal_cost is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    // Pre-existing scope has NO cost recorded — proves the technician's submitted 999 never lands.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost({ internal_cost: null })] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ flat_price: 500, internal_cost: 999 });

    expect(res.status).toBe(200);
    // The job.update() call itself must never have received the technician's submitted
    // internal_cost.
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes[0].internal_cost).toBeNull();
    // D13b (Spec A): flat_price is now write-locked the same way — the submitted 500 is
    // dropped BEFORE the merge, so the PRE-EXISTING price (300, from scopeFixtureWithCost's
    // default) survives untouched rather than being overwritten by the low-priv submission.
    expect(updateArg.data.scopes[0].flat_price).toBe(300);
  });

  it('a low-privilege edit to an unrelated field does NOT clobber a pre-existing internal_cost', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    // An admin previously set a real internal_cost on this scope.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixtureWithCost()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.update.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee (updated)' }); // never mentions internal_cost

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    // Untouched, not wiped, by an edit that never mentioned the field.
    expect(updateArg.data.scopes[0].internal_cost).toBe(150);
    expect(updateArg.data.scopes[0].title).toBe('Permit fee (updated)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1 stock key — never a cost surface
// ════════════════════════════════════════════════════════════════════════════
describe('`stock` response key — retired (LO-4)', () => {
  it('a low-priv qty edit no longer exposes a `stock` object, and the line stays cost-stripped', async () => {
    mockAuthAs('technician');
    grantTechUpdateJobWithoutInvoiceRead();
    // UNSYNCED so the C2 legacy freeze does not fire (a SYNCED qty edit now 400s).
    const line = existingLineWithCost({
      quantity: 2,
      price_book_item_id: TRACKED_ITEM_FIXTURE.id,
      stock_status: 'UNSYNCED',
      stock_location_id: null,
    });
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [line] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow's scoped lookup
    mockPrisma.jobLineItem.update.mockResolvedValue(line);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 4 });

    expect(res.status).toBe(200);
    // LO-4 retired the qty-delta stock movement — no movement fires and there is no `stock` key.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(res.body.stock).toBeUndefined();
    // The line response is still cost-stripped for a low-priv actor.
    expect(res.body.line.unit_cost).toBeUndefined();
    expect(res.body.line.markup_percent).toBeUndefined();
  });
});
