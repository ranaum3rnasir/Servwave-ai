import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// P0 §D3 (QA-107 / A-16): CSV import is per-row upsert-by-(org, sku) with
// per-row error isolation — one bad row never aborts the batch, and a dup-SKU
// row becomes an update. Response: 200 {created, updated, errors:[{index,message}]}.

const mockPrisma = prisma as unknown as {
  priceBookItem: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  priceBookCategory: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  vendor: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const HARDWARE_CATEGORY = { id: '11111111-1111-4111-8111-111111111111', name: 'Hardware', is_active: true };
const BLUM_VENDOR = { id: '22222222-2222-4222-8222-222222222222', name: 'Blum', status: 'active' };
/** The id priceBookCategory.create hands back for a name the org did not have. */
const NEW_CATEGORY_ID = '55555555-5555-4555-8555-555555555555';

/** The org already owns one category and one vendor, both named as in the template. */
function seedLookups() {
  mockPrisma.priceBookCategory.findMany.mockResolvedValue([HARDWARE_CATEGORY]);
  mockPrisma.vendor.findMany.mockResolvedValue([BLUM_VENDOR]);
}

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('POST /api/price-book/items/import', () => {
  it('mixed batch: new row created, dup-SKU row updated, malformed row errored — nothing aborts', async () => {
    mockAuthAs('admin');
    // Row 0 (new SKU): no existing match → create.
    // Row 1 (existing SKU): match → update.
    // Row 2 (malformed: no name) → per-row validation error.
    mockPrisma.priceBookItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100', organization_id: ALPHA_ORG_ID });
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Hinge', sku: 'HINGE-200', sellPrice: 12.5, unitCost: 6, uom: 'EA' },
          { name: 'Deadbolt Lock', sku: 'LOCK-100', sellPrice: 45, unitCost: 22 },
          { sku: 'BROKEN-1', sellPrice: 10 }, // no name → row error
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].index).toBe(2);
    expect(mockPrisma.priceBookItem.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.priceBookItem.update).toHaveBeenCalledTimes(1);
  });

  it('mirrors sellPrice into unit_price AND sell_price on create', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sku: 'HINGE-200', sellPrice: 12.5 }] });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.unit_price).toBe(12.5);
    expect(data.sell_price).toBe(12.5);
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('a DB error on one row is captured per-row and the loop continues', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))
      .mockResolvedValueOnce(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Race Dup', sku: 'DUP-1', sellPrice: 5 },
          { name: 'Fine Row', sku: 'OK-1', sellPrice: 7 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].index).toBe(0);
  });

  it('runs without a wrapping transaction (rows are independent)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5 }] });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty batch at the envelope (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  // SRVW-90 - the CSV door derives `type` from `kind` exactly as the UI door does.
  it('a kind=material row is created as MATERIAL', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-900', sellPrice: 45, kind: 'material' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it('a kind=labor row and a kind-less row are created as SERVICE', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Install hour', sku: 'LAB-1', sellPrice: 95, kind: 'labor' },
          { name: 'Mystery row', sku: 'MYS-1', sellPrice: 10 },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('SERVICE');
    expect(mockPrisma.priceBookItem.create.mock.calls[1][0].data.type).toBe('SERVICE');
  });

  it('a dup-SKU row with kind=material repoints the existing item type', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45, kind: 'material' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it('a dup-SKU row with no kind leaves type alone', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data).not.toHaveProperty('type');
  });
});

