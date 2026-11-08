import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, BRAND_FIXTURE } from './helpers';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  priceBookCategory: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  priceBookItem: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  brand: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  itemGroup: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  // The per-user override cache (60s TTL, keyed by user id) survives across tests in this file
  // since it's a module-level Map, not a vi mock — clear it so a test that sets an override
  // (e.g. the PriceBook allow-override case) can't leak into a later `mockAuthAs('sales')` test.
  clearUserOverrideCache();
});

// ─── Fixtures ─────────────────────────────────────────

const CATEGORY_FIXTURE = {
  id: 'ca000000-0000-0000-0000-000000000001',
  name: 'HVAC Services',
  parent_id: null,
  sort_order: 0,
  is_active: true,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const CHILD_CATEGORY_FIXTURE = {
  id: 'ca000000-0000-0000-0000-000000000002',
  name: 'AC Repair',
  parent_id: CATEGORY_FIXTURE.id,
  sort_order: 0,
  is_active: true,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const ITEM_FIXTURE = {
  id: 'db100000-0000-0000-0000-000000000001',
  name: 'AC Tune-Up',
  description: 'Standard AC tune-up service',
  image_url: null,
  type: 'SERVICE',
  category_id: CATEGORY_FIXTURE.id,
  unit_cost: 50,
  unit_price: 150,
  taxable: true,
  is_active: true,
  sort_order: 0,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  category: { id: CATEGORY_FIXTURE.id, name: 'HVAC Services' },
};

const MATERIAL_FIXTURE = {
  ...ITEM_FIXTURE,
  id: 'db200000-0000-0000-0000-000000000002',
  name: 'Refrigerant R-410A',
  description: '1 lb R-410A refrigerant',
  type: 'MATERIAL',
  unit_cost: 15,
  unit_price: 45,
};

// ═══════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════

describe('GET /api/price-book/categories', () => {
  it('returns list of categories', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findMany.mockResolvedValue([
      { ...CATEGORY_FIXTURE, _count: { items: 3 } },
    ]);

    const res = await request(app)
      .get('/api/price-book/categories')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('HVAC Services');
  });

  it('allows SALES access', async () => {
    mockAuthAs('sales');
    mockPrisma.priceBookCategory.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/categories')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('allows DISPATCHER access', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.priceBookCategory.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/categories')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('allows TECHNICIAN (P3 role-default read PriceBook — catalog picker feed)', async () => {
    mockAuthAs('technician');
    mockPrisma.priceBookCategory.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/categories')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });
});

describe('POST /api/price-book/categories', () => {
  it('creates a category', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.create.mockResolvedValue(CATEGORY_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('admin'))
      .send({ name: 'HVAC Services' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('HVAC Services');
  });

  it('creates a subcategory with valid parent_id', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(CATEGORY_FIXTURE);
    mockPrisma.priceBookCategory.create.mockResolvedValue(CHILD_CATEGORY_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('admin'))
      .send({ name: 'AC Repair', parent_id: CATEGORY_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.data.parent_id).toBe(CATEGORY_FIXTURE.id);
  });

  it('rejects invalid parent_id', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('admin'))
      .send({ name: 'Orphan', parent_id: 'ba000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(404);
  });

  it('forbids SALES from creating categories by default (Pricebook write is admin-only, grantable per user)', async () => {
    mockAuthAs('sales');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('sales'))
      .send({ name: 'New Category' });

    expect(res.status).toBe(403);
  });

  it('allows SALES with a per-user PriceBook allow override to create categories', async () => {
    mockAuthAs('sales');
    clearUserOverrideCache(); // override cache is per-user with 60s TTL; earlier tests cached []
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ action: 'create', subject: 'PriceBook', effect: 'allow' }]);
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookCategory.create.mockResolvedValue({ ...CATEGORY_FIXTURE, name: 'New Category' });

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('sales'))
      .send({ name: 'New Category' });

    expect(res.status).toBe(201);
  });

  it('validates required name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/categories')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/price-book/categories/:id', () => {
  it('updates a category', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue({ ...CATEGORY_FIXTURE, name: 'Updated' });
    mockPrisma.priceBookCategory.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/categories/${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated');
  });

  it('prevents self-referencing parent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(CATEGORY_FIXTURE);

    const res = await request(app)
      .patch(`/api/price-book/categories/${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ parent_id: CATEGORY_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('own parent');
  });

  it('returns 404 for nonexistent category', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/price-book/categories/nonexistent')
      .set(authHeader('admin'))
      .send({ name: 'Nope' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/price-book/categories/:id', () => {
  it('deletes an empty category', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue({
      ...CATEGORY_FIXTURE,
      _count: { items: 0, children: 0 },
    });
    mockPrisma.priceBookCategory.delete.mockResolvedValue(CATEGORY_FIXTURE);

    const res = await request(app)
      .delete(`/api/price-book/categories/${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('blocks deletion of category with items', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue({
      ...CATEGORY_FIXTURE,
      _count: { items: 3, children: 0 },
    });

    const res = await request(app)
      .delete(`/api/price-book/categories/${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('items');
  });

  it('blocks deletion of category with subcategories', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue({
      ...CATEGORY_FIXTURE,
      _count: { items: 0, children: 2 },
    });

    const res = await request(app)
      .delete(`/api/price-book/categories/${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('subcategories');
  });
});

// ═══════════════════════════════════════════════════════
// ITEMS
// ═══════════════════════════════════════════════════════

describe('GET /api/price-book/items', () => {
  it('returns paginated items', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([ITEM_FIXTURE]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/price-book/items')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 });
  });

  it('filters by type', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([MATERIAL_FIXTURE]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/price-book/items?type=MATERIAL')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('filters by category_id', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([ITEM_FIXTURE]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/price-book/items?category_id=${CATEGORY_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('filters by is_active', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/price-book/items?is_active=false')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('searches by name', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([ITEM_FIXTURE]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/price-book/items?search=tune')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('allows TECHNICIAN (P3 role-default read PriceBook — cost stripping asserted below)', async () => {
    mockAuthAs('technician');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/price-book/items')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });
});

describe('GET /api/price-book/items/search', () => {
  it('returns autocomplete results', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([
      { id: ITEM_FIXTURE.id, name: 'AC Tune-Up', description: ITEM_FIXTURE.description, type: 'SERVICE', unit_cost: 50, unit_price: 150, taxable: true, category: ITEM_FIXTURE.category },
    ]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=AC')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('AC Tune-Up');
  });

  it('returns empty for blank query', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/price-book/items/search?q=')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('filters by type', async () => {
    mockAuthAs('sales');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=ref&type=MATERIAL')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('allows TECHNICIAN (P3 role-default read PriceBook — the mobile picker feed)', async () => {
    mockAuthAs('technician');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=test')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });
});

describe('POST /api/price-book/items', () => {
  it('creates an item', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150 });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('AC Tune-Up');
  });

  it('creates with category and cost', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(CATEGORY_FIXTURE);
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150, unit_cost: 50, category_id: CATEGORY_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('forbids SALES from creating items by default (Pricebook write is admin-only, grantable per user)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('sales'))
      .send({ name: 'AC Tune-Up', unit_price: 150 });

    expect(res.status).toBe(403);
  });

  it('rejects invalid category', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Test', unit_price: 100, category_id: 'ba000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(404);
  });

  it('validates required fields', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('blocks TECHNICIAN', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('technician'))
      .send({ name: 'Test', unit_price: 100 });

    expect(res.status).toBe(403);
  });

  it('blocks DISPATCHER', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('dispatcher'))
      .send({ name: 'Test', unit_price: 100 });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/price-book/items/:id', () => {
  it('returns item by id', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .get(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('AC Tune-Up');
  });

  it('returns 404 for nonexistent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/price-book/items/nonexistent')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/price-book/items/:id', () => {
  it('updates an item', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ ...ITEM_FIXTURE, unit_price: 175 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ unit_price: 175 });

    expect(res.status).toBe(200);
    expect(res.body.data.unit_price).toBe(175);
  });

  it('returns 404 for nonexistent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/price-book/items/nonexistent')
      .set(authHeader('admin'))
      .send({ name: 'Updated' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/price-book/items/:id (hybrid)', () => {
  it('HARD-deletes an item that nothing references', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({
      id: ITEM_FIXTURE.id, sku: 'SKU-1', name: 'Widget',
      _count: { job_line_items: 0, invoice_line_items: 0, line_items: 0, stock_balances: 0 },
    });
    mockPrisma.priceBookItem.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('deleted');
    expect(mockPrisma.priceBookItem.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.updateMany).not.toHaveBeenCalled();
  });

  it('ARCHIVES an item that is referenced (soft-delete, keeps history)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({
      id: ITEM_FIXTURE.id, sku: 'SKU-1', name: 'Widget',
      _count: { job_line_items: 2, invoice_line_items: 0, line_items: 0, stock_balances: 0 },
    });
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('archived');
    expect(res.body.referenceCount).toBe(2);
    expect(mockPrisma.priceBookItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { is_active: false } }),
    );
    expect(mockPrisma.priceBookItem.deleteMany).not.toHaveBeenCalled();
  });

  it('returns 404 for nonexistent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .delete('/api/price-book/items/00000000-0000-4000-8000-000000000000')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('forbids SALES by default (Pricebook write is admin-only, grantable per user)', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .delete(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// IMAGE URL
// ═══════════════════════════════════════════════════════

describe('Item image_url', () => {
  it('creates item with image_url', async () => {
    mockAuthAs('admin');
    const withImage = { ...ITEM_FIXTURE, image_url: 'https://storage.example.com/image.jpg' };
    mockPrisma.priceBookItem.create.mockResolvedValue(withImage);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150, image_url: 'https://storage.example.com/image.jpg' });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ image_url: 'https://storage.example.com/image.jpg' }),
      }),
    );
  });

  it('creates item with null image_url', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150 });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ image_url: null }),
      }),
    );
  });

  it('updates item image_url', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });
    const updated = { ...ITEM_FIXTURE, image_url: 'https://storage.example.com/new.png' };
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(updated);

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ image_url: 'https://storage.example.com/new.png' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid image_url format', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Test', unit_price: 100, image_url: 'not-a-url' });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// P0 §D1 — superset write fields + price mirror + 409
// ═══════════════════════════════════════════════════════

