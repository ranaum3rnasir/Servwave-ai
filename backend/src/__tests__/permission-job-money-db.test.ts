/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.26 - money on the job follows invoice access.

   The job's totals and balance show to anyone who can open the job. The invoices listed on the job, and the
   payments on them, are the ones the person can open (the View scope's rows plus the ones they made while attached
   to the job). Collecting stays open on a Completed or Cancelled job.

   Everything goes through the public interface: the job and invoice routes, called as people on custom roles (never
   a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job takes, with no money switch on: the Technician preset's reach (Attached, View invoices off). */
const OPENING = { view_jobs: true, jobs_scope: 'attached', view_invoices: false };

suite('money on the job follows invoice access (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `job-money-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `worker${sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, roleKey: key, api: () => fx.signedInAs(person) };
  }

  /**
   * A job the person is crew on, with two invoices on it: one the person made, one the office made, each $100 with a
   * payment of $30 on it.
   */
  async function jobWithTwoInvoices(opts: { me: Person; org: string; customer: string; officeUser: string; status?: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' }) {
    const job = await fx.addJob(opts.org, opts.customer, { crew: [opts.me.id], status: opts.status });
    const mine = (await fx.addInvoice(opts.org, opts.customer, { jobId: job.id, createdBy: opts.me.id })).id;
    const theirs = (await fx.addInvoice(opts.org, opts.customer, { jobId: job.id, createdBy: opts.officeUser })).id;
    for (const [invoice, ref] of [[mine, 'MINE-1'], [theirs, 'THEIRS-1']] as const) {
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PARTIAL', amount_due: 70, sent_at: new Date() } });
      await db.payment.create({
        data: { invoice_id: invoice, amount: 30, method: 'CHECK', reference_number: ref, paid_at: new Date() },
      });
    }
    return { jobId: job.id, mine, theirs };
  }

  describe('the invoices listed on the job', () => {
    it('with View invoices off, lists the invoices the person made on the job and not the office\'s, with payments only on the first', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, OPENING);
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id });
      const api = await me.api();

      const res = await api.get(`/api/jobs/${world.jobId}/financials`);
      expect(res.status).toBe(200);
      expect(res.body.invoices.map((i: { id: string }) => i.id)).toEqual([world.mine]);
      expect(res.body.payments.map((p: { reference_number: string }) => p.reference_number)).toEqual(['MINE-1']);
      // The listed invoice carries its own money: prices follow the record the person can open.
      expect(Number(res.body.invoices[0].total_amount)).toBe(100);
      expect(Number(res.body.invoices[0].amount_due)).toBe(70);
    });

    it('lists every invoice on the job, and every payment, for a person whose View invoices scope reaches them', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, view_invoices: true, invoices_scope: 'all' });
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id });

      const res = await (await me.api()).get(`/api/jobs/${world.jobId}/financials`);
      expect(res.body.invoices.map((i: { id: string }) => i.id).sort()).toEqual([world.mine, world.theirs].sort());
      expect(res.body.payments).toHaveLength(2);
    });

    it('lists nothing from the office, and nothing of the person\'s own once they are taken off the job', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, jobs_scope: 'all' });
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id });
      const api = await me.api();
      expect((await api.get(`/api/jobs/${world.jobId}/financials`)).body.invoices).toHaveLength(1);

      const visit = await db.visit.findFirstOrThrow({ where: { job_id: world.jobId }, select: { id: true } });
      await fx.removeCrew(visit.id, me.id);
      const after = await api.get(`/api/jobs/${world.jobId}/financials`);
      expect(after.status).toBe(200);
      expect(after.body.invoices).toEqual([]);
      expect(after.body.payments).toEqual([]);
    });

    it('also keeps the invoices the person cannot open out of the job page\'s own invoice list', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, OPENING);
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id });

      const res = await (await me.api()).get(`/api/jobs/${world.jobId}`);
      expect(res.status).toBe(200);
      expect(res.body.job.invoices.map((i: { id: string }) => i.id)).toEqual([world.mine]);
      // A delete decision still knows the job has invoices.
      expect(res.body.job.invoice_count).toBe(2);
    });
  });

  describe('the job\'s totals and balance', () => {
    it('show to a person who can open the job, whichever invoices they can open', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, OPENING);
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id });

      const res = await (await me.api()).get(`/api/jobs/${world.jobId}/financials`);
      // Two $100 invoices, $30 paid on each: the job's figures cover both, though the person lists one. Both invoices'
      // dues count ($70 each), so the contract is the two totals and the balance is both dues.
      expect(Number(res.body.total_invoiced)).toBe(200);
      expect(Number(res.body.total_paid)).toBe(60);
      expect(Number(res.body.final_invoice.total_amount)).toBe(100);
      expect(Number(res.body.final_invoice.amount_due)).toBe(70);
      expect(res.body.totals).toEqual({ contract_total: 200, paid: 60, deposit_paid: 0, processing: 0, balance_due: 140 });
    });

    it('carry an estimate\'s total as the contract for a job with no invoice yet, to a person who cannot read estimates', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, OPENING);
      const job = await fx.addJob(org, customer, { crew: [me.id], fromLead: undefined });
      const est = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      expect(est.id).toBeTruthy();

      const res = await (await me.api()).get(`/api/jobs/${job.id}/financials`);
      expect(res.status).toBe(200);
      expect(res.body.totals.contract_total).toBe(100);
      expect(res.body.totals.paid).toBe(0);
    });
  });

  describe('collecting on a locked job', () => {
    it.each(['COMPLETED', 'CANCELLED'] as const)('still records a payment and sends a payment link on the person\'s invoice on a %s job', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, edit_jobs: true, record_payments: true, send_payment_links: true, allowed_payment_methods: ['CHECK', 'CASH'] });
      const world = await jobWithTwoInvoices({ me, org, customer, officeUser: admin.id, status });
      const api = await me.api();

      // The lock is really in force for this person: an ordinary change to the job is refused.
      const edit = await api.patch(`/api/jobs/${world.jobId}`, { description: 'changed' });
      expect(edit.status).toBe(403);
      expect(edit.body.code).toBe('JOB_LOCKED');

      const paid = await api.post(`/api/invoices/${world.mine}/payments`, { amount: 10, method: 'CASH' });
      expect(paid.status).toBe(201);
      const link = await api.post(`/api/invoices/${world.mine}/payment-link`, {});
      expect(link.status).toBe(200);
      expect(link.body.url).toMatch(/\/p\/invoices\//);
    });
  });
});
