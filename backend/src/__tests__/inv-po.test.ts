import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, JOB_FIXTURE, CUSTOMER_FIXTURE, PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE, matchesScopeWhere } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  purchaseOrderLine: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  jobStageLine: { findMany: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  organization: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { create: ReturnType<typeof vi.fn> };
  invoiceLineItem: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // P0 §A: createPurchaseOrder allocates its number inside a transaction.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('GET /api/inventory/purchase-orders (harness smoke)', () => {
  it('returns 200 with an empty list', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders).toEqual([]);
  });

  it('PO line mapper emits priceBookItemId', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.lines[0].priceBookItemId).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
    // D2: the line id is serialized so the receive contract can key on it.
    expect(res.body.purchaseOrder.lines[0].id).toBe(PURCHASE_ORDER_FIXTURE.lines[0].id);
  });
});

describe('POST /api/inventory/purchase-orders/receive — line-id identity (D2)', () => {
  // CAT = catalogued line (price_book_item_id set); FREE_* = from-job free-text lines (blank SKU, no FK).
  const CAT_LINE = { id: 'aaaaaaa5-0000-0000-0000-0000000000c1', item_sku: 'LOCK-100', item_name: 'Deadbolt', uom: 'EA', qty_ordered: 4, qty_received: 0, unit_cost: 20, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, created_at: new Date('2026-02-01') };
  const FREE_A   = { id: 'aaaaaaa5-0000-0000-0000-0000000000f1', item_sku: '', item_name: 'Custom bracket', uom: 'EA', qty_ordered: 3, qty_received: 0, unit_cost: 7, price_book_item_id: null, created_at: new Date('2026-02-01') };
  const FREE_B   = { id: 'aaaaaaa5-0000-0000-0000-0000000000f2', item_sku: '', item_name: 'Custom shim', uom: 'EA', qty_ordered: 2, qty_received: 0, unit_cost: 3, price_book_item_id: null, created_at: new Date('2026-02-01') };

  function mockPo(lines: any[]) {
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id, staged_as_job_stage_id: null, lines };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(lines.map((l) => ({ ...l })));
    return po;
  }

  it('receives a blank-SKU free-text line by its id — costed + ledgered, but writes NO StockBalance', async () => {
    mockAuthAs('admin');
    const po = mockPo([FREE_A]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: FREE_A.id, qtyReceived: 3 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrderLine.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FREE_A.id }, data: { qty_received: 3 } }),
    );
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();     // ledger row for audit + cost roll-up
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();  // no phantom catalog stock
  });

  it('receives two blank-SKU lines independently — no collision onto the first line', async () => {
    mockAuthAs('admin');
    const po = mockPo([FREE_A, FREE_B]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: FREE_A.id, qtyReceived: 3 }, { lineId: FREE_B.id, qtyReceived: 2 }] });

    expect(res.status).toBe(200);
    const updatedIds = mockPrisma.purchaseOrderLine.update.mock.calls.map((c) => c[0].where.id);
    expect(new Set(updatedIds)).toEqual(new Set([FREE_A.id, FREE_B.id]));
  });

  it('resolves stock identity from price_book_item_id (not a SKU re-lookup) for a catalogued line', async () => {
    mockAuthAs('admin');
    const po = mockPo([CAT_LINE]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: CAT_LINE.id, qtyReceived: 4 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].where.item_id_location_id.item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });
});

describe('POST /api/inventory/purchase-orders/receive — no inventory location (S4.3)', () => {
  // Found by the S2.2 verifier: with no destinationLocationId in the body, no org
  // default and no warehouse location, resolveReceiveLocationId() came back null
  // and the movement write blew up into a 500. The API now says what is missing.
  const LINE = { id: 'aaaaaaa5-0000-0000-0000-0000000000d1', item_sku: 'LOCK-100', item_name: 'Deadbolt', uom: 'EA', qty_ordered: 4, qty_received: 0, unit_cost: 20, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, created_at: new Date('2026-02-01') };

  it('answers 409 NO_STOCK_LOCATION (not 500) and writes nothing when no destination can be resolved', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id, staged_as_job_stage_id: null, lines: [LINE] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: null });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 2 }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NO_STOCK_LOCATION');
    expect(res.body.message).toMatch(/Settings → Locations/);
    expect(mockPrisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('still receives when the org has no default but a warehouse location exists (fallback path intact)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id, staged_as_job_stage_id: null, lines: [LINE] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: null });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ ...LINE, qty_received: 2 }]);

    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 2 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
  });
});

