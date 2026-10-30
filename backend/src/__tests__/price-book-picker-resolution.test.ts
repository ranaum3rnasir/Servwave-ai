/**
 * price-book-picker-resolution.test.ts — the price-book picker's endpoints must hand
 * the client ONE resolved answer per concept, not two raw columns.
 *
 * A catalog item's image lives in `photo_url` (Text, data URIs) or `image_url`
 * (VarChar(500), a URL), and its selling price in `sell_price` or `unit_price`. Writes
 * land in one column and the picker read the other, so an item the price book lists
 * with a photo and $500 browsed as a grey placeholder and $0.00.
 *
 * The browse endpoint (`GET /api/price-book/items`) returned raw rows and left the
 * choice to the client. It now carries `photoUrl` / `sellPrice` — camelCase ANSWERS
 * from lib/catalog/item-resolution, with `null` as the explicit absent state — while
 * keeping every raw column it always returned, so existing readers are untouched.
 *
 * The search endpoint (`GET /api/price-book/items/search`) projects with an explicit
 * `select`, which used to omit the fallback columns outright — so it resolved from the
 * legacy pair only and no client-side fix could ever reach the others. The select now
 * names all four, and the last block below pins both the query and the answers, so
 * browsing and searching the same item can no longer disagree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  priceBookCategory: { findMany: ReturnType<typeof vi.fn> };
  itemGroup: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

const CATEGORY = { id: 'ca000000-0000-0000-0000-000000000009', name: 'HVAC Services' };

/** A row as `listItems`'s `include` returns it — every column present, two per concept. */
function itemRow(overrides: Record<string, unknown>) {
  return {
    id: 'db100000-0000-0000-0000-000000000009',
    name: 'AC Tune-Up',
    description: 'Standard AC tune-up service',
    photo_url: null,
    image_url: null,
    type: 'SERVICE',
    category_id: CATEGORY.id,
    unit_cost: 50,
    unit_price: null,
    sell_price: null,
    taxable: true,
    is_active: true,
    sort_order: 0,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    category: CATEGORY,
    ...overrides,
  };
}

/** Browse one row and return the single item the endpoint answered with. */
async function browseOne(overrides: Record<string, unknown>) {
  mockAuthAs('admin');
  mockPrisma.priceBookItem.findMany.mockResolvedValue([itemRow(overrides)]);
  mockPrisma.priceBookItem.count.mockResolvedValue(1);

  const res = await request(app).get('/api/price-book/items').set(authHeader('admin'));
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
  return res.body.data[0] as Record<string, unknown>;
}

describe('GET /api/price-book/items — resolved image', () => {
  it('answers with the canonical column when only it is set', async () => {
    const item = await browseOne({ photo_url: 'data:image/png;base64,AAA' });
    expect(item.photoUrl).toBe('data:image/png;base64,AAA');
  });

  it('answers with the legacy column when only it is set', async () => {
    const item = await browseOne({ image_url: 'https://cdn.example.com/tune-up.png' });
    expect(item.photoUrl).toBe('https://cdn.example.com/tune-up.png');
  });

  it('prefers the canonical column when the two diverge', async () => {
    const item = await browseOne({
      photo_url: 'data:image/png;base64,AAA',
      image_url: 'https://cdn.example.com/legacy.png',
    });
    expect(item.photoUrl).toBe('data:image/png;base64,AAA');
  });

  it('answers with an explicit null for an image-less item', async () => {
    const item = await browseOne({});
    expect(item.photoUrl).toBeNull();
  });

  it('treats an empty string as absent, not as an image', async () => {
    const item = await browseOne({ photo_url: '', image_url: '' });
    expect(item.photoUrl).toBeNull();
  });
});

