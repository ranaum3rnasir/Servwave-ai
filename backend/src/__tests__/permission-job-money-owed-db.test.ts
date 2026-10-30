/* =============================================================================
   Roles & Permissions, PRD 6, S06.13 - money owed on a job, one figure everywhere (scenario pass 3, finding 1).

   The rule, in a sentence a non-developer can check: a job owes the larger of what its invoices still have due, every
   live invoice counted on its own (a deposit is part of the same contract, so only what the final invoice leaves after
   it is due), and what it was sold for (the estimate it was sold from, else its own priced lines) less what was paid.
   So adding an invoice never lowers what the job owes, drafted, sent or paid, whatever its amount.

   Every case reads the one figure through all of its doors, and they must agree to the cent:
     - GET /api/jobs/:id            ready_to_close.amount_owed, and whether Mark Done is offered to a person without
                                    "Close jobs with money owed";
     - GET /api/jobs/:id/review     the review panel summary's Balance;
     - GET /api/jobs/:id/financials the Balance card's balance_due;
     - POST /api/jobs/:id/mark-done refused for that person, and for an owner the amount they must confirm.
   Everything goes through the routes, as people on custom roles. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { InvoiceKind, InvoiceStatus, PaymentState, PrismaClient, Role } from '@prisma/client';

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

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, leads_scope: 'all' };

suite('money owed on a job, one figure everywhere (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-money-owed-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The three people every case reads the job as. */
  async function people(org: string) {
    return {
      /** Closes jobs, but not over money owed: the person the rule is for. */
      closer: await personWith(org, { ...OPENING, close_jobs: true }),
      /** Closes jobs even over money owed. */
      owner: await personWith(org, { ...OPENING, close_jobs: true, close_jobs_with_money_owed: true }),
      /** Reads the review panel. */
      reviewer: await personWith(org, { ...OPENING, office_review: true }),
      /** Adds an invoice from the job, as S06.19 lets anyone with Create invoices do in every status. */
      biller: await personWith(org, { ...OPENING, edit_invoices: true, create_invoices: true }),
    };
  }

  const readyJob = (s: Setup) => fx.addJob(s.org, s.customer, { status: 'READY_TO_CLOSE' });

  /** Put a price on the job's own lines, with nothing invoiced. */
  const priceJob = (s: Setup, jobId: string, price: number, quantity = 1) =>
    db.jobLineItem.create({
      data: { organization_id: s.org, job_id: jobId, sequence: 1, description: 'Install', quantity, unit_price: price, line_total: price * quantity, is_taxable: false },
    });

  /** An invoice on the job. `due` is what the invoice itself says is still due (defaults to its total). */
  async function invoiceOn(
    s: Setup,
    where: { jobId?: string; estimateId?: string },
    opts: { total?: number; status?: InvoiceStatus; kind?: InvoiceKind; due?: number } = {},
  ) {
    const total = opts.total ?? 100;
    const id = randomUUID();
    const status = opts.status ?? 'SENT';
    await db.invoice.create({
      data: {
        id, organization_id: s.org, customer_id: s.customer, job_id: where.jobId ?? null, estimate_id: where.estimateId ?? null,
        invoice_number: `INV-${id.slice(0, 8)}`, kind: opts.kind ?? 'STANDARD', status,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: opts.due ?? total,
        voided_at: status === 'VOIDED' ? new Date() : null,
      },
    });
    return id;
  }

  /** A payment on an invoice, by the ledger's states. */
  const payOn = (invoiceId: string, amount: number, opts: { state?: PaymentState; credit?: boolean; refunded?: number } = {}) =>
    db.payment.create({
      data: {
        invoice_id: invoiceId, amount, method: 'CASH', paid_at: new Date(), state: opts.state ?? 'SUCCEEDED',
        reference_number: opts.credit ? 'DEPOSIT-CREDIT' : null, refunded_amount: opts.refunded ?? null,
      },
    });

  const jobOf = (jobId: string) => db.job.findUniqueOrThrow({ where: { id: jobId } });

  /**
   * Read the one figure through every door and assert they all say `expected`. When money is owed, the person without
   * "Close jobs with money owed" is refused on the server and told the amount, the owner must confirm exactly that
   * amount; when nothing is owed, Mark Done is offered. Marks the job Done at the end (the owner's confirmed press),
   * so call it once per job.
   */
  async function expectOwed(s: Setup, jobId: string, expected: number) {
    const who = await people(s.org);
    const closer = await who.closer.api();

    const answer = (await closer.get(`/api/jobs/${jobId}`)).body.job.ready_to_close;
    expect(answer.amount_owed).toBe(expected);
    expect(answer.mark_done).toBe(expected > 0 ? 'disabled' : 'offered');

    expect((await (await who.reviewer.api()).get(`/api/jobs/${jobId}/review`)).body.review.summary.balance).toBe(expected);

    const card = (await closer.get(`/api/jobs/${jobId}/financials`)).body.totals;
    expect(card.balance_due).toBe(expected);

    if (expected === 0) {
      expect((await closer.post(`/api/jobs/${jobId}/mark-done`, {})).status).toBe(200);
      return;
    }
    const refused = await closer.post(`/api/jobs/${jobId}/mark-done`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('JOB_MONEY_OWED');
    expect(refused.body.amount_owed).toBe(expected);
    expect((await jobOf(jobId)).status).toBe('READY_TO_CLOSE');

    const owner = await who.owner.api();
    const asked = await owner.post(`/api/jobs/${jobId}/mark-done`, {});
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe('MARK_DONE_AMOUNT');
    expect(asked.body.amount_owed).toBe(expected);
    expect((await owner.post(`/api/jobs/${jobId}/mark-done`, { confirmed_amount: expected })).status).toBe(200);
    expect((await jobOf(jobId)).status).toBe('DONE');
  }

  /** The same job read as the closer, without closing it: the figure only. */
  async function owedNow(s: Setup, jobId: string, closer: Api) {
    void s;
    return (await closer.get(`/api/jobs/${jobId}`)).body.job.ready_to_close.amount_owed as number;
  }

  describe('one invoice', () => {
    it('partly paid: what is left on it', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 100 }), 40);

      await expectOwed(s, job.id, 60);
    });

    it('is not lowered by a small invoice added later from the job (the scenario pass finding), and Mark Done stays refused', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const first = await invoiceOn(s, { jobId: job.id }, { total: 86.56, status: 'PARTIAL', due: 81.56 });
      await payOn(first, 5);
      const who = await people(s.org);
      const closer = await who.closer.api();
      expect(await owedNow(s, job.id, closer)).toBe(81.56);

      const added = await (await who.biller.api()).post(`/api/jobs/${job.id}/invoices`, { amount: 1 });
      expect(added.status).toBe(201);

      // Every figure still says what is owed, plus the new invoice's own dollar, and the closer is still refused.
      await expectOwed(s, job.id, 82.56);
    });

    it('is not lowered either when the later invoice is sent', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'PARTIAL' }), 20);
      await invoiceOn(s, { jobId: job.id }, { total: 1, status: 'SENT' });

      await expectOwed(s, job.id, 81);
    });
  });

  describe('a deposit and a final invoice', () => {
    it('owes what the final invoice leaves after the deposit credit, as before', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      const deposit = await invoiceOn(s, { estimateId: estimate.id }, { kind: 'DEPOSIT', status: 'PAID', total: 100, due: 0 });
      await payOn(deposit, 100);
      const final = await invoiceOn(s, { jobId: job.id }, { total: 437.5, status: 'PARTIAL', due: 337.5 });
      await payOn(final, 100, { credit: true });

      await expectOwed(s, job.id, 337.5);
    });

    it('owes the final invoice less a deposit that was paid but not drawn on it', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      await payOn(await invoiceOn(s, { estimateId: estimate.id }, { kind: 'DEPOSIT', status: 'PAID', total: 300, due: 0 }), 300);
      await invoiceOn(s, { jobId: job.id }, { total: 1000 });

      await expectOwed(s, job.id, 700);
    });

    it('does not count an unpaid deposit on top of the final invoice', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      await invoiceOn(s, { estimateId: estimate.id }, { kind: 'DEPOSIT', status: 'SENT', total: 100 });
      await invoiceOn(s, { jobId: job.id }, { total: 437.5 });

      await expectOwed(s, job.id, 437.5);
    });
  });

  describe('several invoices', () => {
    it('billed in two draws, each partly paid: both dues count', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'PARTIAL' }), 30);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 200, status: 'PARTIAL' }), 50);

      await expectOwed(s, job.id, 220);
    });

    it('a paid draw does not hide an unpaid one', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 250, status: 'PAID' }), 250);
      await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'SENT' });

      await expectOwed(s, job.id, 100);
    });

    it('an overpaid invoice does not offset an underpaid one: money is owed while any invoice has a balance due', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'PAID' }), 130);
      await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'SENT' });

      await expectOwed(s, job.id, 100);
    });
  });

  describe('drafts', () => {
    it('a draft second invoice adds its due, never lowers what is owed', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'PAID' }), 100);
      await invoiceOn(s, { jobId: job.id }, { total: 20, status: 'DRAFT' });

      await expectOwed(s, job.id, 20);
    });

    it('a draft does not stand in for the job\'s priced lines when nothing has been sent', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);
      const who = await people(s.org);
      const closer = await who.closer.api();
      expect(await owedNow(s, job.id, closer)).toBe(324.6);

      expect((await (await who.biller.api()).post(`/api/jobs/${job.id}/invoices`, { amount: 1 })).status).toBe(201);

      await expectOwed(s, job.id, 324.6);
    });

    it('a draft larger than the job\'s lines owes its own total', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 100);
      await invoiceOn(s, { jobId: job.id }, { total: 150, status: 'DRAFT' });

      await expectOwed(s, job.id, 150);
    });
  });

  describe('voids, credits, refunds', () => {
    it('a voided invoice counts for nothing', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'SENT' });
      await invoiceOn(s, { jobId: job.id }, { total: 500, status: 'VOIDED' });

      await expectOwed(s, job.id, 100);
    });

    it('a voided invoice leaves the job to its own priced lines', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 200);
      await invoiceOn(s, { jobId: job.id }, { total: 500, status: 'VOIDED' });

      await expectOwed(s, job.id, 200);
    });

    it('a credit applied takes the credited amount off what the invoice still has due', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'PARTIAL', due: 60 });
      await db.credit.create({ data: { invoice_id: invoice, amount: 40, created_by: s.admin.id, organization_id: s.org, reason: 'Goodwill' } });

      await expectOwed(s, job.id, 60);
    });

    it('a refund does not reopen what was paid, as the Balance card has always read it', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, { jobId: job.id }, { total: 100, status: 'REFUNDED', due: 0 });
      await payOn(invoice, 100, { refunded: 100 });

      await expectOwed(s, job.id, 0);
    });
  });

  describe('a job with nothing sent', () => {
    it('with priced lines and no invoice owes the lines\' total, the figure Mark Done asks the owner to confirm', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);

      await expectOwed(s, job.id, 324.6);
    });

    it('shows the Balance card the same contract, not "No contract yet"', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);
      const who = await people(s.org);

      const totals = (await (await who.closer.api()).get(`/api/jobs/${job.id}/financials`)).body.totals;

      expect(totals).toMatchObject({ contract_total: 324.6, paid: 0, balance_due: 324.6 });
    });

    it('with nothing priced shows no contract and owes nothing', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const who = await people(s.org);

      const totals = (await (await who.closer.api()).get(`/api/jobs/${job.id}/financials`)).body.totals;
      expect(totals).toMatchObject({ contract_total: null, balance_due: 0 });

      await expectOwed(s, job.id, 0);
    });

    it('owes the estimate it was sold from, less what was paid', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      await payOn(await invoiceOn(s, { estimateId: estimate.id }, { kind: 'DEPOSIT', status: 'PAID', total: 30, due: 0 }), 30);

      await expectOwed(s, job.id, 70);
    });
  });

  describe('an invoice never lowers what the job owes, whatever its state or amount', () => {
    it('a small PAID invoice on a lines-only job leaves the rest of the work owed, and Mark Done refused', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 1, status: 'PAID', due: 0 }), 1);

      await expectOwed(s, job.id, 323.6);
    });

    it('a small SENT invoice on a lines-only job leaves the whole job owed', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);
      await invoiceOn(s, { jobId: job.id }, { total: 1, status: 'SENT' });

      await expectOwed(s, job.id, 324.6);
    });

    it('a SENT invoice at nothing on a lines-only job changes nothing', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await priceJob(s, job.id, 162.3, 2);
      await invoiceOn(s, { jobId: job.id }, { total: 0, status: 'SENT' });

      await expectOwed(s, job.id, 324.6);
    });

    it('a small PAID invoice on an estimate-sold job leaves the rest of the sale owed', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      const sold = Number((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).total_amount);
      await payOn(await invoiceOn(s, { jobId: job.id }, { total: 1, status: 'PAID', due: 0 }), 1);

      await expectOwed(s, job.id, Math.round((sold - 1) * 100) / 100);
    });

    it('a SENT invoice at nothing on an estimate-sold job leaves the whole sale owed', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      const estimate = await fx.addEstimate(s.org, s.customer, s.admin.id, { jobId: job.id });
      await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
      const sold = Number((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).total_amount);
      await invoiceOn(s, { jobId: job.id }, { total: 0, status: 'SENT' });

      await expectOwed(s, job.id, sold);
    });

    it('an invoice for the whole job, paid, owes nothing, and one for more than the job owes its own due', async () => {
      const s = await fx.newOrg();
      const paidUp = await readyJob(s);
      await priceJob(s, paidUp.id, 162.3, 2);
      await payOn(await invoiceOn(s, { jobId: paidUp.id }, { total: 324.6, status: 'PAID', due: 0 }), 324.6);
      await expectOwed(s, paidUp.id, 0);

      const bigger = await readyJob(s);
      await priceJob(s, bigger.id, 100);
      await invoiceOn(s, { jobId: bigger.id }, { total: 250, status: 'SENT' });
      await expectOwed(s, bigger.id, 250);
    });
  });

  describe('a zero-total job', () => {
    it('is never owed, whatever is invoiced at nothing', async () => {
      const s = await fx.newOrg();
      const job = await readyJob(s);
      await invoiceOn(s, { jobId: job.id }, { total: 0, status: 'SENT' });

      await expectOwed(s, job.id, 0);
    });
  });
});
