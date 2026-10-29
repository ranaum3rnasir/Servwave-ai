/**
 * LO-4 legacy retirement — job-line stock behavior AFTER the flip.
 *
 * Logistic Orders now own ALL stock deduction, so the legacy job-line stock paths retire:
 *   - Adding a line NEVER moves stock and always stamps NOT_TRACKED (clean-era marker).
 *   - The sync-stock routes (single + bulk) are parked → 404 FEATURE_DISABLED (auth runs first).
 *   - C2 freeze: a QUANTITY edit on a legacy `stock_status='SYNCED'` line → 400 LEGACY_STOCK_LINE
 *     before any stock move; price/description/tax edits still succeed; qty edits on non-SYNCED
 *     lines still succeed (no movement); delete-with-auto-return is UNTOUCHED (returnSyncedLines
 *     still services legacy SYNCED rows).
 *
 * Harness: unchanged from the P1 suite (supertest against `app`, prisma fully mocked, grants via
 * mockAuthAs), tx proxy over the stock delegates.
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
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  jobLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
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

const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const LINE_ID_2 = 'aa000000-0000-0000-0000-000000000002';
const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;

// An existing line on the job — stock-fielded (P1).
function existingLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    job_id: JOB_ID,
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

function jobRow({
  status = 'SUBMITTED' as string,
  sourcePlanId = null as string | null,
  jobLineItems = [] as any[],
  invoices = [] as any[],
  scopes = null as unknown[] | null,
} = {}) {
  return {
    id: JOB_ID,
    status,
    source_plan_id: sourcePlanId,
    job_number: 'J00001',
    customer: { tax_exempt: false },
    assignees: [{ user_id: TEST_USERS.technician.id }],
    estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
    job_line_items: jobLineItems,
    invoices,
    scopes,
  };
}

// $transaction proxy delegating every stock-touching delegate to mockPrisma (callback + array forms).
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        job: { findUnique: mockPrisma.job.findUnique, update: mockPrisma.job.update },
        jobLineItem: {
          create: mockPrisma.jobLineItem.create,
          update: mockPrisma.jobLineItem.update,
          updateMany: mockPrisma.jobLineItem.updateMany,
          deleteMany: mockPrisma.jobLineItem.deleteMany,
        },
        priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst, findMany: mockPrisma.priceBookItem.findMany },
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

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockAuthAs('admin');
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(TRACKED_ITEM_FIXTURE);
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  mockPrisma.jobLineItem.create.mockResolvedValue(existingLine({ id: 'jli-stock-1', stock_status: 'NOT_TRACKED', stock_location_id: null }));
  mockPrisma.jobLineItem.update.mockResolvedValue(existingLine());
  mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/:id/line-items — add line never moves stock (LO owns deduction)
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/jobs/:id/line-items — no deduction, always NOT_TRACKED', () => {
  const trackedAdd = {
    description: '12ga Wire (ft)', quantity: 3, unit_price: 4, item_type: 'MATERIAL',
    price_book_item_id: TRACKED_ITEM_FIXTURE.id, stock_location_id: LOCATION_ID,
  };

  it('tracked item + location → 201, NO movement, line stamped NOT_TRACKED with null location', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin')).send(trackedAdd);

    expect(res.status).toBe(201);
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(createArg.data.stock_status).toBe('NOT_TRACKED');
    expect(createArg.data.stock_location_id).toBeNull();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    // Add no longer resolves the catalog item or the location — those seams retired with deduct-on-add.
    expect(mockPrisma.priceBookItem.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryLocation.findFirst).not.toHaveBeenCalled();
    expect(res.body.stock).toBeUndefined();
  });

  it('tracked item WITHOUT a location → 201 NOT_TRACKED, no movement', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'))
      .send({ ...trackedAdd, stock_location_id: undefined });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_location_id).toBeNull();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(res.body.stock).toBeUndefined();
  });

  it('free-text line → NOT_TRACKED, no movement, response shape intact', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100, is_taxable: false });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(res.body.line).toBeDefined();
    expect(res.body.billing).toBeDefined();
    expect(res.body.stock).toBeUndefined();
  });

  it('a stale client sending stock_location_id is harmless (silently stripped, no error)', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin')).send(trackedAdd);

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_location_id).toBeNull();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// sync-stock routes — parked (LO-4): 404 FEATURE_DISABLED, auth runs first
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/jobs/:id/line-items(/:lineId)/sync-stock — retired', () => {
  it('single-line sync-stock → 404 FEATURE_DISABLED { feature: line_stock_sync }', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}/sync-stock`)
      .set(authHeader('admin'))
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('bulk sync-stock → 404 FEATURE_DISABLED { feature: line_stock_sync }', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items/sync-stock`)
      .set(authHeader('admin'))
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('unauthenticated sync-stock → 401 (auth still runs before the parked handler)', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items/sync-stock`)
      .send({ location_id: LOCATION_ID });

    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/jobs/:id/line-items/:lineId — C2 legacy freeze
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/jobs/:id/line-items/:lineId — C2 legacy SYNCED freeze', () => {
  function syncedLine(over: Record<string, unknown> = {}) {
    return existingLine({ stock_status: 'SYNCED', stock_location_id: LOCATION_ID, quantity: 3, ...over });
  }

  it('qty INCREASE on a SYNCED line → 400 LEGACY_STOCK_LINE, no movement, qty NOT persisted', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'LEGACY_STOCK_LINE', reason: 'qty_frozen' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('qty DECREASE on a SYNCED line → 400 (freeze blocks decreases too)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine({ quantity: 5 })] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_STOCK_LINE');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('same-quantity PATCH on a SYNCED line → 200 (delta 0, not frozen), no movement', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine({ quantity: 3 })] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('price-only edit on a SYNCED line → 200, no movement (price/desc/tax stay editable)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 99 });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(res.body.stock).toBeUndefined();
  });

  it('description edit on a SYNCED line → 200, no movement', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'Renamed line' });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('qty edit on an UNSYNCED line → 200, no movement (freeze is SYNCED-only)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine({ quantity: 3 })] }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 7 });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('qty edit on a NOT_TRACKED line → 200, no movement', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [existingLine({ quantity: 3, stock_status: 'NOT_TRACKED', price_book_item_id: null })] }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 7 });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/jobs/:id/line-items/:lineId — auto-return (§4.3) — UNCHANGED by LO-4
//
// Deleting a legacy SYNCED line still returns its stock (returnSyncedLines is the surviving
// unwind for legacy rows). This block is the regression fence for the delete/auto-return
// asymmetry and must stay green verbatim across the flip.
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/jobs/:id/line-items/:lineId — auto-return on delete', () => {
  function syncedLine(over: Record<string, unknown> = {}) {
    return existingLine({ stock_status: 'SYNCED', stock_location_id: LOCATION_ID, quantity: 3, ...over });
  }

  // returnSyncedLines resolves items in BULK (resolveItemsById → findMany), unlike the qty-delta
  // path above which resolves one item via findFirst. The shared beforeEach only stubs findFirst.
  beforeEach(() => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([TRACKED_ITEM_FIXTURE]);
  });

  it('deleting a SYNCED line returns its full quantity to the line location', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.deleteMany).toHaveBeenCalled();

    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(3);
    expect(movement.to_location_id).toBe(LOCATION_ID);
    expect(movement.job_line_item_id).toBe(LINE_ID);
  });

  it('writes the return movement BEFORE the row is deleted (movement FK must exist at insert)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const movementOrder = mockPrisma.stockMovement.create.mock.invocationCallOrder[0];
    const deleteOrder = mockPrisma.jobLineItem.deleteMany.mock.invocationCallOrder[0];
    expect(movementOrder).toBeLessThan(deleteOrder);
  });

  it('deleting an UNSYNCED line moves nothing (nothing was ever deducted)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));

    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('deleting a NOT_TRACKED (free-text) line moves nothing', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [existingLine({ stock_status: 'NOT_TRACKED', price_book_item_id: null })] }),
    );

    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('unknown lineId → 404, nothing deleted and nothing moved', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [syncedLine()] }));

    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID_2}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.deleteMany).not.toHaveBeenCalled();
  });
});
