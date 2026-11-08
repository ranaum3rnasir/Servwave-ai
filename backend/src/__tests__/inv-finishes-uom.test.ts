import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Finish is a real entity mirroring Brand (own table, FK on the item).
// UomOption is deliberately NOT an FK - it supplies dropdown options only,
// while the item keeps storing the code string, because `uom` is already
// carried on PO lines, stock movements, job stage lines and reservation
// lines and converting it would mean a cross-table backfill.

const mockPrisma = prisma as unknown as {
  finish: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  uomOption: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  priceBookItem: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  priceBookCategory: { findFirst: ReturnType<typeof vi.fn> };
  brand: { findFirst: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

const FINISH_FIXTURE = {
  id: 'f1000000-0000-0000-0000-000000000001',
  name: 'Satin Chrome',
  code: '626',
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const UOM_FIXTURE = {
  id: 'f2000000-0000-0000-0000-000000000001',
  code: 'EA',
  label: 'Each',
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const ITEM_ROW = {
  id: 'db100000-0000-0000-0000-0000000000f1',
  name: 'Mortise Cylinder',
  type: 'MATERIAL',
  unit_cost: 10,
  unit_price: 20,
  taxable: true,
  is_active: true,
  sort_order: 0,
  finish_id: FINISH_FIXTURE.id,
  uom: 'EA',
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  stock_balances: [],
};

// ─── Finish reads ────────────────────────────────────────────────────────

describe('GET /api/inventory/finishes', () => {
  it('lists the org finishes in name order, tenant-scoped, camelCased', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findMany.mockResolvedValue([FINISH_FIXTURE]);

    const res = await request(app).get('/api/inventory/finishes').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.finishes).toEqual([
      { id: FINISH_FIXTURE.id, name: 'Satin Chrome', code: '626', isActive: true },
    ]);
    const args = mockPrisma.finish.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('is readable by a technician with the read PriceBook grant', async () => {
    mockAuthAs('technician');
    mockPrisma.finish.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/finishes').set(authHeader('technician'));

    expect(res.status).toBe(200);
  });
});

// ─── Finish writes ───────────────────────────────────────────────────────

describe('POST /api/price-book/finishes', () => {
  it('creates a finish scoped to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.create.mockResolvedValue(FINISH_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/finishes')
      .set(authHeader('admin'))
      .send({ name: 'Satin Chrome', code: '626' });

    expect(res.status).toBe(201);
    expect(res.body.finish.name).toBe('Satin Chrome');
    expect(mockPrisma.finish.create.mock.calls[0][0].data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('rejects a duplicate name in the same org with 409', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    const res = await request(app)
      .post('/api/price-book/finishes')
      .set(authHeader('admin'))
      .send({ name: 'Satin Chrome' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('404s when updating a finish belonging to another org', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/price-book/finishes')
      .set(authHeader('admin'))
      .send({ id: 'f1000000-0000-0000-0000-0000000000ff', name: 'Stolen' });

    expect(res.status).toBe(404);
    expect(mockPrisma.finish.updateMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('rejects an empty name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/finishes')
      .set(authHeader('admin'))
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.finish.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/price-book/finishes/:id', () => {
  it('refuses to delete a finish that still has items', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findFirst.mockResolvedValue({ ...FINISH_FIXTURE, _count: { items: 3 } });

    const res = await request(app)
      .delete(`/api/price-book/finishes/${FINISH_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockPrisma.finish.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an unused finish, scoped to the org', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findFirst.mockResolvedValue({ ...FINISH_FIXTURE, _count: { items: 0 } });
    mockPrisma.finish.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/price-book/finishes/${FINISH_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.finish.deleteMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('404s on a finish outside the org', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/price-book/finishes/f1000000-0000-0000-0000-0000000000ff')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.finish.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── finish_id on the item ───────────────────────────────────────────────

describe('finish_id on price-book items', () => {
  it('round-trips finish_id on create', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findFirst.mockResolvedValue(FINISH_FIXTURE);
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_ROW);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Mortise Cylinder', sell_price: 20, finish_id: FINISH_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.finish_id).toBe(FINISH_FIXTURE.id);
  });

  it('404s on a finish_id outside the org', async () => {
    mockAuthAs('admin');
    mockPrisma.finish.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'X', sell_price: 1, finish_id: 'f1000000-0000-0000-0000-0000000000ff' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Finish not found');
    expect(mockPrisma.priceBookItem.create).not.toHaveBeenCalled();
  });

  it('clears finish_id when PATCHed with null', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_ROW);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_ROW.id}`)
      .set(authHeader('admin'))
      .send({ finish_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data).toHaveProperty('finish_id', null);
  });

  it('exposes finishId on the inventory item list', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_ROW);

    const res = await request(app)
      .get(`/api/inventory/items/${ITEM_ROW.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.item.finishId).toBe(FINISH_FIXTURE.id);
  });
});

// ─── UoM options ─────────────────────────────────────────────────────────

describe('GET /api/inventory/uom-options', () => {
  it('lists the org UoM options in code order', async () => {
    mockAuthAs('admin');
    mockPrisma.uomOption.findMany.mockResolvedValue([UOM_FIXTURE]);

    const res = await request(app).get('/api/inventory/uom-options').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.uomOptions).toEqual([
      { id: UOM_FIXTURE.id, code: 'EA', label: 'Each', isActive: true },
    ]);
    expect(mockPrisma.uomOption.findMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });
});

describe('POST /api/price-book/uom-options', () => {
  it('creates an option, upper-casing and trimming the code', async () => {
    mockAuthAs('admin');
    mockPrisma.uomOption.create.mockResolvedValue({ ...UOM_FIXTURE, code: 'PAIL', label: null });

    const res = await request(app)
      .post('/api/price-book/uom-options')
      .set(authHeader('admin'))
      .send({ code: ' pail ' });

    expect(res.status).toBe(201);
    const data = mockPrisma.uomOption.create.mock.calls[0][0].data;
    expect(data.code).toBe('PAIL');
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('rejects a duplicate code in the same org with 409', async () => {
    mockAuthAs('admin');
    mockPrisma.uomOption.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    const res = await request(app)
      .post('/api/price-book/uom-options')
      .set(authHeader('admin'))
      .send({ code: 'EA' });

    expect(res.status).toBe(409);
  });

  it('rejects an empty code', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/uom-options')
      .set(authHeader('admin'))
      .send({ code: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.uomOption.create).not.toHaveBeenCalled();
  });
});
