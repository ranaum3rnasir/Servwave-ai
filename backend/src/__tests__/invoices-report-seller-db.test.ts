/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.10 - whose sale an invoice is on the invoice report.

   Every invoice on a job reads the job's stored Sold By (a job invoice with no estimate of its own
   included, an extra-work invoice on a plan visit job included); a service plan's own invoice reads the
   plan's "Sold by"; other job-less invoices keep their estimate's lead Owner; nobody shows as a dash.
   And the one predicate for "does this job count as a sale for its Sold By" tells a plan's booked visit
   jobs from every other job, so a count built on it gives the plan's seller one sale.

   Everything goes through the public interface: the report route and the predicate module. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
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

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

suite('the invoice report credits each invoice to its seller (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;
  const salespersonOf = async (setup: Setup, invoiceId: string) => {
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { invoice_number: true } });
    const res = await (await fx.signedInAs(setup.admin)).get('/api/reports/invoices');
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<{ number: string; salesperson: string }>).find((r) => r.number === invoice.invoice_number);
    expect(row, 'the invoice is on the report').toBeDefined();
    return row!.salesperson;
  };
  const seller = async (setup: Setup, tag: string, last = 'Seller') => {
    const user = await fx.addUser(setup.org, tag, 'SALES');
    await db.user.update({ where: { id: user.id }, data: { first_name: tag, last_name: last } });
    return { id: user.id, name: `${tag} ${last}` };
  };

  it('shows the job\'s Sold By on a job invoice with no estimate of its own', async () => {
    const setup = await fx.newOrg();
    const jobSeller = await seller(setup, 'Jobby');
    const job = await fx.addJob(setup.org, setup.customer, { soldBy: jobSeller.id });
    const invoice = await fx.addInvoice(setup.org, setup.customer, { jobId: job.id });

    expect(await salespersonOf(setup, invoice.id)).toBe(jobSeller.name);
  });

  it('shows the job\'s Sold By, not the lead Owner, when the invoice\'s estimate came from a lead with another Owner', async () => {
    const setup = await fx.newOrg();
    const jobSeller = await seller(setup, 'Jobby2');
    const leadOwner = await seller(setup, 'Leadie2');
    const lead = await fx.addLead(setup.org, setup.customer, { owner: leadOwner.id });
    const job = await fx.addJob(setup.org, setup.customer, { soldBy: jobSeller.id, fromLead: lead.id });
    const invoice = await fx.addInvoice(setup.org, setup.customer, { jobId: job.id, estimateId: job.estimateId });

    expect(await salespersonOf(setup, invoice.id)).toBe(jobSeller.name);
  });

  it('shows a dash for an invoice on a job with no Sold By, even when the lead it came from has an Owner', async () => {
    const setup = await fx.newOrg();
    const leadOwner = await seller(setup, 'Leadie3');
    const lead = await fx.addLead(setup.org, setup.customer, { owner: leadOwner.id });
    const job = await fx.addJob(setup.org, setup.customer, { fromLead: lead.id });
    const invoice = await fx.addInvoice(setup.org, setup.customer, { jobId: job.id, estimateId: job.estimateId });

    expect(await salespersonOf(setup, invoice.id)).toBe('—');
  });

  it('shows the plan\'s Sold by on a plan\'s activation invoice and on a renewal invoice', async () => {
    const setup = await fx.newOrg();
    const planSeller = await seller(setup, 'Planner4');
    const plan = await fx.addServicePlan(setup.org, setup.customer, { soldBy: planSeller.id });
    const activation = await fx.addInvoice(setup.org, setup.customer, { servicePlanId: plan.id });
    const renewal = await fx.addInvoice(setup.org, setup.customer, { servicePlanId: plan.id });

    expect(await salespersonOf(setup, activation.id)).toBe(planSeller.name);
    expect(await salespersonOf(setup, renewal.id)).toBe(planSeller.name);
  });

  it('shows a dash for a plan\'s invoice when the plan has no Sold by', async () => {
    const setup = await fx.newOrg();
    const plan = await fx.addServicePlan(setup.org, setup.customer);
    const activation = await fx.addInvoice(setup.org, setup.customer, { servicePlanId: plan.id });

    expect(await salespersonOf(setup, activation.id)).toBe('—');
  });

  it('keeps the estimate\'s lead Owner on another job-less invoice', async () => {
    const setup = await fx.newOrg();
    const leadOwner = await seller(setup, 'Leadie6');
    const lead = await fx.addLead(setup.org, setup.customer, { owner: leadOwner.id });
    const estimate = await fx.addEstimate(setup.org, setup.customer, setup.admin.id, { leadId: lead.id });
    const invoice = await fx.addInvoice(setup.org, setup.customer, { estimateId: estimate.id });

    expect(await salespersonOf(setup, invoice.id)).toBe(leadOwner.name);
  });

  it('shows a dash for a job-less invoice with no estimate, plan or seller', async () => {
    const setup = await fx.newOrg();
    const invoice = await fx.addInvoice(setup.org, setup.customer);

    expect(await salespersonOf(setup, invoice.id)).toBe('—');
  });

  it('shows the visit job\'s Sold By on an extra-work invoice raised on a plan visit job', async () => {
    const setup = await fx.newOrg();
    const planSeller = await seller(setup, 'Planner7');
    const plan = await fx.addServicePlan(setup.org, setup.customer, { soldBy: planSeller.id });
    const visitJob = await fx.addJob(setup.org, setup.customer, { soldBy: planSeller.id, sourcePlan: plan.id });
    const extraWork = await fx.addInvoice(setup.org, setup.customer, { jobId: visitJob.id });

    expect(await salespersonOf(setup, extraWork.id)).toBe(planSeller.name);
  });

  it('counts a plan once for its seller: its booked visit jobs are not sales, a job from a lead is', async () => {
    const { jobCountsAsSale, jobCountsAsSaleWhere } = await import('../lib/jobSale.js');
    const setup = await fx.newOrg();
    const planSeller = await seller(setup, 'Planner8');
    const plan = await fx.addServicePlan(setup.org, setup.customer, { soldBy: planSeller.id });
    const visitJobs = await Promise.all(
      [1, 2, 3].map(() => fx.addJob(setup.org, setup.customer, { soldBy: planSeller.id, sourcePlan: plan.id })),
    );
    const lead = await fx.addLead(setup.org, setup.customer, { owner: planSeller.id });
    const leadJob = await fx.addJob(setup.org, setup.customer, { soldBy: planSeller.id, fromLead: lead.id });
    const planInvoice = await fx.addInvoice(setup.org, setup.customer, { servicePlanId: plan.id });

    const rows = await db.job.findMany({
      where: { organization_id: setup.org, salesperson_id: planSeller.id },
      select: { id: true, source_plan_id: true },
    });
    const counted = rows.filter(jobCountsAsSale).map((r) => r.id);
    expect(counted).toEqual([leadJob.id]);
    for (const visit of visitJobs) {
      expect(jobCountsAsSale(rows.find((r) => r.id === visit.id)!)).toBe(false);
    }

    // The same question asked as a query agrees with the row-by-row answer.
    const countedByQuery = await db.job.findMany({
      where: { organization_id: setup.org, salesperson_id: planSeller.id, ...jobCountsAsSaleWhere },
      select: { id: true },
    });
    expect(countedByQuery.map((r) => r.id)).toEqual(counted);

    // The plan's sale is credited once, through its invoice.
    expect(await salespersonOf(setup, planInvoice.id)).toBe(planSeller.name);
  });
});
