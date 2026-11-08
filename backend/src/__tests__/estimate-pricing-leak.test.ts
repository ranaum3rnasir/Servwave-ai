/**
 * Estimate pricing leak (v12 plan §2a-6 — the cost-leak security fix, same class of bug as
 * job-lines-pricing-leak.test.ts / the invoice-lines pricing-leak follow-up).
 *
 * unit_cost/markup_percent on an EstimateLineItem, and internal_cost on an Estimate scope-of-work
 * block, are cost/margin data — the SAME class of figure job.controller.ts's canSeePricing() /
 * stripLinesPricing() and invoice-lines.controller.ts's stripInvoiceCost() already gate behind
 * `read Invoice`. Before this fix, estimateDetailSelect unconditionally selected unit_cost on
 * every line item with NO stripping anywhere: a requester who can `read`/`update` Estimate — e.g.
 * a technician an admin opted into "Edit own estimates" (a conditioned per-user grant), WITHOUT
 * also granting `read Invoice` — saw unit_cost on every estimate response (getById, create,
 * update, duplicate, revise), AND could silently persist their own unit_cost/markup_percent/
 * internal_cost submissions via the new granular line/scope endpoints.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts), grants via setCachedGrants —
 * mirrors job-lines-pricing-leak.test.ts's harness for the mock shapes and assertion style.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, ESTIMATE_FIXTURE } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// The granular line/scope handlers wrap their read-validate-write in prisma.$transaction with a
// fresh tx.estimate.findUnique/findFirst read (race-safety convention borrowed from job/invoice-
// lines) — mirrors job-lines-pricing-leak.test.ts's identical helper.
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: {
          findUnique: mockPrisma.estimate.findUnique,
          update: mockPrisma.estimate.update,
        },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          create: mockPrisma.estimateLineItem.create,
          update: mockPrisma.estimateLineItem.update,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000002';

// Mirrors defaultGrants.ts's OWN_ESTIMATE_VIA_LEAD condition exactly.
const OWN_ESTIMATE_VIA_LEAD = { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } };

// Grants a technician `read` + `update` Estimate (own-scope, via the parent lead) WITHOUT `read
// Invoice` — the exact "opted into estimate-line management, but not into seeing pricing" shape
// from Phase B (an admin grants "Edit own estimates" per-user; that grant does NOT imply read
// Invoice).
function grantTechEstimateWithoutInvoiceRead() {
  setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
    { action: 'read', subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD },
    { action: 'update', subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);
}

// A line item WITH real (non-null) cost data — used for the response-STRIP tests. Stripping an
// already-null field would prove nothing; this confirms the strip actually removes real data.
function lineWithCost(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 500,
    markup_percent: 50,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    ...over,
  };
}

// A scope-of-work fixture WITH real (non-null) internal_cost — same "stripping an already-null
// field would prove nothing" rationale as lineWithCost above.
function scopeWithCost(over: Record<string, unknown> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000002',
    title: 'Permit fee',
    body: '',
    flat_price: 300,
    is_taxable: true,
    internal_cost: 150,
    ...over,
  };
}

// The estimate.controller.ts (getById/create/update/…) fixture shape — includes lead_assignees
// so a row-scoped (OWN_ESTIMATE_VIA_LEAD) reader's ownership can be asserted either way.
function estimateFixture({
  ownerId = TEST_USERS.sales.id as string,
  lineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  scopes = null as unknown[] | null,
} = {}) {
  return {
    ...ESTIMATE_FIXTURE,
    lead: { ...ESTIMATE_FIXTURE.lead, lead_assignees: [{ user_id: ownerId }] },
    line_items: lineItems,
    scopes,
  };
}

// The billing-inputs shape estimate-lines.controller's loadGuardedEstimate loads.
function estimateGuardRow({
  ownerId = TEST_USERS.sales.id as string,
  status = 'DRAFT' as string,
  lineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  scopes = null as unknown[] | null,
} = {}) {
  return {
    id: ESTIMATE_ID,
    status,
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    scopes,
    line_items: lineItems,
    lead: { lead_assignees: [{ user_id: ownerId }] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/estimates/:id — the ORIGINAL named leak (estimateDetailSelect, no stripping at all)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id — pricing leak', () => {
  it('requester granted update Estimate but NOT read Invoice gets unit_cost/markup_percent ABSENT', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateFixture({ ownerId: TEST_USERS.technician.id, lineItems: [lineWithCost()], scopes: [scopeWithCost()] }),
    );

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.line_items).toHaveLength(1);
    const line = res.body.estimate.line_items[0];
    expect(line.unit_cost).toBeUndefined();
    expect(line.markup_percent).toBeUndefined();
    expect(res.body.estimate.scopes[0].internal_cost).toBeUndefined();
    // Work detail is preserved.
    expect(line.description).toBe('AC Unit');
    expect(line.unit_price).toBe(1000);
    expect(res.body.estimate.scopes[0].flat_price).toBe(300);
  });

  it('ADMIN (read Invoice) sees unit_cost/markup_percent/internal_cost on the response', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateFixture({ lineItems: [lineWithCost()], scopes: [scopeWithCost()] }),
    );

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.line_items[0].unit_cost).toBe(500);
    expect(res.body.estimate.line_items[0].markup_percent).toBe(50);
    expect(res.body.estimate.scopes[0].internal_cost).toBe(150);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estimates/:id/line-items — add (new granular endpoint)
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/line-items — pricing leak', () => {
  it('requester granted update Estimate but NOT read Invoice gets unit_cost/markup_percent ABSENT on the add response', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID }); // canAccessRow's scoped lookup
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([lineWithCost()]);
    mockPrisma.estimate.update.mockResolvedValue(
      estimateFixture({ ownerId: TEST_USERS.technician.id, lineItems: [lineWithCost()] }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500 });

    expect(res.status).toBe(201);
    expect(res.body.estimate.line_items[0].unit_cost).toBeUndefined();
    expect(res.body.estimate.line_items[0].markup_percent).toBeUndefined();
  });

  it('ADMIN (read Invoice) sees unit_cost/markup_percent on the add response', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateGuardRow());
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([lineWithCost()]);
    mockPrisma.estimate.update.mockResolvedValue(estimateFixture({ lineItems: [lineWithCost()] }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500, unit_cost: 300, markup_percent: 40 });

    expect(res.status).toBe(201);
    expect(res.body.estimate.line_items[0].unit_cost).toBe(500);
    expect(res.body.estimate.line_items[0].markup_percent).toBe(50);
  });

  it('a low-privilege submission of unit_cost/markup_percent is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(estimateFixture({ ownerId: TEST_USERS.technician.id }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Compressor', quantity: 1, unit_price: 500, unit_cost: 300, markup_percent: 40 });

    expect(res.status).toBe(201);
    // The create() call itself must never have received the submitted cost fields — the
    // persistence boundary, not just the response, must drop them.
    const createArg = mockPrisma.estimateLineItem.create.mock.calls[0][0];
    expect(createArg.data.unit_cost).toBeUndefined();
    expect(createArg.data.markup_percent).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/estimates/:id/line-items/:lineId — edit (new granular endpoint)
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/estimates/:id/line-items/:lineId — pricing leak', () => {
  it('requester granted update Estimate but NOT read Invoice gets unit_cost/markup_percent ABSENT on the update response', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id, lineItems: [lineWithCost()] }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([lineWithCost({ quantity: 3, line_total: 3000 })]);
    mockPrisma.estimate.update.mockResolvedValue(
      estimateFixture({ ownerId: TEST_USERS.technician.id, lineItems: [lineWithCost({ quantity: 3, line_total: 3000 })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.estimate.line_items[0].unit_cost).toBeUndefined();
    expect(res.body.estimate.line_items[0].markup_percent).toBeUndefined();
  });

  it('a low-privilege submission of unit_cost/markup_percent is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id, lineItems: [lineWithCost({ unit_cost: null, markup_percent: null })] }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([lineWithCost({ quantity: 3, unit_cost: null, markup_percent: null })]);
    mockPrisma.estimate.update.mockResolvedValue(estimateFixture({ ownerId: TEST_USERS.technician.id }));

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3, unit_cost: 999, markup_percent: 55 });

    expect(res.status).toBe(200);
    // The update() call itself must never have received the submitted cost fields.
    const updateArg = mockPrisma.estimateLineItem.update.mock.calls[0][0];
    expect(updateArg.data.unit_cost).toBeUndefined();
    expect(updateArg.data.markup_percent).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET/POST/PATCH /api/estimates/:id/scopes — pricing leak (new granular endpoints)
// internal_cost on an Estimate scope-of-work block (Estimate.scopes, scopes.ts) is the SAME
// class of cost/margin figure as unit_cost/markup_percent above, gated by the SAME canSeePricing.
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id/scopes — pricing leak', () => {
  it('requester granted update Estimate but NOT read Invoice gets internal_cost ABSENT', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id, scopes: [scopeWithCost()] }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}/scopes`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].internal_cost).toBeUndefined();
    expect(res.body.scopes[0].title).toBe('Permit fee');
    expect(res.body.scopes[0].flat_price).toBe(300);
  });

  it('DISPATCHER (read Invoice) sees internal_cost on the list response', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateGuardRow({ scopes: [scopeWithCost()] }));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}/scopes`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.scopes[0].internal_cost).toBe(150);
  });
});

describe('POST /api/estimates/:id/scopes — pricing leak', () => {
  it('a low-privilege submission of internal_cost is silently dropped, not persisted', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateGuardRow({ ownerId: TEST_USERS.technician.id }));
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
    mockPrisma.estimate.update.mockResolvedValue(estimateFixture({ ownerId: TEST_USERS.technician.id }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(201);
    // The FIRST estimate.update() call is the scope-push write (recomputeAndPersist's totals
    // write is the second) — that first call must never have received internal_cost.
    const scopeWriteArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWriteArg.data.scopes).toHaveLength(1);
    expect(scopeWriteArg.data.scopes[0].internal_cost).toBeNull();
    // Work detail is still saved.
    expect(scopeWriteArg.data.scopes[0].title).toBe('Permit fee');
    expect(scopeWriteArg.data.scopes[0].flat_price).toBe(300);
  });
});

describe('PATCH /api/estimates/:id/scopes/:idx — pricing leak', () => {
  it('a low-privilege edit to an unrelated field does NOT clobber a pre-existing internal_cost', async () => {
    mockAuthAs('technician');
    grantTechEstimateWithoutInvoiceRead();
    // An admin previously set a real internal_cost on this scope.
    mockPrisma.estimate.findUnique.mockResolvedValue(
      estimateGuardRow({ ownerId: TEST_USERS.technician.id, scopes: [scopeWithCost()] }),
    );
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
    mockPrisma.estimate.update.mockResolvedValue(estimateFixture({ ownerId: TEST_USERS.technician.id }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee (updated)' }); // never mentions internal_cost

    expect(res.status).toBe(200);
    const scopeWriteArg = mockPrisma.estimate.update.mock.calls[0][0];
    // Untouched, not wiped, by an edit that never mentioned the field.
    expect(scopeWriteArg.data.scopes[0].internal_cost).toBe(150);
    expect(scopeWriteArg.data.scopes[0].title).toBe('Permit fee (updated)');
  });
});
