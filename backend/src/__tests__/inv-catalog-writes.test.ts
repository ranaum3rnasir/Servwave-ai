import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  brand: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  itemGroup: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  itemGroupLine: { deleteMany: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  priceBookCategory: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  priceBookItem: {
    findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn>;
  };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

// ─── P0 §D4: catalog writes moved to /api/price-book/* — old routes are 410 Gone ──

describe('inv-catalog write routes → 410 Gone (P0 §D4)', () => {
  const cases: Array<[string, () => request.Test]> = [
    ['POST /api/inventory/items', () => request(app).post('/api/inventory/items').send({ name: 'X', sellPrice: 1 })],
    ['POST /api/inventory/items/import', () => request(app).post('/api/inventory/items/import').send({ items: [{ name: 'X', sellPrice: 1 }] })],
    ['POST /api/inventory/items/delete', () => request(app).post('/api/inventory/items/delete').send({ id: PRICE_BOOK_ITEM_FIXTURE.id })],
    ['DELETE /api/inventory/items/:id', () => request(app).delete(`/api/inventory/items/${PRICE_BOOK_ITEM_FIXTURE.id}`)],
    ['POST /api/inventory/categories', () => request(app).post('/api/inventory/categories').send({ name: 'Cat' })],
    ['POST /api/inventory/brands', () => request(app).post('/api/inventory/brands').send({ name: 'Schlage' })],
    ['POST /api/inventory/item-groups', () => request(app).post('/api/inventory/item-groups').send({ name: 'Kit', groupType: 'kit' })],
  ];

  it.each(cases)('%s → 410 {error: GONE} without touching prisma', async (_name, makeReq) => {
    mockAuthAs('admin');
    const res = await makeReq().set(authHeader('admin'));
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('GONE');
    expect(res.body.message).toMatch(/price-book/);
    expect(mockPrisma.priceBookItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookCategory.create).not.toHaveBeenCalled();
    expect(mockPrisma.brand.create).not.toHaveBeenCalled();
    expect(mockPrisma.itemGroup.create).not.toHaveBeenCalled();
  });
});

// ─── P0 §D5: GET /api/inventory/items gains {data, meta} ─────────────────────

describe('GET /api/inventory/items — {data, meta} envelope (P0 §D5)', () => {
  it('returns paginated data + meta', async () => {
    mockAuthAs('admin');
    const row = {
      ...PRICE_BOOK_ITEM_FIXTURE,
      category: null, vendor: null, stock_balances: [],
      updated_at: new Date('2026-02-01'),
    };
    mockPrisma.priceBookItem.findMany.mockResolvedValue([row]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].sku).toBe('LOCK-100');
    expect(res.body.meta).toEqual(expect.objectContaining({ total: 1, page: 1 }));
    expect(res.body.items).toBeUndefined();
  });

  it('passes page/limit through to the query', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    const res = await request(app).get('/api/inventory/items?page=2&limit=50').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const args = mockPrisma.priceBookItem.findMany.mock.calls[0][0];
    expect(args.skip).toBe(50);
    expect(args.take).toBe(50);
    expect(res.body.meta.page).toBe(2);
  });
});

describe('GET /api/inventory/items - archived filter', () => {
  it('hides archived (is_active:false) items by default', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    await request(app).get('/api/inventory/items').set(authHeader('admin'));

    const where = mockPrisma.priceBookItem.findMany.mock.calls[0][0].where;
    expect(where.is_active).toBe(true);
  });

  it('includes archived when include_archived=true', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    await request(app).get('/api/inventory/items?include_archived=true').set(authHeader('admin'));

    const where = mockPrisma.priceBookItem.findMany.mock.calls[0][0].where;
    expect(where.is_active).toBeUndefined();
  });

  it('exposes isActive on each mapped row so the client can tell archived rows apart', async () => {
    mockAuthAs('admin');
    const activeRow = { ...PRICE_BOOK_ITEM_FIXTURE, is_active: true, category: null, vendor: null, stock_balances: [] };
    const archivedRow = { ...PRICE_BOOK_ITEM_FIXTURE, id: 'aaaaaaa2-0000-0000-0000-000000000009', is_active: false, category: null, vendor: null, stock_balances: [] };
    mockPrisma.priceBookItem.findMany.mockResolvedValue([activeRow, archivedRow]);
    mockPrisma.priceBookItem.count.mockResolvedValue(2);

    const res = await request(app).get('/api/inventory/items?include_archived=true').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].isActive).toBe(true);
    expect(res.body.data[1].isActive).toBe(false);
  });
});

// ─── P0 §D7: camelCase cost stripping on inv-catalog reads ────────────────────

