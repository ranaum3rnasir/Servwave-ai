/* =============================================================================
   Payments go-live, slice 28b - follow-ups on the money doors of an invoice.

   - Record Payment (the invoice's own door) works from payable-now: a bank debit still
     PROCESSING on the invoice is not collected a second time by hand.
   - A refund sent back through the processor records the payment's own method, never a hand
     method the dialog happened to carry.
   - The invoice timeline names a hand payment's method in words.
   - A bank payment that clears or fails leaves an audit row.
   - Money sent back from "Payments needing attention" carries a reason that matches why it was
     there, and the invoice's timeline says so.

   Staff calls go through the real routes against a real, migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
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

import { supabaseAdmin } from '../lib/supabase';
import { createRefund } from '../lib/stripe';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

type PaymentSpec = {
  amount: number;
  method: 'CARD' | 'ACH' | 'CASH' | 'CHECK';
  state?: 'SUCCEEDED' | 'PROCESSING';
  online?: boolean;
};

suite('invoice money doors, follow-ups (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 120_000);
  beforeEach(() => {
    processorRefund.mockReset();
    processorRefund.mockResolvedValue({});
  });

  /** An org with an admin, a customer and one invoice carrying the given payments. */
  async function fixture(opts: { total: number; payments?: PaymentSpec[]; status?: 'PAID' | 'PARTIAL' | 'SENT'; kind?: 'DEPOSIT' | 'STANDARD' }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay28b_${tag}`;
    const specs = opts.payments ?? [];
    await db.organization.create({
      data: {
        id: org, name: `pay28b-${tag}`, email: `pay28b-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'], plan: 'SCALE',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const landed = specs.filter((p) => (p.state ?? 'SUCCEEDED') === 'SUCCEEDED').reduce((s, p) => s + p.amount, 0);
    const amountDue = Math.max(opts.total - landed, 0);
    const status = opts.status ?? (amountDue === 0 ? 'PAID' : landed > 0 ? 'PARTIAL' : 'SENT');
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total, amount_due: amountDue, status,
        net_collected: landed, ...(opts.kind ? { kind: opts.kind } : {}), ...(status === 'PAID' ? { paid_at: new Date() } : {}),
      },
    });
    const payments: Array<{ id: string; pi: string | null }> = [];
    for (const [i, p] of specs.entries()) {
      const online = p.online ?? (p.method === 'CARD' || p.method === 'ACH');
      const pi = online ? `pi_pay28b_${tag}_${i}` : null;
      const row = await db.payment.create({
        data: {
          invoice_id: invoice, amount: p.amount, method: p.method, state: p.state ?? 'SUCCEEDED',
          paid_at: new Date(Date.now() - (specs.length - i) * 1000),
          ...(online
            ? { stripe_payment_intent_id: pi, stripe_charge_id: `ch_pay28b_${tag}_${i}`, stripe_account_id: account, created_by_source: 'CLIENT' }
            : {}),
        },
      });
      payments.push({ id: row.id, pi });
    }
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay28b-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    const readInvoice = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const timeline = () => db.timelineEvent.findMany({ where: { entity_type: 'INVOICE', entity_id: invoice }, orderBy: { created_at: 'asc' } });
    const refund = (body: object) =>
      api.post(`/api/invoices/${invoice}/refund`, { reason_category: 'CUSTOMER_REQUEST', reason: 'slice 28b test', ...body });
    const credit = (body: object) => api.post(`/api/invoices/${invoice}/credit`, { reason: 'slice 28b give-back', ...body });
    const refundRows = () => db.refund.findMany({ where: { invoice_id: invoice }, orderBy: { created_at: 'asc' } });
    return { org, tag, user, invoice, account, payments, api, readInvoice, timeline, refund, credit, refundRows };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM credits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['unapplied_captures', 'timeline_events', 'notifications', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  describe('Record Payment while a bank debit is processing', () => {
    it('refuses a hand payment above payable-now, naming the processing amount, and records nothing', async () => {
      const f = await fixture({ total: 500, payments: [{ amount: 500, method: 'ACH', state: 'PROCESSING' }] });

      const res = await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 500, method: 'CASH' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('$500.00');
      expect(res.body.error).toMatch(/processing/i);
      expect((await f.readInvoice()).status).toBe('SENT');
      expect(await db.payment.count({ where: { invoice_id: f.invoice, method: 'CASH' } })).toBe(0);
    });

    it('still takes the part not covered by the processing debit', async () => {
      const f = await fixture({ total: 500, payments: [{ amount: 200, method: 'ACH', state: 'PROCESSING' }] });

      const res = await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 300, method: 'CASH' });

      expect(res.status).toBe(201);
      const invoice = await f.readInvoice();
      // The debit is still in flight, so the $200 it covers is not collected yet.
      expect(invoice.status).toBe('PARTIAL');
      expect(Number(invoice.amount_due)).toBe(200);
    });
  });
  describe('the invoice timeline names a hand payment in words', () => {
    it.each([['CASH', 'Cash'], ['CHECK', 'Check'], ['BANK_TRANSFER', 'Bank transfer']])('%s reads "via %s"', async (method, label) => {
      const f = await fixture({ total: 900 });

      const res = await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 900, method });

      expect(res.status).toBe(201);
      const received = (await f.timeline()).find((e) => e.event_type === 'PAYMENT_RECEIVED');
      expect(received?.description).toBe(`Payment of $900.00 received via ${label}`);
    });
  });
  describe('a refund through the processor records the payment\'s own method', () => {
    it('a card refund sent with a hand method chosen still records CARD', async () => {
      const f = await fixture({ total: 100, payments: [{ amount: 100, method: 'CARD' }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay28b_${f.tag}`, status: 'succeeded' });

      const res = await f.refund({ amount: 40, method: 'CASH' });

      expect(res.status).toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);
      const [row] = await f.refundRows();
      expect(row.method).toBe('CARD');
    });

    it('a record-only refund (hand-paid source) keeps the hand method chosen', async () => {
      const f = await fixture({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });

      const res = await f.refund({ amount: 40, method: 'CHECK' });

      expect(res.status).toBe(200);
      expect(processorRefund).not.toHaveBeenCalled();
      const [row] = await f.refundRows();
      expect(row.method).toBe('CHECK');
    });

    it('the credit door\'s give-back to a card payment records CARD too', async () => {
      const f = await fixture({ total: 100, payments: [{ amount: 100, method: 'CARD' }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay28b_c_${f.tag}`, status: 'succeeded' });

      const res = await f.credit({ amount: 30, method: 'ZELLE' });

      expect(res.status).toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);
      const [row] = await f.refundRows();
      expect(row.method).toBe('CARD');
    });
  });

  describe('the lead page\'s deposit chip knows a bank payment is in flight', () => {
    /** A lead with one estimate whose deposit invoice is the fixture's invoice. */
    async function leadWithDeposit(f: Awaited<ReturnType<typeof fixture>>) {
      const lead = randomUUID();
      const estimate = randomUUID();
      const customer = (await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).customer_id!;
      await db.lead.create({
        data: { id: lead, organization_id: f.org, lead_number: `L-${f.tag}`, customer_id: customer, service_request: 'Deposit by bank', status: 'ESTIMATED' },
      });
      await db.estimate.create({
        data: {
          id: estimate, organization_id: f.org, lead_id: lead, customer_id: customer, created_by: f.user, estimate_number: `E-${f.tag}`,
          status: 'PENDING', subtotal: 1000, tax_amount: 0, total_amount: 1000,
        },
      });
      await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });
      return lead;
    }

    it('carries the processing amount on the estimate\'s deposit, and never the payment rows', async () => {
      const f = await fixture({ total: 500, payments: [{ amount: 500, method: 'ACH', state: 'PROCESSING' }] });
      const lead = await leadWithDeposit(f);

      const res = await f.api.get(`/api/leads/${lead}`);

      expect(res.status).toBe(200);
      const [deposit] = res.body.lead.estimates[0].invoices;
      expect(deposit).toMatchObject({ kind: 'DEPOSIT', processing_amount: 500 });
      expect(deposit.payments).toBeUndefined();
    });

    it('the staff estimate carries each deposit payment\'s state, so the card can show one in flight', async () => {
      const f = await fixture({ total: 500, payments: [{ amount: 200, method: 'ACH', state: 'PROCESSING' }, { amount: 100, method: 'CASH' }] });
      await leadWithDeposit(f);
      const estimate = (await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).estimate_id!;

      const res = await f.api.get(`/api/estimates/${estimate}`);

      expect(res.status).toBe(200);
      const deposit = res.body.estimate.invoices.find((i: { kind: string }) => i.kind === 'DEPOSIT');
      expect(deposit.payments.map((p: { method: string; state: string; voided_at: unknown }) => [p.method, p.state, p.voided_at])
        .sort()).toEqual([['ACH', 'PROCESSING', null], ['CASH', 'SUCCEEDED', null]]);
    });

    it('carries 0 when nothing is processing', async () => {
      const f = await fixture({ total: 500, payments: [{ amount: 200, method: 'CASH' }] });
      const lead = await leadWithDeposit(f);

      const res = await f.api.get(`/api/leads/${lead}`);

      expect(res.body.lead.estimates[0].invoices[0].processing_amount).toBe(0);
    });
  });
});
