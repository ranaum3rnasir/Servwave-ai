/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.19 - the Purchase Orders and Vendors endpoints follow their switches and
   See financial data.

   Without See financial data a purchase order answer carries no amount (no line cost, no catalog cost, no
   material-cost roll-up) and a vendor answer carries no account number, on every route that can carry one, reads
   and write answers alike. A person without View purchase orders gets no purchase-order data at all. Edit vendors
   guards the vendor update, which rides the same upsert route as Create vendors.

   Everything goes through the public interface: the routes, called as a person on a custom role made from blank
   and holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
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

// The suite-wide setup hands every record the same number; these cases create several records in one company.
vi.mock('../lib/numbering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/numbering')>();
  let issued = 0;
  const next = (kind: string) => `${kind.slice(0, 2).toUpperCase()}T${Date.now()}${++issued}`;
  return {
    ...actual,
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => next(entity)),
    allocateAnchoredNumber: vi.fn(async (_tx: unknown, args: { anchorTable: string }) => ({ number: next(args.anchorTable), seq: ++issued })),
  };
});

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const VIEW_PO = keyOf('View purchase orders');
const CREATE_PO = keyOf('Create purchase orders');
const EDIT_PO = keyOf('Edit purchase orders');
const VIEW_VENDORS = keyOf('View vendors');
const CREATE_VENDORS = keyOf('Create vendors');
const EDIT_VENDORS = keyOf('Edit vendors');
const SEE_FINANCIAL = keyOf('See financial data');
const VIEW_JOBS = keyOf('View jobs');
const JOBS_SCOPE = 'jobs_scope';

const ACCOUNT = 'ACCT-4471';
// Distinct figures so a leak of either one is found by value, not only by key.
const LINE_COST = 18.37;
const CATALOG_COST = 20.41;

