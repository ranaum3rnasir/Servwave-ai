/**
 * B6 + B7 — Invoice line-item + billing endpoints.
 *
 *   B6 (gated `manage_lines` Invoice — Dispatcher/Tech/Sales own-scoped):
 *     POST   /api/invoices/:id/line-items          — add a line (custom or price-book snapshot)
 *     DELETE /api/invoices/:id/line-items/:lineId   — delete a line
 *
 *   B7 (gated `update` Invoice — Admin/Dispatcher ONLY; Tech & Sales 403):
 *     PATCH  /api/invoices/:id/line-items/:lineId   — edit one line
 *     PATCH  /api/invoices/:id/billing              — edit tip / invoice-level discount
 *
 * CRITICAL invariants asserted here:
 *   - Adding from / editing a line NEVER calls prisma.priceBookItem.update / .upsert
 *     (no write-back to the catalog/inventory).
 *   - manage_lines (add/delete) vs update (edit/tip) split: Tech & Sales carry manage_lines
 *     but NOT update, so they reach add/delete but 403 on edit-line + billing.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts), grants via setCachedGrants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  CUSTOMER_FIXTURE,
  JOB_FIXTURE,
  INVOICE_FIXTURE,
} from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';
import { addScopeSchema, updateLineSchema } from '../controllers/invoice-lines.controller';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  invoice: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  priceBookItem: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: {
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const INVOICE_ID = INVOICE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';

// The owner chain the controller's findUnique loads, so canAccessRow / status guards have data.
function invoiceRow({
  status = 'DRAFT' as string,
  techId = TEST_USERS.technician.id as string,
  salesId = TEST_USERS.sales.id as string,
  totalAmount = 1080,
  amountDue = 1080,
  credits = [] as Array<{ amount: number }>,
}: {
  status?: string;
  techId?: string;
  salesId?: string;
  totalAmount?: number;
  amountDue?: number;
  credits?: Array<{ amount: number }>;
} = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status,
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: totalAmount,
    amount_due: amountDue,
    tax_rate: 0.08,
    tax_amount: 0,
    discount_amount: 0,
    tip: 0,
    credits,
    job_id: JOB_FIXTURE.id,
    customer: { tax_exempt: false },
    job: {
      assignees: [{ user_id: techId }],
      customer: { tax_exempt: false },
      estimate: { lead: { lead_assignees: [{ user_id: salesId }] } },
    },
  };
}

// Existing lines on the invoice (re-fetched before recompute).
function existingLines() {
  return [
    {
      id: LINE_ID,
      invoice_id: INVOICE_ID,
      sequence: 1,
      description: 'AC Unit',
      quantity: 1,
      unit_price: 1000,
      is_taxable: true,
      line_total: 1000,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'SERVICE',
      price_book_item_id: null,
      unit_cost: null,
      stock_status: 'NOT_TRACKED',
      stock_location_id: null,
    },
  ];
}

// invoiceDetailSelect-shaped object returned after a mutation.
function detailAfter(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status: 'DRAFT',
    kind: 'STANDARD',
    tip: 0,
    subtotal: 1000,
    discount_amount: 0,
    tax_rate: 0.08,
    tax_amount: 80,
    deposit_credit: 0,
    total_amount: 1080,
    amount_due: 1080,
    line_items: existingLines(),
    refunds: [],
    credits: [],
    customer: null,
    job: null,
    payments: [],
    ...overrides,
  };
}

/**
 * $transaction runs the callback synchronously with a tx proxy delegating to the mocked delegates.
 */
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) => fn({
    invoiceLineItem: {
      findMany: mockPrisma.invoiceLineItem.findMany,
      findFirst: mockPrisma.invoiceLineItem.findFirst,
      create: mockPrisma.invoiceLineItem.create,
      update: mockPrisma.invoiceLineItem.update,
      delete: mockPrisma.invoiceLineItem.delete,
      deleteMany: mockPrisma.invoiceLineItem.deleteMany,
    },
    invoice: {
      findUnique: mockPrisma.invoice.findUnique,
      findFirst: mockPrisma.invoice.findFirst,
      update: mockPrisma.invoice.update,
    },
    // SERV10X-59 — INVOICE_EDITED write on a material edit to an already-sent invoice.
    timelineEvent: { create: mockPrisma.timelineEvent.create },
    // P1 stock delegates (addLine deduct-on-add / updateLine qty-delta / deleteLine return).
    priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst },
    stockMovement: { create: mockPrisma.stockMovement.create },
    stockBalance: {
      upsert: mockPrisma.stockBalance.upsert,
      updateMany: mockPrisma.stockBalance.updateMany,
      findUnique: mockPrisma.stockBalance.findUnique,
    },
    organization: { findUnique: mockPrisma.organization.findUnique },
  } as any));
}

// A scope-of-work fixture, as stored in the JSONB Invoice.scopes column.
function scopeFixture(overrides: Partial<{
  id: string;
  title: string;
  body: string;
  flat_price: number | null;
  is_taxable: boolean;
  internal_cost: number | null;
}> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000001',
    title: 'Permit fee',
    body: '',
    flat_price: 300,
    is_taxable: true,
    internal_cost: null,
    ...overrides,
  };
}

/**
 * Queues the exact invoice.findUnique call sequence a scope handler makes (mirrored inside
 * $transaction via the invoice.findUnique proxy in setupTransaction):
 *   1. loadGuardedInvoice's guard-shaped read (outside the tx).
 *   2. the handler's own pre-mutation `{ scopes }` re-read (inside the tx).
 *   3. recomputeAndPersist's post-mutation `{ scopes }` re-read (inside the tx).
 * `after` simulates what the DB would now contain post-write (the mock doesn't apply real writes).
 */
function mockScopeReads(before: unknown[], after: unknown[], guardOverrides: Parameters<typeof invoiceRow>[0] = {}) {
  mockPrisma.invoice.findUnique
    .mockResolvedValueOnce(invoiceRow(guardOverrides))
    .mockResolvedValueOnce({ scopes: before })
    .mockResolvedValueOnce({ scopes: after });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  // P1 stock defaults: catalog lookups resolve nothing (free-text/untracked behavior), org
  // policy = warn mode — pre-P1 tests keep their exact movement-free behavior.
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
  // Default: after the mutation, re-fetch lines returns the (current) line set.
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
  // updateLine loads the target line first.
  mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(existingLines()[0]);
  mockPrisma.invoiceLineItem.create.mockResolvedValue({ id: 'new-line' });
  mockPrisma.invoiceLineItem.update.mockResolvedValue({ id: LINE_ID });
  mockPrisma.invoiceLineItem.delete.mockResolvedValue({ id: LINE_ID });
  mockPrisma.invoice.update.mockResolvedValue(detailAfter());
});

