/**
 * SRVW-91 - per-(item, location) reserve levels: PUT /api/inventory/stock/thresholds.
 *
 * StockBalance.min / .max have 12 read sites and zero writers, so every low-stock
 * surface is structurally empty for an org configured through the product. This is the
 * one narrow write door. It writes ONLY min and max - never on_hand, never reserved,
 * never a StockMovement - so applyStockMovement stays the single write path for quantity.
 *
 * Tenancy: @@unique([item_id, location_id]) on StockBalance omits organization_id, so the
 * compound-key upsert must never see a user-supplied id. Both ids are resolved through
 * tenantWhere(req) first and a miss 404s before any write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader, ALPHA_ORG_ID,
  PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Low-stock notification emit - spied, never awaited (fire-and-forget).
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  stockBalance: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ITEM_ID = PRICE_BOOK_ITEM_FIXTURE.id;
const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;
const LOCATION_ID_2 = 'aaaaaaa1-0000-0000-0000-000000000002';
const THRESHOLDS_URL = '/api/inventory/stock/thresholds';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 0, min: 10, max: 20 });
  mockPrisma.stockMovement.create.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('PUT /api/inventory/stock/thresholds (SRVW-91)', () => {
  it('sets min and max on an existing (item, location) pair and echoes them back', async () => {
    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, min: 10, max: 20 });
    expect(mockPrisma.stockBalance.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].where).toEqual({
      item_id_location_id: { item_id: ITEM_ID, location_id: LOCATION_ID },
    });
  });

  it('writes ONLY min and max - never on_hand, never reserved, never a StockMovement', async () => {
    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });

    expect(res.status).toBe(200);
    // The ledger invariant at inv-stock.controller.ts applyStockMovement: quantity keeps
    // exactly one write path. This endpoint is the named min/max-only exception.
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].update).toEqual({ min: 10, max: 20 });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('creates a balance row at on_hand 0 / reserved 0 for a pair that has none, stamped with the caller org', async () => {
    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 3, max: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].create).toEqual({
      item_id: ITEM_ID,
      location_id: LOCATION_ID,
      on_hand: 0,
      reserved: 0,
      min: 3,
      max: null,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('explicit null clears the column back to NULL so the row leaves the low-stock candidate set', async () => {
    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: null, max: null });

    expect(res.status).toBe(200);
    // NULL, not 0 - `min: { not: null }` is what gates the low-stock candidate set.
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].update).toEqual({ min: null, max: null });
  });

  it('cross-org item_id -> 404 and nothing is written', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });

    expect(res.status).toBe(404);
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
    // Load-bearing: the id is resolved through tenantWhere(req) BEFORE the compound-key
    // upsert ever sees it. Without this assertion the case passes on a missing route.
    expect(mockPrisma.priceBookItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
  });

  it('cross-org location_id -> 404 and nothing is written', async () => {
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });

    expect(res.status).toBe(404);
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryLocation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
  });

  it('max below min -> 400', async () => {
    const res = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 20, max: 5 });

    expect(res.status).toBe(400);
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('negative and fractional thresholds -> 400', async () => {
    const negative = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: -1, max: null });
    expect(negative.status).toBe(400);

    const fractional = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 2.5, max: null });
    expect(fractional.status).toBe(400);

    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it.each(['sales', 'technician'] as const)('%s (no update Inventory) -> 403', async (role) => {
    mockAuthAs(role);

    const res = await request(app).put(THRESHOLDS_URL).set(authHeader(role))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });

    expect(res.status).toBe(403);
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });
});

// ─── End to end in one process: a UI-set min reaches the low-stock consumers ────

describe('a UI-set threshold reaches the low-stock consumers (SRVW-91)', () => {
  type Row = {
    item_id: string;
    location_id: string;
    on_hand: number;
    reserved: number;
    min: number | null;
    max: number | null;
    organization_id: string;
  };
  const store = new Map<string, Row>();
  const keyOf = (itemId: string, locationId: string) => `${itemId}:${locationId}`;

  // Prisma scalar update value: a plain number, or { increment: n } from applyStockMovement.
  const nextNumber = (current: number, value: any): number =>
    value != null && typeof value === 'object' && 'increment' in value
      ? current + Number(value.increment)
      : Number(value);

  const upsertIntoStore = async (args: any) => {
    const { item_id, location_id } = args.where.item_id_location_id;
    const key = keyOf(item_id, location_id);
    const existing = store.get(key);
    if (!existing) {
      const created: Row = {
        item_id,
        location_id,
        on_hand: Number(args.create.on_hand ?? 0),
        reserved: Number(args.create.reserved ?? 0),
        min: args.create.min ?? null,
        max: args.create.max ?? null,
        organization_id: args.create.organization_id,
      };
      store.set(key, created);
      return { ...created };
    }
    const updated: Row = { ...existing };
    for (const [field, value] of Object.entries(args.update ?? {})) {
      if (field === 'on_hand' || field === 'reserved') {
        (updated as any)[field] = nextNumber((existing as any)[field], value);
      } else {
        (updated as any)[field] = value;
      }
    }
    store.set(key, updated);
    return { ...updated };
  };

  const seed = (row: Partial<Row> & { location_id: string }) => {
    const full: Row = {
      item_id: ITEM_ID,
      on_hand: 0,
      reserved: 0,
      min: null,
      max: null,
      organization_id: ALPHA_ORG_ID,
      ...row,
    } as Row;
    store.set(keyOf(full.item_id, full.location_id), full);
  };

  beforeEach(() => {
    store.clear();
    mockPrisma.inventoryLocation.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    mockPrisma.stockBalance.upsert.mockImplementation(upsertIntoStore);
    mockPrisma.stockBalance.findUnique.mockImplementation(async ({ where }: any) => {
      const { item_id, location_id } = where.item_id_location_id;
      return store.get(keyOf(item_id, location_id)) ?? null;
    });
    mockPrisma.stockBalance.findMany.mockImplementation(async () =>
      [...store.values()]
        .filter((r) => r.min != null)
        .map((r) => ({
          ...r,
          item: {
            id: r.item_id, sku: PRICE_BOOK_ITEM_FIXTURE.sku, name: PRICE_BOOK_ITEM_FIXTURE.name,
            kind: 'material', status: 'active', is_active: true, track_inventory: true,
            vendor_id: null, vendor: null,
          },
          location: { id: r.location_id, name: 'Main Warehouse', type: 'warehouse' },
        })),
    );
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        stockMovement: { create: vi.fn().mockResolvedValue({}) },
        stockBalance: { upsert: upsertIntoStore },
      }),
    );
  });

  it('PUT thresholds then GET /low-stock lists the pair', async () => {
    seed({ location_id: LOCATION_ID, on_hand: 2 });

    const put = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 10, max: 20 });
    expect(put.status).toBe(200);

    const low = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(low.status).toBe(200);
    expect(low.body.data).toHaveLength(1);
    expect(low.body.data[0]).toMatchObject({ itemId: ITEM_ID, locationId: LOCATION_ID, onHand: 2, min: 10 });
  });

  it('a consuming movement across the newly-set min emits exactly one inventory.low_stock', async () => {
    seed({ location_id: LOCATION_ID, on_hand: 5 });

    const put = await request(app).put(THRESHOLDS_URL).set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, min: 4, max: null });
    expect(put.status).toBe(200);

    const transfer = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: ITEM_ID, fromId: LOCATION_ID, toId: LOCATION_ID_2, qty: 2 });
    expect(transfer.status).toBe(200);

    const lowStockCalls = mockEmit.mock.calls.filter((c: any[]) => c[0].verb === 'inventory.low_stock');
    expect(lowStockCalls).toHaveLength(1);
    expect(lowStockCalls[0][0].dedupKey).toMatch(
      new RegExp(`^inventory\\.low_stock:${ITEM_ID}:${LOCATION_ID}:\\d{4}-\\d{2}-\\d{2}$`),
    );
  });
});
