import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { allocateNumber } from '../lib/numbering';
import { mockAuthAs, authHeader, TEST_USERS, PURCHASE_ORDER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Server-assigned PO numbers (inventory P0 §A): createPurchaseOrder allocates
// via allocateNumber('purchase_order') inside the create transaction; poNumber
// is no longer accepted from the client on create OR update.

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const LINES = [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }];

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  vi.mocked(allocateNumber).mockResolvedValue('PO-02275');
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
});

describe('POST /api/inventory/purchase-orders — server-assigned number (P0 §A)', () => {
  it('creates without a client poNumber; the allocated number is written and returned', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, po_number: 'PO-02275' });

    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', lines: LINES });

    expect(res.status).toBe(201);
    expect(allocateNumber).toHaveBeenCalledWith(expect.anything(), 'purchase_order', TEST_USERS.admin.organization_id);
    expect(mockPrisma.purchaseOrder.create.mock.calls[0][0].data.po_number).toBe('PO-02275');
    expect(res.body.purchaseOrder.poNumber).toBe('PO-02275');
  });

  it('ignores a client-supplied poNumber (schema strip) — the allocated number wins', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, po_number: 'PO-02275' });

    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ poNumber: 'PO-CLIENT-999', vendor: 'Acme', lines: LINES });

    expect(res.status).toBe(201);
    expect(mockPrisma.purchaseOrder.create.mock.calls[0][0].data.po_number).toBe('PO-02275');
  });

  it('allocates inside the create transaction', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, po_number: 'PO-02275' });

    await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', lines: LINES });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // allocateNumber received the transaction client (first arg of the tx callback).
    expect(vi.mocked(allocateNumber).mock.calls[0][0]).toBe(mockPrisma);
  });
});

describe('PATCH /api/inventory/purchase-orders/:id — poNumber immutable (P0 §A)', () => {
  it('strips poNumber from the update payload; po_number never reaches the write', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.purchaseOrder.update.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app)
      .patch(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ poNumber: 'PO-HACKED', vendor: 'New Vendor' });

    expect(res.status).toBe(200);
    const data = mockPrisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('po_number');
    expect(data.vendor).toBe('New Vendor');
  });
});