describe('POST /api/inventory/purchase-orders — FK population (V4/P1)', () => {
  // JOB_FIXTURE.id ('j...') is not a hex-valid UUID, which the uuid()-validated
  // jobId field correctly rejects; use a valid UUID for the job in these tests.
  const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
  const basePayload = {
    poNumber: 'PO-2001', vendor: 'Acme', status: 'draft',
    lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
  };

  it('writes job_id + customer_id when both exist in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: VALID_JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, job_id: VALID_JOB_ID, customer_id: CUSTOMER_FIXTURE.id });
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, jobId: VALID_JOB_ID, customerId: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(VALID_JOB_ID);
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('rejects a job_id from another org (P1 cross-org FK injection)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null); // not in requesting org
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, jobId: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job/i);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/purchase-orders — SKU→price_book_item_id resolution (V6/D5)', () => {
  it('resolves price_book_item_id from item_sku on PO create', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      poNumber: 'PO-3001', vendor: 'Acme',
      lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2 }],
    });
    const createdLines = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create;
    expect(createdLines[0].price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });
});

describe('POST /api/inventory/purchase-orders — unitCost capture (DEC2 cost source)', () => {
  it('persists unit_cost on PO line create (DEC2 cost source)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      poNumber: 'PO-4001', vendor: 'Acme',
      lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2, unitCost: 22.5 }],
    });
    const createdLines = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create;
    expect(createdLines[0].unit_cost).toBe(22.5);
  });

  it('exposes unitCost on the PO read contract', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], unit_cost: 22.5 }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.body.purchaseOrder.lines[0].unitCost).toBe(22.5);
  });
});

describe('POST /api/inventory/purchase-orders — Create PO dialog payload: real ids + unit cost per line (S3.1)', () => {
  // The exact shape NewPODialog now emits: vendorId (+ the legacy display name), jobId +
  // customerId from the linked job, and a unitCost on every line — a number when the
  // catalog (or the operator) supplied one, an explicit null when the money input was blank.
  const VENDOR_ID = 'e2000000-0000-0000-0000-000000000002';
  const JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000002';

  it('persists vendor_id + job_id + customer_id and each line\'s unit_cost (null when blank)', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'ADI / Anixter' });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      vendor: 'ADI / Anixter',
      vendorId: VENDOR_ID,
      status: 'draft',
      jobId: JOB_ID,
      customerId: CUSTOMER_FIXTURE.id,
      lines: [
        { itemSku: 'HES-1006', itemName: 'HES 1006 Electric Strike', uom: 'EA', qtyOrdered: 2, qtyReceived: 0, unitCost: 120 },
        { itemSku: 'MISC-1', itemName: 'Misc anchors', uom: 'EA', qtyOrdered: 1, qtyReceived: 0, unitCost: null },
      ],
    });

    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor_id).toBe(VENDOR_ID);
    expect(data.vendor).toBe('ADI / Anixter');
    expect(data.job_id).toBe(JOB_ID);
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(data.lines.create[0].unit_cost).toBe(120);
    expect(data.lines.create[1].unit_cost).toBeNull();
  });

  it('rejects a negative unit cost (400, no write)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      vendor: 'ADI / Anixter',
      lines: [{ itemSku: 'HES-1006', itemName: 'Strike', uom: 'EA', qtyOrdered: 1, unitCost: -1 }],
    });
    expect(res.status).toBe(400);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });
});

