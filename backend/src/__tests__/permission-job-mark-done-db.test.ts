/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.13 - Mark Done: POST /api/jobs/:id/mark-done.

   Mark Done moves a job from Ready to close to Done, stamping when and by whom and writing the history entry. Money
   owed (the job's balance above zero, or a positive total with nothing invoiced) also needs Close jobs with money owed
   and the amount the person confirmed, checked against what is owed inside the transaction. Everything goes through the
   public interface (the job routes, called as people on custom roles holding exactly the switch values under test).
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

suite('mark Done (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-mark-done-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** Someone who closes jobs and nothing else (it opens jobs and invoices, which every close needs). */
  const closer = (org: string, extra: Record<string, SwitchValue> = {}) => personWith(org, { ...OPENING, close_jobs: true, ...extra });
  /** Someone who closes jobs even over money owed. */
  const owedCloser = (org: string, extra: Record<string, SwitchValue> = {}) => closer(org, { close_jobs_with_money_owed: true, ...extra });

  /** A job in Ready to close with nothing on it, so nothing is owed. */
  const readyJob = (s: Setup, status: 'READY_TO_CLOSE' | 'OFFICE_REVIEW' | 'DONE' | 'IN_PROGRESS' | 'CANCELLED' = 'READY_TO_CLOSE') =>
    fx.addJob(s.org, s.customer, { status });

  /** Put a price on the job's own lines, with nothing invoiced. */
  const priceJob = (s: Setup, jobId: string, price: number) =>
    db.jobLineItem.create({
      data: { organization_id: s.org, job_id: jobId, sequence: 1, description: 'Install', quantity: 1, unit_price: price, line_total: price, is_taxable: false },
    });

  /** An invoice on the job. */
  async function invoiceOn(s: Setup, jobId: string, opts: { total?: number; status?: InvoiceStatus; voided?: boolean } = {}) {
    const total = opts.total ?? 100;
    const id = randomUUID();
    await db.invoice.create({
      data: {
        id, organization_id: s.org, customer_id: s.customer, job_id: jobId, invoice_number: `INV-${id.slice(0, 8)}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, status: opts.status ?? 'SENT',
        voided_at: opts.voided ? new Date() : null,
      },
    });
    return id;
  }

  /** A payment on an invoice, by the ledger's states. */
  const payOn = (invoiceId: string, amount: number, opts: { state?: PaymentState; voided?: boolean } = {}) =>
    db.payment.create({
      data: { invoice_id: invoiceId, amount, method: 'CASH', paid_at: new Date(), state: opts.state ?? 'SUCCEEDED', voided_at: opts.voided ? new Date() : null },
    });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const markDone = (api: Api, jobId: string, confirmed?: number | null) =>
    api.post(`/api/jobs/${jobId}/mark-done`, confirmed === undefined ? {} : { confirmed_amount: confirmed });
  const jobOf = (jobId: string) => db.job.findUniqueOrThrow({ where: { id: jobId } });
  const events = (jobId: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: 'JOB_MARKED_DONE' } });
  const answerOf = async (api: Api, jobId: string) => (await api.get(`/api/jobs/${jobId}`)).body.job;

  describe('Ready to close to Done', () => {
    it('moves a Ready to close job to Done, records who closed it and when, and writes the history entry', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      const before = Date.now();

      const res = await markDone(await me.api(), job.id);

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe('DONE');
      const row = await jobOf(job.id);
      expect(row.status).toBe('DONE');
      expect(row.closed_by_id).toBe(me.id);
      expect(row.closed_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const history = await events(job.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ created_by: me.id });
      expect(history[0]!.description).toMatch(/marked Done/);
    });

    it('fires no automation and writes no alert: the job-completed trigger fired once, at Complete', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      dispatched.mockClear();

      expect((await markDone(await me.api(), job.id)).status).toBe(200);

      expect(dispatched).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: s.org } })).toBe(0);
    });

    it('is not blocked by a visit still on the books', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await fx.addJob(s.org, s.customer, { status: 'READY_TO_CLOSE', crew: [s.admin.id] });

      expect((await markDone(await me.api(), job.id)).status).toBe(200);
      expect((await jobOf(job.id)).status).toBe('DONE');
    });

    it('is refused from Office review with "Finish the office review first", also for a person holding both switches, and nothing is stamped', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org, { office_review: true });
      const job = await readyJob(s, 'OFFICE_REVIEW');

      const res = await markDone(await me.api(), job.id);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Finish the office review first');
      const row = await jobOf(job.id);
      expect(row).toMatchObject({ status: 'OFFICE_REVIEW', closed_at: null, closed_by_id: null });
      expect(await events(job.id)).toHaveLength(0);
    });

    it.each(['IN_PROGRESS', 'DONE', 'CANCELLED'] as const)('is refused from %s', async (status) => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s, status);

      const res = await markDone(await me.api(), job.id);

      expect(res.status).toBe(409);
      expect((await jobOf(job.id)).status).toBe(status);
      expect(await events(job.id)).toHaveLength(0);
    });

    it('serves two people marking Done at once one after the other: one wins and the other gets a plain refusal', async () => {
      const s = await fx.newOrg();
      const first = await closer(s.org);
      const second = await closer(s.org);
      const job = await readyJob(s);
      const [a, b] = await Promise.all([first.api(), second.api()]);

      const results = await Promise.all([markDone(a, job.id), markDone(b, job.id)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409)!;
      expect(refused.body.error).toBe('This job is already Done.');
      expect(await events(job.id)).toHaveLength(1);
      expect([first.id, second.id]).toContain((await jobOf(job.id)).closed_by_id);
    });
  });

  describe('money owed', () => {
    it('counts a job with a positive total and nothing invoiced as owed: Close jobs alone is refused, with the reason and the amount', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      await priceJob(s, job.id, 250);

      const res = await markDone(await me.api(), job.id);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(MONEY_OWED_WORDS);
      expect(res.body.amount_owed).toBe(250);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');
    });

    it('never counts a zero-total job as owed', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      await priceJob(s, job.id, 0);

      expect((await markDone(await me.api(), job.id)).status).toBe(200);
    });

    it('counts the open balance on a non-voided invoice, and a payment that cleared brings it to zero', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const owing = await readyJob(s);
      const paid = await readyJob(s);
      await invoiceOn(s, owing.id, { total: 100 });
      await payOn(await invoiceOn(s, paid.id, { total: 100, status: 'PAID' }), 100);
      const api = await me.api();

      expect((await markDone(api, owing.id)).status).toBe(403);
      expect((await markDone(api, paid.id)).status).toBe(200);
    });

    it.each([
      ['a bank debit still clearing', { state: 'PROCESSING' as PaymentState }],
      ['a failed payment', { state: 'FAILED' as PaymentState }],
      ['a voided payment', { voided: true }],
    ])('does not count %s as money paid: the ledger decides what counted', async (_name, opts) => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, job.id, { total: 100 }), 100, opts);

      const res = await markDone(await me.api(), job.id);

      expect(res.status).toBe(403);
      expect(res.body.amount_owed).toBe(100);
    });

    it('drops a voided invoice out of what is owed', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      await invoiceOn(s, job.id, { total: 400, status: 'VOIDED', voided: true });

      expect((await markDone(await me.api(), job.id)).status).toBe(200);
    });

    it('owes the same figure the job page\'s Balance card shows', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, job.id, { total: 480 });
      await payOn(invoice, 130);
      await payOn(invoice, 50, { state: 'PROCESSING' });
      const api = await me.api();

      const financials = (await api.get(`/api/jobs/${job.id}/financials`)).body.totals;
      const card = Math.max(financials.contract_total - financials.paid, 0);
      const block = (await answerOf(api, job.id)).ready_to_close;

      expect(card).toBe(350);
      expect(block.amount_owed).toBe(card);
    });

    it('lets a holder of Close jobs with money owed confirm the amount: refused without it, closed with it', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      await invoiceOn(s, job.id, { total: 100 });
      const api = await me.api();

      const asked = await markDone(api, job.id);
      expect(asked.status).toBe(409);
      expect(asked.body.code).toBe('MARK_DONE_AMOUNT');
      expect(asked.body.amount_owed).toBe(100);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');

      const closed = await markDone(api, job.id, 100);
      expect(closed.status).toBe(200);
      expect((await jobOf(job.id)).status).toBe('DONE');
      const entry = (await events(job.id))[0]!;
      expect(entry.description).toMatch(/\$100\.00 still owed/);
      expect(entry.metadata).toMatchObject({ owed_amount: 100 });
    });

    it('refuses an amount that is no longer what is owed, with the new amount, and leaves the job in Ready to close', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, job.id, { total: 100 });
      await payOn(invoice, 40);

      const res = await markDone(await me.api(), job.id, 100);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('$60.00');
      expect(res.body.amount_owed).toBe(60);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');
    });

    it('does not let a payment that lands while the request is deciding slip a job with money owed past the amount confirmed', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, job.id, { total: 100 });
      const api = await me.api();
      let request: Promise<Awaited<ReturnType<typeof markDone>>> | undefined;

      // A payment is mid-write (it holds the invoice, as every money writer does) when the person presses Mark Done
      // having confirmed $100. The request must wait for the payment, then see $60 owed.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice}::uuid FOR UPDATE`;
        await tx.payment.create({ data: { invoice_id: invoice, amount: 40, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' } });
        // `.then` sends it now (a supertest request is lazy until something waits on it).
        request = markDone(api, job.id, 100).then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      });
      const res = await request!;

      expect(res.status).toBe(409);
      expect(res.body.amount_owed).toBe(60);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');
    });

    it('refuses an amount confirmed on a job that has since been paid in full', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      await payOn(await invoiceOn(s, job.id, { total: 100 }), 100);

      const res = await markDone(await me.api(), job.id, 100);

      expect(res.status).toBe(409);
      expect(res.body.amount_owed).toBe(0);
    });

    it('never owes a service plan visit job, which is billed upfront', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const plan = await fx.addServicePlan(s.org, s.customer);
      const job = await fx.addJob(s.org, s.customer, { status: 'READY_TO_CLOSE', sourcePlan: plan.id });
      await priceJob(s, job.id, 90);

      expect((await markDone(await me.api(), job.id)).status).toBe(200);
    });
  });

  describe('route-level enforcement', () => {
    it('lets Mark Done in with Close jobs on and refuses it with Close jobs off, even with Close jobs with money owed on', async () => {
      const s = await fx.newOrg();
      const holder = await closer(s.org);
      const reviewOnly = await personWith(s.org, { ...OPENING, office_review: true, close_jobs_with_money_owed: true });
      const job = await readyJob(s);
      const other = await readyJob(s);

      const refused = await markDone(await reviewOnly.api(), other.id);
      expect(refused.status).toBe(403);
      expect((await jobOf(other.id)).status).toBe('READY_TO_CLOSE');
      expect((await markDone(await holder.api(), job.id)).status).toBe(200);
    });

    it('lets Mark Done with money owed in with its switch on and refuses it with the switch off', async () => {
      const s = await fx.newOrg();
      const holder = await owedCloser(s.org);
      const without = await closer(s.org);
      const job = await readyJob(s);
      const other = await readyJob(s);
      await invoiceOn(s, job.id);
      await invoiceOn(s, other.id);

      expect((await markDone(await without.api(), other.id, 100)).status).toBe(403);
      expect((await jobOf(other.id)).status).toBe('READY_TO_CLOSE');
      expect((await markDone(await holder.api(), job.id, 100)).status).toBe(200);
    });

    it('leaves a job outside the person\'s Jobs reach alone', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPENING, jobs_scope: 'attached', close_jobs: true });
      const job = await readyJob(s);

      const res = await markDone(await me.api(), job.id);

      expect([403, 404]).toContain(res.status);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');
    });

    it('answers a job that is not in the company with a plain 404', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      expect((await markDone(await me.api(), randomUUID())).status).toBe(404);
    });
  });

  describe("the job's own answer", () => {
    it('offers Mark Done to a Close jobs holder on a Ready to close job with nothing owed', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);

      const answer = await answerOf(await me.api(), job.id);

      expect(answer.actions).toContain('mark_done');
      expect(answer.ready_to_close).toEqual({ amount_owed: 0, mark_done: 'offered', mark_done_reason: null, confirm_amount: false, review_changes: false });
    });

    it('offers it with the amount to confirm to a holder of Close jobs with money owed when money is owed', async () => {
      const s = await fx.newOrg();
      const me = await owedCloser(s.org);
      const job = await readyJob(s);
      await invoiceOn(s, job.id, { total: 75 });

      const answer = await answerOf(await me.api(), job.id);

      expect(answer.actions).toContain('mark_done');
      expect(answer.ready_to_close).toMatchObject({ amount_owed: 75, mark_done: 'offered', confirm_amount: true });
    });

    it('draws it disabled with the reason and the amount for a Close jobs holder without Close jobs with money owed', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      await invoiceOn(s, job.id, { total: 75 });

      const answer = await answerOf(await me.api(), job.id);

      expect(answer.actions).not.toContain('mark_done');
      expect(answer.ready_to_close).toEqual({ amount_owed: 75, mark_done: 'disabled', mark_done_reason: MONEY_OWED_WORDS, confirm_amount: false, review_changes: false });
    });

    it('shows a reviewer who cannot close the amount and no Mark Done', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { ...OPENING, office_review: true });
      const job = await readyJob(s);
      await priceJob(s, job.id, 60);

      const answer = await answerOf(await me.api(), job.id);

      expect(answer.actions).not.toContain('mark_done');
      expect(answer.ready_to_close).toEqual({ amount_owed: 60, mark_done: 'none', mark_done_reason: null, confirm_amount: false, review_changes: true });
    });

    it('says nothing about Ready to close to a person who neither closes nor reviews, or on a job in another status', async () => {
      const s = await fx.newOrg();
      const outsider = await personWith(s.org, { ...OPENING });
      const holder = await owedCloser(s.org);
      const ready = await readyJob(s);
      const inReview = await readyJob(s, 'OFFICE_REVIEW');

      expect((await answerOf(await outsider.api(), ready.id)).ready_to_close).toBeNull();
      const review = await answerOf(await holder.api(), inReview.id);
      expect(review.ready_to_close).toBeNull();
      expect(review.actions).not.toContain('mark_done');
    });

    it('gives a Close jobs holder who cannot open the job\'s invoices the job\'s balance and never names an invoice', async () => {
      const s = await fx.newOrg();
      const me = await personWith(s.org, { view_jobs: true, jobs_scope: 'all', close_jobs: true, close_jobs_with_money_owed: true });
      const job = await readyJob(s);
      const invoice = await invoiceOn(s, job.id, { total: 220 });
      const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoice } })).invoice_number;

      const answer = await answerOf(await me.api(), job.id);

      expect(answer.invoices).toEqual([]);
      expect(answer.ready_to_close).toMatchObject({ amount_owed: 220, mark_done: 'offered', confirm_amount: true });
      expect(JSON.stringify(answer.ready_to_close)).not.toContain(number);
      // The same person closes it, confirming the amount they were shown.
      expect((await markDone(await me.api(), job.id, 220)).status).toBe(200);
    });

    it('takes Mark Done away once the job is Done', async () => {
      const s = await fx.newOrg();
      const me = await closer(s.org);
      const job = await readyJob(s);
      const api = await me.api();
      expect((await markDone(api, job.id)).status).toBe(200);

      const answer = await answerOf(api, job.id);

      expect(answer.status).toBe('DONE');
      expect(answer.actions).not.toContain('mark_done');
      expect(answer.ready_to_close).toBeNull();
    });
  });
});