// ════════════════════════════════════════════════════════════════════════════
// B6 — POST /api/invoices/:id/line-items  (add a line)
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/line-items — add (manage_lines)', () => {
  it('ADMIN adds a custom line, persists with next sequence, recomputes totals', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra labor', item_type: 'SERVICE', quantity: 2, unit_price: 100, is_taxable: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    // next sequence = max(existing)+1 = 2; line_total = 2*100 = 200.
    expect(createArg.data.sequence).toBe(2);
    expect(Number(createArg.data.line_total)).toBe(200);
    expect(createArg.data.invoice_id).toBe(INVOICE_ID);
    // Invoice totals recomputed + persisted.
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
    expect(res.body.invoice.line_items).toBeDefined();
    expect(res.body.invoice.tip).toBeDefined();
    // NO write-back to the catalog/inventory.
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
  });

  it('adds from a price_book_item_id as an INDEPENDENT snapshot — stores ref id, NEVER writes back to the catalog', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());

    const PB_ID = 'bb000000-0000-0000-0000-000000000009';
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({
        description: 'Filter (from catalog)',
        item_type: 'MATERIAL',
        quantity: 3,
        unit_price: 25,
        is_taxable: true,
        price_book_item_id: PB_ID,
      });

    expect(res.status).toBe(200);
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    // Snapshot values copied onto the line; ref id stored.
    expect(createArg.data.description).toBe('Filter (from catalog)');
    expect(Number(createArg.data.unit_price)).toBe(25);
    expect(createArg.data.price_book_item_id).toBe(PB_ID);
    expect(createArg.data.item_type).toBe('MATERIAL');
    // CRITICAL: no write-back to the catalog/inventory.
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
  });

  it('add: persists unit_cost + markup_percent with the exact submitted values, and invoiceDetailSelect selects both back', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const newLine = {
      id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Compressor',
      quantity: 1, unit_price: 300, is_taxable: true, line_total: 300, discount_type: null,
      discount_value: null, discount_amount: 0, item_type: 'MATERIAL', price_book_item_id: null,
      unit_cost: 180, markup_percent: 25,
    };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([...existingLines(), newLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [...existingLines(), newLine] })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({
        description: 'Compressor', item_type: 'MATERIAL', quantity: 1, unit_price: 300,
        is_taxable: true, unit_cost: 180, markup_percent: 25,
      });

    expect(res.status).toBe(200);
    // Persisted with the exact submitted values.
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    expect(Number(createArg.data.unit_cost)).toBe(180);
    expect(Number(createArg.data.markup_percent)).toBe(25);
    // invoiceDetailSelect's line_items.select now requests both fields (the gap this stage fixes).
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(updateArg.select.line_items.select.unit_cost).toBe(true);
    expect(updateArg.select.line_items.select.markup_percent).toBe(true);
    // Once selected, both come back in the response with the submitted values.
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === 'new-line');
    expect(Number(returnedLine.unit_cost)).toBe(180);
    expect(Number(returnedLine.markup_percent)).toBe(25);
  });

  it('applies a per-line discount + taxable correctly in the recompute', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    // After adding, the re-fetch returns BOTH lines so the recompute sees the new one.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      ...existingLines(),
      {
        id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Discounted part',
        quantity: 1, unit_price: 200, is_taxable: true, line_total: 200,
        discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 20, item_type: 'MATERIAL',
        price_book_item_id: null, unit_cost: null,
      },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Discounted part', item_type: 'MATERIAL', quantity: 1, unit_price: 200, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 10 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // subtotal = 1000 (line1) + (200 - 20) (line2 effective) = 1180
    expect(Number(updateArg.data.subtotal)).toBe(1180);
    // tax (8% of taxable 1180) = 94.4
    expect(Number(updateArg.data.tax_amount)).toBeCloseTo(94.4, 2);
    // total = 1180 + 94.4 = 1274.4
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1274.4, 2);
  });

  it('allows a SENT invoice (P2: editable until settled) → 200, creates the line', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalled();
  });

  it('PARTIAL invoice: editing recomputes amount_due = new total − amount_paid (payment preserved), stays PARTIAL', async () => {
    mockAuthAs('admin');
    // Old: total 1080, paid 500 → amount_due 580 (amount_paid derived = 500).
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PARTIAL', totalAmount: 1080, amountDue: 580 }));
    // Re-fetch after add returns 2 lines → subtotal 1200, tax 96, new total 1296.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      ...existingLines(),
      { id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Extra', quantity: 1, unit_price: 200,
        is_taxable: true, line_total: 200, discount_type: null, discount_value: null, discount_amount: 0,
        item_type: 'SERVICE', price_book_item_id: null, unit_cost: null },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra', quantity: 1, unit_price: 200, is_taxable: true });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // new total 1296 − amount_paid 500 = 796 due; still owes → PARTIAL.
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1296, 2);
    expect(Number(updateArg.data.amount_due)).toBeCloseTo(796, 2);
    expect(updateArg.data.status).toBe('PARTIAL');
  });

  // SRVW-97/SRVW-84 coupling guard: same money as the sibling above, but held as a write-off
  // credit instead of cash. Deliberately NOT `.toBe('PARTIAL')` like the sibling - with credits
  // subtracted in both places (SRVW-84), amountPaid derives to 1080 - 0 - 580 - 500 = 0, so
  // settledStatus is null (invoice-lines.controller.ts) and the status key is spread out of the
  // write entirely; the row simply stays PARTIAL untouched in the DB. The (796, status-absent)
  // pair is the unique signature of a both-places implementation: credits in neither place gives
  // 796 but status 'PARTIAL'; credits in amountPaid only gives 1296; credits in amountDue only
  // gives 296. If this goes red, it is a cross-card defect in SRVW-84's derivation - report it,
  // do not patch invoice-lines.controller.ts here.
  it('a line edit on an invoice carrying a write-off credit recomputes amount_due without resurrecting the credit as cash', async () => {
    mockAuthAs('admin');
    // Old: total 1080, amount_due 580, one write-off Credit of 500 (SRVW-97's REFUND_WRITE_OFF).
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: 'PARTIAL', totalAmount: 1080, amountDue: 580, credits: [{ amount: 500 }] }),
    );
    // Re-fetch after add returns 2 lines → subtotal 1200, tax 96, new total 1296.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      ...existingLines(),
      { id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Extra', quantity: 1, unit_price: 200,
        is_taxable: true, line_total: 200, discount_type: null, discount_value: null, discount_amount: 0,
        item_type: 'SERVICE', price_book_item_id: null, unit_cost: null },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra', quantity: 1, unit_price: 200, is_taxable: true });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1296, 2);
    expect(Number(updateArg.data.amount_due)).toBeCloseTo(796, 2);
    expect(updateArg.data.status).toBeUndefined();
    expect(updateArg.data).not.toHaveProperty('paid_at');
  });

  it('blocks a VOIDED invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'VOIDED' }));
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('blocks a PAID invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(404);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (qty <= 0) → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 0, unit_price: 10 });
    expect(res.status).toBe(400);
  });
});

