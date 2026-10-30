/* =============================================================================
   Ticket 35 (round 4), the write side of "See prices": every price column the Price Book writes is stripped on the way OUT for a
   person without See prices, so the form they save holds none of it. A save they make therefore must not change a stored price
   (a group save replaces every line, and a price-blind form sends none): the stored flat rate, line prices and item prices stay,
   a price sent is ignored, and a new row starts without one. The same for a CSV import. With See prices nothing changes.

   Also a source-driven table: every Decimal column the filter calls a price on the Price Book's models is listed in
   PRICE_BOOK_PRICE_COLUMNS, and the table lists nothing else, so a new price column fails here until it is handled.

   Everything goes through the routes, called as a person on a custom role made from blank. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { PRICE_BOOK_PRICE_COLUMNS } from '../lib/permissions/priceWrites';
import { isPriceField, isCostField } from '../lib/permissions/prices';

const suite = realClient ? describe : describe.skip;
const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const VIEW_PRICE_BOOK = keyOf('View price book');
const CREATE_PRICE_BOOK = keyOf('Create price book items');
const EDIT_PRICE_BOOK = keyOf('Edit price book items');

/** Figures nothing else on the test records can equal. */
const ITEM_PRICE = 99.5;
const ITEM_LIST = 120.25;
const FLAT_RATE = 400.4;
const LINE_PRICE_A = 20.2;
const LINE_PRICE_B = 75.75;

describe('M4 (ticket 35): the price columns a Price Book save writes are a source-driven table', () => {
  const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const decimalColumns = (model: string): string[] => {
    const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)?.[1] ?? '';
    return block.split('\n').map((l) => /^\s{2}([a-z_]+)\s+Decimal\??\b/.exec(l)?.[1]).filter((c): c is string => !!c);
  };
  for (const [model, listed] of Object.entries(PRICE_BOOK_PRICE_COLUMNS)) {
    it(`${model}: the listed price columns are exactly the Decimal columns the filter calls a price`, () => {
      const prices = decimalColumns(model).filter((c) => isPriceField('/api/price-book/items', c));
      expect([...listed].sort()).toEqual(prices.sort());
      // A cost is the other class (canSeeCosts) and is never in this table.
      for (const c of listed) expect(isCostField('/api/price-book/items', c), c).toBe(false);
    });
  }
});

