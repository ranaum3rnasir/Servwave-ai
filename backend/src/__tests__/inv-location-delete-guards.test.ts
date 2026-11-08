import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// `stock_balances.location_id` is ON DELETE RESTRICT (see the
// 20260601153624_emanuel_unified_modules migration), so an unguarded delete of a
// location that ever held stock raises P2003 and the generic catch turns it into
// an opaque 500. These tests pin the readable 409s instead.
const mockPrisma = prisma as unknown as {
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  stockBalance: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  organization: { count: ReturnType<typeof vi.fn> };
  jobStage: { count: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const LOCATION_ID = INVENTORY_LOCATION_FIXTURE.id;
const url = `/api/inventory/locations/${LOCATION_ID}`;

/**
 * Transaction-client spies that are DISTINCT functions from the global mocks, so
 * "which client ran the delete" is assertable at all - the discipline established
 * by inventory-tx-connection-isolation.test.ts.
 *
 * This matters because the batch form `$transaction([...])` is BROKEN here: under
 * DB_TENANT_GUARD (lib/tenant-guard.ts) `prisma` is a Proxy whose model delegates
 * each open their own transaction and return a plain Promise rather than a
 * PrismaPromise, so building an array out of them fires the writes eagerly and
 * un-atomically and then throws. A mock that hands back the SAME spies for `tx`
 * and `prisma` cannot tell the two forms apart, which is exactly how the bug
 * reached staging: the rows were deleted and the caller still got a 500.
 */
const txClient = {
  stockBalance: { deleteMany: vi.fn() },
  inventoryLocation: { deleteMany: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  // Default: location exists, holds nothing, is not the org default.
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
  mockPrisma.inventoryLocation.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.count.mockResolvedValue(0);
  mockPrisma.stockBalance.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.organization.count.mockResolvedValue(0);
  mockPrisma.jobStage.count.mockResolvedValue(0);
  txClient.stockBalance.deleteMany.mockResolvedValue({ count: 0 });
  txClient.inventoryLocation.deleteMany.mockResolvedValue({ count: 1 });
  // Interactive form only. Handing an array in now throws, the same way the real
  // guarded client does, so a regression to the batch form fails loudly here.
  mockPrisma.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== 'function') {
      throw new Error('Batch $transaction([...]) is unsupported under the tenant guard');
    }
    return arg(txClient);
  });
});

describe('DELETE /api/inventory/locations/:id — referential guards', () => {
  it('409s with a readable reason when the location still holds stock', async () => {
    mockPrisma.stockBalance.count.mockResolvedValue(3);

    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still holds stock/i);
    expect(res.body.error).toContain('3');
    expect(mockPrisma.inventoryLocation.deleteMany).not.toHaveBeenCalled();
  });

  it('counts only non-zero balances as stock', async () => {
    await request(app).delete(url).set(authHeader('admin'));

    const where = mockPrisma.stockBalance.count.mock.calls[0][0].where;
    expect(where.location_id).toBe(LOCATION_ID);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.OR).toEqual([{ on_hand: { not: 0 } }, { reserved: { not: 0 } }]);
  });

  it('409s when the location is the organization default', async () => {
    mockPrisma.organization.count.mockResolvedValue(1);

    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/default/i);
    expect(mockPrisma.inventoryLocation.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes leftover zero-quantity balances with the location in one transaction', async () => {
    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Interactive form, not the batch array form (see the txClient note above).
    expect(typeof mockPrisma.$transaction.mock.calls[0][0]).toBe('function');
    expect(txClient.stockBalance.deleteMany).toHaveBeenCalledWith({
      where: { location_id: LOCATION_ID, organization_id: ALPHA_ORG_ID },
    });
    expect(txClient.inventoryLocation.deleteMany).toHaveBeenCalledWith({
      where: { id: LOCATION_ID, organization_id: ALPHA_ORG_ID },
    });
    // Both writes go through the transaction client, never the global one.
    expect(mockPrisma.stockBalance.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryLocation.deleteMany).not.toHaveBeenCalled();
  });

  it('404s for a location outside the requesting org', async () => {
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.stockBalance.count).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryLocation.deleteMany).not.toHaveBeenCalled();
  });
});

// `job_stages.staged_location_id` is a bare `String? @db.Uuid` with NO Prisma
// relation, so unlike the two guards above there is no foreign key behind it -
// the database happily lets the location go and leaves the stage pointing at a
// row that no longer exists. That column is the DESTINATION of a stock receive
// (inv-stages.controller.ts receiveStageLine), and the stock_balances /
// stock_movements location FKs are real, so the next receive against such a
// stage is rejected by the database and surfaces as an opaque 500.
describe('DELETE /api/inventory/locations/:id - job stages staged here', () => {
  it('409s with a readable reason when active job stages are staged at the location', async () => {
    mockPrisma.jobStage.count.mockResolvedValue(2);

    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/job stage/i);
    expect(res.body.error).toContain('2');
    expect(mockPrisma.inventoryLocation.deleteMany).not.toHaveBeenCalled();
    expect(txClient.inventoryLocation.deleteMany).not.toHaveBeenCalled();
  });

  it('counts only this org and only stages that still hold the parts', async () => {
    await request(app).delete(url).set(authHeader('admin'));

    const where = mockPrisma.jobStage.count.mock.calls[0][0].where;
    expect(where.staged_location_id).toBe(LOCATION_ID);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    // `delivered` means the tech already took the parts away, so that reference
    // is history and must not block. Expressed as notIn rather than an allowlist
    // because JobStage.status is a free-form String, not an enum - an
    // unrecognised status has to block rather than slip through.
    expect(where.status).toEqual({ notIn: ['delivered'] });
  });

  it('still deletes when every referencing stage is delivered', async () => {
    mockPrisma.jobStage.count.mockResolvedValue(0);

    const res = await request(app).delete(url).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(txClient.inventoryLocation.deleteMany).toHaveBeenCalled();
  });
});
