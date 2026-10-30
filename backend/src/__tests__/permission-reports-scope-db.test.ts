/* =============================================================================
   Roles & Permissions, P13 and A6 - a report is a view over the rows a person's scope reaches, never a wider door.

   Every report filters its rows through the same scope resolver the lists use (jobs, leads, estimates, invoices; a payment
   through its invoice), the totals sum only those rows, and the money a report shows follows the three money classes: a
   person without See prices gets no amount in any report. The Billing endpoint (AR aging) follows the person's invoice reach
   like every other report.

   Everything goes through the public interface: the report routes, called as people on custom roles (never a built-in role
   name). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

/** What reading every kind of record, and its reports, takes. */
const READS = {
  access_reports: true, access_billing: true,
  view_jobs: true, view_leads: true, view_estimates: true, view_invoices: true, view_payments: true,
};

/** The names of money a report row or total can carry; none may appear without See prices. */
const MONEY_KEYS = new Set([
  'billed', 'paid', 'subtotal', 'tax', 'tip', 'amount', 'due', 'balance', 'value', 'depositDue', 'profit', 'itemCost', 'laborCost',
  'cardExpenses', 'techExpenses', 'invoiced', 'collected', 'outstanding', 'completed', 'gross', 'net', 'charged', 'stripeFees',
  'platformFees', 'serviceFees', 'tips', 'salesInWindow', 'dso',
]);

/** Every place a money name appears in an answer, at any depth. */
function moneyPaths(body: unknown, path = ''): string[] {
  if (Array.isArray(body)) return body.flatMap((v, i) => moneyPaths(v, `${path}[${i}]`));
  if (body && typeof body === 'object') {
    return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => [
      ...(MONEY_KEYS.has(k) && typeof v !== 'object' ? [`${path}.${k}`] : []),
      ...moneyPaths(v, `${path}.${k}`),
    ]);
  }
  return [];
}

