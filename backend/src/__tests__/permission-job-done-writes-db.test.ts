/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.19 - writes on a Done job.

   Done ends the job, but money can still come in. On a Done job, in three groups:

   1. ALLOWED under their own switches, and the job STAYS Done (status, closed stamps, review round byte-identical, no
      alert, no move): payments, applied deposits, refunds, payment voids, invoice voids, invoice and payment-link sends
      and resends, a new invoice from the job, a note added and an upload.
   2. REFUSED FOR EVERYONE, Change locked jobs holders and the org admin included, with "This job is Done. Reopen it to
      change its lines or prices.": job line, scope and discount edits, and line, scope and discount edits on the job's
      invoices (the invoices on the job, made from its estimate, or made from an estimate attached to it).
   3. NEEDING Change locked jobs, and leaving the job Done: deletes (files, invoice files, notes) and detail changes
      (the job's own details, and the customer details on the job).

   The job's own answer and the invoice's answer carry the Done sentence, so the pages draw their line and price
   controls closed with it; the browser never tests the status.

   Everything goes through the public interface: the job and invoice routes, called as people on custom roles (never a
   built-in role name; the org admin is asked in group 2 because the PRD names it) holding exactly the switch values under
   test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

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

// The suite-wide setup hands every record the same number; these cases create several records in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The PRD's own wording (not read from the code). */
const DONE_MESSAGE = 'This job is Done. Reopen it to change its lines or prices.';
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job, its invoices and its files takes, with no action switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', edit_jobs: true, create_jobs: true,
  view_invoices: true, leads_scope: 'all', view_customers: true,
};

type Res = { status: number; body: Record<string, any> };