describe('GET /api/price-book/items — resolved price', () => {
  it('answers with the canonical column when only it is set', async () => {
    const item = await browseOne({ sell_price: 500 });
    expect(item.sellPrice).toBe(500);
  });

  it('answers with the legacy column when only it is set', async () => {
    const item = await browseOne({ unit_price: 500 });
    expect(item.sellPrice).toBe(500);
  });

  it('prefers the canonical column when the two diverge', async () => {
    const item = await browseOne({ sell_price: 500, unit_price: 125 });
    expect(item.sellPrice).toBe(500);
  });

  it('answers with an explicit null for an unpriced item, never a confident 0', async () => {
    const item = await browseOne({});
    expect(item.sellPrice).toBeNull();
  });

  it('keeps a genuine zero as a price, distinct from unpriced', async () => {
    const item = await browseOne({ sell_price: 0, unit_price: 125 });
    expect(item.sellPrice).toBe(0);
    expect(item.sellPrice).not.toBeNull();
  });
});

describe('GET /api/price-book/items — resolved cost', () => {
  // The picker's consumers seed a line's cost from this, and the margin that line later
  // shows is computed from it. `Number()` on the raw column turns an empty or malformed
  // value into a confident 0 — a 0 cost against a real price is a 100% margin, where an
  // uncosted line is supposed to show an em dash. So cost gets the same explicit
  // present/absent answer the price does.
  it('answers with the item cost alongside the price', async () => {
    const item = await browseOne({ unit_cost: 200, sell_price: 500 });
    expect(item.unitCost).toBe(200);
  });

  it('answers with an explicit null for a cost-less item, never a confident 0', async () => {
    const item = await browseOne({ unit_cost: null });
    expect(item.unitCost).toBeNull();
  });

  it('treats an empty cost column as absent, not as a cost of zero', async () => {
    const item = await browseOne({ unit_cost: '' });
    expect(item.unitCost).toBeNull();
  });

  it('keeps a genuine zero cost, distinct from uncosted', async () => {
    const item = await browseOne({ unit_cost: 0 });
    expect(item.unitCost).toBe(0);
  });

  it('strips the resolved cost for a reader without read Invoice, exactly like the raw column', async () => {
    // The answer is cost data like any other. A resolved field spread back on AFTER the
    // cost strip would hand a technician the margin data the strip exists to withhold.
    mockAuthAs('technician');
    clearPermissionCache();
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' },
    ]);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([itemRow({ unit_cost: 200, sell_price: 500 })]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/price-book/items').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const item = res.body.data[0];
    expect(item.unitCost).toBeUndefined();
    expect(item.unit_cost).toBeUndefined();
    expect(item.sellPrice).toBe(500);
  });
});

describe('GET /api/price-book/items — the raw columns still travel', () => {
  it('adds the resolved answers without removing what readers already consume', async () => {
    const item = await browseOne({
      photo_url: 'data:image/png;base64,AAA',
      image_url: 'https://cdn.example.com/legacy.png',
      sell_price: 500,
      unit_price: 125,
    });
    expect(item).toMatchObject({
      id: 'db100000-0000-0000-0000-000000000009',
      name: 'AC Tune-Up',
      image_url: 'https://cdn.example.com/legacy.png',
      unit_price: 125,
      taxable: true,
      category: CATEGORY,
    });
  });

  it('hands a reader without See financial data exactly these keys and nothing else', async () => {
    // EXHAUSTIVE `toEqual` on purpose — do NOT relax it to `toMatchObject`, and do not
    // reduce it to a handful of `toBeUndefined()` checks on the field names we happen to
    // know about today. Naming the fields that must be ABSENT can only ever catch the
    // leak you already thought of: `stripItemCost` deletes named keys, so a new resolved
    // field it has never heard of reaches a technician under a name no negative assertion
    // mentions. That bypass was demonstrated live while `unitCost` was being added. The
    // whole-payload form is what makes a new field on this projection impossible to ship
    // silently — a future cost field fails HERE rather than in production.
    mockAuthAs('technician');
    // TECHNICIAN holds role-default `read PriceBook` but not `read Invoice` — the same
    // grant shape price-book.test.ts's §D7 block uses.
    clearPermissionCache();
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' },
    ]);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([itemRow({ sell_price: 500, list_price: 900 })]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/price-book/items').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: 'db100000-0000-0000-0000-000000000009',
      name: 'AC Tune-Up',
      description: 'Standard AC tune-up service',
      photo_url: null,
      image_url: null,
      type: 'SERVICE',
      category_id: CATEGORY.id,
      category: CATEGORY,
      taxable: true,
      is_active: true,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      // Prices - raw and resolved, the price book's list price among them - are never stripped.
      unit_price: null,
      sell_price: 500,
      list_price: 900,
      sellPrice: 500,
      photoUrl: null,
      // `unit_cost` and `unitCost` are absent, and so is anything else.
    });
  });
});