suite('reports show only what the person\'s scope reaches (real database)', () => {
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
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `reports-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `reporter${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** One company, two sets of records: the ones the person is on (mine) and the ones they are not (theirs), each with money. */
  async function world(me: Person, org: string, customer: string, admin: Person) {
    const make = async (who: string, jobNumber: string, leadNumber: string, total: number, ref: string) => {
      const job = await fx.addJob(org, customer, { crew: [who] });
      await db.job.update({ where: { id: job.id }, data: { job_number: jobNumber, completed_at: new Date(), amount_invoiced: total } });
      const lead = await fx.addLead(org, customer, { assignees: [who] });
      await db.lead.update({ where: { id: lead.id }, data: { lead_number: leadNumber } });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { total_amount: total, subtotal: total } });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status: 'SENT', sent_at: new Date(), total_amount: total, subtotal: total, amount_due: total },
      });
      await db.payment.create({ data: { invoice_id: invoice.id, amount: total / 2, method: 'CHECK', reference_number: ref, paid_at: new Date() } });
      await db.timelineEvent.create({
        data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CREATED', description: ref, created_by: who },
      });
      return { job, lead, estimate, invoice };
    };
    const other = await fx.addUser(org, `other${++sequence}`, 'TECHNICIAN');
    const mine = await make(me.id, 'J-1001', 'L-3001', 100, 'MINE-REF');
    const theirs = await make(other.id, 'J-2002', 'L-4002', 250, 'THEIRS-REF');
    return { mine, theirs };
  }

  const WIDE = { ...READS, jobs_scope: 'all', leads_scope: 'all', see_prices: true, see_company_figures: true };
  const OWN = { ...READS, jobs_scope: 'attached', leads_scope: 'attached', see_prices: true, see_company_figures: true };

  it('lists only the jobs, leads, estimates, invoices and payments the person is attached to, and sums only those', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, OWN);
    const wide = await personWith(org, WIDE);
    await world(me, org, customer, admin);
    // The sign-in is the test harness's single current identity: ask for each person's client right before using it.
    const api = { get: async (path: string) => (await me.api()).get(path) };
    const everyone = { get: async (path: string) => (await wide.api()).get(path) };

    // The wide reader sees both sets, so the narrow reader's answer is a real narrowing and not an empty company.
    expect((await everyone.get('/api/reports/jobs')).body.jobs.map((j: { jobNumber: number }) => j.jobNumber).sort()).toEqual([1001, 2002]);

    const jobs = await api.get('/api/reports/jobs');
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs.map((j: { jobNumber: number }) => j.jobNumber)).toEqual([1001]);

    const leads = await api.get('/api/reports/leads');
    expect(leads.body.leads.map((l: { leadNumber: number }) => l.leadNumber)).toEqual([3001]);

    const estimates = await api.get('/api/reports/estimates');
    expect(estimates.body.rows).toHaveLength(1);
    expect(estimates.body.rows[0].amount).toBe(100);

    const invoices = await api.get('/api/reports/invoices');
    expect(invoices.body.rows).toHaveLength(1);
    expect(invoices.body.rows[0].amount).toBe(100);

    const payments = await api.get('/api/reports/payments');
    expect(payments.body.payments).toHaveLength(1);
    expect(payments.body.payments[0].amount).toBe(50);

    // The totals sum only the reachable rows: 100 invoiced and 50 collected, not 350 and 175.
    const revenue = await api.get('/api/reports/revenue');
    expect(revenue.body.totals).toMatchObject({ invoiced: 100, collected: 50 });
    expect((await everyone.get('/api/reports/revenue')).body.totals).toMatchObject({ invoiced: 350, collected: 175 });
  });

  it('follows the Jobs scope for the activity of a record: an event on a job the person cannot reach is not counted', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, OWN);
    const wide = await personWith(org, WIDE);
    await world(me, org, customer, admin);

    const count = (body: { users: Array<Record<string, unknown>> }) => body.users.length;
    const narrow = await (await me.api()).get('/api/reports/activity');
    const everyone = await (await wide.api()).get('/api/reports/activity');
    expect(narrow.status).toBe(200);
    expect(count(narrow.body)).toBe(1);
    expect(count(everyone.body)).toBe(2);
  });

  it('answers the Billing endpoint from the invoices the person reaches', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, OWN);
    const wide = await personWith(org, WIDE);
    await world(me, org, customer, admin);

    const narrow = await (await me.api()).get('/api/reports/ar-aging');
    const everyone = await (await wide.api()).get('/api/reports/ar-aging');
    expect(narrow.status).toBe(200);
    const numbersOf = (body: { accounts: Array<{ invoices: unknown[] }> }) => body.accounts.flatMap((a) => a.invoices).length;
    expect(numbersOf(narrow.body)).toBe(1);
    expect(numbersOf(everyone.body)).toBe(2);
    expect(narrow.body.salesInWindow).toBe(100);
    expect(everyone.body.salesInWindow).toBe(350);
  });

  it('shows nothing of a kind the person has View off for, rather than the company\'s rows', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OWN, view_jobs: false, view_invoices: false });
    await world(me, org, customer, admin);
    const api = await me.api();

    expect((await api.get('/api/reports/jobs')).body.jobs).toEqual([]);
    expect((await api.get('/api/reports/invoices')).body.rows).toEqual([]);
    expect((await api.get('/api/reports/payments')).body.payments).toEqual([]);
    expect((await api.get('/api/reports/revenue')).body.totals).toMatchObject({ invoiced: 0, collected: 0 });
  });

  it.each([
    'jobs', 'leads', 'estimates', 'revenue', 'payments', 'payment-fees', 'invoices', 'ar-aging', 'estimate-conversion',
  ])('shows no amount in the %s report to a person without See prices', async (report) => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OWN, see_prices: false, see_company_figures: false });
    await world(me, org, customer, admin);

    const res = await (await me.api()).get(`/api/reports/${report}`);
    expect(res.status).toBe(200);
    expect(moneyPaths(res.body)).toEqual([]);
  });

  it('refuses a person without Access reports every report', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OWN, access_reports: false });
    await world(me, org, customer, admin);

    expect((await (await me.api()).get('/api/reports/jobs')).status).toBe(403);
    expect((await (await me.api()).get('/api/reports/revenue')).status).toBe(403);
  });
});
