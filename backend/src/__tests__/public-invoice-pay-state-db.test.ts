/* =============================================================================
   Payments go-live, slice 25 - the public invoice tells the homeowner the true state of the
   invoice, and its checkout door refuses anything else with a reason the page can show.

   GET  /api/invoices/:id/public            carries the bank money in flight (processing_amount),
                                            what can be paid online now (payable_now) and one
                                            pay_state the page renders from.
   POST /api/invoices/:id/public/checkout   refuses an invoice that changed under the page, and
                                            re-checks the invoice once the session exists.

   Driven through the real routes against a real migrated database (TEST_DATABASE_URL): which
   payment rows count as "processing" is a where-clause a mocked client cannot check. Only the
   processor SDK is replaced, by a recorder. Skips when TEST_DATABASE_URL is unset, like every
   other *-db suite. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

const { sessionsCreate, sessionsExpire } = vi.hoisted(() => ({ sessionsCreate: vi.fn(), sessionsExpire: vi.fn() }));

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

// The real session builder runs; only the processor SDK underneath it records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = {
      sessions: {
        create: sessionsCreate,
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        expire: sessionsExpire,
      },
    };
  },
}));

import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

type PaymentState = 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

suite('public invoice pay state (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_pay25_db';
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  beforeEach(() => {
    sessionsCreate.mockReset();
    sessionsExpire.mockReset().mockResolvedValue({});
  });

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A sent invoice with a public link, on an org whose account takes cards and bank payments. */
  async function invoiceWith(opts: {
    status?: 'SENT' | 'PARTIAL' | 'PAID' | 'VOIDED' | 'DRAFT' | 'REFUNDED';
    total?: number;
    due?: number;
    kind?: 'STANDARD' | 'DEPOSIT';
    payments?: Array<{ amount: number; state: PaymentState; voided?: boolean }>;
  } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay25-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay25-${tag}`, email: `pay25-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay25_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const total = opts.total ?? 200;
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        status: opts.status ?? 'SENT', subtotal: total, tax_amount: 0, total_amount: total,
        amount_due: opts.due ?? total, public_token: token, ...(opts.kind ? { kind: opts.kind } : {}),
      },
    });
    for (const p of opts.payments ?? []) {
      await db.payment.create({
        data: {
          invoice_id: invoice, amount: p.amount, method: p.state === 'SUCCEEDED' ? 'CHECK' : 'ACH', paid_at: new Date(),
          state: p.state, created_by_source: 'CLIENT', ...(p.voided ? { voided_at: new Date(), voided_reason: 'test' } : {}),
        },
      });
    }
    return { org, invoice, token, customer, tag };
  }

  const view = (inv: { invoice: string; token: string }) => request(app).get(`/api/invoices/${inv.invoice}/public?token=${inv.token}`);

  it('carries the bank payment still processing, what can be paid now, and PAYABLE while some is left', async () => {
    // $200 invoice: $50 by check landed (due $150), $60 by bank in flight, a voided and a failed
    // bank payment that are no money at all.
    const inv = await invoiceWith({
      status: 'PARTIAL', due: 150,
      payments: [
        { amount: 50, state: 'SUCCEEDED' },
        { amount: 60, state: 'PROCESSING' },
        { amount: 7, state: 'PROCESSING', voided: true },
        { amount: 9, state: 'FAILED' },
      ],
    });

    const res = await view(inv);

    expect(res.status).toBe(200);
    expect(res.body.processing_amount).toBe(60);
    expect(res.body.payable_now).toBe(90);
    expect(res.body.pay_state).toBe('PAYABLE');
  });

  it('reads PROCESSING, with nothing payable now, while a bank payment covers the whole amount due', async () => {
    const inv = await invoiceWith({ due: 200, payments: [{ amount: 200, state: 'PROCESSING' }] });

    const res = await view(inv);

    expect(res.body).toMatchObject({ pay_state: 'PROCESSING', processing_amount: 200, payable_now: 0 });
  });

  it('offers nothing payable now unless the page is PAYABLE: a voided, closed or paid invoice reports payable_now 0', async () => {
    // A voided invoice keeps its amount_due on the row; the page must not read it as money to pay.
    const voided = await invoiceWith({ status: 'VOIDED', due: 200 });
    const refunded = await invoiceWith({ status: 'REFUNDED', due: 200 });
    const depositDraft = await invoiceWith({ status: 'DRAFT', due: 200, kind: 'DEPOSIT' });

    for (const inv of [voided, refunded, depositDraft]) {
      const res = await view(inv);
      expect(res.body.pay_state).not.toBe('PAYABLE');
      expect(res.body.payable_now).toBe(0);
    }
  });

  it('reads a DRAFT with a link as PAYABLE, with the amount due (W4)', async () => {
    const draft = await invoiceWith({ status: 'DRAFT', due: 200 });

    const res = await view(draft);

    expect(res.body).toMatchObject({ pay_state: 'PAYABLE', payable_now: 200 });
  });

  it('reads PAID, VOIDED and CLOSED for an invoice that takes no money online', async () => {
    const paid = await invoiceWith({ status: 'PAID', due: 0, payments: [{ amount: 200, state: 'SUCCEEDED' }] });
    const voided = await invoiceWith({ status: 'VOIDED' });
    const refunded = await invoiceWith({ status: 'REFUNDED', due: 0 });

    expect((await view(paid)).body).toMatchObject({ pay_state: 'PAID', processing_amount: 0 });
    expect((await view(voided)).body.pay_state).toBe('VOIDED');
    expect((await view(refunded)).body.pay_state).toBe('CLOSED');
  });

  it("reads CHANGED for a deposit whose estimate was recalled to draft", async () => {
    const inv = await invoiceWith({});
    const user = randomUUID();
    const lead = randomUUID();
    const estimate = randomUUID();
    await db.user.create({
      data: { id: user, organization_id: inv.org, email: `admin-${inv.tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.lead.create({
      data: { id: lead, organization_id: inv.org, lead_number: `L-${inv.tag}`, customer_id: inv.customer, service_request: 'Deposit', status: 'ESTIMATED' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: inv.org, lead_id: lead, customer_id: inv.customer, created_by: user, estimate_number: `E-${inv.tag}`,
        status: 'DRAFT', subtotal: 400, tax_amount: 0, total_amount: 400,
      },
    });
    await db.invoice.update({ where: { id: inv.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });

    const res = await view(inv);

    expect(res.body).toMatchObject({ pay_state: 'CHANGED', deposit_hold_reason: 'ESTIMATE_IN_DRAFT' });
  });

  it("does not echo the org's raw accepted methods; the page reads only what the resolver offers", async () => {
    const inv = await invoiceWith({});

    const res = await view(inv);

    expect(res.body.organization).not.toHaveProperty('accepted_payment_methods');
    expect(res.body.available_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);
  });
  describe('the checkout door', () => {
    const checkout = (inv: { invoice: string; token: string }, body: Record<string, unknown>) =>
      request(app).post(`/api/invoices/${inv.invoice}/public/checkout?token=${inv.token}`).send(body);

    it('a bank request with no processor configured says bank payment is not available', async () => {
      const inv = await invoiceWith({});
      const key = env.STRIPE_SECRET_KEY;
      (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = '';
      try {
        const res = await checkout(inv, { method: 'bank' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Bank payment is not available');
      } finally {
        (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = key;
      }
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('sends a bank payer back to the invoice marked as a bank payment, so the page can say it is processing', async () => {
      const inv = await invoiceWith({});
      sessionsCreate.mockResolvedValue({ id: 'cs_pay25_bank', url: 'https://checkout.example/bank' });

      const res = await checkout(inv, { method: 'bank' });

      expect(res.status).toBe(200);
      const [params] = sessionsCreate.mock.calls[0];
      expect(params.success_url).toMatch(new RegExp(`/p/invoices/${inv.invoice}\\?token=${inv.token}&payment=success&method=bank$`));
      expect(params.cancel_url).toMatch(/&payment=cancelled$/);
    });

    it('refuses, as changed, a page that shows a different amount than the invoice now asks for', async () => {
      // The page loaded at $200; a $50 check was recorded since, so $150 is due now.
      const inv = await invoiceWith({ status: 'PARTIAL', due: 150, payments: [{ amount: 50, state: 'SUCCEEDED' }] });

      const res = await checkout(inv, { method: 'card', expected_amount: 200 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVOICE_CHANGED');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('opens the checkout for what the page shows can be paid now, and brings a card payer back marked as card', async () => {
      const inv = await invoiceWith({ status: 'PARTIAL', due: 150, payments: [{ amount: 40, state: 'PROCESSING' }] });
      sessionsCreate.mockResolvedValue({ id: 'cs_pay25_ok', url: 'https://checkout.example/ok' });

      const res = await checkout(inv, { method: 'card', expected_amount: 110 });

      expect(res.status).toBe(200);
      expect(res.body.checkout_url).toBe('https://checkout.example/ok');
      const [params] = sessionsCreate.mock.calls[0];
      expect(params.metadata.payableNowCents).toBe('11000');
      expect(params.success_url).toMatch(new RegExp(`/p/invoices/${inv.invoice}\\?token=${inv.token}&payment=success&method=card$`));
    });

    it('refuses a paid invoice and a fully processing one with codes the page can explain', async () => {
      const paid = await invoiceWith({ status: 'PAID', due: 0 });
      const processing = await invoiceWith({ due: 200, payments: [{ amount: 200, state: 'PROCESSING' }] });

      const paidRes = await checkout(paid, { method: 'card' });
      const processingRes = await checkout(processing, { method: 'card' });

      expect(paidRes.status).toBe(400);
      expect(paidRes.body.code).toBe('INVOICE_NOT_PAYABLE');
      expect(processingRes.status).toBe(400);
      expect(processingRes.body.code).toBe('PAYMENT_PROCESSING');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('closes a session minted while the amount due changed, and never hands out its link', async () => {
      const inv = await invoiceWith({});
      // A manual payment commits in the gap between the door's read and the session existing:
      // the sweep at that payment ran before this session was there to close.
      sessionsCreate.mockImplementation(async () => {
        await db.invoice.update({ where: { id: inv.invoice }, data: { amount_due: 120, status: 'PARTIAL' } });
        return { id: 'cs_pay25_race', url: 'https://checkout.example/stale' };
      });

      const res = await checkout(inv, { method: 'card' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVOICE_CHANGED');
      expect(res.body.checkout_url).toBeUndefined();
      expect(sessionsExpire).toHaveBeenCalledTimes(1);
      expect(sessionsExpire.mock.calls[0][0]).toBe('cs_pay25_race');
    });
  });
});
