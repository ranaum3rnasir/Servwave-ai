/* =============================================================================
   Payments go-live, slice 31 - the customer who pays by bank is told where their payment stands.

   Through the real webhook route, with a real migrated database (TEST_DATABASE_URL; skips when
   unset): the debit starts -> "processing"; it clears -> the receipt, method "Bank •••• 6789"; it
   fails -> "didn't go through" with the link they paid from, which resolves to the public page.
   Wording, the kill-switch bypass, suppression and vendor names are covered in
   email-bank-payment-notices.test.ts; here the doors must call the right sender at the right moment.
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

import { getStripeForOrg } from '../lib/stripe';
import { sendBankPaymentProcessingEmail, sendBankPaymentFailedEmail, sendPaymentReceivedEmail } from '../lib/email';

const processingSender = sendBankPaymentProcessingEmail as unknown as ReturnType<typeof vi.fn>;
const failedSender = sendBankPaymentFailedEmail as unknown as ReturnType<typeof vi.fn>;
const receiptSender = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;
const retrievePaymentIntent = vi.fn();
const suite = realClient ? describe : describe.skip;

suite('bank payment emails to the customer (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    for (const fn of [processingSender, failedSender, receiptSender]) fn.mockClear();
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

  async function fixture(opts: { total?: number; status?: 'SENT' | 'PAID' | 'PARTIAL'; deposit?: boolean } = {}) {
    const total = opts.total ?? 500;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `tok-${randomUUID()}`;
    const account = `acct_pay31_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay31-${tag}`, email: `pay31-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    const user = randomUUID();
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
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
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: opts.status === 'PAID' ? 0 : total,
        status: opts.status ?? 'SENT', public_token: token,
      },
    });
    const payIntent = `pi_pay31_${tag}`;
    retrievePaymentIntent.mockResolvedValue({
      id: payIntent,
      latest_charge: {
        id: `py_pay31_${tag}`, object: 'charge', created: 1789990000, amount: total * 100,
        payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
      },
    });
    let seq = 0;
    const session = (over: Record<string, unknown> = {}) => ({
      id: `cs_pay31_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'complete',
      payment_intent: payIntent, amount_total: total * 100, currency: 'usd', payment_method_types: ['us_bank_account'],
      metadata: { invoiceId: invoice, organizationId: org, kind: 'invoice', payableNowCents: String(total * 100) },
      ...over,
    });
    const deliver = async (type: string, object: object, id?: string) => {
      const event = { id: id ?? `evt_pay31_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: 1790000000, account, data: { object } };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    return {
      org, tag, invoice, token, customer, user, total, customerEmail: `pat-${tag}@example.test`, session, deliver,
      completed: () => deliver('checkout.session.completed', session()),
      cleared: (id?: string) => deliver('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' }), id),
      failed: () => deliver('checkout.session.async_payment_failed', session()),
    };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM lead_status_history WHERE lead_id IN (SELECT id FROM leads WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay31_%'`));
    await db.$disconnect();
  });

  it('the debit starting sends the customer one "processing" email with the amount and invoice number', async () => {
    const f = await fixture({ total: 500 });

    await f.completed();

    await vi.waitFor(() => expect(processingSender).toHaveBeenCalledTimes(1));
    expect(processingSender.mock.calls[0][0]).toMatchObject({
      organizationId: f.org, to: f.customerEmail, amount: 500, invoiceNumber: `INV-${f.tag}`,
    });
    expect(receiptSender).not.toHaveBeenCalled();
    expect(failedSender).not.toHaveBeenCalled();
  });

  it('the debit clearing sends the receipt once, with the method "Bank •••• 6789" and the new balance', async () => {
    const f = await fixture({ total: 500 });
    await f.completed();

    await f.cleared();
    await f.cleared(); // the same outcome again (another event id) sends nothing more

    await vi.waitFor(() => expect(receiptSender).toHaveBeenCalledTimes(1));
    expect(receiptSender.mock.calls[0][0]).toMatchObject({
      to: f.customerEmail, amount: 500, newBalance: 0, method: 'ACH', methodDisplay: 'Bank •••• 6789',
    });
    expect(processingSender).toHaveBeenCalledTimes(1);
  });

  it('a debit that clears before its completion arrives still sends the receipt', async () => {
    const f = await fixture({ total: 500 });

    await f.cleared();

    await vi.waitFor(() => expect(receiptSender).toHaveBeenCalledTimes(1));
    expect(receiptSender.mock.calls[0][0]).toMatchObject({ amount: 500, methodDisplay: 'Bank •••• 6789' });
  });

  it('the same cleared event delivered twice sends one receipt', async () => {
    const f = await fixture({ total: 500 });
    await f.completed();
    const id = `evt_pay31_${f.tag}_dup`;

    await f.cleared(id);
    await f.cleared(id);

    await vi.waitFor(() => expect(receiptSender).toHaveBeenCalledTimes(1));
  });

  it('a failed debit on an open invoice sends "didn\'t go through" with the public link, which resolves to the pay page', async () => {
    const f = await fixture({ total: 500 });
    await f.completed();

    await f.failed();

    await vi.waitFor(() => expect(failedSender).toHaveBeenCalledTimes(1));
    const args = failedSender.mock.calls[0][0] as { to: string; amount: number; payUrl: string };
    expect(args).toMatchObject({ to: f.customerEmail, amount: 500 });
    const url = new URL(args.payUrl);
    expect(url.pathname).toBe(`/p/invoices/${f.invoice}`);
    const page = await request(app).get(`/api/invoices/${f.invoice}/public?token=${url.searchParams.get('token')}`);
    expect(page.status).toBe(200);
    expect(receiptSender).not.toHaveBeenCalled();
  });

  it('a failed debit on an invoice that is already paid sends the customer nothing', async () => {
    const f = await fixture({ total: 500, status: 'PAID' });

    await f.failed();

    expect(failedSender).not.toHaveBeenCalled();
    expect(processingSender).not.toHaveBeenCalled();
  });

  it('a customer with no email address is sent nothing and nothing breaks', async () => {
    const f = await fixture({ total: 500 });
    await db.customer.update({ where: { id: f.customer }, data: { email: null } });

    await f.completed();
    await f.cleared();

    expect(processingSender).not.toHaveBeenCalled();
    expect(receiptSender).not.toHaveBeenCalled();
  });

  it('a bank deposit: "processing" when the debit starts, the receipt when it clears, and a failure links back to the estimate page', async () => {
    const f = await fixture({ total: 500 });
    const lead = randomUUID();
    const estimate = randomUUID();
    const estimateToken = `etok-${randomUUID()}`;
    await db.lead.create({
      data: { id: lead, organization_id: f.org, lead_number: `L-${f.tag}`, customer_id: f.customer, service_request: 'Deposit by bank', status: 'ESTIMATED' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: f.org, lead_id: lead, customer_id: f.customer, created_by: f.user, estimate_number: `E-${f.tag}`,
        status: 'PENDING', signature_data: 'data:image/png;base64,AAAA', signature_at: new Date(), subtotal: 1000, tax_amount: 0, total_amount: 1000,
        public_token: estimateToken,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });
    const meta = { invoiceId: f.invoice, organizationId: f.org, kind: 'deposit', payableNowCents: '50000', estimateId: estimate };

    await f.deliver('checkout.session.completed', f.session({ metadata: meta }));
    await vi.waitFor(() => expect(processingSender).toHaveBeenCalledTimes(1));
    expect(processingSender.mock.calls[0][0]).toMatchObject({ to: f.customerEmail, amount: 500 });

    await f.deliver('checkout.session.async_payment_failed', f.session({ metadata: meta }));
    await vi.waitFor(() => expect(failedSender).toHaveBeenCalledTimes(1));
    const { payUrl } = failedSender.mock.calls[0][0] as { payUrl: string };
    expect(new URL(payUrl).pathname).toBe(`/p/estimates/${estimate}`);
    expect(new URL(payUrl).searchParams.get('token')).toBe(estimateToken);
  });
});
