/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.22 - Record payment on the Payment Received step: GET /api/jobs/:id/financials.

   The job page's Payment Received step offers Record payment from one small object the financials answer carries,
   `payment_received: { offered, reason }`, so the browser never tests a switch name, a role name or an invoice's creator.
   It is offered only when the person holds Record payments AND can open the job's final invoice (Invoices View and
   scope, or the creator rule); otherwise it carries the one reason that applies. The server stays the check: a payment
   posted to an invoice the person cannot open is refused whatever the screen shows.

   Called as people on custom roles holding exactly the switch values under test, never a built-in role name.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job takes. */
const OPEN_JOBS = { view_jobs: true, jobs_scope: 'all' };
/** What opening every invoice takes. */
const OPEN_INVOICES = { view_invoices: true, jobs_scope: 'all', leads_scope: 'all' };
/** What posting a payment takes, on top of opening the invoice. A method the person may use is part of it. */
const RECORD = { record_payments: true, allowed_payment_methods: ['CASH'] };

const CANNOT_OPEN = "You can't open this job's invoice.";
const NO_RECORD = "You don't have permission to record payments.";
const NO_CREATE = "You don't have permission to create invoices.";

suite('the Payment Received step on switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `pay-step-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const stepOf = async (api: Api, jobId: string) => (await api.get(`/api/jobs/${jobId}/financials`)).body.payment_received;
  const pay = (api: Api, invoice: string) => api.post(`/api/invoices/${invoice}/payments`, { amount: 10, method: 'CASH' });

  /** A job the person is crew on, with an invoice on it made by `createdBy` (the office when omitted). */
  async function jobWithInvoice(s: Setup, crew: string[], createdBy?: string) {
    const job = await fx.addJob(s.org, s.customer, { crew });
    const invoice = (await fx.addInvoice(s.org, s.customer, { jobId: job.id, createdBy })).id;
    return { job: job.id, invoice };
  }

  describe('a job with an invoice', () => {
    it('is offered to a person who holds Record payments and opens the invoice through Invoices View and its scope', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...OPEN_INVOICES, ...RECORD });
      const { job, invoice } = await jobWithInvoice(s, [me.id]);

      expect(await stepOf(await me.api(), job)).toEqual({ offered: true, reason: null });
      expect((await pay(await me.api(), invoice)).status).toBe(201);
    });

    it('is greyed for a custom role with Invoices View off even on an invoice it created, and the route refuses the payment (P7)', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...RECORD });
      const { job, invoice } = await jobWithInvoice(s, [me.id], me.id);

      expect(await stepOf(await me.api(), job)).toEqual({ offered: false, reason: CANNOT_OPEN });
      expect((await pay(await me.api(), invoice)).status).toBe(404);
      expect((await db.payment.count({ where: { invoice_id: invoice } }))).toBe(0);
    });

    it("is greyed with the can't-open words for Record payments on and Invoices View off on someone else's invoice, and the route refuses the payment", async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...RECORD });
      const { job, invoice } = await jobWithInvoice(s, [me.id]);

      expect(await stepOf(await me.api(), job)).toEqual({ offered: false, reason: CANNOT_OPEN });
      expect((await pay(await me.api(), invoice)).status).toBe(404);
      expect((await db.payment.count({ where: { invoice_id: invoice } }))).toBe(0);
    });

    it('is greyed with the no-permission words when Record payments is off, on an invoice the person created', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, record_payments: false });
      const { job, invoice } = await jobWithInvoice(s, [me.id], me.id);

      expect(await stepOf(await me.api(), job)).toEqual({ offered: false, reason: NO_RECORD });
      expect((await pay(await me.api(), invoice)).status).toBe(403);
    });

    it('names the missing Record payments, not the invoice, when the person lacks both', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS });
      const { job } = await jobWithInvoice(s, [me.id]);

      expect(await stepOf(await me.api(), job)).toEqual({ offered: false, reason: NO_RECORD });
    });

    it('stays on the job\'s final invoice: a person who opens another of the job\'s invoices but not the final one is greyed', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...RECORD });
      const job = await fx.addJob(s.org, s.customer, { crew: [me.id] });
      const mine = (await fx.addInvoice(s.org, s.customer, { jobId: job.id, createdBy: me.id })).id;
      const finalOne = (await fx.addInvoice(s.org, s.customer, { jobId: job.id })).id;
      // The newest invoice number is the job's final invoice (the financials rule).
      await db.invoice.update({ where: { id: mine }, data: { invoice_number: 'INV-0001' } });
      await db.invoice.update({ where: { id: finalOne }, data: { invoice_number: 'INV-0002' } });

      expect(await stepOf(await me.api(), job.id)).toEqual({ offered: false, reason: CANNOT_OPEN });
    });

    it('says nothing that names an invoice: no number, no amount', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...RECORD });
      const { job, invoice } = await jobWithInvoice(s, [me.id]);
      const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoice } })).invoice_number;

      const step = JSON.stringify(await stepOf(await me.api(), job));

      expect(step).not.toContain(number);
      expect(step).not.toContain('100');
    });
  });

  describe('a job with no invoice yet', () => {
    it('is offered to a person who holds Record payments and Create invoices', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...OPEN_INVOICES, ...RECORD, edit_invoices: true, create_invoices: true });
      const job = await fx.addJob(s.org, s.customer, { crew: [me.id] });

      expect(await stepOf(await me.api(), job.id)).toEqual({ offered: true, reason: null });
    });

    it('is greyed with the create-invoices words without Create invoices', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...OPEN_INVOICES, ...RECORD, create_invoices: false });
      const job = await fx.addJob(s.org, s.customer, { crew: [me.id] });

      expect(await stepOf(await me.api(), job.id)).toEqual({ offered: false, reason: NO_CREATE });
    });

    it('is greyed with the no-permission words without Record payments', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...OPEN_INVOICES, edit_invoices: true, create_invoices: true });
      const job = await fx.addJob(s.org, s.customer, { crew: [me.id] });

      expect(await stepOf(await me.api(), job.id)).toEqual({ offered: false, reason: NO_RECORD });
    });

    it('is not offered, and says nothing, on a service plan visit job: the plan was paid upfront', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPEN_JOBS, ...OPEN_INVOICES, ...RECORD, edit_invoices: true, create_invoices: true });
      const plan = await fx.addServicePlan(s.org, s.customer);
      const job = await fx.addJob(s.org, s.customer, { crew: [me.id], sourcePlan: plan.id });

      expect(await stepOf(await me.api(), job.id)).toEqual({ offered: false, reason: null });
    });
  });
});
