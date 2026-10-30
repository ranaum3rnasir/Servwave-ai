/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.8 - logistic orders: submit rides Create, Attached reach, and the
   approve / process flow.

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

suite('logistic orders: reach and flow follow switches (real database)', () => {
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
      for (const table of ['logistic_order_lines', 'logistic_orders', 'stock_movements', 'stock_balances', 'inventory_locations', 'price_book_items']) {
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
    opts: { base?: Role } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `order-flow-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        leads_scope: 'attached', jobs_scope: 'attached', view_jobs: true, view_leads: true, view_logistic_orders: true,
        create_logistic_orders: false, edit_logistic_orders: false, delete_logistic_orders: false,
        approve_logistic_orders: false, process_logistic_orders: false, cancel_logistic_orders: false,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `flow${sequence}`, base, { customRoleId: role.id });
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

  /** Make an order through the route, as the person. Returns the response. */
  async function createOrderOn(api: Api, anchor: { job_id?: string; lead_id?: string }, stock: { item: string; location: string }) {
    return api.post('/api/logistic-orders', { ...anchor, lines: [{ item_id: stock.item, qty: 1, from_location_id: stock.location }] });
  }

  /** An order on a job in the given status, made directly so the case can start the flow from any step. */
  async function addOrder(org: string, creator: string, jobId: string, status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED', stock: { item: string; location: string }) {
    const id = randomUUID();
    await db.logisticOrder.create({
      data: {
        id, organization_id: org, number: `LO-${id.slice(0, 8)}`, status, created_by: creator, job_id: jobId,
      },
    });
    await db.logisticOrderLine.create({
      data: { logistic_order_id: id, organization_id: org, item_id: stock.item, item_sku: 'SKU', item_name: 'Hinge', qty: 1, from_location_id: stock.location, sequence: 1 },
    });
    return id;
  }
  const statusOf = async (id: string) => (await db.logisticOrder.findUniqueOrThrow({ where: { id } })).status;

  describe('reach under Attached scope', () => {
    it('reads the orders on an attached job and an attached lead, answers "not found" for the rest, and loses an order when taken off the job', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const me = await personWith(org, {});
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const myLead = await fx.addLead(org, customer, { assignees: [me.id] });
      const theirLead = await fx.addLead(org, customer, { assignees: [someone.id] });

      const onMyJob = await addOrder(org, admin.id, mine.id, 'PENDING_APPROVAL', stock);
      const onTheirJob = await addOrder(org, admin.id, theirs.id, 'PENDING_APPROVAL', stock);
      const onMyLead = randomUUID();
      const onTheirLead = randomUUID();
      for (const [id, lead] of [[onMyLead, myLead.id], [onTheirLead, theirLead.id]]) {
        await db.logisticOrder.create({ data: { id, organization_id: org, number: `LO-${id.slice(0, 8)}`, status: 'PENDING_APPROVAL', created_by: admin.id, lead_id: lead } });
      }

      const api = await me.api();
      const idsOf = async () => ((await api.get('/api/logistic-orders')).body.data as { id: string }[]).map((o) => o.id).sort();
      expect(await idsOf()).toEqual([onMyJob, onMyLead].sort());
      expect((await api.get(`/api/logistic-orders/${onMyJob}`)).status).toBe(200);
      expect((await api.get(`/api/logistic-orders/${onMyLead}`)).status).toBe(200);
      expect((await api.get(`/api/logistic-orders/${onTheirJob}`)).status).toBe(404);
      expect((await api.get(`/api/logistic-orders/${onTheirLead}`)).status).toBe(404);

      // Taken off the job, the order is gone on the very next request.
      await fx.removeCrew(mine.visitId!, me.id);
      expect(await idsOf()).toEqual([onMyLead]);
      expect((await api.get(`/api/logistic-orders/${onMyJob}`)).status).toBe(404);
    });
  });

  describe('create and submit ride Create logistic orders', () => {
    it('refuses create and submit with Create off, and with it on allows an openable job and refuses another', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      // Every other logistic-order switch is on, so only Create can explain a refusal.
      const others = { edit_logistic_orders: true, delete_logistic_orders: true, approve_logistic_orders: true, process_logistic_orders: true, cancel_logistic_orders: true };
      const without = await personWith(org, { ...others, create_logistic_orders: false });
      const withIt = await personWith(org, { ...others, create_logistic_orders: true });
      const myJob = await fx.addJob(org, customer, { crew: [without.id, withIt.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [someone.id] });

      const draft = await addOrder(org, admin.id, myJob.id, 'DRAFT', stock);
      const noCreate = await without.api();
      expect((await createOrderOn(noCreate, { job_id: myJob.id }, stock)).status).toBe(403);
      expect((await noCreate.post(`/api/logistic-orders/${draft}/submit`)).status).toBe(403);
      expect(await statusOf(draft)).toBe('DRAFT');

      const yesCreate = await withIt.api();
      const made = await createOrderOn(yesCreate, { job_id: myJob.id }, stock);
      expect(made.status).toBe(201);
      const submitted = await yesCreate.post(`/api/logistic-orders/${made.body.id}/submit`);
      expect(submitted.status).toBe(200);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');
      expect((await createOrderOn(yesCreate, { job_id: otherJob.id }, stock)).status).toBe(403);
      // An order on a job they cannot open cannot be submitted either: it is not found.
      const elsewhere = await addOrder(org, admin.id, otherJob.id, 'DRAFT', stock);
      expect((await yesCreate.post(`/api/logistic-orders/${elsewhere}/submit`)).status).toBe(404);
      expect(await statusOf(elsewhere)).toBe('DRAFT');
    });

    it('lets a Through own leads role create and submit on a job from its own lead, and the order waits for approval', async () => {
      const { org, customer } = await newOrg();
      const stock = await addStockedItem(org);
      const someone = await fx.addUser(org, `rep${++sequence}`, 'SALES');
      const rep = await personWith(org, { jobs_scope: 'through_own_leads', leads_scope: 'attached', create_logistic_orders: true }, { base: 'SALES' });
      const myLead = await fx.addLead(org, customer, { assignees: [rep.id] });
      const theirLead = await fx.addLead(org, customer, { assignees: [someone.id] });
      const fromMine = await fx.addJob(org, customer, { fromLead: myLead.id });
      const fromTheirs = await fx.addJob(org, customer, { fromLead: theirLead.id });

      const api = await rep.api();
      const made = await createOrderOn(api, { job_id: fromMine.id }, stock);
      expect(made.status).toBe(201);
      const submitted = await api.post(`/api/logistic-orders/${made.body.id}/submit`);
      expect(submitted.status).toBe(200);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');
      // Not approved by anyone: with Approve off the person cannot, and nothing else did.
      expect((await api.post(`/api/logistic-orders/${made.body.id}/approve`)).status).toBe(403);
      expect(await statusOf(made.body.id)).toBe('PENDING_APPROVAL');
      expect((await createOrderOn(api, { job_id: fromTheirs.id }, stock)).status).toBe(403);
    });

    it('follows Create alone: a role with every other order switch on still cannot submit', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const me = await personWith(org, {
        edit_logistic_orders: true, delete_logistic_orders: true, approve_logistic_orders: true,
        process_logistic_orders: true, cancel_logistic_orders: true,
      }, { base: 'DISPATCHER' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const draft = await addOrder(org, admin.id, job.id, 'DRAFT', stock);
      const api = await me.api();
      expect((await api.post(`/api/logistic-orders/${draft}/submit`)).status).toBe(403);

      await setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values: { create_logistic_orders: true }, actorId: null, reason: 'manual' });
      expect((await api.post(`/api/logistic-orders/${draft}/submit`)).status).toBe(200);
    });
  });

  describe('approve and process', () => {
    it('needs Approve to approve, Process to process an approved order, and both to carry an order straight to processed', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const approver = await personWith(org, { approve_logistic_orders: true });
      const processor = await personWith(org, { process_logistic_orders: true });
      const both = await personWith(org, { approve_logistic_orders: true, process_logistic_orders: true });
      const neither = await personWith(org, {});
      const crew = [approver.id, processor.id, both.id, neither.id];
      const job = await fx.addJob(org, customer, { crew });

      // Approve: refused without the switch, allowed with it.
      const toApprove = await addOrder(org, admin.id, job.id, 'PENDING_APPROVAL', stock);
      expect((await (await processor.api()).post(`/api/logistic-orders/${toApprove}/approve`)).status).toBe(403);
      expect((await (await neither.api()).post(`/api/logistic-orders/${toApprove}/approve`)).status).toBe(403);
      expect(await statusOf(toApprove)).toBe('PENDING_APPROVAL');
      expect((await (await approver.api()).post(`/api/logistic-orders/${toApprove}/approve`)).status).toBe(200);
      expect(await statusOf(toApprove)).toBe('APPROVED');

      // Process an approved order: Process alone is enough; Approve alone is not.
      expect((await (await approver.api()).post(`/api/logistic-orders/${toApprove}/process`)).status).toBe(403);
      expect(await statusOf(toApprove)).toBe('APPROVED');
      expect((await (await processor.api()).post(`/api/logistic-orders/${toApprove}/process`)).status).toBe(200);
      expect(await statusOf(toApprove)).toBe('PROCESSED');

      // A submitted (or draft) order straight to processed: Process alone is refused, Process plus Approve is allowed.
      for (const start of ['PENDING_APPROVAL', 'DRAFT'] as const) {
        const order = await addOrder(org, admin.id, job.id, start, stock);
        const refused = await (await processor.api()).post(`/api/logistic-orders/${order}/process`);
        expect(refused.status, `${start} with Process only`).toBe(409);
        expect(await statusOf(order), start).toBe(start);
        const carried = await (await both.api()).post(`/api/logistic-orders/${order}/process`);
        expect(carried.status, `${start} with Process and Approve`).toBe(200);
        expect(await statusOf(order), start).toBe('PROCESSED');
      }
    });

    it('keeps processing inside the reach: an order on a job the person cannot open is not found', async () => {
      const { org, customer, admin } = await newOrg();
      const stock = await addStockedItem(org);
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const processor = await personWith(org, { process_logistic_orders: true });
      const mine = await fx.addJob(org, customer, { crew: [processor.id] });
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const api = await processor.api();

      const outside = await addOrder(org, admin.id, theirs.id, 'APPROVED', stock);
      expect((await api.post(`/api/logistic-orders/${outside}/process`)).status).toBe(404);
      expect(await statusOf(outside)).toBe('APPROVED');
      const inside = await addOrder(org, admin.id, mine.id, 'APPROVED', stock);
      expect((await api.post(`/api/logistic-orders/${inside}/process`)).status).toBe(200);
    });
  });
});