suite('a person without See prices cannot change a stored Price Book price (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['item_groups', 'price_book_items']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const org = made.org;
    const item = randomUUID();
    await db.priceBookItem.create({
      data: { id: item, organization_id: org, name: 'Ball bearing hinge', sku: `SKU-${item.slice(0, 8)}`, unit_price: ITEM_PRICE, sell_price: ITEM_PRICE, list_price: ITEM_LIST },
    });
    const group = await db.itemGroup.create({
      data: {
        organization_id: org, name: 'Starter kit', group_type: 'flat_rate', flat_rate_price_override: FLAT_RATE,
        lines: {
          create: [
            { organization_id: org, item_id: item, name: 'Hinge', quantity: 2, price_override: LINE_PRICE_A },
            { organization_id: org, name: 'Dispatch fee', quantity: 1, price_override: LINE_PRICE_B },
          ],
        },
      },
    });
    return { ...made, item, group: group.id };
  }

  async function personWith(org: string, seesPrices: boolean) {
    const key = `price-writes-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { [VIEW_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true, [EDIT_PRICE_BOOK]: true, see_prices: seesPrices },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `pw${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  const linePrices = async (group: string) =>
    (await db.itemGroupLine.findMany({ where: { group_id: group } }))
      .map((l) => (l.price_override == null ? null : Number(l.price_override)))
      .sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const flatRate = async (group: string) => {
    const g = await db.itemGroup.findUniqueOrThrow({ where: { id: group } });
    return g.flat_rate_price_override == null ? null : Number(g.flat_rate_price_override);
  };
  const itemPrices = async (id: string) => {
    const i = await db.priceBookItem.findUniqueOrThrow({ where: { id } });
    return { unit: Number(i.unit_price), sell: i.sell_price == null ? null : Number(i.sell_price), list: i.list_price == null ? null : Number(i.list_price), name: i.name };
  };

  describe('bundles', () => {
    it('saving a bundle from the price-blind read keeps the flat rate and every line price', async () => {
      const { org, group } = await world();
      const api = await personWith(org, false);
      const read = (await api.get('/api/inventory/item-groups')).body.itemGroups[0];
      expect(JSON.stringify(read)).not.toContain(String(FLAT_RATE));
      const res = await api.post('/api/price-book/item-groups', { ...read, name: 'Renamed kit' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await db.itemGroup.findUniqueOrThrow({ where: { id: group } })).name).toBe('Renamed kit');
      expect(await flatRate(group)).toBe(FLAT_RATE);
      expect(await linePrices(group)).toEqual([LINE_PRICE_A, LINE_PRICE_B]);
    });

    it('keeps the stored price of a line sent without its id (matched on item and name), and ignores a price sent', async () => {
      const { org, group, item } = await world();
      const api = await personWith(org, false);
      const res = await api.post('/api/price-book/item-groups', {
        id: group, name: 'Starter kit', groupType: 'flat_rate', flatRatePriceOverride: 888.88,
        lines: [
          { itemId: item, name: 'Hinge', quantity: 3, priceOverride: 999.99 },
          { name: 'Dispatch fee', quantity: 1, priceOverride: 1.11 },
          { name: 'Brand new line', quantity: 1, priceOverride: 777.77 },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await flatRate(group)).toBe(FLAT_RATE);
      expect(await linePrices(group)).toEqual([LINE_PRICE_A, LINE_PRICE_B, null]);
    });

    it('creating a bundle with prices stores none', async () => {
      const { org } = await world();
      const api = await personWith(org, false);
      const res = await api.post('/api/price-book/item-groups', {
        name: 'New kit', groupType: 'flat_rate', flatRatePriceOverride: 555.55,
        lines: [{ name: 'Part', quantity: 1, priceOverride: 10 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await flatRate(res.body.itemGroup.id)).toBeNull();
      expect(await linePrices(res.body.itemGroup.id)).toEqual([null]);
    });

    it('with See prices the prices are saved as before', async () => {
      const { org, group } = await world();
      const api = await personWith(org, true);
      const read = (await api.get('/api/inventory/item-groups')).body.itemGroups[0];
      const lines = read.lines.map((l: { priceOverride: number }) => ({ ...l, priceOverride: l.priceOverride + 1 }));
      const res = await api.post('/api/price-book/item-groups', { ...read, flatRatePriceOverride: 500, lines });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await flatRate(group)).toBe(500);
      expect(await linePrices(group)).toEqual([LINE_PRICE_A + 1, LINE_PRICE_B + 1]);
    });
  });

  describe('items', () => {
    const newItem = (extra: object = {}) => ({ name: 'Fresh item', sku: `NEW-${randomUUID().slice(0, 8)}`, ...extra });

    it('updating an item leaves the stored prices alone whatever is sent', async () => {
      const { org, item } = await world();
      const api = await personWith(org, false);
      for (const prices of [{}, { unit_price: 1.11, sell_price: 2.22, list_price: 3.33 }, { sell_price: 4.44 }, { unit_price: 5.55 }, { list_price: null, sell_price: null }]) {
        const res = await api.patch(`/api/price-book/items/${item}`, { name: `Renamed ${JSON.stringify(prices).length}`, ...prices });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      expect(await itemPrices(item)).toMatchObject({ unit: ITEM_PRICE, sell: ITEM_PRICE, list: ITEM_LIST });
      expect((await itemPrices(item)).name).toMatch(/^Renamed /);
    });

    it('creating an item with no price works and starts at 0; a price sent is ignored', async () => {
      const { org } = await world();
      const api = await personWith(org, false);
      for (const extra of [{}, { unit_price: 10, sell_price: 12, list_price: 15 }]) {
        const res = await api.post('/api/price-book/items', newItem(extra));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await itemPrices(res.body.data.id)).toMatchObject({ unit: 0, sell: 0, list: null });
      }
    });

    it('with See prices the prices are stored as before, and a price is still required to create an item', async () => {
      const { org, item } = await world();
      const api = await personWith(org, true);
      const created = await api.post('/api/price-book/items', newItem({ unit_price: 10, list_price: 15 }));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(await itemPrices(created.body.data.id)).toMatchObject({ unit: 10, sell: 10, list: 15 });
      const refused = await api.post('/api/price-book/items', newItem());
      expect(refused.status).toBe(400);
      const updated = await api.patch(`/api/price-book/items/${item}`, { sell_price: 4.44 });
      expect(updated.status).toBe(200);
      expect(await itemPrices(item)).toMatchObject({ unit: 4.44, sell: 4.44 });
    });

    it('a CSV import keeps the price of an existing row and starts a new row at 0, whatever the file says', async () => {
      const { org, item } = await world();
      const api = await personWith(org, false);
      const existing = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      const sku = `IMP-${randomUUID().slice(0, 8)}`;
      const res = await api.post('/api/price-book/items/import', {
        items: [
          { sku: existing.sku, name: 'Imported rename', sellPrice: 50 },
          { sku, name: 'Imported new', sellPrice: 60 },
          { sku: `${sku}-b`, name: 'Imported without a price column' },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ created: 2, updated: 1 });
      expect(await itemPrices(item)).toMatchObject({ name: 'Imported rename', unit: ITEM_PRICE, sell: ITEM_PRICE });
      const fresh = await db.priceBookItem.findFirstOrThrow({ where: { organization_id: org, sku } });
      expect([Number(fresh.unit_price), Number(fresh.sell_price)]).toEqual([0, 0]);
    });

    it('a CSV import with See prices stores the price as before', async () => {
      const { org, item } = await world();
      const api = await personWith(org, true);
      const existing = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      const res = await api.post('/api/price-book/items/import', { items: [{ sku: existing.sku, name: 'Imported rename', sellPrice: 50 }] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await itemPrices(item)).toMatchObject({ unit: 50, sell: 50 });
    });
  });
});