describe('the sibling mappers that only ever use one column are left alone', () => {
  // mapCategory and mapItemGroup live beside mapItem in inv-catalog.controller and are
  // reached through /api/inventory/*. They deliberately do NOT resolve: a category and an
  // item group each have exactly ONE photo column, so a fallback chain there would be
  // inventing a column that does not exist. Both fixtures below carry a decoy `image_url`
  // - if a later change wires the ITEM resolver into these mappers, the decoy surfaces and
  // these tests go red.

  it('a category answers from its own single photo column and never falls back', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookCategory.findMany.mockResolvedValue([
      {
        id: CATEGORY.id,
        name: CATEGORY.name,
        trade: 'locksmith',
        description: null,
        photo_url: null,
        image_url: 'https://cdn.example.com/decoy-never-read-this.png',
        _count: { items: 0 },
      },
    ]);

    const res = await request(app).get('/api/inventory/categories').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const category = res.body.categories[0];
    expect(category.id).toBe(CATEGORY.id);
    expect(category.photoUrl).toBeUndefined();
  });

  it('an item group answers from its own single photo column and never falls back', async () => {
    mockAuthAs('admin');
    mockPrisma.itemGroup.findMany.mockResolvedValue([
      {
        id: 'ig000000-0000-0000-0000-000000000001',
        name: 'Rooftop unit kit',
        description: null,
        photo_url: null,
        image_url: 'https://cdn.example.com/decoy-never-read-this.png',
        group_type: 'bundle',
        flat_rate_price_override: null,
        is_active: true,
        lines: [],
      },
    ]);

    const res = await request(app).get('/api/inventory/item-groups').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const group = res.body.itemGroups[0];
    expect(group.name).toBe('Rooftop unit kit');
    expect(group.photoUrl).toBeUndefined();
  });
});

