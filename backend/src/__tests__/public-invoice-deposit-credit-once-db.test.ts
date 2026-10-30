/* =============================================================================
   Payments go-live slice 33b - the public invoice counts a deposit credit once.

   A covered or part-covered invoice carries its deposit credit as the invoice's own
   `deposit_credit` line AND as a synthetic DEPOSIT-CREDIT payment row. The page prints the first as
   "Deposit credit" and sums the second into "Payments received", so the same credit printed twice
   and the lines did not add up. The customer's payload therefore leaves that row out of the
   payments it lists: total minus deposit credit minus the payments it carries equals Amount Due.

   Through the real public route against a real migrated database (TEST_DATABASE_URL; skips when
   unset). Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';
import { applyDepositCreditsWithPayments, computeDepositCredit } from '../lib/deposit-credit';

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

const suite = realClient ? describe : describe.skip;

suite('public invoice: the deposit credit is printed once (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['deposit_credit_applications', 'timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A sent invoice with a public link, a deposit credit, and the payments a customer would have made. */
  async function invoiceWith(opts: {
    total: number; credit: number; due: number; status: 'PAID' | 'SENT' | 'PARTIAL';
    cashPaid?: number;
  }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay33b-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay33b-${tag}`, email: `pay33b-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CHECK'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        status: opts.status, subtotal: opts.total, tax_amount: 0, total_amount: opts.total,
        deposit_credit: opts.credit, amount_due: opts.due, public_token: token,
      },
    });
    // The synthetic row the deposit drawdown writes beside the invoice's deposit_credit.
    await db.payment.create({
      data: {
        invoice_id: invoice, amount: opts.credit, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
        created_by_source: 'CLIENT', reference_number: 'DEPOSIT-CREDIT',
      },
    });
    if (opts.cashPaid) {
      await db.payment.create({
        data: { invoice_id: invoice, amount: opts.cashPaid, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED', created_by_source: 'CLIENT' },
      });
    }
    return { invoice, token };
  }

  const view = (inv: { invoice: string; token: string }) => request(app).get(`/api/invoices/${inv.invoice}/public?token=${inv.token}`);

  /** What the page prints, the way the page adds it: total - deposit credit - payments received. */
  const printedDue = (body: { invoice: { total_amount: string | number; deposit_credit: string | number; payments: Array<{ amount: string | number; state?: string }> } }) => {
    const received = body.invoice.payments.filter((p) => (p.state ?? 'SUCCEEDED') === 'SUCCEEDED').reduce((sum, p) => sum + Number(p.amount), 0);
    return Number(body.invoice.total_amount) - Number(body.invoice.deposit_credit) - received;
  };

  it('a covered invoice: the credit is its own line and is not a listed payment, so the lines reach Amount Due $0', async () => {
    const res = await view(await invoiceWith({ total: 100, credit: 100, due: 0, status: 'PAID' }));

    expect(res.status).toBe(200);
    expect(Number(res.body.invoice.deposit_credit)).toBe(100);
    expect(res.body.invoice.payments).toEqual([]);
    expect(printedDue(res.body)).toBe(Number(res.body.invoice.amount_due));
  });

  it('a part-covered invoice with a payment of its own: only that payment is listed, and the lines add up to Amount Due', async () => {
    const res = await view(await invoiceWith({ total: 100, credit: 50, due: 20, status: 'PARTIAL', cashPaid: 30 }));

    expect(res.status).toBe(200);
    expect(res.body.invoice.payments).toHaveLength(1);
    expect(Number(res.body.invoice.payments[0].amount)).toBe(30);
    expect(printedDue(res.body)).toBe(Number(res.body.invoice.amount_due));
  });

  it('a part-covered invoice with no payment of its own lists none and still adds up', async () => {
    const res = await view(await invoiceWith({ total: 100, credit: 50, due: 50, status: 'SENT' }));

    expect(res.body.invoice.payments).toEqual([]);
    expect(printedDue(res.body)).toBe(Number(res.body.invoice.amount_due));
  });

  // V7-12a pin (no overpaid invoices, BE-14 row 9): two paid deposits cannot credit an invoice for
  // more than it is worth, in the read pass or when the credit is written.
  it('two paid $800 deposits on a $1,000 invoice credit $1,000 in total: $800 then $200, never $1,600', async () => {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `v712a-dep-${tag}`, email: `dep-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const deposits = [randomUUID(), randomUUID()];
    for (const [i, id] of deposits.entries()) {
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `DEP-${tag}-${i}`, kind: 'DEPOSIT',
          status: 'PAID', subtotal: 800, tax_amount: 0, total_amount: 800, amount_due: 0,
        },
      });
      await db.payment.create({
        data: { invoice_id: id, amount: 800, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED', created_by_source: 'USER' },
      });
    }
    const target = randomUUID();
    await db.invoice.create({
      data: {
        id: target, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'DRAFT',
        subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 1000,
      },
    });

    const { credit, applied } = await db.$transaction(async (tx) => ({
      credit: await computeDepositCredit(tx, deposits.map((id) => ({ id })), 1000),
      applied: await applyDepositCreditsWithPayments(tx, deposits.map((id) => ({ id })), target, 1000, org),
    }));

    expect(credit).toBe(1000);
    expect(applied.map((a) => a.amount)).toEqual([800, 200]);
    const rows = await db.depositCreditApplication.findMany({ where: { target_invoice_id: target } });
    expect(rows.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(1000);
  });
});
