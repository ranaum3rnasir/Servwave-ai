/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.8 - the review panel's route, GET /api/jobs/:id/review, and the job page's
   per-record answer for it.

   The route builds the change-set (M8) from the job's real history and details. Only a holder of Office review gets it;
   the job's own answer lists the review action for that person while the job is in Office review, so the banner is
   drawn from the server's answer and never re-derived in the browser.

   Everything goes through the public interface (the job routes, called as people on custom roles holding exactly the
   switch values under test). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, invoices_scope: 'all' };

suite('the office review panel (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-review-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A history entry on the job, in the shape the earlier slices write it. */
  async function history(org: string, jobId: string, event_type: string, metadata: object | null, over: { at?: Date; by?: string; description?: string } = {}) {
    return db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'JOB', entity_id: jobId, event_type, description: over.description ?? event_type,
        metadata: (metadata ?? undefined) as never, created_by: over.by ?? null, created_at: over.at ?? new Date(),
      },
    });
  }

  const line = (over: Record<string, unknown> = {}) => ({
    name: 'Spring', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true,
    discount_type: null, discount_value: null, discount_amount: 0, ...over,
  });

  /** A job in Office review with its open round, the way the complete leaves it. */
  async function reviewJob(org: string, customer: string, windowStart = new Date(Date.now() - 3_600_000), opts: { status?: 'OFFICE_REVIEW' | 'READY_TO_CLOSE' | 'IN_PROGRESS' } = {}) {
    const job = await fx.addJob(org, customer, { status: opts.status ?? 'OFFICE_REVIEW' });
    await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: windowStart } });
    return job;
  }

  it('lets a holder of Office review open the panel of a job with no changes, with the job summary and one item to check', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.status).toBe(200);
    const review = res.body.review as { summary: { key: string; job_number: string; checked: boolean }; groups: { key: string; items: unknown[] }[]; totals: unknown };
    expect(review.summary.key).toBe('summary');
    expect(review.summary.job_number).toMatch(/^J-/);
    expect(review.summary.checked).toBe(false);
    expect(review.groups.map((g) => g.key)).toEqual(['unusual', 'customer', 'lines', 'attachments', 'notes', 'payments']);
    expect(review.groups.every((g) => g.items.length === 0)).toBe(true);
    expect(review.totals).toEqual({ items: 1, checked: 0, unusual: 0 });
  });

  it('refuses a person with Office review off, even one who can open and complete the job', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: false, complete_jobs: true, close_jobs: true });
    const job = await reviewJob(org, customer);
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.status).toBe(403);
  });

  it('refuses a job from another company', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const me = await personWith(a.org, { ...OPENING, office_review: true });
    const job = await reviewJob(b.org, b.customer);
    expect((await (await me.api()).get(`/api/jobs/${job.id}/review`)).status).toBe(404);
  });

  it('refuses a job the person cannot open under their jobs scope', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, jobs_scope: 'attached', office_review: true });
    const job = await reviewJob(org, customer);
    expect((await (await me.api()).get(`/api/jobs/${job.id}/review`)).status).toBe(403);
  });

  it('says a job that is not in office review has no review to show', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/not in office review/i);
  });

  it('builds the items from the job history since the round started, one item per thing', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const start = new Date(Date.now() - 3_600_000);
    const job = await reviewJob(org, customer, start);
    const lineId = randomUUID();
    const t = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    await history(org, job.id, 'JOB_LINE_ADDED', { line_id: randomUUID(), old: null, new: line() }, { at: new Date(start.getTime() - 60_000), by: admin.id });
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line({ unit_price: 100 }), new: line({ unit_price: 90, line_total: 90 }) }, { at: t(1), by: admin.id });
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line({ unit_price: 90 }), new: line({ unit_price: 80, line_total: 80 }) }, { at: t(2), by: admin.id });
    await history(org, job.id, 'ATTACHMENT_DELETED', { attachment_id: randomUUID(), file_name: 'a.png', display_name: 'Door.png', uploaded_by_name: 'Lee', deleted_by_name: 'Test Admin' }, { at: t(3), by: admin.id });
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.status).toBe(200);
    const review = res.body.review as { groups: { key: string; items: { key: string; by: string; unusual: boolean; changes: { label: string; old: string; new: string }[] }[] }[]; totals: unknown };
    const lines = review.groups.find((g) => g.key === 'lines')!.items;
    expect(lines.map((i) => i.key)).toEqual([`line:${lineId}`]);
    expect(lines[0]!.by).toBe('Test Admin');
    expect(lines[0]!.changes).toContainEqual({ label: 'Unit price', old: '$100.00', new: '$80.00' });
    expect(review.groups.find((g) => g.key === 'unusual')!.items.map((i) => i.key).sort()).toEqual(
      [`line:${lineId}`, expect.stringMatching(/^attachment:/)].sort(),
    );
    expect(review.totals).toEqual({ items: 3, checked: 0, unusual: 2 });
  });

  it('shows the job summary from the real job: customer, address, visits, lines, total, balance, files and notes', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true, see_financial_data: true });
    const job = await reviewJob(org, customer);
    await fx.addVisit(org, { jobId: job.id, crew: [admin.id], daysFromNow: -2 });
    await db.jobLineItem.create({
      data: { organization_id: org, job_id: job.id, sequence: 1, description: 'Spring', quantity: 2, unit_price: 100, unit_cost: 60, line_total: 200 },
    });
    await db.note.create({ data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, content: 'Gate code', created_by: admin.id } });
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    const summary = res.body.review.summary;
    expect(summary.customer.name).toBe('Pat Payer');
    expect(summary.service_address).toContain('1 Test Way');
    expect(summary.visits).toHaveLength(1);
    expect(summary.visits[0]).toMatchObject({ seq: 1, outcome: 'finished', crew: ['Test Admin'], cancelled_by_complete: false });
    expect(summary.lines).toEqual([{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200, unit_cost: 60 }]);
    expect(summary.total).toBe(200);
    expect(summary.total_cost).toBe(120);
    expect(summary.note_count).toBe(1);
    expect(summary.file_count).toBe(0);
  });

  it('marks a visit the complete cancelled, and tells it from one a person cancelled', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const byComplete = await fx.addVisit(org, { jobId: job.id, seq: 1 });
    const byPerson = await fx.addVisit(org, { jobId: job.id, seq: 2 });
    await db.visit.update({ where: { id: byComplete }, data: { status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Job completed' } });
    await db.visit.update({ where: { id: byPerson }, data: { status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Customer rescheduled' } });
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    const visits = res.body.review.summary.visits as { seq: number; outcome: string; cancelled_by_complete: boolean }[];
    expect(visits.map((v) => [v.seq, v.outcome, v.cancelled_by_complete])).toEqual([[1, 'cancelled', true], [2, 'cancelled', false]]);
  });

  it('leaves costs out of the summary without See financial data and keeps the prices', async () => {
    const { org, customer } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    await db.jobLineItem.create({
      data: { organization_id: org, job_id: job.id, sequence: 1, description: 'Spring', quantity: 2, unit_price: 100, unit_cost: 60, line_total: 200 },
    });
    const without = await personWith(org, { ...OPENING, office_review: true, see_financial_data: false });
    const res = await (await without.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.body.review.summary.lines).toEqual([{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200 }]);
    expect('total_cost' in res.body.review.summary).toBe(false);
    expect(res.body.review.summary.total).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/unit_cost|total_cost|"60"/);
  });

  it("shows the balance the job page shows when a deposit was paid on the job's estimate, to a reader who cannot open invoices too", async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    // The estimate took a $100 cash deposit on its own invoice (no job on it); the final invoice applied that deposit as credit, then took $200.
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    await db.job.update({ where: { id: job.id }, data: { estimate_id: estimate.id } });
    const deposit = await fx.addInvoice(org, customer, { estimateId: estimate.id });
    await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'PAID', amount_due: 0 } });
    await db.payment.create({ data: { invoice_id: deposit.id, amount: 100, method: 'CASH', reference_number: 'DEP-1', paid_at: new Date() } });
    const final = await fx.addInvoice(org, customer, { jobId: job.id });
    await db.invoice.update({ where: { id: final.id }, data: { total_amount: 637.5, subtotal: 637.5, amount_due: 337.5, status: 'PARTIAL', sent_at: new Date() } });
    await db.payment.create({ data: { invoice_id: final.id, amount: 100, method: 'CASH', reference_number: 'DEPOSIT-CREDIT', paid_at: new Date() } });
    await db.payment.create({ data: { invoice_id: final.id, amount: 200, method: 'CASH', reference_number: 'PART-1', paid_at: new Date() } });

    const sees = await personWith(org, { ...OPENING, office_review: true });
    const blind = await personWith(org, { view_jobs: true, jobs_scope: 'all', office_review: true, view_invoices: false });
    const seen = (await (await sees.api()).get(`/api/jobs/${job.id}/review`)).body.review.summary;
    expect(seen.invoices.map((i: { amount_due: number }) => i.amount_due)).toEqual([337.5]);
    expect(seen.balance).toBe(337.5);
    // The job's own balance is the same for a reader who cannot open the invoice, and no invoice row shows for them.
    const hidden = (await (await blind.api()).get(`/api/jobs/${job.id}/review`)).body.review.summary;
    expect(hidden.invoices).toEqual([]);
    expect(hidden.balance).toBe(337.5);
  });

  it('keeps the invoices and the money items from a reader who cannot open invoices', async () => {
    const { org, customer } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    await history(org, job.id, 'JOB_PAYMENT_RECORDED', { invoice_id: inv.id, invoice_number: 'INV-9', amount: 50, method: 'CASH', payment_id: randomUUID() });
    await history(org, job.id, 'JOB_INVOICE_LINE_CHANGED', { invoice_id: inv.id, invoice_number: 'INV-9', line_id: randomUUID(), old: line(), new: line({ unit_price: 50 }) });
    const sees = await personWith(org, { ...OPENING, office_review: true });
    const blind = await personWith(org, { view_jobs: true, jobs_scope: 'all', office_review: true, view_invoices: false });
    const seen = (await (await sees.api()).get(`/api/jobs/${job.id}/review`)).body.review;
    expect(seen.summary.invoices).toHaveLength(1);
    expect(seen.groups.find((g: { key: string }) => g.key === 'payments').items).toHaveLength(1);
    const hidden = (await (await blind.api()).get(`/api/jobs/${job.id}/review`)).body.review;
    expect(hidden.summary.invoices).toEqual([]);
    expect(hidden.groups.find((g: { key: string }) => g.key === 'payments').items).toEqual([]);
    expect(hidden.groups.find((g: { key: string }) => g.key === 'lines').items).toEqual([]);
  });

  it("follows the person's invoices scope: an invoice they cannot open is not listed, nor are its payments or lines", async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    const hiddenInv = await fx.addInvoice(org, customer, { jobId: job.id });
    const mine = await personWith(org, { ...OPENING, invoices_scope: 'attached', office_review: true });
    await history(org, job.id, 'JOB_PAYMENT_RECORDED', { invoice_id: hiddenInv.id, invoice_number: 'INV-9', amount: 50, method: 'CASH', payment_id: randomUUID() }, { by: admin.id });
    await history(org, job.id, 'JOB_INVOICE_LINE_CHANGED', { invoice_id: hiddenInv.id, invoice_number: 'INV-9', line_id: randomUUID(), old: line(), new: line({ unit_price: 50 }) }, { by: admin.id });
    await history(org, job.id, 'JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: hiddenInv.id, invoice_number: 'INV-9', old: 0, new: 10 }, { by: admin.id });
    await history(org, job.id, 'JOB_LINE_ADDED', { line_id: randomUUID(), old: null, new: line() }, { by: admin.id });
    const api = await mine.api();
    // The same person cannot open the invoice itself, nor see it on the job.
    expect((await api.get(`/api/invoices/${hiddenInv.id}`)).status).toBe(403);
    const review = (await api.get(`/api/jobs/${job.id}/review`)).body.review;
    expect(review.summary.invoices).toEqual([]);
    expect(review.groups.find((g: { key: string }) => g.key === 'payments').items).toEqual([]);
    expect(review.groups.find((g: { key: string }) => g.key === 'lines').items).toHaveLength(1);
    expect(JSON.stringify(review)).not.toContain(hiddenInv.id);
  });

  it('lists the invoices and payments for a person with the attached scope who is attached to the job', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    const mine = await personWith(org, { ...OPENING, invoices_scope: 'attached', office_review: true });
    await fx.addVisit(org, { jobId: job.id, crew: [mine.id] });
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    await history(org, job.id, 'JOB_PAYMENT_RECORDED', { invoice_id: inv.id, invoice_number: 'INV-1', amount: 50, method: 'CASH', payment_id: randomUUID() }, { by: admin.id });
    const review = (await (await mine.api()).get(`/api/jobs/${job.id}/review`)).body.review;
    expect(review.summary.invoices).toHaveLength(1);
    expect(review.groups.find((g: { key: string }) => g.key === 'payments').items).toHaveLength(1);
  });

  it('serves a round of 150 changes in one answer', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const start = new Date(Date.now() - 3_600_000);
    const job = await reviewJob(org, customer, start);
    for (let i = 0; i < 150; i += 1) {
      await history(org, job.id, 'JOB_LINE_ADDED', { line_id: randomUUID(), old: null, new: line({ name: `Part ${i}` }) }, { at: new Date(start.getTime() + (i + 1) * 1000) });
    }
    const res = await (await me.api()).get(`/api/jobs/${job.id}/review`);
    expect(res.status).toBe(200);
    expect(res.body.review.totals.items).toBe(151);
  });

  describe("the job's own answer", () => {
    it('lists the review action for a holder while the job is in Office review, and not for a person with it off', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { ...OPENING, office_review: true });
      const other = await personWith(org, { ...OPENING, office_review: false });
      const job = await reviewJob(org, customer);
      expect(((await (await holder.api()).get(`/api/jobs/${job.id}`)).body.job.actions as string[])).toContain('office_review');
      expect(((await (await other.api()).get(`/api/jobs/${job.id}`)).body.job.actions as string[])).not.toContain('office_review');
    });

    it('does not list it on a job that is not in Office review', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { ...OPENING, office_review: true });
      for (const status of ['IN_PROGRESS', 'READY_TO_CLOSE'] as const) {
        const job = await fx.addJob(org, customer, { status });
        expect(((await (await holder.api()).get(`/api/jobs/${job.id}`)).body.job.actions as string[]), status).not.toContain('office_review');
      }
    });
  });
});