describe('GET /api/price-book/items/search — the projection carries both fallback columns', () => {
  /** Every column the row genuinely has in the DB, before any projection narrows it. */
  const FULL_ROW: Record<string, unknown> = {
    id: 'db100000-0000-0000-0000-000000000009',
    name: 'AC Tune-Up',
    description: 'Standard AC tune-up service',
    photo_url: 'data:image/png;base64,AAA',
    image_url: 'https://cdn.example.com/legacy.png',
    type: 'SERVICE',
    unit_cost: 50,
    list_price: 900,
    sell_price: 500,
    unit_price: 125,
    taxable: true,
    category: CATEGORY,
  };

  /**
   * Answer `findMany` the way Prisma does: return ONLY the columns the `select` names.
   *
   * This matters more than it looks. A plain `mockResolvedValue(row)` hands the handler
   * every column no matter what the projection asked for, so a test written that way
   * stays green against the un-widened select and proves nothing — the exact "test that
   * cannot fail" this repo keeps producing. Honouring the select is what makes the
   * assertions below go red when a column is dropped from the projection.
   */
  function mockFindManyThroughSelect(row: Record<string, unknown> = FULL_ROW) {
    mockPrisma.priceBookItem.findMany.mockImplementation(async (args: any) => {
      const select = args?.select as Record<string, unknown> | undefined;
      if (!select) return [row];
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(select)) {
        if (key in row) projected[key] = row[key];
      }
      return [projected];
    });
  }

  /** Search one row (projected through the real select) and return the single answer. */
  async function searchOne(row: Record<string, unknown> = FULL_ROW) {
    mockFindManyThroughSelect(row);

    const res = await request(app).get('/api/price-book/items/search?q=tune').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    return res.body.data[0] as Record<string, unknown>;
  }

  it('names both image columns and both price columns in its select', async () => {
    // The projection IS the defect: a column the explicit `select` does not name never
    // reaches the resolution module, and no client-side fix can reach it either.
    mockAuthAs('admin');
    await searchOne();

    expect(mockPrisma.priceBookItem.findMany.mock.calls[0][0].select).toMatchObject({
      photo_url: true,
      image_url: true,
      sell_price: true,
      unit_price: true,
    });
  });

  it('carries the image and the price of a populated item on the wire', async () => {
    mockAuthAs('admin');
    const item = await searchOne();

    expect(item.photoUrl).toBe('data:image/png;base64,AAA');
    expect(item.sellPrice).toBe(500);
  });

  it('still falls back to the legacy columns when the canonical ones are empty', async () => {
    mockAuthAs('admin');
    const item = await searchOne({ ...FULL_ROW, photo_url: null, sell_price: null });

    expect(item.photoUrl).toBe('https://cdn.example.com/legacy.png');
    expect(item.sellPrice).toBe(125);
  });

  it('answers a searched item exactly as browse answers the same row', async () => {
    // The point of the slice: how the operator found the item must not change what it
    // shows. Same underlying row through both endpoints, same two answers.
    mockAuthAs('admin');
    const browsed = await browseOne({
      photo_url: FULL_ROW.photo_url,
      image_url: FULL_ROW.image_url,
      sell_price: FULL_ROW.sell_price,
      unit_price: FULL_ROW.unit_price,
    });

    vi.clearAllMocks();
    mockAuthAs('admin');
    const searched = await searchOne();

    expect(searched.photoUrl).toBe(browsed.photoUrl);
    expect(searched.sellPrice).toBe(browsed.sellPrice);
  });

  it('hands a reader without read Invoice exactly these keys and nothing else', async () => {
    // Widening a projection is exactly how a strip gets bypassed, and this endpoint shares
    // `pickerItemPayload` with browse — so it leaks identically, and it needs the identical
    // guard. It did not have one: it named `unit_cost` and `list_price` and stopped there,
    // which is why an injected resolved field reached a technician HERE while browse's
    // owning module test went red. Same rule as the browse block above: EXHAUSTIVE
    // `toEqual`, never `toMatchObject`, never a list of `toBeUndefined()` on the names we
    // thought of.
    mockAuthAs('technician');
    clearPermissionCache();
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' },
    ]);
    mockFindManyThroughSelect();

    const res = await request(app).get('/api/price-book/items/search?q=tune').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: 'db100000-0000-0000-0000-000000000009',
      name: 'AC Tune-Up',
      description: 'Standard AC tune-up service',
      photo_url: 'data:image/png;base64,AAA',
      image_url: 'https://cdn.example.com/legacy.png',
      photoUrl: 'data:image/png;base64,AAA',
      type: 'SERVICE',
      category: CATEGORY,
      taxable: true,
      // Customer-facing selling price, raw and resolved — never stripped.
      unit_price: 125,
      sell_price: 500,
      sellPrice: 500,
      // `unit_cost` and `unitCost` are absent, and so is anything else.
    });
    // `list_price` never even enters the projection, so the strip is the second line of
    // defence here rather than the only one.
    expect(mockPrisma.priceBookItem.findMany.mock.calls[0][0].select.list_price).toBeUndefined();
  });
});
