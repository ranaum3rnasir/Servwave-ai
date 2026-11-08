import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { allocateNumber } from '../lib/numbering';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// D16 entry point 2: POST /purchase-orders/from-job — server-resolved PO lines from
// job line items / catalog rows; delegates to the shared persist core (server number).

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  jobLineItem: { findMany: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000021';
const JOB_LINE_ID = 'd1000000-0000-0000-0000-000000000001';
const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';

const JOB_ROW = {
  id: VALID_JOB_ID,
  job_number: 'J00001',
  status: 'SCHEDULED',
  customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
  service_location: { address_line1: '123 Main St', city: 'Austin', state: 'TX' },
};

const CATALOG_ROW = {
  id: PRICE_BOOK_ITEM_FIXTURE.id,
  sku: 'LOCK-100',
  name: 'Deadbolt Lock',
  uom: 'EA',
  unit_cost: 20,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.priceBookItem.findMany.mockResolvedValue([]); // skuMap resolution in the persist core
});

describe('POST /api/inventory/purchase-orders/from-job (D16 entry 2)', () => {
  it('201 happy path — job line with catalog ref resolves sku/uom/cost server-side', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.jobLineItem.findMany.mockResolvedValue([
      { id: JOB_LINE_ID, description: 'Deadbolt install', unit_cost: 25, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id },
    ]);
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(CATALOG_ROW);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 4 }] });

    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(VALID_JOB_ID);
    expect(data.status).toBe('draft');
    const line = data.lines.create[0];
    expect(line.item_sku).toBe('LOCK-100');
    expect(line.item_name).toBe('Deadbolt Lock');
    expect(line.uom).toBe('EA');
    expect(line.unit_cost).toBe(20);
    expect(line.qty_ordered).toBe(4);
    expect(line.qty_received).toBe(0);
    expect(line.price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });

  it('free-text job line (no catalog ref) maps to item_sku "" + description as name', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.jobLineItem.findMany.mockResolvedValue([
      { id: JOB_LINE_ID, description: 'Custom bracket', unit_cost: 12.5, price_book_item_id: null },
    ]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 2 }] });

    expect(res.status).toBe(201);
    const line = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create[0];
    expect(line.item_sku).toBe('');
    expect(line.item_name).toBe('Custom bracket');
    expect(line.uom).toBe('EA');
    expect(line.unit_cost).toBe(12.5);
    expect(line.price_book_item_id).toBeNull();
  });

  it('priceBookItemId direct mode ("order more of X") resolves the active catalog row', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(CATALOG_ROW);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ priceBookItemId: PRICE_BOOK_ITEM_FIXTURE.id, qty: 6 }] });

    expect(res.status).toBe(201);
    // Direct mode requires an active catalog item (D8 spirit).
    const where = mockPrisma.priceBookItem.findFirst.mock.calls[0][0].where;
    expect(where.is_active).toBe(true);
    const line = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create[0];
    expect(line.item_sku).toBe('LOCK-100');
    expect(line.qty_ordered).toBe(6);
    expect(line.price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });

  it('400 on inactive/cross-org priceBookItemId in direct mode', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ priceBookItemId: PRICE_BOOK_ITEM_FIXTURE.id, qty: 1 }] });

    expect(res.status).toBe(400);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('400 on a cross-org job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: '99999999-9999-9999-9999-999999999999', lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job/i);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('409 JOB_CANCELLED on a cancelled job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_ROW, status: 'CANCELLED' });

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('JOB_CANCELLED');
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('400 on a jobLineItemId that does not belong to the job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.jobLineItem.findMany.mockResolvedValue([]); // no line matches within this job

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    expect(res.status).toBe(400);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('snapshots customer + site from the job and persists customer_id', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.jobLineItem.findMany.mockResolvedValue([
      { id: JOB_LINE_ID, description: 'Part', unit_cost: null, price_book_item_id: null },
    ]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.customer).toBe('John Doe');
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(data.site).toBe('123 Main St, Austin, TX');
  });

  it('resolves vendor display from an org-validated vendorId and persists vendor_id', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.jobLineItem.findMany.mockResolvedValue([
      { id: JOB_LINE_ID, description: 'Part', unit_cost: null, price_book_item_id: null },
    ]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, vendorId: VENDOR_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor).toBe('Acme Supply');
    expect(data.vendor_id).toBe(VENDOR_ID);
  });

  it('400 on a cross-org vendorId', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, vendorId: VENDOR_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vendor/i);
  });

  it('400 (Zod) when a line has neither jobLineItemId nor priceBookItemId', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ qty: 1 }] });
    expect(res.status).toBe(400);
  });

  it('delegates through the SAME persist core — server number allocated once', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
    mockPrisma.jobLineItem.findMany.mockResolvedValue([
      { id: JOB_LINE_ID, description: 'Part', unit_cost: null, price_book_item_id: null },
    ]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post('/api/inventory/purchase-orders/from-job').set(authHeader('admin'))
      .send({ jobId: VALID_JOB_ID, lines: [{ jobLineItemId: JOB_LINE_ID, qty: 1 }] });

    expect(res.status).toBe(201);
    expect(vi.mocked(allocateNumber)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(allocateNumber)).toHaveBeenCalledWith(expect.anything(), 'purchase_order', expect.any(String));
    // The globally-mocked allocator returns P00001 for 'purchase_order'.
    expect(mockPrisma.purchaseOrder.create.mock.calls[0][0].data.po_number).toBe('P00001');
  });
});