describe('POST /api/price-book/items — superset fields (P0 §D1)', () => {
  const VENDOR_ID = 'de000000-0000-0000-0000-000000000001';

  it('persists the full superset of snake_case columns', async () => {
    mockAuthAs('admin');
    mockPrisma.brand.findFirst.mockResolvedValue(BRAND_FIXTURE);
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID });
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({
        name: 'Deadbolt', sku: 'LOCK-100', mpn: 'MPN-1', model_number: 'MT5-114', upc: '012345',
        brand_id: BRAND_FIXTURE.id, vendor_id: VENDOR_ID,
        trade: 'locksmith', kind: 'material', uom: 'EA',
        sell_price: 45, list_price: 60, unit_cost: 20,
        serialized: true, hazmat: false, status: 'active', visibility: 'public',
        customer_name: 'Grade-1 Deadbolt', customer_description: 'Heavy duty',
        key_features: ['ANSI Grade 1'], photo_url: 'data:image/png;base64,AAA',
        track_inventory: true,
      });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      sku: 'LOCK-100', mpn: 'MPN-1', model_number: 'MT5-114', upc: '012345',
      brand_id: BRAND_FIXTURE.id, vendor_id: VENDOR_ID,
      trade: 'locksmith', kind: 'material', uom: 'EA',
      sell_price: 45, list_price: 60, unit_cost: 20,
      serialized: true, hazmat: false, status: 'active', visibility: 'public',
      customer_name: 'Grade-1 Deadbolt', customer_description: 'Heavy duty',
      key_features: ['ANSI Grade 1'], photo_url: 'data:image/png;base64,AAA',
      track_inventory: true,
    }));
  });

  it('mirrors sell_price into unit_price when only sell_price is sent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Deadbolt', sell_price: 45 });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.unit_price).toBe(45);
    expect(data.sell_price).toBe(45);
  });

  it('mirrors unit_price into sell_price for legacy clients', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150 });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.unit_price).toBe(150);
    expect(data.sell_price).toBe(150);
  });

  it('writes both prices as-is when both are sent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Deadbolt', unit_price: 40, sell_price: 45 });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.unit_price).toBe(40);
    expect(data.sell_price).toBe(45);
  });

  it('400s when neither unit_price nor sell_price is sent', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'No Price' });

    expect(res.status).toBe(400);
  });

  it('404s on a brand_id outside the org', async () => {
    mockAuthAs('admin');
    mockPrisma.brand.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'X', sell_price: 1, brand_id: 'ba000000-0000-0000-0000-000000000009' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Brand not found');
  });

  it('404s on a vendor_id outside the org', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'X', sell_price: 1, vendor_id: 'ba000000-0000-0000-0000-000000000008' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Vendor not found');
  });

  it('duplicate SKU → 409 with a sku field detail (QA-106)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Dup', sell_price: 5, sku: 'LOCK-100' });

    expect(res.status).toBe(409);
    expect(res.body.details[0].field).toBe('sku');
  });
});

