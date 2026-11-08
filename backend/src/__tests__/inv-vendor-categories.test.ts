import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// S4.1 (Purchasing Audit Verdict, PR 4): vendor categories are a real
// per-company list. /vendor-categories is CRUD over that list, tenant-scoped,
// gated on the Vendor subject, with a 409 matrix (duplicate name on create and
// rename; delete refused while vendors are in the category). The vendor
// upsert resolves `categoryId` (null = Uncategorized) and still accepts the
// legacy name-only payload, which resolves-or-creates a row.

const mockPrisma = prisma as unknown as {
  vendorCategory: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  vendor: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const CAT_A = 'a1000000-0000-4000-8000-000000000a01';
const CAT_B = 'a1000000-0000-4000-8000-000000000a02';
const VENDOR_ID = 'e2000000-0000-0000-0000-000000000041';

const ROW_A = { id: CAT_A, name: 'Plumbing wholesale', organization_id: ALPHA_ORG_ID, _count: { vendors: 3 } };
const ROW_B = { id: CAT_B, name: 'Security + low voltage', organization_id: ALPHA_ORG_ID, _count: { vendors: 0 } };

const VENDOR_ROW = {
  id: VENDOR_ID,
  name: 'S4.1 Vendor',
  category: 'Plumbing wholesale',
  category_id: CAT_A,
  category_rel: { id: CAT_A, name: 'Plumbing wholesale' },
  status: 'active',
  contacts: [],
  organization_id: ALPHA_ORG_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.vendorCategory.findFirst.mockResolvedValue(null);
});

describe('GET /api/inventory/vendor-categories', () => {
  it('lists the org\'s categories with vendorCount, name ascending', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findMany.mockResolvedValue([ROW_A, ROW_B]);

    const res = await request(app).get('/api/inventory/vendor-categories').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([
      { id: CAT_A, name: 'Plumbing wholesale', vendorCount: 3 },
      { id: CAT_B, name: 'Security + low voltage', vendorCount: 0 },
    ]);
    const args = mockPrisma.vendorCategory.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ organization_id: ALPHA_ORG_ID });
    expect(args.orderBy).toEqual([{ name: 'asc' }]);
    expect(args.include).toEqual({ _count: { select: { vendors: true } } });
  });

  // #2042 (Ran, 2026-09-10): SALES gained an unconditional `read Vendor` grant (reference data,
  // org-wide) — vendor categories ride the same gate, so this route now 200s for SALES too.
  it('200s for SALES (read Vendor is unconditional per #2042)', async () => {
    mockAuthAs('sales');
    mockPrisma.vendorCategory.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/vendor-categories').set(authHeader('sales'));
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
  });

  it('200s for DISPATCHER (read Vendor is a default grant)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.vendorCategory.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/vendor-categories').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
  });
});

