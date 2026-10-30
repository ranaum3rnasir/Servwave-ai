/* =============================================================================
   Payments go-live, slice 28 - the invoice APIs carry how each payment was made, the bank money
   still clearing, and (for the customer's page) the refunds.

   Staff:    GET /api/invoices/:id   payments[] carry wallet, card brand/last four, bank name/last
                                     four; refunds[] name who made them; processing_amount is the
                                     bank money still clearing.
             GET /api/invoices       every row carries processing_amount, so a list can badge it.
   Customer: GET /api/invoices/:id/public   payments carry the same display details and their
                                     state; refunds[] lists what was given back or is on its way.

   Driven through the real routes against a real migrated database (TEST_DATABASE_URL): which rows
   count as "processing" is a where-clause a mocked client cannot check. Skips when
   TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is removed.
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

type Row = {
  amount: number;
  method: 'CARD' | 'ACH' | 'CASH';
  state?: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  voided?: boolean;
  wallet?: 'APPLE_PAY' | 'GOOGLE_PAY' | 'LINK';
  card_brand?: string;
  card_last4?: string;
  bank_name?: string;
  bank_last4?: string;
};

suite('invoice payment display fields (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  }, 90_000);

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices']) {
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

  async function fixture(rows: Row[]) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay28-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay28-${tag}`, email: `pay28-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CASH', 'CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Rita', last_name: 'Refunder', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'PARTIAL',
        subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 500, public_token: token,
      },
    });
    const payments: string[] = [];
    for (const r of rows) {
      const p = await db.payment.create({
        data: {
          invoice_id: invoice, amount: r.amount, method: r.method, paid_at: new Date(), state: r.state ?? 'SUCCEEDED',
          created_by_source: 'CLIENT', wallet: r.wallet, card_brand: r.card_brand, card_last4: r.card_last4,
          bank_name: r.bank_name, bank_last4: r.bank_last4,
          ...(r.voided ? { voided_at: new Date(), voided_reason: 'test' } : {}),
        },
      });
      payments.push(p.id);
    }
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay28-${tag}`;
    const get = (path: string) => request(app).get(path).set('Authorization', bearer);
    return { org, user, invoice, token, payments, get, publicView: () => request(app).get(`/api/invoices/${invoice}/public?token=${token}`) };
  }

  const MIXED: Row[] = [
    { amount: 100, method: 'CARD', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' },
    { amount: 50, method: 'ACH', state: 'SUCCEEDED', bank_name: 'Bank of Example', bank_last4: '6789' },
    { amount: 60, method: 'ACH', state: 'PROCESSING', bank_name: 'Bank of Example', bank_last4: '6789' },
    { amount: 25, method: 'ACH', state: 'PROCESSING', voided: true },
    { amount: 9, method: 'ACH', state: 'FAILED' },
  ];

  it('the staff detail carries how each payment was made and the bank money still clearing', async () => {
    const f = await fixture(MIXED);

    const res = await f.get(`/api/invoices/${f.invoice}`);

    expect(res.status).toBe(200);
    const byAmount = (n: number) => res.body.invoice.payments.find((p: { amount: string }) => Number(p.amount) === n);
    expect(byAmount(100)).toMatchObject({ wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' });
    expect(byAmount(50)).toMatchObject({ bank_name: 'Bank of Example', bank_last4: '6789' });
    // Only the live PROCESSING payment: not the voided one, not the failed one, not what cleared.
    expect(res.body.invoice.processing_amount).toBe(60);
  });

  it("the processor sandbox's bank name never reaches the staff detail or the customer's page", async () => {
    const f = await fixture([{ amount: 35, method: 'ACH', state: 'SUCCEEDED', bank_name: 'STRIPE TEST BANK', bank_last4: '1116' }]);

    const staff = await f.get(`/api/invoices/${f.invoice}`);
    const customer = await f.publicView();

    expect(staff.body.invoice.payments[0]).toMatchObject({ bank_name: null, bank_last4: '1116' });
    expect(JSON.stringify(staff.body)).not.toMatch(/stripe test bank/i);
    expect(customer.body.invoice.payments[0]).toMatchObject({ bank_name: null, bank_last4: '1116' });
    expect(JSON.stringify(customer.body)).not.toMatch(/stripe test bank/i);
  });

  it('a refund on the staff detail names the person who made it', async () => {
    const f = await fixture([{ amount: 100, method: 'CARD' }]);
    await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payments[0], organization_id: f.org, amount: 10, method: 'CARD',
        reason_category: 'CUSTOMER_REQUEST', refunded_by: f.user,
      },
    });

    const res = await f.get(`/api/invoices/${f.invoice}`);

    expect(res.body.invoice.refunds[0].refunded_by_user).toEqual({ id: f.user, first_name: 'Rita', last_name: 'Refunder' });
  });

  it('the invoice list carries processing_amount on each row, and no payment rows', async () => {
    const f = await fixture(MIXED);

    const res = await f.get('/api/invoices');

    expect(res.status).toBe(200);
    const row = res.body.invoices.find((i: { id: string }) => i.id === f.invoice);
    expect(row.processing_amount).toBe(60);
    expect(row).not.toHaveProperty('processing_payments');
  });

  it('an invoice with nothing clearing reports a processing_amount of 0', async () => {
    const f = await fixture([{ amount: 100, method: 'CASH' }]);

    const res = await f.get('/api/invoices');

    expect(res.body.invoices.find((i: { id: string }) => i.id === f.invoice).processing_amount).toBe(0);
  });

  it("the customer's page gets each payment's display details and state, never a voided one", async () => {
    const f = await fixture(MIXED);

    const res = await f.publicView();

    expect(res.status).toBe(200);
    const payments = res.body.invoice.payments as Array<{ amount: string; state: string; wallet: string | null; card_brand: string | null; bank_name: string | null }>;
    expect(payments).toHaveLength(4);
    expect(payments.find((p) => Number(p.amount) === 100)).toMatchObject({ state: 'SUCCEEDED', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' });
    expect(payments.find((p) => Number(p.amount) === 60)).toMatchObject({ state: 'PROCESSING', bank_name: 'Bank of Example', bank_last4: '6789' });
    expect(payments.find((p) => Number(p.amount) === 9)).toMatchObject({ state: 'FAILED' });
    expect(payments.find((p) => Number(p.amount) === 25)).toBeUndefined();
  });

  it("the customer's page lists refunds that were given back or are on their way, never a failed one or who made it", async () => {
    const f = await fixture([{ amount: 100, method: 'CARD' }]);
    const refund = (amount: number, state: 'SUCCEEDED' | 'PENDING' | 'FAILED') => db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payments[0], organization_id: f.org, amount, method: 'CARD',
        reason_category: 'CUSTOMER_REQUEST', reason: 'internal note', refunded_by: f.user, state,
      },
    });
    await refund(10, 'SUCCEEDED');
    await refund(20, 'PENDING');
    await refund(30, 'FAILED');

    const res = await f.publicView();

    const refunds = res.body.invoice.refunds as Array<Record<string, unknown>>;
    expect(refunds.map((r) => [Number(r.amount), r.state]).sort()).toEqual([[10, 'SUCCEEDED'], [20, 'PENDING']]);
    // The customer sees an amount, a state and a date: not the staff member, the reason or the ids.
    expect(Object.keys(refunds[0]).sort()).toEqual(['amount', 'created_at', 'id', 'state']);
  });
});
