/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.10 - the job page's inventory actions follow switches.

   The server half: the logistic order's own answer carries the list of actions this person may take on it now
   (`actions`), the records opened from a job open on View alone (Show is display only), and the material cost
   figure reaches only a person who holds both View purchase orders and See financial data.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding
   exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

type OrderStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSED' | 'CANCELLED';

suite('job page inventory actions follow switches (real database)', () => {
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
      for (const table of ['logistic_order_lines', 'logistic_orders', 'purchase_order_lines', 'purchase_orders', 'stock_movements', 'stock_balances', 'inventory_locations', 'price_book_items']) {
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

  /** A person on a fresh custom role of this base holding exactly these switch values, over everything else off. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; roleName?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = opts.roleName ?? `inv-actions-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        leads_scope: 'attached', jobs_scope: 'attached', view_jobs: true, view_leads: true, view_logistic_orders: true,
        create_logistic_orders: false, edit_logistic_orders: false, delete_logistic_orders: false,
        approve_logistic_orders: false, process_logistic_orders: false, cancel_logistic_orders: false,
        view_purchase_orders: false, create_purchase_orders: false, see_financial_data: false,
        // The pickup mark has its own list entries (permission-logistic-order-pickup-db.test.ts); these cases are about the others.
        pick_up_staged_items: false, record_pickup_for_someone_else: false,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `inv${++sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

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

  async function addOrder(org: string, creator: string, jobId: string, status: OrderStatus, stock: { item: string; location: string }) {
    const id = randomUUID();
    await db.logisticOrder.create({
      data: { id, organization_id: org, number: `LO-${id.slice(0, 8)}`, status, created_by: creator, job_id: jobId },
    });
    await db.logisticOrderLine.create({
      data: { logistic_order_id: id, organization_id: org, item_id: stock.item, item_sku: 'SKU', item_name: 'Hinge', qty: 1, from_location_id: stock.location, sequence: 1 },
    });
    return id;
  }

  const actionsOf = async (api: Api, id: string) => {
    const res = await api.get(`/api/logistic-orders/${id}`);
    expect(res.status).toBe(200);
    return res.body.actions as string[];
  };

  describe('the order answer lists what this person may do to it now', () => {
    // [switches held, status, the actions listed (in the answer's fixed order)]. Written out by hand from the
    // rules, never derived from the code under test.
    const table: Array<[string, Record<string, boolean>, OrderStatus, string[]]> = [
      ['nothing', {}, 'DRAFT', []],
      ['Create alone, on a draft', { create_logistic_orders: true }, 'DRAFT', ['submit']],
      ['Create alone, on a submitted order', { create_logistic_orders: true }, 'PENDING_APPROVAL', []],
      ['Edit, Cancel and Delete, on a draft', { edit_logistic_orders: true, cancel_logistic_orders: true, delete_logistic_orders: true }, 'DRAFT', ['cancel', 'edit', 'delete']],
      ['Approve alone, on a submitted order', { approve_logistic_orders: true }, 'PENDING_APPROVAL', ['approve']],
      ['Approve alone, on a draft', { approve_logistic_orders: true }, 'DRAFT', []],
      ['Approve alone, on an approved order', { approve_logistic_orders: true }, 'APPROVED', []],
      ['Process alone, on an approved order', { process_logistic_orders: true }, 'APPROVED', ['process']],
      ['Process alone, on a submitted order', { process_logistic_orders: true }, 'PENDING_APPROVAL', []],
      ['Process alone, on a draft', { process_logistic_orders: true }, 'DRAFT', []],
      ['Approve and Process, on a draft', { approve_logistic_orders: true, process_logistic_orders: true }, 'DRAFT', ['process']],
      ['Approve and Process, on a submitted order', { approve_logistic_orders: true, process_logistic_orders: true }, 'PENDING_APPROVAL', ['approve', 'process']],
      ['Approve and Process, on an approved order', { approve_logistic_orders: true, process_logistic_orders: true }, 'APPROVED', ['process']],
      ['Cancel, on a processed order', { cancel_logistic_orders: true }, 'PROCESSED', []],
      ['Edit without Process, on a processed order', { edit_logistic_orders: true }, 'PROCESSED', []],
      ['Edit with Process, on a processed order', { edit_logistic_orders: true, process_logistic_orders: true }, 'PROCESSED', ['edit']],
      ['Delete without Process, on a processed order', { delete_logistic_orders: true }, 'PROCESSED', []],
      ['Delete with Process, on a processed order', { delete_logistic_orders: true, process_logistic_orders: true }, 'PROCESSED', ['delete']],
      ['Edit without Approve or Process, on an approved order', { edit_logistic_orders: true }, 'APPROVED', []],
      ['Edit with Approve, on an approved order', { edit_logistic_orders: true, approve_logistic_orders: true }, 'APPROVED', ['edit']],
      ['Edit and Delete, on a cancelled order', { edit_logistic_orders: true, delete_logistic_orders: true }, 'CANCELLED', ['delete']],
    ];

    it.each(table)('%s', async (_name, switches, status, expected) => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, switches);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const order = await addOrder(org, admin.id, job.id, status, stock);
      expect(await actionsOf(await me.api(), order)).toEqual(expected);
    });

    it('lists nothing that moves the order on a cancelled job, whatever the person holds', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, {
        create_logistic_orders: true, approve_logistic_orders: true, process_logistic_orders: true,
        cancel_logistic_orders: true, edit_logistic_orders: true, delete_logistic_orders: true,
      });
      const job = await fx.addJob(org, customer, { crew: [me.id], status: 'CANCELLED' });
      const api = await me.api();
      expect(await actionsOf(api, await addOrder(org, admin.id, job.id, 'DRAFT', stock))).toEqual(['edit', 'delete']);
      expect(await actionsOf(api, await addOrder(org, admin.id, job.id, 'PENDING_APPROVAL', stock))).toEqual(['edit', 'delete']);
    });

    it('goes by the switches alone: a role called Administrators without Approve gets no Approve, a role called anything with it does', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const called = await personWith(org, {}, { roleName: 'Administrators' });
      const plain = await personWith(org, { approve_logistic_orders: true }, { roleName: 'Night shift' });
      const job = await fx.addJob(org, customer, { crew: [called.id, plain.id] });
      const order = await addOrder(org, admin.id, job.id, 'PENDING_APPROVAL', stock);
      expect(await actionsOf(await called.api(), order)).toEqual([]);
      expect(await actionsOf(await plain.api(), order)).toEqual(['approve']);
    });

    it('carries the list on the answers to create, submit and approve as well', async () => {
      const { org, customer } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, { create_logistic_orders: true, approve_logistic_orders: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await me.api();
      const made = await api.post('/api/logistic-orders', { job_id: job.id, lines: [{ item_id: stock.item, qty: 1, from_location_id: stock.location }] });
      expect(made.status).toBe(201);
      expect(made.body.actions).toEqual(['submit']);
      const submitted = await api.post(`/api/logistic-orders/${made.body.id}/submit`);
      expect(submitted.body.actions).toEqual(['approve']);
      const approved = await api.post(`/api/logistic-orders/${made.body.id}/approve`);
      expect(approved.body.actions).toEqual([]);
    });

    it('does not put an action list on the order list rows (no query per order)', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, { approve_logistic_orders: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      for (let i = 0; i < 3; i++) await addOrder(org, admin.id, job.id, 'PENDING_APPROVAL', stock);
      const list = await (await me.api()).get(`/api/logistic-orders?job_id=${job.id}`);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(3);
      for (const row of list.body.data) expect(row).not.toHaveProperty('actions');
    });
  });

  describe('a record opened from the job', () => {
    it('opens on View alone, with every Show switch off, and not at all with View off', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const viewer = await personWith(org, { show_logistic_orders_page: false, show_purchase_orders_page: false });
      const blind = await personWith(org, { view_logistic_orders: false });
      const job = await fx.addJob(org, customer, { crew: [viewer.id, blind.id] });
      const order = await addOrder(org, admin.id, job.id, 'DRAFT', stock);

      expect((await (await viewer.api()).get(`/api/logistic-orders/${order}`)).status).toBe(200);
      expect((await (await viewer.api()).get(`/api/logistic-orders?job_id=${job.id}`)).status).toBe(200);
      // With View off the route refuses the person whatever the order is: the same answer for a real id and a made-up one.
      const real = await (await blind.api()).get(`/api/logistic-orders/${order}`);
      const made = await (await blind.api()).get(`/api/logistic-orders/${randomUUID()}`);
      expect(real.status).toBe(403);
      expect(made.status).toBe(real.status);
      expect(real.body).toEqual(made.body);
    });

    it('answers "not found" for an order on a job the person cannot open', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const me = await personWith(org, {});
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const order = await addOrder(org, admin.id, theirs.id, 'DRAFT', stock);
      expect((await (await me.api()).get(`/api/logistic-orders/${order}`)).status).toBe(404);
    });

    it('opens a purchase order on View purchase orders alone, and not with it off', async () => {
      const { org, customer } = await newOrg();
      const viewer = await personWith(org, { view_purchase_orders: true, show_purchase_orders_page: false });
      const blind = await personWith(org, { view_purchase_orders: false });
      const job = await fx.addJob(org, customer, { crew: [viewer.id, blind.id] });
      const po = await db.purchaseOrder.create({
        data: { organization_id: org, po_number: `PO-${randomUUID().slice(0, 6)}`, vendor: 'Supply Co', status: 'draft', job_id: job.id },
      });
      const opened = await (await viewer.api()).get(`/api/inventory/purchase-orders/${po.id}`);
      expect(opened.status).toBe(200);
      expect(opened.body.purchaseOrder.id).toBe(po.id);
      const refused = await (await blind.api()).get(`/api/inventory/purchase-orders/${po.id}`);
      const refusedMade = await (await blind.api()).get(`/api/inventory/purchase-orders/${randomUUID()}`);
      expect(refused.status).toBe(403);
      expect(refusedMade.status).toBe(refused.status);
    });
  });

  describe('the material cost figure', () => {
    async function jobWithPurchasedMaterial(org: string, customer: string, crew: string[]) {
      const job = await fx.addJob(org, customer, { crew });
      const po = await db.purchaseOrder.create({
        data: { organization_id: org, po_number: `PO-${randomUUID().slice(0, 6)}`, vendor: 'Supply Co', status: 'ordered', job_id: job.id },
      });
      await db.purchaseOrderLine.create({
        data: { organization_id: org, purchase_order_id: po.id, item_sku: 'SKU-X', item_name: 'Hinge', uom: 'EA', qty_ordered: 4, qty_received: 4, unit_cost: 18 },
      });
      return job;
    }

    it('reaches a person with View purchase orders and See financial data, and carries no figure for one without See financial data', async () => {
      const { org, customer } = await newOrg();
      const both = await personWith(org, { view_purchase_orders: true, see_financial_data: true });
      const poOnly = await personWith(org, { view_purchase_orders: true, see_financial_data: false });
      const job = await jobWithPurchasedMaterial(org, customer, [both.id, poOnly.id]);

      const withBoth = await (await both.api()).get(`/api/inventory/jobs/${job.id}/material-cost`);
      expect(withBoth.status).toBe(200);
      expect(withBoth.body.materialCost).toBe(72);

      const withoutCosts = await (await poOnly.api()).get(`/api/inventory/jobs/${job.id}/material-cost`);
      expect(withoutCosts.status).toBe(200);
      expect(withoutCosts.body).not.toHaveProperty('materialCost');
      expect(withoutCosts.body.lineCount).toBe(1);
    });

    it('is refused with View purchase orders off, even with See financial data on', async () => {
      const { org, customer } = await newOrg();
      const costsOnly = await personWith(org, { view_purchase_orders: false, see_financial_data: true });
      const job = await jobWithPurchasedMaterial(org, customer, [costsOnly.id]);
      const res = await (await costsOnly.api()).get(`/api/inventory/jobs/${job.id}/material-cost`);
      expect(res.status).toBe(403);
    });

    it('is not on the job answer or its financials for anyone', async () => {
      const { org, customer } = await newOrg();
      const both = await personWith(org, { view_purchase_orders: true, see_financial_data: true });
      const job = await jobWithPurchasedMaterial(org, customer, [both.id]);
      const api = await both.api();
      for (const path of [`/api/jobs/${job.id}`, `/api/jobs/${job.id}/financials`]) {
        const res = await api.get(path);
        expect(JSON.stringify(res.body), path).not.toMatch(/material_?cost|materialCost/i);
      }
    });
  });

  describe('the completed-job lock does not reach the job\'s orders', () => {
    const lockedStatuses: JobStatus[] = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'];
    it.each(lockedStatuses)('a job in %s still takes an order and its submit, and lists what the person holds', async (status) => {
      const { org, customer } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, { create_logistic_orders: true, edit_logistic_orders: true });
      const job = await fx.addJob(org, customer, { crew: [me.id], status });
      const api = await me.api();
      const made = await api.post('/api/logistic-orders', { job_id: job.id, lines: [{ item_id: stock.item, qty: 1, from_location_id: stock.location }] });
      expect(made.status).toBe(201);
      expect(made.body.actions).toEqual(['submit', 'edit']);
      expect((await api.post(`/api/logistic-orders/${made.body.id}/submit`)).status).toBe(200);
    });
  });
});
