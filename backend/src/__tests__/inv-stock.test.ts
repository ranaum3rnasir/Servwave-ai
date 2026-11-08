import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { applyStockMovement, ShortageError } from '../controllers/inv-stock.controller';

const mockPrisma = prisma as unknown as {
  stockApproval: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('applyStockMovement', () => {
  it('upserts StockBalance and emits a StockMovement (receive adds on_hand)', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 5, itemId: PRICE_BOOK_ITEM_FIXTURE.id, toLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'PO-1001', actor: 'Test Admin',
    });
    expect(tx.stockMovement.create).toHaveBeenCalledOnce();
    expect(tx.stockBalance.upsert).toHaveBeenCalledOnce();
    const upsertArg = tx.stockBalance.upsert.mock.calls[0][0];
    expect(upsertArg.update.on_hand).toEqual({ increment: 5 });
  });

  it('skips the StockBalance update when itemId is unknown (uncatalogued SKU)', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn() },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive', itemSku: 'NOPE', itemName: 'Unknown',
      qty: 3, itemId: null, toLocationId: INVENTORY_LOCATION_FIXTURE.id, reference: 'PO-9', actor: 'Test Admin',
    });
    expect(tx.stockMovement.create).toHaveBeenCalledOnce();
    expect(tx.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('passes fractional qty through unrounded (Decimal ledger)', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive',
      itemSku: 'WIRE-12', itemName: '12ga Wire (ft)',
      qty: 2.5, itemId: PRICE_BOOK_ITEM_FIXTURE.id, toLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'PO-1002', actor: 'Test Admin',
    });
    expect(tx.stockMovement.create.mock.calls[0][0].data.qty).toBe(2.5);
    expect(tx.stockBalance.upsert.mock.calls[0][0].update.on_hand).toEqual({ increment: 2.5 });
  });

  it('consume against a missing balance row creates a NEGATIVE on_hand (no clamp)', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'consume',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 3, itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'J00001', actor: 'Test Admin',
    });
    expect(tx.stockBalance.upsert.mock.calls[0][0].create.on_hand).toBe(-3);
  });

  it('persists the new ledger refs when provided', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 1, itemId: PRICE_BOOK_ITEM_FIXTURE.id,
      jobId: 'a1b2c3d4-0000-0000-0000-000000000011',
      jobLineItemId: 'a1b2c3d4-0000-0000-0000-000000000012',
      invoiceLineItemId: 'a1b2c3d4-0000-0000-0000-000000000013',
      unitCost: 12.5,
      actorUserId: TEST_USERS.admin.id,
      toLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'PO-1003', actor: 'Test Admin',
    });
    const data = tx.stockMovement.create.mock.calls[0][0].data;
    expect(data.item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
    expect(data.job_id).toBe('a1b2c3d4-0000-0000-0000-000000000011');
    expect(data.job_line_item_id).toBe('a1b2c3d4-0000-0000-0000-000000000012');
    expect(data.invoice_line_item_id).toBe('a1b2c3d4-0000-0000-0000-000000000013');
    expect(data.unit_cost).toBe(12.5);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('persists null for omitted ledger refs', async () => {
    const tx = {
      stockBalance: { upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive', itemSku: 'NOPE', itemName: 'Unknown',
      qty: 1, itemId: null, toLocationId: INVENTORY_LOCATION_FIXTURE.id, reference: 'PO-1004', actor: 'Test Admin',
    });
    const data = tx.stockMovement.create.mock.calls[0][0].data;
    expect(data.item_id).toBeNull();
    expect(data.job_id).toBeNull();
    expect(data.job_line_item_id).toBeNull();
    expect(data.invoice_line_item_id).toBeNull();
    expect(data.unit_cost).toBeNull();
    expect(data.actor_user_id).toBeNull();
  });
});

// ─── P1 §0.1 — block-mode conditional atomic decrement + StockMovementResult ──

