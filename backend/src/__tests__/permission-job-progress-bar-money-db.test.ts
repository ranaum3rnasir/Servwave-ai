/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.21 - the progress bar's money facts on a Done job: GET /api/jobs/:id.

   The bar calls a money step skipped only on a Done job, and only when the job's total is not zero (Invoice sent and
   Payment received) or money is still owed (Payment received). The server's money rule (lib/job-money-owed) is the only
   definition of either, so the job's own answer carries `close_out_money: { money_owed, zero_total }` on a Done job and
   null on any other. Called as people on custom roles holding exactly the switch values under test.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { InvoiceStatus, PaymentState, PrismaClient, Role } from '@prisma/client';

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

vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

// Marking a job Done fires no automation: the job-completed trigger fired once, at Complete.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, invoices_scope: 'all' };

const MONEY_OWED_WORDS = 'Money is still owed on this job. Only someone allowed to close jobs with money owed can mark it Done.';

suite('the progress bar money facts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;

  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-bar-money-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const doneJob = (s: Setup, status: 'DONE' | 'READY_TO_CLOSE' | 'OFFICE_REVIEW' | 'CANCELLED' = 'DONE') => fx.addJob(s.org, s.customer, { status });

  const priceJob = (s: Setup, jobId: string, price: number) =>
    db.jobLineItem.create({
      data: { organization_id: s.org, job_id: jobId, sequence: 1, description: 'Install', quantity: 1, unit_price: price, line_total: price, is_taxable: false },
    });

  async function invoiceOn(s: Setup, jobId: string, total: number) {
    const id = randomUUID();
    await db.invoice.create({
      data: {
        id, organization_id: s.org, customer_id: s.customer, job_id: jobId, invoice_number: `INV-${id.slice(0, 8)}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, status: 'SENT',
      },
    });
    return id;
  }

  const payOn = (invoiceId: string, amount: number) =>
    db.payment.create({ data: { invoice_id: invoiceId, amount, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' } });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const answerOf = async (api: Api, jobId: string) => (await api.get(`/api/jobs/${jobId}`)).body.job;

  it('says money is owed on a Done job with an unpaid invoice', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s);
    await invoiceOn(s, job.id, 75);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toEqual({ money_owed: true, zero_total: false });
  });

  it('says money is owed on a Done job with a price that was never invoiced', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s);
    await priceJob(s, job.id, 60);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toEqual({ money_owed: true, zero_total: false });
  });

  it('says nothing is owed, and the total is not zero, on a Done job that was paid in full', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s);
    const invoice = await invoiceOn(s, job.id, 100);
    await payOn(invoice, 100);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toEqual({ money_owed: false, zero_total: false });
  });

  it('says the total is zero on a Done job with nothing priced and nothing invoiced', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toEqual({ money_owed: false, zero_total: true });
  });

  it('treats a service plan visit job as a zero total: it is billed upfront and never owes', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const plan = await fx.addServicePlan(s.org, s.customer);
    const job = await fx.addJob(s.org, s.customer, { status: 'DONE', sourcePlan: plan.id });
    await priceJob(s, job.id, 80);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toEqual({ money_owed: false, zero_total: true });
  });

  it('gives the same two facts to a person who cannot open the job\'s invoices, and names no invoice', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, { view_jobs: true, jobs_scope: 'all' });
    const job = await doneJob(s);
    const invoice = await invoiceOn(s, job.id, 220);
    const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoice } })).invoice_number;

    const answer = await answerOf(await me.api(), job.id);

    expect(answer.invoices).toEqual([]);
    expect(answer.close_out_money).toEqual({ money_owed: true, zero_total: false });
    expect(JSON.stringify(answer.close_out_money)).not.toContain(number);
  });

  it('sends when the job was marked Done, so the bar can date its last step', async () => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s);
    const closedAt = new Date('2026-10-01T15:30:00.000Z');
    await db.job.update({ where: { id: job.id }, data: { closed_at: closedAt } });

    expect((await answerOf(await me.api(), job.id)).closed_at).toBe(closedAt.toISOString());
  });

  it.each(['READY_TO_CLOSE', 'OFFICE_REVIEW', 'CANCELLED'] as const)('says nothing about it on a job in %s', async (status) => {
    const s = await fx.newOrg();
    const me = await personWith(s.org, OPENING);
    const job = await doneJob(s, status);
    await invoiceOn(s, job.id, 75);

    expect((await answerOf(await me.api(), job.id)).close_out_money).toBeNull();
  });
});
