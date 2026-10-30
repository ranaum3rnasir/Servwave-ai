/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.11 - the pickup mark on a Processed logistic order: "Taken by me" (Pick up
   staged items) and "Taken by..." (Record pickup for someone else), each needing View logistic orders and reach to
   the order and none of the logistic-order write switches.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly
   the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LogisticOrderStatus, PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The six switches that write to an order; a pickup needs none of them. */
const WRITE_SWITCHES_OFF = {
  create_logistic_orders: false, edit_logistic_orders: false, delete_logistic_orders: false,
  approve_logistic_orders: false, process_logistic_orders: false, cancel_logistic_orders: false,
};

suite('logistic-order pickups follow their switches and the order\'s reach (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
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

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'TECHNICIAN',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `order-pickup-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { ...ALL_OFF, view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached', view_logistic_orders: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `pick${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A tracked catalog item and a location holding some of it. */
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

  /** An order on a job (or a lead) in the given status, made directly so a case can start from any step. */
  async function addOrder(
    org: string, creator: string, anchor: { jobId?: string; leadId?: string }, status: LogisticOrderStatus,
    stock: { item: string; location: string },
  ) {
    const id = randomUUID();
    await db.logisticOrder.create({
      data: {
        id, organization_id: org, number: `LO-${id.slice(0, 8)}`, status, created_by: creator,
        job_id: anchor.jobId ?? null, lead_id: anchor.leadId ?? null,
        ...(status === 'PROCESSED' ? { processed_at: new Date(), processed_by: creator } : {}),
      },
    });
    await db.logisticOrderLine.create({
      data: { logistic_order_id: id, organization_id: org, item_id: stock.item, item_sku: 'SKU', item_name: 'Hinge', qty: 1, from_location_id: stock.location, sequence: 1 },
    });
    return id;
  }

  const takenByMe = (api: Api, id: string) => api.post(`/api/logistic-orders/${id}/taken-by-me`);
  const takenBy = (api: Api, id: string, takenById: string) => api.post(`/api/logistic-orders/${id}/taken-by`, { takenById });
  const peopleFor = (api: Api, id: string) => api.get(`/api/logistic-orders/${id}/pickup-people`);
  const nameOf = async (id: string) => {
    const u = await db.user.findUniqueOrThrow({ where: { id }, select: { first_name: true, last_name: true } });
    return `${u.first_name} ${u.last_name}`;
  };
  const rowOf = (id: string) => db.logisticOrder.findUniqueOrThrow({ where: { id } });
  /** The company's whole stock ledger and shelf, to prove a pickup touches neither. */
  const stockState = async (org: string) => ({
    movements: await db.stockMovement.findMany({ where: { organization_id: org }, orderBy: { id: 'asc' } }),
    balances: await db.stockBalance.findMany({ where: { organization_id: org }, orderBy: { id: 'asc' } }),
  });

  /** A company with a Processed order on a job the person is attached to. */
  async function processedOrderFor(values: Record<string, boolean | string>) {
    const { org, customer, admin } = await newOrg();
    const stock = await addStockedItem(org);
    const me = await personWith(org, values);
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const order = await addOrder(org, admin.id, { jobId: job.id }, 'PROCESSED', stock);
    return { org, customer, admin, stock, me, job, order };
  }

  describe('"Taken by me"', () => {
    it('lets a person with Pick up staged items and View logistic orders take a Processed order in reach with every write switch off', async () => {
      const { me, order } = await processedOrderFor({ pick_up_staged_items: true, ...WRITE_SWITCHES_OFF, edit_stock: false });

      const res = await takenByMe(await me.api(), order);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(order);
      expect(res.body.takenBy).toEqual({ id: me.id, name: await nameOf(me.id) });
      expect(res.body.recordedBy).toEqual({ id: me.id, name: await nameOf(me.id) });
      expect(res.body.takenAt).toBeTruthy();
    });

    it('refuses an order that is not Processed yet, or no longer open to it, with a stale-status answer and nothing saved', async () => {
      const { org, admin, stock, me, job } = await processedOrderFor({ pick_up_staged_items: true });
      const api = await me.api();

      for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'RETURNED'] as const) {
        const order = await addOrder(org, admin.id, { jobId: job.id }, status, stock);
        const res = await takenByMe(api, order);
        expect(res.status, status).toBe(409);
        expect(res.body.error, status).toBe('STALE_STATUS');
        expect(res.body.expected_status, status).toEqual(['PROCESSED']);
        expect((await rowOf(order)).taken_at, status).toBeNull();
      }
    });

    it('refuses a person without Pick up staged items, even holding Record pickup for someone else, Edit stock and every order write switch', async () => {
      const { me, order } = await processedOrderFor({
        pick_up_staged_items: false, record_pickup_for_someone_else: true, view_stock: true, edit_stock: true,
        create_logistic_orders: true, edit_logistic_orders: true, approve_logistic_orders: true, process_logistic_orders: true,
        cancel_logistic_orders: true, delete_logistic_orders: true,
      });

      expect((await takenByMe(await me.api(), order)).status).toBe(403);
      expect((await rowOf(order)).taken_at).toBeNull();
    });

    it('refuses an order outside the person\'s reach as not found, with the switch on', async () => {
      const { org, customer, admin, stock, me } = await processedOrderFor({ pick_up_staged_items: true });
      const someone = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const theirs = await fx.addJob(org, customer, { crew: [someone.id] });
      const outside = await addOrder(org, admin.id, { jobId: theirs.id }, 'PROCESSED', stock);

      const res = await takenByMe(await me.api(), outside);

      expect(res.status).toBe(404);
      expect((await rowOf(outside)).taken_at).toBeNull();
    });

    it('refuses a person with View logistic orders off, whether or not the order exists', async () => {
      const { org, me, order } = await processedOrderFor({ pick_up_staged_items: true, view_logistic_orders: false });
      const api = await me.api();

      const real = await takenByMe(api, order);
      const missing = await takenByMe(api, randomUUID());

      expect(real.status).toBe(403);
      expect(missing.status).toBe(403);
      expect(real.body).toEqual(missing.body);
      expect((await rowOf(order)).taken_at).toBeNull();
      expect(org).toBeTruthy();
    });

    it('does not reach another company\'s order', async () => {
      const { me } = await processedOrderFor({ pick_up_staged_items: true });
      const other = await newOrg();
      const stock = await addStockedItem(other.org);
      const theirs = await addOrder(other.org, other.admin.id, {}, 'PROCESSED', stock);

      expect((await takenByMe(await me.api(), theirs)).status).toBe(404);
      expect((await rowOf(theirs)).taken_at).toBeNull();
    });

    it('writes no stock movement and changes no balance, and the order can still be returned afterwards', async () => {
      const { org, admin, customer, stock, me, job } = await processedOrderFor({ pick_up_staged_items: true });
      const order = await addOrder(org, admin.id, { jobId: job.id }, 'PROCESSED', stock);
      const before = await stockState(org);

      expect((await takenByMe(await me.api(), order)).status).toBe(200);

      expect(await stockState(org)).toEqual(before);

      // The unwind every document verb shares: cancel the job and the processed order comes back in.
      const office = await fx.signedInAs(admin);
      const cancelled = await office.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'PRICE' });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
      const returned = await rowOf(order);
      expect(returned.status).toBe('RETURNED');
      expect(returned.taken_at, 'the mark stays as the record of what happened').toBeTruthy();
      expect(returned.taken_by_id).toBe(me.id);
      const after = await stockState(org);
      expect(after.movements.filter((m) => m.type === 'return').length).toBeGreaterThan(0);
      expect(customer).toBeTruthy();
    });

    it('takes a second pickup as already taken and leaves the first one as it was', async () => {
      const { org, me, order } = await processedOrderFor({ pick_up_staged_items: true, record_pickup_for_someone_else: true });
      const other = await fx.addUser(org, `other${++sequence}`, 'TECHNICIAN');
      const api = await me.api();

      expect((await takenByMe(api, order)).status).toBe(200);
      const first = await rowOf(order);
      const again = await takenByMe(api, order);
      const forOther = await takenBy(api, order, other.id);

      expect(again.status).toBe(409);
      expect(again.body.error).toBe('ALREADY_TAKEN');
      expect(forOther.status).toBe(409);
      const now = await rowOf(order);
      expect(now.taken_by_id).toBe(me.id);
      expect(now.taken_at).toEqual(first.taken_at);
    });

    it('logs the pickup in the order\'s history', async () => {
      const { org, me, order } = await processedOrderFor({ pick_up_staged_items: true });

      expect((await takenByMe(await me.api(), order)).status).toBe(200);

      const logged = await db.auditLog.findMany({ where: { org_id: org, resource_type: 'LogisticOrder', resource_id: order } });
      expect(logged).toHaveLength(1);
      expect(logged[0]!.action).toBe('inventory.logistic_order_picked_up');
      expect(logged[0]!.actor_id).toBe(me.id);
      expect(logged[0]!.metadata).toMatchObject({
        taken_by: me.id, recorded_by: me.id, taken_by_name: await nameOf(me.id), recorded_by_name: await nameOf(me.id),
      });
    });
  });

  describe('"Taken by..."', () => {
    it('lets a person with Record pickup for someone else alone record a colleague\'s pickup, naming both', async () => {
      const { org, me, order } = await processedOrderFor({ record_pickup_for_someone_else: true, pick_up_staged_items: false, ...WRITE_SWITCHES_OFF });
      const taker = await fx.addUser(org, `taker${++sequence}`, 'TECHNICIAN');
      const api = await me.api();

      const res = await takenBy(api, order, taker.id);

      expect(res.status).toBe(200);
      expect(res.body.takenBy).toEqual({ id: taker.id, name: await nameOf(taker.id) });
      expect(res.body.recordedBy).toEqual({ id: me.id, name: await nameOf(me.id) });
      const reloaded = (await api.get(`/api/logistic-orders/${order}`)).body;
      expect(reloaded.takenBy.id).toBe(taker.id);
      expect(reloaded.recordedBy.id).toBe(me.id);
      expect(reloaded.takenAt).toBeTruthy();
      const logged = await db.auditLog.findMany({ where: { org_id: org, resource_type: 'LogisticOrder', resource_id: order } });
      expect(logged[0]!.metadata).toMatchObject({ taken_by: taker.id, recorded_by: me.id });
    });

    it('lets that person record themselves too: Pick up staged items plays no part in the colleague route', async () => {
      const { me, order } = await processedOrderFor({ record_pickup_for_someone_else: true, pick_up_staged_items: false });

      const res = await takenBy(await me.api(), order, me.id);

      expect(res.status).toBe(200);
      expect(res.body.takenBy.id).toBe(me.id);
    });

    it('refuses a person with only Pick up staged items, for the record and for the picker', async () => {
      const { org, me, order } = await processedOrderFor({ pick_up_staged_items: true, record_pickup_for_someone_else: false, view_stock: true, edit_stock: true });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const api = await me.api();

      expect((await takenBy(api, order, colleague.id)).status).toBe(403);
      expect((await peopleFor(api, order)).status).toBe(403);
      expect((await rowOf(order)).taken_at).toBeNull();
    });

    it('refuses an order that is not Processed, and one outside the person\'s reach, for the record and for the picker', async () => {
      const { org, customer, admin, stock, me, job } = await processedOrderFor({ record_pickup_for_someone_else: true });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const api = await me.api();
      const draft = await addOrder(org, admin.id, { jobId: job.id }, 'DRAFT', stock);
      const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
      const outside = await addOrder(org, admin.id, { jobId: theirs.id }, 'PROCESSED', stock);

      expect((await takenBy(api, draft, colleague.id)).status).toBe(409);
      expect((await takenBy(api, outside, colleague.id)).status).toBe(404);
      expect((await peopleFor(api, outside)).status).toBe(404);
      expect((await rowOf(draft)).taken_at).toBeNull();
      expect((await rowOf(outside)).taken_at).toBeNull();
    });

    it('refuses a person who is inactive, in another company, or not a person at all, and a body with no person', async () => {
      const { org, me, order } = await processedOrderFor({ record_pickup_for_someone_else: true });
      const other = await newOrg();
      const gone = await fx.addUser(org, `gone${++sequence}`, 'TECHNICIAN');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      const stranger = await fx.addUser(other.org, `stranger${++sequence}`, 'TECHNICIAN');
      const api = await me.api();

      for (const takenById of [gone.id, stranger.id, randomUUID()]) {
        expect((await takenBy(api, order, takenById)).status, takenById).toBe(400);
      }
      expect((await api.post(`/api/logistic-orders/${order}/taken-by`, {})).status).toBe(400);
      expect((await rowOf(order)).taken_at).toBeNull();

      const taker = await fx.addUser(org, `taker${++sequence}`, 'TECHNICIAN');
      expect((await takenBy(api, order, taker.id)).status).toBe(200);
    });

    it('lists only the company\'s active people for the picker, the order\'s requester first, then by name, a name and an id each', async () => {
      const { org, customer, stock, me, job } = await processedOrderFor({ record_pickup_for_someone_else: true });
      const other = await newOrg();
      const zed = await fx.addUser(org, `zed${++sequence}`, 'TECHNICIAN');
      const requester = await fx.addUser(org, `requester${++sequence}`, 'TECHNICIAN');
      const gone = await fx.addUser(org, `gone${++sequence}`, 'TECHNICIAN');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      const stranger = await fx.addUser(other.org, `stranger${++sequence}`, 'TECHNICIAN');
      const order = await addOrder(org, requester.id, { jobId: job.id }, 'PROCESSED', stock);

      const res = await peopleFor(await me.api(), order);

      expect(res.status).toBe(200);
      const ids = (res.body.people as { id: string }[]).map((p) => p.id);
      expect(ids[0]).toBe(requester.id);
      expect(ids).toContain(zed.id);
      expect(ids).toContain(me.id);
      expect(ids).not.toContain(gone.id);
      expect(ids).not.toContain(stranger.id);
      const rest = (res.body.people as { name: string }[]).slice(1).map((p) => p.name);
      expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
      expect(res.body.people[0]).toEqual({ id: requester.id, name: await nameOf(requester.id), requester: true });
      expect(Object.keys(res.body.people[1]).sort()).toEqual(['id', 'name', 'requester']);
      expect(customer).toBeTruthy();
    });
  });

  describe('what the order\'s own answer offers', () => {
    it('lists pick_up and record_pickup on a Processed order for a person holding the switches, and neither once it is taken', async () => {
      const { org, me, order } = await processedOrderFor({ pick_up_staged_items: true, record_pickup_for_someone_else: true });
      const api = await me.api();

      const before = (await api.get(`/api/logistic-orders/${order}`)).body;
      expect(before.actions).toEqual(expect.arrayContaining(['pick_up', 'record_pickup']));
      expect(before.takenBy).toBeNull();
      expect(before.takenAt).toBeNull();

      expect((await takenByMe(api, order)).status).toBe(200);
      const after = (await api.get(`/api/logistic-orders/${order}`)).body;
      expect(after.actions).not.toContain('pick_up');
      expect(after.actions).not.toContain('record_pickup');
      expect(org).toBeTruthy();
    });

    it('lists each action only with its own switch, and neither without them, whatever the order write switches are', async () => {
      const mine = await processedOrderFor({ pick_up_staged_items: true });
      const theirs = await processedOrderFor({ record_pickup_for_someone_else: true });
      const none = await processedOrderFor({ create_logistic_orders: true, edit_logistic_orders: true, process_logistic_orders: true, approve_logistic_orders: true });

      const a = (await (await mine.me.api()).get(`/api/logistic-orders/${mine.order}`)).body.actions as string[];
      const b = (await (await theirs.me.api()).get(`/api/logistic-orders/${theirs.order}`)).body.actions as string[];
      const c = (await (await none.me.api()).get(`/api/logistic-orders/${none.order}`)).body.actions as string[];

      expect(a.includes('pick_up') && !a.includes('record_pickup')).toBe(true);
      expect(b.includes('record_pickup') && !b.includes('pick_up')).toBe(true);
      expect(c.includes('pick_up') || c.includes('record_pickup')).toBe(false);
    });

    it('lists neither before Processed, nor on a cancelled or returned order', async () => {
      const { org, admin, stock, me, job } = await processedOrderFor({ pick_up_staged_items: true, record_pickup_for_someone_else: true });
      const api = await me.api();

      for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'RETURNED'] as const) {
        const order = await addOrder(org, admin.id, { jobId: job.id }, status, stock);
        const actions = (await api.get(`/api/logistic-orders/${order}`)).body.actions as string[];
        expect(actions.includes('pick_up') || actions.includes('record_pickup'), status).toBe(false);
      }
    });
  });
});
