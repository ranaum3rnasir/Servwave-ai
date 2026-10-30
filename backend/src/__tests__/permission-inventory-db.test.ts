/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.9 - the Inventory group on switches: logistic-order create, submit and
   approval, the order-submitted alert, the van stock limit, the inventory view, and purchase-order reach.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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

import { switchFixture, type Person } from './permission-switches-fixture';
import type { Request } from 'express';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { resolveRestrictedVan } from '../controllers/inv-stock.controller';

const suite = realClient ? describe : describe.skip;

suite('the Inventory group follows switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of [
        'logistic_order_lines', 'logistic_orders', 'purchase_order_lines', 'purchase_orders',
        'stock_movements', 'stock_balances', 'inventory_locations', 'price_book_items', 'vendors', 'asset_events', 'assets',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /**
   * A person on a fresh custom role of this base holding exactly these switch values, with Jobs and Leads scope
   * All and the jobs, leads and logistic orders they can read unless the case says otherwise. Whatever the base,
   * no role name may decide anything.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `inventory-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, view_leads: true, view_logistic_orders: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  /** A tracked catalog item, a location and some stock of it, so an order can be made and processed. */
  async function addStockedItem(org: string) {
    const item = randomUUID();
    const location = randomUUID();
    await db.priceBookItem.create({
      data: { id: item, organization_id: org, name: `Hinge ${item.slice(0, 6)}`, sku: `SKU-${item.slice(0, 8)}`, unit_price: 10, track_inventory: true },
    });
    await db.inventoryLocation.create({ data: { id: location, organization_id: org, name: `Shelf ${location.slice(0, 6)}`, type: 'warehouse' } });
    await db.stockBalance.create({ data: { organization_id: org, item_id: item, location_id: location, on_hand: 100 } });
    return { item, location };
  }

  /** Make an order through the route, as the person, on the job. Returns the response body. */
  async function createOrderOn(api: Api, anchor: { job_id?: string; lead_id?: string }, stock: { item: string; location: string }) {
    return api.post('/api/logistic-orders', { ...anchor, lines: [{ item_id: stock.item, qty: 1, from_location_id: stock.location }] });
  }

  describe('Create logistic orders and Approve logistic orders', () => {
    it('lets a custom role with Create on and Approve off create and submit an order and refuses its approval; with both on it takes its own order through', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const stock = await addStockedItem(org);

      // Whatever the role is based on: approval is open to any role, so a Technician base proves it.
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const maker = await personWith(org, { edit_logistic_orders: true, create_logistic_orders: true, approve_logistic_orders: false }, { base });
        const api = await maker.api();

        const created = await createOrderOn(api, { job_id: job.id }, stock);
        expect(created.status, `${base} create`).toBe(201);
        const id = created.body.id as string;

        const submitted = await api.post(`/api/logistic-orders/${id}/submit`);
        expect(submitted.status, `${base} submit`).toBe(200);
        expect(submitted.body.status, base).toBe('PENDING_APPROVAL');

        const refused = await api.post(`/api/logistic-orders/${id}/approve`);
        expect(refused.status, `${base} approve without the switch`).toBe(403);
        expect((await db.logisticOrder.findUniqueOrThrow({ where: { id } })).status, base).toBe('PENDING_APPROVAL');

        const approver = await personWith(org, { edit_logistic_orders: true, create_logistic_orders: true, approve_logistic_orders: true }, { base });
        const own = await approver.api();
        const mine = await createOrderOn(own, { job_id: job.id }, stock);
        expect(mine.status, `${base} create with both`).toBe(201);
        expect((await own.post(`/api/logistic-orders/${mine.body.id}/submit`)).status, `${base} submit with both`).toBe(200);
        const approved = await own.post(`/api/logistic-orders/${mine.body.id}/approve`);
        expect(approved.status, `${base} approve with both`).toBe(200);
        expect(approved.body.status, base).toBe('APPROVED');
      }
    });
  });

  // Row-reach checks: Assets scope All is let in to every record, Attached is held to the person's own. Each row asks
  // the route about a colleague's asset and says whether the answer carries it.
  type HeldToOwnProbe = { switchKey: string; check: string; sees: (api: Api, colleagueAsset: string) => Promise<boolean> };
  const heldToOwnProbes: HeldToOwnProbe[] = [
    { switchKey: 'assets_scope', check: 'asset-list', sees: async (api, id) => (await api.get('/api/inventory/assets')).body.data.some((a: { id: string }) => a.id === id) },
    { switchKey: 'assets_scope', check: 'asset-detail', sees: async (api, id) => (await api.get(`/api/inventory/assets/${id}`)).status === 200 },
    { switchKey: 'assets_scope', check: 'asset-events', sees: async (api, id) => (await api.get(`/api/inventory/assets/${id}/events`)).status === 200 },
  ];
  describe('the server checks the catalog lists for the Inventory group', () => {
    const INVENTORY_GROUPS = ['Stock', 'Purchase Orders', 'Vendors', 'Logistic Orders', 'Price Book'];
    const missing = randomUUID();
    type Probe = { switchKey: string; check: string; also?: Record<string, boolean>; run: (api: Api) => Promise<{ status: number }> };
    const probes: Probe[] = [
      { switchKey: 'view_stock', check: 'stock-locations', run: (api) => api.get('/api/inventory/locations') },
      { switchKey: 'see_inventory_activity', check: 'stock-movement-list', also: { view_stock: true }, run: (api) => api.get('/api/inventory/movements') },
      { switchKey: 'see_inventory_activity', check: 'stock-movement-detail', also: { view_stock: true }, run: (api) => api.get(`/api/inventory/movements/${missing}`) },
      { switchKey: 'create_stock', check: 'stock-location-create', also: { view_stock: true, edit_stock: true }, run: (api) => api.post('/api/inventory/locations', {}) },
      { switchKey: 'edit_stock', check: 'stock-set-quantity', also: { view_stock: true }, run: (api) => api.post('/api/inventory/stock/set-quantity', {}) },
      { switchKey: 'delete_stock', check: 'stock-location-delete', also: { view_stock: true }, run: (api) => api.delete(`/api/inventory/locations/${missing}`) },
      { switchKey: 'view_purchase_orders', check: 'purchase-order-list', run: (api) => api.get('/api/inventory/purchase-orders') },
      { switchKey: 'view_purchase_orders', check: 'purchase-order-detail', run: (api) => api.get(`/api/inventory/purchase-orders/${missing}`) },
      { switchKey: 'create_purchase_orders', check: 'purchase-order-create', also: { view_purchase_orders: true, edit_purchase_orders: true }, run: (api) => api.post('/api/inventory/purchase-orders', {}) },
      { switchKey: 'edit_purchase_orders', check: 'purchase-order-update', also: { view_purchase_orders: true }, run: (api) => api.patch(`/api/inventory/purchase-orders/${missing}`, {}) },
      { switchKey: 'delete_purchase_orders', check: 'purchase-order-delete', also: { view_purchase_orders: true }, run: (api) => api.delete(`/api/inventory/purchase-orders/${missing}`) },
      { switchKey: 'view_vendors', check: 'vendor-list', run: (api) => api.get('/api/inventory/vendors') },
      { switchKey: 'create_vendors', check: 'vendor-create', also: { view_vendors: true, edit_vendors: true }, run: (api) => api.post('/api/inventory/vendors', {}) },
      { switchKey: 'edit_vendors', check: 'vendor-update', also: { view_vendors: true }, run: (api) => api.post('/api/inventory/vendors', { id: missing }) },
      { switchKey: 'edit_vendors', check: 'vendor-category-rename', also: { view_vendors: true }, run: (api) => api.patch(`/api/inventory/vendor-categories/${missing}`, { name: 'Hardware' }) },
      { switchKey: 'delete_vendors', check: 'vendor-delete', also: { view_vendors: true }, run: (api) => api.delete(`/api/inventory/vendors/${missing}`) },
      { switchKey: 'view_logistic_orders', check: 'logistic-order-list', run: (api) => api.get('/api/logistic-orders') },
      { switchKey: 'create_logistic_orders', check: 'logistic-order-create', also: { view_logistic_orders: true, edit_logistic_orders: true }, run: (api) => api.post('/api/logistic-orders', { job_id: missing }) },
      { switchKey: 'create_logistic_orders', check: 'logistic-order-submit', also: { view_logistic_orders: true, edit_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/submit`) },
      { switchKey: 'edit_logistic_orders', check: 'logistic-order-update', also: { view_logistic_orders: true }, run: (api) => api.patch(`/api/logistic-orders/${missing}`, {}) },
      { switchKey: 'delete_logistic_orders', check: 'logistic-order-delete', also: { view_logistic_orders: true }, run: (api) => api.delete(`/api/logistic-orders/${missing}`) },
      { switchKey: 'approve_logistic_orders', check: 'logistic-order-approve', also: { view_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/approve`) },
      { switchKey: 'process_logistic_orders', check: 'logistic-order-process', also: { view_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/process`) },
      { switchKey: 'cancel_logistic_orders', check: 'logistic-order-cancel', also: { view_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/cancel`, {}) },
      { switchKey: 'pick_up_staged_items', check: 'stage-pickup', run: (api) => api.post(`/api/inventory/job-stages/${missing}/taken-by-me`) },
      { switchKey: 'record_pickup_for_someone_else', check: 'stage-pickup-for-other', run: (api) => api.post(`/api/inventory/job-stages/${missing}/taken-by`, { takenById: missing }) },
      { switchKey: 'record_pickup_for_someone_else', check: 'stage-pickup-people', run: (api) => api.get(`/api/inventory/job-stages/${missing}/pickup-people`) },
      { switchKey: 'pick_up_staged_items', check: 'order-pickup', also: { view_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/taken-by-me`) },
      { switchKey: 'record_pickup_for_someone_else', check: 'order-pickup-for-other', also: { view_logistic_orders: true }, run: (api) => api.post(`/api/logistic-orders/${missing}/taken-by`, { takenById: missing }) },
      { switchKey: 'record_pickup_for_someone_else', check: 'order-pickup-people', also: { view_logistic_orders: true }, run: (api) => api.get(`/api/logistic-orders/${missing}/pickup-people`) },
      { switchKey: 'view_price_book', check: 'price-book-list', run: (api) => api.get('/api/price-book/items') },
      { switchKey: 'create_price_book_items', check: 'price-book-create', also: { view_price_book: true, edit_price_book_items: true }, run: (api) => api.post('/api/price-book/categories', {}) },
      { switchKey: 'edit_price_book_items', check: 'price-book-update', also: { view_price_book: true }, run: (api) => api.patch(`/api/price-book/categories/${missing}`, {}) },
      { switchKey: 'delete_price_book_items', check: 'price-book-delete', also: { view_price_book: true }, run: (api) => api.delete(`/api/price-book/categories/${missing}`) },
    ];
    // Checks that are not a route's allow-or-refuse, each proven by its own cases in this file.
    const provenElsewhere = ['inventory-view', 'stock-van-limit', 'logistic-order-submitted-alert'];

    it('has a row for every server check the catalog lists for an Inventory switch, and no switch is left unaccounted for', () => {
      const inGroups = SWITCH_CATALOG.filter((s) => INVENTORY_GROUPS.includes(s.module));
      const listed = inGroups.flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      // Assets scope holds no server check (it narrows the asset routes by value); its rows are the row-reach checks below.
      const covered = [...probes.map((p) => `${p.switchKey}:${p.check}`), ...provenElsewhere.map((c) => inGroups.find((s) => s.serverChecks.includes(c))!.key + ':' + c)];
      expect(covered.sort()).toEqual([...listed].sort());
      for (const s of inGroups) expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, {}, { base: 'DISPATCHER', name: 'table' });
      const api = await me.api();
      const toggles = SWITCH_CATALOG.filter((s) => INVENTORY_GROUPS.includes(s.module) && s.kind === 'toggle').map((s) => s.key);
      const allOff = Object.fromEntries(toggles.map((k) => [k, false]));
      const setRole = async (values: Record<string, boolean>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(SWITCH_CATALOG.find((s) => s.key === probe.switchKey)!.serverChecks, probe.check).toContain(probe.check);

        await setRole({ ...allOff, ...probe.also, [probe.switchKey]: true });
        const letIn = await probe.run(api);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);

        await setRole({ ...allOff, ...probe.also, [probe.switchKey]: false });
        expect((await probe.run(api)).status, `${probe.check} with the switch off`).toBe(403);
      }
    });
  });

  describe('the row-reach checks of the Assets scope', () => {
    it('lets each in to every record on All and holds it to the person\'s own on Attached, for a custom role', async () => {
      const { org } = await newOrg();
      const colleague = await fx.addUser(org, `holder${++sequence}`, 'TECHNICIAN');
      const colleagueAsset = randomUUID();
      await db.asset.create({ data: { id: colleagueAsset, organization_id: org, name: 'Colleague drill', assigned_user_id: colleague.id } });
      const me = await personWith(org, {}, { base: 'DISPATCHER', name: 'reach' });
      const api = await me.api();

      for (const probe of heldToOwnProbes) {
        for (const [value, expected] of [['all', true], ['attached', false]] as const) {
          await setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values: { view_stock: true, [probe.switchKey]: value }, actorId: null, reason: 'manual' });
          expect(await probe.sees(api, colleagueAsset), `${probe.check} on ${value}`).toBe(expected);
        }
      }
    });
  });

  describe('Restrict stock to own van', () => {
    /** A van assigned to the person, the location their deductions must come from. */
    async function addVan(org: string, person: Person) {
      const id = randomUUID();
      await db.inventoryLocation.create({
        data: { id, organization_id: org, name: `Van ${id.slice(0, 6)}`, type: 'vehicle', primary_tech_id: person.id },
      });
      return id;
    }
    /** The person as the request layer carries them (with their custom role loaded). */
    const asRequest = async (person: Person) =>
      ({ user: await db.user.findUniqueOrThrow({ where: { id: person.id }, include: { custom_role: true } }) }) as unknown as Request;

    it('limits a stock deduction to the person\'s own van when the switch is on, for any role, and to nobody when it is off', async () => {
      const { org } = await newOrg();
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'] as const) {
        const restricted = await personWith(org, { restrict_stock_to_own_van: true, view_price_book: true }, { base });
        const free = await personWith(org, { restrict_stock_to_own_van: false, view_price_book: true }, { base });
        const restrictedVan = await addVan(org, restricted);
        await addVan(org, free);

        // The check the deduction seams ask: restricted, and the one van they may deduct from.
        expect(await resolveRestrictedVan(await asRequest(restricted)), base).toEqual({ restricted: true, vanId: restrictedVan });
        expect(await resolveRestrictedVan(await asRequest(free)), base).toEqual({ restricted: false, vanId: null });

        // The same answer reaches the person's own van view, which locks its location picker on it.
        const onScreen = await (await restricted.api()).get('/api/inventory/my-van');
        expect(onScreen.status, base).toBe(200);
        expect(onScreen.body.restricted, base).toBe(true);
        const offScreen = await (await free.api()).get('/api/inventory/my-van');
        expect(offScreen.body.restricted, base).toBe(false);
      }
    });

    it('is never decided by the Technician role name: a Technician with the switch off is unrestricted, the Admin box is never restricted', async () => {
      const { org, admin } = await newOrg();
      const tech = await fx.addUser(org, `tech${++sequence}`, 'TECHNICIAN');
      await addVan(org, tech);
      await addVan(org, admin);
      // A built-in Technician holds the preset: Restrict stock to own van is off.
      expect((await resolveRestrictedVan(await asRequest(tech))).restricted).toBe(false);
      expect((await resolveRestrictedVan(await asRequest(admin))).restricted).toBe(false);
    });
  });

  describe('Inventory view', () => {
    it('puts a person in the field roster or at the counter by their Inventory view, never by their role name', async () => {
      const { org } = await newOrg();
      const field = await personWith(org, { inventory_view: 'field', view_stock: true }, { base: 'DISPATCHER' });
      const counter = await personWith(org, { inventory_view: 'counter', view_stock: true }, { base: 'TECHNICIAN' });
      // Built-in people hold the preset: Field for the Technician, Counter for the others.
      const presetTech = await fx.addUser(org, `tech${++sequence}`, 'TECHNICIAN');
      const presetSales = await fx.addUser(org, `sales${++sequence}`, 'SALES');

      const roster = await (await field.api()).get('/api/inventory/techs');
      expect(roster.status).toBe(200);
      const viewOf = (person: Person) => (roster.body.techs as { id: string; inventoryView: string }[]).find((t) => t.id === person.id)?.inventoryView;
      expect(viewOf(field)).toBe('field');
      expect(viewOf(counter)).toBe('counter');
      expect(viewOf(presetTech)).toBe('field');
      expect(viewOf(presetSales)).toBe('counter');
      // The answer names the view and never a role: no row carries a role field for a screen to read.
      for (const row of roster.body.techs as Record<string, unknown>[]) expect(row).not.toHaveProperty('role');
    });

    it('follows the switch when it changes: the next roster shows the new view', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { inventory_view: 'counter', view_stock: true }, { base: 'SALES' });
      const api = await person.api();
      const before = await api.get('/api/inventory/techs');
      expect((before.body.techs as { id: string; inventoryView: string }[]).find((t) => t.id === person.id)?.inventoryView).toBe('counter');

      await setRoleSwitchValues({ organizationId: org, roleKey: person.roleKey, values: { inventory_view: 'field' }, actorId: null, reason: 'manual' });
      // A role edit never touches a person who already holds their own set; here the person has none yet.
      const after = await api.get('/api/inventory/techs');
      expect((after.body.techs as { id: string; inventoryView: string }[]).find((t) => t.id === person.id)?.inventoryView).toBe('field');
    });
  });

  describe('Staff list for inventory pickers', () => {
    it('leaves every login email out for a stock technician who holds View users, and keeps names and views', async () => {
      const { org } = await newOrg();
      const stockTech = await personWith(org, { inventory_view: 'field', view_stock: true, edit_stock: false, view_users: true }, { base: 'TECHNICIAN' });
      await fx.addUser(org, `colleague${++sequence}`, 'SALES');

      const roster = await (await stockTech.api()).get('/api/inventory/techs');
      expect(roster.status).toBe(200);
      const rows = roster.body.techs as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(row).not.toHaveProperty('email');
        expect(row).toMatchObject({ id: expect.any(String), name: expect.any(String), inventoryView: expect.stringMatching(/^(field|counter)$/) });
      }
    });

    it('keeps the email only for a person who can send the pickup ticket (Edit stock), whatever they hold on View users', async () => {
      const { org } = await newOrg();
      const sender = await personWith(org, { inventory_view: 'counter', view_stock: true, edit_stock: true, view_users: false }, { base: 'DISPATCHER' });
      await fx.addUser(org, `colleague${++sequence}`, 'SALES');

      const roster = await (await sender.api()).get('/api/inventory/techs');
      expect(roster.status).toBe(200);
      for (const row of roster.body.techs as Record<string, unknown>[]) expect(row.email).toEqual(expect.stringContaining('@'));
    });
  });

  describe('Logistic order reach', () => {
    /** An order awaiting approval, anchored on whichever of a job, a lead or only a customer the case names. */
    async function addOrder(org: string, creator: string, anchor: { jobId?: string; leadId?: string; customerId?: string }) {
      const id = randomUUID();
      await db.logisticOrder.create({
        data: {
          id, organization_id: org, number: `LO-${id.slice(0, 8)}`, status: 'PENDING_APPROVAL', created_by: creator,
          job_id: anchor.jobId ?? null, lead_id: anchor.leadId ?? null, customer_id: anchor.customerId ?? null,
        },
      });
      return id;
    }

    it('reaches the orders on jobs and leads the person can open, and an order on neither only under Jobs scope All', async () => {
      const { org, customer, admin } = await newOrg();
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const narrow = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' }, { base: 'TECHNICIAN' });
      const wide = await personWith(org, { jobs_scope: 'all', leads_scope: 'attached' }, { base: 'SALES' });

      const mine = await fx.addJob(org, customer, { crew: [narrow.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const myLead = await fx.addLead(org, customer, { assignees: [narrow.id] });
      const theirLead = await fx.addLead(org, customer, { assignees: [someone.id] });
      const onMyJob = await addOrder(org, admin.id, { jobId: mine.id });
      const onTheirJob = await addOrder(org, admin.id, { jobId: theirs.id });
      const onMyLead = await addOrder(org, admin.id, { leadId: myLead.id });
      const onTheirLead = await addOrder(org, admin.id, { leadId: theirLead.id });
      const onNeither = await addOrder(org, admin.id, { customerId: customer });
      const wideLead = await fx.addLead(org, customer, { assignees: [wide.id] });
      const onWideLead = await addOrder(org, admin.id, { leadId: wideLead.id });

      const idsOf = async (api: Api) => ((await api.get('/api/logistic-orders')).body.data as { id: string }[]).map((o) => o.id).sort();
      const narrowApi = await narrow.api();
      expect(await idsOf(narrowApi)).toEqual([onMyJob, onMyLead].sort());
      for (const hidden of [onTheirJob, onTheirLead, onNeither]) {
        expect((await narrowApi.get(`/api/logistic-orders/${hidden}`)).status, 'detail outside').toBe(404);
      }
      expect((await narrowApi.get(`/api/logistic-orders/${onMyLead}`)).status).toBe(200);

      // Jobs scope All reaches every order on a job, and the one on neither a job nor a lead; the leads it
      // reaches stay the ones it can open (another person's lead order stays out).
      const wideApi = await wide.api();
      expect(await idsOf(wideApi)).toEqual([onMyJob, onTheirJob, onNeither, onWideLead].sort());
      expect((await wideApi.get(`/api/logistic-orders/${onNeither}`)).status).toBe(200);
    });

    it('keeps approval, and a new order, inside the reach: approving outside it is not found, and a new order needs a job the person can open', async () => {
      const { org, customer, admin } = await newOrg();
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const stock = await addStockedItem(org);
      const narrow = await personWith(
        org,
        { edit_logistic_orders: true, create_logistic_orders: true, approve_logistic_orders: true, jobs_scope: 'attached', leads_scope: 'attached' },
        { base: 'DISPATCHER' },
      );
      const mine = await fx.addJob(org, customer, { crew: [narrow.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const myLead = await fx.addLead(org, customer, { assignees: [narrow.id] });
      const api = await narrow.api();

      const outside = await addOrder(org, admin.id, { jobId: theirs.id });
      expect((await api.post(`/api/logistic-orders/${outside}/approve`)).status).toBe(404);
      expect((await db.logisticOrder.findUniqueOrThrow({ where: { id: outside } })).status).toBe('PENDING_APPROVAL');
      const inside = await addOrder(org, admin.id, { leadId: myLead.id });
      expect((await api.post(`/api/logistic-orders/${inside}/approve`)).status).toBe(200);

      expect((await createOrderOn(api, { job_id: theirs.id }, stock)).status).toBe(403);
      expect((await createOrderOn(api, { lead_id: myLead.id }, stock)).status).toBe(403);
      expect((await createOrderOn(api, {}, stock)).status).toBe(403);
      expect((await createOrderOn(api, { job_id: mine.id }, stock)).status).toBe(201);
    });
  });

  describe('Purchase order reach', () => {
    /** A purchase order, on a job or on none, with one line to receive. */
    async function addPurchaseOrder(org: string, jobId?: string) {
      const id = randomUUID();
      await db.purchaseOrder.create({
        data: {
          id, organization_id: org, po_number: `PO-${id.slice(0, 8)}`, vendor: 'Acme Hardware', status: 'draft', job_id: jobId ?? null,
          lines: { create: [{ organization_id: org, item_sku: 'HNG-1', item_name: 'Hinge', uom: 'ea', qty_ordered: 5, qty_received: 0 }] },
        },
      });
      return id;
    }
    const newPo = { vendor: 'Acme Hardware', lines: [{ itemName: 'Hinge', uom: 'ea', qtyOrdered: 2 }] };

    it('refuses a purchase order with no job to a person without Jobs scope All, and shows it to a person with it', async () => {
      const { org, customer } = await newOrg();
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const narrow = await personWith(org, { view_purchase_orders: true, jobs_scope: 'attached' }, { base: 'DISPATCHER' });
      const wide = await personWith(org, { view_purchase_orders: true, jobs_scope: 'all' }, { base: 'TECHNICIAN' });

      const mine = await fx.addJob(org, customer, { crew: [narrow.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const onMyJob = await addPurchaseOrder(org, mine.id);
      const onTheirJob = await addPurchaseOrder(org, theirs.id);
      const noJob = await addPurchaseOrder(org);

      const narrowApi = await narrow.api();
      const listed = await narrowApi.get('/api/inventory/purchase-orders');
      expect(listed.status).toBe(200);
      expect((listed.body.purchaseOrders as { id: string }[]).map((p) => p.id)).toEqual([onMyJob]);
      expect((await narrowApi.get(`/api/inventory/purchase-orders/${onMyJob}`)).status).toBe(200);
      expect((await narrowApi.get(`/api/inventory/purchase-orders/${onTheirJob}`)).status).toBe(404);
      expect((await narrowApi.get(`/api/inventory/purchase-orders/${noJob}`)).status).toBe(404);

      const wideApi = await wide.api();
      const all = await wideApi.get('/api/inventory/purchase-orders');
      expect((all.body.purchaseOrders as { id: string }[]).map((p) => p.id).sort()).toEqual([onMyJob, onTheirJob, noJob].sort());
      expect((await wideApi.get(`/api/inventory/purchase-orders/${noJob}`)).status).toBe(200);
    });

    it('lets a person make a purchase order only on a job they can open, and one with no job only under Jobs scope All', async () => {
      const { org, customer } = await newOrg();
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const narrow = await personWith(org, { view_purchase_orders: true, edit_purchase_orders: true, create_purchase_orders: true, jobs_scope: 'attached' }, { base: 'SALES' });
      const wide = await personWith(org, { view_purchase_orders: true, edit_purchase_orders: true, create_purchase_orders: true, jobs_scope: 'all' }, { base: 'TECHNICIAN' });
      const mine = await fx.addJob(org, customer, { crew: [narrow.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });

      const narrowApi = await narrow.api();
      expect((await narrowApi.post('/api/inventory/purchase-orders', newPo)).status).toBe(403);
      expect((await narrowApi.post('/api/inventory/purchase-orders', { ...newPo, jobId: theirs.id })).status).toBe(403);
      expect((await narrowApi.post('/api/inventory/purchase-orders', { ...newPo, jobId: mine.id })).status).toBe(201);

      const wideApi = await wide.api();
      expect((await wideApi.post('/api/inventory/purchase-orders', newPo)).status).toBe(201);
      expect((await wideApi.post('/api/inventory/purchase-orders', { ...newPo, jobId: theirs.id })).status).toBe(201);
    });

    it('keeps edit, mark ordered, receive and delete inside the same reach, and keeps an edit from moving an order out of it', async () => {
      const { org, customer } = await newOrg();
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const narrow = await personWith(
        org,
        { view_purchase_orders: true, edit_purchase_orders: true, delete_purchase_orders: true, jobs_scope: 'attached' },
        { base: 'DISPATCHER' },
      );
      const mine = await fx.addJob(org, customer, { crew: [narrow.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const api = await narrow.api();

      const outside = [await addPurchaseOrder(org, theirs.id), await addPurchaseOrder(org)];
      for (const id of outside) {
        expect((await api.patch(`/api/inventory/purchase-orders/${id}`, { notes: 'x' })).status, 'edit outside').toBe(404);
        expect((await api.post(`/api/inventory/purchase-orders/${id}/mark-ordered`, {})).status, 'mark ordered outside').toBe(404);
        expect((await api.delete(`/api/inventory/purchase-orders/${id}`)).status, 'delete outside').toBe(404);
        expect((await api.post('/api/inventory/purchase-orders/receive', { poId: id, lines: [{ lineId: randomUUID(), qtyReceived: 1 }] })).status, 'receive outside').toBe(404);
        expect(await db.purchaseOrder.count({ where: { id } }), 'still there').toBe(1);
      }

      const inside = await addPurchaseOrder(org, mine.id);
      expect((await api.patch(`/api/inventory/purchase-orders/${inside}`, { notes: 'x' })).status).toBe(200);
      // Moving it onto a job outside their reach, or off any job, would take it out of their reach.
      expect((await api.patch(`/api/inventory/purchase-orders/${inside}`, { jobId: theirs.id })).status).toBe(403);
      expect((await api.patch(`/api/inventory/purchase-orders/${inside}`, { jobId: null })).status).toBe(403);
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: inside } })).job_id).toBe(mine.id);
      expect((await api.delete(`/api/inventory/purchase-orders/${inside}`)).status).toBe(204);
    });
  });

  describe('the order-submitted alert', () => {
    /** The people notified about this order's submission, once the fire-and-forget emit has landed. */
    async function alertedAbout(orderId: string, expectedCount: number): Promise<string[]> {
      for (let i = 0; i < 100; i += 1) {
        const rows = await db.notificationRecipient.findMany({
          where: { notification: { verb: 'lo.submitted', object_id: orderId } },
          select: { recipient_id: true },
        });
        if (rows.length >= expectedCount) {
          // Give a wrongly-addressed extra recipient the moment it would need to show up.
          await new Promise((r) => setTimeout(r, 300));
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await db.notificationRecipient.findMany({
        where: { notification: { verb: 'lo.submitted', object_id: orderId } },
        select: { recipient_id: true },
      })).map((r) => r.recipient_id).sort();
    }

    it('reaches only the Approve logistic orders holders who can reach the order, never a role list', async () => {
      const { org, customer, admin } = await newOrg();
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const stock = await addStockedItem(org);

      const maker = await personWith(org, { edit_logistic_orders: true, create_logistic_orders: true, approve_logistic_orders: false }, { base: 'TECHNICIAN' });
      const reachesAll = await personWith(org, { approve_logistic_orders: true }, { base: 'TECHNICIAN' });
      const reachesAttached = await personWith(org, { approve_logistic_orders: true, jobs_scope: 'attached', leads_scope: 'attached' }, { base: 'SALES' });
      const reachesNothing = await personWith(org, { approve_logistic_orders: true, jobs_scope: 'attached', leads_scope: 'attached' }, { base: 'DISPATCHER' });
      const viewer = await personWith(org, { approve_logistic_orders: false }, { base: 'DISPATCHER' });
      // Based on Admin, but a custom role: not the Admin box, and approval is off for it.
      const adminLike = await personWith(org, { approve_logistic_orders: false }, { base: 'ADMIN' });

      const job = await fx.addJob(org, customer, { crew: [reachesAttached.id, crew.id] });
      const api = await maker.api();
      const created = await createOrderOn(api, { job_id: job.id }, stock);
      expect(created.status).toBe(201);
      expect((await api.post(`/api/logistic-orders/${created.body.id}/submit`)).status).toBe(200);

      // The Admin box holds every switch, so the admin is a holder; nobody else is alerted.
      const alerted = await alertedAbout(created.body.id, 3);
      expect(alerted).toEqual([admin.id, reachesAll.id, reachesAttached.id].sort());
      for (const outsider of [maker, reachesNothing, viewer, adminLike]) expect(alerted).not.toContain(outsider.id);
    });
  });
});
