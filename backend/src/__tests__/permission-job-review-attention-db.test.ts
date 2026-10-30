/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 - the Office review attention alert on M6's two-lane chain.

   One alert LISTS the unusual items (the panel's own reason and title for each), through the chain: lane 1 the job's people
   (stored Sold By, crew, Dispatcher); lane 2 the Dispatcher, else the Office review holders who can open the job, else the
   Manage roles and permissions holders; copies to "Alert me about every job" holders. "Someone" is active, can open the
   job and is not the person who made the change. High priority, bell only; its link opens the review panel.

   It is raised (1) when a job ENTERS Office review (Complete) with unusual items already in its window, (2) when a NEW
   unusual item lands while the job is in Office review or Ready to close (in Ready to close the alert rides the move back
   to Office review), and (3) on a DONE job for EVERY delete or detail change by a Change locked jobs holder, unusual or not:
   a file delete, an invoice file delete, a note delete, a job detail edit and a job customer detail change. The job stays
   Done. Payments, refunds and voids, an ordinary note and an upload raise none; a re-read raises none.

   Everything goes through the public interface: the complete, job, invoice and attachment routes, called as people on
   custom roles holding exactly the switch values under test, and the notification rows they leave behind. Real migrated
   database (TEST_DATABASE_URL), on a client with ONE connection, as the hosted database's pool has. The suite skips when
   TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import { reviewAttentionSettled, runWithAttentionQueue, queueReviewAttention, flushReviewAttention } from '../services/notifications/reviewAttentionQueue';

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

const OPENING = {
  view_jobs: true, jobs_scope: 'all', create_jobs: true, view_attachments: true,
  view_invoices: true, invoices_scope: 'all', view_customers: true,
};

/** Everything that makes a person able to make every change below: the Change locked jobs key is what opens a locked job. */
const EVERY_CHANGE = {
  ...OPENING, edit_jobs: true, edit_job_line_items: true, apply_discounts: true, edit_invoices: true,
  edit_invoice_line_items: true, delete_attachments: true, edit_job_and_lead_contact_details: true,
  record_payments: true, allowed_payment_methods: ['CASH'], add_notes: true, upload_attachments: true,
  delete_others_notes: true, change_locked_jobs: true, void_payments: true, refund_payments: true, view_payments: true,
};

/** The people who must act on a review. */
const REVIEWER = { ...OPENING, office_review: true };
const managerValues = { ...OPENING, manage_roles_and_permissions: true, view_users: true };

type Res = { status: number; body: Record<string, any> };

suite('the Office review attention alert (real database, one connection)', () => {
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
  afterEach(() => vi.restoreAllMocks());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `review-attention-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    // A send by hand goes out from the sender's own mailbox (PRD 10, S10.12).
    await fx.addUserMailbox(org, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const HOUR = 3_600_000;

  /**
   * A job as a review leaves it: in `status`, with one $100 line (added inside the round, then checked), one $50 scope, a
   * round holding two checks (the job summary and the line) that is finished unless the job is in Office review, and a file.
   */
  async function reviewedJob(org: string, customer: string, admin: { id: string }, status: JobStatus, people: { soldBy?: string; dispatcher?: string; crew?: string[] } = {}) {
    const job = await fx.addJob(org, customer, { status, ...people });
    const finishedAt = new Date(Date.now() - HOUR);
    const scopeId = randomUUID();
    await db.job.update({
      where: { id: job.id },
      data: {
        tax_rate: 0, completed_at: finishedAt, ...(status === 'DONE' ? { closed_at: finishedAt, closed_by_id: admin.id } : {}),
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
    const attach = async (type: 'JOB' | 'INVOICE', id: string, name: string) => {
      const file = randomUUID();
      await db.attachment.create({
        data: {
          id: file, organization_id: org, entity_type: type, entity_id: id, file_name: `${file}.pdf`,
          file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
          file_size: 10, display_name: name, uploaded_by: admin.id,
        },
      });
      return file;
    };
    const note = (await db.note.create({
      data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, content: 'left by the office', created_by: admin.id },
      select: { id: true },
    })).id;
    return { ...job, lineId: line.id, scopeId, round, file: await attach('JOB', job.id, 'Door photo.pdf'), note, attach, finishedAt, addedEntryId: added.id };
  }

  /** A company with a customer holding a phone, a job in `status`, an invoice of the job with a file, and a quiet set of people. */
  async function world(status: JobStatus, people: { soldBy?: string; dispatcher?: string; crew?: string[] } = {}) {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { accepted_payment_methods: ['CASH'] } });
    await db.customer.update({ where: { id: customer }, data: { phone: '6175550101', email: `pat-${org.slice(0, 8)}@example.test` } });
    const job = await reviewedJob(org, customer, admin, status, people);
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    const invoiceFile = await job.attach('INVOICE', invoice.id, 'Receipt.pdf');
    // Nobody but the people built here can be alerted.
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, EVERY_CHANGE);
    const reviewer = await personWith(org, REVIEWER);
    return { org, customer, admin, job, invoice, invoiceFile, me, reviewer };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const numberOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { job_number: true } })).job_number;
  const statusOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status;

  /** The attention alerts a job has, after the request that raised them has finished sending. */
  async function attention(jobId: string) {
    await reviewAttentionSettled();
    return db.notification.findMany({ where: { object_id: jobId, verb: 'job.review_attention' }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  }
  type Alerts = Awaited<ReturnType<typeof attention>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body?.split('\n').slice(-1)[0] ?? null;

  /** The doors that make an unusual change, as the controls make them. */
  interface Door {
    name: string;
    call: (api: Api, w: World) => Promise<Res>;
    reason: string;
    title: string | RegExp;
  }
  const UNUSUAL_DOORS: Door[] = [
    { name: 'a job line price cut', reason: REASON.lowered, title: 'Line: Door',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 }) },
    { name: 'a job line removed', reason: REASON.removed, title: 'Line: Door',
      call: (api, w) => api.delete(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`) },
    { name: 'an invoice line discount added', reason: REASON.discount, title: /^Invoice .+ line: Service$/,
      call: async (api, w) => {
        const line = await db.invoiceLineItem.findFirstOrThrow({ where: { invoice_id: w.invoice.id }, select: { id: true } });
        return api.patch(`/api/invoices/${w.invoice.id}/line-items/${line.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 10 });
      } },
    { name: 'a scope price cut', reason: REASON.lowered, title: 'Scope: Install',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}/scopes/0`, { flat_price: 40 }) },
    { name: 'a job discount added', reason: REASON.discount, title: 'Job discount',
      call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 5 }) },
    { name: 'a job file deleted', reason: REASON.file, title: 'File: Door photo.pdf',
      call: (api, w) => api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`) },
    { name: 'an invoice file deleted', reason: REASON.file, title: /^Invoice .+ file: Receipt\.pdf$/,
      call: (api, w) => api.delete(`/api/attachments/invoice/${w.invoice.id}/${w.invoiceFile}`) },
    { name: 'a phone changed for this job', reason: REASON.customer, title: 'Phone',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }) },
    { name: 'an email added for this job', reason: REASON.customer, title: 'Email',
      call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries`, { kind: 'EMAIL', value: 'billing@example.test' }) },
  ];

  // ─── Ready to close: the alert rides the move back to Office review ──────────────────────────────────────────

  describe('an unusual change on a Ready to close job sends it back to Office review and raises ONE attention alert', () => {
    for (const door of UNUSUAL_DOORS) {
      it(`${door.name}: one high-priority alert, listing the item in the panel's words, to the people who must act, never to the person who made it`, async () => {
        const w = await world('READY_TO_CLOSE');
        const res = await door.call(await w.me.api(), w);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');

        const alerts = await attention(w.job.id);
        expect(alerts).toHaveLength(1);
        const [alert] = alerts;
        expect(alert!.title).toBe(`${await numberOf(w.job.id)} needs your attention`);
        expect(alert).toMatchObject({ priority: 'INTERRUPT', object_type: 'JOB', object_id: w.job.id, category: 'JOB' });
        expect(alert!.recipients.every((r) => r.priority === 'INTERRUPT')).toBe(true);
        // The link opens the review panel.
        expect((alert!.data as Record<string, unknown>).panel).toBe('review');
        // The body lists the item as the panel names it.
        expect(alert!.body).toContain(`${door.reason}: `);
        const listed = alert!.body!.split('\n').find((l) => l.startsWith(`${door.reason}: `))!.slice(door.reason.length + 2);
        expect(typeof door.title === 'string' ? listed === door.title : door.title.test(listed)).toBe(true);
        // No one else: the reviewer is told, the person who made the change is not.
        expect(recipientsOf(alerts)).toEqual(ids(w.reviewer));
      });
    }

    it('a job that goes back and is finished again alerts again, with the Ready to close alert at the next finish', async () => {
      const w = await world('READY_TO_CLOSE');
      // Each call signs in afresh: the fixture signs in one person at a time.
      const reviewerApi = { get: async (u: string) => (await w.reviewer.api()).get(u), post: async (u: string, b?: object) => (await w.reviewer.api()).post(u, b) };
      const closer = await personWith(w.org, { ...OPENING, close_jobs: true });

      expect((await UNUSUAL_DOORS[5]!.call(await w.me.api(), w)).status).toBeLessThan(300);
      expect(await attention(w.job.id)).toHaveLength(1);

      // The reviewer checks what is left and finishes again.
      const read = await reviewerApi.get(`/api/jobs/${w.job.id}/review`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const review = read.body.review;
      const items = [
        { item_key: 'summary', entry_id: review.summary.latest_entry_id },
        ...review.groups.filter((g: any) => g.key !== 'unusual').flatMap((g: any) => g.items).filter((i: any) => !i.checked).map((i: any) => ({ item_key: i.key, entry_id: i.latest_entry_id })),
      ];
      expect((await reviewerApi.post(`/api/jobs/${w.job.id}/review/checks/all`, { items })).status).toBe(200);
      const version = (await reviewerApi.get(`/api/jobs/${w.job.id}/review`)).body.review.version;
      expect((await reviewerApi.post(`/api/jobs/${w.job.id}/review/finish`, { version })).status).toBe(200);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      await reviewAttentionSettled();
      const ready = () => db.notification.findMany({ where: { object_id: w.job.id, verb: 'job.ready_to_close' }, include: { recipients: true } });
      expect(await ready()).toHaveLength(1);
      expect((await ready())[0]!.recipients.map((r) => r.recipient_id)).toEqual([closer.id]);

      // Another unusual change: the attention alert again.
      expect((await UNUSUAL_DOORS[7]!.call(await w.me.api(), w)).status).toBeLessThan(300);
      expect(await attention(w.job.id)).toHaveLength(2);
    });

    it('a payment and an invoice send on a Ready to close job raise no alert and do not move it', async () => {
      const w = await world('READY_TO_CLOSE');
      const api = await w.me.api();
      const sent = await api.post(`/api/invoices/${w.invoice.id}/send`, {});
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      const paid = await api.post(`/api/invoices/${w.invoice.id}/payments`, { amount: 10, method: 'CASH' });
      expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('READY_TO_CLOSE');
      expect(await attention(w.job.id)).toEqual([]);
    });
  });

  // ─── Office review: a NEW unusual item alerts, a repeat or an ordinary change does not ───────────────────────

  describe('while the job is in Office review', () => {
    for (const door of [UNUSUAL_DOORS[0]!, UNUSUAL_DOORS[3]!, UNUSUAL_DOORS[5]!, UNUSUAL_DOORS[7]!]) {
      it(`${door.name}: a new unusual item alerts once, listing it`, async () => {
        const w = await world('OFFICE_REVIEW');
        const res = await door.call(await w.me.api(), w);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
        const alerts = await attention(w.job.id);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.body).toContain(`${door.reason}: `);
        expect(recipientsOf(alerts)).toEqual(ids(w.reviewer));
      });
    }

    it('a second change to an item that is already flagged is not a new item and does not alert again; a different new item does', async () => {
      const w = await world('OFFICE_REVIEW');
      const api = await w.me.api();
      expect((await api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 80 })).status).toBeLessThan(300);
      expect(await attention(w.job.id)).toHaveLength(1);
      expect((await api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 70 })).status).toBeLessThan(300);
      expect(await attention(w.job.id)).toHaveLength(1);
      expect((await api.patch(`/api/jobs/${w.job.id}/scopes/0`, { flat_price: 40 })).status).toBeLessThan(300);
      const alerts = await attention(w.job.id);
      expect(alerts).toHaveLength(2);
      expect(alerts[1]!.body).toContain('Scope: Install');
      expect(alerts[1]!.body).not.toContain('Line: Door');
    });

    it('an ordinary change (a note, an upload, a payment, a price raised, a line added at its price) raises none; neither does reading the review', async () => {
      const w = await world('OFFICE_REVIEW');
      const api = await w.me.api();
      const ordinary: Res[] = [
        await api.post(`/api/jobs/${w.job.id}/notes`, { content: 'Customer paid by check' }),
        await api.post(`/api/invoices/${w.invoice.id}/payments`, { amount: 10, method: 'CASH' }),
        await api.patch(`/api/jobs/${w.job.id}/line-items/${w.job.lineId}`, { unit_price: 140 }),
        await api.post(`/api/jobs/${w.job.id}/line-items`, { description: 'Lock', quantity: 1, unit_price: 20 }),
      ];
      for (const res of ordinary) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await (await w.reviewer.api()).get(`/api/jobs/${w.job.id}/review`)).status).toBe(200);
      expect((await api.get(`/api/jobs/${w.job.id}`)).status).toBe(200);
      expect(await attention(w.job.id)).toEqual([]);
    });

    it('one request that lands several unusual items sends ONE alert listing them, and an item named twice is listed once', async () => {
      const w = await world('OFFICE_REVIEW');
      const { queue } = runWithAttentionQueue(() => {
        const common = { orgId: w.org, actorId: w.me.id, jobId: w.job.id, onlyIfDone: false };
        queueReviewAttention({ ...common, items: [{ reason: REASON.lowered, title: 'Line: Door' }] });
        queueReviewAttention({ ...common, items: [{ reason: REASON.file, title: 'File: Door photo.pdf' }, { reason: REASON.lowered, title: 'Line: Door' }] });
      });
      flushReviewAttention(queue);
      const alerts = await attention(w.job.id);
      expect(alerts).toHaveLength(1);
      // The reviewer covers for the missing Dispatcher, so the why line follows the list.
      expect(alerts[0]!.body!.split('\n')).toEqual([`${REASON.lowered}: Line: Door`, `${REASON.file}: File: Door photo.pdf`, 'This job has no Dispatcher.']);
    });

    it('a request that failed alerts nobody', async () => {
      const w = await world('OFFICE_REVIEW');
      // A price cut on a line that is not there: refused, nothing written, nothing queued that survives.
      const res = await (await w.me.api()).patch(`/api/jobs/${w.job.id}/line-items/${randomUUID()}`, { unit_price: 1 });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await attention(w.job.id)).toEqual([]);
    });
  });

  // ─── Done: every delete or detail change by a Change locked jobs holder ──────────────────────────────────────

  describe('on a Done job', () => {
    const CHANGES: Array<{ name: string; call: (api: Api, w: World, note: string) => Promise<Res>; reason: string; title: RegExp }> = [
      { name: 'a job file delete', reason: REASON.file, title: /^File: Door photo\.pdf$/,
        call: (api, w) => api.delete(`/api/attachments/job/${w.job.id}/${w.job.file}`) },
      { name: 'an invoice file delete', reason: REASON.file, title: /^Invoice .*file: Receipt\.pdf$/,
        call: (api, w) => api.delete(`/api/attachments/invoice/${w.invoice.id}/${w.invoiceFile}`) },
      { name: 'a note delete', reason: 'A note was deleted', title: /^Note$/,
        call: (api, w, note) => api.delete(`/api/jobs/${w.job.id}/notes/${note}`) },
      { name: 'a job detail edit', reason: 'The job details were changed', title: /^Job details$/,
        call: (api, w) => api.patch(`/api/jobs/${w.job.id}`, { scope_notes: 'changed after close' }) },
      { name: 'a job customer detail change', reason: REASON.customer, title: /^Phone$/,
        call: (api, w) => api.post(`/api/jobs/${w.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }) },
    ];

    for (const change of CHANGES) {
      it(`${change.name} by a Change locked jobs holder raises the attention alert, the job stays Done, and the person who made it is not told`, async () => {
        const w = await world('DONE');
        const before = await db.job.findUniqueOrThrow({ where: { id: w.job.id }, select: { status: true, closed_at: true, closed_by_id: true, completed_at: true } });
        const res = await change.call(await w.me.api(), w, w.job.note);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

        expect(await db.job.findUniqueOrThrow({ where: { id: w.job.id }, select: { status: true, closed_at: true, closed_by_id: true, completed_at: true } })).toEqual(before);
        const alerts = await attention(w.job.id);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ priority: 'INTERRUPT', title: `${await numberOf(w.job.id)} needs your attention` });
        expect((alerts[0]!.data as Record<string, unknown>).panel).toBe('review');
        const line = alerts[0]!.body!.split('\n').find((l) => l.startsWith(`${change.reason}: `));
        expect(line, alerts[0]!.body ?? '').toBeDefined();
        expect(change.title.test(line!.slice(change.reason.length + 2))).toBe(true);
        expect(recipientsOf(alerts)).toEqual(ids(w.reviewer));
      });
    }

    it('payments, refunds and voids raise none, and the job stays Done', async () => {
      const w = await world('DONE');
      const api = await w.me.api();
      const takePayment = async (status: 'PARTIAL' | 'PAID') => {
        await db.invoice.update({ where: { id: w.invoice.id }, data: { status, amount_due: status === 'PAID' ? 0 : 60, sent_at: new Date(), ...(status === 'PAID' ? { paid_at: new Date() } : {}) } });
        return (await db.payment.create({
          data: { invoice_id: w.invoice.id, amount: 40, method: 'CASH', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
          select: { id: true },
        })).id;
      };
      const calls: Res[] = [await api.post(`/api/invoices/${w.invoice.id}/payments`, { amount: 10, method: 'CASH' })];
      const refunded = await takePayment('PAID');
      calls.push(await api.post(`/api/invoices/${w.invoice.id}/refund`, { payment_id: refunded, amount: 10, reason_category: 'GOODWILL', reason: 'Kept the customer' }));
      const voided = await takePayment('PARTIAL');
      calls.push(await api.post(`/api/invoices/${w.invoice.id}/void-payment`, { payment_id: voided, void_category: 'ERROR', reason: 'Typed twice' }));
      calls.push(await api.post(`/api/jobs/${w.job.id}/notes`, { content: 'Customer paid by check' }));
      for (const res of calls) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('DONE');
      expect(await attention(w.job.id)).toEqual([]);
    });

    it('a delete the lock refuses raises none', async () => {
      const w = await world('DONE');
      const noKey = await personWith(w.org, { ...OPENING, delete_attachments: true });
      const res = await (await noKey.api()).delete(`/api/attachments/job/${w.job.id}/${w.job.file}`);
      expect(res.status).toBe(403);
      expect(await attention(w.job.id)).toEqual([]);
    });
  });

  // ─── Entering Office review (Complete) ───────────────────────────────────────────────────────────────────────

  describe('when the job enters Office review (Complete)', () => {
    const completerValues = { ...OPENING, complete_jobs: true };

    /** A job in progress with unusual items already in its window: a deleted file and a price cut, written by the doors. */
    async function jobWithUnusualItems(org: string, customer: string, admin: { id: string }, people: { soldBy?: string; dispatcher?: string; crew?: string[] } = {}) {
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', pastVisit: true, crew: people.crew ?? [], soldBy: people.soldBy, dispatcher: people.dispatcher });
      const line = randomUUID();
      const attachment = randomUUID();
      // Each entry a second after the one before, so the history reads in the order it was written.
      let at = Date.now() + 1000;
      const entry = (event_type: string, description: string, metadata: Record<string, unknown>) =>
        db.timelineEvent.create({ data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type, description, metadata: metadata as never, created_by: admin.id, created_at: new Date((at += 1000)) } });
      const snap = (price: number) => ({ name: 'Door', quantity: 1, unit_price: price, line_total: price, is_taxable: true, discount_type: null, discount_value: null, discount_amount: 0 });
      await entry('JOB_LINE_ADDED', 'Line added: Door', { line_id: line, old: null, new: snap(100) });
      await entry('JOB_LINE_CHANGED', 'Line changed: Door', { line_id: line, old: snap(100), new: snap(80) });
      await entry('ATTACHMENT_UPLOADED', 'Attachment uploaded', { attachment_id: attachment, display_name: 'Front door.png' });
      await entry('ATTACHMENT_DELETED', 'Attachment deleted', { attachment_id: attachment, display_name: 'Front door.png' });
      return job;
    }

    const complete = async (who: Person & { api: () => Promise<Api> }, jobId: string) => {
      const res = await (await who.api()).post(`/api/jobs/${jobId}/complete`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };

    const quietOrg = async () => {
      const world = await fx.newOrg();
      orgs.push(world.org);
      await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
      return world;
    };

    it('lists the unusual items already in its window in one alert, high priority, linking to the review panel', async () => {
      const { org, customer, admin } = await quietOrg();
      const me = await personWith(org, completerValues);
      const reviewer = await personWith(org, REVIEWER);
      const job = await jobWithUnusualItems(org, customer, admin);

      await complete(me, job.id);

      const alerts = await attention(job.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ priority: 'INTERRUPT', title: `${await numberOf(job.id)} needs your attention` });
      expect((alerts[0]!.data as Record<string, unknown>).panel).toBe('review');
      expect(alerts[0]!.body!.split('\n')).toEqual([`${REASON.lowered}: Line: Door`, `${REASON.file}: File: Front door.png`, 'This job has no Dispatcher.']);
      expect(recipientsOf(alerts)).toEqual(ids(reviewer));
      // The Job completed alert still goes out, once, beside it.
      expect(await db.notification.count({ where: { object_id: job.id, verb: 'job.completed' } })).toBe(1);
    });

    it('raises none for a job entering review with nothing unusual in its window', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, completerValues);
      await personWith(org, REVIEWER);
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [] });
      await db.timelineEvent.create({
        data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'ATTACHMENT_UPLOADED', description: 'Attachment uploaded', metadata: { attachment_id: randomUUID(), display_name: 'Kept.png' } },
      });

      await complete(me, job.id);

      expect(await attention(job.id)).toEqual([]);
      expect(await db.notification.count({ where: { object_id: job.id, verb: 'job.completed' } })).toBe(1);
    });

    describe('the chain (lane 1, lane 2, copies, the why line, the empty-chain log)', () => {
      it('with a Dispatcher: lane 1 and the Dispatcher are alerted, and no Office review holder', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const soldBy = await personWith(org, OPENING);
        const crew = await personWith(org, OPENING);
        const dispatcher = await personWith(org, OPENING);
        const reviewer = await personWith(org, REVIEWER);
        const job = await jobWithUnusualItems(org, customer, admin, { soldBy: soldBy.id, crew: [crew.id], dispatcher: dispatcher.id });

        await complete(me, job.id);

        const alerts = await attention(job.id);
        expect(recipientsOf(alerts)).toEqual(ids(soldBy, crew, dispatcher));
        expect(recipientsOf(alerts)).not.toContain(reviewer.id);
        expect(recipientsOf(alerts)).not.toContain(me.id);
        // The Dispatcher took it, so nobody is covering: no why line.
        expect(alerts.every((n) => !n.body!.includes('Dispatcher'))).toBe(true);
      });

      it('without a Dispatcher: lane 1 plus every Office review holder who can open it, with the why line on them only; an Admin-role person with Office review off is not alerted', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const soldBy = await personWith(org, OPENING);
        const reviewer = await personWith(org, REVIEWER);
        const adminReviewOff = await personWith(org, OPENING, 'ADMIN');
        const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', office_review: true });
        const job = await jobWithUnusualItems(org, customer, admin, { soldBy: soldBy.id });

        await complete(me, job.id);

        const alerts = await attention(job.id);
        expect(recipientsOf(alerts)).toEqual(ids(soldBy, reviewer));
        for (const who of [adminReviewOff, cannotOpen, me]) expect(recipientsOf(alerts)).not.toContain(who.id);
        expect(whyFor(alerts, reviewer)).toBe('This job has no Dispatcher.');
        expect(whyFor(alerts, soldBy)).toBe(`${REASON.file}: File: Front door.png`);
      });

      it('with no Office review holder who can open the job: the Manage roles and permissions holders, with the matching why line', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const manager = await personWith(org, managerValues);
        const noSwitch = await personWith(org, OPENING);
        const job = await jobWithUnusualItems(org, customer, admin);

        await complete(me, job.id);

        const alerts = await attention(job.id);
        expect(recipientsOf(alerts)).toEqual(ids(manager));
        expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
        expect(whyFor(alerts, manager)).toBe('This job has no Dispatcher and nobody who can review jobs can open it.');
      });

      it('a Dispatcher who did the action sends the chain to step 2 with the matching why line; the actor is never alerted', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const reviewer = await personWith(org, REVIEWER);
        const job = await jobWithUnusualItems(org, customer, admin, { dispatcher: me.id });

        await complete(me, job.id);

        const alerts = await attention(job.id);
        expect(recipientsOf(alerts)).toEqual(ids(reviewer));
        expect(whyFor(alerts, reviewer)).toBe("This job's Dispatcher made this change.");
      });

      it('a person found twice gets one alert; copies reach "Alert me about every job" holders on jobs they can open only, also when there is a Dispatcher, and never stop the chain', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const everywhere = await personWith(org, { ...REVIEWER, alert_every_job: true });
        const follower = await personWith(org, { ...OPENING, alert_every_job: true });
        const blindFollower = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });
        const dispatcher = await personWith(org, OPENING);
        const withDispatcher = await jobWithUnusualItems(org, customer, admin, { dispatcher: dispatcher.id, soldBy: everywhere.id });

        await complete(me, withDispatcher.id);

        const first = await attention(withDispatcher.id);
        expect(recipientsOf(first)).toEqual(ids(everywhere, dispatcher, follower));
        expect(recipientsOf(first)).not.toContain(blindFollower.id);
        // No Dispatcher: the follower is told as a copy and the chain still goes on to the reviewers.
        const bare = await jobWithUnusualItems(org, customer, admin);
        await complete(me, bare.id);
        expect(recipientsOf(await attention(bare.id))).toEqual(ids(everywhere, follower));
      });

      it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
        const { org, customer, admin } = await quietOrg();
        const me = await personWith(org, completerValues);
        const warn = vi.spyOn(logger, 'warn');
        const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => /office review attention alert/i.test(String(call[0])));

        const lonely = await jobWithUnusualItems(org, customer, admin);
        await complete(me, lonely.id);
        expect(await attention(lonely.id)).toEqual([]);
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]![1]).toMatchObject({ organizationId: org, recordId: lonely.id });
        expect(JSON.stringify(gaps()[0])).not.toMatch(/Pat|Payer|Front door/);

        warn.mockClear();
        const reviewer = await personWith(org, REVIEWER);
        const covered = await jobWithUnusualItems(org, customer, admin);
        await complete(me, covered.id);
        expect(recipientsOf(await attention(covered.id))).toEqual(ids(reviewer));
        expect(gaps()).toHaveLength(0);
      });
    });
  });
});
