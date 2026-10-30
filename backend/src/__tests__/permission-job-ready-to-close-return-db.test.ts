/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.20 - Ready to close returns to Office review on an unusual change.

   A job in Ready to close has had its review finished. When an UNUSUAL change (M8's flags: a deleted file, a price cut,
   a customer detail change) lands on it, the job goes back to Office review on the SAME round: the finished round is
   opened again, its checks and customer decisions are kept, the changed item reads unchecked and everything else stays
   checked, and ONE history entry names the change. An ordinary change (a payment, an invoice send, a note, a line added
   at its price, a price raised) does not move the job; the review lists it under "Since the review".

   Everything goes through the public interface: the job, invoice and attachment routes, called as people on custom roles
   (never a built-in role name) holding exactly the switch values under test. The doors are the ones that can reach a
   Ready to close job at all: the lock holds there, so the job-side writers need Change locked jobs; the Office review
   exception ends at the finish. Real migrated database (TEST_DATABASE_URL), on a client with ONE connection, as the
   hosted database's pool has: a move that needed a second connection inside its transaction would time out here. The
   suite skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '5');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

// This is not a Complete: the job-completed trigger must not fire for a move back.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The panel's own words (the PRD's, not read from the code). */
const REASON = {
  lowered: 'A price was lowered',
  removed: 'A line was removed',
  discount: 'A discount was added or raised',
  file: 'A file was deleted',
  customer: 'A customer detail changed',
} as const;

/** What opening a job, its invoices, its files and its customer takes. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', edit_jobs: true, create_jobs: true,
  view_invoices: true, leads_scope: 'all', view_customers: true,
};

/** Everything that makes a person able to make every change below: the Change locked jobs key is what opens a locked job. */
const EVERY_CHANGE = {
  ...OPENING, edit_jobs: true, edit_job_line_items: true, apply_discounts: true, edit_invoices: true,
  edit_invoice_line_items: true, edit_job_and_lead_contact_details: true,
  record_payments: true, allowed_payment_methods: ['CASH'], add_notes: true, change_locked_jobs: true,
};

/** The people who read the review and the queue. */
const REVIEWER = { ...OPENING, office_review: true, close_jobs: true };

type Res = { status: number; body: Record<string, any> };