describe('applyStockMovement — blockNegative + result value (P1 §0.1)', () => {
  function txMock(over: Record<string, any> = {}) {
    return {
      stockBalance: {
        upsert: vi.fn().mockResolvedValue({ on_hand: 7, min: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ on_hand: 7, min: null }),
        ...over.stockBalance,
      },
      stockMovement: { create: vi.fn().mockResolvedValue({}), ...over.stockMovement },
    } as any;
  }

  const CONSUME = {
    orgId: ALPHA_ORG_ID, type: 'consume' as const,
    itemSku: 'LOCK-100', itemName: 'Deadbolt',
    qty: 3, itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromLocationId: INVENTORY_LOCATION_FIXTURE.id,
    reference: 'J00001', actor: 'Test Admin',
  };

  it('blockNegative consume issues a conditional atomic updateMany (on_hand >= qty), never the unclamped upsert', async () => {
    const tx = txMock();
    await applyStockMovement(tx, { ...CONSUME, blockNegative: true });
    expect(tx.stockBalance.updateMany).toHaveBeenCalledOnce();
    const arg = tx.stockBalance.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      item_id: PRICE_BOOK_ITEM_FIXTURE.id,
      location_id: INVENTORY_LOCATION_FIXTURE.id,
      on_hand: { gte: 3 },
    });
    expect(arg.data.on_hand).toEqual({ decrement: 3 });
    expect(tx.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('blockNegative rowcount 0 throws ShortageError with available from the follow-up read — and the movement row is NEVER written', async () => {
    const tx = txMock({
      stockBalance: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ on_hand: 1 }),
        upsert: vi.fn(),
      },
    });
    await expect(applyStockMovement(tx, { ...CONSUME, blockNegative: true })).rejects.toThrowError(ShortageError);
    try {
      await applyStockMovement(tx, { ...CONSUME, blockNegative: true });
    } catch (err) {
      const e = err as ShortageError;
      expect(e.itemId).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
      expect(e.locationId).toBe(INVENTORY_LOCATION_FIXTURE.id);
      expect(e.requested).toBe(3);
      expect(e.available).toBe(1);
    }
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('blockNegative shortage against a MISSING balance row reports available 0', async () => {
    const tx = txMock({
      stockBalance: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    });
    await expect(applyStockMovement(tx, { ...CONSUME, blockNegative: true })).rejects.toMatchObject({ available: 0 });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('block-mode success returns { onHandAfter, shortage: false } and writes the movement', async () => {
    const tx = txMock({
      stockBalance: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ on_hand: 4, min: null }),
        upsert: vi.fn(),
      },
    });
    const result = await applyStockMovement(tx, { ...CONSUME, blockNegative: true });
    expect(result).toEqual({ onHandAfter: 4, shortage: false });
    expect(tx.stockMovement.create).toHaveBeenCalledOnce();
  });

  it('warn-mode over-draw returns { shortage: true, onHandAfter: <negative> } from the unclamped upsert', async () => {
    const tx = txMock({ stockBalance: { upsert: vi.fn().mockResolvedValue({ on_hand: -2, min: null }), updateMany: vi.fn(), findUnique: vi.fn() } });
    const result = await applyStockMovement(tx, CONSUME);
    expect(result.shortage).toBe(true);
    expect(result.onHandAfter).toBe(-2);
    expect(tx.stockBalance.updateMany).not.toHaveBeenCalled();
  });

  it('writes the balance FIRST and the movement row LAST (blocked deduction can never reach the ledger)', async () => {
    const tx = txMock();
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'receive',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 5, itemId: PRICE_BOOK_ITEM_FIXTURE.id, toLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'PO-1001', actor: 'Test Admin',
    });
    expect(tx.stockBalance.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(tx.stockMovement.create.mock.invocationCallOrder[0]);
  });

  it('transfer source honors blockNegative (conditional decrement) while the destination still upserts', async () => {
    const tx = txMock();
    await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'transfer',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 2, itemId: PRICE_BOOK_ITEM_FIXTURE.id,
      fromLocationId: INVENTORY_LOCATION_FIXTURE.id,
      toLocationId: 'aaaaaaa1-0000-0000-0000-000000000002',
      reference: 'transfer', actor: 'Test Admin', blockNegative: true,
    });
    expect(tx.stockBalance.updateMany).toHaveBeenCalledOnce();
    expect(tx.stockBalance.updateMany.mock.calls[0][0].where.location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
    expect(tx.stockBalance.upsert).toHaveBeenCalledOnce();
    expect(tx.stockBalance.upsert.mock.calls[0][0].update.on_hand).toEqual({ increment: 2 });
  });

  it('transfer source shortage aborts BEFORE the destination is credited (no movement either)', async () => {
    const tx = txMock({
      stockBalance: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ on_hand: 0 }),
        upsert: vi.fn(),
      },
    });
    await expect(applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'transfer',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: 2, itemId: PRICE_BOOK_ITEM_FIXTURE.id,
      fromLocationId: INVENTORY_LOCATION_FIXTURE.id,
      toLocationId: 'aaaaaaa1-0000-0000-0000-000000000002',
      reference: 'transfer', actor: 'Test Admin', blockNegative: true,
    })).rejects.toThrowError(ShortageError);
    expect(tx.stockBalance.upsert).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('signed adjust (qty −2) decrements the destination balance and persists the signed qty', async () => {
    const tx = txMock();
    const result = await applyStockMovement(tx, {
      orgId: ALPHA_ORG_ID, type: 'adjust',
      itemSku: 'LOCK-100', itemName: 'Deadbolt',
      qty: -2, itemId: PRICE_BOOK_ITEM_FIXTURE.id, toLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'count', actor: 'Test Admin',
    });
    expect(tx.stockBalance.upsert.mock.calls[0][0].update.on_hand).toEqual({ increment: -2 });
    expect(tx.stockMovement.create.mock.calls[0][0].data.qty).toBe(-2);
    expect(result.onHandAfter).toBe(7);
  });
});