// ═══════════════════════════════════════════════════════
// SRVW-90 - `type` is a projection of the `kind` control
// ═══════════════════════════════════════════════════════

describe('price-book item type follows kind (SRVW-90)', () => {
  const mockAuditCreate = (prisma as unknown as {
    auditLog: { create: ReturnType<typeof vi.fn> };
  }).auditLog.create;

  it('POST with kind: material writes type MATERIAL', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Deadbolt', sell_price: 45, kind: 'material' });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it.each(['service', 'labor', 'bundle', 'fee'])(
    'POST with kind: %s writes type SERVICE',
    async (kind) => {
      mockAuthAs('admin');
      mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

      const res = await request(app)
        .post('/api/price-book/items')
        .set(authHeader('admin'))
        .send({ name: 'Call-out', sell_price: 45, kind });

      expect(res.status).toBe(201);
      expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('SERVICE');
    },
  );

  it('POST with neither type nor kind still writes SERVICE', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'AC Tune-Up', unit_price: 150 });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('SERVICE');
  });

  it('an explicit type wins over the kind projection on create', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Bundled visit', unit_price: 150, type: 'SERVICE', kind: 'material' });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('SERVICE');
  });

  it('create default taxable stays true and an explicit false persists', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Taxed by default', unit_price: 150 });
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.taxable).toBe(true);

    await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Exempt', unit_price: 150, taxable: false });
    expect(mockPrisma.priceBookItem.create.mock.calls[1][0].data.taxable).toBe(false);
  });

  it('PATCH with kind: material repoints type to MATERIAL', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ kind: 'material' });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it('PATCH with no kind never writes type', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('type');
    expect(data.name).toBe('Renamed');
  });

  it('PATCH with an explicit type beats the kind projection', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ kind: 'material', type: 'SERVICE' });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data.type).toBe('SERVICE');
  });

  it('a kind-derived type change is recorded in the audit metadata', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ kind: 'material' });

    expect(res.status).toBe(200);
    const audited = mockAuditCreate.mock.calls
      .map((c) => c[0].data)
      .find((d: { action: string }) => d.action === 'pricebook.item_updated');
    expect(audited.metadata).toEqual({ fields: ['kind'], derived: { type: 'MATERIAL' } });
  });
});