describe('POST /api/price-book/items/import - Category and Vendor names', () => {
  // The two columns are handled DIFFERENTLY on a miss, and the difference is an
  // authorization boundary, not a preference: POST /categories is gated by
  // `create PriceBook`, the same ability that gates this route, so creating a
  // category here grants the caller nothing. POST /vendors is gated by the
  // separate `create Vendor` subject (inv-vendors.routes.ts), so minting a
  // vendor here would widen one grant into another.

  it('matches both names against the org and writes the two FKs on create', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sku: 'HINGE-200', sellPrice: 12.5, category: 'Hardware', vendor: 'Blum' }] });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.createdCategories).toEqual([]);
    expect(mockPrisma.priceBookCategory.create).not.toHaveBeenCalled();
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.category_id).toBe(HARDWARE_CATEGORY.id);
    expect(data.vendor_id).toBe(BLUM_VENDOR.id);
  });

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5, category: '  hardware ', vendor: 'BLUM' }] });

    expect(res.status).toBe(200);
    // Matched, therefore NOT created - a case variant must not mint a twin.
    expect(mockPrisma.priceBookCategory.create).not.toHaveBeenCalled();
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.category_id).toBe(HARDWARE_CATEGORY.id);
    expect(data.vendor_id).toBe(BLUM_VENDOR.id);
  });

  it('creates a category the org does not have, links the item, and reports it', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookCategory.create.mockResolvedValue({ id: NEW_CATEGORY_ID });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5, category: 'Hinges' }] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.createdCategories).toEqual(['Hinges']);
    expect(mockPrisma.priceBookCategory.create.mock.calls[0][0].data)
      .toEqual({ name: 'Hinges', organization_id: ALPHA_ORG_ID });
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.category_id).toBe(NEW_CATEGORY_ID);
  });

  it('creates a new category ONCE for the whole batch, whatever the casing', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookCategory.create.mockResolvedValue({ id: NEW_CATEGORY_ID });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'A', sellPrice: 1, category: 'Hinges' },
          { name: 'B', sellPrice: 2, category: 'hinges' },
          { name: 'C', sellPrice: 3, category: ' HINGES ' },
        ],
      });

    expect(res.status).toBe(200);
    // A 300-row catalog naming one new category must not mint 300 rows.
    expect(mockPrisma.priceBookCategory.create).toHaveBeenCalledTimes(1);
    expect(res.body.createdCategories).toEqual(['Hinges']);
    for (const call of mockPrisma.priceBookItem.create.mock.calls) {
      expect(call[0].data.category_id).toBe(NEW_CATEGORY_ID);
    }
  });

  it('an unmatched VENDOR warns, leaves the FK blank, and still imports the row', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5, category: 'Hardware', vendor: 'Blumm' }] });

    expect(res.status).toBe(200);
    // The row is IMPORTED, so it is a warning and not an error - "N rows
    // skipped" in the caller's toast must not count it.
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([]);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0].index).toBe(0);
    expect(res.body.warnings[0].message).toContain('Vendor "Blumm" not found');
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.vendor_id).toBeNull();
  });

  it('NEVER creates a vendor - that would widen `create PriceBook` into `create Vendor`', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookCategory.create.mockResolvedValue({ id: NEW_CATEGORY_ID });
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5, category: 'Hinges', vendor: 'Nobody Ltd' }] });

    expect(mockPrisma.vendor.create).not.toHaveBeenCalled();
  });

  it('scopes both lookups to the caller org', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5, category: 'Hardware', vendor: 'Blum' }] });

    expect(mockPrisma.priceBookCategory.findMany.mock.calls[0][0].where).toEqual({ organization_id: ALPHA_ORG_ID });
    expect(mockPrisma.vendor.findMany.mock.calls[0][0].where).toEqual({ organization_id: ALPHA_ORG_ID });
  });

  it('issues no lookup query and creates nothing when the batch names neither', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5 }, { name: 'Screw', sellPrice: 1, category: '  ' }] });

    expect(mockPrisma.priceBookCategory.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.vendor.findMany).not.toHaveBeenCalled();
    // A blank cell is NOT a category named "" and must never mint one.
    expect(mockPrisma.priceBookCategory.create).not.toHaveBeenCalled();
    expect(res.body.createdCategories).toEqual([]);
  });

  it('one lookup per batch, not one per row', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'A', sellPrice: 1, category: 'Hardware' },
          { name: 'B', sellPrice: 2, category: 'Hardware' },
          { name: 'C', sellPrice: 3, category: 'Hardware' },
        ],
      });

    expect(mockPrisma.priceBookCategory.findMany).toHaveBeenCalledTimes(1);
  });

  it('an archived vendor matches, but an active namesake wins', async () => {
    mockAuthAs('admin');
    const archived = { id: '33333333-3333-4333-8333-333333333333', name: 'Blum', status: 'inactive' };
    const retired = { id: '44444444-4444-4444-8444-444444444444', name: 'Salice', status: 'inactive' };
    // Archived first, so first-row-wins alone would pick the wrong one.
    mockPrisma.vendor.findMany.mockResolvedValue([archived, BLUM_VENDOR, retired]);
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'A', sellPrice: 1, vendor: 'Blum' }, { name: 'B', sellPrice: 2, vendor: 'Salice' }] });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.vendor_id).toBe(BLUM_VENDOR.id);
    // The only record with that name is archived, so it still matches.
    expect(mockPrisma.priceBookItem.create.mock.calls[1][0].data.vendor_id).toBe(retired.id);
  });

  it('a dup-SKU row repoints an existing item at the named category', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45, category: 'Hardware' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data.category_id).toBe(HARDWARE_CATEGORY.id);
  });

  it('a dup-SKU row with a blank cell, or an unmatched vendor, leaves the existing links alone', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45, category: null, vendor: 'Blum' },
          { name: 'Hinge', sku: 'HINGE-1', sellPrice: 12, category: null, vendor: 'Nobody Ltd' },
        ],
      });

    expect(res.status).toBe(200);
    // An import can set or repoint a link; it can never null one out.
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data).not.toHaveProperty('category_id');
    expect(mockPrisma.priceBookItem.update.mock.calls[1][0].data).not.toHaveProperty('category_id');
    expect(mockPrisma.priceBookItem.update.mock.calls[1][0].data).not.toHaveProperty('vendor_id');
  });

  it('a row that fails validation is neither warned about nor allowed to create a category', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ sku: 'BROKEN-1', sellPrice: 10, category: 'Hinges', vendor: 'Nobody Ltd' }] });

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.warnings).toEqual([]);
    expect(mockPrisma.priceBookCategory.create).not.toHaveBeenCalled();
    expect(res.body.createdCategories).toEqual([]);
  });
});

