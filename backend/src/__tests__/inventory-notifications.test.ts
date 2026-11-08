/**
 * inventory-notifications.test.ts
 *
 * TDD for Task 3.8: emit() hooks on inventory events across 4 controllers.
 *
 * Verbs covered:
 *   1. inventory.stock_approval_requested — createStockApproval (inv-stock.controller)
 *   2. inventory.low_stock               — applyStockMovement DOWNWARD crossing (inv-stock.controller)
 *   3. inventory.po_partial              — receivePurchaseOrder → status=partial (inv-po.controller)
 *   4. inventory.backorder               — upsertItem flips status TO on_backorder (inv-catalog.controller)
 *   5. inventory.staging_ready           — notifyTechReady (inv-stages.controller)
 *   6. inventory.staging_no_area         — notifyTechReady / updateJobStage with null staged_area (inv-stages.controller)
 *
 * Strategy:
 *   - vi.mock captures emit calls.
 *   - Tests hit real Express routes via supertest.
 *   - Prisma is fully mocked (vi.mock in setup.ts).
 *   - emit() is asserted on: verb, object.type, object.id, actorId, dedupKey.
 *   - fire-and-forget: we assert emit was called but never await its result.
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
  PRICE_BOOK_ITEM_FIXTURE,
  STOCK_BALANCE_FIXTURE,
  PURCHASE_ORDER_FIXTURE,
  JOB_STAGE_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { renderTemplate } from '../services/notifications/templates';
import { resolveRecipients } from '../services/notifications/resolveRecipients';

// ─── Spy on the notification emit function ────────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ──────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APPROVAL_ID = 'bbbbbb01-0000-0000-0000-000000000001';
const ITEM_ID = PRICE_BOOK_ITEM_FIXTURE.id;
const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;
const PO_ID = PURCHASE_ORDER_FIXTURE.id;
const STAGE_ID = JOB_STAGE_FIXTURE.id;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // Safe no-op defaults
  mockPrisma.stockMovement.create.mockResolvedValue({});
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.notification.findFirst.mockResolvedValue(null);
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });
  mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.findMany.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. inventory.stock_approval_requested — createStockApproval
// ═══════════════════════════════════════════════════════════════════════════════

// PARKED (P0 §C, QA-902): /stock-approvals answers 404 FEATURE_DISABLED, so the
// emit intake is unreachable through the route. The handler + this spec stay
// in-tree for cheap un-parking — un-skip when the feature returns.
describe.skip('createStockApproval — inventory.stock_approval_requested', () => {
  it('emits inventory.stock_approval_requested with approval id, actorId, and dedupKey', async () => {
    // Admin has create Inventory permission — use admin as the requestor for routing purposes.
    // The actorId in the emit is req.user!.id which will be the admin's id.
    mockAuthAs('admin');

    const approvalRow = {
      id: APPROVAL_ID,
      requested_at: new Date(),
      requested_by_tech_id: TEST_USERS.admin.id,
      requested_by_tech_name: 'Test Admin',
      type: 'consume_on_job',
      item_sku: 'LOCK-100',
      item_name: 'Deadbolt Lock',
      uom: 'EA',
      qty: 2,
      from_location_id: LOCATION_ID,
      from_location_name: 'Main Warehouse',
      to_location_id: null,
      to_location_name: null,
      job_id: null,
      job_number: null,
      customer_id: null,
      customer: null,
      reason: null,
      serial_captured: null,
      photo_url: null,
      status: 'pending',
      organization_id: ALPHA_ORG_ID,
      modifications: [],
    };

    mockPrisma.stockApproval.create.mockResolvedValue(approvalRow);

    const res = await request(app)
      .post('/api/inventory/stock-approvals')
      .set(authHeader('admin'))
      .send({
        type: 'consume_on_job',
        itemSku: 'LOCK-100',
        itemName: 'Deadbolt Lock',
        uom: 'EA',
        qty: 2,
        fromLocationId: LOCATION_ID,
        fromLocationName: 'Main Warehouse',
        requestedByTechId: TEST_USERS.admin.id,
        requestedByTechName: 'Test Admin',
      });

    expect(res.status).toBe(201);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.stock_approval_requested');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('STOCK_APPROVAL');
    expect(args.object.id).toBe(APPROVAL_ID);
    expect(args.dedupKey).toBe(`inventory.stock_approval_requested:${APPROVAL_ID}`);
    // approval_id must be in data for the APPROVE_STOCK inline action
    expect(args.data?.approval_id).toBe(APPROVAL_ID);
    // entity should be {} (role-gated, not row-scoped)
    expect(args.entity).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. inventory.low_stock — applyStockMovement DOWNWARD CROSSING
// ═══════════════════════════════════════════════════════════════════════════════

describe('applyStockMovement (via transferStock) — inventory.low_stock crossing', () => {
  /**
   * The stock-approvals decide route (the original consume driver) is parked
   * behind featureDisabled (P0 §C), so the crossing logic is exercised through
   * the LIVE transfer route: type='transfer' does addTo(fromLocationId, -qty)
   * with the exact same source-side crossing check as consume.
   *
   * The upsert uses { increment: delta } so newOnHand = prevOnHand + delta and
   * the check reconstructs prevOnHand = newOnHand - delta. With delta=-2,
   * newOnHand=3, min=4: prev=3-(-2)=5 >= 4 AND new=3 < 4 → crossing → emit.
   */

  const LOCATION_ID_2 = 'aaaaaaa1-0000-0000-0000-000000000002';

  const mockTransferTx = (balance: Record<string, unknown>) => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: ITEM_ID, sku: 'LOCK-100', name: 'Deadbolt Lock' });
    mockPrisma.inventoryLocation.findFirst
      .mockResolvedValueOnce({ id: LOCATION_ID })
      .mockResolvedValueOnce({ id: LOCATION_ID_2 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        stockMovement: { create: vi.fn().mockResolvedValue({}) },
        stockBalance: { upsert: vi.fn().mockResolvedValue(balance) },
      };
      return fn(txMock);
    });
  };

  it('emits inventory.low_stock when on_hand crosses below min (downward)', async () => {
    mockAuthAs('admin');

    // After transfer-out(-2): newOnHand=3, min=4 → crossing
    mockTransferTx({
      item_id: ITEM_ID,
      location_id: LOCATION_ID,
      on_hand: 3,
      min: 4,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post('/api/inventory/transfer')
      .set(authHeader('admin'))
      .send({ itemId: ITEM_ID, fromId: LOCATION_ID, toId: LOCATION_ID_2, qty: 2 });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.low_stock');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBeNull(); // system-detected
    expect(args.object.type).toBe('INVENTORY_ITEM');
    expect(args.object.id).toBe(ITEM_ID);
    // dedupKey is daily: inventory.low_stock:{itemId}:{locationId}:{YYYY-MM-DD}
    expect(args.dedupKey).toMatch(
      new RegExp(`^inventory\\.low_stock:${ITEM_ID}:${LOCATION_ID}:\\d{4}-\\d{2}-\\d{2}$`),
    );
    expect(args.entity).toEqual({});
  });

  it('does NOT emit inventory.low_stock when on_hand was already below min (no new crossing)', async () => {
    mockAuthAs('admin');

    // was already below: newOnHand=2, delta=-1, prevOnHand=2-(-1)=3. min=4.
    // prev=3 < 4 → NO new crossing (was already below)
    mockTransferTx({
      item_id: ITEM_ID,
      location_id: LOCATION_ID,
      on_hand: 2,
      min: 4,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post('/api/inventory/transfer')
      .set(authHeader('admin'))
      .send({ itemId: ITEM_ID, fromId: LOCATION_ID, toId: LOCATION_ID_2, qty: 1 });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.low_stock');
    expect(call).toBeUndefined();
  });

  it('does NOT emit inventory.low_stock when balance has no min threshold', async () => {
    mockAuthAs('admin');

    // no min threshold → never fire
    mockTransferTx({
      item_id: ITEM_ID,
      location_id: LOCATION_ID,
      on_hand: 1,
      min: null,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post('/api/inventory/transfer')
      .set(authHeader('admin'))
      .send({ itemId: ITEM_ID, fromId: LOCATION_ID, toId: LOCATION_ID_2, qty: 2 });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.low_stock');
    expect(call).toBeUndefined();
  });

  it('does NOT emit inventory.low_stock on a RESTOCK (delta > 0, on_hand rises above min)', async () => {
    // A receive adds stock; the downward-crossing check never runs on the
    // destination side, and the delta >= 0 guard could never fire it anyway.
    mockAuthAs('admin');

    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: ITEM_ID, sku: 'LOCK-100', name: 'Deadbolt Lock' });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: LOCATION_ID });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        stockMovement: { create: vi.fn().mockResolvedValue({}) },
        stockBalance: {
          upsert: vi.fn().mockResolvedValue({
            item_id: ITEM_ID,
            location_id: LOCATION_ID,
            on_hand: 6,
            min: 4,
            organization_id: ALPHA_ORG_ID,
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/inventory/restock')
      .set(authHeader('admin'))
      .send({ itemId: ITEM_ID, locationId: LOCATION_ID, qty: 4 });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.low_stock');
    expect(call).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. inventory.po_partial — receivePurchaseOrder status → partial
// ═══════════════════════════════════════════════════════════════════════════════

describe('receivePurchaseOrder — inventory.po_partial', () => {
  it('emits inventory.po_partial when status becomes partial', async () => {
    mockAuthAs('admin');

    const po = {
      ...PURCHASE_ORDER_FIXTURE,
      status: 'ordered',
      lines: [
        { id: 'aaaaaaa5-0000-0000-0000-000000000001', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock', uom: 'EA', qty_ordered: 5, qty_received: 0, unit_cost: 20, price_book_item_id: null },
      ],
    };

    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: null });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        purchaseOrderLine: {
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([
            { qty_ordered: 5, qty_received: 2 }, // partial: 2 of 5 received
          ]),
        },
        stockMovement: {
          create: vi.fn().mockResolvedValue({}),
        },
        stockBalance: {
          upsert: vi.fn().mockResolvedValue({ on_hand: 12, min: null, item_id: ITEM_ID, location_id: LOCATION_ID }),
        },
        purchaseOrder: {
          update: vi.fn().mockResolvedValue({}),
          findFirst: vi.fn().mockResolvedValue({
            ...po,
            status: 'partial',
            lines: po.lines,
            job: null,
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/inventory/purchase-orders/receive')
      .set(authHeader('admin'))
      .send({
        poId: PO_ID,
        lines: [{ lineId: 'aaaaaaa5-0000-0000-0000-000000000001', qtyReceived: 2 }],
      });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.po_partial');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('PURCHASE_ORDER');
    expect(args.object.id).toBe(PO_ID);
    expect(args.object.label).toBe(po.po_number);
    expect(args.dedupKey).toBe(`inventory.po_partial:${PO_ID}`);
    expect(args.entity).toEqual({});
  });

  it('does NOT emit inventory.po_partial when status becomes fully received', async () => {
    mockAuthAs('admin');

    const po = {
      ...PURCHASE_ORDER_FIXTURE,
      status: 'ordered',
      lines: [
        { id: 'aaaaaaa5-0000-0000-0000-000000000001', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock', uom: 'EA', qty_ordered: 5, qty_received: 0, unit_cost: 20, price_book_item_id: null },
      ],
    };

    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: null });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        purchaseOrderLine: {
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([
            { qty_ordered: 5, qty_received: 5 }, // fully received
          ]),
        },
        stockMovement: {
          create: vi.fn().mockResolvedValue({}),
        },
        stockBalance: {
          upsert: vi.fn().mockResolvedValue({ on_hand: 15, min: null, item_id: ITEM_ID, location_id: LOCATION_ID }),
        },
        purchaseOrder: {
          update: vi.fn().mockResolvedValue({}),
          findFirst: vi.fn().mockResolvedValue({
            ...po,
            status: 'received',
            lines: po.lines,
            job: null,
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/inventory/purchase-orders/receive')
      .set(authHeader('admin'))
      .send({
        poId: PO_ID,
        lines: [{ lineId: 'aaaaaaa5-0000-0000-0000-000000000001', qtyReceived: 5 }],
      });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.po_partial');
    expect(call).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. inventory.backorder — price-book item write flips status TO on_backorder
//    (the emit moved with the single catalog write path — P0 §D1; the old
//    POST /api/inventory/items route answers 410 Gone)
// ═══════════════════════════════════════════════════════════════════════════════

describe('price-book item write — inventory.backorder', () => {
  it('emits inventory.backorder when status flips TO on_backorder (update path)', async () => {
    mockAuthAs('admin');

    const existingItem = {
      ...PRICE_BOOK_ITEM_FIXTURE,
      status: 'active', // was NOT on_backorder
    };

    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst
      .mockResolvedValueOnce(existingItem) // first call: pre-update read for backorder detection
      .mockResolvedValue({
        ...existingItem,
        status: 'on_backorder',
        category: null,
      });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_ID}`)
      .set(authHeader('admin'))
      .send({
        name: 'Deadbolt Lock',
        sell_price: 40,
        status: 'on_backorder',
      });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.backorder');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVENTORY_ITEM');
    expect(args.object.id).toBe(ITEM_ID);
    expect(args.dedupKey).toBe(`inventory.backorder:${ITEM_ID}`);
    expect(args.entity).toEqual({});
  });

  it('emits inventory.backorder on CREATE when status is on_backorder', async () => {
    mockAuthAs('admin');

    const newItemId = 'cccccc01-0000-0000-0000-000000000001';

    mockPrisma.priceBookItem.create.mockResolvedValue({
      id: newItemId,
      sku: 'NEW-SKU',
      name: 'New Item',
      unit_price: 30,
      sell_price: 30,
      status: 'on_backorder',
      category: null,
      updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({
        name: 'New Item',
        sell_price: 30,
        status: 'on_backorder',
      });

    expect(res.status).toBe(201);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.backorder');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.object.id).toBe(newItemId);
    expect(args.dedupKey).toBe(`inventory.backorder:${newItemId}`);
  });

  it('does NOT emit inventory.backorder when status stays on_backorder (already was)', async () => {
    mockAuthAs('admin');

    const existingItem = {
      ...PRICE_BOOK_ITEM_FIXTURE,
      status: 'on_backorder', // was ALREADY on_backorder
    };

    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst
      .mockResolvedValueOnce(existingItem) // pre-update read
      .mockResolvedValue({
        ...existingItem,
        category: null,
      });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_ID}`)
      .set(authHeader('admin'))
      .send({
        name: 'Deadbolt Lock',
        sell_price: 40,
        status: 'on_backorder',
      });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.backorder');
    expect(call).toBeUndefined();
  });

  it('does NOT emit inventory.backorder when status is something other than on_backorder', async () => {
    mockAuthAs('admin');

    const existingItem = {
      ...PRICE_BOOK_ITEM_FIXTURE,
      status: 'active',
    };

    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst
      .mockResolvedValueOnce(existingItem)
      .mockResolvedValue({
        ...existingItem,
        status: 'inactive',
        category: null,
      });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_ID}`)
      .set(authHeader('admin'))
      .send({
        name: 'Deadbolt Lock',
        sell_price: 40,
        status: 'inactive',
      });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.backorder');
    expect(call).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. inventory.staging_ready — notifyTechReady
// ═══════════════════════════════════════════════════════════════════════════════

describe('notifyTechReady — inventory.staging_ready', () => {
  it('emits inventory.staging_ready after stage status set to ready_for_pickup', async () => {
    mockAuthAs('dispatcher');

    const stageRow = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'ready_for_pickup',
      staged_area: 'Shelf A', // has a staged area → no staging_no_area
    };

    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(stageRow);

    const res = await request(app)
      .post('/api/inventory/job-stages/notify')
      .set(authHeader('dispatcher'))
      .send({ stageId: STAGE_ID });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_ready');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.dispatcher.id);
    expect(args.object.type).toBe('JOB_STAGE');
    expect(args.object.id).toBe(STAGE_ID);
    expect(args.object.label).toBe(stageRow.job_number);
    expect(args.dedupKey).toBe(`inventory.staging_ready:${STAGE_ID}`);
    expect(args.entity).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. inventory.staging_no_area — notifyTechReady when staged_area is null
// ═══════════════════════════════════════════════════════════════════════════════

describe('notifyTechReady — inventory.staging_no_area when staged_area is null', () => {
  it('emits inventory.staging_no_area when stage is ready_for_pickup AND staged_area is null', async () => {
    mockAuthAs('dispatcher');

    const stageRow = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'ready_for_pickup',
      staged_area: null, // no staging area → emit staging_no_area
    };

    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(stageRow);

    const res = await request(app)
      .post('/api/inventory/job-stages/notify')
      .set(authHeader('dispatcher'))
      .send({ stageId: STAGE_ID });

    expect(res.status).toBe(200);

    const readyCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_ready');
    expect(readyCall).toBeDefined();

    const noAreaCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_no_area');
    expect(noAreaCall).toBeDefined();
    const args = noAreaCall![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.dispatcher.id);
    expect(args.object.type).toBe('JOB_STAGE');
    expect(args.object.id).toBe(STAGE_ID);
    expect(args.dedupKey).toBe(`inventory.staging_no_area:${STAGE_ID}`);
    expect(args.entity).toEqual({});
  });

  it('does NOT emit inventory.staging_no_area when staged_area is set', async () => {
    mockAuthAs('dispatcher');

    const stageRow = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'ready_for_pickup',
      staged_area: 'Bay 3',
    };

    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(stageRow);

    const res = await request(app)
      .post('/api/inventory/job-stages/notify')
      .set(authHeader('dispatcher'))
      .send({ stageId: STAGE_ID });

    expect(res.status).toBe(200);

    const noAreaCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_no_area');
    expect(noAreaCall).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. inventory.staging_no_area — updateJobStage with status ∈ {complete, ready_for_pickup} AND staged_area null
// ═══════════════════════════════════════════════════════════════════════════════

describe('updateJobStage — inventory.staging_no_area', () => {
  it('emits inventory.staging_no_area when status=complete AND staged_area is null', async () => {
    mockAuthAs('dispatcher');

    const existing = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'awaiting_parts',
      staged_area: null,
    };

    const updated = {
      ...existing,
      status: 'complete',
      staged_area: null,
    };

    mockPrisma.jobStage.findFirst
      .mockResolvedValueOnce(existing) // pre-update read
      .mockResolvedValue({ ...updated, items: existing.items, photos: [], audit_log: [], customer_rel: null });
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/inventory/job-stages/${STAGE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ status: 'complete' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_no_area');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.object.id).toBe(STAGE_ID);
    expect(args.dedupKey).toBe(`inventory.staging_no_area:${STAGE_ID}`);
  });

  it('emits inventory.staging_no_area when status=ready_for_pickup AND staged_area is null via updateJobStage', async () => {
    mockAuthAs('dispatcher');

    const existing = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'awaiting_parts',
      staged_area: null,
    };

    const updated = {
      ...existing,
      status: 'ready_for_pickup',
      staged_area: null,
    };

    mockPrisma.jobStage.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ ...updated, items: existing.items, photos: [], audit_log: [], customer_rel: null });
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/inventory/job-stages/${STAGE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ status: 'ready_for_pickup' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_no_area');
    expect(call).toBeDefined();
  });

  it('does NOT emit inventory.staging_no_area when staged_area is set on update', async () => {
    mockAuthAs('dispatcher');

    const existing = {
      ...JOB_STAGE_FIXTURE,
      id: STAGE_ID,
      status: 'awaiting_parts',
      staged_area: null,
    };

    const updated = {
      ...existing,
      status: 'complete',
      staged_area: 'Bay 2', // area IS set
    };

    mockPrisma.jobStage.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ ...updated, items: existing.items, photos: [], audit_log: [], customer_rel: null });
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/inventory/job-stages/${STAGE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ status: 'complete', stagedArea: 'Bay 2' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'inventory.staging_no_area');
    expect(call).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P5 §4 — template copy (low_stock body) + recipient matrix (QA-701)
// Pure-function assertions: renderTemplate + resolveRecipients directly.
// ═══════════════════════════════════════════════════════════════════════════════

describe('inventory.low_stock template body (P5 §4)', () => {
  it('renders "N on hand (min M)" from the emit payload', () => {
    const t = renderTemplate('inventory.low_stock', {
      item_name: 'Deadbolt Lock',
      location_id: LOCATION_ID,
      on_hand: 3,
      min: 4,
    });
    expect(t.title).toBe('Low stock: Deadbolt Lock');
    expect(t.body).toBe('3 on hand (min 4)');
  });

  it('renders a zero on_hand honestly (0 != missing)', () => {
    expect(renderTemplate('inventory.low_stock', { item_name: 'X', on_hand: 0, min: 2 }).body).toBe('0 on hand (min 2)');
  });

  it('renders fractional on_hand as stored (Decimal ledger)', () => {
    expect(renderTemplate('inventory.low_stock', { item_name: 'Wire', on_hand: 2.5, min: 4 }).body).toBe('2.5 on hand (min 4)');
  });

  it('omits the body when on_hand or min is missing (no fabricated numbers)', () => {
    expect(renderTemplate('inventory.low_stock', { item_name: 'X' }).body).toBeUndefined();
    expect(renderTemplate('inventory.low_stock', { item_name: 'X', on_hand: 3 }).body).toBeUndefined();
    expect(renderTemplate('inventory.low_stock', { item_name: 'X', min: 4 }).body).toBeUndefined();
  });
});

describe('inventory FEED verbs → Admin + Dispatcher FEED, Technician/Sales excluded (QA-701)', () => {
  const roleHolders = {
    ADMIN: ['admin-1'],
    DISPATCHER: ['disp-1'],
    SALES: ['sales-1'],
    TECHNICIAN: ['tech-1'],
  };

  for (const verb of ['inventory.low_stock', 'inventory.backorder', 'inventory.po_partial'] as const) {
    it(`${verb} routes to Admin + Dispatcher as FEED only`, () => {
      const recipients = resolveRecipients({
        verb,
        organizationId: ALPHA_ORG_ID,
        actorId: null,
        entity: {},
        roleHolders,
      });
      expect(recipients.map((r) => r.userId).sort()).toEqual(['admin-1', 'disp-1']);
      expect(recipients.every((r) => r.priority === 'FEED' && r.needs_action === false)).toBe(true);
    });
  }
});
