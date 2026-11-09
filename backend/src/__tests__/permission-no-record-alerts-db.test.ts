/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.29 - the alerts that have no record, on M6's two-lane chain from its second step.

   The payments-account alerts (payments active, payouts enabled, more information needed, payments paused, payments disconnected,
   connect your bank), Invite accepted, Low stock, Item on backorder, Purchase order partly received, Staging has no area and a stock
   approval request used to go to "every Admin" (and every Dispatcher for the stock ones) by role. Now each goes to the active holders
   of its own switch (Create purchase orders; Edit stock), or the Admins themselves for the payments account (Company settings retired, 36b, M17), else the company's Admins with a line saying what nobody
   could do. Invite accepted goes to the Admins themselves: inviting people is the Admin flag's alone (AL-18). An Admin holds every
   switch, so an Admin is always found among a step's holders and the "nobody could" line is only reached with no active Admin. There is no lane 1, no Dispatcher step and no copy: a person who holds an
   "Alert me about every ..." switch is not told, an Admin-role person with the switch off is not told, and the person who did it
   never is. Nobody comes from a role name.

   One table drives all twelve verbs, so each row of the chain is checked the same way for each, and each goes through its real door:
   the stock transfer, price book, purchase order receive and stage routes, the two invite accept routes, the door both writers of the
   payments account share, and the checkout effects (the first card payment). The stock approval route is parked (it answers 404 for
   every caller), so its alert is checked through the function the route calls. The emails that ride beside the money and payments
   account alerts are checked at the end: they go to the same step holders, no role name.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The client holds ONE connection, as the hosted
   database does. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
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
    pooled.searchParams.set('pool_timeout', '10');
    client = new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  }
  return { realClient: client as PrismaClient | undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { ADMINS } from '../lib/permissions/switchHolders';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import * as email from '../lib/email';
import { issueInviteToken } from '../lib/invite-link';
import { CURRENT_TERMS_VERSION, TERMS_URL, PRIVACY_URL } from '../lib/legal';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** A switch and every switch it needs on, read from the catalog (a person who holds Create purchase orders also holds View purchase orders). */
function withRequires(key: string, into: Record<string, SwitchValue> = {}): Record<string, SwitchValue> {
  const entry = SWITCH_CATALOG.find((s) => s.key === key)!;
  into[key] = true;
  for (const needed of entry.requires) withRequires(needed, into);
  return into;
}

// The last fallback is the company's Admins (AL-18): a manager here is an Admin, by the flag.
const managerValues: Record<string, SwitchValue> = { is_admin: true };
/** What makes a person a holder of a door's step: its switch and what that needs, or the Admin flag for a step that is the Admins. */
const holderValues = (step: string): Record<string, SwitchValue> => (step === ADMINS ? { is_admin: true } : withRequires(step));
const COPY_SWITCHES = ['alert_every_lead', 'alert_every_job', 'alert_every_estimate', 'alert_every_invoice'];
const copyValues = Object.fromEntries(COPY_SWITCHES.flatMap((k) => Object.entries(withRequires(k))));

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;
type Priority = 'FEED' | 'INTERRUPT';

/** What a door is handed to raise its alert. */
interface Ctx {
  org: string;
  customer: string;
  /** The person who takes the action, or null when no person does (a processor's report, a sweep). */
  actor: Person | null;
  api: Api | null;
}

/** One row of the table: a verb, the switch that makes its holders the people who act, and the door that raises it. */
interface Door {
  verb: string;
  step: string;
  /** What "nobody can ..." says. */
  stepWords: string;
  priority: Priority;
  needsAction: boolean;
  /** What the person who takes the action holds to reach the door (a route). Null when no person takes it. */
  actorValues: Record<string, SwitchValue> | null;
  /**
   * False when the alert is raised by the system and names no actor even though a person's action caused it: a stock level crossing
   * its minimum is nobody's action, so the person whose movement crossed it is told like any other holder.
   */
  skipsActor?: boolean;
  fire: (c: Ctx) => Promise<void>;
}

suite('the alerts that have no record (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM stock_movements WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM stock_balances WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM stage_audit_entries WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM job_stage_lines WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM job_stages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM purchase_order_lines WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM purchase_orders WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM price_book_items WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM inventory_locations WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM terms_acceptances WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `no-record-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...switchValues }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    orgs.push(world.org);
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  /** Who an alert reached, with how: one entry per recipient row of the verb in the company. */
  async function reached(org: string, verb: string) {
    const rows = await db.notificationRecipient.findMany({
      where: { organization_id: org, notification: { verb } },
      select: { recipient_id: true, priority: true, needs_action: true, notification: { select: { body: true, title: true } } },
    });
    return rows.map((r) => ({ id: r.recipient_id, priority: r.priority, needsAction: r.needs_action, body: r.notification.body ?? '', title: r.notification.title }));
  }

  // ── the doors ────────────────────────────────────────────────────────────────

  /** A tracked catalog item, two shelves and some stock of it. */
  async function stocked(org: string, opts: { onHand?: number; min?: number } = {}) {
    const item = randomUUID();
    const from = randomUUID();
    const to = randomUUID();
    await db.priceBookItem.create({
      data: { id: item, organization_id: org, name: `Hinge ${item.slice(0, 6)}`, sku: `SKU-${item.slice(0, 8)}`, unit_price: 10, track_inventory: true },
    });
    for (const id of [from, to]) {
      await db.inventoryLocation.create({ data: { id, organization_id: org, name: `Shelf ${id.slice(0, 6)}`, type: 'warehouse' } });
    }
    await db.stockBalance.create({ data: { organization_id: org, item_id: item, location_id: from, on_hand: opts.onHand ?? 5, min: opts.min ?? 4 } });
    return { item, from, to };
  }

  const accountDoor = (verb: string, priority: Priority, needsAction: boolean): Door => ({
    verb, step: ADMINS, stepWords: 'change company settings', priority, needsAction, actorValues: null,
    fire: async (c) => {
      const { sendAccountNotices } = await import('../lib/payments-notifications.js');
      await sendAccountNotices([{ verb, organizationId: c.org, dedup: `acct_${randomUUID()}`, emailAdmins: false }], 'Acme Doors');
    },
  });

  const doors: Door[] = [
    accountDoor('billing.payments_activated', 'FEED', false),
    accountDoor('billing.payouts_activated', 'FEED', false),
    accountDoor('billing.payments_action_needed', 'INTERRUPT', true),
    accountDoor('billing.payments_paused', 'INTERRUPT', true),
    accountDoor('billing.payments_disconnected', 'INTERRUPT', true),
    {
      // The first card payment on the connected account, through the checkout effects every payment event ends in.
      verb: 'billing.payouts_pending_first_payment', step: ADMINS, stepWords: 'change company settings', priority: 'FEED', needsAction: false, actorValues: null,
      fire: async (c) => {
        const { runCheckoutEffects, CHECKOUT_INVOICE_SELECT } = await import('../services/payment-reconciler/checkout-effects.js');
        const job = await fx.addJob(c.org, c.customer, { status: 'SCHEDULED' });
        const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id });
        const payment = await db.payment.create({
          data: { invoice_id: invoice.id, amount: 25, method: 'CARD', stripe_account_id: 'acct_first_payment', paid_at: new Date() } as never,
          select: { id: true },
        });
        const row = await db.invoice.findFirstOrThrow({ where: { id: invoice.id }, select: CHECKOUT_INVOICE_SELECT });
        await runCheckoutEffects({
          settledRefunds: [], externalRefunds: [], unappliedCaptures: [], disputeNotices: [], expireCheckouts: [], bankNotices: [],
          settledPayments: [], reopenedInvoices: [], accountStatusWritten: false, accountNotices: [], failedRefunds: [],
          bookedPayments: [{
            paymentId: payment.id, invoiceId: invoice.id, method: 'CARD', state: 'SUCCEEDED', amount: 25, paysInFull: false, newBalance: 75,
            depositEstimateId: null, approvedEstimateId: null, closedEstimateId: null,
          }],
        } as never, { organization: { id: c.org, name: 'Acme Doors', stripe_payouts_enabled: false }, account: 'acct_first_payment', paymentIntentId: null, invoice: row });
      },
    },
    {
      // Both routes that finish an invitation (a password, or Google). The person who accepted is the actor.
      verb: 'team.invite_accepted', step: ADMINS, stepWords: 'invite users', priority: 'FEED', needsAction: false, actorValues: {},
      fire: async (c) => {
        const invitee = c.actor!;
        // The person's one live invite, as an admin's invitation makes it.
        const inviteToken = await issueInviteToken(invitee);
        vi.mocked(supabaseAdmin.auth.admin.createUser).mockResolvedValue({ data: { user: { id: randomUUID() } }, error: null } as never);
        const app = await fx.listener();
        const res = await request(app).post('/api/auth/accept-invite')
          .send({ token: inviteToken, password: 'sup3rsecret99', accepted_terms: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await reviewAttentionSettled();
      },
    },
    {
      verb: 'inventory.low_stock', step: 'create_purchase_orders', stepWords: 'create purchase orders', priority: 'FEED', needsAction: false,
      actorValues: { ...withRequires('edit_stock') }, skipsActor: false,
      fire: async (c) => {
        const stock = await stocked(c.org);
        const res = await c.api!.post('/api/inventory/transfer', { itemId: stock.item, fromId: stock.from, toId: stock.to, qty: 2 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await reviewAttentionSettled();
      },
    },
    {
      verb: 'inventory.backorder', step: 'create_purchase_orders', stepWords: 'create purchase orders', priority: 'FEED', needsAction: false,
      actorValues: { ...withRequires('edit_price_book_items') },
      fire: async (c) => {
        const item = randomUUID();
        await db.priceBookItem.create({ data: { id: item, organization_id: c.org, name: `Closer ${item.slice(0, 6)}`, sku: `SKU-${item.slice(0, 8)}`, unit_price: 10 } });
        const res = await c.api!.patch(`/api/price-book/items/${item}`, { status: 'on_backorder' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await reviewAttentionSettled();
      },
    },
    {
      verb: 'inventory.po_partial', step: 'create_purchase_orders', stepWords: 'create purchase orders', priority: 'FEED', needsAction: false,
      actorValues: { ...withRequires('edit_purchase_orders'), view_jobs: true, jobs_scope: 'all' },
      fire: async (c) => {
        const stock = await stocked(c.org);
        const job = await fx.addJob(c.org, c.customer, { crew: [c.actor!.id] });
        const po = await db.purchaseOrder.create({
          data: { organization_id: c.org, po_number: `PO-${randomUUID().slice(0, 8)}`, vendor: 'Supply Co', status: 'ordered', job_id: job.id },
        });
        const line = await db.purchaseOrderLine.create({
          data: { organization_id: c.org, purchase_order_id: po.id, item_sku: 'SKU', item_name: 'Hinge', uom: 'EA', qty_ordered: 4, qty_received: 0, price_book_item_id: stock.item },
        });
        const res = await c.api!.post('/api/inventory/purchase-orders/receive', {
          poId: po.id, destinationLocationId: stock.to, lines: [{ lineId: line.id, qtyReceived: 1 }],
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await reviewAttentionSettled();
      },
    },
    {
      verb: 'inventory.staging_no_area', step: 'edit_stock', stepWords: 'edit stock', priority: 'FEED', needsAction: false,
      actorValues: { ...withRequires('edit_stock'), view_jobs: true, jobs_scope: 'all' },
      fire: async (c) => {
        const job = await fx.addJob(c.org, c.customer, { crew: [c.actor!.id] });
        const stage = await db.jobStage.create({
          data: { organization_id: c.org, job_id: job.id, job_number: 'J-1', customer: 'Customer', site: 'Site', trade: 'Locksmith', status: 'pending', staged_area: null },
        });
        const res = await c.api!.patch(`/api/inventory/job-stages/${stage.id}`, { status: 'complete' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await reviewAttentionSettled();
      },
    },
    {
      // The stock approval routes are parked (404 for everyone), so the function the route calls is the door.
      verb: 'inventory.stock_approval_requested', step: 'edit_stock', stepWords: 'edit stock', priority: 'INTERRUPT', needsAction: true,
      actorValues: {},
      fire: async (c) => {
        const { emitStockApprovalRequested } = await import('../services/notifications/inventoryEmit.js');
        emitStockApprovalRequested(c.org, c.actor!.id, randomUUID(), 'Hinge');
        await reviewAttentionSettled();
      },
    },
  ];

  /** The whole situation of one case: a quiet company, the actor, and the door's request context. */
  async function setUp(door: Door, actorHoldsStep = false) {
    const world = await quietOrg();
    let actor: Person | null = null;
    let api: Api | null = null;
    if (door.actorValues) {
      actor = await personWith(world.org, { ...door.actorValues, ...(actorHoldsStep ? holderValues(door.step) : {}) });
      api = await fx.signedInAs(actor);
    }
    return { ...world, actor, api };
  }

  const fireIn = (door: Door, c: Awaited<ReturnType<typeof setUp>>) => door.fire({ org: c.org, customer: c.customer, actor: c.actor, api: c.api });

  describe.each(doors.map((d) => [d.verb, d] as const))('%s', (verb, door) => {
    it('tells the active holders of its switch, an Admin included, and nobody else, with no copies and no why line', async () => {
      const c = await setUp(door);
      const holderA = await personWith(c.org, holderValues(door.step));
      const holderB = await personWith(c.org, holderValues(door.step), 'TECHNICIAN');
      // Not told: the switch is off for an Admin-role person, a Dispatcher-role person, and a person who holds every "Alert me about
      // every ..." switch. An Admin (the flag) holds every switch, so they are a holder of every step and told.
      const adminSwitchOff = await personWith(c.org, {}, 'ADMIN');
      const dispatcherRole = await personWith(c.org, {}, 'DISPATCHER');
      const manager = await personWith(c.org, managerValues);
      const follower = await personWith(c.org, copyValues);
      // Not told: a holder who was deactivated, and a holder in another company.
      const gone = await personWith(c.org, holderValues(door.step));
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      const other = await quietOrg();
      const stranger = await personWith(other.org, holderValues(door.step));

      await fireIn(door, c);

      const got = await reached(c.org, verb);
      expect(got.map((r) => r.id).sort(), 'the holders of the switch, an Admin among them').toEqual([holderA.id, holderB.id, manager.id].sort());
      for (const who of [adminSwitchOff, dispatcherRole, follower, gone]) expect(got.map((r) => r.id)).not.toContain(who.id);
      expect(await reached(other.org, verb), 'another company is never told').toEqual([]);
      expect(stranger.id).toBeTruthy();
      for (const r of got) {
        expect(r.priority, 'priority').toBe(door.priority);
        expect(r.needsAction, 'asked to act').toBe(door.needsAction);
        expect(r.body, 'a holder of the switch is told without a why line').not.toMatch(/nobody can/i);
      }
      if (door.actorValues && door.skipsActor !== false) expect(got.map((r) => r.id)).not.toContain(c.actor!.id);
    }, 60_000);

    it('reaches the Admins, as holders of the step, when nobody on a custom role holds the switch, with no "nobody can" line', async () => {
      const c = await setUp(door);
      const managerA = await personWith(c.org, managerValues);
      const managerB = await personWith(c.org, managerValues, 'SALES');
      const adminSwitchOff = await personWith(c.org, {}, 'ADMIN');
      const follower = await personWith(c.org, copyValues);
      const gone = await personWith(c.org, managerValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });

      await fireIn(door, c);

      const got = await reached(c.org, verb);
      expect(got.map((r) => r.id).sort()).toEqual([managerA.id, managerB.id].sort());
      for (const who of [adminSwitchOff, follower, gone]) expect(got.map((r) => r.id)).not.toContain(who.id);
      for (const r of got) {
        // An Admin holds the step's switch, so the chain stops at the step: nothing says nobody could.
        expect(r.body).not.toContain(`Nobody can ${door.stepWords}.`);
        expect(r.priority).toBe(door.priority);
        expect(r.needsAction).toBe(door.needsAction);
      }
    }, 60_000);

    it('logs the gap and writes no alert when nobody at all can be told', async () => {
      const c = await setUp(door);
      await personWith(c.org, {}, 'ADMIN');
      await personWith(c.org, copyValues);
      const warn = vi.spyOn(logger, 'warn');

      await fireIn(door, c);

      expect(await reached(c.org, verb)).toEqual([]);
      const logged = warn.mock.calls.filter((call) => /nobody to tell/.test(String(call[0])) && (call as unknown[])[1] && ((call as unknown[])[1] as { organizationId?: string }).organizationId === c.org);
      expect(logged.length, 'the empty chain is logged with the company').toBeGreaterThan(0);
      expect(JSON.stringify(logged), 'nothing of the customer in the log').not.toMatch(/Payer|Pat/);
    }, 60_000);

    it('never tells the person who did it, and a person found by both steps gets one alert', async () => {
      const c = await setUp(door, true);
      const both = await personWith(c.org, { ...holderValues(door.step), ...managerValues });
      const holder = await personWith(c.org, holderValues(door.step));

      await fireIn(door, c);

      const got = await reached(c.org, verb);
      if (door.actorValues && door.skipsActor !== false) expect(got.map((r) => r.id), 'the actor holds the switch and is not told').not.toContain(c.actor!.id);
      // A stock level crossing its minimum is the system's alert: the person whose movement crossed it is a holder like any other.
      if (door.skipsActor === false) expect(got.map((r) => r.id)).toContain(c.actor!.id);
      expect(got.filter((r) => r.id === both.id), 'one alert for a person found twice').toHaveLength(1);
      expect(got.map((r) => r.id)).toContain(holder.id);
      const rows = await db.notification.count({ where: { organization_id: c.org, verb } });
      expect(rows, 'one alert, not one per step').toBe(1);
    }, 60_000);
  });

  // ── a retried event ──────────────────────────────────────────────────────────

  describe('a retried event (the processor sends it again)', () => {
    it('keeps its key on the first alert and produces nothing the second time', async () => {
      const { alertSwitchHolders } = await import('../services/notifications/noRecordAlerts.js');
      const one = await quietOrg();
      const admin = await personWith(one.org, managerValues);
      const args = (org: string, key: string) => ({
        verb: 'billing.payments_paused' as const, organizationId: org, actorId: null,
        object: { type: 'ORGANIZATION', id: org, label: 'Acme Doors' }, dedupKey: key,
      });

      expect(await alertSwitchHolders(args(one.org, 'paused:1'))).toEqual([admin.id]);
      expect(await alertSwitchHolders(args(one.org, 'paused:1')), 'replay of an alert that went to the Admins').toEqual([]);
      // A second Admin appearing afterwards does not make the retry tell anyone: the event was already told.
      await personWith(one.org, managerValues);
      expect(await alertSwitchHolders(args(one.org, 'paused:1'))).toEqual([]);
      expect(await db.notification.count({ where: { organization_id: one.org, verb: 'billing.payments_paused' } })).toBe(1);
    }, 60_000);
  });

  // ── the emails ───────────────────────────────────────────────────────────────

  describe('the owner emails that ride beside the alerts', () => {
    const notice = (org: string, invoiceId: string | null, key: string) => ({
      verb: 'billing.disputed', organizationId: org,
      object: invoiceId ? { type: 'INVOICE' as const, id: invoiceId, label: 'I-EMAIL' } : { type: 'ORGANIZATION' as const, id: org, label: 'Acme Doors' },
      data: { amount: '300.00' }, dedupKey: key, actionLabel: 'Open the invoice',
    });
    const sentTo = () => vi.mocked(email.sendOwnerPaymentNoticeEmail).mock.calls.map((c) => c[0].to).sort();

    it('goes to the Access Billing holders who can open the invoice, an Admin included, not to Admin-role people, the Dispatcher or the copy holders', async () => {
      const { notifyOwners } = await import('../lib/owner-payment-notices.js');
      const { org, customer } = await quietOrg();
      const opens = { view_jobs: true, jobs_scope: 'all', view_invoices: true, leads_scope: 'all' };
      const biller = await personWith(org, { ...withRequires('access_billing'), ...opens });
      const noInvoice = await personWith(org, withRequires('access_billing'));
      const adminSwitchOff = await personWith(org, opens, 'ADMIN');
      const dispatcher = await personWith(org, { ...opens, can_be_dispatcher: true });
      const follower = await personWith(org, { ...opens, ...copyValues });
      const manager = await personWith(org, managerValues);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', dispatcher: dispatcher.id });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      vi.mocked(email.sendOwnerPaymentNoticeEmail).mockClear();

      await notifyOwners(notice(org, invoice.id, `dispute:${randomUUID()}`));

      const addressOf = async (p: Person) => p.email;
      // An Admin (the flag) holds Access Billing and opens every invoice.
      expect(sentTo()).toEqual([await addressOf(biller), await addressOf(manager)].sort());
      for (const who of [noInvoice, adminSwitchOff, dispatcher, follower]) expect(sentTo()).not.toContain(who.email);
    }, 60_000);

    it('goes to the Admins when nobody else who can open the invoice holds Access Billing, and to nobody on a replay', async () => {
      const { notifyOwners } = await import('../lib/owner-payment-notices.js');
      const { org, customer } = await quietOrg();
      const manager = await personWith(org, { ...managerValues, view_invoices: true, leads_scope: 'all', view_jobs: true, jobs_scope: 'all' });
      await personWith(org, {}, 'ADMIN');
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      vi.mocked(email.sendOwnerPaymentNoticeEmail).mockClear();
      const key = `dispute:${randomUUID()}`;

      await notifyOwners(notice(org, invoice.id, key));
      expect(sentTo()).toEqual([manager.email]);

      vi.mocked(email.sendOwnerPaymentNoticeEmail).mockClear();
      await notifyOwners(notice(org, invoice.id, key));
      expect(sentTo(), 'a replay sends nothing').toEqual([]);
    }, 60_000);

    it('goes to the Access Billing holders for money no invoice of the company carries, and sends nothing when the bell reached nobody', async () => {
      const { notifyOwners } = await import('../lib/owner-payment-notices.js');
      const { org } = await quietOrg();
      const biller = await personWith(org, withRequires('access_billing'));
      vi.mocked(email.sendOwnerPaymentNoticeEmail).mockClear();
      await notifyOwners(notice(org, null, `dispute:${randomUUID()}`));
      expect(sentTo()).toEqual([biller.email]);

      const empty = await quietOrg();
      await personWith(empty.org, {}, 'ADMIN');
      vi.mocked(email.sendOwnerPaymentNoticeEmail).mockClear();
      await notifyOwners(notice(empty.org, null, `dispute:${randomUUID()}`));
      expect(sentTo(), 'nobody was told in the bell, so nobody is emailed').toEqual([]);
    }, 60_000);

    it('puts the payments account action-needed email in the hands of the Admins alone, and a replay emails nobody', async () => {
      const { sendAccountNotices } = await import('../lib/payments-notifications.js');
      const covered = await quietOrg();
      const manager = await personWith(covered.org, managerValues);
      // Holds every switch a person can, yet is no Admin: not emailed (setting up the company is the Admin flag's alone, 36b).
      const everything = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
      const widest = await personWith(covered.org, everything);
      const adminSwitchOff = await personWith(covered.org, {}, 'ADMIN');
      const recipients = () => vi.mocked(email.sendPaymentsActionNeededEmail).mock.calls.map((c) => c[0].to).sort();

      vi.mocked(email.sendPaymentsActionNeededEmail).mockClear();
      const key = `a:${randomUUID()}`;
      await sendAccountNotices([{ verb: 'billing.payments_action_needed', organizationId: covered.org, dedup: key, emailAdmins: true }], 'Acme Doors');
      expect(recipients()).toEqual([manager.email]);
      expect(recipients()).not.toContain(widest.email);
      expect(recipients()).not.toContain(adminSwitchOff.email);
      vi.mocked(email.sendPaymentsActionNeededEmail).mockClear();
      await sendAccountNotices([{ verb: 'billing.payments_action_needed', organizationId: covered.org, dedup: key, emailAdmins: true }], 'Acme Doors');
      expect(recipients(), 'a replay of an alert the Admins were told emails nobody').toEqual([]);
    }, 60_000);
  });

  // ── the second invite door ───────────────────────────────────────────────────

  it('tells the Admins when an invitation is finished with Google, and not when a returning person signs in', async () => {
    const world = await quietOrg();
    const holder = await personWith(world.org, { is_admin: true });
    const invitee = await fx.addUser(world.org, 'google-invitee', 'TECHNICIAN');
    // The person's one live invite, as an admin's invitation makes it (it gives them has_login when it is sent; a person without it
    // is refused at Google, H2 ticket 22). Finishing it is what makes the first Google sign-in the invitation's acceptance.
    await issueInviteToken(invitee);
    // The consent the invite page records before it hands off to Google.
    await db.termsAcceptance.create({
      data: { user_id: invitee.id, user_email: invitee.email, organization_id: world.org, terms_version: CURRENT_TERMS_VERSION, terms_url: TERMS_URL, privacy_url: PRIVACY_URL },
    });
    const api = await fx.signedInAs(invitee);

    const first = await api.post('/api/auth/google/finalize');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await reviewAttentionSettled();
    expect((await reached(world.org, 'team.invite_accepted')).map((r) => r.id)).toEqual([holder.id]);

    await db.notification.deleteMany({ where: { organization_id: world.org, verb: 'team.invite_accepted' } });
    const again = await (await fx.signedInAs(invitee)).post('/api/auth/google/finalize');
    expect(again.status).toBe(200);
    await reviewAttentionSettled();
    expect(await reached(world.org, 'team.invite_accepted')).toEqual([]);
  }, 60_000);
});
