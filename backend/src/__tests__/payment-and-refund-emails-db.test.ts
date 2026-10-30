/* =============================================================================
   Payments go-live, slice 30 - the customer hears about their money.

   A card payment sends the customer a receipt that itemises what was applied, the tip and the total
   charged, with the method as the customer knows it ("Link"). A refund sends one email when it
   SUCCEEDS: at once for a card refund, when the processor confirms it for a bank refund, and never
   for one still pending or one that failed.

   The wording and the kill-switch bypass are covered in email-payment-receipt-and-refund.test.ts;
   this file proves the doors call the senders at the right moment, through the real webhook route and
   the real refund route. Real migrated database (TEST_DATABASE_URL); skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { createRefund, getStripeForOrg } from '../lib/stripe';
import { sendPaymentReceivedEmail, sendInvoiceRefundNotification } from '../lib/email';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const receiptSender = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;
const refundSender = sendInvoiceRefundNotification as unknown as ReturnType<typeof vi.fn>;
const retrievePaymentIntent = vi.fn();
const suite = realClient ? describe : describe.skip;

suite('receipt and refund emails from the real doors (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    receiptSender.mockClear();
    refundSender.mockClear();
    processorRefund.mockReset();
    retrievePaymentIntent.mockReset();
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
        checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  async function fixture(opts: { total: number; paid: boolean; method?: 'CARD' | 'ACH' }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay30_${tag}`;
    const pi = `pi_pay30_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay30-${tag}`, email: `pay30-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test`,
      },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total,
        ...(opts.paid ? { status: 'PAID', amount_due: 0, paid_at: new Date() } : { status: 'SENT', amount_due: opts.total }),
      },
    });
    const payment = opts.paid
      ? await db.payment.create({
        data: {
          invoice_id: invoice, amount: opts.total, method: opts.method ?? 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
          stripe_payment_intent_id: pi, stripe_charge_id: `ch_pay30_${tag}`, stripe_account_id: account, created_by_source: 'CLIENT',
        },
      })
      : null;
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay30-${tag}`;
    let seq = 0;
    const deliver = async (type: string, object: object) => {
      const event = { id: `evt_pay30_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, account, data: { object } };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    const refundObject = (id: string, amountCents: number, status: string) => ({
      id, object: 'refund', amount: amountCents, currency: 'usd', status, payment_intent: pi,
      charge: `ch_pay30_${tag}`, metadata: { source: 'in_app', invoiceId: invoice },
    });
    const doRefund = (amount: number) => request(app).post(`/api/invoices/${invoice}/refund`)
      .set('Authorization', bearer)
      .send({ amount, payment_id: payment?.id, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 30 test' });
    const doGiveBack = (amount: number) => request(app).post(`/api/invoices/${invoice}/credit`)
      .set('Authorization', bearer)
      .send({ amount, refund_instead: true, reason: 'slice 30 give-back' });
    return { org, tag, invoice, pi, account, doGiveBack, customerEmail: `pat-${tag}@example.test`, deliver, refundObject, doRefund };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay30_%'`));
    await db.$disconnect();
  });

  it('a card payment with a tip, paid with Link, sends one receipt itemising amount, tip and "Link"', async () => {
    const f = await fixture({ total: 100, paid: false });
    retrievePaymentIntent.mockResolvedValue({
      id: f.pi,
      latest_charge: {
        id: `ch_pay30_${f.tag}`, object: 'charge', created: 1789990000, amount: 10600,
        payment_method_details: { type: 'link' },
      },
    });

    await f.deliver('checkout.session.completed', {
      id: `cs_pay30_${f.tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
      payment_intent: f.pi, amount_total: 10600, currency: 'usd',
      metadata: { invoiceId: await invoiceIdOf(f), tipCents: '600' },
    });

    await vi.waitFor(() => expect(receiptSender).toHaveBeenCalledTimes(1));
    expect(receiptSender.mock.calls[0][0]).toMatchObject({
      to: f.customerEmail, amount: 100, tip: 6, methodDisplay: 'Link', newBalance: 0,
    });
  });

  it('a card refund sends the customer one refund email at once', async () => {
    const f = await fixture({ total: 100, paid: true });
    processorRefund.mockResolvedValueOnce({ id: `re_pay30_${f.tag}`, object: 'refund', amount: 4000, status: 'succeeded' });

    expect((await f.doRefund(40)).status).toBe(200);

    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(refundSender.mock.calls[0][0]).toMatchObject({ to: f.customerEmail, refundAmount: 40, invoiceId: f.invoice });
  });

  it('a bank refund sends nothing while pending, then one email when the processor confirms it', async () => {
    const f = await fixture({ total: 100, paid: true, method: 'ACH' });
    const refundId = `re_pay30_ach_${f.tag}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'pending' });

    expect((await f.doRefund(50)).status).toBe(200);
    expect(refundSender).not.toHaveBeenCalled();

    await f.deliver('refund.updated', f.refundObject(refundId, 5000, 'succeeded'));
    await f.deliver('refund.updated', f.refundObject(refundId, 5000, 'succeeded'));

    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(refundSender.mock.calls[0][0]).toMatchObject({ to: f.customerEmail, refundAmount: 50, invoiceId: f.invoice });
  });

  it('a bank refund that fails sends the customer nothing', async () => {
    const f = await fixture({ total: 100, paid: true, method: 'ACH' });
    const refundId = `re_pay30_fail_${f.tag}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'pending' });
    expect((await f.doRefund(50)).status).toBe(200);

    await f.deliver('refund.failed', f.refundObject(refundId, 5000, 'failed'));

    expect(refundSender).not.toHaveBeenCalled();
  });

  it('a card give-back from the Issue Credit door sends the customer one refund email', async () => {
    const f = await fixture({ total: 100, paid: true });
    processorRefund.mockResolvedValueOnce({ id: `re_pay30_gb_${f.tag}`, object: 'refund', amount: 3000, status: 'succeeded' });

    expect((await f.doGiveBack(30)).status).toBe(200);

    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(refundSender.mock.calls[0][0]).toMatchObject({ to: f.customerEmail, refundAmount: 30, invoiceId: f.invoice });
  });

  it('a bank give-back from the Issue Credit door sends nothing while pending, one email when it confirms', async () => {
    const f = await fixture({ total: 100, paid: true, method: 'ACH' });
    const refundId = `re_pay30_gbach_${f.tag}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 3000, status: 'pending' });

    expect((await f.doGiveBack(30)).status).toBe(200);
    expect(refundSender).not.toHaveBeenCalled();

    await f.deliver('refund.updated', f.refundObject(refundId, 3000, 'succeeded'));
    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(refundSender.mock.calls[0][0]).toMatchObject({ invoiceId: f.invoice });
  });

  async function invoiceIdOf(f: { invoice: string }) { return f.invoice; }
});