// ─── B6 RBAC matrix: add-line is gated `manage_lines` ─────────────────────────
describe('POST /api/invoices/:id/line-items — RBAC (manage_lines)', () => {
  it('DISPATCHER (unconditional manage_lines) can add', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('dispatcher'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalled();
  });

  it('TECHNICIAN with a per-user manage_lines grant can add on OWN job invoice', async () => {
    mockAuthAs('technician');
    // Strict model (#253): a technician has NO manage_lines by default — an admin opts them in
    // per-user. Seed that own-scoped grant so this proves the granted + own-scoped path works.
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Invoice', conditions: OWN_VIA_JOB },
      { action: 'manage_lines', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    // canAccessRow(Invoice) → scoped invoice.findFirst resolves truthy for an owned row.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalled();
  });

  it('TECHNICIAN has NO manage_lines by default (strict) → 403 at the route guard, no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('TECHNICIAN (granted manage_lines) still gets 403 on a FOREIGN invoice, never mutates', async () => {
    mockAuthAs('technician');
    // Granted the own-scoped capability, but the invoice isn't theirs → canAccessRow denies it.
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Invoice', conditions: OWN_VIA_JOB },
      { action: 'manage_lines', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ techId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // canAccessRow → false
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('SALES can add on OWN-lead invoice', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalled();
  });

  it('SALES gets 403 on a FOREIGN invoice, never mutates', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ salesId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B6 — DELETE /api/invoices/:id/line-items/:lineId
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/invoices/:id/line-items/:lineId — delete (manage_lines)', () => {
  it('ADMIN deletes a line (scoped to invoice + tenant) and recomputes', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    // After delete, no lines remain.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Delete is scoped to the line id + the parent invoice id (no cross-invoice deletes).
    const delArg = mockPrisma.invoiceLineItem.deleteMany.mock.calls[0]?.[0]
      ?? mockPrisma.invoiceLineItem.delete.mock.calls[0]?.[0];
    expect(JSON.stringify(delArg.where)).toContain(LINE_ID);
    expect(JSON.stringify(delArg.where)).toContain(INVOICE_ID);
    // Recompute on an empty line set → zeros, persisted.
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(Number(updateArg.data.subtotal)).toBe(0);
    expect(Number(updateArg.data.total_amount)).toBe(0);
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('allows deleting a line on a SENT invoice (P2) → 200', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
  });

  it('blocks deleting a line on a PAID invoice → 400, no delete', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.delete).not.toHaveBeenCalled();
    expect(mockPrisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('TECHNICIAN (granted manage_lines per-user) can delete on OWN job invoice; 403 on foreign (no mutation)', async () => {
    // Strict model (#253): manage_lines is a per-user opt-in for technicians, not a role default.
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    const grantTech = () =>
      setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
        { action: 'read', subject: 'Invoice', conditions: OWN_VIA_JOB },
        { action: 'manage_lines', subject: 'Invoice', conditions: OWN_VIA_JOB },
      ] as any);
    // own
    mockAuthAs('technician');
    grantTech();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    let res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'));
    expect(res.status).toBe(200);

    // foreign
    vi.clearAllMocks();
    clearPermissionCache();
    setupTransaction();
    mockAuthAs('technician');
    grantTech();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ techId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.delete).not.toHaveBeenCalled();
    expect(mockPrisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('SALES can delete on OWN-lead invoice; 403 on foreign', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    let res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('sales'));
    expect(res.status).toBe(200);

    vi.clearAllMocks();
    clearPermissionCache();
    setupTransaction();
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ salesId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B7 — PATCH /api/invoices/:id/line-items/:lineId  (edit one line — update Invoice ONLY)
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/invoices/:id/line-items/:lineId — edit line (update Invoice only)', () => {
  it('ADMIN edits qty + recomputes line_total + invoice totals', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    // The patched line is fetched/scoped to the invoice, then re-fetch returns the new set.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { ...existingLines()[0], quantity: 3, line_total: 3000 },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
    const lineUpd = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    // line update is scoped to the invoice (no cross-invoice edit).
    expect(JSON.stringify(lineUpd.where)).toContain(LINE_ID);
    // recomputed line_total = 3 * 1000 = 3000
    expect(Number(lineUpd.data.line_total)).toBe(3000);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(Number(updateArg.data.subtotal)).toBe(3000);
    // NEVER writes back to the catalog.
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
  });

  it('edit: persists a description change (was a silent no-op before the schema added the field)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const updatedLine = { ...existingLines()[0], description: 'Compressor replacement' };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([updatedLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [updatedLine] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'Compressor replacement' });

    expect(res.status).toBe(200);
    const lineUpdateArg = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    expect(lineUpdateArg.data.description).toBe('Compressor replacement');
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === LINE_ID);
    expect(returnedLine.description).toBe('Compressor replacement');
  });

  it('edit: persists markup_percent (and unit_cost) with the exact submitted values, and both are returned', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const updatedLine = { ...existingLines()[0], unit_cost: 220, markup_percent: 35 };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([updatedLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [updatedLine] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_cost: 220, markup_percent: 35 });

    expect(res.status).toBe(200);
    const lineUpdateArg = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    expect(Number(lineUpdateArg.data.unit_cost)).toBe(220);
    expect(Number(lineUpdateArg.data.markup_percent)).toBe(35);
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === LINE_ID);
    expect(Number(returnedLine.unit_cost)).toBe(220);
    expect(Number(returnedLine.markup_percent)).toBe(35);
  });

  // #2012 (L1) — invoice-lines' updateLineSchema previously omitted item_type entirely; zod's
  // non-strict z.object silently STRIPPED it from a submitted PATCH (200, nothing changed) instead
  // of rejecting it. This mirrors job-lines.controller.ts's identical schema/handler field.
  it('edit: item_type round-trips (accepted + written), and an invalid value 400s without writing', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const updatedLine = { ...existingLines()[0], item_type: 'MATERIAL' };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([updatedLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [updatedLine] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ item_type: 'MATERIAL' });

    expect(res.status).toBe(200);
    const lineUpdateArg = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    expect(lineUpdateArg.data.item_type).toBe('MATERIAL');
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === LINE_ID);
    expect(returnedLine.item_type).toBe('MATERIAL');

    const updateCallsBefore = mockPrisma.invoiceLineItem.update.mock.calls.length;
    const badRes = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ item_type: 'NOT_A_TYPE' });

    expect(badRes.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update.mock.calls.length).toBe(updateCallsBefore);
  });

  it('DISPATCHER (has update Invoice) can edit a line', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ unit_price: 1500 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
  });

  it('TECHNICIAN gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 2 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('SALES gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('sales'))
      .send({ quantity: 2 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('DISPATCHER 403s on a FOREIGN invoice via per-instance canAccessRow (owner-scoped grant)', async () => {
    mockAuthAs('dispatcher');
    // Narrow DISPATCHER to an owner-scoped update/read grant (the kind org-settings can persist).
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'DISPATCHER', [
      { action: 'read', subject: 'Invoice', conditions: OWN_VIA_JOB },
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ techId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ quantity: 2 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('allows editing a line on a SENT invoice (P2) → 200', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
  });

  it('editing a PARTIAL invoice so the balance is fully covered → amount_due 0 + status PAID (locks)', async () => {
    mockAuthAs('admin');
    // Old: total 1080, paid 900 → amount_due 180 (amount_paid derived = 900).
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PARTIAL', totalAmount: 1080, amountDue: 180 }));
    // Re-fetch returns one line at 500 → new total 540 (500 + 8% tax) < 900 paid.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { ...existingLines()[0], unit_price: 500, line_total: 500 },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 500 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(Number(updateArg.data.amount_due)).toBe(0);
    expect(updateArg.data.status).toBe('PAID');
  });

  // ── SRVW-84: a credit note is a write-off, not a payment ──────────────────
  // credit() lowers amount_due and writes a Credit row, but never a Payment row. The recompute
  // back-derives collected cash from the invoice's own money fields, so without netting credits
  // out it reads a written-off balance as money in the bank and stamps PAID on an invoice where
  // nothing was ever collected.

  it('credit-noted SENT invoice: a line edit does not persist PAID and stamps no paid_at', async () => {
    mockAuthAs('admin');
    // Total 1080, fully credit-noted to a 0 balance, zero payments. credit() leaves it SENT.
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: 'SENT', totalAmount: 1080, amountDue: 0, credits: [{ amount: 1080 }] }),
    );
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'x' });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // Nothing was collected, so no settled status and no paid_at may be written.
    expect(updateArg.data.status).toBeUndefined();
    expect(updateArg.data.paid_at).toBeUndefined();
    // The write-off still covers the balance.
    expect(Number(updateArg.data.amount_due)).toBe(0);
  });

  it('credit + real cash: the credit is not read as cash and the invoice stays PARTIAL', async () => {
    mockAuthAs('admin');
    // Total 1080: $400 really collected, $680 written off, so amount_due is 0 but only 400 is cash.
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: 'PARTIAL', totalAmount: 1080, amountDue: 0, credits: [{ amount: 680 }] }),
    );
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'x' });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // Status tracks the CASH position: $680 of the $1080 was never collected, so it is not PAID.
    expect(updateArg.data.status).toBe('PARTIAL');
    expect(updateArg.data.paid_at).toBeUndefined();
    expect(Number(updateArg.data.amount_due)).toBe(0);
  });

  it('the credit survives the edit: raising the total leaves only the uncredited remainder due', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: 'SENT', totalAmount: 1080, amountDue: 0, credits: [{ amount: 1080 }] }),
    );
    // Re-fetch returns 2 lines -> subtotal 1200, tax 96, new total 1296.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      ...existingLines(),
      { id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Extra', quantity: 1, unit_price: 200,
        is_taxable: true, line_total: 200, discount_type: null, discount_value: null, discount_amount: 0,
        item_type: 'SERVICE', price_book_item_id: null, unit_cost: null },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'x' });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // The $1080 write-off is not reversed by the edit - only the new $216 is owed.
    expect(Number(updateArg.data.amount_due)).toBe(216);
    // Honest note: 216 alone does NOT discriminate the fix. Whenever amountPaid does not hit its
    // 0 clamp the credits term cancels out of amount_due, so the old code lands on 216 too. The
    // discriminating assertion is the status write: the old code reads the $1080 write-off as
    // cash and persists PARTIAL; the new code knows nothing was collected and writes no status.
    expect(updateArg.data.status).toBeUndefined();
    expect(updateArg.data.paid_at).toBeUndefined();
  });

  it('the guarded invoice read requests credits (wiring lock)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'x' });

    expect(res.status).toBe(200);
    // The mocked Prisma returns the fixture regardless of `select`, so a missing entry in
    // invoiceGuardSelect would leave the fix inert in production with every other test green.
    expect(mockPrisma.invoice.findUnique.mock.calls[0][0].select.credits).toBeTruthy();
  });

  it('two-edit characterization: a total-reducing edit no longer locks, and the clamped cash is not recoverable', async () => {
    mockAuthAs('admin');
    // Total 1080, $200 really collected, $400 written off -> amount_due 480, PARTIAL.
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: 'PARTIAL', totalAmount: 1080, amountDue: 480, credits: [{ amount: 400 }] }),
    );
    // EDIT A: cut the line to 500 -> subtotal 500, tax 40, new total 540.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { ...existingLines()[0], unit_price: 500, line_total: 500 },
    ]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const resA = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 500 });

    expect(resA.status).toBe(200);
    const dataA = mockPrisma.invoice.update.mock.calls[0][0].data;
    expect(Number(dataA.total_amount)).toBe(540);
    expect(Number(dataA.amount_due)).toBe(0);
    // Before the fix this persisted PAID + paid_at, which LOCKS the invoice and makes edit B
    // impossible. Keying status on cash only ($340 of the $540 still uncollected) keeps it open.
    expect(dataA.status).toBe('PARTIAL');
    expect(dataA.paid_at).toBeUndefined();

    // EDIT B: raise the total back to 1080, off the state edit A actually persisted.
    mockPrisma.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        status: (dataA.status as string) ?? 'PARTIAL',
        totalAmount: Number(dataA.total_amount),
        amountDue: Number(dataA.amount_due),
        credits: [{ amount: 400 }],
      }),
    );
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const resB = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 1000 });

    expect(resB.status).toBe(200);
    const dataB = mockPrisma.invoice.update.mock.calls[1][0].data;
    // 540 is WRONG. The truth is 480 (1080 total - 200 real cash - 400 credit). Edit A clamped
    // amount_due at 0, and amount_due is the only persisted anchor the cash figure is derived
    // from, so $60 of real cash was destroyed there: edit B re-derives 140 collected, not 200,
    // and over-bills the customer by 60. This is the structural loss documented in amountPaidOf's
    // JSDoc - it is locked here deliberately, not endorsed. Closing it needs a persisted
    // collected-cash column, which is out of scope for this card.
    expect(Number(dataB.amount_due)).toBe(540);
    expect(dataB.status).toBe('PARTIAL');
  });

  it('blocks editing a line on a VOIDED invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'VOIDED' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });
    expect(res.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST/PATCH /api/invoices/:id/line-items — pricing leak (unit_cost/markup_percent)
//
// unit_cost/markup_percent on an InvoiceLineItem are the SAME class of cost/margin figure as
// job-lines.controller.ts's identically-named fields (see job-lines-pricing-leak.test.ts) and as
// this file's own scopes[].internal_cost fix above — invoiceDetailSelect's line_items.select
// already embeds both fields (Stage 1a), and stripInvoiceScopeCost only ever redacted `scopes`,
// never `line_items`, so a low-privilege response leaked cost/margin data on every line.
//
// NOTE on reachability: same as the scopes block above — a technician/sales user with
// manage_lines/update Invoice but WITHOUT read Invoice cannot occur via any grantable path today
// (userCapabilities.ts's Invoice entries are all impliesRead: true). These tests force
// invoice.findFirst to resolve truthy (mirroring the scopes-leak harness) purely to exercise the
// body-write + response-strip code path in isolation — defense-in-depth coverage for a
// combination that cannot occur today but would silently go live the moment either invariant
// above changes.
// ════════════════════════════════════════════════════════════════════════════
describe('POST/PATCH /api/invoices/:id/line-items — pricing leak (unit_cost/markup_percent)', () => {
  it('POST: a low-privilege submission of unit_cost/markup_percent is silently dropped from the write, and never echoed in the response', async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'manage_lines', subject: 'Invoice', conditions: OWN_VIA_JOB },
      // deliberately NO `read Invoice` grant — see block comment above.
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID }); // forces canAccessRow past its own read-grant gate
    const newLine = {
      id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Compressor',
      quantity: 1, unit_price: 300, is_taxable: true, line_total: 300, discount_type: null,
      discount_value: null, discount_amount: 0, item_type: 'MATERIAL', price_book_item_id: null,
      unit_cost: 180, markup_percent: 25,
    };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([...existingLines(), newLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [...existingLines(), newLine] })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('technician'))
      .send({
        description: 'Compressor', item_type: 'MATERIAL', quantity: 1, unit_price: 300,
        is_taxable: true, unit_cost: 180, markup_percent: 25,
      });

    expect(res.status).toBe(200);
    // Write-side: the technician's submitted cost/margin fields must never land in the create call.
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    expect(createArg.data.unit_cost).toBeUndefined();
    expect(createArg.data.markup_percent).toBeUndefined();
    // Description/pricing fields they ARE allowed to touch still persist.
    expect(createArg.data.description).toBe('Compressor');
    expect(Number(createArg.data.unit_price)).toBe(300);
    // Response-side: even though the mocked "current DB state" carries real cost/margin figures
    // (simulating what a privileged viewer would see), the technician's own response must not.
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === 'new-line');
    expect(returnedLine.unit_cost).toBeUndefined();
    expect(returnedLine.markup_percent).toBeUndefined();
  });

  it('PATCH: a low-privilege submission of unit_cost/markup_percent is silently dropped from the write, and never echoed in the response', async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
      // deliberately NO `read Invoice` grant.
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    const updatedLine = { ...existingLines()[0], unit_cost: 220, markup_percent: 35 };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([updatedLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [updatedLine] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ unit_cost: 220, markup_percent: 35 });

    expect(res.status).toBe(200);
    const lineUpdateArg = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    expect(lineUpdateArg.data.unit_cost).toBeUndefined();
    expect(lineUpdateArg.data.markup_percent).toBeUndefined();
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === LINE_ID);
    expect(returnedLine.unit_cost).toBeUndefined();
    expect(returnedLine.markup_percent).toBeUndefined();
  });

  it('PATCH: a low-privilege edit that never mentions unit_cost/markup_percent leaves the write payload without those keys (pre-existing values untouched)', async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    // An admin previously set real unit_cost/markup_percent on this line.
    const existingWithCost = { ...existingLines()[0], unit_cost: 220, markup_percent: 35 };
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(existingWithCost);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([{ ...existingWithCost, quantity: 5, line_total: 5000 }]);
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 5 }); // never mentions unit_cost/markup_percent

    expect(res.status).toBe(200);
    const lineUpdateArg = mockPrisma.invoiceLineItem.update.mock.calls[0][0];
    // Key absent entirely (not just undefined) — Prisma leaves an omitted column unchanged, so
    // the pre-existing DB value survives untouched.
    expect('unit_cost' in lineUpdateArg.data).toBe(false);
    expect('markup_percent' in lineUpdateArg.data).toBe(false);
    expect(Number(lineUpdateArg.data.quantity)).toBe(5);
  });

  it('DISPATCHER (read Invoice) sees unit_cost/markup_percent on the add response — contrast case', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const newLine = {
      id: 'new-line', invoice_id: INVOICE_ID, sequence: 2, description: 'Compressor',
      quantity: 1, unit_price: 300, is_taxable: true, line_total: 300, discount_type: null,
      discount_value: null, discount_amount: 0, item_type: 'MATERIAL', price_book_item_id: null,
      unit_cost: 180, markup_percent: 25,
    };
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([...existingLines(), newLine]);
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [...existingLines(), newLine] })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('dispatcher'))
      .send({
        description: 'Compressor', item_type: 'MATERIAL', quantity: 1, unit_price: 300,
        is_taxable: true, unit_cost: 180, markup_percent: 25,
      });

    expect(res.status).toBe(200);
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    expect(Number(createArg.data.unit_cost)).toBe(180);
    const returnedLine = res.body.invoice.line_items.find((l: any) => l.id === 'new-line');
    expect(Number(returnedLine.unit_cost)).toBe(180);
    expect(Number(returnedLine.markup_percent)).toBe(25);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B7 — PATCH /api/invoices/:id/line-items/reorder (persist a full drag-and-drop reorder —
// update Invoice ONLY, the SAME gate as edit-line/billing above; Tech & Sales carry manage_lines
// but not update, so they 403 here too). The frontend splices a within-group drag back into the
// FULL flat top-to-bottom order before calling this — the backend has no notion of "groups"; it
// just persists sequence 1..N exactly as given, atomically, or 400s without touching anything.
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/invoices/:id/line-items/reorder — reorder (update Invoice only)', () => {
  const LINE_A = LINE_ID; // 'aa000000-0000-0000-0000-000000000001'
  const LINE_B = 'aa000000-0000-0000-0000-000000000002';
  const LINE_C = 'aa000000-0000-0000-0000-000000000003';

  function threeLines() {
    return [
      { ...existingLines()[0], id: LINE_A, sequence: 1, description: 'A' },
      { ...existingLines()[0], id: LINE_B, sequence: 2, description: 'B' },
      { ...existingLines()[0], id: LINE_C, sequence: 3, description: 'C' },
    ];
  }

  beforeEach(() => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(threeLines());
    mockPrisma.invoiceLineItem.update.mockResolvedValue({});
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));
  });

  it('a valid full permutation reassigns sequence 1..N to match the given order exactly', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_C, LINE_A, LINE_B] });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalledTimes(3);
    const sequenceOf = (id: string) =>
      mockPrisma.invoiceLineItem.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0].data.sequence;
    expect(sequenceOf(LINE_C)).toBe(1);
    expect(sequenceOf(LINE_A)).toBe(2);
    expect(sequenceOf(LINE_B)).toBe(3);
    // Every write is scoped to the line AND its parent invoice — no cross-invoice reorder.
    mockPrisma.invoiceLineItem.update.mock.calls.forEach((c: any) => expect(c[0].where.invoice_id).toBe(INVOICE_ID));
    // Same {invoice} response shape updateLine returns, so callers don't need special-casing.
    expect(res.body.invoice).toBeDefined();
  });

  it('reflects the new order on a fresh read (invoiceDetailSelect line_items, ordered by sequence)', async () => {
    mockAuthAs('admin');
    // Simulate what the DB now contains post-write (the mock doesn't apply real writes).
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(
        detailAfter({
          ...args.data,
          line_items: [
            { ...threeLines()[2], sequence: 1 },
            { ...threeLines()[0], sequence: 2 },
            { ...threeLines()[1], sequence: 3 },
          ],
        }),
      ),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_C, LINE_A, LINE_B] });

    expect(res.status).toBe(200);
    expect(res.body.invoice.line_items.map((l: any) => l.id)).toEqual([LINE_C, LINE_A, LINE_B]);
  });

  it('400s when the submitted order is missing one of the current line ids, no mutation', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B] }); // LINE_C missing
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains an id that is not one of this invoice\'s lines, no mutation', async () => {
    mockAuthAs('admin');
    const FOREIGN_ID = 'ff000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B, FOREIGN_ID] });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains a duplicate id, no mutation', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_A, LINE_B] }); // LINE_C missing, LINE_A duplicated
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('a mixed MATERIAL+SERVICE set of lines reorders correctly across the full set (no "groups" on the backend)', async () => {
    mockAuthAs('admin');
    const LINE_D = 'aa000000-0000-0000-0000-000000000004';
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { ...threeLines()[0], item_type: 'SERVICE' },
      { ...threeLines()[1], item_type: 'MATERIAL' },
      { ...threeLines()[2], item_type: 'SERVICE' },
      { ...existingLines()[0], id: LINE_D, sequence: 4, item_type: 'MATERIAL' },
    ]);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_B, LINE_D, LINE_A, LINE_C] }); // MATERIAL, MATERIAL, SERVICE, SERVICE

    expect(res.status).toBe(200);
    const sequenceOf = (id: string) =>
      mockPrisma.invoiceLineItem.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0].data.sequence;
    expect(sequenceOf(LINE_B)).toBe(1);
    expect(sequenceOf(LINE_D)).toBe(2);
    expect(sequenceOf(LINE_A)).toBe(3);
    expect(sequenceOf(LINE_C)).toBe(4);
  });

  it('blocks a locked (PAID) invoice → 400, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A] });
    expect(res.status).toBe(404);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  // ─── RBAC: reorder is gated `update` Invoice — the SAME B7 gate edit-line/billing use ───
  it('DISPATCHER (has update Invoice) can reorder', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('dispatcher'))
      .send({ order: [LINE_C, LINE_B, LINE_A] });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalledTimes(3);
  });

  it('TECHNICIAN gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('technician'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('SALES gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('sales'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('DISPATCHER 403s on a FOREIGN invoice via per-instance canAccessRow (owner-scoped grant)', async () => {
    mockAuthAs('dispatcher');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'DISPATCHER', [
      { action: 'read', subject: 'Invoice', conditions: OWN_VIA_JOB },
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ techId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('dispatcher'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B7 — PATCH /api/invoices/:id/billing  (tip / invoice discount — update Invoice ONLY)
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/invoices/:id/billing — tip + discount (update Invoice only)', () => {
  it('ADMIN sets a tip → recomputes total/amount_due (tip post-tax, untaxed)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tip: 50 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // subtotal 1000, tax 80, tip 50 (NOT taxed) → total 1130, amount_due 1130 (deposit_credit 0).
    expect(Number(updateArg.data.tip)).toBe(50);
    expect(Number(updateArg.data.tax_amount)).toBeCloseTo(80, 2);
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1130, 2);
    expect(Number(updateArg.data.amount_due)).toBeCloseTo(1130, 2);
  });

  it('ADMIN edits invoice-level discount_amount → recomputes', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ discount_amount: 100 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // subtotal 1000, less 100 discount = 900; tax on prorated taxable (all taxable) = 72; total 972.
    expect(Number(updateArg.data.discount_amount)).toBe(100);
    expect(Number(updateArg.data.tax_amount)).toBeCloseTo(72, 2);
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(972, 2);
  });

  it('ADMIN sets tax_rate (jurisdiction dropdown) → persists fraction + recomputes tax_amount', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow()); // tax_rate 0.08
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines()); // 1 line, 1000 taxable
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.05 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // tax_rate is a FRACTION; 1000 taxable × 0.05 = 50 tax → total 1050.
    expect(Number(updateArg.data.tax_rate)).toBeCloseTo(0.05, 4);
    expect(Number(updateArg.data.tax_amount)).toBeCloseTo(50, 2);
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1050, 2);
  });

  it('ADMIN sets tax_rate 0 (No tax) → tax_amount 0', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(Number(updateArg.data.tax_rate)).toBe(0);
    expect(Number(updateArg.data.tax_amount)).toBe(0);
    expect(Number(updateArg.data.total_amount)).toBeCloseTo(1000, 2);
  });

  it('DISPATCHER can edit billing', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('dispatcher'))
      .send({ tip: 10 });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
  });

  it('TECHNICIAN gets 403 at the route guard (no update grant)', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('technician'))
      .send({ tip: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('SALES gets 403 at the route guard (no update grant)', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('sales'))
      .send({ tip: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('blocks a non-DRAFT invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tip: 10 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tip: 10 });
    expect(res.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Stage 5 — Invoice scope-of-work CRUD (B6 add/delete manage_lines; B7 update-only).
// Invoice.scopes is a JSONB array of flat-priced, non-line-item blocks (scopes.ts). Every
// handler reuses loadGuardedInvoice (404 tenant / 403 owner / 400 locked, for free) and
// recomputeAndPersist (which now also folds scopes into the totals — see the regression
// describe block at the bottom of this file).
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/scopes — add (manage_lines)', () => {
  it('ADMIN adds a scope with a flat_price and the invoice totals reflect it', async () => {
    mockAuthAs('admin');
    mockScopeReads([], [scopeFixture({ title: 'Permit fee', flat_price: 300 })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });

    expect(res.status).toBe(200);
    // First invoice.update call is the handler's own scopes-column write.
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes).toHaveLength(1);
    expect(scopeUpdateArg.data.scopes[0].title).toBe('Permit fee');
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBe(300);
    expect(typeof scopeUpdateArg.data.scopes[0].id).toBe('string');
    expect(scopeUpdateArg.data.scopes[0].id.length).toBeGreaterThan(0);
    // subtotal = 1000 (existing line) + 300 (scope) = 1300; tax 8% of 1300 = 104; total 1404.
    expect(Number(res.body.invoice.subtotal)).toBe(1300);
    expect(Number(res.body.invoice.tax_amount)).toBeCloseTo(104, 2);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(1404, 2);
  });

  it('ADMIN adds an unpriced scope (flat_price omitted) — totals unchanged, scope stored with a generated id', async () => {
    mockAuthAs('admin');
    mockScopeReads([], [scopeFixture({ title: 'Inspect roof', flat_price: null })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Inspect roof' });

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes).toHaveLength(1);
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBeNull();
    expect(typeof scopeUpdateArg.data.scopes[0].id).toBe('string');
    expect(scopeUpdateArg.data.scopes[0].id.length).toBeGreaterThan(0);
    // Unpriced scope contributes nothing — totals stay at the existing line's own numbers.
    expect(Number(res.body.invoice.subtotal)).toBe(1000);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(1080, 2);
  });

  it('TECHNICIAN has no manage_lines by default (strict) → 403, no scope persisted', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('blocks adding a scope on a PAID (locked) invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });
    expect(res.status).toBe(404);
    // Asserts the specific loadGuardedInvoice message (not just status 404) so this genuinely
    // distinguishes "route wired but invoice not found" from "route not wired at all" — the
    // app-wide fallback 404 handler also returns status 404, with body { error: 'Not found' }.
    expect(res.body.error).toBe('Invoice not found');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (empty title) → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/invoices/:id/scopes/:idx — update (update Invoice only)', () => {
  it("ADMIN updates a scope's flat_price and totals recompute", async () => {
    mockAuthAs('admin');
    const before = [scopeFixture({ flat_price: 300 })];
    const after = [scopeFixture({ flat_price: 500 })];
    mockScopeReads(before, after);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBe(500);
    // Untouched fields are preserved (merge, not replace).
    expect(scopeUpdateArg.data.scopes[0].title).toBe(before[0].title);
    expect(scopeUpdateArg.data.scopes[0].id).toBe(before[0].id);
    // subtotal = 1000 (line) + 500 (updated scope) = 1500; tax 8% = 120; total 1620.
    expect(Number(res.body.invoice.subtotal)).toBe(1500);
    expect(Number(res.body.invoice.tax_amount)).toBeCloseTo(120, 2);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(1620, 2);
  });

  it("explicitly clears a scope's flat_price to null when the request sends flat_price: null", async () => {
    mockAuthAs('admin');
    const before = [scopeFixture({ flat_price: 300 })];
    const after = [scopeFixture({ flat_price: null })];
    mockScopeReads(before, after);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: null });

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBeNull();
    // subtotal reverts to 1000 (line only) — the now-cleared scope contributes nothing.
    expect(Number(res.body.invoice.subtotal)).toBe(1000);
  });

  it('404s when idx is out of range, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: [scopeFixture()] });
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/5`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(404);
    // Asserts the specific out-of-range message (not just status 404) so this genuinely
    // distinguishes "idx out of range" from "route not wired at all" — the app-wide fallback
    // 404 handler also returns status 404, with body { error: 'Not found' }.
    expect(res.body.error).toBe('Scope not found');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('blocks updating a scope on a locked (VOIDED) invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'VOIDED' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/invoices/:id/scopes/reorder — reorder (update Invoice only)
//
// Closes the Move-up/down lost-update race: a "Move up/down" click used to fire TWO concurrent
// index-addressed PATCH /scopes/:idx requests that swapped two blocks' field content by diffing
// the target order against the current one — each a non-atomic whole-column read-modify-write
// with no locking, so whichever committed last silently clobbered the other's change from a stale
// snapshot (one block's content replaced by the other's, one block's true content lost). This
// single all-or-nothing reorder call — mirrors line-items' own /reorder route exactly — replaces
// that with one atomic read-then-write.
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/invoices/:id/scopes/reorder — reorder (update Invoice only)', () => {
  const SCOPE_A = 'cc000000-0000-0000-0000-000000000001';
  const SCOPE_B = 'cc000000-0000-0000-0000-000000000002';
  const SCOPE_C = 'cc000000-0000-0000-0000-000000000003';

  function threeScopes() {
    return [
      scopeFixture({ id: SCOPE_A, title: 'A', flat_price: 100 }),
      scopeFixture({ id: SCOPE_B, title: 'B', flat_price: 200 }),
      scopeFixture({ id: SCOPE_C, title: 'C', flat_price: 300 }),
    ];
  }

  it('a valid full permutation rewrites the WHOLE scopes column in one atomic call, content traveling WITH its id (the swap the race used to corrupt)', async () => {
    mockAuthAs('admin');
    const reorderedForTotals = [threeScopes()[2], threeScopes()[0], threeScopes()[1]];
    mockScopeReads(threeScopes(), reorderedForTotals);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_C, SCOPE_A, SCOPE_B] });

    expect(res.status).toBe(200);
    // Two invoice.update calls: [0] the handler's own scopes-column write, [1] recomputeAndPersist's
    // totals write — SAME shape as addScope/updateScope, mirroring their "first call" convention.
    // Critically: NOT a per-index PATCH loop — a single reordered array is written once.
    expect(mockPrisma.invoice.update).toHaveBeenCalledTimes(2);
    const scopeArg = mockPrisma.invoice.update.mock.calls[0][0].data.scopes;
    expect(scopeArg.map((s: { id: string }) => s.id)).toEqual([SCOPE_C, SCOPE_A, SCOPE_B]);
    // Each block's own content (title/flat_price) travels WITH its id to its new position —
    // never swapped/lost the way the two-concurrent-PATCH race could corrupt it.
    expect(scopeArg[0].title).toBe('C');
    expect(scopeArg[0].flat_price).toBe(300);
    expect(scopeArg[1].title).toBe('A');
    expect(scopeArg[1].flat_price).toBe(100);
    expect(scopeArg[2].title).toBe('B');
    expect(scopeArg[2].flat_price).toBe(200);
    // Totals are unaffected by mere reordering (100+200+300 = 600 either way).
    expect(Number(res.body.invoice.subtotal)).toBe(1600); // 1000 (line) + 600 (scopes)
  });

  // NOTE: these three mismatch cases bail out after exactly TWO invoice.findUnique reads (the
  // loadGuardedInvoice guard read + the handler's own pre-mutation "current scopes" read inside
  // the tx) — they never reach recomputeAndPersist's third read. Queuing a THIRD
  // mockResolvedValueOnce (e.g. via the 3-deep mockScopeReads helper, meant for the success path)
  // would leave it dangling in the queue and silently corrupt the NEXT test's first
  // invoice.findUnique call — vi.clearAllMocks() clears call history, not queued
  // mockResolvedValueOnce values. Queue exactly two, mirroring the "404 idx out of range" test above.
  it('400s when the submitted order is missing one of the current scope ids, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: threeScopes() });
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B] }); // SCOPE_C missing
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it("400s when the submitted order contains an id that is not one of this invoice's scopes, no mutation", async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: threeScopes() });
    const FOREIGN_ID = 'ff000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B, FOREIGN_ID] });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains a duplicate id, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: threeScopes() });
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_A, SCOPE_B] }); // SCOPE_C missing, SCOPE_A duplicated
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('blocks a locked (PAID) invoice → 400, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A] });
    expect(res.status).toBe(404);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  // ─── RBAC: reorder is gated `update` Invoice — the SAME gate PATCH .../:idx (updateScope) uses ───
  it('DISPATCHER (has update Invoice) can reorder', async () => {
    mockAuthAs('dispatcher');
    mockScopeReads(threeScopes(), threeScopes());
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('dispatcher'))
      .send({ order: [SCOPE_C, SCOPE_B, SCOPE_A] });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalledTimes(2);
  });

  it('TECHNICIAN gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('technician'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('SALES gets 403 at the route guard (has manage_lines, NOT update) — no mutation', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('sales'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST/PATCH /api/invoices/:id/scopes — pricing leak (internal_cost)
//
// internal_cost on an Invoice scope-of-work block is the SAME class of cost/margin figure as
// job-lines.controller.ts's unit_cost/markup_percent (see job-lines-pricing-leak.test.ts) — this
// file had NO canSeePricing gate at all before this fix (canSeePricing wasn't even imported).
//
// NOTE on reachability: unlike the job side's grantTechUpdateJobWithoutInvoiceRead (a REAL,
// admin-grantable combination — "Edit own jobs" implies only `read Job`, not `read Invoice`), a
// technician with `manage_lines`/`update` Invoice but WITHOUT `read` Invoice cannot occur via any
// grantable path today: userCapabilities.ts's Invoice entries (create/update/record_payment) are
// all impliesRead: true and don't cover manage_lines at all, AND canAccessRow(Invoice) itself
// derives its row-scope PURELY from `read` grants (scopeWhereFor filters action==='read') — so in
// a REAL request this exact combination would 403 at loadGuardedInvoice's own canAccessRow check
// before ever reaching addScope/updateScope. These tests force invoice.findFirst to resolve truthy
// (mirroring the job-side harness's canAccessRow-probe mock, but here bypassing what would be a
// real 403) purely to exercise the body-write + response-strip code path in isolation — defense-
// in-depth coverage for a combination that cannot occur today but would silently go live the
// moment either invariant above changes (matches the review's own "latent, not yet active" note).
// ════════════════════════════════════════════════════════════════════════════
describe('POST/PATCH /api/invoices/:id/scopes — pricing leak (internal_cost)', () => {
  it('POST: a low-privilege submission of internal_cost is silently dropped from the write, and never echoed in the response', async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'manage_lines', subject: 'Invoice', conditions: OWN_VIA_JOB },
      // deliberately NO `read Invoice` grant — see block comment above.
    ] as any);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID }); // forces canAccessRow past its own read-grant gate
    mockScopeReads([], [scopeFixture({ title: 'Permit fee', flat_price: 300, internal_cost: 150 })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(
        detailAfter({ ...args.data, scopes: [scopeFixture({ title: 'Permit fee', flat_price: 300, internal_cost: 150 })] }),
      ),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(200);
    // Write-side: the scopes-column write (first invoice.update call) must never receive the
    // technician's submitted internal_cost.
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes[0].internal_cost).toBeNull();
    // Work detail is still saved.
    expect(scopeUpdateArg.data.scopes[0].title).toBe('Permit fee');
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBe(300);
    // Response-side: even though the mocked "current DB state" carries internal_cost 150
    // (simulating a value a privileged viewer would see), the technician's own response must not.
    expect(res.body.invoice.scopes[0].internal_cost).toBeUndefined();
  });

  it('PATCH: a low-privilege submission of internal_cost is silently dropped from the write, and never echoed in the response', async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
      // deliberately NO `read Invoice` grant — see block comment above.
    ] as any);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    const before = [scopeFixture({ flat_price: 300, internal_cost: null })];
    mockScopeReads(before, [scopeFixture({ flat_price: 500, internal_cost: 150 })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, scopes: [scopeFixture({ flat_price: 500, internal_cost: 150 })] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ flat_price: 500, internal_cost: 999 });

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // The pre-existing null is preserved — the technician's submitted 999 never lands.
    expect(scopeUpdateArg.data.scopes[0].internal_cost).toBeNull();
    // The field they ARE allowed to touch still persists.
    expect(scopeUpdateArg.data.scopes[0].flat_price).toBe(500);
    expect(res.body.invoice.scopes[0].internal_cost).toBeUndefined();
  });

  it("PATCH: a low-privilege edit to an unrelated field does NOT clobber a pre-existing internal_cost", async () => {
    mockAuthAs('technician');
    const OWN_VIA_JOB = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'update', subject: 'Invoice', conditions: OWN_VIA_JOB },
    ] as any);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    // An admin previously set a real internal_cost on this scope.
    const before = [scopeFixture({ title: 'Permit fee', flat_price: 300, internal_cost: 150 })];
    mockScopeReads(before, [scopeFixture({ title: 'Permit fee (updated)', flat_price: 300, internal_cost: 150 })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockResolvedValue(detailAfter());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee (updated)' }); // never mentions internal_cost

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    // Untouched, not wiped, by an edit that never mentioned the field.
    expect(scopeUpdateArg.data.scopes[0].internal_cost).toBe(150);
    expect(scopeUpdateArg.data.scopes[0].title).toBe('Permit fee (updated)');
  });

  it('DISPATCHER (read Invoice) sees internal_cost on the add response — contrast case', async () => {
    mockAuthAs('dispatcher');
    mockScopeReads([], [scopeFixture({ title: 'Permit fee', flat_price: 300, internal_cost: 150 })]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(
        detailAfter({ ...args.data, scopes: [scopeFixture({ title: 'Permit fee', flat_price: 300, internal_cost: 150 })] }),
      ),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('dispatcher'))
      .send({ title: 'Permit fee', flat_price: 300, internal_cost: 150 });

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes[0].internal_cost).toBe(150);
    expect(res.body.invoice.scopes[0].internal_cost).toBe(150);
  });
});

describe('DELETE /api/invoices/:id/scopes/:idx — delete (manage_lines)', () => {
  it('ADMIN removes the scope at idx and totals recompute without it', async () => {
    mockAuthAs('admin');
    const before = [scopeFixture({ id: 'first', flat_price: 300 }), scopeFixture({ id: 'second', title: 'Second scope', flat_price: 150 })];
    const after = [scopeFixture({ id: 'second', title: 'Second scope', flat_price: 150 })];
    mockScopeReads(before, after);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const scopeUpdateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(scopeUpdateArg.data.scopes).toHaveLength(1);
    expect(scopeUpdateArg.data.scopes[0].id).toBe('second');
    // subtotal = 1000 (line) + 150 (remaining scope) = 1150; tax 8% = 92; total 1242.
    expect(Number(res.body.invoice.subtotal)).toBe(1150);
    expect(Number(res.body.invoice.tax_amount)).toBeCloseTo(92, 2);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(1242, 2);
  });

  it('404s when idx is out of range, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: [scopeFixture()] });
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/9`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    // Asserts the specific out-of-range message (not just status 404) so this genuinely
    // distinguishes "idx out of range" from "route not wired at all" — the app-wide fallback
    // 404 handler also returns status 404, with body { error: 'Not found' }.
    expect(res.body.error).toBe('Scope not found');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN has no manage_lines by default (strict) → 403, no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('blocks deleting a scope on a locked (PAID) invoice → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org invoice id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Regression: recomputeAndPersist now folds scopes into ALL FOUR pre-existing handlers'
// totals too (not just the three new scope handlers above), since they all share it.
// ════════════════════════════════════════════════════════════════════════════
describe('recomputeAndPersist regression — scopes silently fold into pre-existing handlers', () => {
  it("a pre-existing scope's flat_price is folded into addLine's recomputed totals", async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow())
      .mockResolvedValueOnce({ scopes: [scopeFixture({ flat_price: 200 })] });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());
    mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve(detailAfter(args.data)));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra labor', quantity: 1, unit_price: 1, is_taxable: false });

    expect(res.status).toBe(200);
    // subtotal = 1000 (existing line — the mock doesn't reflect the newly-created one) + 200
    // (scope) = 1200; tax 8% of 1200 = 96; total 1296.
    expect(Number(res.body.invoice.subtotal)).toBe(1200);
    expect(Number(res.body.invoice.tax_amount)).toBeCloseTo(96, 2);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(1296, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Stage 1a regression: invoiceDetailSelect now selects unit_cost + markup_percent back on
// line_items, mirroring JobLineItem. This is the ONE select object recomputeAndPersist() re-reads
// through for every add/update/delete/updateBilling response, so a line that already carries both
// fields must no longer be silently dropped — proven here via updateBilling, a handler that never
// touches line_items itself, so the fix is demonstrably in the shared SELECT, not a handler.
// ════════════════════════════════════════════════════════════════════════════
describe('invoiceDetailSelect regression — unit_cost/markup_percent surfaced on line_items', () => {
  it('a line that already has unit_cost/markup_percent set is no longer silently dropped from the response', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
    const lineWithCostAndMarkup = { ...existingLines()[0], unit_cost: 250, markup_percent: 40 };
    mockPrisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve(detailAfter({ ...args.data, line_items: [lineWithCostAndMarkup] })),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tip: 10 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.invoice.update.mock.calls[0][0];
    expect(updateArg.select.line_items.select.unit_cost).toBe(true);
    expect(updateArg.select.line_items.select.markup_percent).toBe(true);
    const line = res.body.invoice.line_items[0];
    expect(Number(line.unit_cost)).toBe(250);
    expect(Number(line.markup_percent)).toBe(40);
  });
});

// #2053 AC10 — the shared invoice-lines schemas (also re-exported into Job/Invoice's own scope
// routes) stay flag-blind: is_optional/is_selected are estimate-only, added to
// estimate.controller.ts's lineItemObjectSchema and estimate-lines.controller.ts's
// addEstimateScopeSchema, never to these. Zod's default strip-unknown-keys behaviour means a
// value sent here is accepted-and-ignored (200/201), not rejected.
describe('#2053 AC10 — shared line/scope schemas stay estimate-blind', () => {
  it('addScopeSchema strips is_optional/is_selected from a parsed payload', () => {
    const parsed = addScopeSchema.parse({ title: 'x', is_optional: true, is_selected: false });
    expect(parsed).not.toHaveProperty('is_optional');
    expect(parsed).not.toHaveProperty('is_selected');
  });

  it("invoice-lines.controller's own updateLineSchema strips is_optional/is_selected too", () => {
    const parsed = updateLineSchema.parse({ description: 'x', is_optional: true, is_selected: false });
    expect(parsed).not.toHaveProperty('is_optional');
    expect(parsed).not.toHaveProperty('is_selected');
  });
});