describe('POST /api/price-book/items/import - the operator must be able to act on the message', () => {
  // Every rejected row costs someone a trip back to a spreadsheet. Zod's own
  // text does not name the column ("Required", "Expected number, received
  // string"), so these pin the wording we hand back, not just the count.

  async function importOne(row: Record<string, unknown>) {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [row] });
    return res;
  }

  it('names the missing column rather than saying "Required"', async () => {
    const res = await importOne({ sku: 'NO-NAME-1', sellPrice: 10 });
    expect(res.status).toBe(200);
    expect(res.body.errors[0].message).toBe('Name is required');
  });

  it('names the column when a number cell holds text', async () => {
    const res = await importOne({ name: 'Hinge', sellPrice: 'twelve fifty' });
    expect(res.body.errors[0].message).toBe('Sell Price must be a number');
  });

  it('does not call a TEXT column a number', async () => {
    // The trap in reading Zod's prose: "Expected string, received number" also
    // contains the word "number".
    const res = await importOne({ name: 12345, sellPrice: 10 });
    expect(res.body.errors[0].message).toBe('Name must be text');
  });

  it('says a missing Sell Price is required, not that it is not a number', async () => {
    const res = await importOne({ name: 'Hinge' });
    expect(res.body.errors[0].message).toBe('Sell Price is required');
  });

  it('explains a negative number instead of quoting a bound', async () => {
    const res = await importOne({ name: 'Hinge', sellPrice: -5 });
    expect(res.body.errors[0].message).toBe('Sell Price cannot be negative');
  });

  it('explains an over-long cell', async () => {
    const res = await importOne({ name: 'x'.repeat(201), sellPrice: 10 });
    expect(res.body.errors[0].message).toBe('Name is too long');
  });

  it('never hands back a raw Prisma message', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockRejectedValue(
      new Error('Invalid `prisma.priceBookItem.create()` invocation: column "sell_price" does not exist'),
    );

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 10 }] });

    expect(res.status).toBe(200);
    // Neither our schema nor Prisma's internals belong in a customer's toast.
    expect(res.body.errors[0].message).not.toMatch(/prisma|invocation|column/i);
    expect(res.body.errors[0].message).toBe('This row could not be saved - check its values and try again');
  });

  it('still names a duplicate SKU specifically - that one IS actionable', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: 'P2002' }),
    );

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sku: 'DUP-1', sellPrice: 10 }] });

    expect(res.body.errors[0].message).toBe('An item with this SKU already exists');
  });

  it('reports the row INDEX with every issue, so the caller can point at the line', async () => {
    mockAuthAs('admin');
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Fine', sellPrice: 1 },
          { sellPrice: 2 },
          { name: 'Also fine', sellPrice: 3, vendor: 'Nobody Ltd' },
        ],
      });

    expect(res.body.errors).toEqual([{ index: 1, message: 'Name is required' }]);
    expect(res.body.warnings).toEqual([
      { index: 2, message: 'Vendor "Nobody Ltd" not found - left blank' },
    ]);
  });
});

