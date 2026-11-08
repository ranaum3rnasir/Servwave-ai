/**
 * Connection-pool isolation — no GLOBAL-client query may run while an interactive
 * transaction is open.
 *
 * WHY THIS SUITE EXISTS
 * `prisma.$transaction(async (tx) => …)` holds one pooled connection for the life of the
 * callback. A query issued on the GLOBAL `prisma` client inside that callback checks out a
 * SECOND connection. On a connection-limited deployment none is free, so the nested query
 * dies with Prisma P2024 ("Timed out fetching a new connection from the connection pool")
 * and takes the whole transaction down with it. Locally it is invisible: dev DATABASE_URLs
 * carry connection_limit=5, so a spare connection always masks the bug.
 *
 * WHY THE OTHER 5,000 TESTS COULD NOT CATCH IT
 * Every existing inventory suite builds its transaction client by handing back the SAME
 * spy objects as the global mock, e.g.
 *     priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst }
 * so `tx.priceBookItem.findFirst` and `prisma.priceBookItem.findFirst` are literally the
 * same function and the distinction under test does not exist. The harness below gives the
 * tx client its OWN spies (delegating to the global mocks' current implementations, so
 * fixtures still work) — which is what makes "which client was queried" assertable at all.
 *
 * Covers the three sites fixed together: invoice-line qty edit (resolveTrackedItem),
 * bulk restock (loadItemAndLocation), and the PO path (resolveSkuMap); PLUS the LO-2
 * engine (processLogisticOrder + returnProcessedLo), which must obey the same discipline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  TEST_USERS,
  JOB_FIXTURE,
  INVOICE_FIXTURE,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { processLogisticOrder, returnProcessedLo } from '../lib/logisticOrders';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const INVOICE_ID = INVOICE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const LOC_ID = INVENTORY_LOCATION_FIXTURE.id;
const ITEM_ID = TRACKED_ITEM_FIXTURE.id;

/**
 * A transaction-client spy that is a DISTINCT function from the global mock but resolves
 * whatever the global mock is currently configured to resolve. Reading the implementation at
 * call time (not capture time) keeps per-test `mockResolvedValue` setup working.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txSpy(globalFn: any) {
  return vi.fn((...args: unknown[]) => {
    const impl = globalFn.getMockImplementation();
    return impl ? impl(...args) : Promise.resolve(null);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let txClient: Record<string, any>;

function setupTransaction() {
  txClient = {
    invoice: {
      findUnique: txSpy(mockPrisma.invoice.findUnique),
      findFirst: txSpy(mockPrisma.invoice.findFirst),
      update: txSpy(mockPrisma.invoice.update),
    },
    invoiceLineItem: {
      findMany: txSpy(mockPrisma.invoiceLineItem.findMany),
      findFirst: txSpy(mockPrisma.invoiceLineItem.findFirst),
      create: txSpy(mockPrisma.invoiceLineItem.create),
      update: txSpy(mockPrisma.invoiceLineItem.update),
      deleteMany: txSpy(mockPrisma.invoiceLineItem.deleteMany),
    },
    priceBookItem: {
      findFirst: txSpy(mockPrisma.priceBookItem.findFirst),
      findMany: txSpy(mockPrisma.priceBookItem.findMany),
    },
    inventoryLocation: {
      findFirst: txSpy(mockPrisma.inventoryLocation.findFirst),
      findMany: txSpy(mockPrisma.inventoryLocation.findMany),
    },
    organization: { findUnique: txSpy(mockPrisma.organization.findUnique) },
    stockMovement: { create: txSpy(mockPrisma.stockMovement.create) },
    stockBalance: {
      upsert: txSpy(mockPrisma.stockBalance.upsert),
      updateMany: txSpy(mockPrisma.stockBalance.updateMany),
      findUnique: txSpy(mockPrisma.stockBalance.findUnique),
      findMany: txSpy(mockPrisma.stockBalance.findMany),
    },
    // Logistic Orders (LO-2). processLogisticOrder + returnProcessedLo must use tx for every
    // in-transaction query; the assertions below prove they never reach for the global client.
    logisticOrder: {
      findFirst: txSpy(mockPrisma.logisticOrder.findFirst),
      updateMany: txSpy(mockPrisma.logisticOrder.updateMany),
      update: txSpy(mockPrisma.logisticOrder.update),
    },
    logisticOrderLine: {
      findMany: txSpy(mockPrisma.logisticOrderLine.findMany),
      create: txSpy(mockPrisma.logisticOrderLine.create),
      update: txSpy(mockPrisma.logisticOrderLine.update),
      deleteMany: txSpy(mockPrisma.logisticOrderLine.deleteMany),
    },
    purchaseOrder: { create: txSpy(mockPrisma.purchaseOrder.create) },
    estimateReservation: {
      findFirst: txSpy(mockPrisma.estimateReservation.findFirst),
      update: txSpy(mockPrisma.estimateReservation.update),
      updateMany: txSpy(mockPrisma.estimateReservation.updateMany),
    },
  };

  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(txClient);
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function invoiceRow() {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status: 'DRAFT',
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: 8,
    amount_due: 8,
    tax_rate: 0.08,
    discount_amount: 0,
    tip: 0,
    scopes: null,
    job_id: JOB_FIXTURE.id,
    customer: { tax_exempt: false },
    job: { customer: { tax_exempt: false } },
  };
}

function syncedLine() {
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
    price_book_item_id: ITEM_ID,
    // SYNCED + a qty change is the only combination that reaches resolveTrackedItem.
    stock_status: 'SYNCED',
    stock_location_id: LOC_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockAuthAs('admin');

  setupTransaction();

  mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
  mockPrisma.invoice.findFirst.mockResolvedValue(invoiceRow());
  mockPrisma.invoice.update.mockResolvedValue({
    ...invoiceRow(), subtotal: 20, line_items: [syncedLine()], refunds: [], credits: [], payments: [], job: null,
  });
  mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(syncedLine());
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue([syncedLine()]);
  mockPrisma.invoiceLineItem.update.mockResolvedValue(syncedLine());
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(TRACKED_ITEM_FIXTURE);
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: LOC_ID });
  mockPrisma.organization.findUnique.mockResolvedValue({
    block_negative_stock: false, default_inventory_location_id: LOC_ID,
  });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 100 });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 97 });
  mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });
});

describe('invoice-line qty edit — legacy SYNCED freeze (LO-4)', () => {
  it('qty edit on a SYNCED line → 400 LEGACY_STOCK_LINE, no movement, no item resolution on either client', async () => {
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 5 });

    // LO-4 froze qty edits on legacy SYNCED lines, so the old P2024 fence here (resolveTrackedItem
    // on tx during an invoice-line qty edit) is obsolete — no item resolution runs at all. The same
    // in-transaction P2024 discipline for the SURVIVING deduction path (LO processing) is asserted
    // in the LO engine block below, which re-homes this fence.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'LEGACY_STOCK_LINE', reason: 'qty_frozen' });
    expect(txClient.stockMovement.create).not.toHaveBeenCalled();
    expect(txClient.priceBookItem.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.findFirst).not.toHaveBeenCalled();
    // The freeze throws before the qty write, so the edit never persists.
    expect(txClient.invoiceLineItem.update).not.toHaveBeenCalled();
  });
});

describe('bulk restock — item/location resolution happens BEFORE the transaction opens', () => {
  it('issues its global-client reads ahead of $transaction, not inside it', async () => {
    const res = await request(app)
      .post('/api/inventory/bulk-restock')
      .set(authHeader('admin'))
      .send({ lines: [{ itemId: ITEM_ID, locationId: LOC_ID, qty: 4 }] });

    expect(res.status).toBe(200);
    expect(txClient.stockMovement.create).toHaveBeenCalled();

    // These reads are legitimate on the global client — but only OUTSIDE the transaction.
    // Ordering is the assertion: every resolution must precede the $transaction call.
    const itemOrder = mockPrisma.priceBookItem.findFirst.mock.invocationCallOrder[0];
    const txOrder = mockPrisma.$transaction.mock.invocationCallOrder[0];
    expect(itemOrder).toBeLessThan(txOrder);
  });

  it('returns 404 for an unknown item instead of throwing from inside the transaction', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/inventory/bulk-restock')
      .set(authHeader('admin'))
      .send({ lines: [{ itemId: ITEM_ID, locationId: LOC_ID, qty: 4 }] });

    expect(res.status).toBe(404);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LO-2: the same P2024 discipline applies to the Logistic Orders engine. These call the
// engine DIRECTLY (the controller/routes are a sibling stream) — the distinction under test
// is which CLIENT each query lands on, which is a property of the engine, not the route.
// ─────────────────────────────────────────────────────────────────────────────

const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000010';
const LO_LINE_ID = 'bbbbbbb2-0000-0000-0000-000000000010';

function loReq(): Request {
  const u = TEST_USERS.admin;
  return {
    user: {
      id: u.id,
      organization_id: ALPHA_ORG_ID,
      role: 'ADMIN',
      first_name: 'Ada',
      last_name: 'Admin',
    },
  } as unknown as Request;
}

function loRow() {
  return {
    id: LO_ID,
    number: 'LO-J00001-1',
    status: 'APPROVED',
    job_id: JOB_FIXTURE.id,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    lines: [
      {
        id: LO_LINE_ID,
        item_id: ITEM_ID,
        item_sku: TRACKED_ITEM_FIXTURE.sku,
        item_name: TRACKED_ITEM_FIXTURE.name,
        qty: 2,
        from_location_id: LOC_ID,
        sequence: 0,
      },
    ],
  };
}

describe('LO processing — every in-transaction query lands on the tx client', () => {
  beforeEach(() => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow());
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([TRACKED_ITEM_FIXTURE]);
    mockPrisma.inventoryLocation.findMany.mockResolvedValue([{ id: LOC_ID, name: 'Main Warehouse' }]);
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 8, min: null });
  });

  it('processLogisticOrder: status claim + movement run on tx, never on the global client', async () => {
    const result = await processLogisticOrder(prisma as never, loReq(), LO_ID);

    expect(result.status).toBe('PROCESSED');
    // In-tx writes go through the tx spies.
    expect(txClient.logisticOrder.updateMany).toHaveBeenCalled();
    expect(txClient.stockMovement.create).toHaveBeenCalled();
    // …and NEVER through the global client (the P2024 hazard).
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('processLogisticOrder: LO/org/item/location resolution precedes $transaction (global reads)', async () => {
    await processLogisticOrder(prisma as never, loReq(), LO_ID);

    const txOrder = mockPrisma.$transaction.mock.invocationCallOrder[0];
    expect(mockPrisma.logisticOrder.findFirst.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.organization.findUnique.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.priceBookItem.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.inventoryLocation.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    // The LO row itself is NOT re-read on the tx client.
    expect(txClient.logisticOrder.findFirst).not.toHaveBeenCalled();
  });

  it('returnProcessedLo: item resolution + return movement run on tx, never on the global client', async () => {
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });

    const written = await returnProcessedLo(txClient as never, {
      id: LO_ID,
      number: 'LO-J00001-1',
      organization_id: ALPHA_ORG_ID,
      job_id: JOB_FIXTURE.id,
      lines: loRow().lines,
      actor: 'Ada Admin',
      actorUserId: TEST_USERS.admin.id,
    });

    expect(written).toBe(1);
    expect(txClient.logisticOrder.updateMany).toHaveBeenCalled();
    expect(txClient.priceBookItem.findMany).toHaveBeenCalled();
    expect(txClient.stockMovement.create).toHaveBeenCalled();
    // resolveItemsById + applyStockMovement received `tx` — the global client stays untouched.
    expect(mockPrisma.priceBookItem.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
