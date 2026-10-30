/* =============================================================================
   Roles & Permissions, PRD 1 (costs, prices and company figures) and PRD 7 (View price book alone never
   reaches stock): the Price Book's item-group lines, brands, items and CSV import keep cost data - unit
   cost, a group line's cost, a brand's default markup - away from a person without See costs, on
   the way OUT and on the way IN.

   Out: the key is left out of the answer (never zero, never null). In: a cost or markup SENT by such a person
   is ignored, and a save they make never wipes a cost that is already stored (the browser holds none of it,
   so a delete-and-recreate of the lines would otherwise blank every line cost). The answers to creating or
   changing an item carry no serial numbers or stock fields without View stock.

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
const CREATE_PRICE_BOOK = keyOf('Create price book items');
const EDIT_PRICE_BOOK = keyOf('Edit price book items');
const SEE_FINANCIAL_DATA = keyOf('See costs');

/** Figures nothing else on the test records can equal. */
const LINE_COST_A = 12.34;
const LINE_COST_B = 5.67;
const ITEM_COST = 41.37;
const BRAND_MARKUP = 1.43;
const SERIAL = 'SER-ONLY-IN-STOCK-7788';

/** Every key a stock-side field can travel under. */
const STOCK_KEYS = ['stock', 'stock_balances', 'stockBalances', 'onHand', 'on_hand', 'reserved', 'serials'];

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

