/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 (fix) - the Office review attention alert never says more to a person than the
   review panel would show them.

   The panel's reader leaves out an invoice item (an invoice line, an invoice discount, a file on an invoice) for a person who
   cannot open that invoice: View invoices off, or Invoices scope Attached and not on it (the creator rule lets a creator in).
   The alert lists the same items, so each person's copy lists only the items the panel would list for THEM. An item about an
   invoice the person cannot open is left out of their copy, and when that leaves nothing to list they get no attention alert
   for the landing (the panel would show them nothing unusual either). The PRD asks for no bare "something happened" line
   for them, so none is sent. Nothing in the alert's title, body or data names such an invoice: no number, no id, no line name.

   The job's History is read by people who can open the job: the sentence of a job sent back to Office review by an invoice
   item carries the item's title, so a reader who cannot open that invoice gets the sentence without it.

   Everything goes through the public interface: the complete, job, invoice and attachment routes and the History route,
   called as people on custom roles holding exactly the switch values under test, and the notification rows they leave
   behind. Real migrated database (TEST_DATABASE_URL), on a client with ONE connection, as the hosted database's pool has.
   The suite skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
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
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The panel's own words (the PRD's, not read from the code). */
const REASON = {
  lowered: 'A price was lowered',
  discount: 'A discount was added or raised',
  file: 'A file was deleted',
} as const;

/** Opens jobs, their files and customers, and every invoice. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', create_jobs: true, view_attachments: true,
  view_invoices: true, invoices_scope: 'all', view_customers: true,
};
/** Opens jobs and nothing of invoices. */
const JOBS_ONLY = { view_jobs: true, jobs_scope: 'all', view_attachments: true, view_customers: true };
/** Every change below, and the key that opens a locked job. */
const EVERY_CHANGE = {
  ...OPENING, edit_jobs: true, edit_job_line_items: true, apply_discounts: true, edit_invoices: true,
  edit_invoice_line_items: true, delete_attachments: true, complete_jobs: true, change_locked_jobs: true,
};

type Res = { status: number; body: Record<string, any> };

