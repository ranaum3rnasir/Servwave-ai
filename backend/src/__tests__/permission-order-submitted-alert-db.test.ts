/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.9 - the order-submitted alert goes to Approve logistic orders holders, with its fallback.

   When a logistic order is submitted the bell alert goes to every "someone" who holds Approve logistic orders: active, able to
   reach the order (the order's own read reach), and not the person who submitted it. The order's people and the job's people are
   never added, and no role name decides anything: a person on a role called Admin with Approve off is not told. When no such
   holder exists it goes to the Manage roles and permissions holders under the same test, with the line "Nobody can approve this
   order"; a chain that ends with nobody is logged and nothing is sent. Bell only. The order-approved alert to the order's creator
   is unchanged.

   Everything goes through the real submit route, as people on custom roles built from the catalog. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. The client holds ONE connection, as the hosted database does. Every org
   it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One client holding ONE connection, as the hosted database's does: a query on the global client from inside a
// transaction waits for a second connection that never comes, which a local pool of several hides.
const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  let client: unknown;
  if (dbUrl) {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '30');
    client = new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  }
  return { realClient: client as PrismaClient | undefined };
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
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import * as email from '../lib/email';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** A switch and every switch it needs on, read from the catalog. */
function withRequires(key: string, into: Record<string, SwitchValue> = {}): Record<string, SwitchValue> {
  const entry = SWITCH_CATALOG.find((s) => s.key === key)!;
  into[key] = true;
  for (const needed of entry.requires) withRequires(needed, into);
  return into;
}

