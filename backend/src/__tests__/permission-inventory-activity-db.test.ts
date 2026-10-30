/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.12 - See inventory activity gates the stock movement list and detail.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding
   exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('See inventory activity gates the stock movement history (real database)', () => {
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
        'stock_movements', 'job_stage_lines', 'job_stages', 'purchase_order_lines', 'purchase_orders',
        'logistic_order_lines', 'logistic_orders', 'stock_balances', 'inventory_locations', 'price_book_items',
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

  /** A person on a fresh custom role of this base holding exactly these switch values, with Jobs scope All. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `activity-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, view_leads: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `activity${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  /** A tracked catalog item, a location and some stock of it. */
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

  const movementsOf = (org: string, type: string) => db.stockMovement.findMany({ where: { organization_id: org, type } });

  describe('the movement list and detail', () => {
    it('refuses both with See inventory activity off and View stock on, and lets both in with both on, whatever the base role', async () => {
      const { org } = await newOrg();
      const stock = await addStockedItem(org);
      const movement = await db.stockMovement.create({
        data: {
          organization_id: org, occurred_at: new Date(), item_sku: 'SKU', item_name: 'Hinge', type: 'receive', qty: 3,
          reference: 'PO-1', actor: 'Tester', item_id: stock.item, to_location_id: stock.location,
        },
      });

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'] as const) {
        const without = await (await personWith(org, { view_stock: true, see_inventory_activity: false }, { base })).api();
        expect((await without.get('/api/inventory/movements')).status, `${base} list without`).toBe(403);
        expect((await without.get(`/api/inventory/movements/${movement.id}`)).status, `${base} detail without`).toBe(403);
        // The item filter is a caller of the same list: refused as well.
        expect((await without.get(`/api/inventory/movements?item_id=${stock.item}&limit=1`)).status, `${base} item history without`).toBe(403);

        const withBoth = await (await personWith(org, { view_stock: true, see_inventory_activity: true }, { base })).api();
        const list = await withBoth.get('/api/inventory/movements');
        expect(list.status, `${base} list with`).toBe(200);
        expect(list.body.data.map((m: { id: string }) => m.id), base).toContain(movement.id);
        expect((await withBoth.get(`/api/inventory/movements/${movement.id}`)).status, `${base} detail with`).toBe(200);
      }
    });
  });

  describe('movements written as a side effect are unaffected', () => {
    it('still writes the consume movement when a person with the switch off processes a logistic order', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const processor = await personWith(org, { view_logistic_orders: true, process_logistic_orders: true, approve_logistic_orders: true, see_inventory_activity: false });
      const job = await fx.addJob(org, customer, { crew: [processor.id] });
      const order = randomUUID();
      await db.logisticOrder.create({
        data: { id: order, organization_id: org, number: `LO-${order.slice(0, 8)}`, status: 'APPROVED', created_by: admin.id, job_id: job.id },
      });
      await db.logisticOrderLine.create({
        data: { logistic_order_id: order, organization_id: org, item_id: stock.item, item_sku: 'SKU', item_name: 'Hinge', qty: 2, from_location_id: stock.location, sequence: 1 },
      });

      const api = await processor.api();
      expect((await api.get('/api/inventory/movements')).status, 'the history stays closed').toBe(403);
      expect((await api.post(`/api/logistic-orders/${order}/process`)).status).toBe(200);

      const written = await movementsOf(org, 'consume');
      expect(written).toHaveLength(1);
      expect(written[0].logistic_order_id).toBe(order);
      expect(Number(written[0].qty)).toBe(2);
    });

    it('still writes the receive movement when a person with the switch off receives a purchase order', async () => {
      const { org, customer } = await newOrg();
      const stock = await addStockedItem(org);
      const receiver = await personWith(org, { view_purchase_orders: true, edit_purchase_orders: true, see_inventory_activity: false });
      const job = await fx.addJob(org, customer, { crew: [receiver.id] });
      const po = await db.purchaseOrder.create({
        data: { organization_id: org, po_number: `PO-${org.slice(0, 6)}`, vendor: 'Supply Co', status: 'ordered', job_id: job.id },
      });
      const line = await db.purchaseOrderLine.create({
        data: { organization_id: org, purchase_order_id: po.id, item_sku: 'SKU', item_name: 'Hinge', uom: 'EA', qty_ordered: 4, qty_received: 0, price_book_item_id: stock.item },
      });

      const api = await receiver.api();
      expect((await api.get('/api/inventory/movements')).status, 'the history stays closed').toBe(403);
      const received = await api.post('/api/inventory/purchase-orders/receive', {
        poId: po.id, destinationLocationId: stock.location, lines: [{ lineId: line.id, qtyReceived: 4 }],
      });
      expect(received.status).toBe(200);

      const written = await movementsOf(org, 'receive');
      expect(written).toHaveLength(1);
      expect(Number(written[0].qty)).toBe(4);
      expect(written[0].actor_user_id).toBe(receiver.id);
    });

    it('still writes the receive movement when a person with the switch off receives parts staged for a job', async () => {
      const { org, customer } = await newOrg();
      const stock = await addStockedItem(org);
      const receiver = await personWith(org, { view_stock: true, edit_stock: true, see_inventory_activity: false });
      const job = await fx.addJob(org, customer, { crew: [receiver.id] });
      const stage = await db.jobStage.create({
        data: { organization_id: org, job_id: job.id, job_number: 'J-1', customer: 'Customer', site: 'Site', trade: 'Locksmith', status: 'pending', staged_location_id: stock.location },
      });
      const line = await db.jobStageLine.create({
        data: { organization_id: org, job_stage_id: stage.id, item_sku: 'SKU', item_name: 'Hinge', uom: 'EA', qty_ordered: 2, qty_received: 0, vendor: 'Supply Co', price_book_item_id: stock.item },
      });

      const api = await receiver.api();
      expect((await api.get('/api/inventory/movements')).status, 'the history stays closed').toBe(403);
      const received = await api.post('/api/inventory/job-stages/receive', { stageId: stage.id, itemId: line.id, qty: 2 });
      expect(received.status).toBe(200);

      const written = await movementsOf(org, 'receive');
      expect(written).toHaveLength(1);
      expect(written[0].job_id).toBe(job.id);
    });
  });
});