suite('the Price Book keeps cost data from a person without See costs (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['item_groups', 'price_book_items', 'brands', 'price_book_categories']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company with a costed item, a brand with a markup and a group whose two lines carry costs. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const org = made.org;
    const brand = await db.brand.create({ data: { organization_id: org, name: 'Brandy', default_markup_pct: BRAND_MARKUP } });
    const item = randomUUID();
    await db.priceBookItem.create({
      data: {
        id: item, organization_id: org, name: 'Ball bearing hinge', sku: `SKU-${item.slice(0, 8)}`,
        unit_price: 99.5, sell_price: 99.5, unit_cost: ITEM_COST, serials: [SERIAL],
      },
    });
    const group = await db.itemGroup.create({
      data: {
        organization_id: org, name: 'Starter kit', group_type: 'individual',
        lines: {
          create: [
            { organization_id: org, item_id: item, name: 'Hinge', quantity: 2, price_override: 20, cost_override: LINE_COST_A },
            { organization_id: org, name: 'Dispatch fee', quantity: 1, price_override: 75, cost_override: LINE_COST_B },
          ],
        },
      },
    });
    return { ...made, item, brand: brand.id, group: group.id };
  }

  /** A person on a custom role made from blank, holding exactly these switches (View, Create and Edit price book unless told otherwise). */
  async function personWith(org: string, values: Record<string, boolean> = {}) {
    const key = `price-book-cost-leaks-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { [VIEW_PRICE_BOOK]: true, [CREATE_PRICE_BOOK]: true, [EDIT_PRICE_BOOK]: true, see_prices: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `pbc${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  const storedLines = (group: string) =>
    db.itemGroupLine.findMany({ where: { group_id: group }, orderBy: { created_at: 'asc' } });
  const costsOf = async (group: string) =>
    (await storedLines(group)).map((l) => (l.cost_override == null ? null : Number(l.cost_override)))
      .sort((a, b) => (a ?? Infinity) - (b ?? Infinity));

  describe('item groups', () => {
    it('the list answer carries no line cost without See costs, and carries it with', async () => {
      const { org } = await world();
      const without = (await (await personWith(org)).get('/api/inventory/item-groups')).body;
      expect(without.itemGroups[0].lines).toHaveLength(2);
      expect(allKeys(without).has('costOverride')).toBe(false);
      expect(JSON.stringify(without)).not.toContain(String(LINE_COST_A));

      const withCosts = (await (await personWith(org, { [SEE_FINANCIAL_DATA]: true })).get('/api/inventory/item-groups')).body;
      const costs = withCosts.itemGroups[0].lines.map((l: { costOverride: number }) => l.costOverride).sort((a: number, b: number) => a - b);
      expect(costs).toEqual([LINE_COST_B, LINE_COST_A]);
    });

    it('saving a group from the stripped read keeps every stored line cost, and the answer carries none', async () => {
      const { org, group } = await world();
      const api = await personWith(org);
      const read = (await api.get('/api/inventory/item-groups')).body.itemGroups[0];
      const res = await api.post('/api/price-book/item-groups', { ...read, name: 'Renamed kit' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(allKeys(res.body).has('costOverride')).toBe(false);
      expect((await db.itemGroup.findUniqueOrThrow({ where: { id: group } })).name).toBe('Renamed kit');
      expect(await costsOf(group)).toEqual([LINE_COST_B, LINE_COST_A]);
    });

    it('keeps the stored cost of a line the browser sent without its id (matched on item and name)', async () => {
      const { org, group, item } = await world();
      const api = await personWith(org);
      const res = await api.post('/api/price-book/item-groups', {
        id: group, name: 'Starter kit', groupType: 'individual',
        lines: [
          { itemId: item, name: 'Hinge', quantity: 3, priceOverride: 20 },
          { name: 'Dispatch fee', quantity: 1, priceOverride: 80 },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await costsOf(group)).toEqual([LINE_COST_B, LINE_COST_A]);
    });

    it('ignores a cost sent on a line: an existing line keeps its cost and a new line gets none', async () => {
      const { org, group } = await world();
      const api = await personWith(org);
      const read = (await api.get('/api/inventory/item-groups')).body.itemGroups[0];
      const lines = read.lines.map((l: object) => ({ ...l, costOverride: 999.99 }));
      lines.push({ name: 'Brand new line', quantity: 1, priceOverride: 10, costOverride: 888.88 });
      const res = await api.post('/api/price-book/item-groups', { ...read, lines });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await costsOf(group)).toEqual([LINE_COST_B, LINE_COST_A, null]);
      expect(JSON.stringify(await storedLines(group))).not.toContain('999.99');
    });

    it('creating a group with line costs stores none', async () => {
      const { org } = await world();
      const api = await personWith(org);
      const res = await api.post('/api/price-book/item-groups', {
        name: 'New kit', groupType: 'individual',
        lines: [{ name: 'Part', quantity: 1, priceOverride: 10, costOverride: 777.77 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(allKeys(res.body).has('costOverride')).toBe(false);
      expect(await costsOf(res.body.itemGroup.id)).toEqual([null]);
    });

    it('with See costs the cost is returned and saved as before', async () => {
      const { org, group } = await world();
      const api = await personWith(org, { [SEE_FINANCIAL_DATA]: true });
      const read = (await api.get('/api/inventory/item-groups')).body.itemGroups[0];
      const lines = read.lines.map((l: { costOverride: number }) => ({ ...l, costOverride: l.costOverride + 1 }));
      const res = await api.post('/api/price-book/item-groups', { ...read, lines });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.itemGroup.lines.map((l: { costOverride: number }) => l.costOverride).sort((a: number, b: number) => a - b))
        .toEqual([LINE_COST_B + 1, LINE_COST_A + 1]);
      expect(await costsOf(group)).toEqual([LINE_COST_B + 1, LINE_COST_A + 1]);
    });
  });

  describe('brands', () => {
    it('the read carries no default markup without See costs, and carries it with', async () => {
      const { org } = await world();
      const without = (await (await personWith(org)).get('/api/inventory/brands')).body;
      expect(without.brands).toHaveLength(1);
      expect(allKeys(without).has('defaultMarkupPct')).toBe(false);
      const withCosts = (await (await personWith(org, { [SEE_FINANCIAL_DATA]: true })).get('/api/inventory/brands')).body;
      expect(withCosts.brands[0].defaultMarkupPct).toBe(BRAND_MARKUP);
    });

    it('a save keeps the stored markup and ignores one sent; the answer carries none', async () => {
      const { org, brand } = await world();
      const api = await personWith(org);
      const kept = await api.post('/api/price-book/brands', { id: brand, name: 'Brandy Two' });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(allKeys(kept.body).has('defaultMarkupPct')).toBe(false);
      const sent = await api.post('/api/price-book/brands', { id: brand, name: 'Brandy Three', defaultMarkupPct: 9 });
      expect(sent.status).toBe(200);
      const stored = await db.brand.findUniqueOrThrow({ where: { id: brand } });
      expect(stored.name).toBe('Brandy Three');
      expect(Number(stored.default_markup_pct)).toBe(BRAND_MARKUP);
    });

    it('creating a brand with a markup stores none', async () => {
      const { org } = await world();
      const api = await personWith(org);
      const res = await api.post('/api/price-book/brands', { name: 'Fresh', defaultMarkupPct: 3 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(allKeys(res.body).has('defaultMarkupPct')).toBe(false);
      const stored = await db.brand.findUniqueOrThrow({ where: { id: res.body.brand.id } });
      expect(stored.default_markup_pct).toBeNull();
    });

    it('with See costs the markup is saved as before', async () => {
      const { org, brand } = await world();
      const api = await personWith(org, { [SEE_FINANCIAL_DATA]: true });
      const res = await api.post('/api/price-book/brands', { id: brand, name: 'Brandy', defaultMarkupPct: 1.9 });
      expect(res.status).toBe(200);
      expect(res.body.brand.defaultMarkupPct).toBe(1.9);
      expect(Number((await db.brand.findUniqueOrThrow({ where: { id: brand } })).default_markup_pct)).toBe(1.9);
    });
  });

  describe('items', () => {
    const newItem = (extra: object = {}) => ({ name: 'Fresh item', unit_price: 10, sku: `NEW-${randomUUID().slice(0, 8)}`, ...extra });

    it('creating an item with a unit cost stores none, and the answer has no cost, serials or stock key', async () => {
      const { org } = await world();
      const api = await personWith(org);
      const res = await api.post('/api/price-book/items', newItem({ unit_cost: 55.55 }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const keys = allKeys(res.body);
      for (const k of [...STOCK_KEYS, 'unit_cost', 'unitCost']) expect(keys.has(k), k).toBe(false);
      expect((await db.priceBookItem.findUniqueOrThrow({ where: { id: res.body.data.id } })).unit_cost).toBeNull();
    });

    it('updating an item leaves the stored cost alone whatever is sent, and the answer has no cost, serials or stock key', async () => {
      const { org, item } = await world();
      const api = await personWith(org);
      for (const unit_cost of [1.11, null]) {
        const res = await api.patch(`/api/price-book/items/${item}`, { name: `Renamed ${unit_cost}`, unit_cost });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const keys = allKeys(res.body);
        for (const k of [...STOCK_KEYS, 'unit_cost', 'unitCost']) expect(keys.has(k), k).toBe(false);
      }
      const stored = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      expect(Number(stored.unit_cost)).toBe(ITEM_COST);
      expect(stored.name).toBe('Renamed null');
    });

    it('with See costs the cost is stored and returned as before', async () => {
      const { org, item } = await world();
      const api = await personWith(org, { [SEE_FINANCIAL_DATA]: true });
      const created = await api.post('/api/price-book/items', newItem({ unit_cost: 55.55 }));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(Number(created.body.data.unit_cost)).toBe(55.55);
      const updated = await api.patch(`/api/price-book/items/${item}`, { unit_cost: 2.22 });
      expect(Number(updated.body.data.unit_cost)).toBe(2.22);
      expect(Number((await db.priceBookItem.findUniqueOrThrow({ where: { id: item } })).unit_cost)).toBe(2.22);
    });

    it('a CSV import by such a person stores no cost on a new row and keeps the cost of an existing one', async () => {
      const { org, item } = await world();
      const api = await personWith(org);
      const existing = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      const sku = `IMP-${randomUUID().slice(0, 8)}`;
      const res = await api.post('/api/price-book/items/import', {
        items: [
          { sku: existing.sku, name: 'Imported rename', sellPrice: 50, unitCost: 3.33 },
          { sku, name: 'Imported new', sellPrice: 50, unitCost: 4.44 },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ created: 1, updated: 1 });
      const renamed = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      expect(renamed.name).toBe('Imported rename');
      expect(Number(renamed.unit_cost)).toBe(ITEM_COST);
      expect((await db.priceBookItem.findFirstOrThrow({ where: { organization_id: org, sku } })).unit_cost).toBeNull();
    });

    it('a CSV import with See costs stores the cost as before', async () => {
      const { org, item } = await world();
      const api = await personWith(org, { [SEE_FINANCIAL_DATA]: true });
      const existing = await db.priceBookItem.findUniqueOrThrow({ where: { id: item } });
      const res = await api.post('/api/price-book/items/import', {
        items: [{ sku: existing.sku, name: 'Imported rename', sellPrice: 50, unitCost: 3.33 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Number((await db.priceBookItem.findUniqueOrThrow({ where: { id: item } })).unit_cost)).toBe(3.33);
    });
  });
});
