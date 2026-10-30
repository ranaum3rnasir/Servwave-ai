/* =============================================================================
   Payments go-live, slice 18 - voiding an invoice that carries payments is refused.

   A VOIDED invoice is never restored, so the void door may only take an invoice whose
   payments are all voided. Any live SUCCEEDED or PROCESSING payment (money taken, or a bank
   debit on its way) answers 409 with the reason, whatever the invoice's status says - PAID,
   PARTIAL, PARTIALLY_REFUNDED and REFUNDED alike: a refund gives the money back, it does not
   un-take it. The synthetic DEPOSIT-CREDIT row is not money taken on this invoice (its cash
   sits on the deposit invoice); the void releases it, as before.

   Voiding a payment-free invoice also expires the checkout links still open for it (and a
   job cancel that voids invoices does the same), so a customer cannot pay a voided bill
   through an old link.

   Driven through the real routes against a real, migrated database (TEST_DATABASE_URL): the
   rule is a WHERE clause and a row lock, which a mocked client cannot check. Only the
   processor SDK is replaced, by a recorder. Skips when TEST_DATABASE_URL is unset, like every
   other *-db suite. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient, sessionsList, sessionsExpire } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return {
    realClient: dbUrl ? clientAt(dbUrl) : undefined,
    sessionsList: vi.fn(),
    sessionsExpire: vi.fn(),
  };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The real checkout-expiry code runs; only the processor SDK underneath it records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = { sessions: { list: sessionsList, expire: sessionsExpire, create: vi.fn() } };
  },
}));

import { supabaseAdmin } from '../lib/supabase';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const HAS_PAYMENTS = 'This invoice has payments. Void or refund them first.';

suite('voiding an invoice that carries payments (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // A 127.0.0.1 listener, so a request can only reach this app (see loopback-app.ts).
  let app: Server;
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_pay18_void_db';
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });
  beforeEach(() => {
    sessionsList.mockReset().mockResolvedValue({ data: [], has_more: false });
    sessionsExpire.mockReset().mockResolvedValue({});
  });

  async function fixture(opts: { total: number }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay18-${tag}`, email: `pay18-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CARD', 'CASH', 'CHECK'],
        stripe_account_id: `acct_pay18_${tag}`,
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'SENT',
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total, amount_due: opts.total,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer pay18-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    const voidIt = () => api.post(`/api/invoices/${invoice}/void`, { voided_reason: 'Sent in error' });
    const readInvoice = async () => {
      const res = await api.get(`/api/invoices/${invoice}`);
      expect(res.status).toBe(200);
      return { status: res.body.invoice.status as string, amountDue: Number(res.body.invoice.amount_due) };
    };
    return { org, user, customer, invoice, api, voidIt, readInvoice };
  }

  /**
   * Holds the invoice row lock in a second transaction (the way a payment door does: lock, book the
   * money), starts `door`, proves the door is waiting on that lock, then commits. What the door
   * answers is what it decides once the money has landed.
   */
  async function whileAPaymentHoldsTheInvoice<T>(invoiceId: string, paymentSql: string[], door: () => PromiseLike<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${invoiceId}' FOR UPDATE`);
      for (const sql of paymentSql) await tx.$executeRawUnsafe(sql);
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the payment never held the lock'); })]);
    const result = Promise.resolve(door());
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the door never waited on the invoice lock').toBe(true);
    } finally {
      release();
      await holder;
    }
    return result;
  }

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      // Children first; the invoice is held by Restrict foreign keys from payments and refunds.
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['deposit_credit_applications', 'timeline_events', 'notifications', 'audit_logs', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('a PARTIAL invoice with a SUCCEEDED cash payment is refused with the reason and left as it was', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 50, method: 'CASH' })).status).toBe(201);

    const res = await f.voidIt();

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: HAS_PAYMENTS, code: 'INVOICE_HAS_PAYMENTS' });
    expect(await f.readInvoice()).toEqual({ status: 'PARTIAL', amountDue: 100 });
  });

  it('a SENT invoice with a bank payment still PROCESSING is refused: the money is on its way', async () => {
    const f = await fixture({ total: 150 });
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 150, method: 'ACH', paid_at: new Date(), state: 'PROCESSING', created_by_source: 'CLIENT' },
    });

    const res = await f.voidIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HAS_PAYMENTS);
    expect(await f.readInvoice()).toEqual({ status: 'SENT', amountDue: 150 });
  });

  it('a PAID invoice is refused with the same reason', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 150, method: 'CHECK' })).status).toBe(201);

    const res = await f.voidIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HAS_PAYMENTS);
    expect(await f.readInvoice()).toEqual({ status: 'PAID', amountDue: 0 });
  });

  it('a refund does not make the invoice voidable: PARTIALLY_REFUNDED and REFUNDED invoices are refused', async () => {
    for (const refund of [40, 150]) {
      const f = await fixture({ total: 150 });
      expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 150, method: 'CASH' })).status).toBe(201);
      const refunded = await f.api.post(`/api/invoices/${f.invoice}/refund`, {
        amount: refund, method: 'CASH', reason_category: 'CUSTOMER_REQUEST', reason: 'slice 18 test',
      });
      expect(refunded.status).toBe(200);
      const before = await f.readInvoice();
      expect(before.status).toBe(refund === 150 ? 'REFUNDED' : 'PARTIALLY_REFUNDED');

      const res = await f.voidIt();

      // Slice 29: a REFUNDED invoice is final; a partly refunded one still holds money.
      expect(res.status).toBe(refund === 150 ? 400 : 409);
      expect(res.body.error).toBe(refund === 150 ? 'A refunded invoice is final and cannot be voided.' : HAS_PAYMENTS);
      expect(await f.readInvoice()).toEqual(before);
    }
  });

  it('an invoice whose only payments are voided is payment-free: it is voided and its checkout links expire', async () => {
    const f = await fixture({ total: 150 });
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_voided_only', metadata: { invoiceId: f.invoice } }], has_more: false });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 50, method: 'CASH' })).status).toBe(201);
    const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice }, select: { id: true } });
    const voidedPayment = await f.api.post(`/api/invoices/${f.invoice}/void-payment`, {
      payment_id: payment.id, void_category: 'ERROR', reason: 'entered on the wrong invoice',
    });
    expect(voidedPayment.status).toBe(200);
    // Slice 14: recording the payment and voiding it each swept the link already; only the
    // invoice void's sweep is under test.
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalledTimes(2));
    sessionsExpire.mockClear();
    // A failed bank debit was never money either.
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 150, method: 'ACH', paid_at: new Date(), state: 'FAILED', created_by_source: 'CLIENT' },
    });

    const res = await f.voidIt();

    expect(res.status).toBe(200);
    expect((await f.readInvoice()).status).toBe('VOIDED');
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalled());
    expect(sessionsExpire.mock.calls.map((call) => call[0])).toEqual(['cs_pay18_voided_only']);
  });

  it('a deposit credit drawn onto the invoice is not money taken on it: the void goes through, releases the credit and expires the links', async () => {
    const f = await fixture({ total: 150 });
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_deposit_credit', metadata: { invoiceId: f.invoice } }], has_more: false });
    const deposit = randomUUID();
    await db.invoice.create({
      data: {
        id: deposit, organization_id: f.org, customer_id: f.customer, invoice_number: `DEP-${f.org.slice(0, 8)}`, kind: 'DEPOSIT',
        status: 'PAID', subtotal: 50, tax_amount: 0, total_amount: 50, amount_due: 0,
      },
    });
    await db.payment.create({ data: { invoice_id: deposit, amount: 50, method: 'CASH', paid_at: new Date() } });
    await db.depositCreditApplication.create({
      data: { deposit_invoice_id: deposit, target_invoice_id: f.invoice, amount: 50, organization_id: f.org },
    });
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 50, method: 'CARD', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT' },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { deposit_credit: 50, amount_due: 100 } });

    const res = await f.voidIt();

    expect(res.status).toBe(200);
    expect((await f.readInvoice()).status).toBe('VOIDED');
    const application = await db.depositCreditApplication.findFirstOrThrow({ where: { target_invoice_id: f.invoice } });
    expect(application.reversed_at).not.toBeNull();
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalled());
    expect(sessionsExpire.mock.calls.map((call) => call[0])).toEqual(['cs_pay18_deposit_credit']);
  });

  it('a payment that lands while the void waits on the invoice wins: the void is refused and the money stays on a PARTIAL invoice', async () => {
    const f = await fixture({ total: 150 });

    const res = await whileAPaymentHoldsTheInvoice(f.invoice, [
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ('${randomUUID()}', '${f.invoice}', 50, 'CASH', now(), 'SUCCEEDED')`,
      `UPDATE invoices SET amount_due = 100, status = 'PARTIAL' WHERE id = '${f.invoice}'`,
    ], () => f.voidIt());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HAS_PAYMENTS);
    expect(await f.readInvoice()).toEqual({ status: 'PARTIAL', amountDue: 100 });
  });

  it('a payment that pays the invoice in full while the void waits is refused with the same reason, not a generic one', async () => {
    const f = await fixture({ total: 150 });

    const res = await whileAPaymentHoldsTheInvoice(f.invoice, [
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ('${randomUUID()}', '${f.invoice}', 150, 'CHECK', now(), 'SUCCEEDED')`,
      `UPDATE invoices SET amount_due = 0, status = 'PAID', paid_at = now() WHERE id = '${f.invoice}'`,
    ], () => f.voidIt());

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: HAS_PAYMENTS, code: 'INVOICE_HAS_PAYMENTS' });
    expect(await f.readInvoice()).toEqual({ status: 'PAID', amountDue: 0 });
  });

  it('voiding a payment-free invoice expires its open checkout links, and no other invoice\'s', async () => {
    const f = await fixture({ total: 150 });
    const other = randomUUID();
    sessionsList.mockResolvedValue({
      data: [
        { id: 'cs_pay18_this', metadata: { invoiceId: f.invoice } },
        { id: 'cs_pay18_other', metadata: { invoiceId: other } },
      ],
      has_more: false,
    });

    const res = await f.voidIt();

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalled());
    expect(sessionsExpire.mock.calls).toEqual([
      ['cs_pay18_this', undefined, { stripeAccount: `acct_pay18_${f.org.slice(0, 8)}` }],
    ]);
  });

  it('a checkout link the processor refuses to expire never blocks the void', async () => {
    const f = await fixture({ total: 150 });
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_stuck', metadata: { invoiceId: f.invoice } }], has_more: false });
    sessionsExpire.mockRejectedValue(new Error('processor unavailable'));

    const res = await f.voidIt();

    expect(res.status).toBe(200);
    expect((await f.readInvoice()).status).toBe('VOIDED');
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalledTimes(1));
  });

  it('a refused void expires nothing: the invoice can still be paid', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 50, method: 'CASH' })).status).toBe(201);
    // The payment closes the invoice's other open links on its own, after its answer (and the billing alert no longer holds that answer
    // back, S06.28): let that finish before a live link exists, so only the refused void is under test.
    await new Promise((resolve) => setTimeout(resolve, 300));
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_live', metadata: { invoiceId: f.invoice } }], has_more: false });

    expect((await f.voidIt()).status).toBe(409);
    expect(sessionsExpire).not.toHaveBeenCalled();
  });

  it('a job cancel that voids the job\'s open invoice expires that invoice\'s checkout links too', async () => {
    const f = await fixture({ total: 150 });
    const tag = f.org.slice(0, 8);
    const location = await db.serviceLocation.create({
      data: { customer_id: f.customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const job = randomUUID();
    await db.job.create({
      data: {
        id: job, organization_id: f.org, customer_id: f.customer, service_location_id: location.id,
        job_number: `J-${tag}`, status: 'SCHEDULED', amount_invoiced: 150,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { job_id: job } });
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_job', metadata: { invoiceId: f.invoice } }], has_more: false });

    const res = await f.api.post(`/api/jobs/${job}/cancel`, { cancel_reason_code: 'OTHER', cancelled_reason: 'Customer changed plans' });

    expect(res.status).toBe(200);
    expect(res.body.voided_invoice_ids).toEqual([f.invoice]);
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalled());
    expect(sessionsExpire.mock.calls).toEqual([['cs_pay18_job', undefined, { stripeAccount: `acct_pay18_${tag}` }]]);
  });

  // W4: a DRAFT with a public link is payable. A job cancel leaves a DRAFT alone (it is deleted,
  // not voided), so its link would stay live for a cancelled job unless the cancel closes it.
  it('a job cancel closes the payment link of the job\'s DRAFT invoice: its checkout is expired and the link is retired', async () => {
    const f = await fixture({ total: 150 });
    const tag = f.org.slice(0, 8);
    const location = await db.serviceLocation.create({
      data: { customer_id: f.customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const job = randomUUID();
    await db.job.create({
      data: {
        id: job, organization_id: f.org, customer_id: f.customer, service_location_id: location.id,
        job_number: `J-${tag}`, status: 'SCHEDULED', amount_invoiced: 150,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { job_id: job, status: 'DRAFT', public_token: randomUUID() } });
    sessionsList.mockResolvedValue({ data: [{ id: 'cs_pay18_draft', metadata: { invoiceId: f.invoice } }], has_more: false });

    const res = await f.api.post(`/api/jobs/${job}/cancel`, { cancel_reason_code: 'OTHER', cancelled_reason: 'Customer changed plans' });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sessionsExpire).toHaveBeenCalled());
    expect(sessionsExpire.mock.calls).toEqual([['cs_pay18_draft', undefined, { stripeAccount: `acct_pay18_${tag}` }]]);
    const row = await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } });
    expect([row.status, row.public_token]).toEqual(['DRAFT', null]);
  });
});

