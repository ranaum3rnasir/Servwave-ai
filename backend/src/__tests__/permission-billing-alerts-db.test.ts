/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.28 - the billing alerts on M6's two-lane chain: Payment received, Partial payment received,
   Invoice overdue, Invoice due soon, Refund issued, Payment disputed, Chargeback received, Card payment could not be applied,
   Invoice voided and Credit applied, and the five money alerts that sit beside them (a bank payment started, cleared or failed; a
   dispute closed; a refund that failed).

   Each used to go to "every Admin" (and, for payments, "every Dispatcher" and the customer owner) by role. Now each goes through the
   chain: lane 1 is the invoice's job or lead people (the job's stored Sold By, crew and Dispatcher, or the lead's Owner, walkthrough
   crew and Dispatcher); lane 2 is who must act (the record's Dispatcher, else the holders of Access Billing who can open the invoice,
   else the company's Admins, stopping at the first step that finds someone); holders of Alert me about every
   invoice and payment get a copy. "Someone" is active, can open the INVOICE and its job or lead, and is not the person who did the
   action. Nobody comes from a role name. A standalone invoice (no job, no estimate with a job or lead) has no lane 1 and starts at
   step 2.

   One table drives all fifteen verbs, so a row of the chain is checked the same way for each, and each goes through its real door:
   the record-payment, void, credit and refund routes (called as people on custom roles holding exactly the switch values under test,
   every other toggle off), the nightly sweep's own function, and the shared notice function every processor event (dispute, bank
   payment, refund, unapplied capture) reports through. The payment webhook itself is covered in its own block at the end. The alert
   goes out after the response, so each route case waits for it. Money is the sensitive part: a lane 1 person who cannot open the
   invoice is not told.

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
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '10');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';
import { getStripeForOrg, listPaymentIntentRefunds } from '../lib/stripe';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What a person needs to be named on a job or a lead at all: to be allowed on a crew, as Sold By or Owner, and as Dispatcher. */
const slots = { can_be_on_crew: true, can_own_leads: true, can_be_dispatcher: true };
/** Opening a job, a lead and an invoice: what "someone" needs for an alert about an invoice on a job or lead. */
const opens = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_invoices: true, ...slots };
/** Opening the job and the lead but NOT the invoice (Invoices View off): the alert names an amount, so this person is not told. */
const opensJobNotInvoice = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', ...slots };
const STEP = 'access_billing';
const COPY = 'alert_every_invoice';
// An Admin (the flag, AL-18): holds every switch, Access Billing and the copy switches included, and opens every invoice. Since the
// Manage roles and permissions switch retired, the chain's last fallback is the Admins, so an Admin is found at the step already.
const adminValues = { ...opens, is_admin: true, view_users: true };
const stepValues = { ...opens, [STEP]: true };

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;
type Priority = 'FEED' | 'INTERRUPT';
type Shape = 'job' | 'standalone' | 'leadDeposit' | 'jobDeposit';

/** The people a case puts on the invoice's job or lead before the action. */
interface Cast {
  org: string;
  customer: string;
  /** The person who takes the action (a route) or just a person with no part in it (a system door). */
  me: Person;
  crew: Person[];
  soldBy?: Person;
  dispatcher?: Person;
  /** The Owner of a lead the job came from, or of the lead a deposit invoice is on. */
  leadOwner?: Person;
  shape?: Shape;
}

/** What the world looks like once built: the invoice the alert is about. */
interface World {
  invoiceId: string;
  number: string;
  jobId: string | null;
  leadId: string | null;
}

/** One row of the table: a verb, and the door that raises it. */
interface Verb {
  verb: string;
  /** The title the bell shows. */
  title: (number: string) => string;
  /** The body the bell shows to a person told as the record's own person (null when the alert has none). */
  body: string | null;
  /** True when a person takes the action (a route), so they are the actor and are never told. */
  byPerson: boolean;
  /** What the actor holds to take the action (a route). */
  actorValues: Record<string, SwitchValue>;
  /** The priority of the record's own people. */
  lane1: Priority;
  /** The priority of the people who must act, and whether they are asked to. */
  lane2: Priority;
  lane2Action: boolean;
  /** The priority of the copies. */
  copy: Priority;
  /** The invoice's state the door needs. */
  prepare: (world: World) => Promise<void>;
  act: (world: World, cast: Cast) => Promise<{ status: number; body: unknown } | void>;
}

/** The answer a route is expected to give: a success. */
const succeeded = (res: { status: number; body: unknown } | void) => {
  if (res) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
};