describe('POST /api/inventory/vendor-categories', () => {
  it('creates a category in the caller\'s org and answers 201 with vendorCount 0', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.create.mockResolvedValue({ id: CAT_B, name: 'Glazing', organization_id: ALPHA_ORG_ID });

    const res = await request(app)
      .post('/api/inventory/vendor-categories')
      .set(authHeader('admin'))
      .send({ name: '  Glazing ' });

    expect(res.status).toBe(201);
    expect(res.body.category).toEqual({ id: CAT_B, name: 'Glazing', vendorCount: 0 });
    // Trimmed, org-stamped.
    expect(mockPrisma.vendorCategory.create.mock.calls[0][0].data).toEqual({
      name: 'Glazing',
      organization_id: ALPHA_ORG_ID,
    });
    // The duplicate probe is tenant-scoped and case-insensitive.
    const probe = mockPrisma.vendorCategory.findFirst.mock.calls[0][0].where;
    expect(probe.organization_id).toBe(ALPHA_ORG_ID);
    expect(probe.name).toEqual({ equals: 'Glazing', mode: 'insensitive' });
  });

  it('409 CATEGORY_EXISTS on a duplicate name - nothing is created', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(ROW_A);

    const res = await request(app)
      .post('/api/inventory/vendor-categories')
      .set(authHeader('admin'))
      .send({ name: 'plumbing WHOLESALE' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_EXISTS');
    expect(mockPrisma.vendorCategory.create).not.toHaveBeenCalled();
  });

  it('a name with % or _ is compared as text: "Plumbing_wholesale" is not a duplicate of "Plumbing wholesale"', async () => {
    mockAuthAs('admin');
    // Postgres' ILIKE, which is what Prisma compiles `equals` + `mode: 'insensitive'` to: `%` and
    // `_` are wildcards unless escaped with a backslash.
    const ilike = (value: string, pattern: string) => {
      let re = '';
      for (let i = 0; i < pattern.length; i += 1) {
        const c = pattern[i];
        if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (c === '%') re += '.*';
        else if (c === '_') re += '.';
        else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(`^${re}$`, 'is').test(value);
    };
    mockPrisma.vendorCategory.findFirst.mockImplementation(async ({ where }: any) =>
      [ROW_A, ROW_B].find((r) => ilike(r.name, where.name.equals)) ?? null,
    );
    mockPrisma.vendorCategory.create.mockImplementation(async ({ data }: any) => ({ id: CAT_B, ...data }));

    for (const name of ['Plumbing_wholesale', 'Plumbing%', '%']) {
      const res = await request(app).post('/api/inventory/vendor-categories').set(authHeader('admin')).send({ name });
      expect({ name, status: res.status }).toEqual({ name, status: 201 });
    }
    // The same name in another case is still a duplicate.
    const dup = await request(app).post('/api/inventory/vendor-categories').set(authHeader('admin')).send({ name: 'PLUMBING wholesale' });
    expect(dup.status).toBe(409);
  });

  it('409 CATEGORY_EXISTS when the unique index fires under a concurrent create', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await request(app)
      .post('/api/inventory/vendor-categories')
      .set(authHeader('admin'))
      .send({ name: 'Glazing' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_EXISTS');
  });

  it('400 on a blank name', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/inventory/vendor-categories')
      .set(authHeader('admin'))
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(mockPrisma.vendorCategory.create).not.toHaveBeenCalled();
  });

  it('403s for TECHNICIAN (no create Vendor)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/inventory/vendor-categories')
      .set(authHeader('technician'))
      .send({ name: 'Glazing' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/inventory/vendor-categories/:id', () => {
  it('renames the row and carries every vendor in it along', async () => {
    mockAuthAs('admin');
    // First probe: the row itself (org-scoped); second: the duplicate check.
    mockPrisma.vendorCategory.findFirst
      .mockResolvedValueOnce(ROW_A)
      .mockResolvedValueOnce(null);
    mockPrisma.vendorCategory.update.mockResolvedValue({ ...ROW_A, name: 'Plumbing supply' });
    mockPrisma.vendor.updateMany.mockResolvedValue({ count: 3 });

    const res = await request(app)
      .patch(`/api/inventory/vendor-categories/${CAT_A}`)
      .set(authHeader('admin'))
      .send({ name: 'Plumbing supply' });

    expect(res.status).toBe(200);
    expect(res.body.category).toEqual({ id: CAT_A, name: 'Plumbing supply', vendorCount: 3 });

    const lookup = mockPrisma.vendorCategory.findFirst.mock.calls[0][0].where;
    expect(lookup).toEqual({ id: CAT_A, organization_id: ALPHA_ORG_ID });
    // The duplicate check excludes the row being renamed.
    const dup = mockPrisma.vendorCategory.findFirst.mock.calls[1][0].where;
    expect(dup.id).toEqual({ not: CAT_A });

    expect(mockPrisma.vendorCategory.update.mock.calls[0][0]).toMatchObject({
      where: { id: CAT_A },
      data: { name: 'Plumbing supply' },
    });
    // The legacy display string on every vendor in the category follows.
    expect(mockPrisma.vendor.updateMany.mock.calls[0][0]).toEqual({
      where: { category_id: CAT_A, organization_id: ALPHA_ORG_ID },
      data: { category: 'Plumbing supply' },
    });
  });

  it('409 CATEGORY_EXISTS when another row already has the name', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findFirst
      .mockResolvedValueOnce(ROW_A)
      .mockResolvedValueOnce(ROW_B);

    const res = await request(app)
      .patch(`/api/inventory/vendor-categories/${CAT_A}`)
      .set(authHeader('admin'))
      .send({ name: 'Security + low voltage' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_EXISTS');
    expect(mockPrisma.vendorCategory.update).not.toHaveBeenCalled();
    expect(mockPrisma.vendor.updateMany).not.toHaveBeenCalled();
  });

  it('404 for a cross-org / unknown id and for a non-UUID id', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(null);

    const missing = await request(app)
      .patch(`/api/inventory/vendor-categories/${CAT_B}`)
      .set(authHeader('admin'))
      .send({ name: 'X' });
    expect(missing.status).toBe(404);

    const malformed = await request(app)
      .patch('/api/inventory/vendor-categories/not-a-uuid')
      .set(authHeader('admin'))
      .send({ name: 'X' });
    expect(malformed.status).toBe(404);
    expect(mockPrisma.vendorCategory.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/inventory/vendor-categories/:id', () => {
  it('deletes an empty category (org-scoped)', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.count.mockResolvedValue(0);
    mockPrisma.vendorCategory.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/inventory/vendor-categories/${CAT_B}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.vendor.count.mock.calls[0][0].where).toEqual({
      category_id: CAT_B,
      organization_id: ALPHA_ORG_ID,
    });
    expect(mockPrisma.vendorCategory.deleteMany.mock.calls[0][0].where).toEqual({
      id: CAT_B,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('409 CATEGORY_IN_USE with vendor_count while vendors are in it - nothing deleted', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.count.mockResolvedValue(3);

    const res = await request(app)
      .delete(`/api/inventory/vendor-categories/${CAT_A}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_IN_USE');
    expect(res.body.vendor_count).toBe(3);
    expect(res.body.message).toMatch(/3 vendors/);
    expect(mockPrisma.vendorCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('404 for a cross-org / unknown id', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.count.mockResolvedValue(0);
    mockPrisma.vendorCategory.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/inventory/vendor-categories/${CAT_B}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('403s for TECHNICIAN (no delete Vendor)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .delete(`/api/inventory/vendor-categories/${CAT_B}`)
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.vendor.count).not.toHaveBeenCalled();
  });
});

describe('vendor upsert - categoryId (S4.1)', () => {
  it('the DTO exposes categoryId and the row\'s name as category', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findMany.mockResolvedValue([VENDOR_ROW]);

    const res = await request(app).get('/api/inventory/vendors').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.vendors[0]).toMatchObject({ categoryId: CAT_A, category: 'Plumbing wholesale' });
    // The relation is loaded so the name is the ROW's, not the legacy string.
    expect(mockPrisma.vendor.findMany.mock.calls[0][0].include).toEqual({ contacts: true, category_rel: true });
  });

  it('an uncategorized vendor reads categoryId null and category ""', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findMany.mockResolvedValue([
      { ...VENDOR_ROW, category: '', category_id: null, category_rel: null },
    ]);

    const res = await request(app).get('/api/inventory/vendors').set(authHeader('admin'));
    expect(res.body.vendors[0]).toMatchObject({ categoryId: null, category: '' });
  });

  it('update with categoryId null clears both the FK and the legacy string', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst
      .mockResolvedValueOnce(VENDOR_ROW)
      .mockResolvedValueOnce({ ...VENDOR_ROW, category: '', category_id: null, category_rel: null });
    mockPrisma.vendor.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, categoryId: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.vendor.update.mock.calls[0][0].data).toEqual({ category_id: null, category: '' });
    expect(res.body.vendor).toMatchObject({ categoryId: null, category: '' });
    // No category row is touched for "Uncategorized".
    expect(mockPrisma.vendorCategory.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.vendorCategory.create).not.toHaveBeenCalled();
  });

  it('update with a categoryId writes the FK and the row\'s name; the sent name is ignored', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(ROW_B);
    mockPrisma.vendor.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, categoryId: CAT_B, category: 'stale client name' });

    expect(res.status).toBe(200);
    expect(mockPrisma.vendorCategory.findFirst.mock.calls[0][0].where).toEqual({
      id: CAT_B,
      organization_id: ALPHA_ORG_ID,
    });
    expect(mockPrisma.vendor.update.mock.calls[0][0].data).toEqual({
      category_id: CAT_B,
      category: 'Security + low voltage',
    });
  });

  it('400 when categoryId is not one of the org\'s categories', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, categoryId: CAT_B });

    expect(res.status).toBe(400);
    expect(res.body.details?.[0]).toMatchObject({ field: 'categoryId' });
    expect(mockPrisma.vendor.update).not.toHaveBeenCalled();
  });

  it('a patch that says nothing about the category leaves both columns alone', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendor.update.mockResolvedValue({});

    await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, website: 'https://s41.example' });

    expect(mockPrisma.vendor.update.mock.calls[0][0].data).toEqual({ website: 'https://s41.example' });
  });

  it('create with categoryId null is Uncategorized', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({ ...VENDOR_ROW, category: '', category_id: null, category_rel: null });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S4.1 Vendor', categoryId: null });

    expect(res.status).toBe(201);
    expect(mockPrisma.vendor.create.mock.calls[0][0].data).toMatchObject({ category: '', category_id: null });
    expect(res.body.vendor).toMatchObject({ categoryId: null, category: '' });
  });

  it('create with no category at all is Uncategorized too', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({ ...VENDOR_ROW, category: '', category_id: null, category_rel: null });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S4.1 Vendor' });

    expect(res.status).toBe(201);
    expect(mockPrisma.vendor.create.mock.calls[0][0].data).toMatchObject({ category: '', category_id: null });
  });
});

describe('vendor upsert - legacy name-only payload resolves or creates the row (S4.1)', () => {
  it('an existing name (any case) links to that row and writes its canonical name', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(ROW_A);
    mockPrisma.vendor.create.mockResolvedValue(VENDOR_ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S4.1 Vendor', category: 'plumbing wholesale' });

    expect(res.status).toBe(201);
    const probe = mockPrisma.vendorCategory.findFirst.mock.calls[0][0].where;
    expect(probe).toEqual({
      organization_id: ALPHA_ORG_ID,
      name: { equals: 'plumbing wholesale', mode: 'insensitive' },
    });
    expect(mockPrisma.vendorCategory.create).not.toHaveBeenCalled();
    expect(mockPrisma.vendor.create.mock.calls[0][0].data).toMatchObject({
      category: 'Plumbing wholesale',
      category_id: CAT_A,
    });
  });

  it('an unknown name creates the row in the org first', async () => {
    mockAuthAs('admin');
    mockPrisma.vendorCategory.findFirst.mockResolvedValue(null);
    mockPrisma.vendorCategory.create.mockResolvedValue({ id: CAT_B, name: 'Glazing', organization_id: ALPHA_ORG_ID });
    mockPrisma.vendor.create.mockResolvedValue(VENDOR_ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S4.1 Vendor', category: '  Glazing ' });

    expect(res.status).toBe(201);
    expect(mockPrisma.vendorCategory.create.mock.calls[0][0].data).toEqual({
      name: 'Glazing',
      organization_id: ALPHA_ORG_ID,
    });
    expect(mockPrisma.vendor.create.mock.calls[0][0].data).toMatchObject({
      category: 'Glazing',
      category_id: CAT_B,
    });
  });

  it('an empty name means Uncategorized (no row created)', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(VENDOR_ROW);
    mockPrisma.vendor.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, category: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.vendor.update.mock.calls[0][0].data).toEqual({ category_id: null, category: '' });
    expect(mockPrisma.vendorCategory.create).not.toHaveBeenCalled();
  });
});
