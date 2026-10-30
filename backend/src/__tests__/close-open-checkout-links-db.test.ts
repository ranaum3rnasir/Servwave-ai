/* =============================================================================
   Payments go-live slice 14 - open checkout links close when the invoice changes.

   A customer can never pay an old amount through an old link. A hosted checkout lives at the
   processor for about a day and settles on its own, so whenever what the invoice asks for stops
   being true, every link still open for it is expired at the processor:
     - a payment is recorded by hand (on the invoice, or on the estimate's deposit);
     - the invoice is voided;
     - a line, a scope of work or the billing (tax, discount, tip) changes;
     - an online payment is booked against it (a bank debit starts, or clears first; a card pays).
   The deposit put on hold is covered by deposit-checkout-expiry.test.ts and
   deposit-hold-on-recall.test.ts.

   Each test opens two links at a faked processor, one for this invoice and one for another, does
   the action through the real route, and asserts only this invoice's link was expired. The sweep
   itself (lib/stripe.ts) runs for real against the faked processor client. A sweep the processor
   refuses never fails the action. Real migrated database (TEST_DATABASE_URL); skips when unset.
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
import { getStripeForOrg, expireOpenCheckoutSessionsForInvoice, expireCheckoutSession } from '../lib/stripe';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;
/** How long a fire-and-forget sweep may take on a loaded machine; inside the 20s test timeout. */
const SWEEP_TIMEOUT = 8000;

/** The processor's open checkout sessions, and the expire call under test. */
const listSessions = vi.fn();
const expireSession = vi.fn();
/** The charge the processor returns for a payment intent (latest_charge expanded). */
const retrievePaymentIntent = vi.fn();

