import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { logAudit } from '../lib/audit';
import {
  mockAuthAs, authHeader,
  PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE,
  JOB_STAGE_FIXTURE, BRAND_FIXTURE, ITEM_GROUP_FIXTURE, ALPHA_ORG_ID,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// P0 §B audit sweep: every inventory mutation fires exactly one endpoint-level
// void logAudit(...) after the write commits. Spy on logAudit itself (it is
// called synchronously, fire-and-forget) — one assertion per audit site.

vi.mock('../lib/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  writeSettingsAudit: vi.fn().mockResolvedValue(undefined),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
};

const auditedWith = (action: string) =>
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action }));

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockAuthAs('admin');
});

// ─── inv-po.controller ────────────────────────────────────────────────────

describe('purchase-order audits', () => {
  it('createPurchaseOrder → inventory.po_created', async () => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }] });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.po_created',
      resourceType: 'PurchaseOrder',
      resourceId: PURCHASE_ORDER_FIXTURE.id,
      metadata: expect.objectContaining({ po_number: PURCHASE_ORDER_FIXTURE.po_number, line_count: 1 }),
    }));
  });

  it('updatePurchaseOrder → inventory.po_updated', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.purchaseOrder.update.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).patch(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`)
      .set(authHeader('admin')).send({ status: 'received' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.po_updated',
      resourceType: 'PurchaseOrder',
      // Verdict §2: a status move is audited with both ends.
      metadata: expect.objectContaining({ status: 'received', status_from: 'ordered', status_to: 'received' }),
    }));
  });

  it('receivePurchaseOrder → inventory.po_received', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(
      PURCHASE_ORDER_FIXTURE.lines.map((l) => ({ ...l, qty_received: 5 })),
    );
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: PURCHASE_ORDER_FIXTURE.id, lines: [{ lineId: PURCHASE_ORDER_FIXTURE.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.po_received',
      resourceType: 'PurchaseOrder',
      resourceId: PURCHASE_ORDER_FIXTURE.id,
      metadata: expect.objectContaining({ lines_received: 1 }),
    }));
  });
});

// ─── inv-catalog.controller stock writes ──────────────────────────────────

describe('stock-write audits', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  });

  it('restock → inventory.stock_restocked', async () => {
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5 });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stock_restocked',
      resourceType: 'PriceBookItem',
      resourceId: PRICE_BOOK_ITEM_FIXTURE.id,
      metadata: expect.objectContaining({ qty: 5 }),
    }));
  });

  it('bulkRestock → inventory.stock_bulk_restocked', async () => {
    const res = await request(app).post('/api/inventory/bulk-restock').set(authHeader('admin'))
      .send({ lines: [{ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 3 }] });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stock_bulk_restocked',
      resourceType: 'StockMovement',
      resourceId: null,
      metadata: expect.objectContaining({ line_count: 1 }),
    }));
  });

  it('transferStock → inventory.stock_transferred', async () => {
    const res = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromId: INVENTORY_LOCATION_FIXTURE.id, toId: INVENTORY_LOCATION_FIXTURE.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stock_transferred',
      resourceType: 'PriceBookItem',
      resourceId: PRICE_BOOK_ITEM_FIXTURE.id,
      metadata: expect.objectContaining({ qty: 2 }),
    }));
  });

  it('setThresholds → inventory.thresholds_set', async () => {
    mockPrisma.stockBalance.upsert.mockResolvedValue({ min: 10, max: 20, on_hand: 0 });
    const res = await request(app).put('/api/inventory/stock/thresholds').set(authHeader('admin'))
      .send({ item_id: PRICE_BOOK_ITEM_FIXTURE.id, location_id: INVENTORY_LOCATION_FIXTURE.id, min: 10, max: 20 });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.thresholds_set',
      resourceType: 'PriceBookItem',
      resourceId: PRICE_BOOK_ITEM_FIXTURE.id,
      metadata: expect.objectContaining({ location_id: INVENTORY_LOCATION_FIXTURE.id, min: 10, max: 20 }),
    }));
  });
});

// ─── inv-stages.controller ────────────────────────────────────────────────

describe('job-stage audits', () => {
  it('createJobStage → inventory.stage_created', async () => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ jobNumber: 'J00001', customer: 'John Doe', site: '123 Main St', trade: 'locksmith', status: 'awaiting_parts' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stage_created',
      resourceType: 'JobStage',
      resourceId: JOB_STAGE_FIXTURE.id,
      metadata: expect.objectContaining({ job_number: 'J00001', item_count: 0 }),
    }));
  });

  it('updateJobStage → inventory.stage_updated', async () => {
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app).patch(`/api/inventory/job-stages/${JOB_STAGE_FIXTURE.id}`)
      .set(authHeader('admin')).send({ notes: 'updated' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stage_updated',
      resourceType: 'JobStage',
      resourceId: JOB_STAGE_FIXTURE.id,
      metadata: expect.objectContaining({ fields: ['notes'] }),
    }));
  });

  it('receiveStageLine → inventory.stage_line_received', async () => {
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id, itemId: JOB_STAGE_FIXTURE.items[0].id, qty: 2 });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stage_line_received',
      resourceType: 'JobStage',
      resourceId: JOB_STAGE_FIXTURE.id,
      metadata: expect.objectContaining({ stage_line_id: JOB_STAGE_FIXTURE.items[0].id, qty: 2 }),
    }));
  });

  it('notifyTechReady → inventory.stage_ready_notified', async () => {
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    const res = await request(app).post('/api/inventory/job-stages/notify').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.stage_ready_notified',
      resourceType: 'JobStage',
      resourceId: JOB_STAGE_FIXTURE.id,
      metadata: expect.objectContaining({ job_number: JOB_STAGE_FIXTURE.job_number }),
    }));
  });
});

// ─── inv-vendors.controller ───────────────────────────────────────────────

describe('vendor audits', () => {
  const VENDOR_ROW = {
    id: 'aaaaaad1-0000-0000-0000-000000000001',
    name: 'Acme Supply', category: 'Supplies', payment_terms: 'Net 30',
    lead_time_days: 3, transmit_method: 'email', contacts: [],
    organization_id: ALPHA_ORG_ID,
  };

  it('upsertVendor (create) → inventory.vendor_created', async () => {
    mockPrisma.vendor.create.mockResolvedValue(VENDOR_ROW);
    const res = await request(app).post('/api/inventory/vendors').set(authHeader('admin'))
      .send({ name: 'Acme Supply', category: 'Supplies' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.vendor_created',
      resourceType: 'Vendor',
      resourceId: VENDOR_ROW.id,
      metadata: expect.objectContaining({ name: 'Acme Supply' }),
    }));
  });

  it('upsertVendor (update) → inventory.vendor_updated', async () => {
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendor.update.mockResolvedValue(VENDOR_ROW);
    const res = await request(app).post('/api/inventory/vendors').set(authHeader('admin'))
      .send({ id: VENDOR_ROW.id, name: 'Acme Supply Co' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.vendor_updated',
      resourceType: 'Vendor',
      resourceId: VENDOR_ROW.id,
      metadata: expect.objectContaining({ fields: ['id', 'name'] }),
    }));
  });

  it('deleteVendor → inventory.vendor_deleted', async () => {
    // P2 item 7a: canonical DELETE /vendors/:id (POST /vendors/delete is 410 GONE).
    mockPrisma.purchaseOrder.count.mockResolvedValue(0);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/inventory/vendors/${VENDOR_ROW.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.vendor_deleted',
      resourceType: 'Vendor',
      resourceId: VENDOR_ROW.id,
    }));
  });
});

// ─── inv-locations.controller ─────────────────────────────────────────────

describe('branch + location audits', () => {
  const BRANCH_ROW = { id: 'aaaaaae1-0000-0000-0000-000000000001', name: 'Main Branch', organization_id: ALPHA_ORG_ID };

  it('createBranch → inventory.branch_created', async () => {
    mockPrisma.branch.create.mockResolvedValue(BRANCH_ROW);
    const res = await request(app).post('/api/inventory/branches').set(authHeader('admin'))
      .send({ name: 'Main Branch' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.branch_created',
      resourceType: 'Branch',
      resourceId: BRANCH_ROW.id,
      metadata: expect.objectContaining({ name: 'Main Branch' }),
    }));
  });

  it('updateBranch → inventory.branch_updated', async () => {
    mockPrisma.branch.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.branch.findFirst.mockResolvedValue(BRANCH_ROW);
    const res = await request(app).patch(`/api/inventory/branches/${BRANCH_ROW.id}`)
      .set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    auditedWith('inventory.branch_updated');
  });

  it('deleteBranch → inventory.branch_deleted', async () => {
    mockPrisma.branch.findFirst.mockResolvedValue({ ...BRANCH_ROW, _count: { locations: 0 } });
    mockPrisma.branch.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/inventory/branches/${BRANCH_ROW.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.branch_deleted',
      resourceType: 'Branch',
      resourceId: BRANCH_ROW.id,
    }));
  });

  it('createLocation → inventory.location_created', async () => {
    mockPrisma.inventoryLocation.create.mockResolvedValue({ ...INVENTORY_LOCATION_FIXTURE, branch: null, primary_tech: null });
    const res = await request(app).post('/api/inventory/locations').set(authHeader('admin'))
      .send({ name: 'Main Warehouse', type: 'warehouse' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.location_created',
      resourceType: 'InventoryLocation',
      resourceId: INVENTORY_LOCATION_FIXTURE.id,
      metadata: expect.objectContaining({ name: 'Main Warehouse', type: 'warehouse' }),
    }));
  });

  it('updateLocation → inventory.location_updated', async () => {
    mockPrisma.inventoryLocation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ ...INVENTORY_LOCATION_FIXTURE, branch: null, primary_tech: null });
    const res = await request(app).patch(`/api/inventory/locations/${INVENTORY_LOCATION_FIXTURE.id}`)
      .set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    auditedWith('inventory.location_updated');
  });

  it('deleteLocation → inventory.location_deleted', async () => {
    // The referential guards run before the delete (see
    // inv-location-delete-guards.test.ts): the location must exist, hold no
    // non-zero stock, and not be the org default.
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.stockBalance.count.mockResolvedValue(0);
    mockPrisma.organization.count.mockResolvedValue(0);
    mockPrisma.stockBalance.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(async (ops: any) =>
      Array.isArray(ops) ? Promise.all(ops) : ops(mockPrisma),
    );
    mockPrisma.inventoryLocation.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/inventory/locations/${INVENTORY_LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.location_deleted',
      resourceType: 'InventoryLocation',
      resourceId: INVENTORY_LOCATION_FIXTURE.id,
    }));
  });
});

// ─── price-book.controller — moved/new handlers (P0 §D2/§D3) ──────────────

describe('price-book brand / item-group / import audits', () => {
  it('upsertBrand (create) → pricebook.brand_created', async () => {
    mockPrisma.brand.create.mockResolvedValue(BRAND_FIXTURE);
    const res = await request(app).post('/api/price-book/brands').set(authHeader('admin'))
      .send({ name: 'Schlage' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.brand_created',
      resourceType: 'Brand',
      resourceId: BRAND_FIXTURE.id,
    }));
  });

  it('upsertBrand (update) → pricebook.brand_updated', async () => {
    mockPrisma.brand.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.brand.findFirst.mockResolvedValue(BRAND_FIXTURE);
    const res = await request(app).post('/api/price-book/brands').set(authHeader('admin'))
      .send({ id: BRAND_FIXTURE.id, name: 'Schlage Pro' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.brand_updated',
      resourceType: 'Brand',
      metadata: expect.objectContaining({ fields: ['id', 'name'] }),
    }));
  });

  it('deleteBrand → pricebook.brand_deleted', async () => {
    mockPrisma.brand.findFirst.mockResolvedValue({ ...BRAND_FIXTURE, _count: { items: 0 } });
    mockPrisma.brand.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/price-book/brands/${BRAND_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.brand_deleted',
      resourceType: 'Brand',
      resourceId: BRAND_FIXTURE.id,
    }));
  });

  it('upsertItemGroup (create) → pricebook.item_group_created', async () => {
    mockPrisma.itemGroup.create.mockResolvedValue(ITEM_GROUP_FIXTURE);
    const res = await request(app).post('/api/price-book/item-groups').set(authHeader('admin'))
      .send({ name: 'Door Hardware Kit', groupType: 'kit' });
    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.item_group_created',
      resourceType: 'ItemGroup',
      resourceId: ITEM_GROUP_FIXTURE.id,
    }));
  });

  it('upsertItemGroup (update) → pricebook.item_group_updated', async () => {
    mockPrisma.itemGroup.findFirst.mockResolvedValue({ id: ITEM_GROUP_FIXTURE.id });
    mockPrisma.itemGroup.update.mockResolvedValue(ITEM_GROUP_FIXTURE);
    const res = await request(app).post('/api/price-book/item-groups').set(authHeader('admin'))
      .send({ id: ITEM_GROUP_FIXTURE.id, name: 'Kit v2', groupType: 'kit' });
    expect(res.status).toBe(200);
    auditedWith('pricebook.item_group_updated');
  });

  it('deleteItemGroup → pricebook.item_group_deleted', async () => {
    mockPrisma.itemGroup.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/price-book/item-groups/${ITEM_GROUP_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.item_group_deleted',
      resourceType: 'ItemGroup',
      resourceId: ITEM_GROUP_FIXTURE.id,
    }));
  });

  it('importItems → pricebook.items_imported with created/updated/error counts', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 40 }] });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pricebook.items_imported',
      resourceType: 'PriceBookItem',
      resourceId: null,
      metadata: expect.objectContaining({ created: 1, updated: 0, error_count: 0 }),
    }));
  });
});