// S4.5 (Purchasing Audit Verdict B15): docs/inventory/catalog-import-template.csv
// is the file a new customer loads their catalog from. Feed its one example row
// through the importer exactly as InventoryPage.handleImport would send it and
// require a clean create - no per-row error, no unmapped header.
describe('catalog import template imports cleanly', () => {
  const TEMPLATE = join(__dirname, '../../../docs/inventory/catalog-import-template.csv');
  // Header -> import field. Every key importRowSchema reads; a header not in
  // this table means the template grew a column the importer does not parse.
  const HEADER_TO_FIELD: Record<string, string> = {
    SKU: 'sku',
    Name: 'name',
    Category: 'category',
    Kind: 'kind',
    UoM: 'uom',
    'Unit Cost': 'unitCost',
    'Sell Price': 'sellPrice',
    Vendor: 'vendor',
  };

  function templateRows(): Array<Record<string, unknown>> {
    const lines = readFileSync(TEMPLATE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    const headers = lines[0]!.split(',').map((h) => h.trim());
    for (const h of headers) expect(HEADER_TO_FIELD, `unknown header ${h}`).toHaveProperty(h);
    return lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const field = HEADER_TO_FIELD[h]!;
        const v = cells[i] ?? '';
        row[field] = field === 'unitCost' || field === 'sellPrice' ? (parseFloat(v) || 0) : (v || null);
      });
      return row;
    });
  }

  it('the example row is created as one MATERIAL item with its cost and price', async () => {
    mockAuthAs('admin');
    // The template's Category and Vendor cells name records the org already owns,
    // which is the state the README tells a new customer to set up first.
    seedLookups();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const items = templateRows();
    expect(items).toHaveLength(1);
    // If the template's cells drift off the seeded names the FK assertions below
    // would pass for the wrong reason - the row would simply be warned and blank.
    expect(items[0]!.category).toBe(HARDWARE_CATEGORY.name);
    expect(items[0]!.vendor).toBe(BLUM_VENDOR.name);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 0, errors: [], warnings: [], createdCategories: [] });
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.category_id).toBe(HARDWARE_CATEGORY.id);
    expect(data.vendor_id).toBe(BLUM_VENDOR.id);
    expect(data.sku).toBe(items[0]!.sku);
    expect(data.name).toBe(items[0]!.name);
    expect(data.kind).toBe('material');
    expect(data.type).toBe('MATERIAL');
    expect(data.uom).toBe(items[0]!.uom);
    expect(data.unit_cost).toBe(items[0]!.unitCost);
    expect(data.sell_price).toBe(items[0]!.sellPrice);
    expect(data.unit_price).toBe(items[0]!.sellPrice);
  });
});
