import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// D16 entry point 3 / QA-612: GET /purchase-orders/low-stock-proposals is a READ-ONLY
// proposal computation (quantities editable before create) — it never creates a PO.

const mockPrisma = prisma as unknown as {
  stockBalance: { findMany: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  purchaseOrder: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ITEM_A = 'aaaaaaa2-0000-0000-0000-000000000011';
const ITEM_B = 'aaaaaaa2-0000-0000-0000-000000000012';
const ITEM_C = 'aaaaaaa2-0000-0000-0000-000000000013';
const VENDOR_1 = 'e2000000-0000-0000-0000-000000000001';
const LOC = { id: INVENTORY_LOCATION_FIXTURE.id, name: 'Main Warehouse' };

const balanceRow = (over: Record<string, unknown>) => ({
  on_hand: '2',
  min: 5,
  location_id: LOC.id,
  location: LOC,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/inventory/purchase-orders/low-stock-proposals (D16 entry 3, QA-612)', () => {
  it('returns only below-min rows with ceil suggestedQty, grouped by vendor (null group included)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({
        on_hand: '2', min: 5,
        item: { id: ITEM_A, sku: 'LOCK-100', name: 'Deadbolt', uom: 'EA', unit_cost: 20, vendor_id: VENDOR_1, vendor: { id: VENDOR_1, name: 'Acme', contact_email: 'orders@acme.com' } },
      }),
      // At/above min — filtered out in JS (on_hand >= min).
      balanceRow({
        on_hand: '10', min: 5,
        item: { id: ITEM_B, sku: 'WIRE-12', name: 'Wire', uom: 'FT', unit_cost: 1, vendor_id: VENDOR_1, vendor: { id: VENDOR_1, name: 'Acme', contact_email: 'orders@acme.com' } },
      }),
      // Vendor-less item — returned in the manual (vendorId null) group, never auto-created.
      balanceRow({
        on_hand: '1.5', min: 4,
        item: { id: ITEM_C, sku: 'HINGE-3', name: 'Hinge', uom: 'EA', unit_cost: null, vendor_id: null, vendor: null },
      }),
    ]);

    const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(2);

    const acme = res.body.proposals.find((p: any) => p.vendorId === VENDOR_1);
    expect(acme.vendorName).toBe('Acme');
    expect(acme.vendorEmail).toBe('orders@acme.com');
    expect(acme.lines).toHaveLength(1);
    expect(acme.lines[0]).toMatchObject({
      itemId: ITEM_A, itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA',
      locationId: LOC.id, locationName: 'Main Warehouse',
      onHand: 2, min: 5, suggestedQty: 3, unitCost: 20,
    });

    const manual = res.body.proposals.find((p: any) => p.vendorId === null);
    expect(manual.vendorName).toBeNull();
    // ceil(4 - 1.5) = 3 (rounded up).
    expect(manual.lines[0].suggestedQty).toBe(3);
    expect(manual.lines[0].unitCost).toBeNull();
  });

  it('scopes the query to tracked+active items with a min set (D8/QA-105)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.proposals).toEqual([]);
    const where = mockPrisma.stockBalance.findMany.mock.calls[0][0].where;
    expect(where.min).toEqual({ not: null });
    expect(where.item).toEqual({ track_inventory: true, is_active: true });
    expect(where.organization_id).toBeDefined();
  });

  it('honors an org-validated locationId filter', async () => {
    mockAuthAs('admin');
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: LOC.id });
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/inventory/purchase-orders/low-stock-proposals?locationId=${LOC.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.stockBalance.findMany.mock.calls[0][0].where;
    expect(where.location_id).toBe(LOC.id);
  });

  it('404s on a cross-org locationId', async () => {
    mockAuthAs('admin');
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/inventory/purchase-orders/low-stock-proposals?locationId=99999999-9999-9999-9999-999999999999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('400s on a malformed locationId', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/inventory/purchase-orders/low-stock-proposals?locationId=not-a-uuid')
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
  });

  it('NEVER creates a purchase order (QA-612 propose-only)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({
        on_hand: '0', min: 3,
        item: { id: ITEM_A, sku: 'LOCK-100', name: 'Deadbolt', uom: 'EA', unit_cost: 20, vendor_id: VENDOR_1, vendor: { id: VENDOR_1, name: 'Acme', contact_email: null } },
      }),
    ]);

    const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });
});
