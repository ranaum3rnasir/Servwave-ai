import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// P2 item 7 (A-17, QA-610): vendor route normalization — canonical
// DELETE /vendors/:id with a has-POs guard; the legacy verb-style
// POST /vendors/delete answers 410 GONE (catalog-retirement precedent);
// "archive" stays the existing status:'inactive' upsert.

const mockPrisma = prisma as unknown as {
  vendor: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  vendorContact: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  purchaseOrder: { count: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';

const VENDOR_ROW = {
  id: VENDOR_ID,
  name: 'Acme Supply',
  category: 'Locks',
  payment_terms: 'Net 30',
  lead_time_days: 3,
  transmit_method: 'email',
  status: 'inactive',
  contacts: [],
  organization_id: ALPHA_ORG_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('DELETE /api/inventory/vendors/:id (P2 item 7)', () => {
  it('deletes an org-scoped vendor with no purchase orders', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.count.mockResolvedValue(0);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/inventory/vendors/${VENDOR_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Guard keyed on the FK, org-scoped.
    const countWhere = mockPrisma.purchaseOrder.count.mock.calls[0][0].where;
    expect(countWhere.vendor_id).toBe(VENDOR_ID);
    expect(countWhere.organization_id).toBe(ALPHA_ORG_ID);
    // Atomic org-scoped delete.
    const delWhere = mockPrisma.vendor.deleteMany.mock.calls[0][0].where;
    expect(delWhere.id).toBe(VENDOR_ID);
    expect(delWhere.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('409 VENDOR_HAS_POS when purchase orders reference the vendor — no delete', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.count.mockResolvedValue(3);

    const res = await request(app)
      .delete(`/api/inventory/vendors/${VENDOR_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VENDOR_HAS_POS');
    expect(res.body.po_count).toBe(3);
    expect(res.body.message).toMatch(/archive/i);
    expect(mockPrisma.vendor.deleteMany).not.toHaveBeenCalled();
  });

  it('404 for a cross-org/unknown vendor', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.count.mockResolvedValue(0);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/inventory/vendors/${VENDOR_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/inventory/vendors/delete — retired (410 GONE)', () => {
  it('answers 410 with a pointer to the canonical route', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/inventory/vendors/delete')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('GONE');
    expect(res.body.message).toContain('DELETE /api/inventory/vendors/:id');
    expect(mockPrisma.vendor.deleteMany).not.toHaveBeenCalled();
  });
});

describe('vendor archive = status inactive via the existing upsert (P2 item 7c)', () => {
  it('persists status inactive on POST /vendors with an id', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendor.update.mockResolvedValue(VENDOR_ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, status: 'inactive' });

    expect(res.status).toBe(200);
    expect(mockPrisma.vendor.update.mock.calls[0][0].data.status).toBe('inactive');
    expect(res.body.vendor.status).toBe('inactive');
  });
});