// Item Kind collapsed to material|service. `labor`, `bundle` and `fee` were
// selectable but bought nothing: typeForKind already billed all three as
// SERVICE, and the Stock > Items grid filtered bundle and fee out entirely, so
// an item saved as either simply vanished. Rather than reject the retired
// tokens - which would 400 an old client, a stored CSV or a queued request -
// the server folds them into `service`, the value they already behaved as.
describe('item kind normalizes to material|service', () => {
  it.each([
    ['labor', 'service', 'SERVICE'],
    ['bundle', 'service', 'SERVICE'],
    ['fee', 'service', 'SERVICE'],
    ['service', 'service', 'SERVICE'],
    ['material', 'material', 'MATERIAL'],
    // Case and padding: the dropdown only ever sends lower-case, but a CSV or a
    // hand-rolled request does not, and two spellings of one kind would split
    // the grid filter.
    ['Labor', 'service', 'SERVICE'],
    ['  MATERIAL  ', 'material', 'MATERIAL'],
    // Anything unrecognised lands where typeForKind already put it.
    ['widget', 'service', 'SERVICE'],
  ])('POST with kind %s stores %s', async (sent, storedKind, storedType) => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Anything', sell_price: 45, kind: sent });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.kind).toBe(storedKind);
    expect(data.type).toBe(storedType);
  });

  it('POST with no kind still stores null rather than inventing one', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.create.mockResolvedValue(ITEM_FIXTURE);

    const res = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('admin'))
      .send({ name: 'Kindless', sell_price: 45 });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.kind).toBeNull();
  });

  it('PATCH with kind: labor writes kind service', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ kind: 'labor' });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data;
    expect(data.kind).toBe('service');
    expect(data.type).toBe('SERVICE');
  });

  it('PATCH clearing kind to null still clears it', async () => {
    // Guarded separately because normalize() must not turn a deliberate clear
    // into the string "service" - that would silently reclassify the item.
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ kind: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data.kind).toBeNull();
  });
});