describe('POST/PATCH /api/inventory/purchase-orders — vendor_id FK (P2 item 1b)', () => {
  const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';
  const basePayload = {
    vendor: 'Acme', status: 'draft',
    lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
  };

  it('persists vendor_id on create when the vendor exists in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, vendorId: VENDOR_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor_id).toBe(VENDOR_ID);
    expect(data.vendor).toBe('Acme'); // both present → both persisted as given
  });

  it('rejects a cross-org vendorId on create (400, no write)', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, vendorId: VENDOR_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vendor/i);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('resolves the vendor display string from the vendor row when only vendorId is sent', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendorId: VENDOR_ID, lines: basePayload.lines });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor).toBe('Acme Supply');
    expect(data.vendor_id).toBe(VENDOR_ID);
  });

  it('maps vendorId on update and refreshes the display string from the vendor row', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.purchaseOrder.update.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).patch(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`)
      .set(authHeader('admin')).send({ vendorId: VENDOR_ID });
    expect(res.status).toBe(200);
    const data = mockPrisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data.vendor_id).toBe(VENDOR_ID);
    expect(data.vendor).toBe('Acme Supply');
  });

  it('emits vendorId on the read contract when the FK is set', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, vendor_id: VENDOR_ID });
    const res = await request(app).get(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.vendorId).toBe(VENDOR_ID);
  });

  // S3.3: the Edit form pre-selects the linked job by id, so the read contract carries
  // the FKs next to their display snapshots (and omits them when unlinked).
  it('emits jobId + customerId on the read contract when linked, omits them when not', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id, customer_id: CUSTOMER_FIXTURE.id, job: { job_number: 'J-0042' },
    });
    const linked = await request(app).get(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`).set(authHeader('admin'));
    expect(linked.status).toBe(200);
    expect(linked.body.purchaseOrder).toMatchObject({ jobId: JOB_FIXTURE.id, customerId: CUSTOMER_FIXTURE.id, jobNumber: 'J-0042' });

    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(PURCHASE_ORDER_FIXTURE);
    const unlinked = await request(app).get(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`).set(authHeader('admin'));
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.purchaseOrder).not.toHaveProperty('jobId');
    expect(unlinked.body.purchaseOrder).not.toHaveProperty('customerId');
  });
});

describe('POST /api/inventory/purchase-orders/receive (B2/V5)', () => {
  it('updates qty_received, emits StockMovement, updates StockBalance — and creates NO billing (DEC2)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id }; // linked job, but still no billing
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po); // initial load + re-read
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).toHaveBeenCalled();
    // DEC2: receipt is internal-cost only — no billing (no invoice / invoice line) by receipt.
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('uses the org default receive-location, not first-warehouse, when set (DEC3)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: 'bbbbbbb1-0000-0000-0000-000000000099' });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    // inventoryLocation.findFirst (the first-warehouse fallback) is NOT consulted when a default exists.
    expect(mockPrisma.inventoryLocation.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe('bbbbbbb1-0000-0000-0000-000000000099');
  });

  it('404s when the PO is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: '99999999-9999-9999-9999-999999999999', lines: [{ lineId: 'aaaaaaa5-0000-0000-0000-0000000000ff', qtyReceived: 1 }] });
    expect(res.status).toBe(404);
  });

  it('threads job_id + unit_cost + actor_user_id into the receive movement', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id }; // fixture line unit_cost = 20
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_FIXTURE.id);
    expect(data.unit_cost).toBe(20);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('a downward correction emits a signed negative adjust that SUBTRACTS from the balance', async () => {
    mockAuthAs('admin');
    // Stored qty_received 5, dialog submits absolute total 3 → delta -2.
    // Catalogued line (FK set) so the signed adjust moves a StockBalance (D2).
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], qty_received: 5, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 3 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 3 }] });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.type).toBe('adjust');
    expect(data.qty).toBe(-2);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].update.on_hand).toEqual({ increment: -2 });
  });
});

describe('POST /api/inventory/purchase-orders/receive — over-receive guard (P2 4a, QA-606)', () => {
  it('400 OVER_RECEIVE when the absolute total exceeds qty_ordered — zero partial application', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null }; // line qty_ordered = 5
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 7 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OVER_RECEIVE');
    expect(res.body.item_sku).toBe('LOCK-100');
    expect(res.body.qty_ordered).toBe(5);
    expect(res.body.qty_received).toBe(7);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).not.toHaveBeenCalled();
  });

  it('absolute-total semantics: 7 of 5 rejects even after a prior partial receive of 3', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], qty_received: 3 }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 7 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OVER_RECEIVE');
  });

  it('receiving exactly qty_ordered stays allowed', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/inventory/purchase-orders/receive — destination picker (P2 4b, D14)', () => {
  const DEST = 'bbbbbbb1-0000-0000-0000-000000000077';

  it('honors an org-validated destinationLocationId for every movement in the call', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: DEST });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, destinationLocationId: DEST, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe(DEST);
    // The DEC3 org-default resolver is NOT consulted when a destination is picked.
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('404s on a cross-org destinationLocationId', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, destinationLocationId: DEST, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(404);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/purchase-orders/receive — staged-PO guard (P2 4d, D14/QA-611)', () => {
  const STAGE_ID = 'aaaaaaa6-0000-0000-0000-000000000009';

  it('409 STAGED_PO when receiving a line that is staged (single receive path)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, staged_as_job_stage_id: STAGE_ID };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([{ item_sku: 'LOCK-100' }]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 2 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STAGED_PO');
    expect(res.body.staged_skus).toEqual(['LOCK-100']);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('a request touching only unlinked SKUs on a partially-staged PO proceeds', async () => {
    mockAuthAs('admin');
    const wireLine = { id: 'aaaaaaa5-0000-0000-0000-000000000002', item_sku: 'WIRE-12', item_name: 'Wire', uom: 'FT', qty_ordered: 10, qty_received: 0, unit_cost: 1, price_book_item_id: null, created_at: new Date('2026-02-01') };
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, staged_as_job_stage_id: STAGE_ID, lines: [PURCHASE_ORDER_FIXTURE.lines[0], wireLine] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([{ item_sku: 'LOCK-100' }]); // only LOCK-100 staged
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: wireLine.id, qtyReceived: 4 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
  });
});

describe('GET /api/inventory/jobs/:jobId/material-cost (V1/DEC2)', () => {
  it('sums qty_received × unit_cost across the job PO + stage lines', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // 5 received × $20 unit_cost (PO) + 3 received × $20 unit_cost (stage) = $160
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([
      { qty_received: 3, unit_cost: 20, price_book_item: null },
    ]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.materialCost).toBe(160);
    expect(res.body.lineCount).toBe(2);
  });

  it('falls back to PriceBookItem.unit_cost when the line has no unit_cost', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // line unit_cost null → fall back to catalog unit_cost 20; 4 × 20 = 80
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 4, unit_cost: null, price_book_item: { unit_cost: 20 } },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.body.materialCost).toBe(80);
  });

  it('404s when the job is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/inventory/jobs/99999999-9999-9999-9999-999999999999/material-cost').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  // ─── P2 item 5 (§3.6): staged-PO dedup — PO side wins per line ─────────────
  it('excludes PO-linked stage lines from the stage query (counted once via the PO side)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // The PO line is the authoritative row; the linked stage mirror is excluded by
    // the where filter, so the DB never returns it. 5 × $20 = $100 exactly once.
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.materialCost).toBe(100);
    expect(res.body.lineCount).toBe(1);
    // The one-token fix: stage lines only count when they have NO PO linkage.
    const stageWhere = mockPrisma.jobStageLine.findMany.mock.calls[0][0].where;
    expect(stageWhere.purchase_order_id).toBeNull();
  });

  it('manual (unlinked) stage lines still count; unstaged PO lines of a partially-staged PO count', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // 5×$20 (PO, staged or not) + 3×$10 (manual stage line) = $130.
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([
      { qty_received: 3, unit_cost: 10, price_book_item: null },
    ]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.body.materialCost).toBe(130);
    expect(res.body.lineCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #2042 SLICE 1 — enforcement of a conditioned `read PurchaseOrder` grant. DEFAULT_GRANTS
// carries no such row for SALES yet (that is slice 2), so these hand-inject the job-scoped
// condition on top of SALES's normal defaults — same technique as repro-2042.test.ts's (a)/(b).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('#2042 — GET /api/inventory/purchase-orders(+/:id) scoped to a conditioned read PurchaseOrder grant', () => {
  const OWN_JOB_PO_CONDITION = {
    job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  };
  const SALES_ID = TEST_USERS.sales.id;
  const OTHER_ID = TEST_USERS.admin.id;
  const PO_OWN_ID = 'aaaaaaa4-9000-0000-0000-000000000001';
  const PO_OTHER_ID = 'aaaaaaa4-9000-0000-0000-000000000002';
  const PO_NOJOB_ID = 'aaaaaaa4-9000-0000-0000-000000000003';

  function poRow(over: Record<string, unknown>) {
    return { ...PURCHASE_ORDER_FIXTURE, ...over };
  }
  const PO_OWN = poRow({
    id: PO_OWN_ID, job_id: 'ba000000-0000-0000-0000-000000000021',
    job: { job_number: 'J-OWN', estimate: { lead: { lead_assignees: [{ user_id: SALES_ID }] } } },
  });
  const PO_OTHER = poRow({
    id: PO_OTHER_ID, job_id: 'ba000000-0000-0000-0000-000000000022',
    job: { job_number: 'J-OTH', estimate: { lead: { lead_assignees: [{ user_id: OTHER_ID }] } } },
  });
  const PO_NOJOB = poRow({ id: PO_NOJOB_ID, job_id: null, job: null });
  const ALL_POS = [PO_OWN, PO_OTHER, PO_NOJOB];

  function mockSalesConditionedPoRead() {
    mockAuthAs('sales');
    const rows = [
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      { role: 'SALES', action: 'read', subject: 'PurchaseOrder', conditions: OWN_JOB_PO_CONDITION },
    ];
    mockPrisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(ALL_POS.filter((row) => matchesScopeWhere(where, row))),
    );
    mockPrisma.purchaseOrder.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const row = ALL_POS.find((p) => p.id === where.id);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
    });
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    clearPermissionCache();
  }

  it('SALES list holds only the rep\'s own-job PO', async () => {
    mockSalesConditionedPoRead();
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));
    expect(res.status).toBe(200);
    expect((res.body.purchaseOrders as Array<{ id: string }>).map((p) => p.id)).toEqual([PO_OWN_ID]);
  });

  it('SALES detail: own-job 200, other-job 404, no-job 404 — same body a random uuid returns', async () => {
    mockSalesConditionedPoRead();
    const own = await request(app).get(`/api/inventory/purchase-orders/${PO_OWN_ID}`).set(authHeader('sales'));
    expect(own.status).toBe(200);
    expect(own.body.purchaseOrder.id).toBe(PO_OWN_ID);

    const other = await request(app).get(`/api/inventory/purchase-orders/${PO_OTHER_ID}`).set(authHeader('sales'));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'Purchase order not found' });

    const noJob = await request(app).get(`/api/inventory/purchase-orders/${PO_NOJOB_ID}`).set(authHeader('sales'));
    expect(noJob.status).toBe(404);
    expect(noJob.body).toEqual({ error: 'Purchase order not found' });
  });

  it('SALES activity: own-job 200, other-job 404 — identical body to the detail route\'s miss', async () => {
    mockSalesConditionedPoRead();
    // auditLog/inventoryEmail aren't in this file's typed mockPrisma surface (see inv-po-activity.test.ts).
    const anyPrisma = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;
    anyPrisma.auditLog.findMany.mockResolvedValue([]);
    anyPrisma.inventoryEmail.findMany.mockResolvedValue([]);

    const own = await request(app).get(`/api/inventory/purchase-orders/${PO_OWN_ID}/activity`).set(authHeader('sales'));
    expect(own.status).toBe(200);
    const callsAfterOwn = anyPrisma.auditLog.findMany.mock.calls.length;

    const other = await request(app).get(`/api/inventory/purchase-orders/${PO_OTHER_ID}/activity`).set(authHeader('sales'));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'Purchase order not found' });
    // The out-of-scope miss returns before ever reading the audit trail.
    expect(anyPrisma.auditLog.findMany.mock.calls.length).toBe(callsAfterOwn);
  });

  it('DISPATCHER is unchanged: list holds all three POs, PO-C (no job) 200s', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue(ALL_POS);
    const list = await request(app).get('/api/inventory/purchase-orders').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect((list.body.purchaseOrders as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(
      [PO_OWN_ID, PO_OTHER_ID, PO_NOJOB_ID].sort(),
    );

    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PO_NOJOB);
    const detail = await request(app).get(`/api/inventory/purchase-orders/${PO_NOJOB_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
  });
});