suite('Ready to close returns to Office review on an unusual change (real database, one connection)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
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

  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `ready-return-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    // A send by hand goes out from the sender's own mailbox (PRD 10, S10.12).
    await fx.addUserMailbox(org, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const HOUR = 3_600_000;

  /**
   * A job as Finish review leaves it: in `status`, with one $100 line (added inside the round, then checked), one $50 scope,
   * a finished (or open) round holding two checks (the job summary and the line), and a file.
   */
  async function reviewedJob(org: string, customer: string, admin: { id: string }, status: JobStatus = 'READY_TO_CLOSE') {
    const job = await fx.addJob(org, customer, { status });
    const finishedAt = new Date(Date.now() - HOUR);
    const scopeId = randomUUID();
    await db.job.update({
      where: { id: job.id },
      data: {
        tax_rate: 0, completed_at: finishedAt,
        scopes: [{ id: scopeId, title: 'Install', body: '', flat_price: 50, is_taxable: true, internal_cost: null }],
      },
    });
    const line = await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Door', quantity: 1, unit_price: 100, line_total: 100 },
    });
    const added = await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_LINE_ADDED', description: 'Line added: Door',
        metadata: { line_id: line.id, old: null, new: { name: 'Door', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true, discount_type: null, discount_value: null, discount_amount: 0 } },
        created_by: admin.id, created_at: new Date(finishedAt.getTime() - 90 * 60_000),
      },
    });
    const round = await db.jobReview.create({
      data: {
        organization_id: org, job_id: job.id, window_start: new Date(finishedAt.getTime() - 3 * HOUR),
        ...(status === 'OFFICE_REVIEW' ? {} : { state: 'FINISHED', finished_by_id: admin.id, finished_at: finishedAt }),
      },
    });
    await db.jobReviewItemCheck.createMany({
      data: [
        { organization_id: org, review_id: round.id, item_key: 'summary', entry_id: added.id, checked_by_id: admin.id },
        { organization_id: org, review_id: round.id, item_key: `line:${line.id}`, entry_id: added.id, checked_by_id: admin.id },
      ],
    });
    const file = randomUUID();
    await db.attachment.create({
      data: {
        id: file, organization_id: org, entity_type: 'JOB', entity_id: job.id, file_name: `${file}.pdf`,
        file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: 'Door photo.pdf', uploaded_by: admin.id,
      },
    });
    return { ...job, lineId: line.id, scopeId, round, file, finishedAt, addedEntryId: added.id };
  }

  /** A company with a customer holding a phone, a Ready to close job, and the invoices that can belong to it. */
  async function readyWorld() {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { accepted_payment_methods: ['CASH'] } });
    await db.customer.update({ where: { id: customer }, data: { phone: '6175550101', email: `pat-${org.slice(0, 8)}@example.test` } });
    const job = await reviewedJob(org, customer, admin);
    // An invoice made from the job, with a file of its own.
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    const invoiceFile = randomUUID();
    await db.attachment.create({
      data: {
        id: invoiceFile, organization_id: org, entity_type: 'INVOICE', entity_id: invoice.id, file_name: `${invoiceFile}.pdf`,
        file_url: `https://files.example.test/${invoiceFile}.pdf`, storage_path: `org/${invoiceFile}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: 'Receipt.pdf', uploaded_by: admin.id,
      },
    });
    const me = await personWith(org, EVERY_CHANGE);
    const reviewer = await personWith(org, REVIEWER);
    return { org, customer, admin, job, invoice, invoiceFile, me, reviewer };
  }
  type World = Awaited<ReturnType<typeof readyWorld>>;

  const reviewOf = async (w: World, jobId: string) => {
    const res = await (await w.reviewer.api()).get(`/api/jobs/${jobId}/review`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.review as Record<string, any>;
  };
  const itemsOf = (review: Record<string, any>) => (review.groups as any[]).filter((g) => g.key !== 'unusual').flatMap((g) => g.items as any[]);
  const unusualOf = (review: Record<string, any>) => (review.groups as any[]).find((g) => g.key === 'unusual').items as any[];
  const movedBack = (jobId: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: 'JOB_MOVED_BACK' }, orderBy: { created_at: 'asc' } });
  const statusOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status;
  const queue = async (w: World) => (await (await w.reviewer.api()).get('/api/jobs/review-queue')).body as { office_review: number; ready_to_close: number };

  // ─── Every door that makes an unusual change ─────────────────────────────────────────────────────────────────

  interface Door {
    name: string;
    /** The change, as the control makes it. */
    call: (api: Api, w: World) => Promise<Res>;
    reason: string;
    /** What the item is called in the review, and so in the history line. */
    title: (w: World) => string | RegExp;
  }

  const UNUSUAL_DOORS: Door[] = [
    { name: 'a job line price cut', reason: REASON.lowered, title: () => 'Line: Door',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 }) },
    { name: 'a job line removed', reason: REASON.removed, title: () => 'Line: Door',
      call: (api, w) => api.delete(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`) },
    { name: 'an invoice line discount added', reason: REASON.discount, title: () => /^Invoice .+ line: Service$/,
      call: (api, w) => api.patch(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`, { discount_type: 'FIXED_AMOUNT', discount_value: 10 }) },
    { name: 'a scope price cut', reason: REASON.lowered, title: () => 'Scope: Install',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}/scopes/0`, { flat_price: 40 }) },
    { name: 'a scope removed', reason: REASON.removed, title: () => 'Scope: Install',
      call: (api, w) => api.delete(`/api/jobs/${w.job.id}/scopes/0`) },
    { name: 'a job discount added', reason: REASON.discount, title: () => 'Job discount',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 5 }) },
    { name: 'an invoice line price cut', reason: REASON.lowered, title: () => /^Invoice .+ line: Service$/,
      call: (api, w) => api.patch(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`, { unit_price: 60 }) },
    { name: 'an invoice line removed', reason: REASON.removed, title: () => /^Invoice .+ line: Service$/,
      call: (api, w) => api.delete(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`) },
    { name: 'an invoice discount added', reason: REASON.discount, title: () => /^Invoice .+ discount$/,
      call: (api, w) => api.patch(`/api/invoices/${w.invoice.id}/billing`, { discount_amount: 5 }) },
    { name: 'a job file deleted', reason: REASON.file, title: () => 'File: Door photo.pdf',
      call: (api, w) => api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`) },
    { name: 'an invoice file deleted', reason: REASON.file, title: () => /^Invoice .+ file: Receipt\.pdf$/,
      call: (api, w) => api.delete(`/api/attachments/invoice/${w.invoice.id}/${w.invoiceFile}`) },
    { name: 'a phone added for this job', reason: REASON.customer, title: () => 'Phone',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries`, { kind: 'PHONE', value: '6175550177' }) },
    { name: 'a phone changed for this job', reason: REASON.customer, title: () => 'Phone',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }) },
    { name: 'an email added for this job', reason: REASON.customer, title: () => 'Email',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries`, { kind: 'EMAIL', value: 'billing@example.test' }) },
    { name: 'a first name changed for this job', reason: REASON.customer, title: () => 'First name',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Patricia' }) },
  ];

  const titleMatches = (title: string, expected: string | RegExp) => (typeof expected === 'string' ? title === expected : expected.test(title));

  describe('an unusual change on a Ready to close job sends it back to Office review on the same round', () => {
    for (const door of UNUSUAL_DOORS) {
      it(`${door.name}: the job is in Office review, the round is open again with its checks, one history entry names the change`, async () => {
        const w = await readyWorld();
        const before = await queue(w);
        expect(before).toMatchObject({ ready_to_close: 1, office_review: 0 });
        const checksBefore = await db.jobReviewItemCheck.findMany({ where: { review_id: w.job.round.id }, orderBy: { item_key: 'asc' } });
        const startedBefore = await db.timelineEvent.count({ where: { entity_id: w.job.id, event_type: { in: ['COMPLETED', 'OFFICE_REVIEW_STARTED'] } } });
        dispatched.mockClear();

        const res = await door.call(await w.me.api(), w);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

        // M7: the job is back in Office review, the SAME round is open again, and its checks are untouched.
        expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
        const rounds = await db.jobReview.findMany({ where: { job_id: w.job.id } });
        expect(rounds).toHaveLength(1);
        expect(rounds[0]).toMatchObject({ id: w.job.round.id, state: 'OPEN', finished_at: null, finished_by_id: null });
        expect(await db.jobReviewItemCheck.findMany({ where: { review_id: w.job.round.id }, orderBy: { item_key: 'asc' } })).toEqual(checksBefore);

        // ONE history entry, a system entry carrying who made the change, naming the kind of change and what it was on.
        const entries = await movedBack(w.job.id);
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.created_by).toBe(w.me.id);
        expect(entry.metadata).toMatchObject({ from: 'READY_TO_CLOSE', to: 'OFFICE_REVIEW', door: 'unusual_change', review_id: w.job.round.id, change_reason: door.reason });
        expect(entry.description).toContain('moved back from Ready to close to Office review');
        expect(entry.description).toContain(door.reason);
        expect(titleMatches((entry.metadata as any).item_title, door.title(w))).toBe(true);
        expect(entry.description).toContain((entry.metadata as any).item_title);

        // The panel and the history line read the same: the item is unusual, with the same reason and title, and unchecked.
        const review = await reviewOf(w, w.job.id);
        expect(review.round).toMatchObject({ id: w.job.round.id, state: 'OPEN' });
        expect(review.since_review).toBeNull();
        const flagged = unusualOf(review);
        expect(flagged).toHaveLength(1);
        expect(flagged[0]).toMatchObject({ unusual_reason: door.reason, checked: false });
        expect(titleMatches(flagged[0].title, door.title(w))).toBe(true);
        expect(flagged[0].title).toBe((entry.metadata as any).item_title);
        // Everything else the round had checked is still checked, except the job summary, which any later change un-checks.
        const others = itemsOf(review).filter((i) => i.key !== flagged[0].key);
        expect(others.every((i) => i.checked)).toBe(true);
        expect(review.summary.checked).toBe(false);

        // Not a Complete: no job-completed automation, no new Completed or review-started entry.
        expect(dispatched).not.toHaveBeenCalled();
        expect(await db.timelineEvent.count({ where: { entity_id: w.job.id, event_type: { in: ['COMPLETED', 'OFFICE_REVIEW_STARTED'] } } })).toBe(startedBefore);

        // The queue follows the status: Ready to close drops by one, Office review rises by one.
        expect(await queue(w)).toMatchObject({ ready_to_close: 0, office_review: 1 });
      });
    }
  });

  // ─── Ordinary changes do not move it ─────────────────────────────────────────────────────────────────────────

  const ORDINARY_DOORS: Array<{ name: string; call: (api: Api, w: World) => Promise<Res>; since?: (item: Record<string, any>) => boolean }> = [
    { name: 'a payment', since: (i) => i.kind === 'payment',
      call: (api, w) => api.post(`/api/invoices/${w.invoice.id}/payments`, { amount: 10, method: 'CASH' }) },
    { name: 'an invoice send', call: (api, w) => api.post(`/api/invoices/${w.invoice.id}/send`, {}) },
    { name: 'a note added', since: (i) => i.kind === 'note', call: (api, w) => api.post(`/api/jobs/${w.job.id}/notes`, { content: 'Customer paid by check' }) },
    { name: 'a job line added at its price', since: (i) => i.kind === 'line',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 }) },
    { name: 'a job line price raised', since: (i) => i.kind === 'line',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 140 }) },
    { name: 'a scope added', since: (i) => i.kind === 'scope', call: (api, w) => api.post(`/api/jobs/${w.job.id}/scopes`, { title: 'Extra', flat_price: 10 }) },
    { name: 'a scope price raised', since: (i) => i.kind === 'scope', call: (api, w) => api.patch(`/api/jobs/${w.job.id}/scopes/0`, { flat_price: 90 }) },
    { name: 'an invoice line added', since: (i) => i.kind === 'invoice_line',
      call: (api, w) => api.post(`/api/invoices/${w.invoice.id}/line-items`, { description: 'Extra', quantity: 1, unit_price: 20, is_taxable: false }) },
    { name: 'an invoice line price raised', since: (i) => i.kind === 'invoice_line',
      call: (api, w) => api.patch(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`, { unit_price: 120 }) },
  ];

  describe('an ordinary change does not move the job; the review lists it under "Since the review"', () => {
    for (const door of ORDINARY_DOORS) {
      it(`${door.name}: the job stays Ready to close on its finished round${door.since ? ' and the change is listed since the review' : ''}`, async () => {
        const w = await readyWorld();
        const checksBefore = await db.jobReviewItemCheck.findMany({ where: { review_id: w.job.round.id }, orderBy: { item_key: 'asc' } });
        const roundBefore = await db.jobReview.findUniqueOrThrow({ where: { id: w.job.round.id } });

        const res = await door.call(await w.me.api(), w);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

        expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
        expect(await movedBack(w.job.id)).toHaveLength(0);
        expect(await db.jobReview.findUniqueOrThrow({ where: { id: w.job.round.id } })).toEqual(roundBefore);
        expect(await db.jobReviewItemCheck.findMany({ where: { review_id: w.job.round.id }, orderBy: { item_key: 'asc' } })).toEqual(checksBefore);
        expect(await queue(w)).toMatchObject({ ready_to_close: 1, office_review: 0 });

        const review = await reviewOf(w, w.job.id);
        expect(Array.isArray(review.since_review)).toBe(true);
        if (door.since) {
          expect((review.since_review as any[]).some(door.since), JSON.stringify(review.since_review)).toBe(true);
          // Nothing listed since the review is flagged unusual: an unusual change would have sent the job back.
          expect((review.since_review as any[]).every((i) => !i.unusual)).toBe(true);
        }
      });
    }

    it('lists nothing since the review on a Ready to close job that has not changed since', async () => {
      const w = await readyWorld();
      const review = await reviewOf(w, w.job.id);
      expect(review.since_review).toEqual([]);
    });

    it('does not list "Since the review" for a job still in Office review', async () => {
      const w = await readyWorld();
      await db.job.update({ where: { id: w.job.id }, data: { status: 'OFFICE_REVIEW' } });
      await db.jobReview.update({ where: { id: w.job.round.id }, data: { state: 'OPEN', finished_at: null, finished_by_id: null } });
      expect((await reviewOf(w, w.job.id)).since_review).toBeNull();
    });
  });

  // ─── The second change in a row, and what must not move ──────────────────────────────────────────────────────

  describe('idempotence and containment', () => {
    it('a second unusual change in a row finds the job already in Office review: one history entry, and only the new item reads unchecked', async () => {
      const w = await readyWorld();
      const api = await w.me.api();
      expect((await api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 })).status).toBe(200);
      expect((await api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`)).status).toBe(200);

      expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
      expect(await movedBack(w.job.id)).toHaveLength(1);
      const review = await reviewOf(w, w.job.id);
      expect(unusualOf(review).map((i) => i.unusual_reason).sort()).toEqual([REASON.file, REASON.lowered].sort());
      expect(unusualOf(review).every((i) => !i.checked)).toBe(true);
    });

    it('an ordinary change then an unusual one: the ordinary one is an unchecked item of the re-opened round, the job moves once', async () => {
      const w = await readyWorld();
      const api = await w.me.api();
      expect((await api.post(`/api/jobs/${w.job.id}/notes`, { content: 'Paid' })).status).toBe(201);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      expect((await api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`)).status).toBe(200);
      expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
      expect(await movedBack(w.job.id)).toHaveLength(1);
      const review = await reviewOf(w, w.job.id);
      expect(itemsOf(review).find((i) => i.kind === 'note')).toMatchObject({ checked: false });
    });

    it('a job in Office review, or Done, is not moved by the same changes; they leave their status and write no move', async () => {
      const w = await readyWorld();
      const inReview = await reviewedJob(w.org, w.customer, w.admin, 'OFFICE_REVIEW');
      const done = await reviewedJob(w.org, w.customer, w.admin, 'DONE');
      const api = await w.me.api();
      for (const job of [inReview, done]) {
        expect((await api.delete(`/api/attachments/job/${job.id}/${job.file}`)).status).toBe(200);
        expect((await api.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: '6175550166' })).status).toBe(201);
        expect(await movedBack(job.id)).toHaveLength(0);
      }
      // A price cut is open in Office review (its own exception, here Change locked jobs) and closed on Done.
      expect((await api.patch(`/api/jobs/${inReview.id}/line-items/${inReview.lineId}`, { unit_price: 10 })).status).toBe(200);
      expect((await api.patch(`/api/jobs/${done.id}/line-items/${done.lineId}`, { unit_price: 10 })).status).toBe(403);
      expect(await statusOf(inReview.id)).toBe('OFFICE_REVIEW');
      expect(await statusOf(done.id)).toBe('DONE');
      expect(await movedBack(inReview.id)).toHaveLength(0);
      expect(await movedBack(done.id)).toHaveLength(0);
      // The job that really was Ready to close is untouched by all of it.
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
    });

    it('a person without Change locked jobs is refused a job-side change by the lock, and the job does not move', async () => {
      const w = await readyWorld();
      const without = await personWith(w.org, { ...EVERY_CHANGE, change_locked_jobs: false });
      const api = await without.api();
      const cut = await api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 });
      expect(cut.status).toBe(403);
      const del = await api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`);
      expect(del.status).toBe(403);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      expect(await movedBack(w.job.id)).toHaveLength(0);
    });

    it('a person who holds Office review but not Change locked jobs gets no Office review exception on a Ready to close job', async () => {
      const w = await readyWorld();
      const reviewer = await personWith(w.org, { ...OPENING, office_review: true, edit_job_line_items: true });
      const res = await (await reviewer.api()).patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 });
      expect(res.status).toBe(403);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
    });
  });

  // ─── Several jobs ────────────────────────────────────────────────────────────────────────────────────────────

  describe('a change on an invoice that belongs to more than one job sends every Ready to close job it touches back', () => {
    /**
     * Job A (Ready to close) holds the invoice by being its job; job B (Ready to close) holds it through an estimate attached
     * to B; job C (Office review) holds it the same way and is not moved. A fourth invoice, with no job of its own, is held by B only.
     */
    async function shared() {
      const w = await readyWorld();
      const b = await reviewedJob(w.org, w.customer, w.admin);
      const c = await reviewedJob(w.org, w.customer, w.admin, 'OFFICE_REVIEW');
      const estimateB = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: b.id });
      const estimateC = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: c.id });
      const both = await fx.addInvoice(w.org, w.customer, { jobId: w.job.id, estimateId: estimateB.id, createdBy: w.admin.id });
      await db.invoice.update({ where: { id: both.id }, data: { estimate_id: estimateB.id } });
      const noJob = await fx.addInvoice(w.org, w.customer, { estimateId: estimateB.id, createdBy: w.admin.id });
      const viaC = await fx.addInvoice(w.org, w.customer, { estimateId: estimateC.id, createdBy: w.admin.id });
      return { w, b, c, both, noJob, viaC };
    }

    it('an invoice line cut on the invoice of job A that was made from an estimate attached to job B moves both, each with an entry that names it', async () => {
      const { w, b, both } = await shared();
      const res = await (await w.me.api()).patch(`/api/invoices/${both.id}/line-items/${both.lineId}`, { unit_price: 60 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      for (const job of [w.job, b]) {
        expect(await statusOf(job.id), job.id).toBe('OFFICE_REVIEW');
        const entries = await movedBack(job.id);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.description).toContain(REASON.lowered);
        expect(entries[0]!.metadata).toMatchObject({ review_id: job.round.id, door: 'unusual_change' });
        // The job's own review lists the change, unchecked and flagged, so the history line and the panel agree.
        const review = await reviewOf(w, job.id);
        expect(unusualOf(review)).toHaveLength(1);
        expect(unusualOf(review)[0]).toMatchObject({ unusual_reason: REASON.lowered, kind: 'invoice_line', checked: false });
      }
      expect(await queue(w)).toMatchObject({ ready_to_close: 0, office_review: 3 });
    });

    it('a cut on an invoice with no job of its own moves the Ready to close job that holds it, and leaves the one in Office review alone', async () => {
      const { w, b, c, noJob } = await shared();
      const res = await (await w.me.api()).patch(`/api/invoices/${noJob.id}/line-items/${noJob.lineId}`, { unit_price: 60 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(b.id)).toBe('OFFICE_REVIEW');
      expect(await movedBack(b.id)).toHaveLength(1);
      expect(unusualOf(await reviewOf(w, b.id))).toHaveLength(1);
      // The job that does not hold it, and the one already in review, are not touched.
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      expect(await movedBack(c.id)).toHaveLength(0);
      expect(await statusOf(c.id)).toBe('OFFICE_REVIEW');
    });

    it('an invoice of a job in Office review that a Ready to close job also holds: only the Ready to close one moves', async () => {
      const { w, b, c, viaC } = await shared();
      await db.job.update({ where: { id: b.id }, data: { status: 'READY_TO_CLOSE' } });
      // The invoice is made from the estimate attached to C; make B hold it too.
      await db.estimate.updateMany({ where: { invoices: { some: { id: viaC.id } } }, data: { job_id: b.id } });
      const res = await (await w.me.api()).patch(`/api/invoices/${viaC.id}/line-items/${viaC.lineId}`, { unit_price: 60 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(b.id)).toBe('OFFICE_REVIEW');
      expect(await movedBack(c.id)).toHaveLength(0);
    });

    it('an ordinary change on the shared invoice (a payment) moves neither job', async () => {
      const { w, b, both } = await shared();
      const res = await (await w.me.api()).post(`/api/invoices/${both.id}/payments`, { amount: 10, method: 'CASH' });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      expect(await statusOf(b.id)).toBe('READY_TO_CLOSE');
    });
  });

  // ─── The job's own answer ────────────────────────────────────────────────────────────────────────────────────

  describe('the job page reads the move on its next read', () => {
    it('the job answers Office review with the review action offered, and no Ready to close block, after the change', async () => {
      const w = await readyWorld();
      const reviewerApi = await w.reviewer.api();
      const before = await reviewerApi.get(`/api/jobs/${w.job.id}`);
      expect((before.body.job ?? before.body).status).toBe('READY_TO_CLOSE');
      expect((before.body.job ?? before.body).ready_to_close).not.toBeNull();

      await (await w.me.api()).delete(`/api/attachments/job/${w.job.id}/${w.job.file}`);

      const after = (await reviewerApi.get(`/api/jobs/${w.job.id}`)).body;
      const job = after.job ?? after;
      expect(job.status).toBe('OFFICE_REVIEW');
      expect(job.ready_to_close).toBeNull();
      expect(job.actions).toContain('office_review');
    });

    it('offers the review of a Ready to close job to the person who holds Office review (for "Since the review"), and not to one who does not', async () => {
      const w = await readyWorld();
      const holder = (await (await w.reviewer.api()).get(`/api/jobs/${w.job.id}`)).body;
      expect((holder.job ?? holder).ready_to_close).toMatchObject({ review_changes: true });
      const closer = await personWith(w.org, { ...OPENING, close_jobs: true });
      const closing = (await (await closer.api()).get(`/api/jobs/${w.job.id}`)).body;
      expect((closing.job ?? closing).ready_to_close).toMatchObject({ review_changes: false });
    });
  });
});
