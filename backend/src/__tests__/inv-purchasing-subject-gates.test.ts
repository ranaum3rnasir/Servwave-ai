import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, PURCHASE_ORDER_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Subject split (inventory P0, plan D11): /purchase-orders, /rfqs and
// /jobs/:jobId/material-cost gate on `PurchaseOrder`; /vendors gates on `Vendor`. Stock routes
// keep the coarse `Inventory` subject, so SALES (read Inventory) loses purchasing without
// losing stock visibility. #2042 (Ran, 2026-09-10) re-opens purchasing to SALES read-only:
// `read PurchaseOrder` job-scoped, `read Vendor` unconditional (org-wide reference data) — SALES
// is no longer severed from purchasing reads, only from purchasing WRITES (still 403 below).

const mockPrisma = prisma as unknown as {
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  purchaseOrder: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  purchaseOrderLine: { findMany: ReturnType<typeof vi.fn> };
  jobStageLine: { findMany: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  stockMovement: { findMany: ReturnType<typeof vi.fn> };
  vendor: { findMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const PO_PAYLOAD = {
  poNumber: 'PO-9001', vendor: 'Acme', status: 'draft',
  lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // P0 §A: createPurchaseOrder allocates its number inside a transaction.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('SALES — purchasing read-only and job-scoped, stock retained (#2042)', () => {
  it('200s on GET /api/inventory/purchase-orders (job-scoped read, not severed)', async () => {
    mockAuthAs('sales');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('200s on GET /api/inventory/vendors (unconditional read — reference data)', async () => {
    mockAuthAs('sales');
    mockPrisma.vendor.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/vendors').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('still 200s on GET /api/inventory/movements (retained read Inventory)', async () => {
    mockAuthAs('sales');
    mockPrisma.stockMovement.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/movements').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });
});

describe('DISPATCHER — full CRUD on both new subjects', () => {
  it('200s on GET /api/inventory/purchase-orders', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('can POST /api/inventory/purchase-orders (non-403)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders')
      .set(authHeader('dispatcher')).send(PO_PAYLOAD);
    expect(res.status).toBe(201);
  });

  it('200s on GET /api/inventory/vendors', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.vendor.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/vendors').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('can POST /api/inventory/vendors/delete (non-403)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).post('/api/inventory/vendors/delete')
      .set(authHeader('dispatcher')).send({ id: 'v0000000-0000-0000-0000-000000000001' });
    expect(res.status).not.toBe(403);
  });

  it('can GET /api/inventory/jobs/:jobId/material-cost (non-403)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });
});

describe('grandfathered org — SALES with derivation-produced read rows', () => {
  // The derivation migration copies each org's SALES `read Inventory` row into
  // `read PurchaseOrder` + `read Vendor`. Reads keep working; writes were never held.
  it('derived read allows GET but create still 403s', async () => {
    mockAuthAs('sales');
    const grandfathered = [
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      { role: 'SALES', action: 'read', subject: 'PurchaseOrder' },
      { role: 'SALES', action: 'read', subject: 'Vendor' },
    ];
    mockPrisma.rolePermission.findMany.mockResolvedValue(grandfathered);
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);

    const read = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));
    expect(read.status).toBe(200);

    const create = await request(app).post('/api/inventory/purchase-orders')
      .set(authHeader('sales')).send(PO_PAYLOAD);
    expect(create.status).toBe(403);
  });
});

describe('P2 purchasing routes — role matrix', () => {
  const RES_ID = 'ee000000-0000-0000-0000-000000000001';
  const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

  it('SALES 403s on POST /purchase-orders/from-job (create PurchaseOrder)', async () => {
    mockAuthAs('sales');
    const res = await request(app).post('/api/inventory/purchase-orders/from-job')
      .set(authHeader('sales')).send({ jobId: VALID_JOB_ID, lines: [{ priceBookItemId: VALID_JOB_ID, qty: 1 }] });
    expect(res.status).toBe(403);
  });

  // #2042 / spec R3 (AC12): SALES now passes this gate — a STATED outcome of "reads the whole
  // inventory module", org-scoped by tenantWhere only (never claimed to be job-scoped).
  it('SALES 200s on GET /purchase-orders/low-stock-proposals (read PurchaseOrder, #2042)', async () => {
    mockAuthAs('sales');
    (prisma as any).stockBalance.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('TECHNICIAN 403s on GET /purchase-orders/low-stock-proposals', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('SALES and TECHNICIAN 403 on DELETE /vendors/:id (delete Vendor)', async () => {
    mockAuthAs('sales');
    const sales = await request(app).delete(`/api/inventory/vendors/${RES_ID}`).set(authHeader('sales'));
    expect(sales.status).toBe(403);

    mockAuthAs('technician');
    const tech = await request(app).delete(`/api/inventory/vendors/${RES_ID}`).set(authHeader('technician'));
    expect(tech.status).toBe(403);
  });

  it('DISPATCHER passes the vendor-delete gate (reaches the handler)', async () => {
    mockAuthAs('dispatcher');
    (prisma as any).purchaseOrder.count.mockResolvedValue(0);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 0 });
    const del = await request(app).delete(`/api/inventory/vendors/${RES_ID}`).set(authHeader('dispatcher'));
    expect(del.status).toBe(404); // past the gate, into the handler
  });

  it('DISPATCHER passes the gates (200 proposals)', async () => {
    mockAuthAs('dispatcher');
    (prisma as any).stockBalance.findMany.mockResolvedValue([]);
    const proposals = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('dispatcher'));
    expect(proposals.status).toBe(200);
  });
});

describe('TECHNICIAN — no purchasing access', () => {
  it('403s on GET /api/inventory/purchase-orders', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('403s on GET /api/inventory/vendors', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/inventory/vendors').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});