suite('purchase orders and vendors follow their switches and See financial data (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of [
        'stock_movements', 'stock_balances', 'inventory_locations', 'purchase_order_lines', 'purchase_orders',
        'price_book_items', 'vendor_contacts', 'vendors',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company with a vendor (account number set), a catalog item with a cost, and a draft order on a job. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const org = made.org;
    const job = await fx.addJob(org, made.customer);
    const vendor = await db.vendor.create({ data: { organization_id: org, name: 'Supply Co', category: 'Hardware', account_number: ACCOUNT } });
    const item = await db.priceBookItem.create({
      data: {
        organization_id: org, name: 'Deadbolt', sku: `SKU-${org.slice(0, 6)}`, type: 'MATERIAL', kind: 'material',
        unit_cost: CATALOG_COST, unit_price: 80, sell_price: 90, track_inventory: true, vendor_id: vendor.id,
      },
    });
    const location = await db.inventoryLocation.create({ data: { organization_id: org, name: 'Back shelf', type: 'warehouse' } });
    // A minimum above what is on hand puts the item on the low-stock proposals.
    await db.stockBalance.create({ data: { organization_id: org, item_id: item.id, location_id: location.id, on_hand: 1, min: 5 } });
    const po = await db.purchaseOrder.create({
      data: { organization_id: org, po_number: `PO-${org.slice(0, 6)}`, vendor: 'Supply Co', vendor_id: vendor.id, status: 'draft', job_id: job.id },
    });
    const line = await db.purchaseOrderLine.create({
      data: {
        organization_id: org, purchase_order_id: po.id, item_sku: item.sku!, item_name: item.name, uom: 'EA',
        qty_ordered: 4, qty_received: 0, unit_cost: LINE_COST, price_book_item_id: item.id,
      },
    });
    return { ...made, job: job.id, vendor: vendor.id, item, po: po.id, line: line.id, location: location.id };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A person on a custom role made from blank holding exactly these switch values, with Jobs scope All. */
  async function personWith(org: string, values: Record<string, boolean>) {
    const key = `purchasing-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { [JOBS_SCOPE]: 'all', ...values } as Record<string, boolean | string>,
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `pu${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  const LINE_COST_TEXT = String(LINE_COST);
  const CATALOG_COST_TEXT = String(CATALOG_COST);
  const noAmounts = (body: unknown) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(LINE_COST_TEXT);
    expect(text).not.toContain(CATALOG_COST_TEXT);
    expect(text).not.toMatch(/"(unitCost|catalogUnitCost|materialCost|unit_cost)"/);
  };

  describe('purchase order amounts need See financial data', () => {
    const reads: { name: string; path: (w: World) => string; carries: (body: any) => boolean }[] = [
      { name: 'the list', path: () => '/api/inventory/purchase-orders', carries: (b) => b.purchaseOrders[0].lines[0].unitCost === LINE_COST && b.purchaseOrders[0].lines[0].catalogUnitCost === CATALOG_COST },
      { name: 'the detail', path: (w) => `/api/inventory/purchase-orders/${w.po}`, carries: (b) => b.purchaseOrder.lines[0].unitCost === LINE_COST && b.purchaseOrder.lines[0].catalogUnitCost === CATALOG_COST },
      { name: 'the low-stock proposals', path: () => '/api/inventory/purchase-orders/low-stock-proposals', carries: (b) => b.proposals[0].lines[0].unitCost === CATALOG_COST },
      { name: "a job's material cost", path: (w) => `/api/inventory/jobs/${w.job}/material-cost`, carries: (b) => b.materialCost === 0 || b.materialCost > 0 },
    ];

    describe.each(reads)('$name', ({ path, carries }) => {
      it('carries no amount without See financial data, and still answers', async () => {
        const w = await world();
        const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true });
        const res = await api.get(path(w));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        noAmounts(res.body);
      });

      it('carries the amounts with it', async () => {
        const w = await world();
        const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [SEE_FINANCIAL]: true });
        const res = await api.get(path(w));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(carries(res.body), JSON.stringify(res.body)).toBe(true);
      });
    });

    it('answers a create, an edit and a mark-ordered with no amount, and stores no cost a blind person sent', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [CREATE_PO]: true, [EDIT_PO]: true });

      const created = await api.post('/api/inventory/purchase-orders', {
        vendorId: w.vendor, jobId: w.job,
        lines: [{ itemSku: w.item.sku, itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2, unitCost: 99.13, priceBookItemId: w.item.id }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      noAmounts(created.body);
      expect(JSON.stringify(created.body)).not.toContain('99.13');
      const createdLine = await db.purchaseOrderLine.findFirstOrThrow({ where: { purchase_order_id: created.body.purchaseOrder.id } });
      expect(createdLine.unit_cost).toBeNull();

      const marked = await api.post(`/api/inventory/purchase-orders/${created.body.purchaseOrder.id}/mark-ordered`, {});
      expect(marked.status, JSON.stringify(marked.body)).toBe(200);
      noAmounts(marked.body);

      const edited = await api.patch(`/api/inventory/purchase-orders/${w.po}`, { notes: 'Call ahead' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      noAmounts(edited.body);
    });

    it("keeps a line's stored cost when a blind person edits the draft's lines, and ignores a cost they send", async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [EDIT_PO]: true });
      // The edit form sends the lines it was shown: no cost on them.
      const edited = await api.patch(`/api/inventory/purchase-orders/${w.po}`, {
        lines: [{ itemSku: w.item.sku, itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 6, priceBookItemId: w.item.id }],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      noAmounts(edited.body);
      const [kept] = await db.purchaseOrderLine.findMany({ where: { purchase_order_id: w.po } });
      expect(Number(kept!.qty_ordered)).toBe(6);
      expect(Number(kept!.unit_cost)).toBe(LINE_COST);

      // A cost sent anyway is not stored.
      const planted = await api.patch(`/api/inventory/purchase-orders/${w.po}`, {
        lines: [{ itemSku: w.item.sku, itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 6, unitCost: 1, priceBookItemId: w.item.id }],
      });
      expect(planted.status, JSON.stringify(planted.body)).toBe(200);
      const [after] = await db.purchaseOrderLine.findMany({ where: { purchase_order_id: w.po } });
      expect(Number(after!.unit_cost)).toBe(LINE_COST);
    });

    it('keeps every surviving line\'s cost through a rename, a reorder, a quantity change, an added and a removed line', async () => {
      const w = await world();
      // Three uncatalogued lines, each with its own cost, beside the catalogued one the world holds.
      const costs: Record<string, number> = { Hinge: 5.55, Strike: 6.66, Closer: 7.77 };
      for (const [name, cost] of Object.entries(costs)) {
        await db.purchaseOrderLine.create({
          data: { organization_id: w.org, purchase_order_id: w.po, item_sku: '', item_name: name, uom: 'EA', qty_ordered: 2, qty_received: 0, unit_cost: cost },
        });
      }
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [EDIT_PO]: true });
      // The edit form is seeded from the answer the person sees: the lines with their ids and no cost.
      const shown = (await api.get(`/api/inventory/purchase-orders/${w.po}`)).body.purchaseOrder.lines as Array<{ id: string; itemName: string; itemSku: string; uom: string; qtyOrdered: number; priceBookItemId?: string }>;
      const form = (name: string) => shown.find((l) => l.itemName === name)!;
      const sent = (l: typeof shown[number], over: Record<string, unknown> = {}) => ({
        id: l.id, itemSku: l.itemSku, itemName: l.itemName, uom: l.uom, qtyOrdered: l.qtyOrdered,
        ...(l.priceBookItemId ? { priceBookItemId: l.priceBookItemId } : {}), ...over,
      });

      // Reordered, one renamed, one with a new quantity, one removed (Closer), one added.
      const edited = await api.patch(`/api/inventory/purchase-orders/${w.po}`, {
        lines: [
          sent(form('Strike'), { itemName: 'Strike plate renamed' }),
          sent(form('Hinge'), { qtyOrdered: 9 }),
          sent(form('Deadbolt')),
          { itemSku: '', itemName: 'Brand new line', uom: 'EA', qtyOrdered: 1 },
        ],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      noAmounts(edited.body);

      const rows = await db.purchaseOrderLine.findMany({ where: { purchase_order_id: w.po } });
      const costOf = (name: string) => rows.find((r) => r.item_name === name)?.unit_cost;
      expect(Number(costOf('Strike plate renamed'))).toBe(6.66);
      expect(Number(costOf('Hinge'))).toBe(5.55);
      expect(Number(costOf('Deadbolt'))).toBe(LINE_COST);
      expect(costOf('Brand new line')).toBeNull();
      expect(rows.find((r) => r.item_name === 'Closer')).toBeUndefined();
      expect(rows).toHaveLength(4);

      // Read as the office: every surviving line still carries its cost.
      const office = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [SEE_FINANCIAL]: true });
      const seen = (await office.get(`/api/inventory/purchase-orders/${w.po}`)).body.purchaseOrder.lines as Array<{ itemName: string; unitCost?: number }>;
      expect(seen.find((l) => l.itemName === 'Strike plate renamed')!.unitCost).toBe(6.66);
      expect(seen.find((l) => l.itemName === 'Hinge')!.unitCost).toBe(5.55);
    });

    it('does not hand a stored cost to a line that carries another line\'s id twice or an id from elsewhere', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [EDIT_PO]: true });
      const edited = await api.patch(`/api/inventory/purchase-orders/${w.po}`, {
        lines: [
          { id: w.line, itemSku: w.item.sku, itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 1, priceBookItemId: w.item.id },
          { id: w.line, itemSku: '', itemName: 'Copy of the same line', uom: 'EA', qtyOrdered: 1 },
          { id: randomUUID(), itemSku: '', itemName: 'Stranger', uom: 'EA', qtyOrdered: 1 },
        ],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const rows = await db.purchaseOrderLine.findMany({ where: { purchase_order_id: w.po } });
      expect(Number(rows.find((r) => r.item_name === 'Deadbolt')!.unit_cost)).toBe(LINE_COST);
      expect(rows.find((r) => r.item_name === 'Copy of the same line')!.unit_cost).toBeNull();
      expect(rows.find((r) => r.item_name === 'Stranger')!.unit_cost).toBeNull();
    });

    it('lets a person with See financial data set and change line costs as before', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [EDIT_PO]: true, [SEE_FINANCIAL]: true });
      const edited = await api.patch(`/api/inventory/purchase-orders/${w.po}`, {
        lines: [{ itemSku: w.item.sku, itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 6, unitCost: 7.5, priceBookItemId: w.item.id }],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.purchaseOrder.lines[0].unitCost).toBe(7.5);
    });

    it('answers a receipt with no amount without See financial data', async () => {
      const w = await world();
      await db.purchaseOrder.update({ where: { id: w.po }, data: { status: 'ordered', ordered_at: new Date() } });
      const api = await personWith(w.org, { [VIEW_PO]: true, [VIEW_JOBS]: true, [EDIT_PO]: true });
      const res = await api.post('/api/inventory/purchase-orders/receive', {
        poId: w.po, destinationLocationId: w.location, lines: [{ lineId: w.line, qtyReceived: 1 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      noAmounts(res.body);
    });
  });

  describe('no purchase-order data without View purchase orders', () => {
    it('refuses every purchase-order read', async () => {
      const w = await world();
      // Everything else on: the only thing missing is the view.
      const api = await personWith(w.org, { [VIEW_VENDORS]: true, [VIEW_JOBS]: true, [SEE_FINANCIAL]: true });
      for (const path of [
        '/api/inventory/purchase-orders',
        `/api/inventory/purchase-orders/${w.po}`,
        `/api/inventory/purchase-orders/${w.po}/activity`,
        '/api/inventory/purchase-orders/low-stock-proposals',
        `/api/inventory/jobs/${w.job}/material-cost`,
      ]) {
        const res = await api.get(path);
        expect(res.status, path).toBe(403);
        expect(JSON.stringify(res.body), path).not.toContain('Supply Co');
      }
    });
  });

  describe('the vendor account number needs See financial data', () => {
    it('is on no vendor answer without it: list, detail, create and update', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_VENDORS]: true, [CREATE_VENDORS]: true, [EDIT_VENDORS]: true });

      const list = await api.get('/api/inventory/vendors');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.vendors.length).toBeGreaterThan(0);
      expect(JSON.stringify(list.body)).not.toContain(ACCOUNT);
      expect(JSON.stringify(list.body)).not.toContain('accountNumber');

      const detail = await api.get(`/api/inventory/vendors/${w.vendor}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(JSON.stringify(detail.body)).not.toContain(ACCOUNT);

      const created = await api.post('/api/inventory/vendors', { name: 'New Supply', accountNumber: 'ACCT-9' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain('ACCT-9');
      expect((await db.vendor.findUniqueOrThrow({ where: { id: created.body.vendor.id } })).account_number).toBeNull();

      const updated = await api.post('/api/inventory/vendors', { id: w.vendor, notes: 'Net 30', accountNumber: 'ACCT-PLANTED' });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(JSON.stringify(updated.body)).not.toContain(ACCOUNT);
      expect(JSON.stringify(updated.body)).not.toContain('ACCT-PLANTED');
      const stored = await db.vendor.findUniqueOrThrow({ where: { id: w.vendor } });
      expect(stored.account_number).toBe(ACCOUNT);
      expect(stored.notes).toBe('Net 30');
    });

    it('is on every vendor answer with it', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_VENDORS]: true, [CREATE_VENDORS]: true, [EDIT_VENDORS]: true, [SEE_FINANCIAL]: true });
      const list = await api.get('/api/inventory/vendors');
      expect(list.body.vendors.find((v: any) => v.id === w.vendor).accountNumber).toBe(ACCOUNT);
      const detail = await api.get(`/api/inventory/vendors/${w.vendor}`);
      expect(detail.body.vendor.accountNumber).toBe(ACCOUNT);
      const updated = await api.post('/api/inventory/vendors', { id: w.vendor, accountNumber: 'ACCT-NEW' });
      expect(updated.body.vendor.accountNumber).toBe('ACCT-NEW');
    });

    it('cannot be found by a request that names it', async () => {
      const w = await world();
      const blind = await personWith(w.org, { [VIEW_VENDORS]: true });
      // No vendor route filters by a query string, so a name or number in the query changes nothing: the answer
      // is the same list, with no number on it.
      for (const query of [`?search=${ACCOUNT}`, `?q=${ACCOUNT}`, `?accountNumber=${ACCOUNT}`]) {
        const res = await blind.get(`/api/inventory/vendors${query}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
      }
      // Signing in is global to the fixture: the second person signs in after the first is done.
      const sighted = await personWith(w.org, { [VIEW_VENDORS]: true, [SEE_FINANCIAL]: true });
      const sees = await sighted.get('/api/inventory/vendors');
      expect(JSON.stringify(sees.body)).toContain(ACCOUNT);
    });
  });

  describe('Edit vendors guards the vendor update', () => {
    it('refuses an update to a person who can only create, and lets a person who can edit', async () => {
      const w = await world();
      const creator = await personWith(w.org, { [VIEW_VENDORS]: true, [CREATE_VENDORS]: true });
      const refused = await creator.post('/api/inventory/vendors', { id: w.vendor, notes: 'changed by a creator' });
      expect(refused.status).toBe(403);
      expect((await db.vendor.findUniqueOrThrow({ where: { id: w.vendor } })).notes).toBeNull();

      const created = await creator.post('/api/inventory/vendors', { name: 'Creator Supply' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const editor = await personWith(w.org, { [VIEW_VENDORS]: true, [EDIT_VENDORS]: true });
      const ok = await editor.post('/api/inventory/vendors', { id: w.vendor, notes: 'changed by an editor' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await db.vendor.findUniqueOrThrow({ where: { id: w.vendor } })).notes).toBe('changed by an editor');

      // Editing is not creating: an editor cannot add a vendor through the same route.
      const noCreate = await editor.post('/api/inventory/vendors', { name: 'Editor Supply' });
      expect(noCreate.status).toBe(403);
    });
  });

  describe('vendor reads need View vendors', () => {
    it('refuses the vendor list, detail and categories to a person without it', async () => {
      const w = await world();
      const api = await personWith(w.org, { [VIEW_PO]: true, [SEE_FINANCIAL]: true });
      for (const path of ['/api/inventory/vendors', `/api/inventory/vendors/${w.vendor}`, '/api/inventory/vendor-categories']) {
        expect((await api.get(path)).status, path).toBe(403);
      }
    });
  });
});