// PARKED (P0 §C, QA-902): the decide route answers 404 FEATURE_DISABLED, so the
// handler is unreachable through HTTP. Handler + spec stay in-tree for cheap
// un-parking — un-skip when the feature returns.
describe.skip('POST /api/inventory/stock-approvals/decide — stock effect (V5)', () => {
  it('on approve(consume_on_job) emits a consume StockMovement + sets reviewed_by_id', async () => {
    mockAuthAs('admin');
    const approval = { id: 'aaaaaaa0-0000-0000-0000-000000000001', status: 'pending', type: 'consume_on_job', item_sku: 'LOCK-100', item_name: 'Deadbolt', qty: 2, from_location_id: INVENTORY_LOCATION_FIXTURE.id, to_location_id: null, job_number: 'J00001', organization_id: ALPHA_ORG_ID };
    mockPrisma.stockApproval.findFirst.mockResolvedValueOnce(approval).mockResolvedValueOnce({ ...approval, status: 'approved', modifications: [] });
    mockPrisma.stockApproval.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/stock-approvals/decide').set(authHeader('admin'))
      .send({ id: approval.id, decision: 'approved', reviewedByName: 'Test Admin' });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.type).toBe('consume');
    expect(mockPrisma.stockApproval.updateMany.mock.calls[0][0].data.reviewed_by_id).toBe(TEST_USERS.admin.id);
  });

  it('on approve threads job_id + unit_cost + actor_user_id into the movement', async () => {
    mockAuthAs('admin');
    const jobId = 'a1b2c3d4-0000-0000-0000-000000000021';
    const approval = { id: 'aaaaaaa0-0000-0000-0000-000000000003', status: 'pending', type: 'consume_on_job', item_sku: 'LOCK-100', item_name: 'Deadbolt', qty: 2, from_location_id: INVENTORY_LOCATION_FIXTURE.id, to_location_id: null, job_id: jobId, job_number: 'J00001', organization_id: ALPHA_ORG_ID };
    mockPrisma.stockApproval.findFirst.mockResolvedValueOnce(approval).mockResolvedValueOnce({ ...approval, status: 'approved', modifications: [] });
    mockPrisma.stockApproval.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id, unit_cost: 20 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/stock-approvals/decide').set(authHeader('admin'))
      .send({ id: approval.id, decision: 'approved', reviewedByName: 'Test Admin' });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(jobId);
    expect(data.unit_cost).toBe(20);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('on reject does NOT emit a StockMovement', async () => {
    mockAuthAs('admin');
    const approval = { id: 'aaaaaaa0-0000-0000-0000-000000000002', status: 'pending', type: 'consume_on_job', item_sku: 'X', item_name: 'X', qty: 1, from_location_id: INVENTORY_LOCATION_FIXTURE.id, organization_id: ALPHA_ORG_ID };
    mockPrisma.stockApproval.findFirst.mockResolvedValueOnce(approval).mockResolvedValueOnce({ ...approval, status: 'rejected', modifications: [] });
    mockPrisma.stockApproval.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    await request(app).post('/api/inventory/stock-approvals/decide').set(authHeader('admin'))
      .send({ id: approval.id, decision: 'rejected', reviewedByName: 'Test Admin' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