describe('#2042 (R3) — GET /api/inventory/jobs/:jobId/material-cost scoped to read Job, not read PurchaseOrder', () => {
  // The ROUTE gates on `read PurchaseOrder` (R3: it rides the same gate as the PO routes), which
  // SALES holds no row for at all today (case (d) — that is slice 2), so a grant still has to be
  // hand-injected to even reach the controller. Once inside, the CONTROLLER scopes by `read Job`
  // instead (R3) — SALES already holds THAT one job-scoped TODAY (OWN_JOB_VIA_ESTIMATE, PR #1968),
  // with no injection needed for the Job side of the check.
  const JOB_OWN_ID = 'ba000000-0000-0000-0000-000000000031';
  const JOB_OTHER_ID = 'ba000000-0000-0000-0000-000000000032';
  const JOB_OWN = { id: JOB_OWN_ID, organization_id: TEST_USERS.sales.organization_id, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } };
  const JOB_OTHER = { id: JOB_OTHER_ID, organization_id: TEST_USERS.sales.organization_id, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] } } };

  function wireScopedJobFindFirst() {
    mockPrisma.job.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const row = [JOB_OWN, JOB_OTHER].find((j) => j.id === where.id);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
    });
  }

  function mockSalesWithUnconditionalPoReadForRouteGate() {
    mockAuthAs('sales');
    const rows = [
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      // Any `read PurchaseOrder` row clears the ROUTE gate; the Job-scoping this test pins is
      // enforced by the CONTROLLER's own `read Job` fragment (R3), not by this row's condition.
      { role: 'SALES', action: 'read', subject: 'PurchaseOrder', conditions: null },
    ];
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    clearPermissionCache();
  }

  it('SALES: own job 200, another rep\'s job 404 {"error":"Job not found"}', async () => {
    mockSalesWithUnconditionalPoReadForRouteGate();
    wireScopedJobFindFirst();
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);

    const own = await request(app).get(`/api/inventory/jobs/${JOB_OWN_ID}/material-cost`).set(authHeader('sales'));
    expect(own.status).toBe(200);

    const other = await request(app).get(`/api/inventory/jobs/${JOB_OTHER_ID}/material-cost`).set(authHeader('sales'));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'Job not found' });
  });

  it('DISPATCHER and ADMIN are unchanged: 200 on both jobs', async () => {
    for (const role of ['dispatcher', 'admin'] as const) {
      mockAuthAs(role);
      mockPrisma.job.findFirst.mockResolvedValueOnce({ id: JOB_OWN_ID }).mockResolvedValueOnce({ id: JOB_OTHER_ID });
      mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([]);
      mockPrisma.jobStageLine.findMany.mockResolvedValue([]);

      const a = await request(app).get(`/api/inventory/jobs/${JOB_OWN_ID}/material-cost`).set(authHeader(role));
      expect(a.status).toBe(200);
      const b = await request(app).get(`/api/inventory/jobs/${JOB_OTHER_ID}/material-cost`).set(authHeader(role));
      expect(b.status).toBe(200);
    }
  });
});

describe('POST /api/inventory/purchase-orders/:id/send — removed (Purchasing Audit Verdict PR 1, S1.1)', () => {
  it('answers 404 and never reaches Prisma: ServWave does not send POs', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ to: ['orders@acme.com'] });
    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});