suite('the Office review attention alert and invoices the reader cannot open (real database, one connection)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['attachments', 'notes', 'job_reviews', 'job_line_items', 'workflow_enrollments']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `invoice-items-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const HOUR = 3_600_000;
  const snap = (name: string, price: number) => ({ name, quantity: 1, unit_price: price, line_total: price, is_taxable: true, discount_type: null, discount_value: null, discount_amount: 0 });

  /**
   * A company whose people are told about a job, each able to open it: the reviewer (Office review, every invoice), crew with
   * View invoices off, a copy holder whose Invoices scope is Attached and who is not on the job, and crew who made the invoice
   * with View invoices off (the creator rule lets them in). The job carries one invoice with a line "Service" and a file.
   */
  async function world(status: JobStatus) {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.customer.update({ where: { id: customer }, data: { phone: '6175550101' } });
    // Nobody but the people built here can be alerted.
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, EVERY_CHANGE);
    const reviewer = await personWith(org, { ...OPENING, office_review: true });
    const crew = await personWith(org, JOBS_ONLY);
    const creator = await personWith(org, JOBS_ONLY);
    const attached = await personWith(org, { ...OPENING, invoices_scope: 'attached', alert_every_job: true });
    const job = await fx.addJob(org, customer, { status, pastVisit: true, crew: [crew.id, creator.id] });
    const finishedAt = new Date(Date.now() - HOUR);
    const line = await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Door', quantity: 1, unit_price: 100, line_total: 100 },
    });
    await db.job.update({
      where: { id: job.id },
      data: { tax_rate: 0, completed_at: status === 'IN_PROGRESS' ? null : finishedAt, ...(status === 'DONE' ? { closed_at: finishedAt, closed_by_id: me.id } : {}) },
    });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
    const invoiceNumber = (await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { invoice_number: true } })).invoice_number;
    const file = randomUUID();
    await db.attachment.create({
      data: {
        id: file, organization_id: org, entity_type: 'INVOICE', entity_id: invoice.id, file_name: `${file}.pdf`,
        file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: 'Receipt.pdf', uploaded_by: me.id,
      },
    });
    return { org, customer, job: { ...job, lineId: line.id }, invoice, invoiceNumber, invoiceFile: file, me, reviewer, crew, creator, attached, finishedAt };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const statusOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status;

  /** The attention alerts a person was sent for a job, after the request that raised them has finished sending. */
  async function attentionFor(jobId: string, who: Person) {
    await reviewAttentionSettled();
    return db.notification.findMany({
      where: { object_id: jobId, verb: 'job.review_attention', recipients: { some: { recipient_id: who.id } } },
      orderBy: { created_at: 'asc' },
    });
  }
  const linesOf = (alerts: Array<{ body: string | null }>) => alerts.flatMap((n) => (n.body ?? '').split('\n')).filter((l) => l.includes(': '));

  /** Everything an invoice the person cannot open would give away, searched in the whole of the alert: title, body, data. */
  function expectNoInvoiceIn(alerts: unknown, w: World) {
    const text = JSON.stringify(alerts);
    expect(text).not.toContain(w.invoiceNumber);
    expect(text).not.toContain(w.invoice.id);
    expect(text).not.toContain(w.invoice.lineId);
    expect(text).not.toMatch(/Invoice /);
    expect(text).not.toContain('Service');
    expect(text).not.toContain('Receipt');
  }

  /** A job in progress whose window already holds a price cut on its line and, when asked, a price cut on the invoice's line. */
  async function windowWithCuts(w: World, opts: { jobItem: boolean; invoiceItem: boolean }) {
    let at = Date.now() + 1000;
    const entry = (event_type: string, description: string, metadata: Record<string, unknown>) =>
      db.timelineEvent.create({ data: { organization_id: w.org, entity_type: 'JOB', entity_id: w.job.id, event_type, description, metadata: metadata as never, created_by: w.me.id, created_at: new Date((at += 1000)) } });
    if (opts.jobItem) {
      await entry('JOB_LINE_CHANGED', 'Line changed: Door', { line_id: w.job.lineId, old: snap('Door', 100), new: snap('Door', 80) });
    }
    if (opts.invoiceItem) {
      await entry('JOB_INVOICE_LINE_CHANGED', `Invoice ${w.invoiceNumber} line changed: Service`, {
        invoice_id: w.invoice.id, invoice_number: w.invoiceNumber, line_id: w.invoice.lineId, old: snap('Service', 100), new: snap('Service', 70),
      });
    }
  }

  // ─── Entering Office review: one alert, a different list for each person ────────────────────────────────────

  describe('when the job enters Office review (Complete) with a price cut on the job and one on its invoice', () => {
    it('lists both items to the people who can open the invoice and only the job item to the rest, with no word of the invoice in their copy', async () => {
      const w = await world('IN_PROGRESS');
      await windowWithCuts(w, { jobItem: true, invoiceItem: true });
      const res: Res = await (await w.me.api()).post(`/api/jobs/${w.job.id}/complete`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      for (const opener of [w.reviewer, w.creator]) {
        const alerts = await attentionFor(w.job.id, opener);
        expect(alerts, `opener ${opener.id}`).toHaveLength(1);
        expect(linesOf(alerts)).toEqual([
          `${REASON.lowered}: Line: Door`,
          `${REASON.lowered}: Invoice ${w.invoiceNumber} line: Service`,
        ]);
      }
      for (const other of [w.crew, w.attached]) {
        const alerts = await attentionFor(w.job.id, other);
        expect(alerts, `non-opener ${other.id}`).toHaveLength(1);
        expect(linesOf(alerts)).toEqual([`${REASON.lowered}: Line: Door`]);
        expectNoInvoiceIn(alerts, w);
      }
    });

    it('sends a person who cannot open the invoice no attention alert at all when the invoice item is the only unusual item', async () => {
      const w = await world('IN_PROGRESS');
      await windowWithCuts(w, { jobItem: false, invoiceItem: true });
      expect((await (await w.me.api()).post(`/api/jobs/${w.job.id}/complete`)).status).toBe(200);
      await reviewAttentionSettled();

      expect(await attentionFor(w.job.id, w.crew)).toEqual([]);
      expect(await attentionFor(w.job.id, w.attached)).toEqual([]);
      expect(linesOf(await attentionFor(w.job.id, w.reviewer))).toEqual([`${REASON.lowered}: Invoice ${w.invoiceNumber} line: Service`]);
      expect(linesOf(await attentionFor(w.job.id, w.creator))).toEqual([`${REASON.lowered}: Invoice ${w.invoiceNumber} line: Service`]);
      // Nothing generic went out in its place: nobody got an alert that is not one of the above.
      const everyone = await db.notification.findMany({ where: { object_id: w.job.id, verb: 'job.review_attention' }, include: { recipients: true } });
      expect(everyone.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort()).toEqual([w.reviewer.id, w.creator.id].sort());
    });
  });

  // ─── An invoice item landing on a job that is already past the review's start ───────────────────────────────

  describe('an invoice line cut on a Ready to close job', () => {
    it('sends the job back to Office review and alerts only the people who can open the invoice; its History sentence names the item only to them', async () => {
      const w = await world('READY_TO_CLOSE');
      const res: Res = await (await w.me.api()).patch(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`, { discount_type: 'FIXED_AMOUNT', discount_value: 10 });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
      await reviewAttentionSettled();

      for (const opener of [w.reviewer, w.creator]) {
        const alerts = await attentionFor(w.job.id, opener);
        expect(alerts, `opener ${opener.id}`).toHaveLength(1);
        expect(linesOf(alerts)).toEqual([`${REASON.discount}: Invoice ${w.invoiceNumber} line: Service`]);
      }
      for (const other of [w.crew, w.attached]) {
        const alerts = await attentionFor(w.job.id, other);
        expect(alerts, `non-opener ${other.id}`).toEqual([]);
      }

      // The job's History: the move back is there for everyone who opens the job, the invoice item only for those who open the invoice.
      const history = async (who: Who) => (await (await who.api()).get(`/api/jobs/${w.job.id}/timeline`)).body.events as Array<Record<string, any>>;
      const movedBack = (events: Array<Record<string, any>>) => events.filter((e) => e.event_type === 'JOB_MOVED_BACK');
      for (const other of [w.crew, w.attached]) {
        const events = await history(other);
        expect(movedBack(events), `non-opener ${other.id}`).toHaveLength(1);
        expectNoInvoiceIn(events, w);
        expect(movedBack(events)[0]!.description).toMatch(/moved back from Ready to close to Office review/i);
      }
      for (const opener of [w.reviewer, w.creator]) {
        const [entry] = movedBack(await history(opener));
        expect(entry!.description, `opener ${opener.id}`).toContain(`${REASON.discount}: Invoice ${w.invoiceNumber} line: Service`);
      }
    });
  });

  describe('the same move back, read in the dashboard Recent Activity tile', () => {
    it('gives the sentence without the invoice item to a person who cannot open the invoice, and with it to a person who can', async () => {
      const w = await world('READY_TO_CLOSE');
      const res: Res = await (await w.me.api()).patch(`/api/invoices/${w.invoice.id}/line-items/${w.invoice.lineId}`, { discount_type: 'FIXED_AMOUNT', discount_value: 10 });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('OFFICE_REVIEW');
      await reviewAttentionSettled();

      const feed = async (who: Who) => {
        const answer: Res = await (await who.api()).get('/api/dashboard?tiles=recent_activity');
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return answer.body.data.recent_activity as Array<Record<string, any>>;
      };
      const movedBack = (events: Array<Record<string, any>>) => events.filter((e) => e.event_type === 'JOB_MOVED_BACK');
      for (const other of [w.crew, w.attached]) {
        const events = await feed(other);
        expect(movedBack(events), `non-opener ${other.id}`).toHaveLength(1);
        expectNoInvoiceIn(events, w);
        expect(movedBack(events)[0]!.description).toMatch(/moved back from Ready to close to Office review/i);
      }
      for (const opener of [w.reviewer, w.creator]) {
        const [entry] = movedBack(await feed(opener));
        expect(entry!.description, `opener ${opener.id}`).toContain(`${REASON.discount}: Invoice ${w.invoiceNumber} line: Service`);
      }
    });
  });

  describe('a move back written before entries carried their invoices', () => {
    it('names a file on an invoice to nobody who cannot open every invoice, and does not fail the History or the dashboard', async () => {
      const w = await world('OFFICE_REVIEW');
      await db.timelineEvent.create({
        data: {
          organization_id: w.org, entity_type: 'JOB', entity_id: w.job.id, event_type: 'JOB_MOVED_BACK', created_by: w.me.id,
          description: 'Job J-1 moved back from Ready to close to Office review. A file was deleted: Invoice 123 file: Receipt.pdf.',
          metadata: { from: 'READY_TO_CLOSE', to: 'OFFICE_REVIEW', door: 'change', item_key: 'invoice-file:abc', item_title: 'Invoice 123 file: Receipt.pdf' } as never,
        },
      });
      const history = await (await w.crew.api()).get(`/api/jobs/${w.job.id}/timeline`);
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      expect(JSON.stringify(history.body)).not.toContain('Receipt');
      const feed = await (await w.crew.api()).get('/api/dashboard?tiles=recent_activity');
      expect(feed.status, JSON.stringify(feed.body)).toBe(200);
      expect(JSON.stringify(feed.body.data.recent_activity)).not.toContain('Receipt');
    });
  });

  // ─── Done: an invoice file delete ────────────────────────────────────────────────────────────────────────────

  describe('an invoice file deleted from a Done job', () => {
    it('alerts only the people who can open the invoice, naming the invoice and the file only to them', async () => {
      const w = await world('DONE');
      const res: Res = await (await w.me.api()).delete(`/api/attachments/invoice/${w.invoice.id}/${w.invoiceFile}`);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(await statusOf(w.job.id)).toBe('DONE');
      await reviewAttentionSettled();

      for (const opener of [w.reviewer, w.creator]) {
        const alerts = await attentionFor(w.job.id, opener);
        expect(alerts, `opener ${opener.id}`).toHaveLength(1);
        expect(linesOf(alerts)).toEqual([`${REASON.file}: Invoice ${w.invoiceNumber} file: Receipt.pdf`]);
      }
      for (const other of [w.crew, w.attached]) {
        expect(await attentionFor(w.job.id, other), `non-opener ${other.id}`).toEqual([]);
      }
    });

    it('still tells everyone about a job file deleted on the same Done job, in one list each', async () => {
      const w = await world('DONE');
      const file = randomUUID();
      await db.attachment.create({
        data: {
          id: file, organization_id: w.org, entity_type: 'JOB', entity_id: w.job.id, file_name: `${file}.pdf`,
          file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
          file_size: 10, display_name: 'Door photo.pdf', uploaded_by: w.me.id,
        },
      });
      expect((await (await w.me.api()).delete(`/api/attachments/job/${w.job.id}/${file}`)).status).toBeLessThan(300);
      await reviewAttentionSettled();
      for (const who of [w.reviewer, w.creator, w.crew, w.attached]) {
        expect(linesOf(await attentionFor(w.job.id, who)), `person ${who.id}`).toEqual([`${REASON.file}: File: Door photo.pdf`]);
      }
    });
  });

  // ─── The Ready to close alert names only the job ─────────────────────────────────────────────────────────────

  describe('the Ready to close alert', () => {
    it('names only the job: no invoice number, line, file or amount, whoever receives it', async () => {
      const w = await world('READY_TO_CLOSE');
      const closer = await personWith(w.org, { ...JOBS_ONLY, close_jobs: true });
      const { alertJobReadyToClose } = await import('../services/notifications/jobReviewAlerts.js');
      await alertJobReadyToClose({ organizationId: w.org, actorId: w.me.id, jobId: w.job.id });
      const alerts = await db.notification.findMany({ where: { object_id: w.job.id, verb: 'job.ready_to_close' }, include: { recipients: true } });
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.flatMap((n) => n.recipients.map((r) => r.recipient_id))).toContain(closer.id);
      for (const alert of alerts) expect(alert.title).toMatch(/ is ready to close$/);
      expectNoInvoiceIn(alerts, w);
    });
  });
});
