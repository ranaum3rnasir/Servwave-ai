/* =============================================================================
   Payments go-live V7-10a - the Documents tab's API, called as people on custom roles (never a built-in role
   name). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Covers the upload marker
   (`source`), the Documents list (GET /api/payments-page/documents) and the dialog's target search
   (GET /api/payments-page/documents/targets). Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). It logs queries as
// events so the page's query count can be asserted.
const { realClient, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const client = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on('query', (q) => queries.push(q.query));
    return client;
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, queries };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;
const MARK = 'PAYMENTS_DOCUMENTS';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

suite('Documents tab API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
    for (const org of orgs) await q(`DELETE FROM attachments WHERE organization_id = '${org}'`);
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    return o;
  }

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(org: string, values: Record<string, boolean | string | string[]>, name = 'docs') {
    const key = `docs-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `${name}${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }
  /** Sees the page, may upload, reaches every invoice, job and customer. */
  const officer = (org: string) => personWith(org, {
    view_payments: true, view_invoices: true, invoices_scope: 'all', view_jobs: true, jobs_scope: 'all',
    view_leads: true, leads_scope: 'all', view_customers: true, upload_attachments: true, view_attachments: true,
  }, 'officer');

  /** Customers View off, with every switch that needs it. */
  const NO_CUSTOMERS = {
    view_customers: false, create_customers: false, edit_customers: false, delete_customers: false,
    show_customers_page: false, export_customers: false, archive_customers: false, edit_customer_record_ids: false,
  };

  async function addDoc(
    org: string, entity: { type: 'INVOICE' | 'JOB' | 'CUSTOMER'; id: string }, uploadedBy: string,
    o: { source?: string | null; name?: string; createdAt?: Date } = {},
  ) {
    const id = randomUUID();
    await db.attachment.create({
      data: {
        id, organization_id: org, entity_type: entity.type, entity_id: entity.id, file_name: `${id}.pdf`, file_url: '',
        storage_path: `org/${id}.pdf`, file_type: 'application/pdf', file_size: 2048, display_name: o.name ?? `Doc ${id.slice(0, 4)}`,
        uploaded_by: uploadedBy, ...(o.createdAt ? { created_at: o.createdAt } : {}),
        source: o.source === undefined ? MARK : o.source,
      },
    });
    return id;
  }

  /** Posts a multipart upload as this person. */
  async function upload(person: Person, entity: string, id: string, fields: Record<string, string>) {
    await fx.signedInAs(person);
    const app = (await import('../app.js')).default as never;
    let call = request(app).post(`/api/attachments/${entity}/${id}`).set('Authorization', `Bearer switches-${person.id}`)
      .attach('file', PDF, { filename: 'scope.pdf', contentType: 'application/pdf' });
    for (const [k, v] of Object.entries(fields)) call = call.field(k, v);
    return call;
  }

  describe('the upload marker', () => {
    it('stores PAYMENTS_DOCUMENTS from a multipart upload to an invoice, a job and a customer, and null when none is sent', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await fx.addInvoice(org, customer);
      const me = await officer(org);
      for (const [entity, id] of [['invoice', invoice.id], ['job', job.id], ['customer', customer]] as const) {
        const marked = await upload(me, entity, id, { display_name: `marked ${entity}`, description: '', source: MARK });
        expect(marked.status, `${entity} marked`).toBe(201);
        const plain = await upload(me, entity, id, { display_name: `plain ${entity}`, description: '' });
        expect(plain.status, `${entity} plain`).toBe(201);
        const blank = await upload(me, entity, id, { display_name: `blank ${entity}`, description: '', source: '' });
        expect(blank.status, `${entity} blank`).toBe(201);
      }
      const rows = await db.attachment.findMany({ where: { organization_id: org }, select: { display_name: true, source: true } });
      expect(rows).toHaveLength(9);
      for (const r of rows) expect(r.source, r.display_name).toBe(r.display_name.startsWith('marked') ? MARK : null);
    });

    it('answers 400 Invalid source for any other value, writes no row and puts nothing in storage', async () => {
      const { org, customer } = await newOrg();
      const invoice = await fx.addInvoice(org, customer);
      const me = await officer(org);
      const put = (supabaseAdmin.storage.from('attachments').upload as ReturnType<typeof vi.fn>);
      put.mockClear();
      const res = await upload(me, 'invoice', invoice.id, { display_name: 'x', description: '', source: 'SOMETHING_ELSE' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid source');
      expect(await db.attachment.count({ where: { organization_id: org } })).toBe(0);
      expect(put).not.toHaveBeenCalled();
    });

    it('a source sent twice (a list, not one marker) is the same 400 Invalid source, and nothing is stored', async () => {
      const { org, customer } = await newOrg();
      const invoice = await fx.addInvoice(org, customer);
      const me = await officer(org);
      await fx.signedInAs(me);
      const app = (await import('../app.js')).default as never;
      const res = await request(app).post(`/api/attachments/invoice/${invoice.id}`).set('Authorization', `Bearer switches-${me.id}`)
        .attach('file', PDF, { filename: 'scope.pdf', contentType: 'application/pdf' })
        .field('display_name', 'x').field('description', '').field('source', MARK).field('source', MARK);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid source');
      expect(await db.attachment.count({ where: { organization_id: org } })).toBe(0);
    });

    it('refuses the marker on a record kind the Documents tab does not list', async () => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const me = await officer(org);
      const res = await upload(me, 'lead', lead.id, { display_name: 'x', description: '', source: MARK });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid source');
      expect(await db.attachment.count({ where: { organization_id: org } })).toBe(0);
    });

    it('still refuses a person without Create attachments (403), and a record they cannot open (403)', async () => {
      const { org, customer } = await newOrg();
      const invoice = await fx.addInvoice(org, customer);
      const noUpload = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', upload_attachments: false });
      expect((await upload(noUpload, 'invoice', invoice.id, { display_name: 'x', description: '', source: MARK })).status).toBe(403);
      const attachedOnly = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached', upload_attachments: true });
      expect((await upload(attachedOnly, 'invoice', invoice.id, { display_name: 'x', description: '', source: MARK })).status).toBe(403);
      expect(await db.attachment.count({ where: { organization_id: org } })).toBe(0);
    });
  });

  describe('GET /api/payments-page/documents', () => {
    it('needs View payments', async () => {
      const { org } = await newOrg();
      const without = await personWith(org, { view_payments: false, upload_attachments: true });
      expect((await (await without.api()).get('/api/payments-page/documents')).status).toBe(403);
      const withIt = await personWith(org, { view_payments: true });
      expect((await (await withIt.api()).get('/api/payments-page/documents')).status).toBe(200);
    });

    it('lists only this company\'s marked files, newest first, with the attached record named', async () => {
      const { org, customer, admin } = await newOrg();
      const other = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await fx.addInvoice(org, customer);
      const otherInvoice = await fx.addInvoice(other.org, other.customer);
      await db.job.update({ where: { id: job.id }, data: { job_number: 'J-4101' } });
      await db.invoice.update({ where: { id: invoice.id }, data: { invoice_number: 'INV-1302' } });
      const t = (s: string) => new Date(`2026-10-${s}T12:00:00Z`);
      await addDoc(org, { type: 'INVOICE', id: invoice.id }, admin.id, { name: 'oldest on invoice', createdAt: t('01') });
      await addDoc(org, { type: 'JOB', id: job.id }, admin.id, { name: 'middle on job', createdAt: t('02') });
      await addDoc(org, { type: 'CUSTOMER', id: customer }, admin.id, { name: 'newest on customer', createdAt: t('03') });
      // not listed: an ordinary attachment on the same invoice, and another company's marked file
      await addDoc(org, { type: 'INVOICE', id: invoice.id }, admin.id, { name: 'ordinary', source: null, createdAt: t('04') });
      await addDoc(other.org, { type: 'INVOICE', id: otherInvoice.id }, other.admin.id, { name: 'other company' });

      const me = await officer(org);
      const res = await (await me.api()).get('/api/payments-page/documents');
      expect(res.status).toBe(200);
      expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(['newest on customer', 'middle on job', 'oldest on invoice']);
      expect(res.body.pagination).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
      const [onCustomer, onJob, onInvoice] = res.body.documents;
      expect(onInvoice).toMatchObject({ type: 'Uploaded', size: 2048, attached_to: { kind: 'invoice', id: invoice.id, label: 'INV-1302' } });
      expect(onJob.attached_to).toEqual({ kind: 'job', id: job.id, label: 'J-4101' });
      expect(onCustomer.attached_to).toEqual({ kind: 'customer', id: customer, label: 'Pat Payer' });
      expect(onInvoice.date).toBe(t('01').toISOString());
      for (const d of res.body.documents) expect(d.download_url).toMatch(/^https:\/\//);
      // nothing internal leaks
      expect(Object.keys(onInvoice).sort()).toEqual(['attached_to', 'date', 'download_url', 'id', 'name', 'size', 'type']);
    });

    it('signs a fresh download URL per row, valid one hour', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await fx.addInvoice(org, customer);
      const a = await addDoc(org, { type: 'INVOICE', id: invoice.id }, admin.id);
      const sign = (supabaseAdmin.storage.from('attachments').createSignedUrl as ReturnType<typeof vi.fn>);
      sign.mockClear();
      const res = await (await (await officer(org)).api()).get('/api/payments-page/documents');
      expect(res.status).toBe(200);
      expect(sign).toHaveBeenCalledWith(`org/${a}.pdf`, 3600);
    });

    it('pages at 25 with the total', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await fx.addInvoice(org, customer);
      for (let i = 0; i < 27; i++) {
        await addDoc(org, { type: 'INVOICE', id: invoice.id }, admin.id, { name: `d${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });
      }
      const api = await (await officer(org)).api();
      const first = await api.get('/api/payments-page/documents');
      expect(first.body.documents).toHaveLength(25);
      expect(first.body.documents[0].name).toBe('d26');
      expect(first.body.pagination).toEqual({ page: 1, limit: 25, total: 27, totalPages: 2 });
      const second = await api.get('/api/payments-page/documents?page=2');
      expect(second.body.documents.map((d: { name: string }) => d.name)).toEqual(['d1', 'd0']);
    });

    it('lists a file on a record the person cannot open, with no link and no download', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await fx.addInvoice(org, customer);
      await addDoc(org, { type: 'INVOICE', id: invoice.id }, admin.id, { name: 'on invoice' });
      await addDoc(org, { type: 'JOB', id: job.id }, admin.id, { name: 'on job' });
      await addDoc(org, { type: 'CUSTOMER', id: customer }, admin.id, { name: 'on customer' });
      const narrow = await personWith(org, {
        view_payments: true, view_invoices: true, invoices_scope: 'attached', view_jobs: true, jobs_scope: 'attached',
        view_leads: true, leads_scope: 'attached', ...NO_CUSTOMERS,
      });
      const res = await (await narrow.api()).get('/api/payments-page/documents');
      expect(res.status).toBe(200);
      expect(res.body.documents).toHaveLength(3);
      for (const d of res.body.documents) {
        expect(d.attached_to.id, d.name).toBeNull();
        expect(d.attached_to.label, d.name).toBeNull();
        expect(d.download_url, d.name).toBeNull();
        expect(d.type).toBe('Uploaded');
      }
      expect(res.body.documents.map((d: { attached_to: { kind: string } }) => d.attached_to.kind).sort()).toEqual(['customer', 'invoice', 'job']);
    });

    it('resolves a page of 25 rows in a bounded number of queries', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await fx.addInvoice(org, customer);
      for (let i = 0; i < 25; i++) {
        const entity = [{ type: 'INVOICE' as const, id: invoice.id }, { type: 'JOB' as const, id: job.id }, { type: 'CUSTOMER' as const, id: customer }][i % 3];
        await addDoc(org, entity, admin.id);
      }
      // a person with a restricted reach, so every scope check really queries
      const narrow = await personWith(org, {
        view_payments: true, view_invoices: true, invoices_scope: 'attached', view_jobs: true, jobs_scope: 'attached',
        view_leads: true, leads_scope: 'attached', ...NO_CUSTOMERS,
      });
      const api = await narrow.api();
      await api.get('/api/payments-page/documents'); // warm the permission caches
      queries.length = 0;
      const res = await api.get('/api/payments-page/documents');
      expect(res.body.documents).toHaveLength(25);
      // the page, its count, and one scope check per kind of record - never one per row
      expect(queries.length, queries.join(' | ')).toBeLessThanOrEqual(6);
    });
  });

  describe('GET /api/payments-page/documents/targets', () => {
    it('needs Create attachments, not View payments', async () => {
      const { org } = await newOrg();
      const viewOnly = await personWith(org, { view_payments: true, upload_attachments: false });
      expect((await (await viewOnly.api()).get('/api/payments-page/documents/targets?kind=invoice')).status).toBe(403);
      const uploader = await personWith(org, { view_payments: false, upload_attachments: true, view_invoices: true, invoices_scope: 'all' });
      expect((await (await uploader.api()).get('/api/payments-page/documents/targets?kind=invoice')).status).toBe(200);
    });

    it('refuses an unknown kind', async () => {
      const { org } = await newOrg();
      const me = await officer(org);
      expect((await (await me.api()).get('/api/payments-page/documents/targets?kind=lead')).status).toBe(400);
      expect((await (await me.api()).get('/api/payments-page/documents/targets')).status).toBe(400);
    });

    it('finds invoices by number or customer name, jobs by number, type or customer, customers by name, phone or email', async () => {
      const { org, customer } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { first_name: 'Marcus', last_name: 'Delgado', phone: '5551234567', email: 'marcus@example.test' } });
      const job = await fx.addJob(org, customer);
      await db.job.update({ where: { id: job.id }, data: { job_number: 'J-4101', job_type: 'Furnace tune-up' } });
      const invoice = await fx.addInvoice(org, customer);
      await db.invoice.update({ where: { id: invoice.id }, data: { invoice_number: 'INV-1302', total_amount: 642.5, due_date: new Date('2026-10-20T12:00:00Z') } });
      const api = await (await officer(org)).api();
      const find = async (kind: string, q: string) => (await api.get(`/api/payments-page/documents/targets?kind=${kind}&q=${encodeURIComponent(q)}`)).body.targets as Array<Record<string, unknown>>;

      expect(await find('invoice', '1302')).toEqual([expect.objectContaining({ id: invoice.id, main: 'INV-1302 · Marcus Delgado', amount: 642.5, due_date: '2026-10-20T12:00:00.000Z' })]);
      expect((await find('invoice', 'marcus del')).map((r) => r.id)).toEqual([invoice.id]);
      expect(await find('invoice', 'nobody')).toEqual([]);

      expect(await find('job', 'J-4101')).toEqual([expect.objectContaining({ id: job.id, main: 'J-4101 · Furnace tune-up', sub: 'Marcus Delgado' })]);
      expect((await find('job', 'furnace')).map((r) => r.id)).toEqual([job.id]);
      expect((await find('job', 'delgado')).map((r) => r.id)).toEqual([job.id]);

      expect(await find('customer', 'Marcus')).toEqual([expect.objectContaining({ id: customer, main: 'Marcus Delgado', sub: '5551234567' })]);
      expect((await find('customer', '555123')).map((r) => r.id)).toEqual([customer]);
      expect((await find('customer', 'marcus@example')).map((r) => r.id)).toEqual([customer]);
      await db.customer.update({ where: { id: customer }, data: { phone: null } });
      expect((await find('customer', 'Marcus'))[0].sub).toBe('marcus@example.test');
    });

    it('returns the newest 25 for an empty search, never another company\'s record, never a record the person cannot open', async () => {
      const { org, customer } = await newOrg();
      const other = await newOrg();
      for (let i = 0; i < 27; i++) await fx.addInvoice(org, customer);
      await fx.addInvoice(other.org, other.customer);
      await fx.addJob(other.org, other.customer);
      const api = await (await officer(org)).api();
      const all = await api.get('/api/payments-page/documents/targets?kind=invoice');
      expect(all.body.targets).toHaveLength(25);
      expect((await api.get('/api/payments-page/documents/targets?kind=job')).body.targets).toHaveLength(0);
      expect((await api.get('/api/payments-page/documents/targets?kind=customer')).body.targets).toHaveLength(1);

      const narrow = await personWith(org, {
        upload_attachments: true, view_invoices: true, invoices_scope: 'attached', view_jobs: true, jobs_scope: 'attached',
        view_leads: true, leads_scope: 'attached', ...NO_CUSTOMERS,
      });
      const nApi = await narrow.api();
      for (const kind of ['invoice', 'job', 'customer']) {
        expect((await nApi.get(`/api/payments-page/documents/targets?kind=${kind}`)).body.targets, kind).toEqual([]);
      }
    });
  });
});