describe('PATCH /api/price-book/items/:id — mirror + 409 (P0 §D1)', () => {
  it('mirrors sell_price into unit_price on update', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ sell_price: 99 });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data;
    expect(data.sell_price).toBe(99);
    expect(data.unit_price).toBe(99);
  });

  it('passes model_number and mpn through on update, and clears them on null', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ model_number: 'MT5-114', mpn: 'MPN-1' });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ model_number: 'MT5-114', mpn: 'MPN-1' }),
    );

    const cleared = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ model_number: null, mpn: null });

    expect(cleared.status).toBe(200);
    expect(mockPrisma.priceBookItem.updateMany.mock.calls[1][0].data).toEqual(
      expect.objectContaining({ model_number: null, mpn: null }),
    );
  });

  it('touches neither price when neither is sent', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('unit_price');
    expect(data).not.toHaveProperty('sell_price');
    expect(data.name).toBe('Renamed');
  });

  it('duplicate SKU on update → 409', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ITEM_FIXTURE);
    mockPrisma.priceBookItem.updateMany.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ sku: 'LOCK-100' });

    expect(res.status).toBe(409);
    expect(res.body.details[0].field).toBe('sku');
  });
});

// ═══════════════════════════════════════════════════════
// P0 §D6 — new list filters
// ═══════════════════════════════════════════════════════

describe('GET /api/price-book/items — brand_id/track_inventory filters (P0 §D6)', () => {
  it('threads brand_id + track_inventory into the where', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/price-book/items?brand_id=${BRAND_FIXTURE.id}&track_inventory=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.priceBookItem.findMany.mock.calls[0][0].where;
    expect(where.brand_id).toBe(BRAND_FIXTURE.id);
    expect(where.track_inventory).toBe(true);
  });

  it('search also matches SKU', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.priceBookItem.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/price-book/items?search=LOCK')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.priceBookItem.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      { sku: { contains: 'LOCK', mode: 'insensitive' } },
    ]));
  });
});

// ═══════════════════════════════════════════════════════
// P0 §D7 — cost stripping (unit_cost + list_price only)
// ═══════════════════════════════════════════════════════

describe('price-book cost stripping (P0 §D7)', () => {
  const ROW = { ...ITEM_FIXTURE, list_price: 200, sell_price: 150 };

  const grantTechPriceBookRead = () => {
    clearPermissionCache();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' },
    ]);
  };

  it('list strips unit_cost + list_price for a reader without read Invoice, keeps selling prices', async () => {
    mockAuthAs('technician');
    grantTechPriceBookRead();
    mockPrisma.priceBookItem.findMany.mockResolvedValue([ROW]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/price-book/items')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unit_cost).toBeUndefined();
    expect(res.body.data[0].list_price).toBeUndefined();
    expect(res.body.data[0].unit_price).toBe(150);
    expect(res.body.data[0].sell_price).toBe(150);
  });

  it('list keeps unit_cost + list_price for ADMIN', async () => {
    mockAuthAs('admin');
    clearPermissionCache();
    mockPrisma.priceBookItem.findMany.mockResolvedValue([ROW]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/price-book/items')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unit_cost).toBe(50);
    expect(res.body.data[0].list_price).toBe(200);
  });

  it('search strips unit_cost for a reader without read Invoice', async () => {
    mockAuthAs('technician');
    grantTechPriceBookRead();
    mockPrisma.priceBookItem.findMany.mockResolvedValue([
      { id: ROW.id, name: ROW.name, description: ROW.description, image_url: null, type: 'SERVICE', unit_cost: 50, unit_price: 150, taxable: true, category: ROW.category },
    ]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=AC')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unit_cost).toBeUndefined();
    expect(res.body.data[0].unit_price).toBe(150);
  });

  it('single-item read strips too', async () => {
    mockAuthAs('technician');
    grantTechPriceBookRead();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(ROW);

    const res = await request(app)
      .get(`/api/price-book/items/${ROW.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data.unit_cost).toBeUndefined();
    expect(res.body.data.list_price).toBeUndefined();
    expect(res.body.data.unit_price).toBe(150);
  });
});
