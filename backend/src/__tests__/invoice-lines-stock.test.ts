/**
 * LO-4 legacy retirement — invoice-line stock behavior AFTER the flip.
 *
 * Twin of job-lines-stock.test.ts, invoice side:
 *   - Adding a line NEVER moves stock and always stamps NOT_TRACKED.
 *   - The sync-stock routes (single + bulk) are parked → 404 FEATURE_DISABLED (auth runs first).
 *   - C2 freeze: a QUANTITY edit on a legacy SYNCED line → 400 LEGACY_STOCK_LINE, thrown inside the
 *     tx BEFORE the qty write so nothing persists; price/description/tax edits still succeed; qty
 *     edits on non-SYNCED lines still succeed; delete-with-auto-return is UNTOUCHED.
 *
 * Harness: unchanged from the P1 suite (supertest, prisma mocked, tx proxy) + stock delegates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  JOB_FIXTURE,
  INVOICE_FIXTURE,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  invoice: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  priceBookItem: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: {
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const INVOICE_ID = INVOICE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;

function invoiceRow({
  status = 'DRAFT' as string,
  jobId = JOB_FIXTURE.id as string | null,
}: { status?: string; jobId?: string | null } = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status,
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: 1080,
    amount_due: 1080,
    tax_rate: 0.08,
    discount_amount: 0,
    tip: 0,
    scopes: null,
    job_id: jobId,
    customer: { tax_exempt: false },
    job: jobId
      ? {
          assignees: [{ user_id: TEST_USERS.technician.id }],
          customer: { tax_exempt: false },
          estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
        }
      : null,
  };
}

function stockLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    invoice_id: INVOICE_ID,
    sequence: 1,
    description: '12ga Wire (ft)',
    quantity: 2,
    unit_price: 4,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 8,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: TRACKED_ITEM_FIXTURE.id,
    stock_status: 'UNSYNCED',
    stock_location_id: null,
    ...over,
  };
}

// invoiceDetailSelect-shaped object for the post-mutation reads.
function detailAfter(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status: 'DRAFT',
    kind: 'STANDARD',
    tip: 0,
    subtotal: 8,
    discount_amount: 0,
    tax_rate: 0.08,
    tax_amount: 0.64,
    deposit_credit: 0,
    total_amount: 8.64,
    amount_due: 8.64,
    line_items: [stockLine()],
    scopes: null,
    refunds: [],
    credits: [],
    customer: null,
    job: null,
    payments: [],
    ...overrides,
  };
}

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) => fn({
    invoiceLineItem: {
      findMany: mockPrisma.invoiceLineItem.findMany,
      findFirst: mockPrisma.invoiceLineItem.findFirst,
      create: mockPrisma.invoiceLineItem.create,
      update: mockPrisma.invoiceLineItem.update,
      deleteMany: mockPrisma.invoiceLineItem.deleteMany,
    },
    invoice: {
      findUnique: mockPrisma.invoice.findUnique,
      findFirst: mockPrisma.invoice.findFirst,
      update: mockPrisma.invoice.update,
    },
    priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst, findMany: mockPrisma.priceBookItem.findMany },
    stockMovement: { create: mockPrisma.stockMovement.create },
    stockBalance: {
      upsert: mockPrisma.stockBalance.upsert,
      updateMany: mockPrisma.stockBalance.updateMany,
      findUnique: mockPrisma.stockBalance.findUnique,
    },
    organization: { findUnique: mockPrisma.organization.findUnique },
  } as any));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockAuthAs('admin');
  mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
  mockPrisma.invoice.update.mockResolvedValue(detailAfter());
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue([stockLine()]);
  mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(stockLine());
  mockPrisma.invoiceLineItem.create.mockResolvedValue(stockLine({ id: 'ili-stock-1' }));
  mockPrisma.invoiceLineItem.update.mockResolvedValue(stockLine());
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(TRACKED_ITEM_FIXTURE);
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/invoices/:id/line-items — add line never moves stock
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/line-items — no deduction, always NOT_TRACKED', () => {
  const trackedAdd = {
    description: '12ga Wire (ft)', quantity: 3, unit_price: 4, item_type: 'MATERIAL',
    price_book_item_id: TRACKED_ITEM_FIXTURE.id, stock_location_id: LOCATION_ID,
  };

  it('tracked item + location on a job-linked DRAFT invoice → 200, NO movement, NOT_TRACKED', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`).set(authHeader('admin')).send(trackedAdd);

    expect(res.status).toBe(200);
    const createArg = mockPrisma.invoiceLineItem.create.mock.calls[0][0];
    expect(createArg.data.stock_status).toBe('NOT_TRACKED');
    expect(createArg.data.stock_location_id).toBeNull();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryLocation.findFirst).not.toHaveBeenCalled();
    expect(res.body.stock).toBeUndefined();
  });

  it('free-text line → NOT_TRACKED, no movement, response shape intact', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`).set(authHeader('admin'))
      .send({ description: 'Extra labor', quantity: 2, unit_price: 100 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(res.body.invoice).toBeDefined();
    expect(res.body.stock).toBeUndefined();
  });

  it('standalone invoice (no job) → 200 NOT_TRACKED, no movement', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ jobId: null }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`).set(authHeader('admin')).send(trackedAdd);

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('plain addLine on a PAID invoice keeps the legacy 400 (loader gate unchanged)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(400);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// sync-stock routes — parked (LO-4): 404 FEATURE_DISABLED, auth runs first
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/line-items(/:lineId)/sync-stock — retired', () => {
  it('single-line sync-stock → 404 FEATURE_DISABLED { feature: line_stock_sync }', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}/sync-stock`)
      .set(authHeader('admin'))
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('bulk sync-stock → 404 FEATURE_DISABLED { feature: line_stock_sync }', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items/sync-stock`)
      .set(authHeader('admin'))
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('unauthenticated sync-stock → 401 (auth still runs before the parked handler)', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items/sync-stock`)
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/invoices/:id/line-items/:lineId — C2 legacy freeze
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/invoices/:id/line-items/:lineId — C2 legacy SYNCED freeze', () => {
  function syncedLine(over: Record<string, unknown> = {}) {
    return stockLine({ stock_status: 'SYNCED', stock_location_id: LOCATION_ID, quantity: 2, ...over });
  }

  it('qty INCREASE on a SYNCED line → 400 LEGACY_STOCK_LINE, no movement, qty NOT persisted', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'LEGACY_STOCK_LINE', reason: 'qty_frozen' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    // Freeze throws before the qty write inside the tx → the qty edit never persists.
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('qty DECREASE on a SYNCED line → 400 (freeze blocks decreases too)', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine({ quantity: 5 }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_STOCK_LINE');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.invoiceLineItem.update).not.toHaveBeenCalled();
  });

  it('same-quantity PATCH on a SYNCED line → 200 (delta 0, not frozen)', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine({ quantity: 2 }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('price-only edit on a SYNCED line → 200, no movement', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 42 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('qty edit on an UNSYNCED line → 200, no movement (freeze is SYNCED-only)', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(stockLine());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 9 });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/invoices/:id/line-items/:lineId — auto-return (§4.3) — UNCHANGED by LO-4
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/invoices/:id/line-items/:lineId — auto-return on delete', () => {
  function syncedLine(over: Record<string, unknown> = {}) {
    return stockLine({ stock_status: 'SYNCED', stock_location_id: LOCATION_ID, quantity: 3, ...over });
  }

  beforeEach(() => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([TRACKED_ITEM_FIXTURE]);
  });

  it('deleting a SYNCED line returns its full quantity to the line location', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine());

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.deleteMany).toHaveBeenCalled();

    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(3);
    expect(movement.to_location_id).toBe(LOCATION_ID);
    expect(movement.invoice_line_item_id).toBe(LINE_ID);
  });

  it('writes the return movement BEFORE the row is deleted (movement FK must exist at insert)', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine());

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const movementOrder = mockPrisma.stockMovement.create.mock.invocationCallOrder[0];
    const deleteOrder = mockPrisma.invoiceLineItem.deleteMany.mock.invocationCallOrder[0];
    expect(movementOrder).toBeLessThan(deleteOrder);
  });

  it('deleting an UNSYNCED line moves nothing (nothing was ever deducted)', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(stockLine());

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('deleting a NOT_TRACKED (free-text) line moves nothing', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(
      stockLine({ stock_status: 'NOT_TRACKED', price_book_item_id: null }),
    );

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
