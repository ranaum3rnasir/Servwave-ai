/**
 * Inventory P3 — GET /api/inventory/my-van (tech truck-stock view).
 *
 * Own-scope endpoint on the /my-today pattern: gated `read PriceBook` (after §3 every role
 * passes), the REAL boundary is structural — `primary_tech_id = req.user.id` + tenantWhere.
 * It must never consult the `Inventory` subject, and the response is cost-stripped BY
 * PROJECTION: unit_cost / list_price are never selected. 404 NO_VAN_ASSIGNED when no
 * InventoryLocation carries the requester's id (any role).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

const mockPrisma = prisma as unknown as {
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  stockBalance: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

const VAN_ID = 'aaaaaaa1-0000-0000-0000-000000000099';

const VAN_ROW = { id: VAN_ID, name: 'Van 1', type: 'truck', vehicle: 'Ford Transit 2521' };

// What the projection-limited select would return — picker-safe item fields only.
const BALANCE_ROWS = [
  {
    on_hand: 3.5,
    min: 1,
    max: 10,
    item: {
      id: 'aaaaaaa2-0000-0000-0000-000000000002',
      sku: 'WIRE-12',
      name: '12ga Wire (ft)',
      type: 'MATERIAL',
      uom: 'FT',
      unit_price: 4,
      track_inventory: true,
      is_active: true,
      image_url: null,
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockAuthAs('technician');
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(VAN_ROW);
  mockPrisma.stockBalance.findMany.mockResolvedValue(BALANCE_ROWS);
});

describe('GET /api/inventory/my-van', () => {
  it('tech with a van → 200 { location, restricted, balances } with numeric on_hand', async () => {
    const res = await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.location).toEqual({ id: VAN_ID, name: 'Van 1', type: 'truck', vehicle: 'Ford Transit 2521' });
    expect(res.body.restricted).toBe(false);
    expect(res.body.balances).toHaveLength(1);
    expect(res.body.balances[0].on_hand).toBe(3.5);
    expect(typeof res.body.balances[0].on_hand).toBe('number');
    expect(res.body.balances[0].min).toBe(1);
    expect(res.body.balances[0].item.name).toBe('12ga Wire (ft)');
    expect(res.body.balances[0].item.unit_price).toBe(4);
  });

  it('cost-strips BY PROJECTION: the select never asks for unit_cost / list_price, and the payload carries neither (QA-802)', async () => {
    const res = await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    expect(res.status).toBe(200);
    // API-level assert: no cost key anywhere in the response body.
    for (const b of res.body.balances) {
      expect(b.item).not.toHaveProperty('unit_cost');
      expect(b.item).not.toHaveProperty('list_price');
    }
    // Projection assert: the Prisma select itself omits the cost pair (stronger than
    // delete-after-read — the values never leave the DB).
    const arg = mockPrisma.stockBalance.findMany.mock.calls[0][0];
    const itemSelect = arg.select.item.select;
    expect(itemSelect).not.toHaveProperty('unit_cost');
    expect(itemSelect).not.toHaveProperty('list_price');
    expect(itemSelect.unit_price).toBe(true);
  });

  it('no van assigned → 404 NO_VAN_ASSIGNED, balances never queried', async () => {
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_VAN_ASSIGNED');
    expect(mockPrisma.stockBalance.findMany).not.toHaveBeenCalled();
  });

  it('tenancy: the van lookup is org-scoped + keyed to the requester; balances are van-scoped + org-scoped', async () => {
    await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    const vanWhere = mockPrisma.inventoryLocation.findFirst.mock.calls[0][0].where;
    expect(vanWhere.organization_id).toBe(TEST_USERS.technician.organization_id);
    expect(vanWhere.primary_tech_id).toBe(TEST_USERS.technician.id);

    const balWhere = mockPrisma.stockBalance.findMany.mock.calls[0][0].where;
    expect(balWhere.organization_id).toBe(TEST_USERS.technician.organization_id);
    expect(balWhere.location_id).toBe(VAN_ID);
  });

  it('deterministic one-van convention: the lookup orders by created_at asc', async () => {
    await request(app).get('/api/inventory/my-van').set(authHeader('technician'));
    expect(mockPrisma.inventoryLocation.findFirst.mock.calls[0][0].orderBy).toEqual({ created_at: 'asc' });
  });

  it('gate: a role WITHOUT read PriceBook → 403 (route never reaches the controller)', async () => {
    // Simulate a pre-backfill org / stripped role: no PriceBook read in the role grants.
    mockPrisma.rolePermission.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.inventoryLocation.findFirst).not.toHaveBeenCalled();
  });

  it('restricted:true when the tech carries the location_restricted allow-override', async () => {
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'location_restricted', subject: 'Inventory', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/inventory/my-van').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.restricted).toBe(true);
  });

  it('a DISPATCHER with a van gets their van too (restricted always false for non-techs); without one → 404', async () => {
    mockAuthAs('dispatcher');
    const ok = await request(app).get('/api/inventory/my-van').set(authHeader('dispatcher'));
    expect(ok.status).toBe(200);
    expect(ok.body.restricted).toBe(false);

    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);
    const missing = await request(app).get('/api/inventory/my-van').set(authHeader('dispatcher'));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('NO_VAN_ASSIGNED');
  });
});
