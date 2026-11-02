/* =============================================================================
   Security finding H3 (ticket 30): account statements, on screen and as a PDF, and the money sections of the customer page
   carry only the invoices (and their payments) the signed-in person can reach, through the existing reach layer.

   One customer holds two people's money: a Sales rep's invoices (on a job from a lead the rep is assigned to) and another
   person's invoices (on a job from someone else's lead), each with a job invoice and a deposit invoice. The rep is on a custom
   role whose invoice reach is "own leads" (the Jobs scope's kept "Through own leads" value; invoices have no scope of their
   own). Everything goes through the HTTP API on a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. The PDF is checked at its generator's edge: what the generator is handed is what the document prints.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The PDF generator's edge: the statement it is handed is what the document prints.
const { generateStatementPdf } = vi.hoisted(() => ({ generateStatementPdf: vi.fn() }));
vi.mock('../lib/pdf', () => ({ generateStatementPdf }));
vi.mock('../lib/pdf/index.js', () => ({ generateStatementPdf }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { withDependantsOff } from './support/switchDependants';
import { THROUGH_OWN_LEADS, findSwitch, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('H3: statements and the customer page follow invoice reach (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    generateStatementPdf.mockReset();
    generateStatementPdf.mockResolvedValue(Buffer.from('%PDF-1.4 statement'));
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  // The switches under test. Invoices have no scope of their own: "own leads" invoice reach is the Jobs scope's kept value.
  const MONEY_READER: Record<string, SwitchValue> = { view_customers: true, view_invoices: true, see_prices: true };

  async function personOn(org: string, base: 'SALES' | 'DISPATCHER', values: Record<string, SwitchValue>) {
    const key = `h3-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await fx.setRoleSwitches(org, key, values);
    const person = await fx.addUser(org, `h3p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A job invoice and a deposit invoice that belong to whoever is assigned to `lead`, with a payment on the job invoice. */
  async function moneyOn(
    org: string, customer: string, admin: Person, lead: string,
    amounts: { invoice: number; paid: number; deposit: number },
  ) {
    const job = await fx.addJob(org, customer, { fromLead: lead });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
    await db.invoice.update({
      where: { id: invoice.id },
      data: { total_amount: amounts.invoice, subtotal: amounts.invoice, amount_due: amounts.invoice - amounts.paid, status: 'PARTIAL' },
    });
    await db.payment.create({
      data: { invoice_id: invoice.id, amount: amounts.paid, method: 'CASH', paid_at: new Date(Date.now() - 86_400_000) },
    });
    const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead });
    const deposit = await fx.addInvoice(org, customer, { estimateId: estimate.id });
    await db.invoice.update({
      where: { id: deposit.id },
      data: { kind: 'DEPOSIT', total_amount: amounts.deposit, subtotal: amounts.deposit, amount_due: amounts.deposit, status: 'SENT' },
    });
    const numbers = await db.invoice.findMany({ where: { id: { in: [invoice.id, deposit.id] } }, select: { id: true, invoice_number: true } });
    const numberOf = (id: string) => numbers.find((n) => n.id === id)!.invoice_number;
    return { job: job.id, invoice: invoice.id, deposit: deposit.id, invoiceNumber: numberOf(invoice.id), depositNumber: numberOf(deposit.id) };
  }

  async function world() {
    const { org, admin, customer } = await fx.newOrg();
    // The rep: a Sales-based custom role reading money, whose invoice reach is "own leads".
    const rep = await personOn(org, 'SALES', { ...MONEY_READER, leads_scope: 'attached', jobs_scope: THROUGH_OWN_LEADS });
    const other = await personOn(org, 'SALES', { ...MONEY_READER, leads_scope: 'attached', jobs_scope: THROUGH_OWN_LEADS });
    // A person with company-wide reach, on a custom role (not the Admin flag).
    const companyWide = await personOn(org, 'DISPATCHER', { ...MONEY_READER, leads_scope: 'all', jobs_scope: 'all' });
    const repLead = await fx.addLead(org, customer, { assignees: [rep.id] });
    const otherLead = await fx.addLead(org, customer, { assignees: [other.id] });
    const mine = await moneyOn(org, customer, admin, repLead.id, { invoice: 100, paid: 40, deposit: 30 });
    const theirs = await moneyOn(org, customer, admin, otherLead.id, { invoice: 250, paid: 70, deposit: 55 });
    // The other person also has a paid invoice and a past-due one on their job, so every financial figure has their money in it.
    const paid = await fx.addInvoice(org, customer, { jobId: theirs.job });
    await db.invoice.update({ where: { id: paid.id }, data: { total_amount: 90, subtotal: 90, amount_due: 0, status: 'PAID' } });
    await db.payment.create({ data: { invoice_id: paid.id, amount: 90, method: 'CASH', paid_at: new Date(Date.now() - 86_400_000) } });
    const pastDue = await fx.addInvoice(org, customer, { jobId: theirs.job });
    await db.invoice.update({
      where: { id: pastDue.id },
      data: { total_amount: 45, subtotal: 45, amount_due: 45, status: 'SENT', due_date: new Date(Date.now() - 10 * 86_400_000) },
    });
    const theirExtras = await db.invoice.findMany({ where: { id: { in: [paid.id, pastDue.id] } }, select: { id: true, invoice_number: true } });
    const theirExtraIds = [paid.id, pastDue.id];
    const theirExtraNumbers = theirExtras.map((i) => i.invoice_number);
    // Estimates on the customer: the rep's two (their lead's, and the one their job came from, $100 each, drafts) and the other
    // person's two the same, plus the other person's won $7,777 one.
    const won = await fx.addEstimate(org, customer, admin.id, { leadId: otherLead.id });
    await db.estimate.update({ where: { id: won.id }, data: { status: 'WON', total_amount: 7777, subtotal: 7777 } });
    // A customer billed through this one that the rep has nothing to do with.
    const member = randomUUID();
    await db.customer.create({
      data: {
        id: member, organization_id: org, customer_number: `M-${member.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Morgan', last_name: 'Member', bill_to_customer_id: customer,
      },
    });
    // A customer the rep cannot reach at all: only the other person's lead is on it.
    const elsewhere = randomUUID();
    await db.customer.create({
      data: {
        id: elsewhere, organization_id: org, customer_number: `X-${elsewhere.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Elsie', last_name: 'Elsewhere', email: 'elsie@example.test',
      },
    });
    const elsewhereLead = await fx.addLead(org, elsewhere, { assignees: [other.id] });
    await moneyOn(org, elsewhere, admin, elsewhereLead.id, { invoice: 500, paid: 0, deposit: 20 });
    const adminApi = () => fx.signedInAs(admin);
    return { org, admin, adminApi, customer, member, elsewhere, rep, companyWide, mine, theirs, theirExtraIds, theirExtraNumbers };
  }

  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => {
    // The role's switches are what the case says they are: invoice reach comes from the Jobs scope, and the kept value is
    // "Through own leads".
    expect(findSwitch('jobs_scope')!.keptValues).toContain(THROUGH_OWN_LEADS);
    w = await world();
  }, 120_000);

  const statementNumbers = (body: { lines: { invoice_number: string }[] }) => [...new Set(body.lines.map((l) => l.invoice_number))].sort();

  describe('the customer statement on screen', () => {
    it('carries only the rep\'s own invoices, and totals over them alone', async () => {
      const api: Api = await w.rep.api();
      const res = await api.get(`/api/statements/customer/${w.customer}`);
      expect(res.status).toBe(200);
      expect(statementNumbers(res.body)).toEqual([w.mine.invoiceNumber, w.mine.depositNumber].sort());
      // Billed 100 + 30, paid 40.
      expect(res.body.totals).toMatchObject({ billed: 130, paid: 40, balance: 90 });
      // The customer billed through this one is someone the rep cannot reach: not named.
      expect(res.body.members).toEqual([]);
    });

    it('carries everything for an Admin and for a person with company-wide reach', async () => {
      for (const who of [w.adminApi, w.companyWide.api]) {
        const api: Api = await who();
        const res = await api.get(`/api/statements/customer/${w.customer}`);
        expect(res.status).toBe(200);
        expect(statementNumbers(res.body)).toEqual(
          [w.mine.invoiceNumber, w.mine.depositNumber, w.theirs.invoiceNumber, w.theirs.depositNumber, ...w.theirExtraNumbers].sort(),
        );
        // Billed 100 + 30 + 250 + 55 + 90 + 45, paid 40 + 70 + 90.
        expect(res.body.totals).toMatchObject({ billed: 570, paid: 200, balance: 370 });
        expect(res.body.members.map((m: { id: string }) => m.id)).toEqual([w.member]);
      }
    });

    it('answers "not found" for a customer the rep cannot reach, the same as for one that does not exist', async () => {
      const api: Api = await w.rep.api();
      const hidden = await api.get(`/api/statements/customer/${w.elsewhere}`);
      const missingApi: Api = await w.rep.api();
      const missing = await missingApi.get(`/api/statements/customer/${randomUUID()}`);
      expect(missing.status).toBe(404);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(missing.body);
    });
  });

  describe('the customer statement as a PDF', () => {
    it('hands the PDF only the rep\'s own invoices and their totals', async () => {
      const api: Api = await w.rep.api();
      const res = await api.get(`/api/statements/customer/${w.customer}?format=pdf`);
      expect(res.status).toBe(200);
      expect(generateStatementPdf).toHaveBeenCalledTimes(1);
      const printed = generateStatementPdf.mock.calls[0]![0] as { lines: { invoice_number: string }[]; totals: Record<string, number> };
      expect(statementNumbers(printed)).toEqual([w.mine.invoiceNumber, w.mine.depositNumber].sort());
      expect(printed.totals).toMatchObject({ billed: 130, paid: 40, balance: 90 });
    });

    it('hands the PDF every invoice for an Admin', async () => {
      const api: Api = await w.adminApi();
      const res = await api.get(`/api/statements/customer/${w.customer}?format=pdf`);
      expect(res.status).toBe(200);
      const printed = generateStatementPdf.mock.calls[0]![0] as { lines: { invoice_number: string }[]; totals: Record<string, number> };
      expect(statementNumbers(printed)).toEqual(
        [w.mine.invoiceNumber, w.mine.depositNumber, w.theirs.invoiceNumber, w.theirs.depositNumber, ...w.theirExtraNumbers].sort(),
      );
      expect(printed.totals).toMatchObject({ billed: 570, paid: 200, balance: 370 });
    });
  });

  describe('the job statement', () => {
    it('opens on the rep\'s own job, and answers "not found" on another person\'s job, on screen and as a PDF', async () => {
      const own = await (await w.rep.api()).get(`/api/statements/job/${w.mine.job}`);
      expect(own.status).toBe(200);
      expect(statementNumbers(own.body)).toEqual([w.mine.invoiceNumber]);

      const missing = await (await w.rep.api()).get(`/api/statements/job/${randomUUID()}`);
      const hidden = await (await w.rep.api()).get(`/api/statements/job/${w.theirs.job}`);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(missing.body);

      const hiddenPdf = await (await w.rep.api()).get(`/api/statements/job/${w.theirs.job}?format=pdf`);
      expect(hiddenPdf.status).toBe(404);
      expect(generateStatementPdf).not.toHaveBeenCalled();
    });

    it('opens on any job for an Admin', async () => {
      const res = await (await w.adminApi()).get(`/api/statements/job/${w.theirs.job}`);
      expect(res.status).toBe(200);
      expect(statementNumbers(res.body)).toEqual([w.theirs.invoiceNumber, ...w.theirExtraNumbers].sort());
    });
  });

  describe('the customer page', () => {
    type Page = {
      customer: { invoices: { id: string }[]; orphan_invoices: { id: string }[] };
      summary: Summary;
    };
    type Summary = {
      financials: Record<string, number>;
      deposits: { collected: number; pending: number };
      estimates: { total: number; pending: number; approved: number; total_value: number };
    };
    // The rep's two $100 drafts.
    const REP_ESTIMATES = { total: 2, pending: 2, approved: 0, total_value: 200 };
    // Four $100 drafts and the won $7,777.
    const ALL_ESTIMATES = { total: 5, pending: 4, approved: 1, total_value: 8177 };

    it('lists only the rep\'s invoices and payments, and adds up only those and the rep\'s estimates', async () => {
      const res = await (await w.rep.api()).get(`/api/customers/${w.customer}`);
      expect(res.status).toBe(200);
      const page = res.body as Page;
      expect(page.customer.invoices.map((i) => i.id)).toEqual([w.mine.invoice]);
      expect(page.customer.orphan_invoices.map((i) => i.id)).toEqual([w.mine.deposit]);
      expect(page.summary.financials).toMatchObject({
        lifetime_revenue: 40, total_invoiced: 100, due_balance: 60, past_due_balance: 0, unpaid_invoice_count: 1, paid_invoice_count: 0,
      });
      expect(page.summary.deposits).toEqual({ collected: 0, pending: 30 });
      expect(page.summary.estimates).toEqual(REP_ESTIMATES);
    });

    it('the summary the page refreshes adds up only the rep\'s invoices and estimates', async () => {
      const res = await (await w.rep.api()).get(`/api/customers/${w.customer}/summary`);
      expect(res.status).toBe(200);
      const summary = res.body as Summary;
      expect(summary.financials).toMatchObject({
        lifetime_revenue: 40, total_invoiced: 100, due_balance: 60, past_due_balance: 0, unpaid_invoice_count: 1, paid_invoice_count: 0,
      });
      expect(summary.deposits).toEqual({ collected: 0, pending: 30 });
      expect(summary.estimates).toEqual(REP_ESTIMATES);
    });

    it('lists no invoice, on the customer or on its jobs, and adds up nothing, for a person who reaches no invoices', async () => {
      // Company-wide reach over jobs and leads, but View invoices off: the jobs are listed, their invoices are not.
      const noInvoices = await personOn(w.org, 'DISPATCHER', {
        // View invoices off takes the invoice switches that need it (Create, Edit, line items, record IDs) off with it.
        view_customers: true, view_jobs: true, ...withDependantsOff(['view_invoices']), see_prices: true, leads_scope: 'all', jobs_scope: 'all',
      });
      const res = await (await noInvoices.api()).get(`/api/customers/${w.customer}`);
      expect(res.status).toBe(200);
      const page = res.body as Page & { customer: { jobs: { id: string; invoices: unknown[] }[] } };
      expect(page.customer.jobs.map((j) => j.id).sort()).toEqual([w.mine.job, w.theirs.job].sort());
      expect(page.customer.jobs.flatMap((j) => j.invoices)).toEqual([]);
      expect(page.customer.invoices).toEqual([]);
      expect(page.customer.orphan_invoices).toEqual([]);
      expect(page.summary.financials).toMatchObject({
        lifetime_revenue: 0, total_invoiced: 0, due_balance: 0, past_due_balance: 0, unpaid_invoice_count: 0, paid_invoice_count: 0,
      });
      expect(page.summary.deposits).toEqual({ collected: 0, pending: 0 });
    });

    it('lists and adds up everything for an Admin and for a person with company-wide reach', async () => {
      for (const who of [w.adminApi, w.companyWide.api]) {
        const res = await (await who()).get(`/api/customers/${w.customer}`);
        expect(res.status).toBe(200);
        const page = res.body as Page;
        expect(page.customer.invoices.map((i) => i.id).sort()).toEqual([w.mine.invoice, w.theirs.invoice, ...w.theirExtraIds].sort());
        expect(page.customer.orphan_invoices.map((i) => i.id).sort()).toEqual([w.mine.deposit, w.theirs.deposit].sort());
        const ALL_FINANCIALS = {
          lifetime_revenue: 200, total_invoiced: 485, due_balance: 240, past_due_balance: 45, unpaid_invoice_count: 3, paid_invoice_count: 1,
        };
        expect(page.summary.financials).toMatchObject(ALL_FINANCIALS);
        expect(page.summary.deposits).toEqual({ collected: 0, pending: 85 });
        expect(page.summary.estimates).toEqual(ALL_ESTIMATES);

        const summary = (await (await who()).get(`/api/customers/${w.customer}/summary`)).body as Summary;
        expect(summary.financials).toMatchObject(ALL_FINANCIALS);
        expect(summary.deposits).toEqual({ collected: 0, pending: 85 });
        expect(summary.estimates).toEqual(ALL_ESTIMATES);
      }
    });
  });
});
