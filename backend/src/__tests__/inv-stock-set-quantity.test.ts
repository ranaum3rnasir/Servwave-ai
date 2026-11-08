/**
 * Inventory P1 §3.3 — "Set quantity" count action (QA-205).
 *
 * POST /api/inventory/stock/set-quantity: "Counted N" becomes ONE signed `adjust` movement of
 * (counted − on_hand) via applyStockMovement. Zero delta ⇒ no movement, no audit. Block-mode is
 * EXEMPT (a physical count is truth). Gate: update Inventory (Admin + Dispatcher).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  stockBalance: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ITEM_ID = PRICE_BOOK_ITEM_FIXTURE.id;
const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 9 });
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7 });
  mockPrisma.stockMovement.create.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('POST /api/inventory/stock/set-quantity (P1 §3.3)', () => {
  it('counted 7 vs on_hand 9 → one signed adjust of −2 with the count reference (QA-205)', async () => {
    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: 7, reason: 'annual count' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, on_hand: 7, delta: -2 });
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.type).toBe('adjust');
    expect(data.qty).toBe(-2);
    expect(data.item_id).toBe(ITEM_ID);
    expect(data.to_location_id).toBe(LOCATION_ID);
    expect(data.reference).toBe('count: annual count');
    expect(data.unit_cost).toBeNull(); // a count is a quantity correction, not a cost event
  });

  it('counted == on_hand → no movement, no audit, delta 0', async () => {
    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: 9 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, on_hand: 9, delta: 0 });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('missing balance row → previous 0, delta = counted', async () => {
    mockPrisma.stockBalance.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: 5 });

    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(5);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.qty).toBe(5);
  });

  it('fractional count passes through (Decimal ledger): counted 2.5 vs 0 → adjust +2.5', async () => {
    mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 0 });

    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: 2.5 });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.qty).toBe(2.5);
  });

  it('cross-org item → 404 (QA-805)', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: '99999999-9999-9999-9999-999999999999', location_id: LOCATION_ID, counted_qty: 3 });

    expect(res.status).toBe(404);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('cross-org location → 404 (QA-805)', async () => {
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: '99999999-9999-9999-9999-999999999999', counted_qty: 3 });

    expect(res.status).toBe(404);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('negative counted_qty → 400 (a physical count is never negative)', async () => {
    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader('admin'))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: -1 });

    expect(res.status).toBe(400);
  });

  it.each(['sales', 'technician'] as const)('%s (no update Inventory) → 403', async (role) => {
    mockAuthAs(role);

    const res = await request(app).post('/api/inventory/stock/set-quantity').set(authHeader(role))
      .send({ item_id: ITEM_ID, location_id: LOCATION_ID, counted_qty: 3 });

    expect(res.status).toBe(403);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
