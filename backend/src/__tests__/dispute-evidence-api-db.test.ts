/* =============================================================================
   Payments go-live P10 - answering a dispute inside ServWave (/api/payments-page/disputes/:id/evidence):
   read the form, stage the evidence at the processor, submit it, and the guard on deleting an attached file.

   Called as people on custom roles (never a built-in role name). The processor SDK is mocked at the lib/stripe
   boundary and file storage at the storage client; everything in between is the real app on a real migrated
   database (TEST_DATABASE_URL, skipped when unset). Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';

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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { supabaseAdmin } from '../lib/supabase';
import {
  uploadDisputeEvidenceFile, stageDisputeEvidence, submitDisputeEvidence, retrieveDisputeSubmissionCount,
} from '../lib/stripe';

const suite = realClient ? describe : describe.skip;
const upload = uploadDisputeEvidenceFile as unknown as ReturnType<typeof vi.fn>;
const stage = stageDisputeEvidence as unknown as ReturnType<typeof vi.fn>;
const submit = submitDisputeEvidence as unknown as ReturnType<typeof vi.fn>;
const submissionCount = retrieveDisputeSubmissionCount as unknown as ReturnType<typeof vi.fn>;

const png = (padTo = 0) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(Math.max(0, padTo))]);
async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Anything that looks like a processor id or the vendor's name. */
const PROCESSOR_LOOK = /\b(du|dp|acct|pi|ch|re|po)_[A-Za-z0-9]|\bfile_(?!name\b)[A-Za-z0-9]|stripe/i;