suite('the billing alerts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    // All the companies in one statement per table, not a round trip per company per table.
    const inOrgs = orgs.map((org) => `'${org}'`).join(', ');
    if (orgs.length) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM credits WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN (${inOrgs}))`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM unapplied_captures WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN (${inOrgs}))`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_bill28_%'`));
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `billing-alert-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await fx.setRoleSwitches(org, key, { ...ALL_OFF, see_prices: true, ...switchValues });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    orgs.push(world.org);
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    await db.organization.update({ where: { id: world.org }, data: { accepted_payment_methods: ['CASH', 'CHECK', 'CARD'] } });
    return world;
  }

  /** The invoice the alert is about, on the job or lead the shape names, ready for a payment, a void, a credit or the sweep. */
  async function build(cast: Cast): Promise<World> {
    const { org, customer } = cast;
    const shape = cast.shape ?? 'job';
    const crew = cast.crew.map((p) => p.id);
    let jobId: string | null = null;
    let leadId: string | null = null;
    let invoice: { id: string };
    if (shape === 'job') {
      const lead = cast.leadOwner ? await fx.addLead(org, customer, { owner: cast.leadOwner.id }) : null;
      const job = await fx.addJob(org, customer, {
        status: 'SCHEDULED', crew, soldBy: cast.soldBy?.id, dispatcher: cast.dispatcher?.id, fromLead: lead?.id, createdBy: cast.me.id,
      });
      jobId = job.id;
      invoice = await fx.addInvoice(org, customer, { jobId: job.id });
    } else if (shape === 'jobDeposit') {
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew, soldBy: cast.soldBy?.id, dispatcher: cast.dispatcher?.id });
      jobId = job.id;
      const estimate = await fx.addEstimate(org, customer, cast.me.id, { jobId: job.id });
      invoice = await fx.addInvoice(org, customer, { estimateId: estimate.id });
    } else if (shape === 'leadDeposit') {
      const lead = await fx.addLead(org, customer, { owner: cast.leadOwner?.id, dispatcher: cast.dispatcher?.id, walkthroughCrew: crew });
      leadId = lead.id;
      const estimate = await fx.addEstimate(org, customer, cast.me.id, { leadId: lead.id });
      invoice = await fx.addInvoice(org, customer, { estimateId: estimate.id });
    } else {
      invoice = await fx.addInvoice(org, customer);
    }
    await db.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT', sent_at: new Date(), public_token: randomUUID() } });
    const row = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { invoice_number: true } });
    return { invoiceId: invoice.id, number: row.invoice_number, jobId, leadId };
  }

  /** A cash payment of $40 on an invoice that is paid (a refund needs a paid invoice). */
  async function takePayment(world: World) {
    await db.invoice.update({ where: { id: world.invoiceId }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } });
    return (
      await db.payment.create({
        data: { invoice_id: world.invoiceId, amount: 40, method: 'CASH', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
        select: { id: true },
      })
    ).id;
  }

  const as = async (cast: Cast) => fx.signedInAs(cast.me);
  const noPrep = async () => undefined;

  /** The door of a processor event: the one function every dispute, bank payment, refund and unapplied-capture notice goes through. */
  const notice = (verb: string, data: Record<string, string>, tag: string) => async (world: World, cast: Cast) => {
    const { notifyOwners } = await import('../lib/owner-payment-notices.js');
    await notifyOwners({
      verb, organizationId: cast.org, object: { type: 'INVOICE', id: world.invoiceId, label: world.number },
      data, dedupKey: `${verb}:${tag}:${world.invoiceId}`, actionLabel: 'Open the invoice',
    });
  };

  const SAYS_OFF = { lane1: 'FEED', lane2: 'FEED', lane2Action: false, copy: 'FEED' } as const;
  const INTERRUPTS = { lane1: 'FEED', lane2: 'INTERRUPT', lane2Action: false, copy: 'INTERRUPT' } as const;
  const ROUTE = { byPerson: true } as const;
  const SYSTEM = { byPerson: false, actorValues: {} } as const;
  const PAY = { amount: 100, method: 'CASH' };

  const table: Verb[] = [
    {
      verb: 'billing.payment_received', ...ROUTE, ...SAYS_OFF, title: (n) => `Payment received for ${n}`, body: null,
      actorValues: { ...opens, record_payments: true, allowed_payment_methods: ['CASH'] },
      prepare: noPrep,
      act: async (world, cast) => (await as(cast)).post(`/api/invoices/${world.invoiceId}/payments`, PAY),
    },
    {
      verb: 'billing.partial_payment', ...ROUTE, ...SAYS_OFF, title: (n) => `Partial payment received for ${n}`, body: null,
      actorValues: { ...opens, record_payments: true, allowed_payment_methods: ['CASH'] },
      prepare: noPrep,
      act: async (world, cast) => (await as(cast)).post(`/api/invoices/${world.invoiceId}/payments`, { ...PAY, amount: 40 }),
    },
    {
      verb: 'billing.voided', ...ROUTE, ...SAYS_OFF, title: (n) => `${n} voided`, body: null,
      actorValues: { ...opens, void_invoices: true },
      prepare: noPrep,
      act: async (world, cast) => (await as(cast)).post(`/api/invoices/${world.invoiceId}/void`, { voided_reason: 'Sent in error' }),
    },
    {
      // The route passes the amount as a number, which the template does not print: the alert has never carried one.
      verb: 'billing.credit_applied', ...ROUTE, ...SAYS_OFF, title: (n) => `Credit applied to ${n}`, body: null,
      actorValues: { ...opens, apply_credits: true },
      prepare: noPrep,
      act: async (world, cast) => (await as(cast)).post(`/api/invoices/${world.invoiceId}/credit`, { amount: 10, reason: 'goodwill' }),
    },
    {
      verb: 'billing.refunded', ...ROUTE, ...INTERRUPTS, title: (n) => `Refund issued for ${n}`, body: null,
      actorValues: { ...opens, refund_payments: true, view_payments: true },
      prepare: noPrep,
      act: async (world, cast) => {
        const payment = await takePayment(world);
        return (await as(cast)).post(`/api/invoices/${world.invoiceId}/refund`, {
          payment_id: payment, amount: 10, reason_category: 'GOODWILL', reason: 'Kept the customer',
        });
      },
    },
    {
      verb: 'billing.invoice_overdue', ...SYSTEM, ...SAYS_OFF, lane2Action: true, title: (n) => `${n} is overdue`, body: null,
      prepare: async (world) => { await db.invoice.update({ where: { id: world.invoiceId }, data: { due_date: new Date(Date.now() - 2 * 86_400_000) } }); },
      act: async () => { await (await import('../services/notifications/invoiceDueCron.js')).runInvoiceDueChecks(new Date()); },
    },
    {
      verb: 'billing.invoice_due_soon', ...SYSTEM, ...SAYS_OFF, lane2Action: true, title: (n) => `${n} is due soon`, body: null,
      prepare: async (world) => { await db.invoice.update({ where: { id: world.invoiceId }, data: { due_date: new Date(Date.now() + 2 * 86_400_000) } }); },
      act: async () => { await (await import('../services/notifications/invoiceDueCron.js')).runInvoiceDueChecks(new Date()); },
    },
    {
      verb: 'billing.disputed', ...SYSTEM, ...INTERRUPTS, title: (n) => `Payment disputed for ${n}`, body: null,
      prepare: noPrep, act: notice('billing.disputed', { amount: '300.00' }, 'dp1'),
    },
    {
      verb: 'billing.chargeback', ...SYSTEM, ...INTERRUPTS, title: (n) => `Chargeback received for ${n}`,
      body: 'This payment was taken back from your ServWave Payments balance.',
      prepare: noPrep, act: notice('billing.chargeback', { amount: '300.00' }, 'dp1'),
    },
    {
      verb: 'billing.payment_unrecorded', ...SYSTEM, ...INTERRUPTS, title: (n) => `Card payment could not be applied to ${n}`,
      body: 'The customer was charged but the amount does not match what this invoice is owed, so no payment was recorded. '
        + 'Check the payment against the invoice before replying to the customer.',
      prepare: noPrep, act: notice('billing.payment_unrecorded', { reason: 'AMOUNT_MISMATCH' }, 'evt1'),
    },
    {
      verb: 'billing.dispute_closed', ...SYSTEM, ...SAYS_OFF, title: (n) => `Dispute won for ${n}`,
      body: 'It was decided in your favor and the payment stands.',
      prepare: noPrep, act: notice('billing.dispute_closed', { amount: '300.00', outcome: 'WON' }, 'dp1'),
    },
    {
      verb: 'billing.bank_payment_started', ...SYSTEM, ...SAYS_OFF, title: (n) => `Bank payment started for ${n}`,
      body: 'It usually takes a few business days to clear.',
      prepare: noPrep, act: notice('billing.bank_payment_started', { amount: '300.00' }, 'evt1'),
    },
    {
      verb: 'billing.bank_payment_cleared', ...SYSTEM, ...SAYS_OFF, title: (n) => `Bank payment cleared for ${n}`, body: null,
      prepare: noPrep, act: notice('billing.bank_payment_cleared', { amount: '300.00' }, 'evt1'),
    },
    {
      verb: 'billing.bank_payment_failed', ...SYSTEM, ...INTERRUPTS, title: (n) => `Bank payment failed for ${n}`,
      body: 'No money moved. We emailed the customer a link to pay again.',
      prepare: noPrep, act: notice('billing.bank_payment_failed', { amount: '300.00', customer_notice: 'sent' }, 'evt1'),
    },
    {
      verb: 'billing.refund_failed', ...SYSTEM, ...INTERRUPTS, title: (n) => `Refund failed for ${n}`,
      body: 'A refund to the customer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.',
      prepare: noPrep, act: notice('billing.refund_failed', { amount: '300.00' }, 'rf1'),
    },
  ];

  /** Take the action as this person (or let the system do it); the alert goes out once the response has. */
  async function take(row: Verb, cast: Cast): Promise<World> {
    const world = await build(cast);
    await row.prepare(world);
    succeeded(await row.act(world, cast));
    await reviewAttentionSettled();
    return world;
  }

  const alertsFor = (verb: string, invoiceId: string) =>
    db.notification.findMany({ where: { object_id: invoiceId, verb }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  /** The why line one person's alert carries (null when it carries none). */
  const whyFor = (rows: Alerts, person: Person) => {
    const alert = rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id));
    return (alert?.data as Record<string, unknown> | null | undefined)?.fallback_reason || null;
  };
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);
  const alertOf = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id));

  describe.each(table.map((row) => [row.verb, row] as const))('%s', (_name, row) => {
    const cast = (org: string, customer: string, me: Person, opts: Partial<Cast> = {}): Cast => ({ org, customer, me, crew: [], ...opts });
    const actor = (org: string) => personWith(org, { ...row.actorValues });

    it('says what it always said, as a bell alert on the invoice, with the priorities it always gave', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const crew = await personWith(org, opens);
      const soldBy = await personWith(org, opens);
      const dispatcher = await personWith(org, opens);

      const world = await take(row, cast(org, customer, me, { crew: [crew], soldBy, dispatcher }));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ object_type: 'INVOICE', category: 'BILLING', title: row.title(world.number), body: row.body });
      // The person at step 1 is the Dispatcher: they are the one asked, and the others are only told.
      expect(rowFor(alerts, soldBy)).toMatchObject({ priority: row.lane1, needs_action: false });
      expect(rowFor(alerts, crew)).toMatchObject({ priority: row.lane1, needs_action: false });
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
    });

    it('with a Dispatcher: the record\'s people and the Dispatcher are alerted, and no step holder; no role list reaches anyone', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opens);
      const crew = await personWith(org, opens);
      const dispatcher = await personWith(org, opens);
      const holder = await personWith(org, stepValues);
      // A Dispatcher-role person and an Admin-role person holding nothing: a role name tells nobody anything now.
      const dispatcherRole = await personWith(org, opens, 'DISPATCHER');
      const adminRole = await personWith(org, opens, 'ADMIN');

      const world = await take(row, cast(org, customer, me, { crew: [crew], soldBy, dispatcher }));

      const got = recipientsOf(await alertsFor(row.verb, world.invoiceId));
      expect(got).toEqual(ids(soldBy, crew, dispatcher));
      for (const who of [holder, dispatcherRole, adminRole, me]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher: the record\'s people plus every Access Billing holder who can open the invoice, an Admin among them; an Admin-role person with the switch off is not one', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opens);
      const holder = await personWith(org, stepValues);
      const secondHolder = await personWith(org, stepValues, 'TECHNICIAN');
      // Based on the Admin role with the step switch off: a role name holds nothing, the switch does.
      const adminSwitchOff = await personWith(org, opens, 'ADMIN');
      const cannotOpenInvoice = await personWith(org, { ...opensJobNotInvoice, [STEP]: true });
      const gone = await personWith(org, stepValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      // An Admin (the flag) holds Access Billing like every switch: a holder of the step, not a later fallback.
      const admin = await personWith(org, adminValues);

      const world = await take(row, cast(org, customer, me, { soldBy }));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      const got = recipientsOf(alerts);
      expect(got).toEqual(ids(soldBy, holder, secondHolder, admin));
      for (const who of [adminSwitchOff, cannotOpenInvoice, gone]) expect(got).not.toContain(who.id);
      // The holders cover for the missing Dispatcher and are told why; the record's own person is not.
      expect(whyFor(alerts, holder)).toBe('This job has no Dispatcher.');
      // An Admin also holds Alert me about every invoice, so they are told once, without the line, and still asked to act.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(rowFor(alerts, admin)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
      expect(whyFor(alerts, soldBy)).toBeNull();
      expect(rowFor(alerts, holder)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
    });

    it('a record person who cannot open the invoice is not told, however they are attached; one who can, is', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldByNoInvoices = await personWith(org, opensJobNotInvoice);
      const crewNoInvoices = await personWith(org, opensJobNotInvoice);
      // A technician-style reach: the invoices of the jobs they are attached to.
      const crewAttached = await personWith(org, { ...opens, jobs_scope: 'attached', leads_scope: 'attached' }, 'TECHNICIAN');
      const holder = await personWith(org, stepValues);

      const world = await take(row, cast(org, customer, me, { soldBy: soldByNoInvoices, crew: [crewNoInvoices, crewAttached] }));

      const got = recipientsOf(await alertsFor(row.verb, world.invoiceId));
      expect(got).toEqual(ids(crewAttached, holder));
      expect(got).not.toContain(soldByNoInvoices.id);
      expect(got).not.toContain(crewNoInvoices.id);
    });

    it('a record person who can open the invoice but not the job is not told either (the chain asks both)', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const invoiceOnly = await personWith(org, { view_invoices: true, jobs_scope: 'all', leads_scope: 'all', ...slots });
      const holder = await personWith(org, stepValues);

      const world = await take(row, cast(org, customer, me, { soldBy: invoiceOnly }));

      const got = recipientsOf(await alertsFor(row.verb, world.invoiceId));
      expect(got).toEqual(ids(holder));
    });

    it('without a Dispatcher and with no other Access Billing holder who can open the invoice: an Admin, who holds the step, asked to act', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const admin = await personWith(org, adminValues);
      const cannotOpenInvoice = await personWith(org, { ...opensJobNotInvoice, [STEP]: true });
      const noSwitch = await personWith(org, opens);

      const world = await take(row, cast(org, customer, me));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(cannotOpenInvoice.id);
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // Found at the step (an Admin holds Access Billing), never as "nobody who can access billing"; and as a holder of the copy
      // switch too, so told once, without a line, still asked to act.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(rowFor(alerts, admin)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
    });

    describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
      const cases: Array<[string, string, boolean, (org: string, me: Person) => Promise<Person>]> = [
        ['is deactivated', "This job's Dispatcher is not available.", true, async (org) => {
          const dispatcher = await personWith(org, opens);
          await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
          return dispatcher;
        }],
        ['did the action', "This job's Dispatcher made this change.", row.byPerson, async (_org, me) => me],
        // Being the job's Dispatcher attaches them to it, but the invoice is a separate door.
        ['cannot open the invoice', "This job's Dispatcher is not available.", true, async (org) => personWith(org, opensJobNotInvoice)],
      ];
      it.each(cases.filter((c) => c[2]))('a Dispatcher who %s', async (_label, line, _applies, makeDispatcher) => {
        const { org, customer } = await quietOrg();
        const me = await actor(org);
        const holder = await personWith(org, stepValues);
        const dispatcher = await makeDispatcher(org, me);

        const world = await take(row, cast(org, customer, me, { dispatcher }));

        const alerts = await alertsFor(row.verb, world.invoiceId);
        expect(recipientsOf(alerts)).toContain(holder.id);
        expect(whyFor(alerts, holder)).toBe(line);
        // The actor is never alerted, even as the job's own Dispatcher.
        if (row.byPerson) expect(recipientsOf(alerts)).not.toContain(me.id);
      });
    });

    it('a standalone invoice has no record people: it goes straight to the Access Billing holders who can open it, with the why line', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const holder = await personWith(org, stepValues);
      const cannotOpen = await personWith(org, { ...opensJobNotInvoice, [STEP]: true });
      const noSwitch = await personWith(org, opens);
      // An Admin holds Access Billing too, so they are one of the holders told.
      const admin = await personWith(org, adminValues);

      const world = await take(row, cast(org, customer, me, { shape: 'standalone' }));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      expect(recipientsOf(alerts)).toEqual(ids(holder, admin));
      for (const who of [cannotOpen, noSwitch]) expect(recipientsOf(alerts)).not.toContain(who.id);
      expect(whyFor(alerts, holder)).toBe('This invoice has no job or lead.');
      // An Admin also holds Alert me about every invoice, so they are told once, without the line, and still asked to act.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(rowFor(alerts, admin)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
      expect(alertOf(alerts, holder)).toMatchObject({ title: row.title(world.number), body: [row.body, 'This invoice has no job or lead.'].filter(Boolean).join('\n') });
    });

    it('a standalone invoice with no other Access Billing holder who can open it goes to an Admin, who holds the step', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const admin = await personWith(org, adminValues);
      const noSwitch = await personWith(org, opens);

      const world = await take(row, cast(org, customer, me, { shape: 'standalone' }));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // Found at the step, never as "nobody who can access billing"; told once, without a line (they hold the copy switch too).
      expect(whyFor(alerts, admin)).toBeNull();
      expect(rowFor(alerts, admin)).toMatchObject({ priority: row.lane2, needs_action: row.lane2Action });
    });

    it('a deposit invoice on a lead reaches the lead\'s Owner, its walkthrough crew and its Dispatcher; one on an estimate\'s job reaches the job\'s people', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const owner = await personWith(org, opens);
      const performer = await personWith(org, opens);
      const leadDispatcher = await personWith(org, opens);
      const holder = await personWith(org, stepValues);

      const onLead = await take(row, cast(org, customer, me, { shape: 'leadDeposit', leadOwner: owner, crew: [performer], dispatcher: leadDispatcher }));
      const leadAlerts = await alertsFor(row.verb, onLead.invoiceId);
      expect(recipientsOf(leadAlerts)).toEqual(ids(owner, performer, leadDispatcher));
      expect(recipientsOf(leadAlerts)).not.toContain(holder.id);

      const soldBy = await personWith(org, opens);
      const onJob = await take(row, cast(org, customer, me, { shape: 'jobDeposit', soldBy, crew: [performer] }));
      const jobAlerts = await alertsFor(row.verb, onJob.invoiceId);
      expect(recipientsOf(jobAlerts)).toEqual(ids(soldBy, performer, holder));
      expect(whyFor(jobAlerts, holder)).toBe('This job has no Dispatcher.');
    });

    it('a person found twice gets one alert', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      // Sold By, crew, step holder and follower at once.
      const everywhere = await personWith(org, { ...stepValues, [COPY]: true });

      const world = await take(row, cast(org, customer, me, { soldBy: everywhere, crew: [everywhere] }));

      const alerts = await alertsFor(row.verb, world.invoiceId);
      expect(recipientsOf(alerts).filter((id) => id === everywhere.id)).toHaveLength(1);
      // ...and found in every lane, they keep the strongest priority and the ask they were given.
      expect(rowFor(alerts, everywhere)).toMatchObject({ priority: row.lane2 === 'INTERRUPT' ? 'INTERRUPT' : row.lane1, needs_action: row.lane2Action });
      // They were found as the record's own person too, so they are told without the why line.
      expect(whyFor(alerts, everywhere)).toBeNull();
    });

    it('copies reach "Alert me about every invoice and payment" holders on invoices they can open, also when there is a Dispatcher, never on invoices they cannot open; a copy never stops the chain', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const dispatcher = await personWith(org, opens);
      const follower = await personWith(org, { ...opens, [COPY]: true });
      // Sees the job but not invoices: Alert me about every invoice needs View invoices, so it can only be set with it on and a narrower scope.
      const blindFollower = await personWith(org, { ...opens, jobs_scope: 'attached', leads_scope: 'attached', [COPY]: true });

      const withDispatcher = await take(row, cast(org, customer, me, { dispatcher }));

      const first = await alertsFor(row.verb, withDispatcher.invoiceId);
      expect(recipientsOf(first)).toEqual(ids(dispatcher, follower));
      expect(recipientsOf(first)).not.toContain(blindFollower.id);
      expect(rowFor(first, follower)).toMatchObject({ priority: row.copy, needs_action: false });

      // No Dispatcher and no other holder of the step: the follower is told as a copy and the chain still goes on, to an Admin.
      const admin = await personWith(org, adminValues);
      const bare = await take(row, cast(org, customer, me));
      expect(recipientsOf(await alertsFor(row.verb, bare.invoiceId))).toEqual(ids(follower, admin));
    });

    it('the why line is on step 2 and step 3 and not on the record\'s people, step 1 or copies', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opens);
      const follower = await personWith(org, { ...opens, [COPY]: true });
      const holder = await personWith(org, stepValues);
      const dispatcher = await personWith(org, opens);

      // Step 2: no Dispatcher, so the step holder is covering.
      const noDispatcher = await take(row, cast(org, customer, me, { soldBy }));
      const step2 = await alertsFor(row.verb, noDispatcher.invoiceId);
      expect(whyFor(step2, holder)).toBe('This job has no Dispatcher.');
      expect(whyFor(step2, soldBy)).toBeNull();
      expect(whyFor(step2, follower)).toBeNull();

      // Step 1: the Dispatcher took it; nobody is covering, so no line anywhere.
      const withDispatcher = await take(row, cast(org, customer, me, { soldBy, dispatcher }));
      const step1 = await alertsFor(row.verb, withDispatcher.invoiceId);
      expect(step1.every((n) => (n.data as Record<string, unknown>).fallback_reason === '')).toBe(true);
      expect(step1.every((n) => n.body === row.body)).toBe(true);
      expect(recipientsOf(step1)).toEqual(ids(soldBy, dispatcher, follower));
    });

    it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const warn = vi.spyOn(logger, 'warn');
      const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('alert: nobody to tell'));

      // A standalone invoice: nobody on it, nobody who must act, no copies.
      const lonely = await take(row, cast(org, customer, me, { shape: 'standalone' }));
      expect(await alertsFor(row.verb, lonely.invoiceId)).toEqual([]);
      const mine = gaps().filter((call) => (call[1] as { recordId?: string }).recordId === lonely.invoiceId);
      expect(mine).toHaveLength(1);
      expect(mine[0]![1]).toMatchObject({ organizationId: org, recordType: 'INVOICE', recordId: lonely.invoiceId });
      // The customer on this invoice is called Pat Payer: nothing of the customer reaches the log.
      expect(JSON.stringify(mine[0])).not.toMatch(/Pat|Payer/);

      warn.mockClear();
      const holder = await personWith(org, stepValues);
      const covered = await take(row, cast(org, customer, me, { shape: 'standalone' }));
      expect(recipientsOf(await alertsFor(row.verb, covered.invoiceId))).toEqual(ids(holder));
      expect(gaps().filter((call) => (call[1] as { recordId?: string }).recordId === covered.invoiceId)).toHaveLength(0);
    });

    it('a record person alone is somebody: no log, even when nobody can act', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opens);
      const warn = vi.spyOn(logger, 'warn');

      const world = await take(row, cast(org, customer, me, { soldBy }));

      expect(recipientsOf(await alertsFor(row.verb, world.invoiceId))).toEqual(ids(soldBy));
      expect((warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('nobody to tell')
        && (call[1] as { recordId?: string }).recordId === world.invoiceId)).toHaveLength(0);
    });

    it('never tells another company, however its people are set up', async () => {
      const { org, customer } = await quietOrg();
      const other = await quietOrg();
      const me = await actor(org);
      const outsiderHolder = await personWith(other.org, { ...stepValues, [COPY]: true });
      const outsiderAdmin = await personWith(other.org, adminValues);
      const holder = await personWith(org, stepValues);

      const world = await take(row, cast(org, customer, me, { shape: 'standalone' }));

      const got = recipientsOf(await alertsFor(row.verb, world.invoiceId));
      expect(got).toEqual(ids(holder));
      expect(got).not.toContain(outsiderHolder.id);
      expect(got).not.toContain(outsiderAdmin.id);
    });

    it('today\'s "customer owner" is gone: the Owner of the lead a job came from is told only through the job\'s own Sold By, never on their own', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const leadOwner = await personWith(org, opens);
      const holder = await personWith(org, stepValues);

      // The job has no Sold By, so an empty field sends no Sold By alert even though the lead has an Owner.
      const world = await take(row, cast(org, customer, me, { leadOwner }));

      const got = recipientsOf(await alertsFor(row.verb, world.invoiceId));
      expect(got).toEqual(ids(holder));
      expect(got).not.toContain(leadOwner.id);
    });

    if (row.byPerson) {
      it('raises no alert when the action itself is refused', async () => {
        const { org, customer } = await quietOrg();
        const refused = await personWith(org, opens);
        // Somebody who would have been told, so a missing alert is the refusal's doing.
        await personWith(org, stepValues);
        const world = await build(cast(org, customer, refused, { shape: 'standalone' }));
        const before = await db.notification.count({ where: { organization_id: org, verb: row.verb } });

        const res = await row.act(world, cast(org, customer, refused, { shape: 'standalone' }));
        await reviewAttentionSettled();

        expect(res && res.status).toBeGreaterThanOrEqual(400);
        expect(await db.notification.count({ where: { organization_id: org, verb: row.verb } })).toBe(before);
      });
    } else {
      it('a retried event produces no second alert: the same key sends nothing twice, plain or with the why line', async () => {
        const { org, customer } = await quietOrg();
        const me = await actor(org);
        const soldBy = await personWith(org, opens);
        const holder = await personWith(org, stepValues);
        const world = await build(cast(org, customer, me, { soldBy }));
        await row.prepare(world);

        succeeded(await row.act(world, cast(org, customer, me, { soldBy })));
        const once = await alertsFor(row.verb, world.invoiceId);
        expect(recipientsOf(once)).toEqual(ids(soldBy, holder));
        // The chain sent two alerts (the record's person, and the holder with the why line); a replay finds either key and sends none.
        expect(once).toHaveLength(2);
        succeeded(await row.act(world, cast(org, customer, me, { soldBy })));
        succeeded(await row.act(world, cast(org, customer, me, { soldBy })));

        expect(await alertsFor(row.verb, world.invoiceId)).toHaveLength(2);
      });

      it('the person who set it off is nobody in particular: no one is left out of the chain', async () => {
        const { org, customer } = await quietOrg();
        const me = await actor(org);
        const holder = await personWith(org, stepValues);

        const world = await take(row, cast(org, customer, me, { shape: 'standalone' }));

        expect(recipientsOf(await alertsFor(row.verb, world.invoiceId))).toEqual(ids(holder));
        expect((await alertsFor(row.verb, world.invoiceId))[0]!.actor_id).toBeNull();
      });
    }
  });

  // ─── Money that no invoice of the company carries ────────────────────────────────────────────────────────────────────────

  describe('money no invoice carries (a processor report against nothing the company recorded)', () => {
    const noInvoice = async (verb: string, org: string, data: Record<string, string> = {}) => {
      const { notifyOwners } = await import('../lib/owner-payment-notices.js');
      await notifyOwners({
        verb, organizationId: org, object: { type: 'ORGANIZATION', id: org, label: 'an invoice' },
        data: { object_kind: 'ORGANIZATION', ...data }, dedupKey: `${verb}:${org}:none`, actionLabel: 'Open Payments',
      });
    };
    const alertsOf = (org: string, verb: string) =>
      db.notification.findMany({ where: { organization_id: org, verb }, include: { recipients: true } });

    it('has no record: the Access Billing holders, an Admin among them, are told with no why line, then the copies; people who hold neither are not', async () => {
      const { org } = await quietOrg();
      const holder = await personWith(org, { [STEP]: true });
      const follower = await personWith(org, { ...opens, [COPY]: true });
      const admin = await personWith(org, adminValues);
      const nobody = await personWith(org, opens);

      await noInvoice('billing.payment_unrecorded', org, { reason: 'INVOICE_NOT_FOUND' });

      const alerts = await alertsOf(org, 'billing.payment_unrecorded');
      expect(recipientsOf(alerts)).toEqual(ids(holder, follower, admin));
      expect(recipientsOf(alerts)).not.toContain(nobody.id);
      expect(alerts.every((n) => n.object_type === 'ORGANIZATION')).toBe(true);
      expect(alerts.every((n) => (n.data as Record<string, unknown>).fallback_reason === '')).toBe(true);
      expect(rowFor(alerts, holder)).toMatchObject({ priority: 'INTERRUPT' });
    });

    it('with no other Access Billing holder: an Admin, who holds the step, with no why line', async () => {
      const { org } = await quietOrg();
      const admin = await personWith(org, adminValues);
      const nobody = await personWith(org, opens);

      await noInvoice('billing.refund_failed', org, { amount: '12.00' });

      const alerts = await alertsOf(org, 'billing.refund_failed');
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(nobody.id);
      expect(whyFor(alerts, admin)).toBeNull();
      expect(alerts[0]!.body).not.toContain('Nobody can access billing.');
    });

    it('with nobody at all: logged with the alert kind and the org id, never dropped silently', async () => {
      const { org } = await quietOrg();
      const warn = vi.spyOn(logger, 'warn');

      await noInvoice('billing.disputed', org, { amount: '12.00' });

      expect(await alertsOf(org, 'billing.disputed')).toEqual([]);
      const gaps = (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('alert: nobody to tell')
        && (call[1] as { organizationId?: string }).organizationId === org);
      expect(gaps).toHaveLength(1);
    });
  });

  // ─── The payment webhook ─────────────────────────────────────────────────────────────────────────────────────────────────

  describe('the payment webhook: a card payment, a dispute and a retried event', () => {
    const retrievePaymentIntent = vi.fn();
    const sessionsList = vi.fn();
    const sessions = new Map<string, { id: string; email: string }>();
    let app: Parameters<typeof request>[0];

    beforeAll(async () => {
      app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
    }, 90_000);

    /** A company with a connected payment account, an invoice on a job, and the doors to deliver processor events to. */
    async function webhookWorld(shape: Shape, cast: Partial<Cast> = {}) {
      const { org, customer, admin } = await quietOrg();
      const tag = org.slice(0, 8);
      const account = `acct_bill28_${tag}`;
      await db.organization.update({ where: { id: org }, data: { stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'] } });
      const me = await personWith(org, {});
      const full: Cast = { org, customer, me, crew: [], ...cast, shape };
      const world = await build(full);
      await db.invoice.update({ where: { id: world.invoiceId }, data: { total_amount: 500, subtotal: 500, amount_due: 500 } });
      const payIntent = `pi_bill28_${tag}`;
      retrievePaymentIntent.mockReset().mockResolvedValue({
        id: payIntent,
        latest_charge: {
          id: `py_bill28_${tag}`, object: 'charge', created: 1789990000, amount: 50000,
          payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
        },
      });
      let seq = 0;
      const session = (over: Record<string, unknown> = {}) => ({
        id: `cs_bill28_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
        payment_intent: payIntent, amount_total: 50000, currency: 'usd', payment_method_types: ['card'],
        metadata: { invoiceId: world.invoiceId, organizationId: org, kind: 'invoice', payableNowCents: '50000' },
        ...over,
      });
      const deliver = async (type: string, object: object, id?: string) => {
        const event = { id: id ?? `evt_bill28_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: 1790000000, account, data: { object } };
        const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
          .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
        expect(res.status).toBe(200);
      };
      return { org, customer, admin, tag, account, world, payIntent, session, deliver, cast: full };
    }

    const wire = () => {
      sessionsList.mockReset().mockResolvedValue({ data: [], has_more: false });
      vi.mocked(supabaseAdmin.auth.getUser).mockImplementation((async (token: string) => (
        sessions.has(token) ? { data: { user: sessions.get(token) }, error: null } : { data: { user: null }, error: { message: 'invalid token' } }
      )) as never);
      vi.mocked(listPaymentIntentRefunds).mockReset().mockResolvedValue([]);
      vi.mocked(getStripeForOrg).mockReturnValue({
        stripe: {
          paymentIntents: { retrieve: retrievePaymentIntent },
          disputes: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
          checkout: { sessions: { list: sessionsList } },
          applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
        },
        stripeAccount: undefined,
      } as unknown as ReturnType<typeof getStripeForOrg>);
    };

    it('a card payment on an invoice with a job reaches that job\'s people who can open the invoice, and the holders covering for a missing Dispatcher with the why line', async () => {
      wire();
      const w = await webhookWorld('job');
      const sellerHere = await personWith(w.org, opens);
      const crewHere = await personWith(w.org, opens);
      const noInvoiceReach = await personWith(w.org, opensJobNotInvoice);
      const holder = await personWith(w.org, stepValues);
      // The world was built before these people existed: put them on the job now.
      await db.job.update({ where: { id: w.world.jobId! }, data: { salesperson_id: sellerHere.id } });
      const visit = await db.visit.findFirstOrThrow({ where: { job_id: w.world.jobId! }, select: { id: true } }).catch(() => null);
      const visitId = visit?.id ?? (await fx.addVisit(w.org, { jobId: w.world.jobId!, crew: [], daysFromNow: 2 }));
      await db.visitAssignee.createMany({ data: [crewHere, noInvoiceReach].map((p) => ({ visit_id: visitId, user_id: p.id, organization_id: w.org })) });

      await w.deliver('checkout.session.completed', w.session());

      await vi.waitFor(async () => expect(await alertsFor('billing.payment_received', w.world.invoiceId)).not.toHaveLength(0));
      const alerts = await alertsFor('billing.payment_received', w.world.invoiceId);
      expect(recipientsOf(alerts)).toEqual(ids(sellerHere, crewHere, holder));
      expect(recipientsOf(alerts)).not.toContain(noInvoiceReach.id);
      expect(alerts.every((n) => n.actor_id === null)).toBe(true);
      expect(whyFor(alerts, holder)).toBe('This job has no Dispatcher.');
      expect(whyFor(alerts, sellerHere)).toBeNull();
      expect(alerts.find((n) => n.recipients.some((r) => r.recipient_id === holder.id))!.body).not.toContain('Amount');
      for (const row of await db.notification.findMany({ where: { organization_id: w.org } })) {
        expect(`${row.title} ${row.body ?? ''}`).not.toMatch(/stripe|plaid|resend|supabase|render\.com|visa|4242/i);
      }
    });

    it('a retried event (the same event twice, and a second delivery of the same payment) produces no second alert, plain or with the why line', async () => {
      wire();
      const w = await webhookWorld('standalone');
      const holder = await personWith(w.org, stepValues);
      const id = `evt_bill28_${w.tag}_dup`;

      await w.deliver('checkout.session.completed', w.session(), id);
      await vi.waitFor(async () => expect(await alertsFor('billing.payment_received', w.world.invoiceId)).toHaveLength(1));
      await w.deliver('checkout.session.completed', w.session(), id);
      await w.deliver('checkout.session.completed', w.session(), `evt_bill28_${w.tag}_again`);

      const alerts = await alertsFor('billing.payment_received', w.world.invoiceId);
      expect(alerts).toHaveLength(1);
      expect(recipientsOf(alerts)).toEqual(ids(holder));
      expect(whyFor(alerts, holder)).toBe('This invoice has no job or lead.');
      expect(alerts[0]!.dedup_key).toMatch(/:why$/);
    });

    it('a dispute on a card payment reaches the invoice\'s job people, interrupts the people who must act and is not told twice', async () => {
      wire();
      const w = await webhookWorld('job');
      const dispatcher = await personWith(w.org, opens);
      const soldBy = await personWith(w.org, opens);
      await db.job.update({ where: { id: w.world.jobId! }, data: { dispatcher_id: dispatcher.id, salesperson_id: soldBy.id } });
      const charge = `ch_bill28_${w.tag}`;
      await db.invoice.update({ where: { id: w.world.invoiceId }, data: { status: 'PAID', amount_due: 0 } });
      await db.payment.create({
        data: {
          invoice_id: w.world.invoiceId, amount: 500, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'CLIENT',
          stripe_payment_intent_id: w.payIntent, stripe_charge_id: charge, stripe_account_id: w.account,
        },
      });
      const dispute = {
        id: `dp_bill28_${w.tag}`, object: 'dispute', amount: 50000, currency: 'usd', status: 'needs_response', reason: 'fraudulent', charge,
        payment_intent: w.payIntent, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86_400 * 5 }, payment_method_details: { type: 'card' },
      };

      await w.deliver('charge.dispute.created', dispute);
      await w.deliver('charge.dispute.created', dispute);

      await vi.waitFor(async () => expect(await alertsFor('billing.disputed', w.world.invoiceId)).not.toHaveLength(0));
      const alerts = await alertsFor('billing.disputed', w.world.invoiceId);
      expect(alerts).toHaveLength(1);
      expect(recipientsOf(alerts)).toEqual(ids(dispatcher, soldBy));
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: 'INTERRUPT' });
      expect(rowFor(alerts, soldBy)).toMatchObject({ priority: 'FEED' });
    });
  });
});