suite('open checkout links close when the invoice changes (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  beforeEach(async () => {
    // The real sweep, run against the faked processor client below.
    const actual = await vi.importActual<typeof import('../lib/stripe')>('../lib/stripe');
    vi.mocked(expireOpenCheckoutSessionsForInvoice).mockImplementation(actual.expireOpenCheckoutSessionsForInvoice);
    vi.mocked(expireCheckoutSession).mockImplementation(actual.expireCheckoutSession);
    listSessions.mockReset();
    expireSession.mockReset();
    expireSession.mockResolvedValue({ status: 'expired' });
    retrievePaymentIntent.mockReset();
    retrievePaymentIntent.mockResolvedValue({ latest_charge: null });
    vi.mocked(getStripeForOrg).mockImplementation((org) => ({
      stripe: {
        checkout: { sessions: { list: listSessions, expire: expireSession } },
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: org.stripe_account_id ?? undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>));
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM credits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM lead_status_history WHERE lead_id IN (SELECT id FROM leads WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay14_%'`));
    await db.$disconnect();
  });

  /**
   * An org on a connected account with an admin signed in, a customer, the invoice under test (one
   * $500 line) and a second invoice. The processor holds one open link for each.
   */
  async function orgWithOpenLinks(opts: { status?: 'DRAFT' | 'SENT' | 'PARTIAL' } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const other = randomUUID();
    const line = randomUUID();
    const account = `acct_pay14_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay14-${tag}`, email: `pay14-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'], stripe_charges_enabled: true,
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    for (const [id, number] of [[invoice, `INV-${tag}`], [other, `INV-${tag}-2`]] as const) {
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: number, status: opts.status ?? 'SENT',
          sent_at: opts.status === 'DRAFT' ? null : new Date(), public_token: randomUUID(),
          subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500,
        },
      });
    }
    await db.invoiceLineItem.create({
      data: { id: line, invoice_id: invoice, sequence: 1, description: 'Door repair', quantity: 1, unit_price: 500, line_total: 500, is_taxable: false },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const mine = `cs_pay14_${tag}_mine`;
    const theirs = `cs_pay14_${tag}_other`;
    listSessions.mockResolvedValue({
      has_more: false,
      data: [
        { id: theirs, status: 'open', metadata: { invoiceId: other, organizationId: org } },
        { id: mine, status: 'open', metadata: { invoiceId: invoice, organizationId: org } },
      ],
    });
    // A token per org: the auth layer caches who a token belongs to.
    const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer pay14-${tag}`);
    return { org, tag, account, user, customer, invoice, other, line, mine, theirs, asAdmin };
  }

  /**
   * The session ids the processor was asked to expire, once the post-action sweep has run. The
   * sweep is fire-and-forget, so this waits for the first `calls` expiries and then for the calls
   * to stop arriving: a late expiry is counted in this test (a duplicate fails it every time)
   * instead of landing in the next test after its mocks were reset. The ceiling is generous
   * because a loaded machine runs the sweep late, not wrongly.
   */
  async function expiredAfterSweep(calls = 1): Promise<string[]> {
    await vi.waitFor(() => expect(expireSession.mock.calls.length).toBeGreaterThanOrEqual(calls), { timeout: SWEEP_TIMEOUT });
    let seen = -1;
    await vi.waitFor(() => {
      const now = expireSession.mock.calls.length;
      const settled = now === seen;
      seen = now;
      expect(settled).toBe(true);
    }, { timeout: SWEEP_TIMEOUT, interval: 200 });
    return expireSession.mock.calls.map((call) => call[0] as string);
  }

  describe('a payment recorded by hand', () => {
    it('on the invoice: its open link is expired on the connected account, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/payments`))
        .send({ amount: 120, method: 'CASH' });

      expect(res.status).toBe(201);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
      expect(expireSession.mock.calls[0][2]).toEqual({ stripeAccount: f.account });
    });

    it('on the estimate\'s deposit: the deposit invoice\'s open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();
      const lead = randomUUID();
      const estimate = randomUUID();
      await db.lead.create({
        data: { id: lead, organization_id: f.org, lead_number: `L-${f.tag}`, customer_id: f.customer, service_request: 'Deposit by hand', status: 'ESTIMATED' },
      });
      await db.estimate.create({
        data: {
          id: estimate, organization_id: f.org, lead_id: lead, customer_id: f.customer, created_by: f.user, estimate_number: `E-${f.tag}`,
          status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000,
        },
      });
      await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });

      const res = await f.asAdmin(request(app).post(`/api/estimates/${estimate}/record-payment`))
        .send({ amount: 200, payment_method: 'CHECK' });

      expect(res.status).toBe(200);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('a credit is applied', () => {
    it('the balance drops, so its open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/credit`))
        .send({ amount: 100, reason: 'Goodwill' });

      expect(res.status).toBe(200);
      expect(Number((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).amount_due)).toBe(400);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('cash given back reopens the balance', () => {
    it('the balance rises, so its open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();
      const paid = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/payments`)).send({ amount: 120, method: 'CASH' });
      expect(paid.status).toBe(201);
      await expiredAfterSweep();
      expireSession.mockClear();

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/credit`))
        .send({ amount: 50, reason: 'Returned in cash', refund_instead: true, reopen_balance: true, method: 'CASH' });

      expect(res.status).toBe(200);
      expect(Number((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).amount_due)).toBe(430);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('a payment is voided', () => {
    it('the balance rises back, so its open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();
      const paid = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/payments`)).send({ amount: 100, method: 'CASH' });
      expect(paid.status).toBe(201);
      await expiredAfterSweep();
      expireSession.mockClear();
      const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice } });

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/void-payment`))
        .send({ payment_id: payment.id, void_category: 'ERROR', reason: 'Entered by mistake' });

      expect(res.status).toBe(200);
      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } });
      expect([invoice.status, Number(invoice.amount_due)]).toEqual(['SENT', 500]);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });

    it('a deposit\'s payment: the deposit\'s link and the link of the invoice its credit is taken back from are expired, an unrelated one is not', async () => {
      const f = await orgWithOpenLinks();
      // The invoice under test is a paid $500 deposit; $200 of it was drawn down onto the other
      // invoice, which now asks for $300. Voiding the deposit's payment takes the $200 back.
      await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', status: 'PAID', amount_due: 0, paid_at: new Date() } });
      const payment = await db.payment.create({
        data: { invoice_id: f.invoice, amount: 500, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' },
      });
      await db.invoice.update({ where: { id: f.other }, data: { status: 'PARTIAL', amount_due: 300 } });
      await db.depositCreditApplication.create({
        data: { organization_id: f.org, deposit_invoice_id: f.invoice, target_invoice_id: f.other, amount: 200 },
      });
      await db.payment.create({
        data: { invoice_id: f.other, amount: 200, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED', reference_number: 'DEPOSIT-CREDIT' },
      });
      const unrelated = `cs_pay14_${f.tag}_unrelated`;
      listSessions.mockResolvedValue({
        has_more: false,
        data: [
          { id: unrelated, status: 'open', metadata: { invoiceId: randomUUID(), organizationId: f.org } },
          { id: f.theirs, status: 'open', metadata: { invoiceId: f.other, organizationId: f.org } },
          { id: f.mine, status: 'open', metadata: { invoiceId: f.invoice, organizationId: f.org } },
        ],
      });

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/void-payment`))
        .send({ payment_id: payment.id, void_category: 'BOUNCED', reason: 'Check bounced' });

      expect(res.status).toBe(200);
      expect(Number((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).amount_due)).toBe(500);
      expect(Number((await db.invoice.findUniqueOrThrow({ where: { id: f.other } })).amount_due)).toBe(500);
      expect((await expiredAfterSweep(2)).sort()).toEqual([f.mine, f.theirs].sort());
    });
  });

  describe('the invoice is voided', () => {
    it('its open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/void`))
        .send({ voided_reason: 'Billed in error' });

      expect(res.status).toBe(200);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('a sent deposit invoice is voided by the estimate or lead closing', () => {
    type Fixture = Awaited<ReturnType<typeof orgWithOpenLinks>>;
    /** The invoice under test becomes the SENT deposit of a SENT estimate on an open lead. */
    async function depositWithOpenLink() {
      const f = await orgWithOpenLinks();
      const lead = randomUUID();
      const estimate = randomUUID();
      const estimateToken = randomUUID();
      // Leads are a paid module; the lead doors need a plan that includes them.
      await db.organization.update({ where: { id: f.org }, data: { plan: 'ENTERPRISE' } });
      await db.lead.create({
        data: { id: lead, organization_id: f.org, lead_number: `L-${f.tag}`, customer_id: f.customer, service_request: 'Deposit door', status: 'ESTIMATED' },
      });
      await db.estimate.create({
        data: {
          id: estimate, organization_id: f.org, lead_id: lead, customer_id: f.customer, created_by: f.user, estimate_number: `E-${f.tag}`,
          status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000, public_token: estimateToken,
        },
      });
      await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });
      return { ...f, lead, estimate, estimateToken };
    }
    const doors: Array<[string, (f: Fixture & { lead: string; estimate: string; estimateToken: string }) => request.Test]> = [
      ['the estimate is cancelled', (f) => f.asAdmin(request(app).post(`/api/estimates/${f.estimate}/cancel`)).send({ cancelled_reason: 'Customer changed plans' })],
      ['the office declines the estimate', (f) => f.asAdmin(request(app).post(`/api/estimates/${f.estimate}/decline-internal`)).send({ lost_reason: 'PRICE' })],
      ['the customer declines the estimate', (f) => request(app).post(`/api/estimates/${f.estimate}/decline?token=${f.estimateToken}`).send({})],
      ['the deposit is waived', (f) => f.asAdmin(request(app).post(`/api/estimates/${f.estimate}/waive-deposit`)).send({ action: 'waive' })],
      ['the lead is marked lost', (f) => f.asAdmin(request(app).post(`/api/leads/${f.lead}/mark-lost`)).send({ lost_reason: 'PRICE' })],
    ];

    it.each(doors)('%s: the deposit\'s open link is expired, the other invoice\'s is not', async (_name, door) => {
      const f = await depositWithOpenLink();

      const res = await door(f);

      expect(res.status).toBe(200);
      expect((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).status).toBe('VOIDED');
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('a line, a scope of work or the billing changes', () => {
    type Fixture = Awaited<ReturnType<typeof orgWithOpenLinks>>;
    const edits: Array<[string, (f: Fixture) => request.Test]> = [
      ['a line is added', (f) => f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/line-items`)).send({ description: 'Hinge', quantity: 2, unit_price: 25 })],
      ['a line\'s price changes', (f) => f.asAdmin(request(app).patch(`/api/invoices/${f.invoice}/line-items/${f.line}`)).send({ unit_price: 450 })],
      ['a line is removed', (f) => f.asAdmin(request(app).delete(`/api/invoices/${f.invoice}/line-items/${f.line}`))],
      ['a scope of work is added', (f) => f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/scopes`)).send({ title: 'Haul away', flat_price: 80 })],
      ['the discount changes', (f) => f.asAdmin(request(app).patch(`/api/invoices/${f.invoice}/billing`)).send({ discount_amount: 50 })],
    ];

    it.each(edits)('%s: its open link is expired, the other invoice\'s is not', async (_name, edit) => {
      const f = await orgWithOpenLinks();

      const res = await edit(f);

      expect(res.status).toBe(200);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });

    // W4: a DRAFT with a public link is payable, so an edit must expire its open link too.
    it.each(edits)('a DRAFT with a payable link, %s: its open link is expired, the other invoice\'s is not', async (_name, edit) => {
      const f = await orgWithOpenLinks({ status: 'DRAFT' });

      const res = await edit(f);

      expect(res.status).toBe(200);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });
  });

  describe('a DRAFT invoice with a payable link is deleted (W4)', () => {
    it('with no payment: its open link is expired first, the other invoice\'s is not, then the invoice is gone', async () => {
      const f = await orgWithOpenLinks({ status: 'DRAFT' });

      const res = await f.asAdmin(request(app).delete(`/api/invoices/${f.invoice}`));

      expect(res.status).toBe(204);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
      expect(await db.invoice.count({ where: { id: f.invoice } })).toBe(0);
    });

    it('with a payment on it: refused with 409 (a 500 foreign-key error before), the invoice and its payment stay', async () => {
      const f = await orgWithOpenLinks({ status: 'DRAFT' });
      await db.payment.create({ data: { invoice_id: f.invoice, amount: 100, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED' } });

      const res = await f.asAdmin(request(app).delete(`/api/invoices/${f.invoice}`));

      expect(res.status).toBe(409);
      expect(await db.invoice.count({ where: { id: f.invoice } })).toBe(1);
      expect(await db.payment.count({ where: { invoice_id: f.invoice } })).toBe(1);
    });

    it('when the processor cannot confirm its link is dead: refused with 409 and the invoice stays', async () => {
      const f = await orgWithOpenLinks({ status: 'DRAFT' });
      expireSession.mockRejectedValue(new Error('processor unavailable'));

      const res = await f.asAdmin(request(app).delete(`/api/invoices/${f.invoice}`));

      expect(res.status).toBe(409);
      expect(await db.invoice.count({ where: { id: f.invoice } })).toBe(1);
    });
  });

  describe('an online payment is booked against the invoice', () => {
    /** Post one processor event to the webhook route, on the org's connected account. */
    async function deliver(f: Awaited<ReturnType<typeof orgWithOpenLinks>>, type: string, object: object) {
      const event = {
        id: `evt_pay14_${f.tag}_${randomUUID().slice(0, 8)}`, object: 'event', api_version: '2025-02-24.acacia',
        type, created: 1790000000, account: f.account, data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    }
    /** The completed checkout that paid: a third link, not one of the two still open. */
    const paidSession = (f: Awaited<ReturnType<typeof orgWithOpenLinks>>, over: Record<string, unknown>) => ({
      id: `cs_pay14_${f.tag}_paid`, object: 'checkout.session', mode: 'payment', status: 'complete',
      payment_intent: `pi_pay14_${f.tag}`, amount_total: 50000, currency: 'usd',
      metadata: { invoiceId: f.invoice, organizationId: f.org, kind: 'invoice', payableNowCents: '50000' },
      ...over,
    });
    const charge = (f: Awaited<ReturnType<typeof orgWithOpenLinks>>, details: object) => retrievePaymentIntent.mockResolvedValue({
      id: `pi_pay14_${f.tag}`,
      latest_charge: { id: `py_pay14_${f.tag}`, object: 'charge', created: 1789990000, amount: 50000, payment_method_details: details },
    });
    const bank = { type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } };

    it('a card checkout pays: the invoice\'s other open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();
      charge(f, { type: 'card', card: { brand: 'visa', last4: '4242' } });

      await deliver(f, 'checkout.session.completed', paidSession(f, { payment_status: 'paid', payment_method_types: ['card'] }));

      expect(await db.payment.count({ where: { invoice_id: f.invoice, state: 'SUCCEEDED' } })).toBe(1);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });

    it('a bank debit starts processing: the invoice\'s other open link is expired, the other invoice\'s is not', async () => {
      const f = await orgWithOpenLinks();
      charge(f, bank);

      await deliver(f, 'checkout.session.completed', paidSession(f, { payment_status: 'unpaid', payment_method_types: ['us_bank_account'] }));

      expect(await db.payment.count({ where: { invoice_id: f.invoice, state: 'PROCESSING' } })).toBe(1);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });

    it('a bank debit\'s clearing arrives before its completion: the payment is booked and the other open link is still expired', async () => {
      const f = await orgWithOpenLinks();
      charge(f, bank);

      await deliver(f, 'checkout.session.async_payment_succeeded', paidSession(f, { payment_status: 'paid', payment_method_types: ['us_bank_account'] }));
      expect(await db.payment.count({ where: { invoice_id: f.invoice, state: 'SUCCEEDED' } })).toBe(1);
      expect(await expiredAfterSweep()).toEqual([f.mine]);

      // The late completion books nothing more and sweeps nothing more.
      expireSession.mockClear();
      await deliver(f, 'checkout.session.completed', paidSession(f, { payment_status: 'paid', payment_method_types: ['us_bank_account'] }));
      expect(await db.payment.count({ where: { invoice_id: f.invoice } })).toBe(1);
    });

    // ServWave keeps no per-invoice record of open links (the sweep asks the processor each time),
    // so a link that times out has nothing to mark closed. The event is acknowledged on purpose.
    it('a link that times out (checkout.session.expired) is acknowledged on purpose and changes nothing', async () => {
      const f = await orgWithOpenLinks();
      const eventsBefore = await db.stripeEvent.count({ where: { stripe_event_id: { startsWith: `evt_pay14_${f.tag}` } } });
      vi.mocked(logger.info).mockClear();

      await deliver(f, 'checkout.session.expired', paidSession(f, { status: 'expired', payment_status: 'unpaid', payment_intent: null }));

      expect(await db.stripeEvent.count({ where: { stripe_event_id: { startsWith: `evt_pay14_${f.tag}` } } })).toBe(eventsBefore + 1);
      expect(await db.payment.count({ where: { invoice_id: f.invoice } })).toBe(0);
      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } });
      expect([invoice.status, Number(invoice.amount_due)]).toEqual(['SENT', 500]);
      expect(vi.mocked(logger.info).mock.calls.map((c) => String(c[0]))).not.toContain('Unhandled webhook event: checkout.session.expired');
    });
  });

  describe('the processor cannot close a link', () => {
    it('never blocks the action, leaves an audit row naming the trigger, and the next trigger sweeps again', async () => {
      const f = await orgWithOpenLinks();
      expireSession.mockRejectedValueOnce(new Error('processor unavailable'));

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/payments`)).send({ amount: 120, method: 'CASH' });

      expect(res.status).toBe(201);
      await vi.waitFor(async () => {
        const rows = await db.auditLog.findMany({ where: { org_id: f.org, action: 'invoice.checkout_expiry_failed', resource_id: f.invoice } });
        expect(rows.map((r) => r.metadata)).toEqual([expect.objectContaining({ trigger: 'manual_payment', failed_sessions: 1, expired_sessions: 0 })]);
      }, { timeout: SWEEP_TIMEOUT });

      // The link is still open at the processor; the next change to the invoice tries again.
      expireSession.mockClear();
      const edit = await f.asAdmin(request(app).patch(`/api/invoices/${f.invoice}/line-items/${f.line}`)).send({ unit_price: 450 });
      expect(edit.status).toBe(200);
      expect(await expiredAfterSweep()).toEqual([f.mine]);
    });

    it('a processor that cannot even list the open links still lets the void through', async () => {
      const f = await orgWithOpenLinks();
      listSessions.mockRejectedValue(new Error('processor unavailable'));

      const res = await f.asAdmin(request(app).post(`/api/invoices/${f.invoice}/void`)).send({ voided_reason: 'Billed in error' });

      expect(res.status).toBe(200);
      await vi.waitFor(async () => {
        const rows = await db.auditLog.findMany({ where: { org_id: f.org, action: 'invoice.checkout_expiry_failed', resource_id: f.invoice } });
        expect(rows.map((r) => r.metadata)).toEqual([expect.objectContaining({ trigger: 'invoice_voided' })]);
      }, { timeout: SWEEP_TIMEOUT });
      expect(expireSession).not.toHaveBeenCalled();
    });
  });
});

