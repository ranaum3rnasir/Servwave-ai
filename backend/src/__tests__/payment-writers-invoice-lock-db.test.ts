/* =============================================================================
   Payments go-live, slice 18 - every door that writes money onto an invoice takes the invoice
   row lock and decides on what it reads UNDER that lock.

   Slices 05 and 17 fenced the main doors (record payment, the card checkout, refund, void,
   void payment, the job cancel). The rest still decided on figures read before any lock, so a
   door running at the same moment could be written over:
     - the estimate's record-deposit door could mark a VOIDED deposit invoice paid;
     - drawing a deposit's credit onto a new invoice (copy-to-invoice, invoice from a job) could
       draw credit that a refund was taking back at that moment;
     - a credit could put back a balance that a payment had just cleared;
     - voiding a deposit payment could reopen a target invoice's balance over a payment that had
       just landed on it;
     - two hand refunds could together give back more than was paid.

   Each test holds the invoice lock in a second transaction the way the other door does (lock,
   write), starts the door under test through its real route, proves the door waits on that
   lock, then commits. What the door does next is what this suite checks. Real, migrated
   database (TEST_DATABASE_URL): the race is Postgres row locking, which no mock reproduces.
   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

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

const suite = realClient ? describe : describe.skip;

suite('payment writers decide under the invoice lock (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // A 127.0.0.1 listener, so a request can only reach this app (see loopback-app.ts).
  let app: Server;
  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  async function fixture() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay18-lock-${tag}`, email: `pay18-lock-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CARD', 'CASH', 'CHECK'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer pay18-lock-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    let n = 0;
    const invoice = async (data: { total: number; due?: number; status: 'SENT' | 'PARTIAL' | 'PAID'; kind?: 'STANDARD' | 'DEPOSIT'; estimate?: string; job?: string }) => {
      const id = randomUUID();
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}-${++n}`, status: data.status,
          kind: data.kind ?? 'STANDARD', estimate_id: data.estimate ?? null, job_id: data.job ?? null,
          subtotal: data.total, tax_amount: 0, total_amount: data.total, amount_due: data.due ?? data.total,
          paid_at: data.status === 'PAID' ? new Date() : null,
        },
      });
      return id;
    };
    const cash = async (invoiceId: string, amount: number, extra: { reference_number?: string } = {}) =>
      (await db.payment.create({ data: { invoice_id: invoiceId, amount, method: 'CASH', paid_at: new Date(), ...extra } })).id;
    const estimate = async (total: number, status: 'DRAFT' | 'SENT' | 'WON' = 'SENT') => {
      const id = randomUUID();
      await db.estimate.create({
        data: {
          id, organization_id: org, customer_id: customer, estimate_number: `E-${tag}-${++n}`, status,
          subtotal: total, tax_amount: 0, total_amount: total, created_by: user,
          line_items: { create: [{ sequence: 1, description: 'Install', quantity: 1, unit_price: total, line_total: total }] },
        },
      });
      return id;
    };
    const readInvoice = async (id: string) => {
      const row = await db.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, amount_due: true, deposit_credit: true, total_refunded: true } });
      return { status: row.status, amountDue: Number(row.amount_due), depositCredit: Number(row.deposit_credit), totalRefunded: Number(row.total_refunded) };
    };
    return { org, user, customer, tag, api, invoice, cash, estimate, readInvoice };
  }

  /**
   * Holds the invoice row lock in a second transaction (the way another money door does: lock,
   * write), starts `door`, proves the door is waiting on that lock, then commits.
   */
  async function whileAnotherDoorHoldsTheInvoice<T>(invoiceId: string, sql: string[], door: () => PromiseLike<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${invoiceId}' FOR UPDATE`);
      for (const statement of sql) await tx.$executeRawUnsafe(statement);
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the other door never held the lock'); })]);
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM credits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM job_line_items WHERE organization_id = '${org}'`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'estimate_versions', 'estimates', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      for (const table of ['number_sequences', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('a deposit recorded on an estimate while its deposit invoice is being voided is refused and books nothing', async () => {
    const f = await fixture();
    const est = await f.estimate(500);
    const deposit = await f.invoice({ total: 100, status: 'SENT', kind: 'DEPOSIT', estimate: est });

    const res = await whileAnotherDoorHoldsTheInvoice(deposit, [
      `UPDATE invoices SET status = 'VOIDED', voided_at = now(), voided_reason = 'Sent in error' WHERE id = '${deposit}'`,
    ], () => f.api.post(`/api/estimates/${est}/record-payment`, { amount: 100, payment_method: 'CASH' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deposit invoice/i);
    expect(await f.readInvoice(deposit)).toMatchObject({ status: 'VOIDED' });
    expect(await db.payment.count({ where: { invoice_id: deposit } })).toBe(0);
    expect((await db.estimate.findUniqueOrThrow({ where: { id: est } })).status).toBe('SENT');
  });

  // The refund door's shape: lock, record the refund, move the totals.
  const refundTheInvoice = (f: { org: string; user: string }, invoiceId: string, amount: number, status = 'REFUNDED') => [
    `INSERT INTO refunds (id, invoice_id, organization_id, amount, tax_portion, method, reason, reason_category, state, refunded_by)
       VALUES ('${randomUUID()}', '${invoiceId}', '${f.org}', ${amount}, 0, 'CASH', 'customer changed plans', 'CUSTOMER_REQUEST', 'SUCCEEDED', '${f.user}')`,
    `UPDATE invoices SET status = '${status}', total_refunded = total_refunded + ${amount}, net_collected = net_collected - ${amount} WHERE id = '${invoiceId}'`,
  ];

  it('copying an estimate to an invoice while its deposit is being refunded draws no credit from the refunded deposit', async () => {
    const f = await fixture();
    const est = await f.estimate(500, 'WON');
    const deposit = await f.invoice({ total: 100, due: 0, status: 'PAID', kind: 'DEPOSIT', estimate: est });
    await f.cash(deposit, 100);

    const res = await whileAnotherDoorHoldsTheInvoice(deposit, refundTheInvoice(f, deposit, 100),
      () => f.api.post(`/api/estimates/${est}/copy-to-invoice`, {}));

    expect(res.status).toBe(201);
    expect(await f.readInvoice(res.body.invoice.id)).toMatchObject({ depositCredit: 0, amountDue: 500 });
    expect(await db.depositCreditApplication.count({ where: { deposit_invoice_id: deposit } })).toBe(0);
  });

  it('invoicing a job while its estimate\'s deposit is being refunded draws no credit from the refunded deposit', async () => {
    const f = await fixture();
    const est = await f.estimate(500, 'WON');
    const deposit = await f.invoice({ total: 100, due: 0, status: 'PAID', kind: 'DEPOSIT', estimate: est });
    await f.cash(deposit, 100);
    const location = await db.serviceLocation.create({
      data: { customer_id: f.customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const job = randomUUID();
    await db.job.create({
      data: {
        id: job, organization_id: f.org, customer_id: f.customer, service_location_id: location.id, estimate_id: est,
        job_number: `J-${f.tag}`, status: 'COMPLETED',
        job_line_items: { create: [{ organization_id: f.org, sequence: 1, description: 'Install', quantity: 1, unit_price: 500, line_total: 500 }] },
      },
    });

    const res = await whileAnotherDoorHoldsTheInvoice(deposit, refundTheInvoice(f, deposit, 100),
      () => f.api.post(`/api/jobs/${job}/invoices`, { percent: 100 }));

    expect(res.status).toBe(201);
    const created = await db.invoice.findFirstOrThrow({ where: { job_id: job, kind: 'STANDARD' }, select: { id: true } });
    expect(await f.readInvoice(created.id)).toMatchObject({ depositCredit: 0, amountDue: 500 });
    expect(await db.depositCreditApplication.count({ where: { deposit_invoice_id: deposit } })).toBe(0);
  });

  it('a credit applied while a payment clears the invoice is refused: the balance the payment cleared is not put back', async () => {
    const f = await fixture();
    const inv = await f.invoice({ total: 150, status: 'SENT' });

    const res = await whileAnotherDoorHoldsTheInvoice(inv, [
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ('${randomUUID()}', '${inv}', 150, 'CASH', now(), 'SUCCEEDED')`,
      `UPDATE invoices SET amount_due = 0, status = 'PAID', paid_at = now() WHERE id = '${inv}'`,
    ], () => f.api.post(`/api/invoices/${inv}/credit`, { amount: 50, reason: 'goodwill' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed/i);
    expect(await f.readInvoice(inv)).toMatchObject({ status: 'PAID', amountDue: 0 });
    expect(await db.credit.count({ where: { invoice_id: inv } })).toBe(0);
  });

  it('voiding a deposit payment while a payment lands on the target invoice reopens only the credit, on the balance as it now stands', async () => {
    const f = await fixture();
    const est = await f.estimate(150, 'WON');
    const deposit = await f.invoice({ total: 50, due: 0, status: 'PAID', kind: 'DEPOSIT', estimate: est });
    const depositCash = await f.cash(deposit, 50);
    const target = await f.invoice({ total: 150, due: 100, status: 'PARTIAL', estimate: est });
    await db.depositCreditApplication.create({ data: { deposit_invoice_id: deposit, target_invoice_id: target, amount: 50, organization_id: f.org } });
    await f.cash(target, 50, { reference_number: 'DEPOSIT-CREDIT' });

    // The customer pays the $100 still owed on the target while staff void the deposit's cash.
    const res = await whileAnotherDoorHoldsTheInvoice(target, [
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ('${randomUUID()}', '${target}', 100, 'CHECK', now(), 'SUCCEEDED')`,
      `UPDATE invoices SET amount_due = 0, status = 'PAID', paid_at = now() WHERE id = '${target}'`,
    ], () => f.api.post(`/api/invoices/${deposit}/void-payment`, { payment_id: depositCash, void_category: 'BOUNCED', reason: 'check bounced' }));

    expect(res.status).toBe(200);
    // $100 of $150 was paid in money; the $50 deposit credit is gone, so $50 is owed - not the
    // $150 a balance read before the payment landed would reopen.
    expect(await f.readInvoice(target)).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
  });

  it('two hand refunds at the same moment cannot together give back more than was paid', async () => {
    const f = await fixture();
    const inv = await f.invoice({ total: 100, due: 0, status: 'PAID' });
    await f.cash(inv, 100);

    // Another hand refund of $60 is being recorded while staff refund $60 more.
    const res = await whileAnotherDoorHoldsTheInvoice(inv, refundTheInvoice(f, inv, 60, 'PARTIALLY_REFUNDED'),
      () => f.api.post(`/api/invoices/${inv}/refund`, { amount: 60, method: 'CASH', reason_category: 'CUSTOMER_REQUEST', reason: 'second refund' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Refund exceeds net paid');
    expect(await db.refund.count({ where: { invoice_id: inv } })).toBe(1);
    expect(await f.readInvoice(inv)).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 60 });
  });
});

