/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.16 - the Price Book works on View price book alone.

   Every read the Price Book page needs (items, categories, brands, finishes, units, item groups) is
   reachable with View price book and nothing else, the items it returns carry catalog fields and prices
   (never stock, and never cost without See costs), and the stock item endpoints keep their
   View stock check.

   Everything goes through the public interface: the routes, called as a person on a custom role made from
   blank and holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const VIEW_PRICE_BOOK = keyOf('View price book');
const VIEW_STOCK = keyOf('View stock');
const VIEW_VENDORS = keyOf('View vendors');
const SEE_FINANCIAL_DATA = keyOf('See costs');

/** Figures nothing else on the test records can equal, so finding one in a response means the field was carried. */
const COST = 41.37;
const PRICE = 99.5;
const ON_HAND = 7321;
const SERIAL = 'SER-ONLY-IN-STOCK-7788';

/** Every key a stock-side field can travel under. */
const STOCK_KEYS = ['stock', 'stock_balances', 'stockBalances', 'onHand', 'on_hand', 'reserved', 'serials'];
const COST_KEYS = ['unitCost', 'unit_cost'];

/** Keys that appear anywhere in a body, however deep. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

suite('the Price Book works on View price book alone (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of [
        'item_groups', 'stock_balances', 'inventory_locations', 'price_book_items',
        'price_book_categories', 'brands', 'finishes', 'uom_options', 'vendors',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company with one priced, costed, stocked, vendor-supplied item and one of every catalog list entry. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const org = made.org;
    const vendor = await db.vendor.create({ data: { organization_id: org, name: 'Hardware Supply Co', category: 'Hardware' } });
    const category = await db.priceBookCategory.create({ data: { organization_id: org, name: 'Hinges' } });
    const brand = await db.brand.create({ data: { organization_id: org, name: 'Brandy' } });
    const finish = await db.finish.create({ data: { organization_id: org, name: 'Satin' } });
    await db.uomOption.create({ data: { organization_id: org, code: 'EA' } });
    await db.itemGroup.create({ data: { organization_id: org, name: 'Starter kit', group_type: 'individual' } });
    const item = randomUUID();
    await db.priceBookItem.create({
      data: {
        id: item, organization_id: org, name: 'Ball bearing hinge', sku: `SKU-${item.slice(0, 8)}`,
        unit_price: PRICE, sell_price: PRICE, unit_cost: COST, track_inventory: true,
        category_id: category.id, brand_id: brand.id, finish_id: finish.id, vendor_id: vendor.id,
        serials: [SERIAL],
      },
    });
    const location = randomUUID();
    await db.inventoryLocation.create({ data: { id: location, organization_id: org, name: 'Back shelf', type: 'warehouse' } });
    await db.stockBalance.create({ data: { organization_id: org, item_id: item, location_id: location, on_hand: ON_HAND } });
    return { ...made, item, vendor: vendor.id };
  }

  /** A person on a custom role made from blank, holding exactly these switches (plus View price book unless told otherwise). */
  async function personWith(org: string, values: Record<string, boolean> = {}) {
    const key = `price-book-reads-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { [VIEW_PRICE_BOOK]: true, see_prices: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `pb${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  describe('View price book alone', () => {
    const catalogReads = [
      '/api/price-book/categories',
      '/api/inventory/categories',
      '/api/inventory/brands',
      '/api/inventory/finishes',
      '/api/inventory/uom-options',
      '/api/inventory/item-groups',
      '/api/price-book/items',
      '/api/price-book/catalog-items',
    ];

    it.each(catalogReads)('opens %s', async (path) => {
      const { org } = await world();
      const api = await personWith(org);
      const res = await api.get(path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('opens one item by id through the Price Book read', async () => {
      const { org, item } = await world();
      const api = await personWith(org);
      expect((await api.get(`/api/price-book/items/${item}`)).status).toBe(200);
    });

    it('is refused on the stock item endpoints, which keep their View stock check', async () => {
      const { org, item } = await world();
      const api = await personWith(org);
      expect((await api.get('/api/inventory/items')).status).toBe(403);
      expect((await api.get(`/api/inventory/items/${item}`)).status).toBe(403);
      // And holding View stock is what opens them, so the check is the one it always was.
      const stocker = await personWith(org, { [VIEW_STOCK]: true });
      expect((await stocker.get('/api/inventory/items')).status).toBe(200);
    });
  });

  describe('the items the Price Book reads return', () => {
    const itemReads: { name: string; read: (api: Awaited<ReturnType<typeof personWith>>, item: string) => Promise<{ body: unknown }>; find: (body: any) => any }[] = [
      { name: 'catalog list', read: (api) => api.get('/api/price-book/catalog-items'), find: (b) => b.data[0] },
      { name: 'item list', read: (api) => api.get('/api/price-book/items'), find: (b) => b.data[0] },
      { name: 'item detail', read: (api, item) => api.get(`/api/price-book/items/${item}`), find: (b) => b.data },
    ];

    it.each(itemReads)('$name carries names, details and sell prices but no stock field and no cost without See costs', async ({ read, find }) => {
      const { org, item } = await world();
      const api = await personWith(org);
      const body = (await read(api, item)).body;
      const row = find(body);
      expect(row.name).toBe('Ball bearing hinge');
      expect(Number(row.sellPrice ?? row.sell_price)).toBe(PRICE);
      const keys = allKeys(body);
      for (const k of [...STOCK_KEYS, ...COST_KEYS]) expect(keys.has(k), k).toBe(false);
      const text = JSON.stringify(body);
      for (const figure of [String(ON_HAND), SERIAL, String(COST)]) expect(text, figure).not.toContain(figure);
    });

    it('catalog list carries the cost with See costs, and still no stock field', async () => {
      const { org } = await world();
      const api = await personWith(org, { [SEE_FINANCIAL_DATA]: true });
      const body = (await api.get('/api/price-book/catalog-items')).body;
      expect(body.data[0].unitCost).toBe(COST);
      const keys = allKeys(body);
      for (const k of STOCK_KEYS) expect(keys.has(k), k).toBe(false);
    });

    it('catalog list leaves out the vendor without View vendors and carries it with', async () => {
      const { org, vendor } = await world();
      const without = (await (await personWith(org)).get('/api/price-book/catalog-items')).body;
      expect(JSON.stringify(without)).not.toContain('Hardware Supply Co');
      expect(JSON.stringify(without)).not.toContain(vendor);
      const withVendors = (await (await personWith(org, { [VIEW_VENDORS]: true })).get('/api/price-book/catalog-items')).body;
      expect(withVendors.data[0].vendor).toBe('Hardware Supply Co');
    });

    it('catalog list hides archived items unless asked', async () => {
      const { org, item } = await world();
      await db.priceBookItem.update({ where: { id: item }, data: { is_active: false } });
      const api = await personWith(org);
      expect((await api.get('/api/price-book/catalog-items')).body.data).toHaveLength(0);
      expect((await api.get('/api/price-book/catalog-items?include_archived=true')).body.data).toHaveLength(1);
    });
  });
});
