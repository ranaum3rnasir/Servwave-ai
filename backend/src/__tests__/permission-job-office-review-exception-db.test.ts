/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.9 - the review's own edits while the job is in Office review.

   The completed-job lock holds from Completed on. While the job's status is Office review, a person who holds Office
   review, can open the job and holds the edit's OWN switch may still change its lines, scopes and job discount, the
   customer details on the job and the files on the job and its invoices. Everything else on the lock list stays locked
   for them (details, people, visits, note deletes), and from Ready to close on only Change locked jobs passes. Each
   such edit is logged in the job's history and is an item in the review panel.

   Everything goes through the public interface: the job and attachment routes, called as people on custom roles
   (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
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

/** The wording of every refusal and every disabled control (the PRD's own text, not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job, its invoices and its files takes, with no edit switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', view_invoices: true, leads_scope: 'all',
};

/** The review's own edits, each on its ordinary switch, plus Office review: the lock is the only thing left to refuse. */
const REVIEWER = {
  ...OPENING, office_review: true, edit_job_line_items: true, apply_discounts: true, edit_jobs: true, edit_invoices: true,
  edit_job_and_lead_contact_details: true,
  add_notes: true, assign_people_to_jobs: true, schedule_visits: true,
  edit_job_record_ids: true, delete_jobs: true,
};

suite('the review\'s own edits while the job is in Office review (real database)', () => {
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
      for (const table of ['attachments', 'timeline_events', 'job_reviews', 'record_contact_entries', 'notes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM job_line_items WHERE job_id IN (SELECT id FROM jobs WHERE organization_id = '${org}')`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `review-edit-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `re${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addFile(org: string, entity: { type: 'JOB' | 'INVOICE'; id: string }, uploadedBy: string) {
    const id = randomUUID();
    await db.attachment.create({
      data: {
        id, organization_id: org, entity_type: entity.type, entity_id: entity.id, file_name: `${id}.pdf`,
        file_url: `https://files.example.test/${id}.pdf`, storage_path: `org/${id}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: `File ${id.slice(0, 4)}`, uploaded_by: uploadedBy,
      },
    });
    return id;
  }

  /**
   * A job at `status` (with its open review round when it is in Office review) on a customer with a phone, one line, one
   * scope, a job file, an invoice with a file, a job-only phone entry and a note by someone else, plus the person asking.
   */
  async function setup(status: JobStatus, values: Record<string, SwitchValue> = REVIEWER) {
    const { org, customer } = await fx.newOrg();
    orgs.push(org);
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones' },
    });
    const me = await personWith(org, values);
    const other = await personWith(org, OPENING);
    const job = await fx.addJob(org, customer, { status });
    if (status === 'OFFICE_REVIEW') {
      await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
    }
    const line = await db.jobLineItem.create({
      data: { organization_id: org, job_id: job.id, sequence: 1, description: 'Closer', quantity: 1, unit_price: 100, line_total: 100 },
      select: { id: true },
    });
    await db.job.update({
      where: { id: job.id },
      data: { scopes: [{ id: randomUUID(), title: 'Scope A', description: '', flat_price: 50, sequence: 1 }] as never },
      select: { id: true },
    });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
    const jobFile = await addFile(org, { type: 'JOB', id: job.id }, other.id);
    const invoiceFile = await addFile(org, { type: 'INVOICE', id: invoice.id }, other.id);
    const entry = await db.recordContactEntry.create({
      data: { organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '6175550199' },
      select: { id: true },
    });
    const note = await db.note.create({
      data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, content: 'Left a message', created_by: other.id },
      select: { id: true },
    });
    return { org, customer, me, other, job, line: line.id, invoice: invoice.id, jobFile, invoiceFile, entry: entry.id, note: note.id, api: await me.api() };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const base = (s: Setup) => `/api/jobs/${s.job.id}`;
  const fileRoute = (type: 'job' | 'invoice', id: string, file: string) => `/api/attachments/${type}/${id}/${file}`;

  /** The review's own edits, as the call a control makes. Each is the one thing the exception lets through. */
  const REVIEW_EDITS: Record<string, (api: Api, s: Setup) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'add a line': (api, s) => api.post(`${base(s)}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 10 }),
    'edit a line': (api, s) => api.patch(`${base(s)}/line-items/${s.line}`, { quantity: 2 }),
    "cut a line's price": (api, s) => api.patch(`${base(s)}/line-items/${s.line}`, { unit_price: 60 }),
    'remove a line': (api, s) => api.delete(`${base(s)}/line-items/${s.line}`),
    'add a scope': (api, s) => api.post(`${base(s)}/scopes`, { title: 'Scope B', flat_price: 10 }),
    'edit a scope': (api, s) => api.patch(`${base(s)}/scopes/0`, { title: 'Changed' }),
    'remove a scope': (api, s) => api.delete(`${base(s)}/scopes/0`),
    'change the job discount': (api, s) => api.patch(base(s), { discount_type: 'FIXED_AMOUNT', discount_value: 5 }),
    'add a customer phone': (api, s) => api.post(`${base(s)}/contact-entries`, { kind: 'PHONE', value: '6175550123' }),
    "change the customer's phone": (api, s) =>
      api.post(`${base(s)}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }),
    "change the customer's name": (api, s) => api.post(`${base(s)}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Patrick' }),
    'correct an entry': (api, s) => api.patch(`${base(s)}/contact-entries/${s.entry}`, { label: 'Wife' }),
    'remove an entry': (api, s) => api.delete(`${base(s)}/contact-entries/${s.entry}`),
    'rename a job file': (api, s) => api.patch(fileRoute('job', s.job.id, s.jobFile), { display_name: 'Renamed' }),
    'delete a job file': (api, s) => api.delete(fileRoute('job', s.job.id, s.jobFile)),
    'delete an invoice file': (api, s) => api.delete(fileRoute('invoice', s.invoice, s.invoiceFile)),
  };

  /** What stays on the lock list for the same person in Office review. */
  const STILL_LOCKED: Record<string, (api: Api, s: Setup) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'delete a note (someone else\'s)': (api, s) => api.delete(`${base(s)}/notes/${s.note}`),
    'edit the job details': (api, s) => api.patch(base(s), { scope_notes: 'changed' }),
    'edit the job tax rate': (api, s) => api.patch(base(s), { tax_rate: 0.05 }),
    'edit a discount along with the details': (api, s) =>
      api.patch(base(s), { discount_type: 'FIXED_AMOUNT', discount_value: 5, scope_notes: 'changed' }),
    'change the crew': (api, s) => api.post(`${base(s)}/assignees`, { assignee_ids: [s.me.id] }),
    'assign': (api, s) => api.post(`${base(s)}/assign`, { assignee_ids: [s.me.id] }),
    'set the dispatcher': (api, s) => api.post(`${base(s)}/dispatcher`, { dispatcher_id: s.me.id }),
    'add a tag': (api, s) => api.post(`${base(s)}/tags`, { name: 'Priority' }),
    'renumber': (api, s) => api.patch(`${base(s)}/number`, { job_number: `JN-${randomUUID().slice(0, 8)}` }),
    'delete the job': (api, s) => api.delete(base(s)),
    'reschedule a visit': (api, s) =>
      api.patch(`${base(s)}/visits/${randomUUID()}`, { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z' }),
  };

  describe('a job in Office review', () => {
    it('lets the Office review holder make every one of the review\'s own edits, with Change locked jobs off', async () => {
      const s = await setup('OFFICE_REVIEW');
      expect(s.job.id).toBeTruthy();
      for (const [name, edit] of Object.entries(REVIEW_EDITS)) {
        const res = await edit(s.api, s);
        expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      }
    });

    it('logs each edit in the job\'s history naming who made it', async () => {
      const s = await setup('OFFICE_REVIEW');
      for (const edit of Object.values(REVIEW_EDITS)) await edit(s.api, s);

      const events = (await s.api.get(`${base(s)}/timeline`)).body.events as Array<{
        event_type: string; creator: { id: string } | null; metadata: Record<string, unknown> | null;
      }>;
      const mine = events.filter((e) => e.creator?.id === s.me.id).map((e) => e.event_type);
      for (const type of [
        'JOB_LINE_ADDED', 'JOB_LINE_CHANGED', 'JOB_LINE_REMOVED', 'JOB_SCOPE_ADDED', 'JOB_SCOPE_CHANGED', 'JOB_SCOPE_REMOVED',
        'JOB_DISCOUNT_CHANGED', 'JOB_CONTACT_ENTRY_ADDED', 'JOB_CONTACT_ENTRY_CHANGED', 'JOB_CONTACT_ENTRY_CORRECTED',
        'JOB_CONTACT_ENTRY_REMOVED', 'ATTACHMENT_DELETED', 'ATTACHMENT_UPDATED',
      ]) {
        expect(mine, type).toContain(type);
      }
      // Both files are gone, and each delete is on the JOB's history: the invoice's file too, naming the invoice.
      const deletes = events.filter((e) => e.event_type === 'ATTACHMENT_DELETED');
      expect(deletes.map((e) => e.metadata?.attachment_id).sort()).toEqual([s.jobFile, s.invoiceFile].sort());
      expect(deletes.find((e) => e.metadata?.attachment_id === s.invoiceFile)?.metadata?.invoice_id).toBe(s.invoice);
    });

    it('shows each edit as an item in the review panel', async () => {
      const s = await setup('OFFICE_REVIEW');
      for (const edit of Object.values(REVIEW_EDITS)) await edit(s.api, s);

      const review = (await s.api.get(`${base(s)}/review`)).body.review as {
        groups: Array<{ key: string; items: Array<{ kind: string; key: string; by: string | null }> }>;
      };
      const items = review.groups.flatMap((g) => g.items);
      const kinds = new Set(items.map((i) => i.kind));
      for (const kind of ['line', 'scope', 'discount', 'contact', 'attachment']) expect(kinds.has(kind), kind).toBe(true);
      const keys = items.map((i) => i.key);
      expect(keys).toContain(`attachment:${s.jobFile}`);
      expect(keys).toContain(`attachment:${s.invoiceFile}`);
      // Every item names who made it.
      expect(items.every((i) => i.by !== null)).toBe(true);
    });

    it('still refuses the same person a note delete, a job detail edit, a crew change and the rest of the lock list', async () => {
      const s = await setup('OFFICE_REVIEW');
      for (const [name, call] of Object.entries(STILL_LOCKED)) {
        const res = await call(s.api, s);
        expect(res.status, name).toBe(403);
        expect(res.body.error, name).toBe(LOCK_MESSAGE);
      }
      expect(await db.note.count({ where: { id: s.note } })).toBe(1);
    });

    it('refuses a note delete to the author of the note too', async () => {
      const s = await setup('OFFICE_REVIEW');
      const mine = await db.note.create({
        data: { organization_id: s.org, entity_type: 'JOB', entity_id: s.job.id, content: 'Mine', created_by: s.me.id },
        select: { id: true },
      });
      const res = await s.api.delete(`${base(s)}/notes/${mine.id}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(LOCK_MESSAGE);
    });

    it('never replaces the edit\'s own switch: without Edit job line items a line edit is still refused', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_job_line_items: false });
      for (const name of ['add a line', 'edit a line', "cut a line's price", 'remove a line', 'add a scope', 'edit a scope', 'remove a scope']) {
        const res = await REVIEW_EDITS[name]!(s.api, s);
        expect(res.status, name).toBe(403);
      }
      // The discount is a pricing write: it needs the right to price the job as well as Apply discounts.
      expect((await REVIEW_EDITS['change the job discount']!(s.api, s)).status).toBe(403);
    });

    it('refuses the discount without Apply discounts, whatever else the person holds, naming the missing switch and not the lock', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, apply_discounts: false });
      const res = await REVIEW_EDITS['change the job discount']!(s.api, s);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to apply discounts.');
      expect(res.body.code).toBeUndefined();
      expect(Number((await db.job.findUniqueOrThrow({ where: { id: s.job.id }, select: { discount_amount: true } })).discount_amount)).toBe(0);
    });

    it('answers the ordinary missing-permission refusal, not the lock, when the discount lacks the right to price the job', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_job_line_items: false });
      const res = await REVIEW_EDITS['change the job discount']!(s.api, s);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient permissions');
      expect(res.body.code).toBeUndefined();
    });

    it('still answers the lock for the same discount when the person does not hold Office review', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, office_review: false, apply_discounts: false });
      const res = await REVIEW_EDITS['change the job discount']!(s.api, s);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(LOCK_MESSAGE);
      expect(res.body.code).toBe('JOB_LOCKED');
    });

    it('never replaces the customer-detail switches: without Edit jobs and Edit contact details the entries are refused', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_jobs: false, edit_job_and_lead_contact_details: false });
      for (const name of ['add a customer phone', "change the customer's phone", "change the customer's name", 'correct an entry', 'remove an entry']) {
        expect((await REVIEW_EDITS[name]!(s.api, s)).status, name).toBe(403);
      }
    });

    it('lets Edit job and lead contact details change a phone but not the name, and Edit jobs alone change both', async () => {
      const phoneOnly = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_jobs: false });
      expect((await REVIEW_EDITS['add a customer phone']!(phoneOnly.api, phoneOnly)).status).toBe(201);
      expect((await REVIEW_EDITS["change the customer's name"]!(phoneOnly.api, phoneOnly)).status).toBe(403);
      const editsJobs = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_job_and_lead_contact_details: false });
      expect((await REVIEW_EDITS['add a customer phone']!(editsJobs.api, editsJobs)).status).toBe(201);
      expect((await REVIEW_EDITS["change the customer's name"]!(editsJobs.api, editsJobs)).status).toBe(201);
    });

    it('never replaces the record\'s Edit: a job file goes with Edit jobs and an invoice file with Edit invoices, and neither without', async () => {
      const noInvoiceEdit = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_invoices: false });
      expect((await REVIEW_EDITS['delete a job file']!(noInvoiceEdit.api, noInvoiceEdit)).status).toBe(200);
      expect((await REVIEW_EDITS['delete an invoice file']!(noInvoiceEdit.api, noInvoiceEdit)).status).toBe(403);
      const noJobEdit = await setup('OFFICE_REVIEW', { ...REVIEWER, edit_jobs: false });
      expect((await REVIEW_EDITS['delete a job file']!(noJobEdit.api, noJobEdit)).status).toBe(403);
      // The person\'s own upload is no exception: the Edit decides.
      const mine = await addFile(noJobEdit.org, { type: 'JOB', id: noJobEdit.job.id }, noJobEdit.me.id);
      expect((await noJobEdit.api.delete(fileRoute('job', noJobEdit.job.id, mine))).status).toBe(403);
    });

    it('refuses every one of these edits to a person with Office review off, with the lock message', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, office_review: false });
      for (const [name, edit] of Object.entries(REVIEW_EDITS)) {
        const res = await edit(s.api, s);
        expect(res.status, name).toBe(403);
        expect(res.body.error, name).toBe(LOCK_MESSAGE);
      }
    });

    it('answers the lines, the discount and the customer pencils as open on the job page, from the server', async () => {
      const s = await setup('OFFICE_REVIEW');
      const job = (await s.api.get(base(s))).body.job as {
        locked: boolean; contact_locked: boolean; actions: string[]; locked_actions: string[];
      };
      expect(job.actions).toEqual(expect.arrayContaining(['edit_line_items', 'apply_discount', 'office_review']));
      // Details, people and visits stay withheld (disabled with the reason); the job as a whole is still locked.
      expect(job.locked).toBe(true);
      expect(job.locked_actions).toEqual(expect.arrayContaining(['edit', 'assign', 'schedule']));
      expect(job.locked_actions).not.toContain('edit_line_items');
      expect(job.locked_actions).not.toContain('apply_discount');
      expect(job.contact_locked).toBe(false);
    });

    it('answers the same job page as locked for a person with Office review off', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, office_review: false });
      const job = (await s.api.get(base(s))).body.job as { contact_locked: boolean; actions: string[]; locked_actions: string[] };
      expect(job.actions).not.toContain('edit_line_items');
      expect(job.locked_actions).toEqual(expect.arrayContaining(['edit_line_items', 'apply_discount']));
      expect(job.contact_locked).toBe(true);
    });

    it('draws a delete and a rename on the job\'s files and the invoice\'s files for the Office review holder', async () => {
      const s = await setup('OFFICE_REVIEW');
      for (const [type, id, file] of [['job', s.job.id, s.jobFile], ['invoice', s.invoice, s.invoiceFile]] as const) {
        const rows = (await s.api.get(`/api/attachments/${type}/${id}`)).body.attachments as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.id === file)!;
        expect(row.can_delete, type).toBe(true);
        expect(row.can_rename, type).toBe(true);
        expect(row.locked_actions, type).toEqual([]);
      }
    });

    it('draws no delete on the files for a person with Office review off', async () => {
      const s = await setup('OFFICE_REVIEW', { ...REVIEWER, office_review: false });
      for (const [type, id, file] of [['job', s.job.id, s.jobFile], ['invoice', s.invoice, s.invoiceFile]] as const) {
        const rows = (await s.api.get(`/api/attachments/${type}/${id}`)).body.attachments as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.id === file)!;
        expect(row.can_delete, type).toBe(false);
        expect(row.locked_actions, type).toEqual(expect.arrayContaining(['delete']));
      }
    });

    it('keeps an invoice file\'s history entry out of the panel of a reviewer who cannot open that invoice', async () => {
      const s = await setup('OFFICE_REVIEW');
      const blind = await personWith(s.org, { ...OPENING, view_invoices: false, office_review: true });
      expect((await REVIEW_EDITS['delete an invoice file']!(s.api, s)).status).toBe(200);
      expect((await REVIEW_EDITS['delete a job file']!(s.api, s)).status).toBe(200);
      const review = (await (await blind.api()).get(`${base(s)}/review`)).body.review as { groups: Array<{ items: Array<{ key: string }> }> };
      const keys = review.groups.flatMap((g) => g.items.map((i) => i.key));
      expect(keys).toContain(`attachment:${s.jobFile}`);
      expect(keys).not.toContain(`attachment:${s.invoiceFile}`);
    });
  });

  it('lists a file taken off an invoice once in the job\'s Activity, and not at all to a reader who cannot open invoices', async () => {
    const s = await setup('OFFICE_REVIEW');
    expect((await REVIEW_EDITS['delete an invoice file']!(s.api, s)).status).toBe(200);
    const blind = await personWith(s.org, { ...OPENING, view_invoices: false });

    const seen = async (api: Api) =>
      ((await api.get(`${base(s)}/timeline`)).body.events as Array<{ event_type: string; metadata: Record<string, unknown> | null }>)
        .filter((e) => e.event_type === 'ATTACHMENT_DELETED' && e.metadata?.attachment_id === s.invoiceFile);
    expect(await seen(s.api)).toHaveLength(1);
    expect(await seen(await blind.api())).toHaveLength(0);
  });

  for (const status of ['READY_TO_CLOSE', 'DONE'] as const) {
    describe(`a job in ${status}`, () => {
      it('refuses all of the review\'s own edits to the Office review holder, with the lock message (the Done sentence for a Done job\'s lines and prices)', async () => {
        const s = await setup(status);
        for (const [name, edit] of Object.entries(REVIEW_EDITS)) {
          const res = await edit(s.api, s);
          expect(res.status, name).toBe(403);
          // S06.19: a Done job's lines, scopes and discount answer their own sentence; everything else is the lock's.
          const closesPrices = status === 'DONE' && /line|scope|discount/.test(name);
          expect(res.body.error, name).toBe(closesPrices ? 'This job is Done. Reopen it to change its lines or prices.' : LOCK_MESSAGE);
        }
        expect(await db.attachment.count({ where: { id: { in: [s.jobFile, s.invoiceFile] } } })).toBe(2);
      });

      it('answers the lines, the discount, the pencils and the files as locked', async () => {
        const s = await setup(status);
        const job = (await s.api.get(base(s))).body.job as { contact_locked: boolean; actions: string[]; locked_actions: string[] };
        expect(job.actions).not.toContain('edit_line_items');
        expect(job.locked_actions).toEqual(expect.arrayContaining(['edit_line_items', 'apply_discount']));
        expect(job.contact_locked).toBe(true);
        const rows = (await s.api.get(`/api/attachments/invoice/${s.invoice}`)).body.attachments as Array<Record<string, unknown>>;
        expect(rows.find((r) => r.id === s.invoiceFile)!.can_delete).toBe(false);
      });
    });
  }

  it('still lets a Change locked jobs holder through in Ready to close, as before', async () => {
    const s = await setup('READY_TO_CLOSE', { ...REVIEWER, office_review: false, change_locked_jobs: true });
    expect((await REVIEW_EDITS['edit a line']!(s.api, s)).status).toBe(200);
    expect((await REVIEW_EDITS['delete a job file']!(s.api, s)).status).toBe(200);
  });
});