const REACH_ALL = { view_jobs: true, view_leads: true, jobs_scope: 'all', leads_scope: 'all' } as const;
const REACH_ATTACHED = { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' } as const;
const APPROVER = { ...withRequires('approve_logistic_orders'), ...withRequires('view_logistic_orders') };
const MANAGER = { ...withRequires('manage_roles_and_permissions'), ...withRequires('view_logistic_orders') };
const MAKER = { ...withRequires('create_logistic_orders'), ...withRequires('view_logistic_orders'), ...REACH_ALL };

const WHY = 'Nobody can approve this order.';

suite('the order-submitted alert (real database)', () => {
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
  afterEach(() => vi.restoreAllMocks());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A company whose built-in Admin is gone, so only the people a case builds can be told. */
  async function quietOrg() {
    const world = await fx.newOrg();
    orgs.push(world.org);
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  /** A person on a fresh custom role (named as asked) holding exactly these switch values, everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, opts: { base?: Role; label?: string } = {}) {
    const key = `order-alert-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    if (opts.label) await db.customRole.update({ where: { id: role.id }, data: { label: opts.label } });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${++sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
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

  /** A draft order on the job, made by the person through the route. */
  async function draftOrder(api: Api, org: string, jobId: string): Promise<string> {
    const stock = await addStockedItem(org);
    const created = await api.post('/api/logistic-orders', { job_id: jobId, lines: [{ item_id: stock.item, qty: 1, from_location_id: stock.location }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  async function submit(api: Api, orderId: string) {
    const res = await api.post(`/api/logistic-orders/${orderId}/submit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await reviewAttentionSettled();
  }

  /** Who an order's submitted alert reached, with how, plus how many alerts (events) there were. */
  async function reached(orderId: string, verb = 'lo.submitted') {
    const events = await db.notification.findMany({ where: { verb, object_id: orderId }, select: { id: true } });
    const rows = await db.notificationRecipient.findMany({
      where: { notification: { verb, object_id: orderId } },
      select: { recipient_id: true, priority: true, needs_action: true, notification: { select: { body: true, title: true } } },
    });
    return {
      events: events.length,
      ids: rows.map((r) => r.recipient_id).sort(),
      rows: rows.map((r) => ({ id: r.recipient_id, priority: r.priority, needsAction: r.needs_action, body: r.notification.body ?? '', title: r.notification.title })),
    };
  }

  it('tells the active Approve holders who can reach the order and nobody else, whatever the roles are called', async () => {
    const { org, customer } = await quietOrg();
    const crew = await personWith(org, { ...REACH_ATTACHED });
    const soldBy = await personWith(org, { ...REACH_ALL });
    const dispatcher = await personWith(org, { ...REACH_ALL });
    const maker = await personWith(org, MAKER);

    const everywhere = await personWith(org, { ...APPROVER, ...REACH_ALL });
    const onTheJob = await personWith(org, { ...APPROVER, ...REACH_ATTACHED });
    const notOnTheJob = await personWith(org, { ...APPROVER, ...REACH_ATTACHED });
    const gone = await personWith(org, { ...APPROVER, ...REACH_ALL });
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    // A role called Admin, based on the Admin box, with Approve switched off: everything else on, and Manage roles too.
    const adminNamed = await personWith(org, { ...MANAGER, ...REACH_ALL, approve_logistic_orders: false }, { base: 'ADMIN', label: 'Admin' });

    const other = await fx.newOrg();
    orgs.push(other.org);
    const elsewhere = await personWith(other.org, { ...APPROVER, ...REACH_ALL });

    const job = await fx.addJob(org, customer, { crew: [crew.id, onTheJob.id], soldBy: soldBy.id, dispatcher: dispatcher.id, createdBy: maker.id });
    const orderId = await draftOrder(await maker.api(), org, job.id);
    await submit(await maker.api(), orderId);

    const told = await reached(orderId);
    expect(told.ids).toEqual([everywhere.id, onTheJob.id].sort());
    expect(told.events).toBe(1);
    // The people who must act are interrupted and asked to; nobody is covering, so there is no why line.
    expect(told.rows.every((r) => r.priority === 'INTERRUPT' && r.needsAction && r.body.includes(WHY) === false)).toBe(true);
    for (const outsider of [crew, soldBy, dispatcher, maker, notOnTheJob, gone, adminNamed, elsewhere]) expect(told.ids).not.toContain(outsider.id);
  });

  it('never tells the person who submitted it, and covers with the next holder', async () => {
    const { org, customer } = await quietOrg();
    const both = await personWith(org, { ...MAKER, ...APPROVER });
    const second = await personWith(org, { ...APPROVER, ...REACH_ALL });
    const job = await fx.addJob(org, customer);
    const orderId = await draftOrder(await both.api(), org, job.id);
    await submit(await both.api(), orderId);

    expect((await reached(orderId)).ids).toEqual([second.id]);
  });

  it('tells the Manage roles and permissions holders who can reach the order, with the why line, when nobody else can approve it', async () => {
    const { org, customer } = await quietOrg();
    // The submitter is the only Approve holder; a second holder cannot reach the order; a third is gone.
    const both = await personWith(org, { ...MAKER, ...APPROVER });
    const cannotReach = await personWith(org, { ...APPROVER, ...REACH_ATTACHED });
    const gone = await personWith(org, { ...APPROVER, ...REACH_ALL });
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    const manager = await personWith(org, { ...MANAGER, ...REACH_ALL });
    const managerCannotReach = await personWith(org, { ...MANAGER, ...REACH_ATTACHED });
    const crew = await personWith(org, { ...REACH_ALL });
    const job = await fx.addJob(org, customer, { crew: [crew.id] });
    const orderId = await draftOrder(await both.api(), org, job.id);
    await submit(await both.api(), orderId);

    const told = await reached(orderId);
    expect(told.ids).toEqual([manager.id]);
    expect(told.rows[0]).toMatchObject({ priority: 'INTERRUPT', needsAction: true });
    expect(told.rows[0]!.body).toContain(WHY);
    for (const outsider of [both, cannotReach, gone, managerCannotReach, crew]) expect(told.ids).not.toContain(outsider.id);
  });

  it('logs a chain that ends with nobody and sends nothing', async () => {
    const { org, customer } = await quietOrg();
    const maker = await personWith(org, { ...MAKER, ...MANAGER });
    const approverElsewhere = await personWith(org, { ...APPROVER, ...REACH_ATTACHED });
    const job = await fx.addJob(org, customer);
    const orderId = await draftOrder(await maker.api(), org, job.id);
    const warn = vi.spyOn(logger, 'warn');
    await submit(await maker.api(), orderId);

    expect((await reached(orderId)).ids).toEqual([]);
    expect(await db.notification.count({ where: { object_id: orderId, verb: 'lo.submitted' } })).toBe(0);
    expect(approverElsewhere.id).toBeTruthy();
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('nobody to tell'));
    expect(lines).toHaveLength(1);
    expect((lines[0] as unknown[])[1]).toMatchObject({ alert: 'logistic order submitted alert', organizationId: org });
  });

  it('is a bell alert only: no email goes out', async () => {
    const { org, customer } = await quietOrg();
    const maker = await personWith(org, MAKER);
    await personWith(org, { ...APPROVER, ...REACH_ALL });
    const job = await fx.addJob(org, customer);
    const orderId = await draftOrder(await maker.api(), org, job.id);
    const mocked = Object.values(email).filter((fn) => vi.isMockFunction(fn));
    expect(mocked.length).toBeGreaterThan(0);
    mocked.forEach((fn) => vi.mocked(fn).mockClear());
    await submit(await maker.api(), orderId);

    expect((await reached(orderId)).ids).toHaveLength(1);
    expect(mocked.flatMap((fn) => vi.mocked(fn).mock.calls)).toEqual([]);
  });

  it('refuses a second submit of the same order and sends no second alert', async () => {
    const { org, customer } = await quietOrg();
    const maker = await personWith(org, MAKER);
    const approver = await personWith(org, { ...APPROVER, ...REACH_ALL });
    const job = await fx.addJob(org, customer);
    const api = await maker.api();
    const orderId = await draftOrder(api, org, job.id);
    await submit(api, orderId);

    const again = await api.post(`/api/logistic-orders/${orderId}/submit`);
    expect(again.status).toBe(409);
    await reviewAttentionSettled();
    const told = await reached(orderId);
    expect(told.ids).toEqual([approver.id]);
    expect(told.events).toBe(1);
  });

  it('keeps the order-approved alert to the creator as it was', async () => {
    const { org, customer } = await quietOrg();
    const maker = await personWith(org, MAKER);
    const approver = await personWith(org, { ...APPROVER, ...REACH_ALL });
    const job = await fx.addJob(org, customer);
    const orderId = await draftOrder(await maker.api(), org, job.id);
    await submit(await maker.api(), orderId);

    const approved = await (await approver.api()).post(`/api/logistic-orders/${orderId}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await reviewAttentionSettled();
    const told = await reached(orderId, 'lo.approved');
    expect(told.ids).toEqual([maker.id]);
    expect(told.rows[0]).toMatchObject({ priority: 'INTERRUPT', needsAction: false });
  });
});