suite('writes on a Done job (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['attachments', 'notes', 'record_contact_entries', 'job_reviews', 'job_line_items', 'workflow_enrollments']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `done-writes-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    // A send by hand goes out from the sender's own mailbox (PRD 10, S10.12).
    await fx.addUserMailbox(org, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A Done job: closed by the admin, one $100 job line, one $50 scope, a finished review round, an estimate attached to
   * it (with its own invoice), and an invoice made from the job. `deposit` makes the job's own estimate carry a paid
   * deposit, which a new invoice from the job draws down.
   */
  async function doneWorld(opts: { status?: JobStatus; deposit?: boolean } = {}) {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { accepted_payment_methods: ['CASH', 'CHECK'] } });
    await db.customer.update({ where: { id: customer }, data: { phone: '6175550101', email: `pat-${org.slice(0, 8)}@example.test` } });
    const job = await fx.addJob(org, customer, { status: opts.status ?? 'DONE' });
    const closedAt = new Date(Date.now() - 3_600_000);
    const scopeId = randomUUID();
    await db.job.update({
      where: { id: job.id },
      data: {
        tax_rate: 0, completed_at: closedAt, closed_at: opts.status && opts.status !== 'DONE' ? null : closedAt,
        closed_by_id: opts.status && opts.status !== 'DONE' ? null : admin.id,
        scopes: [{ id: scopeId, title: 'Install', body: '', flat_price: 50, is_taxable: true, internal_cost: null }],
      },
    });
    const line = await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Door', quantity: 1, unit_price: 100, line_total: 100 },
    });
    await db.jobReview.create({
      data: { organization_id: org, job_id: job.id, window_start: closedAt, state: 'FINISHED', finished_by_id: admin.id, finished_at: closedAt },
    });
    const onJob = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    // Made from the job's own estimate (no job on the invoice), and from an estimate attached to the job.
    const primary = await fx.addEstimate(org, customer, admin.id);
    await db.job.update({ where: { id: job.id }, data: { estimate_id: primary.id } });
    await db.estimate.update({ where: { id: primary.id }, data: { job_id: job.id } });
    const viaEstimate = await fx.addInvoice(org, customer, { estimateId: primary.id });
    const attached = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const viaAttached = await fx.addInvoice(org, customer, { estimateId: attached.id });
    // Not the job's: a standalone invoice and an invoice on a job that is still open.
    const standalone = await fx.addInvoice(org, customer, { createdBy: admin.id });
    const openJob = await fx.addJob(org, customer, { status: 'SCHEDULED' });
    const onOpenJob = await fx.addInvoice(org, customer, { jobId: openJob.id, createdBy: admin.id });
    for (const invoice of [onJob, viaEstimate, viaAttached, standalone, onOpenJob]) {
      await db.invoice.update({
        where: { id: invoice.id },
        data: { scopes: [{ id: randomUUID(), title: 'Install', body: '', flat_price: 50, is_taxable: true, internal_cost: null }] },
      });
    }
    if (opts.deposit) {
      const depositInvoice = randomUUID();
      await db.invoice.create({
        data: {
          id: depositInvoice, organization_id: org, customer_id: customer, estimate_id: primary.id, kind: 'DEPOSIT',
          invoice_number: `D-${depositInvoice.slice(0, 8)}`, subtotal: 40, tax_amount: 0, total_amount: 40, amount_due: 0,
          net_collected: 40, status: 'PAID', paid_at: new Date(),
        },
      });
      await db.payment.create({
        data: { invoice_id: depositInvoice, amount: 40, method: 'CHECK', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
      });
    }
    return { org, customer, admin, job, scopeId, lineId: line.id, onJob, viaEstimate, viaAttached, standalone, onOpenJob, primary };
  }
  type World = Awaited<ReturnType<typeof doneWorld>>;

  /** What "the job stays Done" means: the close-out stamps and the review round, byte for byte. */
  async function closeOutState(jobId: string) {
    return {
      job: await db.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { status: true, closed_at: true, closed_by_id: true, completed_at: true, sub_status_id: true },
      }),
      reviews: await db.jobReview.findMany({
        where: { job_id: jobId }, orderBy: { id: 'asc' },
        select: { id: true, state: true, window_start: true, finished_by_id: true, finished_at: true },
      }),
    };
  }

  /** The alerts and automation enrollments in the company: a write on a Done job must not add any because the job is Done. */
  async function reach(w: World) {
    return {
      alerts: (await db.notification.findMany({ where: { organization_id: w.org }, select: { verb: true }, orderBy: { created_at: 'asc' } })).map((n) => n.verb),
      enrollments: await db.workflowEnrollment.count({ where: { entity_id: w.job.id } }),
    };
  }

  /** The prices a job and its invoices hold: lines, scopes, discount, tax and totals. */
  async function prices(w: World) {
    const invoiceIds = [w.onJob.id, w.viaEstimate.id, w.viaAttached.id, w.standalone.id, w.onOpenJob.id];
    return JSON.stringify({
      job: await db.job.findUniqueOrThrow({
        where: { id: w.job.id },
        select: { tax_rate: true, discount_type: true, discount_value: true, discount_amount: true, scopes: true },
      }),
      lines: await db.jobLineItem.findMany({ where: { job_id: w.job.id }, orderBy: { id: 'asc' } }),
      invoices: await db.invoice.findMany({
        where: { id: { in: invoiceIds } }, orderBy: { id: 'asc' },
        select: { id: true, subtotal: true, tax_rate: true, tax_amount: true, discount_amount: true, tip: true, total_amount: true, amount_due: true, scopes: true },
      }),
      invoiceLines: await db.invoiceLineItem.findMany({ where: { invoice_id: { in: invoiceIds } }, orderBy: { id: 'asc' } }),
      history: await db.timelineEvent.count({ where: { organization_id: w.org } }),
    });
  }

  // ─── Group 1: allowed, and the job stays Done ─────────────────────────────────────────────────────────────────

  /** A recorded cash payment on an invoice, for the refund and the payment void. */
  async function takePayment(w: World, invoiceId: string, status: 'PARTIAL' | 'PAID' = 'PARTIAL') {
    await db.invoice.update({
      where: { id: invoiceId },
      data: { status, amount_due: status === 'PAID' ? 0 : 60, sent_at: new Date(), ...(status === 'PAID' ? { paid_at: new Date() } : {}) },
    });
    return (
      await db.payment.create({
        data: { invoice_id: invoiceId, amount: 40, method: 'CASH', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
        select: { id: true },
      })
    ).id;
  }

  const ALLOWED: Array<{
    name: string;
    switches: Record<string, SwitchValue>;
    world?: { deposit?: boolean };
    call: (api: Api, w: World) => Promise<Res>;
    status: number | number[];
  }> = [
    { name: 'a payment', switches: { record_payments: true, allowed_payment_methods: ['CASH'] }, status: 201,
      call: (api, w) => api.post(`/api/invoices/${w.onJob.id}/payments`, { amount: 10, method: 'CASH' }) },
    { name: 'a refund', switches: { refund_payments: true, view_payments: true }, status: [200, 201],
      call: async (api, w) => {
        const payment = await takePayment(w, w.onJob.id, 'PAID');
        return api.post(`/api/invoices/${w.onJob.id}/refund`, { payment_id: payment, amount: 10, reason_category: 'GOODWILL', reason: 'Kept the customer' });
      } },
    { name: 'a payment void', switches: { void_payments: true }, status: 200,
      call: async (api, w) => {
        const payment = await takePayment(w, w.onJob.id);
        return api.post(`/api/invoices/${w.onJob.id}/void-payment`, { payment_id: payment, void_category: 'ERROR', reason: 'Typed twice' });
      } },
    { name: 'an invoice void', switches: { void_invoices: true }, status: 200,
      call: async (api, w) => {
        await db.invoice.update({ where: { id: w.onJob.id }, data: { status: 'SENT', sent_at: new Date(), public_token: randomUUID() } });
        return api.post(`/api/invoices/${w.onJob.id}/void`, { voided_reason: 'Sent in error' });
      } },
    { name: 'an invoice send', switches: { edit_invoices: true }, status: 200,
      call: (api, w) => api.post(`/api/invoices/${w.onJob.id}/send`, {}) },
    { name: 'an invoice resend', switches: { edit_invoices: true }, status: 200,
      call: async (api, w) => {
        await db.invoice.update({ where: { id: w.onJob.id }, data: { status: 'SENT', sent_at: new Date(), public_token: randomUUID() } });
        return api.post(`/api/invoices/${w.onJob.id}/resend`, {});
      } },
    { name: 'a payment link', switches: { send_payment_links: true }, status: 200,
      call: (api, w) => api.post(`/api/invoices/${w.onJob.id}/payment-link`, {}) },
    { name: 'a new invoice from the job (a draw of its lines)', switches: { edit_invoices: true, create_invoices: true }, status: 201,
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/invoices`, { percent: 50 }) },
    { name: 'a new invoice from the job (the whole job, with its deposit applied)', switches: { edit_invoices: true, create_invoices: true }, status: 201, world: { deposit: true },
      call: async (api, w) => {
        // One live invoice per job on this door: void the one made from the job first, directly.
        await db.invoice.update({ where: { id: w.onJob.id }, data: { status: 'VOIDED', voided_at: new Date() } });
        return api.post('/api/invoices', { job_id: w.job.id });
      } },
    { name: 'a note added', switches: { add_notes: true }, status: 201,
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/notes`, { content: 'Customer paid by check' }) },
  ];

  describe('group 1: collecting, sending, a new invoice, a note and an upload keep the job Done', () => {
    for (const c of ALLOWED) {
      it(`lets in ${c.name} from a custom role holding only its own switch, and the job stays Done`, async () => {
        const w = await doneWorld(c.world);
        const me = await personWith(w.org, { ...OPENING, ...c.switches });
        const api = await me.api();
        const stateBefore = await closeOutState(w.job.id);
        const reachBefore = await reach(w);
        const pricesBefore = JSON.parse(await prices(w));

        const res = await c.call(api, w);

        expect(Array.isArray(c.status) ? c.status : [c.status], JSON.stringify(res.body)).toContain(res.status);
        expect(res.body.error).not.toBe(LOCK_MESSAGE);
        expect(res.body.error).not.toBe(DONE_MESSAGE);
        // The job is exactly as it was closed: status, who closed it and when, and the review round.
        const stateAfter = await closeOutState(w.job.id);
        expect(stateAfter).toEqual(stateBefore);
        expect(stateAfter.job.status).toBe('DONE');
        // Nothing about the job's close-out was raised: no completed, review or ready-to-close alert, no enrollment on the job.
        // The write's own fire-and-forget work (a receipt, an alert on any job) settles before the count is read.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const reachAfter = await reach(w);
        const raised = reachAfter.alerts.slice(reachBefore.alerts.length);
        expect(raised.filter((verb) => /review|complete|ready|close|reopen/i.test(verb))).toEqual([]);
        expect(reachAfter.enrollments).toBe(reachBefore.enrollments);
        // The job's lines, scopes, discount and tax are untouched by money moving (or a new invoice made from them).
        const pricesAfter = JSON.parse(await prices(w));
        expect(pricesAfter.job).toEqual(pricesBefore.job);
        expect(pricesAfter.lines).toEqual(pricesBefore.lines);
      });
    }

    it('lets in an upload from a custom role holding only Upload attachments, and the job stays Done', async () => {
      const w = await doneWorld();
      const me = await personWith(w.org, { ...OPENING, });
      const api = await me.api();
      const before = await closeOutState(w.job.id);
      // No file is sent, so the route stops at "no file" once every guard has let the person in; the lock would answer 403 first.
      const res = await api.post(`/api/attachments/job/${w.job.id}`, {});
      expect(res.status).not.toBe(403);
      expect(res.body.error).not.toBe(LOCK_MESSAGE);
      expect(res.body.error).not.toBe(DONE_MESSAGE);
      expect(await closeOutState(w.job.id)).toEqual(before);
    });

    it('applies the deposit when the new invoice is drawn from the job, and the invoice carries the job\'s lines as they are', async () => {
      const w = await doneWorld({ deposit: true });
      const me = await personWith(w.org, { ...OPENING, edit_invoices: true, create_invoices: true });
      const api = await me.api();
      await db.invoice.update({ where: { id: w.onJob.id }, data: { status: 'VOIDED', voided_at: new Date() } });

      const res = await api.post('/api/invoices', { job_id: w.job.id });
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const created = await db.invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id }, include: { line_items: true } });
      expect(Number(created.deposit_credit)).toBe(40);
      expect(created.line_items.map((l) => [l.description, Number(l.unit_price)])).toEqual([['Door', 100]]);
      expect((await closeOutState(w.job.id)).job.status).toBe('DONE');
    });
  });

  // ─── Group 2: refused for everyone ──────────────────────────────────────────────────────────────────────────

  const JOB_PRICE_EDITS: Array<{ name: string; call: (api: Api, w: World) => Promise<Res> }> = [
    { name: 'a job line added', call: (api, w) => api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 }) },
    { name: 'a job line changed', call: (api, w) => api.patch(`/api/jobs/${w.job.id}/line-items/${w.lineId}`, { unit_price: 1 }) },
    { name: 'a job line removed', call: (api, w) => api.delete(`/api/jobs/${w.job.id}/line-items/${w.lineId}`) },
    { name: 'the job lines reordered', call: (api, w) => api.patch(`/api/jobs/${w.job.id}/line-items/reorder`, { order: [w.lineId] }) },
    { name: 'a scope added', call: (api, w) => api.post(`/api/jobs/${w.job.id}/scopes`, { title: 'Extra', flat_price: 10 }) },
    { name: 'a scope changed', call: (api, w) => api.patch(`/api/jobs/${w.job.id}/scopes/0`, { flat_price: 1 }) },
    { name: 'a scope removed', call: (api, w) => api.delete(`/api/jobs/${w.job.id}/scopes/0`) },
    { name: 'the scopes reordered', call: (api, w) => api.patch(`/api/jobs/${w.job.id}/scopes/reorder`, { order: [w.scopeId] }) },
    { name: 'the job discount', call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 5 }) },
    { name: 'the job discount sent with another edit', call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { scope_notes: 'also this', discount_type: 'FIXED_AMOUNT', discount_value: 5 }) },
    { name: 'the job tax rate', call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { tax_rate: 0.07 }) },
  ];

  /** Lines, scopes and the billing discount and tax of an invoice the job holds, by the three ways an invoice belongs to a job. */
  const INVOICE_PRICE_EDITS: Array<{ name: string; call: (api: Api, w: World, invoice: string, line: string) => Promise<Res> }> = [
    { name: 'a line added', call: (api, _w, inv) => api.post(`/api/invoices/${inv}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20, is_taxable: false }) },
    { name: 'a line changed', call: (api, _w, inv, line) => api.patch(`/api/invoices/${inv}/line-items/${line}`, { unit_price: 1 }) },
    { name: 'a line removed', call: (api, _w, inv, line) => api.delete(`/api/invoices/${inv}/line-items/${line}`) },
    { name: 'the lines reordered', call: (api, _w, inv, line) => api.patch(`/api/invoices/${inv}/line-items/reorder`, { order: [line] }) },
    { name: 'a scope added', call: (api, _w, inv) => api.post(`/api/invoices/${inv}/scopes`, { title: 'Extra', flat_price: 10 }) },
    { name: 'a scope changed', call: (api, _w, inv) => api.patch(`/api/invoices/${inv}/scopes/0`, { flat_price: 1 }) },
    { name: 'a scope removed', call: (api, _w, inv) => api.delete(`/api/invoices/${inv}/scopes/0`) },
    { name: 'the scopes reordered', call: (api, _w, inv) => api.patch(`/api/invoices/${inv}/scopes/reorder`, { order: [randomUUID()] }) },
    { name: 'the invoice discount', call: (api, _w, inv) => api.patch(`/api/invoices/${inv}/billing`, { discount_amount: 5 }) },
    { name: 'the invoice tax rate', call: (api, _w, inv) => api.patch(`/api/invoices/${inv}/billing`, { tax_rate: 0.07 }) },
  ];

  /** Everything that makes a person able to make every price edit above, Change locked jobs included. */
  const EVERY_PRICE_SWITCH = {
    ...OPENING, edit_jobs: true, edit_job_line_items: true, apply_discounts: true, edit_invoices: true,
    edit_invoice_line_items: true, change_locked_jobs: true,
  };

  describe('group 2: line, scope and discount edits are refused for everyone until the job is reopened', () => {
    for (const edit of JOB_PRICE_EDITS) {
      it(`refuses ${edit.name} with the Done sentence, also for Change locked jobs and the org admin, and writes nothing`, async () => {
        const w = await doneWorld();
        const holder = await personWith(w.org, EVERY_PRICE_SWITCH);
        const without = await personWith(w.org, { ...EVERY_PRICE_SWITCH, change_locked_jobs: false });
        const before = await prices(w);
        for (const api of [await holder.api(), await fx.signedInAs(w.admin)]) {
          const res = await edit.call(api, w);
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(res.body.error).toBe(DONE_MESSAGE);
        }
        // Without the key the job is refused too (on a mixed edit, by the lock's own sentence).
        expect((await edit.call(await without.api(), w)).status).toBe(403);
        expect(await prices(w)).toBe(before);
        expect((await closeOutState(w.job.id)).job.status).toBe('DONE');
      });
    }

    it('tells a person without Change locked jobs the Done sentence too, not that the job is locked', async () => {
      const w = await doneWorld();
      const me = await personWith(w.org, { ...EVERY_PRICE_SWITCH, change_locked_jobs: false });
      const res = await (await me.api()).post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(DONE_MESSAGE);
    });

    it('does not let the Office review exception free a Done job', async () => {
      const w = await doneWorld();
      const reviewer = await personWith(w.org, { ...OPENING, office_review: true, edit_job_line_items: true, apply_discounts: true, edit_jobs: true });
      const api = await reviewer.api();
      const before = await prices(w);
      expect((await api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 })).body.error).toBe(DONE_MESSAGE);
      expect((await api.patch(`/api/jobs/${w.job.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 5 })).body.error).toBe(DONE_MESSAGE);
      expect(await prices(w)).toBe(before);
    });

    const INVOICES: Array<[string, (w: World) => string, (w: World) => string]> = [
      ['an invoice made from the job', (w) => w.onJob.id, (w) => w.onJob.lineId],
      ['an invoice made from the job\'s estimate', (w) => w.viaEstimate.id, (w) => w.viaEstimate.lineId],
      ['an invoice made from an estimate attached to the job', (w) => w.viaAttached.id, (w) => w.viaAttached.lineId],
    ];
    for (const [which, invoiceOf, lineOf] of INVOICES) {
      for (const edit of INVOICE_PRICE_EDITS) {
        it(`refuses ${edit.name} on ${which} with the Done sentence, also for Change locked jobs and the org admin, and writes nothing`, async () => {
          const w = await doneWorld();
          const holder = await personWith(w.org, EVERY_PRICE_SWITCH);
          const before = await prices(w);
          for (const api of [await holder.api(), await fx.signedInAs(w.admin)]) {
            const res = await edit.call(api, w, invoiceOf(w), lineOf(w));
            expect(res.status, JSON.stringify(res.body)).toBe(403);
            expect(res.body.error).toBe(DONE_MESSAGE);
          }
          expect(await prices(w)).toBe(before);
        });
      }
    }

    it('still lets a line be edited on an invoice that is not the Done job\'s: a standalone one, and one on an open job', async () => {
      const w = await doneWorld();
      const api = await fx.signedInAs(w.admin);
      for (const invoice of [w.standalone, w.onOpenJob]) {
        const res = await api.patch(`/api/invoices/${invoice.id}/line-items/${invoice.lineId}`, { unit_price: 90 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
    });

    it('still lets what is not a line or a price change on the Done job\'s invoice: a tip, the due date and a credit is not asked', async () => {
      const w = await doneWorld();
      const api = await fx.signedInAs(w.admin);
      expect((await api.patch(`/api/invoices/${w.onJob.id}/billing`, { tip: 5 })).status).toBe(200);
      expect((await api.patch(`/api/invoices/${w.onJob.id}`, { due_date: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(200);
    });

    it('lets the same edits through on a job that is only Completed, for a Change locked jobs holder: the Done sentence is Done\'s alone', async () => {
      const w = await doneWorld({ status: 'COMPLETED' });
      const holder = await personWith(w.org, EVERY_PRICE_SWITCH);
      const api = await holder.api();
      const line = await api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 });
      expect(line.status, JSON.stringify(line.body)).toBe(201);
      const invoice = await api.patch(`/api/invoices/${w.onJob.id}/line-items/${w.onJob.lineId}`, { unit_price: 90 });
      expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    });

    it('reads the Done sentence the moment the job is reopened: the same edit is let in again', async () => {
      const w = await doneWorld();
      const holder = await personWith(w.org, { ...EVERY_PRICE_SWITCH, reopen_done_jobs: true });
      const api = await holder.api();
      const refused = await api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 });
      expect(refused.body.error).toBe(DONE_MESSAGE);
      const reopened = await api.post(`/api/jobs/${w.job.id}/reopen`, {});
      expect(reopened.status, JSON.stringify(reopened.body)).toBeLessThan(300);
      const allowed = await api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    });
  });

  // ─── Group 3: needs Change locked jobs, and leaves the job Done ───────────────────────────────────────────

  describe('group 3: deletes and detail changes need Change locked jobs and leave the job Done', () => {
    async function withFiles(w: World) {
      const addFile = async (type: 'JOB' | 'INVOICE', id: string) => {
        const file = randomUUID();
        await db.attachment.create({
          data: {
            id: file, organization_id: w.org, entity_type: type, entity_id: id, file_name: `${file}.pdf`,
            file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
            file_size: 10, display_name: `File ${file.slice(0, 4)}`, uploaded_by: w.admin.id,
          },
        });
        return file;
      };
      const note = (await db.note.create({
        data: { organization_id: w.org, entity_type: 'JOB', entity_id: w.job.id, content: 'left by the office', created_by: w.admin.id },
        select: { id: true },
      })).id;
      return { jobFile: await addFile('JOB', w.job.id), invoiceFile: await addFile('INVOICE', w.onJob.id), note };
    }

    const CHANGES: Record<string, (api: Api, w: World, f: Awaited<ReturnType<typeof withFiles>>) => Promise<Res>> = {
      'a job file delete': (api, w, f) => api.delete(`/api/attachments/job/${w.job.id}/${f.jobFile}`),
      'an invoice file delete': (api, w, f) => api.delete(`/api/attachments/invoice/${w.onJob.id}/${f.invoiceFile}`),
      'a note delete': (api, w, f) => api.delete(`/api/jobs/${w.job.id}/notes/${f.note}`),
      'a job detail edit': (api, w) => api.patch(`/api/jobs/${w.job.id}`, { scope_notes: 'changed after close' }),
      'a job customer detail change': (api, w) =>
        api.post(`/api/jobs/${w.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }),
    };
    /** The ordinary switches of the five changes, with neither key to the lock. */
    const WITHOUT_THE_KEY = { ...OPENING, edit_jobs: true, edit_invoices: true, edit_job_and_lead_contact_details: true };

    const standing = async (w: World, f: Awaited<ReturnType<typeof withFiles>>) => ({
      jobFile: await db.attachment.count({ where: { id: f.jobFile } }),
      invoiceFile: await db.attachment.count({ where: { id: f.invoiceFile } }),
      note: await db.note.count({ where: { id: f.note } }),
      scope_notes: (await db.job.findUniqueOrThrow({ where: { id: w.job.id }, select: { scope_notes: true } })).scope_notes,
      entries: await db.recordContactEntry.count({ where: { job_id: w.job.id } }),
    });

    it('refuses all five, with the lock sentence, from a custom role without Change locked jobs', async () => {
      const w = await doneWorld();
      const f = await withFiles(w);
      const me = await personWith(w.org, WITHOUT_THE_KEY);
      const api = await me.api();
      const before = await standing(w, f);
      for (const [name, call] of Object.entries(CHANGES)) {
        const res = await call(api, w, f);
        expect(res.status, name).toBe(403);
        expect(res.body.error, name).toBe(LOCK_MESSAGE);
      }
      expect(await standing(w, f)).toEqual(before);
      expect((await closeOutState(w.job.id)).job.status).toBe('DONE');
    });

    it('lets all five in from a custom role with Change locked jobs on, writes the history entries, and the job stays Done', async () => {
      const w = await doneWorld();
      const f = await withFiles(w);
      const me = await personWith(w.org, { ...WITHOUT_THE_KEY, change_locked_jobs: true });
      const api = await me.api();
      const stateBefore = await closeOutState(w.job.id);
      const historyBefore = await db.timelineEvent.findMany({ where: { organization_id: w.org }, select: { id: true } });
      for (const [name, call] of Object.entries(CHANGES)) {
        const res = await call(api, w, f);
        expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      }
      const after = await standing(w, f);
      expect(after).toMatchObject({ jobFile: 0, invoiceFile: 0, note: 0, scope_notes: 'changed after close' });
      expect(after.entries).toBeGreaterThan(0);
      expect(await closeOutState(w.job.id)).toEqual(stateBefore);
      // The deletes and the customer change are on the job's history; the next review round reads them.
      const made = await db.timelineEvent.findMany({
        where: { organization_id: w.org, id: { notIn: historyBefore.map((e) => e.id) } }, select: { event_type: true },
      });
      const types = made.map((e) => e.event_type);
      expect(types).toEqual(expect.arrayContaining(['ATTACHMENT_DELETED', 'NOTE_DELETED']));
      expect(types.some((t) => t.startsWith('JOB_CONTACT'))).toBe(true);
    });
  });

  // ─── The answers the pages draw from ─────────────────────────────────────────────────────────────────────

  describe('the job\'s answer and the invoice\'s answer', () => {
    it('takes the line and price actions off a Done job for a Change locked jobs holder, names the Done sentence, and keeps the collecting actions', async () => {
      const w = await doneWorld();
      const me = await personWith(w.org, { ...EVERY_PRICE_SWITCH, add_notes: true, edit_invoices: true, create_invoices: true });
      const res = await (await me.api()).get(`/api/jobs/${w.job.id}`);
      expect(res.status).toBe(200);
      const job = res.body.job ?? res.body;
      expect(job.price_edit_closed_reason).toBe(DONE_MESSAGE);
      expect(job.actions).not.toContain('edit_line_items');
      expect(job.actions).not.toContain('apply_discount');
      expect(job.locked_actions).toEqual(expect.arrayContaining(['edit_line_items', 'apply_discount']));
      expect(job.actions).toEqual(expect.arrayContaining(['add_note', 'upload_attachment', 'create_invoice']));
    });

    it('names the Done sentence for a person without Change locked jobs too, and nothing on a job that is not Done', async () => {
      const w = await doneWorld({ status: 'COMPLETED' });
      const me = await personWith(w.org, { ...EVERY_PRICE_SWITCH, change_locked_jobs: false });
      const open = await (await me.api()).get(`/api/jobs/${w.job.id}`);
      expect((open.body.job ?? open.body).price_edit_closed_reason).toBeNull();
      await db.job.update({ where: { id: w.job.id }, data: { status: 'DONE' } });
      const done = await (await me.api()).get(`/api/jobs/${w.job.id}`);
      expect((done.body.job ?? done.body).price_edit_closed_reason).toBe(DONE_MESSAGE);
    });

    it('names the Done sentence on each invoice the Done job holds, and nothing on the others', async () => {
      const w = await doneWorld();
      const api = await fx.signedInAs(w.admin);
      for (const invoice of [w.onJob, w.viaEstimate, w.viaAttached]) {
        const res = await api.get(`/api/invoices/${invoice.id}`);
        expect(res.status).toBe(200);
        expect(res.body.invoice.price_edit_closed_reason, invoice.id).toBe(DONE_MESSAGE);
        // Collecting and sending stay on the list.
        expect(res.body.invoice.actions).toEqual(expect.arrayContaining(['send', 'record_payment']));
      }
      for (const invoice of [w.standalone, w.onOpenJob]) {
        const res = await api.get(`/api/invoices/${invoice.id}`);
        expect(res.body.invoice.price_edit_closed_reason, invoice.id).toBeNull();
      }
    });
  });
});