describe('GET /api/inventory/items — cost stripping (P0 §D7)', () => {
  const row = {
    ...PRICE_BOOK_ITEM_FIXTURE,
    list_price: 60,
    category: null, vendor: null, stock_balances: [],
    updated_at: new Date('2026-02-01'),
  };

  it('strips unitCost + listPrice for a reader without read Invoice, keeps sellPrice', async () => {
    mockAuthAs('technician');
    // Grant the tech stock visibility (read Inventory) but NOT read Invoice.
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'Inventory' },
    ]);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([row]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unitCost).toBeUndefined();
    expect(res.body.data[0].listPrice).toBeUndefined();
    expect(res.body.data[0].sellPrice).toBe(40);
  });

  it('keeps unitCost + listPrice for ADMIN', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([row]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unitCost).toBe(20);
    expect(res.body.data[0].listPrice).toBe(60);
  });

  it('strips on the single-item read too', async () => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'Inventory' },
    ]);
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(row);

    const res = await request(app).get(`/api/inventory/items/${row.id}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.item.unitCost).toBeUndefined();
    expect(res.body.item.listPrice).toBeUndefined();
    expect(res.body.item.sellPrice).toBe(40);
  });
});

// ─── SRVW-90: the item DTO carries type + taxable so the edit dialog can prefill ─

describe('GET /api/inventory/items - type + taxable on the DTO (SRVW-90)', () => {
  const materialRow = {
    ...PRICE_BOOK_ITEM_FIXTURE,
    type: 'MATERIAL',
    taxable: false,
    kind: 'material',
    category: null, vendor: null, stock_balances: [],
  };

  it('exposes type and taxable on every listed row', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([materialRow]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].type).toBe('MATERIAL');
    expect(res.body.data[0].taxable).toBe(false);
  });

  it('exposes type and taxable on the single-item read', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(materialRow);

    const res = await request(app)
      .get(`/api/inventory/items/${materialRow.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.item.type).toBe('MATERIAL');
    expect(res.body.item.taxable).toBe(false);
  });

  it('taxable falls back to true when the column is absent from the row', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([
      { ...materialRow, taxable: null },
    ]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].taxable).toBe(true);
  });

  it('a null kind is reported from type, not hardcoded to material', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([
      { ...materialRow, id: 'aaaaaaa3-0000-0000-0000-000000000001', type: 'SERVICE', kind: null },
      { ...materialRow, id: 'aaaaaaa3-0000-0000-0000-000000000002', type: 'MATERIAL', kind: null },
    ]);
    mockPrisma.priceBookItem.count.mockResolvedValue(2);

    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].kind).toBe('service');
    expect(res.body.data[1].kind).toBe('material');
  });
});

// ─── Stock writes stay live on inv-catalog (unchanged behavior) ───────────────

describe('POST /api/inventory/restock (B2/V5)', () => {
  it('emits a receive StockMovement and increments StockBalance', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5 });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.type).toBe('receive');
  });
  it('rejects an item from another org', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: '99999999-9999-9999-9999-999999999999', locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5 });
    expect(res.status).toBe(404);
  });

  it('threads unitCost + actor_user_id into the movement', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5, unitCost: 12.5 });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.unit_cost).toBe(12.5);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('passes fractional qty through unrounded', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 2.5 });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.qty).toBe(2.5);
  });

  // ─── SRVW-92: the ledger reference should record the typed reference number ───

  it('persists the typed reference number on the ledger row', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5, source: 'vendor_po', reference: 'PO-2261' });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.reference).toBe('PO-2261');
  });

  it('falls back to the source token when no reference is typed', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/restock').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 5, source: 'vendor_po' });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.reference).toBe('vendor_po');
  });
});

describe('POST /api/inventory/bulk-restock (B2/V5)', () => {
  it('threads per-line unitCost when provided', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/bulk-restock').set(authHeader('admin'))
      .send({ lines: [{ itemId: PRICE_BOOK_ITEM_FIXTURE.id, locationId: INVENTORY_LOCATION_FIXTURE.id, qty: 3, unitCost: 9.75 }] });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.unit_cost).toBe(9.75);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });
});

describe('POST /api/inventory/transfer (B2/V5)', () => {
  it('emits a transfer movement (from→to)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromId: INVENTORY_LOCATION_FIXTURE.id, toId: INVENTORY_LOCATION_FIXTURE.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.type).toBe('transfer');
  });

  it('threads actor_user_id into the transfer movement', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromId: INVENTORY_LOCATION_FIXTURE.id, toId: INVENTORY_LOCATION_FIXTURE.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  // ─── P1 §6.3 — manual transfer under the org negative-stock policy (QA-203/204) ───

  it('warn mode (default) lets the source go negative and still records the movement (QA-203)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ block_negative_stock: false });
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: -1, min: null });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromId: INVENTORY_LOCATION_FIXTURE.id, toId: INVENTORY_LOCATION_FIXTURE.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
  });

  it('block mode refuses an over-draw transfer with 409 SHORTAGE and NO movement (QA-204)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ block_negative_stock: true });
    (prisma.stockBalance.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (prisma.stockBalance.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ on_hand: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/transfer').set(authHeader('admin'))
      .send({ itemId: PRICE_BOOK_ITEM_FIXTURE.id, fromId: INVENTORY_LOCATION_FIXTURE.id, toId: INVENTORY_LOCATION_FIXTURE.id, qty: 2 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'SHORTAGE', requested: 2, available: 1 });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });
});

// ─── Pure-catalog reads re-gated to PriceBook (P0 §D4) ────────────────────────

describe('inv-catalog pure-catalog reads gate on read PriceBook', () => {
  it.each([
    ['/api/inventory/categories'],
    ['/api/inventory/brands'],
    ['/api/inventory/item-groups'],
  ])('GET %s 403s for a reader with Inventory but not PriceBook', async (path) => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'Inventory' },
    ]);
    const res = await request(app).get(path).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('GET /api/inventory/brands 200s with a read PriceBook grant', async () => {
    mockAuthAs('technician');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' },
    ]);
    mockPrisma.brand.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/brands').set(authHeader('technician'));
    expect(res.status).toBe(200);
  });
});
