/**
 * inv-stock-low-stock.test.ts — P5 §1.1: GET /api/inventory/low-stock
 *
 * Server-computed low-stock view over StockBalance: rows where min is set AND
 * on_hand < min. Immune to the FE's 100-item window. {data,meta} envelope,
 * location filter, deterministic sort (location name asc, item name asc),
 * inactive items included (QA-105), vendor NAME joined (the P2 proposal
 * groups on it). No cost fields on this endpoint at all.
 *
 * Harness: supertest against app, prisma fully mocked (setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  stockBalance: { findMany: ReturnType<typeof vi.fn> };
};

const LOCATION_2_ID = 'aaaaaaa1-0000-0000-0000-000000000002';
const ITEM_2_ID = 'aaaaaaa2-0000-0000-0000-000000000009';

/** A StockBalance row as the endpoint's include shapes it. */
function balanceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbb0-0000-0000-0000-000000000001',
    item_id: PRICE_BOOK_ITEM_FIXTURE.id,
    location_id: INVENTORY_LOCATION_FIXTURE.id,
    on_hand: '4.50', // Prisma Decimal round-trips as a stringable — mapper must Number() it
    reserved: 0,
    min: 5,
    max: 12,
    organization_id: ALPHA_ORG_ID,
    item: {
      id: PRICE_BOOK_ITEM_FIXTURE.id,
      sku: 'LOCK-100',
      name: 'Deadbolt Lock',
      kind: 'part',
      status: 'active',
      is_active: true,
      track_inventory: true,
      vendor_id: 'ccccccc1-0000-0000-0000-000000000001',
      vendor: { id: 'ccccccc1-0000-0000-0000-000000000001', name: 'Acme Supply' },
    },
    location: { id: INVENTORY_LOCATION_FIXTURE.id, name: 'Main Warehouse', type: 'warehouse' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/inventory/low-stock', () => {
  it('returns only rows with on_hand < min, Decimal-safe at the boundary (4.50 < 5 in; 5.00 vs 5 out)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000001', on_hand: '4.50', min: 5 }),
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000002', on_hand: '5.00', min: 5 }),
    ]);

    const res = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].onHand).toBe(4.5);
    expect(res.body.data[0].min).toBe(5);
    expect(res.body.meta.total).toBe(1);
  });

  it('queries only balances with a configured min, tenant-scoped (cross-org rows can never appear)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const where = mockPrisma.stockBalance.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.min).toEqual({ not: null });
  });

  it('passes location_id through to the where when provided; rejects a non-uuid with 400', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);

    const ok = await request(app)
      .get(`/api/inventory/low-stock?location_id=${INVENTORY_LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(ok.status).toBe(200);
    expect(mockPrisma.stockBalance.findMany.mock.calls[0][0].where.location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);

    const bad = await request(app).get('/api/inventory/low-stock?location_id=not-a-uuid').set(authHeader('admin'));
    expect(bad.status).toBe(400);
  });

  it('paginates the FILTERED set with a {data,meta} envelope', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000001', on_hand: 1, min: 5, item: { ...balanceRow().item, name: 'Item A' } }),
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000002', on_hand: 2, min: 5, item: { ...balanceRow().item, name: 'Item B' } }),
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000003', on_hand: 3, min: 5, item: { ...balanceRow().item, name: 'Item C' } }),
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000004', on_hand: 9, min: 5 }), // NOT low — excluded before paging
    ]);

    const res = await request(app).get('/api/inventory/low-stock?page=2&limit=2').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Item C');
    expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('sorts deterministically: location name asc, then item name asc', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({
        id: 'bbbbbbb0-0000-0000-0000-000000000001', on_hand: 1, min: 5,
        location_id: LOCATION_2_ID, location: { id: LOCATION_2_ID, name: 'Van 2', type: 'van' },
        item: { ...balanceRow().item, name: 'Zeta Valve' },
      }),
      balanceRow({
        id: 'bbbbbbb0-0000-0000-0000-000000000002', on_hand: 1, min: 5,
        item: { ...balanceRow().item, id: ITEM_2_ID, name: 'Zeta Valve' },
      }),
      balanceRow({ id: 'bbbbbbb0-0000-0000-0000-000000000003', on_hand: 1, min: 5 }), // Main Warehouse / Deadbolt Lock
    ]);

    const res = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => [r.locationName, r.name])).toEqual([
      ['Main Warehouse', 'Deadbolt Lock'],
      ['Main Warehouse', 'Zeta Valve'],
      ['Van 2', 'Zeta Valve'],
    ]);
  });

  it('includes deactivated items with isActive:false (QA-105) and joins the vendor name', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({ on_hand: 2, min: 5, item: { ...balanceRow().item, is_active: false } }),
    ]);

    const res = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row.isActive).toBe(false);
    expect(row.vendorName).toBe('Acme Supply');
    expect(row.vendorId).toBe('ccccccc1-0000-0000-0000-000000000001');
    // No cost fields on this endpoint at all — nothing to leak.
    expect('unitCost' in row).toBe(false);
    expect('cost' in row).toBe(false);
  });

  it('null-safes a vendor-less item (manual-pick group downstream)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      balanceRow({ on_hand: 2, min: 5, item: { ...balanceRow().item, vendor_id: null, vendor: null } }),
    ]);

    const res = await request(app).get('/api/inventory/low-stock').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data[0].vendorName).toBeNull();
    expect(res.body.data[0].vendorId).toBeNull();
  });
});
