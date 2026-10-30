/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.18 - vendor fields on items, price book items and brands follow
   View vendors.

   A person who holds View stock and View price book but not View vendors (the Technician preset) must
   get no vendor name and no vendor id from any item, price book item or brand response; with View vendors
   they carry them as before. The rule holds for every caller, so it is checked on each route that carries
   one of those fields, reads and write answers alike.

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
const VIEW_STOCK = keyOf('View stock');
const VIEW_PRICE_BOOK = keyOf('View price book');
const EDIT_PRICE_BOOK = keyOf('Edit price book items');
const CREATE_PRICE_BOOK = keyOf('Create price book items');
const VIEW_VENDORS = keyOf('View vendors');

const VENDOR_NAME = 'Hardware Supply Co';

suite('vendor fields follow View vendors (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['stock_balances', 'inventory_locations', 'price_book_items', 'brands', 'vendors']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company with one vendor, a brand whose default vendor it is, and a stocked item that vendor supplies. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const org = made.org;
    const vendor = await db.vendor.create({ data: { organization_id: org, name: VENDOR_NAME, category: 'Hardware' } });
    const brand = await db.brand.create({ data: { organization_id: org, name: 'Brandy', default_vendor_id: vendor.id } });
    const item = randomUUID();
    await db.priceBookItem.create({
      data: {
        id: item, organization_id: org, name: 'Ball bearing hinge', sku: `SKU-${item.slice(0, 8)}`,
        unit_price: 99.5, sell_price: 99.5, track_inventory: true, brand_id: brand.id, vendor_id: vendor.id,
      },
    });
    const location = randomUUID();
    await db.inventoryLocation.create({ data: { id: location, organization_id: org, name: 'Back shelf', type: 'warehouse' } });
    // A minimum above what is on hand puts the item on the low-stock list.
    await db.stockBalance.create({ data: { organization_id: org, item_id: item, location_id: location, on_hand: 1, min: 5 } });
    return { ...made, item, vendor: vendor.id, brand: brand.id };
  }

  /** A person on a custom role made from blank, holding View stock and View price book plus these switches. */
  async function personWith(org: string, values: Record<string, boolean> = {}) {
    const key = `vendor-fields-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { [VIEW_STOCK]: true, [VIEW_PRICE_BOOK]: true, see_prices: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `vf${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  /** Every route whose answer can carry an item's vendor name or a vendor id, with a way to find the item or brand in it. */
  const reads: { name: string; path: (w: { item: string }) => string; carried: (body: any, w: { vendor: string }) => boolean }[] = [
    {
      name: 'stock item list',
      path: () => '/api/inventory/items',
      carried: (b) => b.data[0].vendor === VENDOR_NAME,
    },
    {
      name: 'stock item detail',
      path: ({ item }) => `/api/inventory/items/${item}`,
      carried: (b) => b.item.vendor === VENDOR_NAME,
    },
    {
      name: 'low-stock list',
      path: () => '/api/inventory/low-stock',
      carried: (b, w) => b.data[0].vendorName === VENDOR_NAME && b.data[0].vendorId === w.vendor,
    },
    {
      name: 'brand list',
      path: () => '/api/inventory/brands',
      carried: (b, w) => b.brands[0].defaultVendorId === w.vendor,
    },
    {
      name: 'price book item list',
      path: () => '/api/price-book/items',
      carried: (b, w) => b.data[0].vendor_id === w.vendor,
    },
    {
      name: 'price book item detail',
      path: ({ item }) => `/api/price-book/items/${item}`,
      carried: (b, w) => b.data.vendor_id === w.vendor,
    },
    {
      name: 'price book catalog list',
      path: () => '/api/price-book/catalog-items',
      carried: (b) => b.data[0].vendor === VENDOR_NAME,
    },
  ];

  describe.each(reads)('$name', ({ path, carried }) => {
    it('carries no vendor name and no vendor id without View vendors', async () => {
      const w = await world();
      const api = await personWith(w.org);
      const res = await api.get(path(w));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(VENDOR_NAME);
      expect(text).not.toContain(w.vendor);
      // The key itself is gone, not sent empty.
      expect(text).not.toMatch(/"(vendor|vendorId|vendorName|vendor_id|defaultVendorId)"/);
    });

    it('carries them with View vendors', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_VENDORS]: true });
      const res = await api.get(path(w));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(carried(res.body, w)).toBe(true);
    });
  });

  describe('write answers', () => {
    it('brand save answers with no default vendor id without View vendors, and keeps the stored one', async () => {
      const w = await world();
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true });
      const res = await api.post('/api/price-book/brands', { id: w.brand, name: 'Brandy renamed' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(w.vendor);
      // Saving a brand from a form that has no vendor field must not clear the vendor the office set.
      const stored = await db.brand.findUniqueOrThrow({ where: { id: w.brand } });
      expect(stored.name).toBe('Brandy renamed');
      expect(stored.default_vendor_id).toBe(w.vendor);
    });

    it('brand save ignores a default vendor sent without View vendors', async () => {
      const w = await world();
      const other = await db.vendor.create({ data: { organization_id: w.org, name: 'Other Supply', category: 'Hardware' } });
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true });
      const res = await api.post('/api/price-book/brands', { id: w.brand, name: 'Brandy', defaultVendorId: other.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const stored = await db.brand.findUniqueOrThrow({ where: { id: w.brand } });
      expect(stored.default_vendor_id).toBe(w.vendor);
    });

    it('brand save keeps changing the default vendor with View vendors', async () => {
      const w = await world();
      const other = await db.vendor.create({ data: { organization_id: w.org, name: 'Other Supply', category: 'Hardware' } });
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true, [VIEW_VENDORS]: true });
      const res = await api.post('/api/price-book/brands', { id: w.brand, name: 'Brandy', defaultVendorId: other.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.brand.defaultVendorId).toBe(other.id);
    });

    it('item edit answers with no vendor id without View vendors, and keeps the stored vendor even when one is sent', async () => {
      const w = await world();
      const other = await db.vendor.create({ data: { organization_id: w.org, name: 'Other Supply', category: 'Hardware' } });
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true });
      const res = await api.patch(`/api/price-book/items/${w.item}`, { name: 'Renamed hinge', vendor_id: other.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(w.vendor);
      expect(JSON.stringify(res.body)).not.toContain(other.id);
      const stored = await db.priceBookItem.findUniqueOrThrow({ where: { id: w.item } });
      expect(stored.name).toBe('Renamed hinge');
      expect(stored.vendor_id).toBe(w.vendor);
    });

    it('item create answers with no vendor id and stores none without View vendors', async () => {
      const w = await world();
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true });
      const res = await api.post('/api/price-book/items', { name: 'New hinge', unit_price: 5, vendor_id: w.vendor });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain(w.vendor);
      const stored = await db.priceBookItem.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(stored.vendor_id).toBeNull();
    });

    it('item edit and create keep the vendor id with View vendors', async () => {
      const w = await world();
      const api = await personWith(w.org, { [EDIT_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true, [VIEW_VENDORS]: true });
      const edited = await api.patch(`/api/price-book/items/${w.item}`, { name: 'Renamed hinge' });
      expect(edited.body.data.vendor_id).toBe(w.vendor);
      const created = await api.post('/api/price-book/items', { name: 'New hinge', unit_price: 5, vendor_id: w.vendor });
      expect(created.body.data.vendor_id).toBe(w.vendor);
    });
  });
});