suite('dispute evidence API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  /** The fake bucket: path -> bytes. `info` and `download` answer from it. */
  const bucket = new Map<string, Buffer>();
  beforeEach(() => {
    bucket.clear();
    upload.mockReset();
    let n = 0;
    upload.mockImplementation(async () => `file_test_${++n}`);
    stage.mockReset().mockResolvedValue(undefined);
    submit.mockReset().mockResolvedValue(undefined);
    submissionCount.mockReset().mockResolvedValue(0);
    const storage = (supabaseAdmin.storage.from as unknown as (b: string) => Record<string, unknown>)('attachments');
    storage.info = vi.fn(async (path: string) => bucket.has(path)
      ? { data: { size: bucket.get(path)!.length }, error: null }
      : { data: null, error: { message: 'not found' } });
    storage.download = vi.fn(async (path: string) => bucket.has(path)
      ? { data: new Blob([new Uint8Array(bucket.get(path)!)]), error: null }
      : { data: null, error: { message: 'not found' } });
  });

  const orgs: string[] = [];
  afterAll(async () => {
    for (const org of orgs) {
      const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
      await q(`DELETE FROM dispute_evidence_items WHERE organization_id = '${org}'`);
      await q(`DELETE FROM disputes WHERE organization_id = '${org}'`);
      await q(`DELETE FROM attachments WHERE organization_id = '${org}'`);
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.customer.update({ where: { id: o.customer }, data: { email: 'pat.payer@example.test' } });
    return o;
  }

  async function personWith(org: string, values: Record<string, boolean | string | string[]>, name = 'person') {
    const key = `de-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `${name}${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }
  const SEES = { view_payments: true, view_invoices: true, invoices_scope: 'all' } as const;
  const responder = (org: string) => personWith(org, { ...SEES, refund_payments: true }, 'responder');
  const viewer = (org: string) => personWith(org, { ...SEES, refund_payments: false }, 'viewer');

  /** An invoice with a card payment and a dispute on it. */
  async function addDispute(org: string, customer: string, o: {
    status?: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON'; bank?: boolean; due?: Date | null; brand?: string; reason?: string; count?: number; account?: string | null;
  } = {}) {
    const { id: invoiceId } = await fx.addInvoice(org, customer);
    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, invoice_id: invoiceId, amount: 100, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
        stripe_payment_intent_id: `pi_test_${paymentId.slice(0, 12)}`, card_brand: o.brand ?? 'visa', card_last4: '4242',
        stripe_account_id: o.account === undefined ? 'acct_test_one' : o.account,
      },
    });
    const d = await db.dispute.create({
      data: {
        organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_test_${randomUUID().slice(0, 12)}`,
        status: o.status ?? 'NEEDS_RESPONSE', reason: o.reason ?? 'product_not_received', amount: 100,
        evidence_due_by: o.due === undefined ? new Date(Date.now() + 7 * 86_400_000) : o.due, is_bank_return: o.bank ?? false,
        evidence_submission_count: o.count ?? 0,
      },
    });
    return { id: d.id, invoiceId, paymentId, processorId: d.stripe_dispute_id };
  }

  /** A stored file attached to an invoice (or another record). `declared` is what the row says; `bytes` is what storage holds. */
  async function addFile(org: string, uploader: string, record: string, bytes: Buffer, o: {
    name?: string; entity?: 'INVOICE' | 'JOB'; declaredType?: string; declaredSize?: number; path?: string | null;
  } = {}) {
    const id = randomUUID();
    const path = o.path === undefined ? `${org}/${id}/${o.name ?? 'file.pdf'}` : o.path;
    if (path) bucket.set(path, bytes);
    await db.attachment.create({
      data: {
        id, entity_type: o.entity ?? 'INVOICE', entity_id: record, file_name: o.name ?? 'file.pdf', file_url: 'x', storage_path: path,
        file_type: o.declaredType ?? 'application/pdf', file_size: o.declaredSize ?? bytes.length, display_name: o.name ?? 'file.pdf',
        uploaded_by: uploader, organization_id: org,
      },
    });
    return id;
  }

  const get = (api: Api, id: string) => api.get(`/api/payments-page/disputes/${id}/evidence`);
  const put = (api: Api, id: string, body: object) => api.put(`/api/payments-page/disputes/${id}/evidence`, body);
  const send = (api: Api, id: string, body: object) => api.post(`/api/payments-page/disputes/${id}/evidence/submit`, body);

  /** A dispute plus a responder and one stored PDF on its invoice: the start of most cases. */
  async function setup(opts: Parameters<typeof addDispute>[2] = {}) {
    const { org, customer, admin } = await newOrg();
    const d = await addDispute(org, customer, opts);
    const me = await responder(org);
    const api = await me.api();
    const file = (bytes: Buffer, o: Parameters<typeof addFile>[4] = {}) => addFile(org, admin.id, d.invoiceId, bytes, o);
    return { org, customer, admin, d, me, api, file };
  }

  // ---------------------------------------------------------------------------------------------------------------
  describe('who may do what', () => {
    it('lets View payments read the form and nothing else, and a view-only person sees can_edit false', async () => {
      const { org, customer } = await newOrg();
      const d = await addDispute(org, customer);
      const seer = await viewer(org);
      const api = await seer.api();
      const res = await get(api, d.id);
      expect(res.status).toBe(200);
      expect(res.body.can_edit).toBe(false);
      expect(res.body.can_submit).toBe(false);
      expect((await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'x' } })).status).toBe(403);
      expect((await send(api, d.id, { version: 0 })).status).toBe(403);
      expect(upload).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('refuses the read to a person without View payments', async () => {
      const { org, customer } = await newOrg();
      const d = await addDispute(org, customer);
      const nobody = await personWith(org, { view_payments: false, view_invoices: true, invoices_scope: 'all', refund_payments: false });
      expect((await get(await nobody.api(), d.id)).status).toBe(403);
    });

    it('lets the responder read the form: dispute facts, defaults from the customer, limits, recommended fields, no processor id', async () => {
      const { api, d } = await setup({ reason: 'product_not_received' });
      const res = await get(api, d.id);
      expect(res.status).toBe(200);
      expect(res.body.dispute).toMatchObject({ id: d.id, status: 'NEEDS_RESPONSE', reason_text: 'The customer says they did not receive the service', amount: 100, is_bank_return: false, closed_at: null, outcome: null });
      expect(res.body.dispute.days_left).toBeGreaterThanOrEqual(6);
      expect(res.body.dispute.respond_by).toEqual(expect.any(String));
      expect(res.body.can_edit).toBe(true);
      expect(res.body.can_submit).toBe(false);
      expect(res.body.form.version).toBe(0);
      expect(res.body.form.defaults).toMatchObject({ customer_name: 'Pat Payer', customer_email_address: 'pat.payer@example.test' });
      expect(res.body.form.text.customer_name).toBe('');
      expect(Object.keys(res.body.form.files).sort()).toEqual(['cancellation_policy', 'customer_communication', 'customer_signature', 'receipt', 'refund_policy', 'service_documentation', 'uncategorized_file']);
      expect(res.body.form.files.receipt).toBeNull();
      expect(res.body.totals).toEqual({ bytes: 0, pages: 0, chars: 0 });
      expect(res.body.limits).toEqual({ max_bytes: 4_500_000, max_pages: 49, max_chars: 150_000, types: ['application/pdf', 'image/jpeg', 'image/png'] });
      expect(res.body.recommended).toEqual(expect.arrayContaining(['service_documentation', 'service_date', 'uncategorized_text']));
      expect(res.body.submitted).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(PROCESSOR_LOOK);
    });

    it('names the customer and the invoice the dispute is on, so the form can show them and attach files to the invoice', async () => {
      const { api, d } = await setup();
      const res = await get(api, d.id);
      expect(res.status).toBe(200);
      expect(res.body.dispute.customer_name).toBe('Pat Payer');
      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: d.invoiceId }, select: { invoice_number: true } });
      expect(res.body.dispute.invoice).toEqual({ id: d.invoiceId, number: invoice.invoice_number });
      expect(JSON.stringify(res.body)).not.toMatch(PROCESSOR_LOOK);
    });

    it('cannot edit a bank return, a closed dispute, a past-due dispute or one already submitted', async () => {
      const { org, customer } = await newOrg();
      const me = await responder(org);
      const api = await me.api();
      const cases = [
        await addDispute(org, customer, { bank: true }),
        await addDispute(org, customer, { status: 'WON' }),
        await addDispute(org, customer, { due: new Date(Date.now() - 3_600_000) }),
        await addDispute(org, customer, { status: 'UNDER_REVIEW', count: 1 }),
      ];
      for (const c of cases) expect((await get(api, c.id)).body.can_edit, c.id).toBe(false);
      expect((await get(api, cases[1].id)).body.dispute.outcome).toBe('won');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('V7-05a: the dispute code and the customer block', () => {
    it('carries dispute.reference and a customer_block, and never the processor\'s dispute id', async () => {
      const { api, d, customer } = await setup();
      const res = await get(api, d.id);
      expect(res.status).toBe(200);
      expect(res.body.dispute.reference).toBe(`DSP-${d.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`);
      expect(res.body.customer_block).toMatchObject({ restricted: false, id: customer, name: 'Pat Payer', email: 'pat.payer@example.test', invoice: { id: d.invoiceId } });
      expect(JSON.stringify(res.body)).not.toContain(d.processorId);
    });
  });

  describe('V7-08a: opening an evidence file, and the extra dispute fields', () => {
    const fileUrl = (api: Api, id: string, attachmentId: string) => api.get(`/api/payments-page/disputes/${id}/evidence/files/${attachmentId}`);
    const storage = () => (supabaseAdmin.storage.from as unknown as (b: string) => { createSignedUrl: ReturnType<typeof vi.fn> })('attachments');

    /** An evidence row written straight to the table (the staging route needs real bytes; these cases are about reading). */
    async function evidence(org: string, disputeId: string, attachmentId: string, field = 'receipt', o: { name?: string; size?: number; pages?: number } = {}) {
      await db.disputeEvidenceItem.create({
        data: {
          organization_id: org, dispute_id: disputeId, evidence_field: field, attachment_id: attachmentId, file_name: o.name ?? 'invoice.pdf',
          mime: 'application/pdf', size_bytes: o.size ?? 1234, page_count: o.pages ?? 2, sha256: 'a'.repeat(64), processor_file_id: 'file_secret_1',
        },
      });
    }

    it('returns a signed url and the stored facts for a file in this dispute, and never the hash, path or processor id', async () => {
      const { org, d, api, file } = await setup();
      const id = await file(await pdf(2), { name: 'invoice.pdf' });
      await evidence(org, d.id, id);
      storage().createSignedUrl.mockClear();
      const res = await fileUrl(api, d.id, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: expect.stringContaining('https://'), file_name: 'invoice.pdf', mime: 'application/pdf', size_bytes: 1234, page_count: 2 });
      const att = await db.attachment.findUniqueOrThrow({ where: { id } });
      expect(storage().createSignedUrl).toHaveBeenCalledWith(att.storage_path, 3600);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('file_secret_1');
      expect(text).not.toContain('a'.repeat(64));
      expect(text).not.toContain(att.storage_path as string);
    });

    it('returns the stored url for a legacy row that has no storage path', async () => {
      const { org, d, api, file } = await setup();
      const id = await file(await pdf(1), { path: null });
      await db.attachment.update({ where: { id }, data: { file_url: 'https://files.example.test/legacy.pdf' } });
      await evidence(org, d.id, id);
      storage().createSignedUrl.mockClear();
      const res = await fileUrl(api, d.id, id);
      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://files.example.test/legacy.pdf');
      expect(storage().createSignedUrl).not.toHaveBeenCalled();
    });

    it('answers 404 for another company\'s file, for this company\'s file that is not evidence on this dispute, and for a malformed id', async () => {
      const { org, customer, admin, d, api, file } = await setup();
      const mine = await file(await pdf(1));
      await evidence(org, d.id, mine);
      const other = await newOrg();
      const theirDispute = await addDispute(other.org, other.customer);
      const theirFile = await addFile(other.org, other.admin.id, theirDispute.invoiceId, await pdf(1));
      await evidence(other.org, theirDispute.id, theirFile);
      const notEvidence = await addFile(org, admin.id, d.invoiceId, await pdf(1));
      const sibling = await addDispute(org, customer);
      const siblingFile = await addFile(org, admin.id, sibling.invoiceId, await pdf(1));
      await evidence(org, sibling.id, siblingFile);
      storage().createSignedUrl.mockClear();
      for (const id of [theirFile, notEvidence, siblingFile, randomUUID(), 'not-a-uuid']) {
        const res = await fileUrl(api, d.id, id);
        expect(res.status, id).toBe(404);
        expect(res.body.error).toBe('File not found');
      }
      expect((await fileUrl(api, theirDispute.id, theirFile)).status).toBe(404);
      expect(storage().createSignedUrl).not.toHaveBeenCalled();
    });

    it('answers 404 when the person cannot open the invoice and 403 without View payments', async () => {
      const { org, d, file } = await setup();
      const id = await file(await pdf(1));
      await evidence(org, d.id, id);
      const narrow = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached', refund_payments: true });
      const res = await fileUrl(await narrow.api(), d.id, id);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('https://');
      const nobody = await personWith(org, { view_payments: false, view_invoices: true, invoices_scope: 'all', refund_payments: false });
      expect((await fileUrl(await nobody.api(), d.id, id)).status).toBe(403);
    });

    it('lets a View-only person open a file (reading evidence needs View payments only)', async () => {
      const { org, d, file } = await setup();
      const id = await file(await pdf(1));
      await evidence(org, d.id, id);
      const seer = await viewer(org);
      expect((await fileUrl(await seer.api(), d.id, id)).status).toBe(200);
    });

    it('puts the attachment id on every submitted file', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(2), { name: 'invoice.pdf' });
      const staging = await put(api, d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'We did the work.' } });
      const res = await send(api, d.id, { version: staging.body.form.version });
      expect(res.status).toBe(200);
      expect(res.body.submitted.files).toEqual([{ field: 'receipt', file_name: 'invoice.pdf', attachment_id: a }]);
      expect((await get(api, d.id)).body.submitted.files).toEqual([{ field: 'receipt', file_name: 'invoice.pdf', attachment_id: a }]);
    });

    it('carries when the dispute opened and the payment it is on, with its PMT code and no processor id', async () => {
      const { api, d } = await setup();
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      const res = await get(api, d.id);
      expect(res.body.dispute.opened_at).toBe(row.created_at.toISOString());
      expect(res.body.dispute.payment).toEqual({ id: d.paymentId, reference: `PMT-${d.paymentId.replace(/-/g, '').slice(0, 8).toUpperCase()}` });
      expect(res.body.dispute.reference).toMatch(/^DSP-[0-9A-F]{8}$/);
      expect(JSON.stringify(res.body)).not.toMatch(PROCESSOR_LOOK);
    });

    it('gives a person who cannot open the invoice nothing about the customer', async () => {
      const { org, d } = await setup();
      const narrow = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached', refund_payments: true });
      const res = await get(await narrow.api(), d.id);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Pat');
      expect(res.body.customer_block).toBeUndefined();
    });
  });

  describe('whose dispute and whose file', () => {
    it('answers 404 for another company\'s dispute on every route and never reaches the processor', async () => {
      const mine = await newOrg();
      const theirs = await newOrg();
      const d = await addDispute(theirs.org, theirs.customer);
      const api = await (await responder(mine.org)).api();
      expect((await get(api, d.id)).status).toBe(404);
      expect((await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'x' } })).status).toBe(404);
      expect((await send(api, d.id, { version: 0 })).status).toBe(404);
      expect((await get(api, randomUUID())).status).toBe(404);
      expect((await get(api, 'not-a-uuid')).status).toBe(404);
      expect(upload).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('answers 404 for a dispute on an invoice the person cannot open', async () => {
      const { org, customer } = await newOrg();
      const d = await addDispute(org, customer);
      const narrow = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached', refund_payments: true });
      const api = await narrow.api();
      expect((await get(api, d.id)).status).toBe(404);
      expect((await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'x' } })).status).toBe(404);
      expect((await send(api, d.id, { version: 0 })).status).toBe(404);
      expect(stage).not.toHaveBeenCalled();
    });

    it('refuses a file of another company, of another invoice and of a job, as not found, naming the field', async () => {
      const { org, admin, d, api } = await setup();
      const other = await newOrg();
      const otherInvoice = await fx.addInvoice(org, (await newOrg().then((o) => o.customer)).toString()).catch(() => null);
      void otherInvoice;
      const sameOrgOtherInvoice = await fx.addInvoice(org, (await db.customer.findFirstOrThrow({ where: { organization_id: org } })).id);
      const foreign = await addFile(other.org, other.admin.id, d.invoiceId, await pdf(1));
      const elsewhere = await addFile(org, admin.id, sameOrgOtherInvoice.id, await pdf(1));
      const job = await fx.addJob(org, (await db.customer.findFirstOrThrow({ where: { organization_id: org } })).id, {});
      const onJob = await addFile(org, admin.id, job.id, await pdf(1), { entity: 'JOB' });
      for (const [field, id] of [['receipt', foreign], ['refund_policy', elsewhere], ['customer_communication', onJob]] as const) {
        const res = await put(api, d.id, { version: 0, files: { [field]: id }, text: {} });
        expect(res.status, field).toBe(404);
        expect(res.body.field).toBe(field);
      }
      expect(await db.disputeEvidenceItem.count({ where: { dispute_id: d.id } })).toBe(0);
      expect(upload).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    });

    it('refuses a field that is not on the list', async () => {
      const { api, d } = await setup();
      const res = await put(api, d.id, { version: 0, files: { shipping_documentation: randomUUID() }, text: {} });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('shipping_documentation');
      const text = await put(api, d.id, { version: 0, files: {}, text: { shipping_tracking_number: '123' } });
      expect(text.status).toBe(400);
      expect(text.body.field).toBe('shipping_tracking_number');
    });

    it('refuses the same file in two fields', async () => {
      const { api, d, file } = await setup();
      const id = await file(await pdf(1));
      const res = await put(api, d.id, { version: 0, files: { receipt: id, refund_policy: id }, text: {} });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('refund_policy');
      expect(upload).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('the stored bytes decide, not the row', () => {
    it('reads a PNG that is declared as a PDF for what it is', async () => {
      const { api, d, file } = await setup();
      const id = await file(png(), { name: 'scan.pdf', declaredType: 'application/pdf' });
      const res = await put(api, d.id, { version: 0, files: { receipt: id }, text: {} });
      expect(res.status).toBe(200);
      expect(res.body.form.files.receipt).toMatchObject({ attachment_id: id, mime: 'image/png', page_count: 1 });
      expect(upload).toHaveBeenCalledWith('acct_test_one', expect.objectContaining({ mime: 'image/png' }));
    });

    it('judges the size on the stored object even when the row says it is small', async () => {
      const { api, d, file } = await setup();
      const id = await file(png(4_600_596), { declaredSize: 10 });
      const res = await put(api, d.id, { version: 0, files: { receipt: id }, text: {} });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ field: 'receipt', error: 'The files total 4.6 MB. The limit is 4.5 MB for all files together.' });
      expect(upload).not.toHaveBeenCalled();
    });

    it('refuses a HEIC photo declared as a PNG, an unreadable PDF and an encrypted PDF, each naming its field', async () => {
      const { api, d, file } = await setup();
      const heic = await file(HEIC, { name: 'photo.png', declaredType: 'image/png' });
      const bad = await file(Buffer.from('%PDF-1.4 nothing readable here'), { name: 'a.pdf' });
      const res1 = await put(api, d.id, { version: 0, files: { receipt: heic }, text: {} });
      expect(res1.status).toBe(400);
      expect(res1.body).toEqual({ field: 'receipt', error: 'Evidence must be a PDF, JPG or PNG. Save it as a PDF and attach that.' });
      const res2 = await put(api, d.id, { version: 0, files: { refund_policy: bad }, text: {} });
      expect(res2.body).toEqual({ field: 'refund_policy', error: "This PDF can't be read. Save it again as a PDF and attach that." });
      expect(upload).not.toHaveBeenCalled();
    });

    it('answers not found for a file whose stored object is missing', async () => {
      const { api, d, file } = await setup();
      const id = await file(await pdf(1));
      bucket.clear();
      const res = await put(api, d.id, { version: 0, files: { receipt: id }, text: {} });
      expect(res.status).toBe(404);
      expect(res.body.field).toBe('receipt');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('limits across every slot', () => {
    it('counts the bytes of all slots together', async () => {
      const { api, d, file } = await setup();
      const a = await file(png(2_000_000));
      const b = await file(png(2_500_000));
      const res = await put(api, d.id, { version: 0, files: { receipt: a, customer_communication: b }, text: {} });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('customer_communication');
      expect(res.body.error).toMatch(/^The files total 4\.\d MB\. The limit is 4\.5 MB for all files together\.$/);
    });

    it('counts the pages of all slots together and holds a Mastercard payment to 19', async () => {
      const visa = await setup({ brand: 'visa' });
      const v1 = await visa.file(await pdf(30));
      const v2 = await visa.file(await pdf(20));
      expect((await put(visa.api, visa.d.id, { version: 0, files: { receipt: v1, refund_policy: v2 }, text: {} })).body).toMatchObject({
        field: 'refund_policy', error: 'The files total 50 pages. The limit is 49 pages for all files together.',
      });
      const v3 = await visa.file(await pdf(19));
      expect((await put(visa.api, visa.d.id, { version: 0, files: { receipt: v1, refund_policy: v3 }, text: {} })).status).toBe(200);

      const mc = await setup({ brand: 'mastercard' });
      const m20 = await mc.file(await pdf(20));
      const m19 = await mc.file(await pdf(19));
      const refused = await put(mc.api, mc.d.id, { version: 0, files: { receipt: m20 }, text: {} });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ field: 'receipt', error: 'The files total 20 pages. The limit is 19 pages for a Mastercard payment.' });
      expect((await put(mc.api, mc.d.id, { version: 0, files: { receipt: m19 }, text: {} })).status).toBe(200);
    });

    it('counts the characters of all text fields together', async () => {
      const { api, d } = await setup();
      const over = await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'a'.repeat(100_000), product_description: 'b'.repeat(50_001) } });
      expect(over.status).toBe(400);
      expect(over.body).toEqual({ field: 'product_description', error: 'The text totals 150,001 characters. The limit is 150,000 for all text together.' });
      const ok = await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'a'.repeat(100_000), product_description: 'b'.repeat(50_000) } });
      expect(ok.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('staging the draft at the processor', () => {
    it('uploads each new slot once, stages without submitting, and records what was sent', async () => {
      const { api, d, file, org } = await setup();
      const bytes = await pdf(2);
      const a = await file(bytes, { name: 'invoice.pdf' });
      const b = await file(png(), { name: 'signed.png', declaredType: 'image/png' });
      const res = await put(api, d.id, { version: 0, files: { receipt: a, customer_signature: b }, text: { uncategorized_text: 'We did the work on the 3rd.' } });
      expect(res.status).toBe(200);
      expect(res.body.form.version).toBe(1);
      expect(res.body.totals).toMatchObject({ pages: 3 });
      expect(res.body.can_submit).toBe(true);

      expect(upload).toHaveBeenCalledTimes(2);
      expect(upload).toHaveBeenCalledWith('acct_test_one', expect.objectContaining({ name: 'invoice.pdf', mime: 'application/pdf' }));
      expect(stage).toHaveBeenCalledTimes(1);
      const [account, processorId, evidence] = stage.mock.calls[0];
      expect(account).toBe('acct_test_one');
      expect(processorId).toBe(d.processorId);
      expect(evidence).toMatchObject({ receipt: expect.stringMatching(/^file_test_/), customer_signature: expect.stringMatching(/^file_test_/), uncategorized_text: 'We did the work on the 3rd.' });
      // a field with no file is sent empty, so a file removed earlier cannot linger at the processor
      expect(evidence.refund_policy).toBe('');
      expect(submit).not.toHaveBeenCalled();

      const items = await db.disputeEvidenceItem.findMany({ where: { dispute_id: d.id }, orderBy: { evidence_field: 'asc' } });
      expect(items.map((i) => i.evidence_field)).toEqual(['customer_signature', 'receipt']);
      const receipt = items.find((i) => i.evidence_field === 'receipt')!;
      expect(receipt).toMatchObject({ organization_id: org, attachment_id: a, file_name: 'invoice.pdf', mime: 'application/pdf', size_bytes: bytes.length, page_count: 2, sha256: sha(bytes) });
      expect(receipt.processor_file_id).toMatch(/^file_test_/);
      expect(receipt.staged_at).not.toBeNull();
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_staged_at).not.toBeNull();
      expect(row.evidence_version).toBe(1);
      expect(row.evidence_submitted_at).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(PROCESSOR_LOOK);
    });

    it('sends nothing to the platform account pin when the payment has no connected account', async () => {
      const { api, d, file } = await setup({ account: null });
      const a = await file(await pdf(1));
      expect((await put(api, d.id, { version: 0, files: { receipt: a }, text: {} })).status).toBe(200);
      expect(upload).toHaveBeenCalledWith(null, expect.anything());
      expect(stage.mock.calls[0][0]).toBeNull();
    });

    it('re-uploads only the slot that changed', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      const b = await file(await pdf(1));
      const c = await file(await pdf(1));
      await put(api, d.id, { version: 0, files: { receipt: a, refund_policy: b }, text: {} });
      upload.mockClear();
      stage.mockClear();
      const res = await put(api, d.id, { version: 1, files: { refund_policy: c }, text: {} });
      expect(res.status).toBe(200);
      expect(upload).toHaveBeenCalledTimes(1);
      const evidence = stage.mock.calls[0][2];
      expect(evidence.refund_policy).toMatch(/^file_test_/);
      expect(evidence).not.toHaveProperty('receipt');
      const items = await db.disputeEvidenceItem.findMany({ where: { dispute_id: d.id } });
      expect(items.find((i) => i.evidence_field === 'receipt')!.attachment_id).toBe(a);
      expect(items.find((i) => i.evidence_field === 'refund_policy')!.attachment_id).toBe(c);
    });

    it('clears a slot by sending its field empty', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      await put(api, d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'x' } });
      stage.mockClear();
      upload.mockClear();
      const res = await put(api, d.id, { version: 1, files: { receipt: null }, text: {} });
      expect(res.status).toBe(200);
      expect(upload).not.toHaveBeenCalled();
      expect(stage.mock.calls[0][2].receipt).toBe('');
      expect(res.body.form.files.receipt).toBeNull();
      expect(await db.disputeEvidenceItem.count({ where: { dispute_id: d.id } })).toBe(0);
    });

    it('keeps typed text and fills the defaults only where nothing was typed', async () => {
      const { api, d } = await setup();
      await put(api, d.id, { version: 0, files: {}, text: { customer_name: 'Patricia P. Payer', customer_email_address: '' } });
      const form = (await get(api, d.id)).body.form;
      expect(form.text.customer_name).toBe('Patricia P. Payer');
      expect(form.text.customer_email_address).toBe('');
    });

    it('warns at stage time when there is no file and no explanation, and still saves', async () => {
      const { api, d } = await setup();
      const res = await put(api, d.id, { version: 0, files: {}, text: {} });
      expect(res.status).toBe(200);
      expect(res.body.warnings).toEqual(['empty']);
      expect(res.body.can_submit).toBe(false);
      const withText = await put(api, d.id, { version: 1, files: {}, text: { uncategorized_text: 'We did the work.' } });
      expect(withText.body.warnings).toEqual([]);
    });

    it('counts only stored text in the totals, never the prefilled defaults', async () => {
      const { api, d } = await setup();
      await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'abcde' } });
      const body = (await get(api, d.id)).body;
      expect(body.totals.chars).toBe(5);
      expect(body.form.defaults.customer_name).toBe('Pat Payer');
    });

    it('answers 409 to a stale version and changes nothing', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      expect((await put(api, d.id, { version: 0, files: { receipt: a }, text: {} })).status).toBe(200);
      stage.mockClear();
      const stale = await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'late' } });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('Someone changed this evidence. Reload and try again.');
      expect(stage).not.toHaveBeenCalled();
      expect((await db.dispute.findUniqueOrThrow({ where: { id: d.id } })).evidence_version).toBe(1);
    });

    it('keeps the draft, marks nothing as sent and says so when the processor refuses, then a retry sends what is missing', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      stage.mockRejectedValueOnce(Object.assign(new Error('Invalid file du_secret for acct_secret at stripe'), { code: 'something_odd' }));
      const failed = await put(api, d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'Draft text' } });
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("We couldn't send this to the card network. Try again in a moment, or contact ServWave support.");
      expect(failed.body).toMatchObject({ sent: false, draft_saved: true });
      expect(JSON.stringify(failed.body)).not.toMatch(PROCESSOR_LOOK);

      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_staged_at).toBeNull();
      expect(row.evidence_version).toBe(1);
      const items = await db.disputeEvidenceItem.findMany({ where: { dispute_id: d.id } });
      expect(items).toHaveLength(1);
      expect(items[0].staged_at).toBeNull();
      const read = (await get(api, d.id)).body;
      expect(read.form.files.receipt.attachment_id).toBe(a);
      expect(read.form.text.uncategorized_text).toBe('Draft text');
      expect(read.can_submit).toBe(false);

      upload.mockClear();
      stage.mockClear();
      const retry = await put(api, d.id, { version: 1, files: {}, text: {} });
      expect(retry.status).toBe(200);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(stage.mock.calls[0][2]).toMatchObject({ receipt: expect.stringMatching(/^file_test_/), uncategorized_text: 'Draft text' });
      expect((await db.dispute.findUniqueOrThrow({ where: { id: d.id } })).evidence_staged_at).not.toBeNull();
    });

    it('carries the saved form and its new version in the refusal, so the retry with that version is not a 409', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      stage.mockRejectedValueOnce(Object.assign(new Error('Invalid file du_secret for acct_secret at stripe'), { code: 'something_odd' }));
      const failed = await put(api, d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'Draft text' } });
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("We couldn't send this to the card network. Try again in a moment, or contact ServWave support.");
      expect(failed.body).toMatchObject({ sent: false, draft_saved: true, staged: false });
      // The same form and state a 200 carries, with the version the save moved on to.
      const read = (await get(api, d.id)).body;
      expect(failed.body.form).toEqual(read.form);
      expect(failed.body.form.version).toBe(1);
      expect(failed.body.form.text.uncategorized_text).toBe('Draft text');
      expect(failed.body.dispute).toEqual(read.dispute);
      expect(failed.body.can_submit).toBe(false);
      expect(JSON.stringify(failed.body)).not.toMatch(PROCESSOR_LOOK);

      const retry = await put(api, d.id, { version: failed.body.form.version, files: {}, text: {} });
      expect(retry.status).toBe(200);
      expect(retry.body.staged).toBe(true);
    });

    it('marks the file the card network did not take as refused beside its row, and names the field the processor pointed at', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1), { name: 'receipt.pdf' });
      const b = await file(await pdf(1), { name: 'policy.pdf' });
      // One file uploads, the other is refused (by name, so the order the server walks them in does not matter).
      upload.mockReset().mockImplementation(async (_acct: string, f: { name: string }) => {
        if (f.name === 'policy.pdf') throw Object.assign(new Error('Invalid file'), { type: 'StripeInvalidRequestError', statusCode: 400 });
        return 'file_test_1';
      });
      const failed = await put(api, d.id, { version: 0, files: { receipt: a, refund_policy: b }, text: {} });
      expect(failed.status).toBe(502);
      expect(failed.body.field).toBe('refund_policy');
      expect(failed.body.form.files.refund_policy).toMatchObject({ attachment_id: b, refused: true });
      expect(failed.body.form.files.receipt).toMatchObject({ attachment_id: a });
      expect(JSON.stringify(failed.body)).not.toMatch(PROCESSOR_LOOK);

      // Once the retry goes through nothing is marked.
      upload.mockReset().mockResolvedValue('file_test_9');
      const ok = await put(api, d.id, { version: failed.body.form.version, files: {}, text: {} });
      expect(ok.status).toBe(200);
      expect(ok.body.form.files.refund_policy.refused).toBeUndefined();
      expect(ok.body.form.files.receipt.refused).toBeUndefined();
    });

    it('names the text field when the processor points at one, and marks no file as refused', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      stage.mockRejectedValueOnce(Object.assign(new Error('Invalid value'), { type: 'StripeInvalidRequestError', statusCode: 400, param: 'evidence[customer_name]' }));
      const failed = await put(api, d.id, { version: 0, files: { receipt: a }, text: { customer_name: 'Pat Payer' } });
      expect(failed.status).toBe(502);
      expect(failed.body.field).toBe('customer_name');
      expect(failed.body.form.text.customer_name).toBe('Pat Payer');
      // The file reached the processor; only the text was refused.
      expect(failed.body.form.files.receipt.refused).toBeUndefined();
    });

    it('translates a processor refusal about the deadline', async () => {
      const { api, d } = await setup();
      stage.mockRejectedValueOnce(Object.assign(new Error('The evidence is past due'), { code: 'dispute_evidence_past_due' }));
      const res = await put(api, d.id, { version: 0, files: {}, text: { uncategorized_text: 'x' } });
      expect(res.body.error).toBe('The deadline has passed');
    });

    it('refuses an edit on a bank return, a closed dispute, a past-due dispute and a submitted one, without reaching the processor', async () => {
      const { org, customer } = await newOrg();
      const api = await (await responder(org)).api();
      const body = { version: 0, files: {}, text: { uncategorized_text: 'x' } };
      const bank = await addDispute(org, customer, { bank: true });
      const closed = await addDispute(org, customer, { status: 'WON' });
      const late = await addDispute(org, customer, { due: new Date(Date.now() - 3_600_000) });
      const done = await addDispute(org, customer, { status: 'UNDER_REVIEW', count: 1 });
      expect((await put(api, bank.id, body)).body.error).toBe('A returned bank payment takes no evidence.');
      expect((await put(api, closed.id, body)).body.error).toBe('This dispute is closed.');
      expect((await put(api, late.id, body)).body.error).toBe('The deadline has passed');
      expect((await put(api, done.id, body)).body.error).toBe('Evidence was already submitted');
      for (const r of [bank, closed, late, done]) expect((await put(api, r.id, body)).status).toBe(409);
      expect(stage).not.toHaveBeenCalled();
    });

    it('writes an audit row with field names and totals only', async () => {
      const { api, d, file, org } = await setup();
      const a = await file(await pdf(2), { name: 'secret-customer-name.pdf' });
      await put(api, d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'private words' } });
      const rows = await db.auditLog.findMany({ where: { org_id: org, action: 'dispute.evidence_staged' } });
      expect(rows).toHaveLength(1);
      const blob = JSON.stringify(rows[0].metadata);
      expect(JSON.parse(blob)).toMatchObject({ files: ['receipt'], bytes: expect.any(Number), pages: 2 });
      expect(blob).not.toMatch(/private words|secret-customer-name/);
      expect(blob).not.toMatch(PROCESSOR_LOOK);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('submitting', () => {
    async function staged(opts: Parameters<typeof addDispute>[2] = {}) {
      const s = await setup(opts);
      const a = await s.file(await pdf(2), { name: 'invoice.pdf' });
      const staging = await put(s.api, s.d.id, { version: 0, files: { receipt: a }, text: { uncategorized_text: 'We did the work.' } });
      expect(staging.status).toBe(200);
      return { ...s, version: staging.body.form.version as number };
    }

    it('submits once, stamps the dispute and its files, and writes the audit and timeline rows', async () => {
      const { api, d, me, org, version } = await staged();
      const res = await send(api, d.id, { version });
      expect(res.status).toBe(200);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith('acct_test_one', d.processorId);
      expect(res.body.submitted).toMatchObject({ count: 1, by_name: expect.stringContaining('responder'), files: [{ field: 'receipt', file_name: 'invoice.pdf' }] });
      expect(res.body.can_edit).toBe(false);

      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row).toMatchObject({ evidence_submission_count: 1, evidence_submitted_by: me.id });
      expect(row.evidence_submitted_at).not.toBeNull();
      expect(row.evidence_submitted_by_name).toContain('responder');
      expect((await db.disputeEvidenceItem.findMany({ where: { dispute_id: d.id } })).every((i) => i.submitted_at !== null)).toBe(true);

      const audit = await db.auditLog.findMany({ where: { org_id: org, action: 'dispute.evidence_submitted' } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0].metadata)).not.toMatch(/We did the work|invoice\.pdf|stripe|du_|dp_/);
      expect(audit[0].metadata).toMatchObject({ files: ['receipt'], pages: 2 });
      const timeline = await db.timelineEvent.findMany({ where: { organization_id: org, entity_type: 'INVOICE', entity_id: d.invoiceId, event_type: 'DISPUTE_EVIDENCE_SUBMITTED' } });
      expect(timeline).toHaveLength(1);
      expect(timeline[0].description).toContain('Dispute evidence submitted');
      expect(timeline[0].created_by).toBe(me.id);
      expect(JSON.stringify([res.body, timeline[0]])).not.toMatch(PROCESSOR_LOOK);
    });

    it('makes one processor call for a second submit, and for two at the same moment', async () => {
      const { api, d, version } = await staged();
      const [one, two] = await Promise.all([send(api, d.id, { version }), send(api, d.id, { version })]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(submit).toHaveBeenCalledTimes(1);
      const again = await send(api, d.id, { version });
      expect(again.status).toBe(200);
      expect(again.body.submitted.count).toBe(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await db.dispute.findUniqueOrThrow({ where: { id: d.id } })).evidence_submission_count).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'dispute.evidence_submitted', resource_id: d.id } })).toBe(1);
    });

    it('refuses to submit before the evidence is saved, and a stale version', async () => {
      const { api, d, file } = await setup();
      const a = await file(await pdf(1));
      stage.mockRejectedValueOnce(new Error('boom'));
      await put(api, d.id, { version: 0, files: { receipt: a }, text: {} });
      const unsaved = await send(api, d.id, { version: 1 });
      expect(unsaved.status).toBe(409);
      expect(unsaved.body.error).toBe('Save the evidence before you submit it');
      const stale = await send(api, d.id, { version: 0 });
      expect(stale.status).toBe(409);
      expect(submit).not.toHaveBeenCalled();
    });

    it('refuses an empty set, a past-due dispute and a bank return', async () => {
      const empty = await setup();
      // nothing typed and nothing attached: stage an explanation, then clear it
      await put(empty.api, empty.d.id, { version: 0, files: {}, text: { uncategorized_text: 'x', customer_name: '', customer_email_address: '' } });
      await put(empty.api, empty.d.id, { version: 1, files: {}, text: { uncategorized_text: '' } });
      const none = await send(empty.api, empty.d.id, { version: 2 });
      expect(none.status).toBe(409);
      expect(none.body.error).toBe('Add at least one file or write an explanation before you submit.');

      const late = await staged();
      await db.dispute.update({ where: { id: late.d.id }, data: { evidence_due_by: new Date(Date.now() - 1000) } });
      expect((await send(late.api, late.d.id, { version: late.version })).body.error).toBe('The deadline has passed');

      const bank = await staged();
      await db.dispute.update({ where: { id: bank.d.id }, data: { is_bank_return: true } });
      expect((await send(bank.api, bank.d.id, { version: bank.version })).body.error).toBe('A returned bank payment takes no evidence.');
      expect(submit).not.toHaveBeenCalled();
    });

    it('leaves the dispute open to a retry when the processor refuses the submit', async () => {
      const { api, d, version } = await staged();
      submit.mockRejectedValueOnce(Object.assign(new Error('odd failure du_123'), { type: 'StripeInvalidRequestError', statusCode: 400 }));
      const failed = await send(api, d.id, { version });
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("We couldn't send this to the card network. Try again in a moment, or contact ServWave support.");
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_submission_count).toBe(0);
      expect(row.evidence_submitted_at).toBeNull();
      expect((await send(api, d.id, { version })).status).toBe(200);
      expect(submit).toHaveBeenCalledTimes(2);
    });

    const timeout = () => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });

    it('on a timeout, keeps the stamps when the processor shows the evidence was submitted', async () => {
      const { api, d, version } = await staged();
      submit.mockRejectedValueOnce(timeout());
      submissionCount.mockResolvedValueOnce(1);
      const res = await send(api, d.id, { version });
      expect(res.status).toBe(200);
      expect(res.body.submitted.count).toBe(1);
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_submission_count).toBe(1);
      expect(row.evidence_submitted_at).not.toBeNull();
    });

    it('on a timeout, rolls the claim back when the processor shows nothing was submitted', async () => {
      const { api, d, version } = await staged();
      submit.mockRejectedValueOnce(timeout());
      submissionCount.mockResolvedValueOnce(0);
      const res = await send(api, d.id, { version });
      expect(res.status).toBe(502);
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_submission_count).toBe(0);
      expect(row.evidence_submitted_at).toBeNull();
    });

    it('on a timeout with an unreadable processor, keeps the claim and says the state is being checked', async () => {
      const { api, d, version } = await staged();
      submit.mockRejectedValueOnce(timeout());
      submissionCount.mockRejectedValueOnce(timeout());
      const res = await send(api, d.id, { version });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/being checked/i);
      const row = await db.dispute.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.evidence_submission_count).toBe(1);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('treats the processor saying "already submitted" as success when its own count agrees', async () => {
      const { api, d, version } = await staged();
      submit.mockRejectedValueOnce(Object.assign(new Error('This dispute has already been submitted'), { code: 'dispute_already_submitted' }));
      submissionCount.mockResolvedValueOnce(1);
      const res = await send(api, d.id, { version });
      expect(res.status).toBe(200);
      expect(res.body.submitted.count).toBe(1);
      expect((await db.dispute.findUniqueOrThrow({ where: { id: d.id } })).evidence_submission_count).toBe(1);
    });

    it('takes no edit after the submit', async () => {
      const { api, d, version } = await staged();
      await send(api, d.id, { version });
      stage.mockClear();
      const res = await put(api, d.id, { version, files: {}, text: { uncategorized_text: 'more' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Evidence was already submitted');
      expect(stage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('deleting a file that is attached to a dispute', () => {
    it('answers 409 for an attached file, deletes an unattached one as before, and still allows a rename', async () => {
      const { org, customer, admin } = await newOrg();
      const d = await addDispute(org, customer);
      const api = await fx.signedInAs(admin);
      const attachedId = await addFile(org, admin.id, d.invoiceId, await pdf(1), { name: 'attached.pdf' });
      const freeId = await addFile(org, admin.id, d.invoiceId, await pdf(1), { name: 'free.pdf' });
      const mine = await (await responder(org)).api();
      expect((await put(mine, d.id, { version: 0, files: { receipt: attachedId }, text: {} })).status).toBe(200);

      const refused = await api.delete(`/api/attachments/INVOICE/${d.invoiceId}/${attachedId}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('This file is attached to a dispute. Remove it from the dispute first.');
      expect(await db.attachment.count({ where: { id: attachedId } })).toBe(1);

      const renamed = await api.patch(`/api/attachments/INVOICE/${d.invoiceId}/${attachedId}`, { display_name: 'Renamed receipt' });
      expect(renamed.status).toBe(200);
      expect((await get(mine, d.id)).body.form.files.receipt.file_name).toBe('attached.pdf');

      const freed = await api.delete(`/api/attachments/INVOICE/${d.invoiceId}/${freeId}`);
      expect(freed.status).toBe(200);
      expect(await db.attachment.count({ where: { id: freeId } })).toBe(0);

      // removed from the dispute, it can go
      expect((await put(mine, d.id, { version: 1, files: { receipt: null }, text: {} })).status).toBe(200);
      expect((await api.delete(`/api/attachments/INVOICE/${d.invoiceId}/${attachedId}`)).status).toBe(200);
    });
  });
});
