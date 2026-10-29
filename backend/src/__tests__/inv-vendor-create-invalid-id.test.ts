import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// The "Add Vendor" dialog stamps a brand-new vendor with a client-side
// placeholder id (`vnd_new_${Date.now()}`) before the first save. Any truthy
// `id` routes the upsert into the UPDATE branch, which runs
// `prisma.vendor.findFirst({ where: { id } })` — but `vendors.id` is a
// Postgres UUID column, so a non-UUID string throws inside the driver
// (Prisma P2023) instead of failing validation, and the controller's catch
// turns that into a 500. Every vendor a user "adds" through the dialog 500s.
const mockPrisma = prisma as unknown as {
  vendor: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  purchaseOrder: { count: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('POST /api/inventory/vendors — non-UUID id (dialog placeholder)', () => {
  it('400s on a client-synthesized placeholder id instead of 500ing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: `vnd_new_${1753200000000}`, name: 'Acme', category: 'Locks' });

    expect(res.status).toBe(400);
    // Rejected by validation, before the controller ever reaches Prisma.
    expect(mockPrisma.vendor.findFirst).not.toHaveBeenCalled();
  });

  it('still creates normally with no id at all', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'e2000000-0000-0000-0000-000000000099',
      name: 'Acme',
      category: 'Locks',
      payment_terms: '',
      lead_time_days: 0,
      transmit_method: 'email',
      contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'Acme', category: 'Locks' });

    expect(res.status).toBe(201);
  });

  it('still updates normally with a real UUID id', async () => {
    mockAuthAs('admin');
    const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, organization_id: '00000000-0000-0000-0000-000000000001' });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, name: 'Acme Updated' });

    expect(res.status).not.toBe(400);
    expect(mockPrisma.vendor.findFirst).toHaveBeenCalled();
  });
});

// The optimistically-inserted row (handleAdd pushes it into VendorsPage state
// before the create response returns) carries the same placeholder id. If a
// user deletes it during that window, the id reaches
// `prisma.purchaseOrder.count({ where: { vendor_id: id } })` — vendor_id is a
// UUID column too, so the same non-UUID crash class applies here.
describe('DELETE /api/inventory/vendors/:id — non-UUID id (optimistic-row race)', () => {
  it('404s on a malformed id instead of 500ing, without touching Prisma', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .delete(`/api/inventory/vendors/vnd_new_${1753200000000}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.count).not.toHaveBeenCalled();
  });

  it('still deletes normally with a real UUID id', async () => {
    mockAuthAs('admin');
    const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';
    mockPrisma.purchaseOrder.count.mockResolvedValue(0);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/inventory/vendors/${VENDOR_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrder.count).toHaveBeenCalled();
  });
});
