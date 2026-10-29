import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// A malformed PO `:id` path param (client placeholder like `po_new_…`, a
// truncated deep-link) reaches `prisma.purchaseOrder.findFirst({ where: { id } })`,
// but `purchase_orders.id` is a UUID column — Prisma throws P2023 inside the
// driver and the controller catch turns it into a 500. requireUuidParam('id')
// fails fast with the same 404 the handler returns for a genuinely-missing PO,
// BEFORE Prisma is touched. (Same defect class as inv-vendor-create-invalid-id.)
//
// The discriminating assertion is `findFirst NOT called`: the global prisma mock
// returns undefined (not a P2023 throw), so a non-UUID already yields 404 via the
// handler's own `!po` branch — a status check alone would pass even unguarded.
const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

const BAD_ID = 'po_new_1753200000000';
const GOOD_ID = 'aaaaaaa5-0000-4000-8000-000000000001';

describe('PO :id routes — non-UUID param guard (D4)', () => {
  it('GET /purchase-orders/:id 404s on a malformed id without touching Prisma', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get(`/api/inventory/purchase-orders/${BAD_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH /purchase-orders/:id 404s on a malformed id without touching Prisma', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/inventory/purchase-orders/${BAD_ID}`)
      .set(authHeader('admin'))
      .send({ status: 'closed' }); // valid body — proves the guard, not validation, blocks
    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
  });

  it('still reaches the controller (Prisma) for a real UUID', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/inventory/purchase-orders/${GOOD_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404); // not found, but the guard let it through
    expect(mockPrisma.purchaseOrder.findFirst).toHaveBeenCalled();
  });
});
