/**
 * #2053 slice 1 — optional items on estimates (line items + scope-of-work blocks), the editor +
 * totals slice. FROZEN per bfd-reproduce Pass B — do not edit to make these pass; fix the
 * production code instead.
 *
 * PRD (gh issue #2053, Q14-Q19 + "Implementation decisions"): line items AND scope blocks gain a
 * pair of flags, `is_optional` / `is_selected`. A non-optional line is always selected. An
 * unselected optional line/scope is excluded from subtotal, tax, total (and the deposit, which is
 * derived FROM total_amount by estimate.controller.ts's `resolveDepositAmount` — once total_amount
 * is selection-correct, the deposit follows with no separate defect surface, so this file does not
 * duplicate that math). calculateTotals (estimate.controller.ts) is the single totals source;
 * invoice-totals.ts's recomputeInvoiceTotals must agree with it on identical input.
 *
 * Confirmed CONFIRMED-ABSENT on prod == this worktree's HEAD (reproduce-a.md): `is_optional`/
 * `is_selected` sent over the real API are silently stripped by zod (`validate()` calls
 * `schema.parse(req.body)` and REPLACES req.body — see middleware/validate.ts:16), never persisted,
 * never counted. This file proves that at the actual persistence boundary (the `data` argument a
 * mutating handler passes to the mocked Prisma client), not at the response body — a GET response
 * would echo back whatever a fully-mocked prisma.estimate.findUnique is told to return regardless
 * of whether the schema/columns exist, which would pass "green" today for the wrong reason (see
 * red flag #2 in bfd-reproduce SKILL.md: "a test that fails because of missing setup is not a
 * reproduction" — the inverse also holds: a test that PASSES because the mock papers over a real
 * gap proves nothing).
 *
 * Harness mirrors estimate-lines.test.ts / estimate-pricing-leak.test.ts: supertest against `app`,
 * prisma fully mocked (setup.ts), a $transaction shim that hands the callback the same top-level
 * mocks as `tx`, real DEFAULT_GRANTS-derived abilities via mockAuthAs / setCachedGrants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { calculateTotals } from '../controllers/estimate.controller';
import { recomputeInvoiceTotals, type LineForTotals, type ScopeForTotals } from '../lib/invoice-totals';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  lead: { findUnique: ReturnType<typeof vi.fn> };
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';

// estimate-lines.controller's `tx` proxy — mirrors estimate-lines.test.ts's setupTransaction()
// verbatim (only the sub-objects this file's handlers touch).
function setupLinesTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
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

// estimate.controller's create() `tx` proxy — mirrors estimates.test.ts's inline pattern.
function setupCreateTransaction(createMock: ReturnType<typeof vi.fn>) {
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      estimate: { findFirst: vi.fn().mockResolvedValue(null), create: createMock },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    return fn(tx);
  });
}

// estimate-lines.controller's loadGuardedEstimate select shape — mirrors estimate-lines.test.ts's
// guardRow() verbatim.
function guardRow({
  status = 'DRAFT' as string,
  lineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  scopes = null as unknown[] | null,
  tax_rate = 0.1 as number,
  version = 1 as number,
  subtotal = 1000 as number,
  tax_amount = 100 as number,
  total_amount = 1100 as number,
  discount_amount = 0 as number,
  invoices = [] as { status: string }[],
  lockOnSend = false as boolean,
} = {}) {
  return {
    id: ESTIMATE_ID,
    status,
    version,
    tax_rate,
    discount_type: null,
    discount_value: null,
    subtotal,
    tax_amount,
    total_amount,
    discount_amount,
    scopes,
    organization: { lock_on_send: lockOnSend },
    invoices,
    line_items: lineItems,
  };
}

// A line row, extended with the two flags this suite is pinning (default: a plain non-optional,
// always-selected line — today's only shape).
function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
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
    is_optional: false,
    is_selected: true,
    ...over,
  };
}

// A scope-of-work fixture, extended with the two flags.
function scope(over: Record<string, unknown> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000003',
    title: 'Permit fee',
    body: '',
    flat_price: 100,
    is_taxable: true,
    internal_cost: null,
    is_optional: false,
    is_selected: true,
    ...over,
  };
}

function respondingEstimate() {
  return { ...ESTIMATE_FIXTURE, id: ESTIMATE_ID, line_items: [], scopes: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin'); // ADMIN bypasses CASL — every case below is about the flags, not gating.
});

// ════════════════════════════════════════════════════════════════════════════
// Case 1 — POST create round-trips the flags (today: silently stripped by zod)
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 1: create persists is_optional/is_selected', () => {
  it('POST /api/estimates writes is_optional/is_selected onto each created line item', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    setupCreateTransaction(createMock);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.1,
        line_items: [
          { description: 'Base line', quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: false },
          { description: 'Add-on', quantity: 2, unit_price: 50, is_taxable: true, is_optional: true, is_selected: false },
        ],
      });

    expect(res.status).toBe(201);
    const createdLines = createMock.mock.calls[0][0].data.line_items.create;
    expect(createdLines[0].is_optional).toBe(true);
    expect(createdLines[0].is_selected).toBe(false);
    expect(createdLines[1].is_optional).toBe(true);
    expect(createdLines[1].is_selected).toBe(false);
  });

  it('POST /api/estimates/:id/scopes writes is_optional/is_selected onto the pushed scope block', async () => {
    setupLinesTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Optional scope', flat_price: 200, is_taxable: true, is_optional: true, is_selected: false });

    expect(res.status).toBe(201);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes[0].is_optional).toBe(true);
    expect(scopeWrite.data.scopes[0].is_selected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 2 — granular PATCH round-trips the flags (today: no-ops, per reproduce-a.md §3)
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 2: granular PATCH persists is_optional/is_selected', () => {
  it('PATCH /api/estimates/:id/line-items/:lineId writes the flags sent alone', async () => {
    setupLinesTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line({ is_optional: false, is_selected: true })] }));
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ is_optional: true, is_selected: false })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_optional: true, is_selected: false });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.estimateLineItem.update.mock.calls[0][0];
    expect(updateArg.data.is_optional).toBe(true);
    expect(updateArg.data.is_selected).toBe(false);
  });

  it('PATCH /api/estimates/:id/scopes/:idx merges the flags sent alone onto the existing scope', async () => {
    setupLinesTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope({ is_optional: false, is_selected: true })] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ is_optional: true, is_selected: false });

    expect(res.status).toBe(200);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes[0].is_optional).toBe(true);
    expect(scopeWrite.data.scopes[0].is_selected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 3 — totals follow selection (Q16). Fixture shared across this block: A ($100 non-optional,
// always selected), B ($100 optional+selected), C ($75 optional+UNselected), scope ($200,
// taxable, optional+UNselected). tax_rate 0.1. Correct subtotal = A + B = $200 (C and the scope
// excluded); tax = $20 (taxable-selected subset only); total = $220.
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 3: totals exclude optional-unselected lines and scopes', () => {
  it('create(): the real calculateTotals() call sums only non-optional + optional-selected lines', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    setupCreateTransaction(createMock);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.1,
        line_items: [
          { description: 'A - base', quantity: 1, unit_price: 100, is_taxable: true, is_optional: false, is_selected: true },
          { description: 'B - optional, selected', quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: true },
          { description: 'C - optional, unselected', quantity: 1, unit_price: 75, is_taxable: true, is_optional: true, is_selected: false },
        ],
      });

    expect(res.status).toBe(201);
    const data = createMock.mock.calls[0][0].data;
    expect(data.subtotal).toBe(200);
    expect(data.tax_amount).toBe(20);
    expect(data.total_amount).toBe(220);
  });

  it('updateLine(): flipping C from selected to unselected DROPS the subtotal to $200 (today: unconditional sum stays $275)', async () => {
    // Direction matters here: today's recomputeAndPersist sums every line unconditionally, so a
    // scenario where the "correct" and "buggy" answers happen to coincide (e.g. flipping an
    // excluded line TO included, when the buggy sum already included it) would pass BOTH before
    // and after the fix — a false green. Deselecting a previously-selected line is the only
    // direction where the buggy (sum-everything) and correct (selection-filtered) answers diverge.
    setupLinesTransaction();
    const a = line({ id: 'aa000000-0000-0000-0000-000000000010', sequence: 1, description: 'A', unit_price: 100, line_total: 100, is_optional: false, is_selected: true });
    const b = line({ id: 'aa000000-0000-0000-0000-000000000011', sequence: 2, description: 'B', unit_price: 100, line_total: 100, is_optional: true, is_selected: true });
    const cLineId = 'aa000000-0000-0000-0000-000000000012';
    const cBefore = line({ id: cLineId, sequence: 3, description: 'C', unit_price: 75, line_total: 75, is_optional: true, is_selected: true });
    const cAfter = { ...cBefore, is_selected: false };

    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [a, b, cBefore], tax_rate: 0.1, subtotal: 275, tax_amount: 27.5, total_amount: 302.5 }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    // Recompute reads back the FRESH line set with C now UNselected.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([a, b, cAfter]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${cLineId}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(200);
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.subtotal).toBe(200);
  });

  it('addScope(): a taxable optional-unselected $200 scope contributes $0 — subtotal stays $200', async () => {
    setupLinesTransaction();
    const a = line({ id: 'aa000000-0000-0000-0000-000000000020', sequence: 1, unit_price: 100, line_total: 100, is_optional: false, is_selected: true });
    const b = line({ id: 'aa000000-0000-0000-0000-000000000021', sequence: 2, unit_price: 100, line_total: 100, is_optional: true, is_selected: true });

    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [a, b], scopes: [], tax_rate: 0.1, subtotal: 200, tax_amount: 20, total_amount: 220 }),
    );
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([a, b]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Extra scope', flat_price: 200, is_taxable: true, is_optional: true, is_selected: false });

    expect(res.status).toBe(201);
    // Second estimate.update() call is recomputeAndPersist (first is the scope-array push).
    const totalsArg = mockPrisma.estimate.update.mock.calls[1][0];
    expect(totalsArg.data.subtotal).toBe(200);
    expect(totalsArg.data.tax_amount).toBe(20);
    expect(totalsArg.data.total_amount).toBe(220);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 4 — a non-optional line is always selected (Solution decisions, Q14): sending
// is_optional:false, is_selected:false must normalise to selected=true, and be counted.
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 4: a non-optional line is always selected', () => {
  it('is_optional:false, is_selected:false normalises to is_selected:true and is counted in the subtotal', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    setupCreateTransaction(createMock);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0,
        line_items: [
          { description: 'Always included', quantity: 1, unit_price: 500, is_taxable: false, is_optional: false, is_selected: false },
        ],
      });

    expect(res.status).toBe(201);
    const data = createMock.mock.calls[0][0].data;
    expect(data.line_items.create[0].is_selected).toBe(true);
    expect(data.subtotal).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 5 — single-source rule: calculateTotals (estimate.controller.ts) and
// recomputeInvoiceTotals (lib/invoice-totals.ts) must derive the SAME correct,
// selection-filtered totals for the identical input. Today both ignore is_optional/is_selected
// entirely (neither's line/scope interface even declares the fields), so both wrongly sum
// everything — this fails on the CORRECT-VALUE assertions, not the equality one (the two helpers
// currently agree with each other, just agree on the wrong number).
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 5: calculateTotals and recomputeInvoiceTotals agree on selection-filtered totals', () => {
  it('same selection-bearing input, same $200 subtotal / $20 tax / $220 total from both helpers', () => {
    type SelectableLine = LineForTotals & { is_optional: boolean; is_selected: boolean };
    type SelectableScope = ScopeForTotals & { is_optional: boolean; is_selected: boolean };

    const lines: SelectableLine[] = [
      { quantity: 1, unit_price: 100, is_taxable: true, is_optional: false, is_selected: true },
      { quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: true },
      { quantity: 1, unit_price: 75, is_taxable: true, is_optional: true, is_selected: false },
    ];
    const scopes: SelectableScope[] = [
      { flat_price: 200, is_taxable: true, is_optional: true, is_selected: false },
    ];

    const estimateTotals = calculateTotals(lines, 0.1, undefined, scopes);
    expect(estimateTotals.subtotal).toBe(200);
    expect(estimateTotals.taxAmount).toBe(20);
    expect(estimateTotals.totalAmount).toBe(220);

    const invoiceTotals = recomputeInvoiceTotals({ lines, scopes, taxRate: 0.1, taxExempt: false });
    expect(invoiceTotals.subtotal).toBe(200);
    expect(invoiceTotals.tax_amount).toBe(20);
    expect(invoiceTotals.total_amount).toBe(220);

    // The two helpers must never drift — true both before and after the fix, but only meaningful
    // once each is independently correct (the assertions above).
    expect(estimateTotals.subtotal).toBe(invoiceTotals.subtotal);
    expect(estimateTotals.totalAmount).toBe(invoiceTotals.total_amount);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 6 — regression guard: a plain estimate with NO optional lines must total byte-identical
// to evidence/totals-baseline-regression-fixture.json (prod fixture C00023-4). GREEN today AND
// after slice 1 ships.
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 6: regression — totals for an estimate with no optional lines are unchanged', () => {
  it('2 plain lines ($240 + $150), tax_rate 0.07 -> subtotal 390 / tax 27.3 / total 417.3 (baseline fixture)', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    setupCreateTransaction(createMock);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.07,
        line_items: [
          { description: 'Line A', quantity: 1, unit_price: 240, is_taxable: true },
          { description: 'Line B', quantity: 1, unit_price: 150, is_taxable: true },
        ],
      });

    expect(res.status).toBe(201);
    const data = createMock.mock.calls[0][0].data;
    expect(data.subtotal).toBe(390);
    expect(data.tax_amount).toBe(27.3);
    expect(data.total_amount).toBe(417.3);
    expect(data.discount_amount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 7 — price-blind requester (stripDocumentCost path, no `read Pricing`): the optional flags
// are not cost fields and must remain visible; unit_cost/markup_percent still stripped. GREEN
// today AND after (stripDocumentCost only ever deletes named cost keys — see lib/scopes.ts:71-76
// — so an unrelated key it has never heard of survives untouched, both before and after the
// migration adds real columns for it).
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 7: price-blind requester still sees the (non-cost) optional flags', () => {
  // Mirrors estimate-pricing-leak.test.ts's grantTechEstimateWithoutInvoiceRead(): a technician
  // opted into "Edit own estimates" (own-scope read/update Estimate) WITHOUT `read Pricing`.
  const OWN_ESTIMATE_VIA_LEAD = { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } };
  function grantPriceBlindTechnicianEstimateAccess() {
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD },
      { action: 'update', subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD },
      // Deliberately NO `read Pricing` grant.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
  }

  it('GET /api/estimates/:id keeps is_optional/is_selected while stripping unit_cost/markup_percent', async () => {
    mockAuthAs('technician');
    grantPriceBlindTechnicianEstimateAccess();
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      lead: { ...ESTIMATE_FIXTURE.lead, lead_assignees: [{ user_id: TEST_USERS.technician.id }] },
      line_items: [line({ unit_cost: 500, markup_percent: 50, is_optional: true, is_selected: false })],
      scopes: [scope({ internal_cost: 150, is_optional: true, is_selected: true })],
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const respLine = res.body.estimate.line_items[0];
    expect(respLine.unit_cost).toBeUndefined();
    expect(respLine.markup_percent).toBeUndefined();
    expect(respLine.is_optional).toBe(true);
    expect(respLine.is_selected).toBe(false);
    const respScope = res.body.estimate.scopes[0];
    expect(respScope.internal_cost).toBeUndefined();
    expect(respScope.is_optional).toBe(true);
    expect(respScope.is_selected).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 8 — public estimate JSON (estimatePublicSelect) shape unchanged today: no cost fields.
// Slice 2 owns the "Optional add-ons" section; this only pins the regression floor. GREEN today
// AND after slice 1 (which does not touch the public select).
// ════════════════════════════════════════════════════════════════════════════
describe('#2053 case 8: public estimate select carries no cost fields (regression floor for slice 2)', () => {
  it('estimatePublicSelect (estimate.controller.ts) never selects unit_cost/markup_percent/internal_cost', () => {
    const source = readFileSync(join(__dirname, '../controllers/estimate.controller.ts'), 'utf8');
    const startIdx = source.indexOf('const estimatePublicSelect = {');
    expect(startIdx).toBeGreaterThan(-1);
    // Balanced-brace extraction of the object literal, mirroring the balanced-paren extraction
    // customer-contact-redaction-guard.test.ts uses for res.json(...) call args.
    const openIdx = source.indexOf('{', startIdx);
    let depth = 0;
    let endIdx = openIdx;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    const block = source.slice(startIdx, endIdx + 1);
    expect(block).not.toMatch(/\bunit_cost\s*:/);
    expect(block).not.toMatch(/\bmarkup_percent\s*:/);
    expect(block).not.toMatch(/\binternal_cost\s*:/);
    expect(block).not.toMatch(/\blabor_hours\s*:/);
    expect(block).not.toMatch(/\boverhead_(mode|value)\s*:/);
  });
});
