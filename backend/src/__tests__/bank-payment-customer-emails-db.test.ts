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
import { claimContact, releaseContactClaim } from '../lib/payment-attention-contact';
import { CHECKOUT_INVOICE_SELECT, runCheckoutEffects } from '../services/payment-reconciler/checkout-effects';
import type { AppliedEffects } from '../services/payment-reconciler/apply';
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
    failedSender.mockReset().mockResolvedValue({ status: 'sent', providerMessageId: null, fromAddress: 'noreply@example.test', fromName: null });
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
  // ---- V7-13 part 2 (BE-13d): path 1 (the debit fails while clearing) emails first, then the alert says what happened ------
  describe('a debit that fails while clearing: the customer is emailed first, and the office alert says what really happened', () => {
    const ASKED = 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN';
    const failedAlert = async (f: { org: string }) => (await db.notification.findMany({ where: { organization_id: f.org, verb: 'billing.bank_payment_failed' } }))[0];
    const askedRows = (f: { org: string }) => db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: ASKED } });

    it('with an email on file: the customer gets the email, the alert says so, and one history row is filed against the item', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      await f.failed();

      await vi.waitFor(async () => expect(await failedAlert(f)).toBeTruthy());
      expect(failedSender).toHaveBeenCalledTimes(1);
      expect((await failedAlert(f)).body).toBe('Amount: $500.00. No money moved. We emailed the customer a link to pay again.');
      const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      const rows = await askedRows(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ description: 'Customer emailed a link to pay again', created_by: null, entity_id: f.invoice, metadata: { item_key: `failed_payment:${payment.id}` } });
    });

    it('no email on file: no email, no history row, and the alert no longer says a link was sent', async () => {
      const f = await fixture({ total: 500 });
      await db.customer.update({ where: { id: f.customer }, data: { email: null } });
      await f.completed();
      await f.failed();

      await vi.waitFor(async () => expect(await failedAlert(f)).toBeTruthy());
      expect(failedSender).not.toHaveBeenCalled();
      const { body } = await failedAlert(f);
      expect(body).toBe('Amount: $500.00. No money moved. No email was sent because this customer has no email address on file. Contact them to pay again.');
      expect(body).not.toMatch(/has been sent/);
      expect(await askedRows(f)).toHaveLength(0);
    });

    it('a suppressed address reads bounced; a forced failure reads could not be sent; neither leaves a history row', async () => {
      const a = await fixture({ total: 500 });
      await a.completed();
      failedSender.mockResolvedValueOnce({ status: 'skipped', reason: 'suppressed' });
      await a.failed();
      await vi.waitFor(async () => expect(await failedAlert(a)).toBeTruthy());
      expect((await failedAlert(a)).body).toBe('Amount: $500.00. No money moved. No email was sent because earlier emails to this customer\u2019s address bounced. Contact them to pay again.');
      expect(await askedRows(a)).toHaveLength(0);

      const b = await fixture({ total: 500 });
      await b.completed();
      failedSender.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
      await b.failed();
      await vi.waitFor(async () => expect(await failedAlert(b)).toBeTruthy());
      expect((await failedAlert(b)).body).toBe('Amount: $500.00. No money moved. The email to the customer could not be sent. Contact them to pay again.');

      const c = await fixture({ total: 500 });
      await c.completed();
      failedSender.mockRejectedValueOnce(new Error('network down'));
      await c.failed();
      await vi.waitFor(async () => expect(await failedAlert(c)).toBeTruthy());
      expect((await failedAlert(c)).body).toContain('could not be sent');
      expect(await askedRows(c)).toHaveLength(0);
    });

    // N-19: the mail layer's other ways to skip a send all read "could not be sent"; only a suppressed address reads bounced.
    it.each(['no_api_key', 'no_recipient', 'address_needed', 'foreign_mailbox'])('a send skipped for %s reads could not be sent, with no history row', async (reason) => {
      const f = await fixture({ total: 500 });
      await f.completed();
      failedSender.mockResolvedValueOnce({ status: 'skipped', reason });
      await f.failed();
      await vi.waitFor(async () => expect(await failedAlert(f)).toBeTruthy());
      expect((await failedAlert(f)).body).toBe('Amount: $500.00. No money moved. The email to the customer could not be sent. Contact them to pay again.');
      expect(await askedRows(f)).toHaveLength(0);
    });

    it('an invoice already PAID by another payment, or DISPUTED, gets no Pay Again email and the alert says it cannot be paid online (C-38)', async () => {
      const paid = await fixture({ total: 500 });
      await paid.completed();
      await db.invoice.update({ where: { id: paid.invoice }, data: { status: 'PAID', amount_due: 0 } });
      await paid.failed();
      await vi.waitFor(async () => expect(await failedAlert(paid)).toBeTruthy());
      expect((await failedAlert(paid)).body).toBe('Amount: $500.00. No money moved. No email was sent because this invoice cannot be paid online right now.');

      const disputed = await fixture({ total: 500 });
      await disputed.completed();
      await db.invoice.update({ where: { id: disputed.invoice }, data: { status: 'DISPUTED' } });
      await disputed.failed();
      await vi.waitFor(async () => expect(await failedAlert(disputed)).toBeTruthy());
      expect((await failedAlert(disputed)).body).toBe('Amount: $500.00. No money moved. No email was sent because this invoice cannot be paid online right now.');
      expect(failedSender).not.toHaveBeenCalled();
      expect(await askedRows(paid)).toHaveLength(0);
    });

    // BE-13d: a VOIDED invoice is not PAID/DISPUTED, so the unchanged sentence applies (C-38 covers only those two).
    it('a VOIDED invoice gets no Pay Again email and the alert keeps the unchanged "no longer open for payment" sentence (BE-13d)', async () => {
      const voided = await fixture({ total: 500 });
      await voided.completed();
      await db.invoice.update({ where: { id: voided.invoice }, data: { status: 'VOIDED' } });
      await voided.failed();
      await vi.waitFor(async () => expect(await failedAlert(voided)).toBeTruthy());
      expect((await failedAlert(voided)).body).toBe('Amount: $500.00. No money moved. The invoice is no longer open for payment.');
      expect(failedSender).not.toHaveBeenCalled();
    });

    it('a second automatic email for the same item inside 10 minutes is not sent', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      await db.timelineEvent.create({
        data: {
          organization_id: f.org, entity_type: 'INVOICE', entity_id: f.invoice, event_type: ASKED,
          description: 'Customer emailed a link to pay again', metadata: { item_key: `failed_payment:${payment.id}` },
        },
      });
      await f.failed();
      await vi.waitFor(async () => expect(await failedAlert(f)).toBeTruthy());
      expect(failedSender).not.toHaveBeenCalled();
      expect((await failedAlert(f)).body).toContain('We emailed the customer a link to pay again.');
      expect(await askedRows(f)).toHaveLength(1);

      // Past the window the item can be asked again.
      await db.timelineEvent.updateMany({ where: { organization_id: f.org, event_type: ASKED }, data: { created_at: new Date(Date.now() - 11 * 60 * 1000) } });
      expect(await claimContact({ organizationId: f.org, invoiceId: f.invoice, itemKey: `failed_payment:${payment.id}`, createdBy: null })).not.toBeNull();
    });

    it('two attempts to email the same item at the same moment claim it once (the automatic path takes the endpoint\'s lock)', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      const args = { organizationId: f.org, invoiceId: f.invoice, itemKey: `failed_payment:${payment.id}`, createdBy: null };
      const claims = await Promise.all([claimContact(args), claimContact(args), claimContact(args)]);
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
      expect(await askedRows(f)).toHaveLength(1);
      // Giving the claim back (no email left) frees the item again.
      await releaseContactClaim(f.org, claims.find((c) => c !== null)!, f.invoice);
      expect(await askedRows(f)).toHaveLength(0);
      expect(await claimContact(args)).not.toBeNull();
    });

    it('a debit that fails before its completion arrived is written down FAILED, the customer is emailed, and the history row names that payment', async () => {
      const f = await fixture({ total: 500 });
      await f.failed();
      await vi.waitFor(async () => expect(await failedAlert(f)).toBeTruthy());
      expect(failedSender).toHaveBeenCalledTimes(1);
      const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      expect(payment.state).toBe('FAILED');
      const rows = await askedRows(f);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ item_key: `failed_payment:${payment.id}` });
    });

    it('a failed notice that names no payment still emails the customer, and files no history row', async () => {
      const f = await fixture({ total: 500 });
      const invoice = await db.invoice.findFirstOrThrow({ where: { id: f.invoice }, select: CHECKOUT_INVOICE_SELECT });
      const effects = {
        unappliedCaptures: [], settledPayments: [], expireCheckouts: [], bookedPayments: [], disputeNotices: [], bankReturnNotices: [],
        bankNotices: [{ type: 'notify_bank_payment', kind: 'failed', invoiceId: f.invoice, amountCents: 50000, deposit: false, payAgain: true, eventId: `evt_pay31_${f.tag}_np` }],
      } as unknown as AppliedEffects;
      await runCheckoutEffects(effects, {
        organization: { id: f.org, name: null, stripe_payouts_enabled: true }, account: undefined, paymentIntentId: null, invoice,
      });
      expect(failedSender).toHaveBeenCalledTimes(1);
      expect(await askedRows(f)).toHaveLength(0);
      expect((await failedAlert(f)).body).toBe('Amount: $500.00. No money moved. We emailed the customer a link to pay again.');
    });
  });
});
