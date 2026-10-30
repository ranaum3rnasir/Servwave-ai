/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.17 - Record payments, Refund payments, Send payment links and
   Allowed payment methods.

   Everything goes through the public interface: the role store and the invoice and estimate routes, called as
   people on custom roles (never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { ALL_ACCEPTED_METHODS } from '../lib/permissions/switches/catalog';
import { assignRoleToPerson, resolveSwitches, setRoleSwitchValues } from '../lib/permissions/switches/store';
import { METHOD_NOT_ACCEPTED, METHOD_NOT_ALLOWED } from '../lib/permissions/paymentMethods';

const suite = realClient ? describe : describe.skip;

suite('payments on switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string | string[]>,
    opts: { base?: 'DISPATCHER' | 'SALES' | 'TECHNICIAN'; blank?: boolean; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `pay-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base, { madeFromBlank: opts.blank });
    // Recording a payment stands on See prices (P11), so every person here holds it unless the case says otherwise.
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `${opts.name ?? 'payer'}${sequence}`, base, { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, roleKey: key, api: () => fx.signedInAs(person) };
  }

  /** The company's Payments & Lists settings: the stored accepted list, and whether the card processor can take charges. */
  const companyAccepts = (org: string, methods: string[], chargesEnabled = false) =>
    db.organization.update({ where: { id: org }, data: { accepted_payment_methods: methods, stripe_charges_enabled: chargesEnabled } });

  /** An invoice the person is crew on, through a job, so Attached reaches it. */
  async function invoiceFor(org: string, customer: string, crew: string[]) {
    const job = await fx.addJob(org, customer, { crew });
    return (await fx.addInvoice(org, customer, { jobId: job.id })).id;
  }

  const pay = (api: Api, invoice: string, method: string) =>
    api.post(`/api/invoices/${invoice}/payments`, { amount: 10, method });

  describe('Record payments on an invoice', () => {
    it('is refused on an invoice the person cannot open, and let in on one they can', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached', record_payments: true });
      const mine = await invoiceFor(org, customer, [me.id]);
      const theirs = (await fx.addInvoice(org, customer)).id;
      const api = await me.api();

      expect((await pay(api, theirs, 'CASH')).status).toBe(404);
      expect((await pay(api, mine, 'CASH')).status).toBe(201);
    });

    it('is refused without Record payments, whatever else the person holds', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', edit_invoices: true, record_payments: false });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;
      expect((await pay(api, invoice, 'CASH')).status).toBe(403);
    });

    it('refuses a method the company does not accept, and says so in the company\'s words', async () => {
      const { org, customer } = await fx.newOrg();
      await companyAccepts(org, ['CHECK']);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;

      const refused = await pay(api, invoice, 'CASH');
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(METHOD_NOT_ACCEPTED);
      expect((await pay(api, invoice, 'CHECK')).status).toBe(201);
    });

    it('refuses a method outside the person\'s own list, though the company accepts it', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, allowed_payment_methods: ['CHECK'] });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;

      const refused = await pay(api, invoice, 'CASH');
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(METHOD_NOT_ALLOWED);
      expect((await pay(api, invoice, 'CHECK')).status).toBe(201);
    });

    it('refuses everything for a role made from blank, whose list is empty', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true }, { blank: true });
      expect((await resolveSwitches({ is_admin: false, ...me, role: 'DISPATCHER', organization_id: org })).allowed_payment_methods).toEqual([]);
      const invoice = (await fx.addInvoice(org, customer)).id;
      expect((await pay(await me.api(), invoice, 'CHECK')).status).toBe(404);
    });

    it.each([
      ['an empty list', [] as string[], false],
      ['a live card processor with Credit Card alone stored', ['CARD'], true],
    ])('accepts any method, for an admin and for a person on "All accepted methods", with %s', async (_name, stored, live) => {
      const { org, customer, admin } = await fx.newOrg();
      await companyAccepts(org, stored, live);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, allowed_payment_methods: ALL_ACCEPTED_METHODS });
      const adminApi = await fx.signedInAs(admin);
      const meApi = await me.api();
      for (const method of ['CASH', 'CHECK', 'ZELLE', 'CARD']) {
        expect((await pay(adminApi, (await fx.addInvoice(org, customer)).id, method)).status, `admin ${method}`).toBe(201);
        expect((await pay(meApi, (await fx.addInvoice(org, customer)).id, method)).status, `person ${method}`).toBe(201);
      }
    });

    it('accepts Check and Credit Card, and refuses Cash, for a company that ticked Check with the processor live', async () => {
      const { org, customer } = await fx.newOrg();
      await companyAccepts(org, ['CHECK', 'CARD'], true);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;

      expect((await pay(api, invoice, 'CHECK')).status).toBe(201);
      expect((await pay(api, invoice, 'CARD')).status).toBe(201);
      expect((await pay(api, invoice, 'CASH')).status).toBe(403);
    });

    it('stores "All accepted methods" as the marker, never expanded, so a method the company adds later is allowed for it and not for a fixed subset', async () => {
      const { org, customer } = await fx.newOrg();
      await companyAccepts(org, ['CHECK']);
      const everything = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, allowed_payment_methods: ALL_ACCEPTED_METHODS });
      const fixed = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, allowed_payment_methods: ['CHECK'] });

      const stored = await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: everything.roleKey, switch_key: 'allowed_payment_methods' } });
      expect(stored?.value).toBe(ALL_ACCEPTED_METHODS);
      // A person given the role follows the role's marker: nothing is copied onto them, least of all a copy of the company's list.
      const full = await db.user.findUniqueOrThrow({ where: { id: everything.id } });
      await db.$transaction((tx) => assignRoleToPerson(tx, {
        organizationId: org, userId: everything.id, roleKey: everything.roleKey, userBaseRole: full.role, previous: {}, actorId: null,
      }));
      expect(await db.permissionUserSwitch.count({ where: { user_id: everything.id } })).toBe(0);

      await companyAccepts(org, ['CHECK', 'CASH']);
      const invoice = (await fx.addInvoice(org, customer)).id;
      expect((await pay(await everything.api(), invoice, 'CASH')).status).toBe(201);
      expect((await pay(await fixed.api(), invoice, 'CASH')).status).toBe(403);
      expect((await pay(await fixed.api(), invoice, 'CHECK')).status).toBe(201);
    });

    it('logs a change of a list switch once, and not when it is written again unchanged', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { allowed_payment_methods: ['CHECK', 'CASH'] });
      const store = (values: Record<string, string[] | string>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values, actorId: null, reason: 'manual' });
      await store({ allowed_payment_methods: ['CHECK', 'CASH'] });
      await store({ allowed_payment_methods: ['CHECK'] });
      const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, target_id: me.roleKey, switch_key: 'allowed_payment_methods' }, orderBy: { created_at: 'asc' } });
      expect(log.map((l) => [l.from_value, l.to_value])).toEqual([
        [ALL_ACCEPTED_METHODS, ['CHECK', 'CASH']],
        [['CHECK', 'CASH'], ['CHECK']],
      ]);
    });

    it('refuses a stored list that names a method that does not exist', async () => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'bad-list', 'DISPATCHER');
      await expect(setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { allowed_payment_methods: ['GOLD'] }, actorId: null, reason: 'manual' })).rejects.toThrow(/Allowed payment methods/);
    });
  });

  describe('a deposit on an estimate', () => {
    const deposit = (api: Api, estimate: string, method: string) =>
      api.post(`/api/estimates/${estimate}/record-payment`, { amount: 10, payment_method: method });

    it('needs Record payments, a method the company accepts and a method in the person\'s list', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await companyAccepts(org, ['CHECK', 'CASH']);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, allowed_payment_methods: ['CHECK'] });
      const off = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: false });
      const estimate = (await fx.addEstimate(org, customer, admin.id)).id;

      expect((await deposit(await off.api(), estimate, 'CHECK')).status).toBe(403);
      // Signing in is global to the mocked auth layer: take the next person's api after the last one's calls.
      const api = await me.api();
      const notMine = await deposit(api, estimate, 'CASH');
      expect(notMine.status).toBe(403);
      expect(notMine.body.error).toBe(METHOD_NOT_ALLOWED);
      const notAccepted = await deposit(api, estimate, 'ZELLE');
      expect(notAccepted.status).toBe(403);
      expect(notAccepted.body.error).toBe(METHOD_NOT_ACCEPTED);
      expect((await deposit(api, estimate, 'CHECK')).status).toBe(200);
    });

    // Roles & Permissions S02.32: the estimate deposit dialog offers Credit Card beside the ticked methods while the
    // processor is live, so the server has to take it from a person on "All accepted methods" (and only then).
    it('takes Credit Card from a person on "All accepted methods" when the company ticked Check with the processor live, and refuses Cash', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await companyAccepts(org, ['CHECK', 'CARD'], true);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true });
      const estimate = (await fx.addEstimate(org, customer, admin.id)).id;
      const api = await me.api();

      expect((await deposit(api, estimate, 'CARD')).status).toBe(200);
      const cash = await deposit(api, estimate, 'CASH');
      expect(cash.status).toBe(403);
      expect(cash.body.error).toBe(METHOD_NOT_ACCEPTED);
    });

    it('refuses Credit Card when the company ticked Check and the processor is not live', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await companyAccepts(org, ['CHECK']);
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true });
      const estimate = (await fx.addEstimate(org, customer, admin.id)).id;

      const card = await deposit(await me.api(), estimate, 'CARD');
      expect(card.status).toBe(403);
      expect(card.body.error).toBe(METHOD_NOT_ACCEPTED);
    });
  });

  describe('what the screens read', () => {
    it('serves the Allowed payment methods list switch with its options and its marker preset to any signed-in person', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, {});
      const res = await (await me.api()).get('/api/permission-switches/catalog');
      expect(res.status).toBe(200);
      const entry = res.body.switches.find((s: { key: string }) => s.key === 'allowed_payment_methods');
      expect(entry).toMatchObject({ module: 'Invoices', label: 'Allowed payment methods', kind: 'list' });
      expect(entry.listOptions).toEqual(expect.arrayContaining(['CASH', 'CHECK', 'CARD']));
      expect(entry.presets).toEqual({ ADMIN: ALL_ACCEPTED_METHODS, SALES: ALL_ACCEPTED_METHODS, DISPATCHER: ALL_ACCEPTED_METHODS, TECHNICIAN: ALL_ACCEPTED_METHODS });
    });

    it('serves the company\'s effective accepted list to any signed-in person of that company, and only theirs', async () => {
      const first = await fx.newOrg();
      const second = await fx.newOrg();
      await companyAccepts(first.org, ['CHECK', 'CARD'], true);
      await companyAccepts(second.org, []);
      const me = await personWith(first.org, {});
      const res = await (await me.api()).get('/api/permission-switches/accepted-payment-methods');
      expect(res.status).toBe(200);
      expect(res.body.every_method).toBe(false);
      expect([...res.body.methods].sort()).toEqual(['CARD', 'CHECK']);

      const other = await personWith(second.org, {});
      const all = await (await other.api()).get('/api/permission-switches/accepted-payment-methods');
      expect(all.body.every_method).toBe(true);
      expect(all.body.methods).toEqual(expect.arrayContaining(['CASH', 'CHECK', 'CARD', 'ZELLE']));
    });
  });

  describe('Refund payments', () => {
    const refund = (api: Api, invoice: string) =>
      api.post(`/api/invoices/${invoice}/refund`, { amount: 5, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer asked' });

    it('is refused with Record payments on and Refund payments off, and let in with it on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', record_payments: true, refund_payments: false, view_payments: true });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;
      expect((await pay(api, invoice, 'CASH')).status).toBe(201);

      expect((await refund(api, invoice)).status).toBe(403);
      await setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values: { refund_payments: true, view_payments: true }, actorId: null, reason: 'manual' });
      const letIn = await refund(api, invoice);
      expect(letIn.status).not.toBe(403);
      expect(letIn.status).not.toBe(401);
    });
  });

  describe('Send payment links', () => {
    const link = (api: Api, invoice: string) => api.post(`/api/invoices/${invoice}/payment-link`, {});

    it('is refused without Send payment links even with Edit invoices on, and let in with it on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', edit_invoices: true, send_payment_links: false });
      const api = await me.api();
      const invoice = (await fx.addInvoice(org, customer)).id;
      expect((await link(api, invoice)).status).toBe(403);

      // Create requires Edit (AL-04): taking Edit invoices away takes Create invoices (and Standalone invoices) with it.
      await setRoleSwitchValues({
        organizationId: org, roleKey: me.roleKey,
        values: { send_payment_links: true, edit_invoices: false, create_invoices: false, standalone_invoices: false }, actorId: null, reason: 'manual',
      });
      const created = await link(api, invoice);
      expect(created.status).toBe(200);
      expect(created.body.url).toMatch(/\/p\/invoices\//);
    });

    it('is refused on an invoice the person cannot open', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached', send_payment_links: true });
      const theirs = (await fx.addInvoice(org, customer)).id;
      expect((await link(await me.api(), theirs)).status).toBe(404);
    });
  });

  describe('who made the invoice opens nothing (P7)', () => {
    it('refuses a Technician-preset person who holds Record payments and Send payment links a payment and a link on their own invoice with Invoices View off', async () => {
      const { org, customer } = await fx.newOrg();
      // AL-04: the Technician preset holds neither switch any more, so this person has been given both.
      const me = await personWith(org, { record_payments: true, send_payment_links: true }, { base: 'TECHNICIAN' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = (await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id })).id;

      const switches = await resolveSwitches({ is_admin: false, ...me, role: 'TECHNICIAN', organization_id: org });
      expect(switches.view_invoices).toBe(false);
      expect((await pay(api, mine, 'CASH')).status).toBe(404);
      expect((await api.post(`/api/invoices/${mine}/payment-link`, {})).status).toBe(404);
      expect(await db.payment.count({ where: { invoice_id: mine } })).toBe(0);
    });

    it('lets the same person record a payment and send a link on the invoice of their job once Invoices View is on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { record_payments: true, send_payment_links: true, view_invoices: true, jobs_scope: 'attached', leads_scope: 'attached' }, { base: 'TECHNICIAN' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = (await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id })).id;
      const theirs = (await fx.addInvoice(org, customer)).id;

      expect((await pay(api, mine, 'CASH')).status).toBe(201);
      expect((await api.post(`/api/invoices/${mine}/payment-link`, {})).status).toBe(200);
      expect((await pay(api, theirs, 'CASH')).status).toBe(404);
      expect((await api.post(`/api/invoices/${theirs}/payment-link`, {})).status).toBe(404);
    });

    it('refuses the creator a payment or a link when the switches are off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { record_payments: false, send_payment_links: false }, { base: 'TECHNICIAN' });
      const api = await me.api();
      const mine = (await fx.addInvoice(org, customer, { createdBy: me.id })).id;
      expect((await pay(api, mine, 'CASH')).status).toBe(403);
      expect((await api.post(`/api/invoices/${mine}/payment-link`, {})).status).toBe(403);
    });
  });
});
