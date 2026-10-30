/* =============================================================================
   Payments go-live, slice 13 - a bank (ACH) payment's lifecycle: PROCESSING until it clears, then
   SUCCEEDED; if the debit fails it is FAILED and the balance is open for payment again.

   Before: a bank checkout that completed unpaid booked nothing (slice 08), so what could be paid
   online did not drop while the debit cleared, and a cleared debit was only written down as money
   "not recorded" for a person to book by hand (slice 12's stopgap).

   Events are posted to the real webhook route in the processor's payload shape for the pinned
   version (a checkout session carries the payment intent id; the charge, with the bank's name and
   last four, is read back from the processor). Real migrated database (TEST_DATABASE_URL); skips
   when unset. Every org it creates is removed again.
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

import { getStripeForOrg, expireOpenCheckoutSessionsForInvoice } from '../lib/stripe';
import { sendDepositPaymentConfirmation, sendDepositPaidAlert, sendPaymentReceivedEmail, sendBankPaymentFailedEmail } from '../lib/email';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { paymentDisplayStatus } from '../services/payments-page';

const suite = realClient ? describe : describe.skip;
const failedSender = sendBankPaymentFailedEmail as unknown as ReturnType<typeof vi.fn>;

/** The charge the processor returns for a payment intent (latest_charge expanded). */
const retrievePaymentIntent = vi.fn();
/** The disputes the processor holds on a charge. */
const listDisputes = vi.fn();
/** The checkout sessions the processor holds for a payment intent (an unmatched dispute asks). */
const listSessions = vi.fn();

const CHARGE_CREATED = 1789990000; // the customer authorised the debit, then the events came

suite('a bank payment: processing, cleared, failed (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    failedSender.mockReset().mockResolvedValue({ status: 'sent', providerMessageId: null, fromAddress: 'noreply@example.test', fromName: null });
    listDisputes.mockReset();
    listDisputes.mockResolvedValue({ data: [], has_more: false });
    listSessions.mockReset();
    listSessions.mockResolvedValue({ data: [], has_more: false });
    vi.mocked(expireOpenCheckoutSessionsForInvoice).mockClear();
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: listDisputes },
        checkout: { sessions: { list: listSessions } },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  /** An org with a connected account, an admin, a customer and one invoice of $total. */
  async function orgWithInvoice(opts: { total?: number; amountDue?: number; status?: 'SENT' | 'PARTIAL' } = {}) {
    const total = opts.total ?? 500;
    const amountDue = opts.amountDue ?? total;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay13_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay13-${tag}`, email: `pay13-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
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
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: amountDue, status: opts.status ?? 'SENT',
      },
    });
    const payIntent = `pi_pay13_${tag}`;
    const chargeId = `py_pay13_${tag}`;
    // The processor's bank charge for the debit: pending while it clears, with the bank on it.
    retrievePaymentIntent.mockResolvedValue({
      id: payIntent,
      latest_charge: {
        id: chargeId, object: 'charge', created: CHARGE_CREATED, amount: amountDue * 100,
        payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
      },
    });
    let seq = 0;
    /** A bank checkout session, as the checkout.session.* events carry it. */
    const session = (over: Record<string, unknown> = {}) => ({
      id: `cs_pay13_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'complete',
      payment_intent: payIntent, amount_total: amountDue * 100, currency: 'usd',
      payment_method_types: ['us_bank_account'],
      metadata: { invoiceId: invoice, organizationId: org, kind: 'invoice', payableNowCents: String(amountDue * 100) },
      ...over,
    });
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object, opts2: { id?: string; status?: number } = {}) => {
      const event = {
        id: opts2.id ?? `evt_pay13_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia',
        type, created: 1790000000, account, data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(opts2.status ?? 200);
      return res;
    };
    const completed = (over: Record<string, unknown> = {}, opts2: { id?: string } = {}) =>
      deliver('checkout.session.completed', session(over), opts2);
    const cleared = (opts2: { id?: string } = {}) =>
      deliver('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' }), opts2);
    const failed = (opts2: { id?: string } = {}) =>
      deliver('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' }), opts2);
    const payments = () => db.payment.findMany({ where: { invoice_id: invoice } });
    const readInvoice = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const history = (eventType: string) =>
      db.timelineEvent.findMany({ where: { organization_id: org, entity_id: invoice, event_type: eventType } });
    return { org, tag, invoice, account, user, customer, payIntent, chargeId, session, deliver, completed, cleared, failed, payments, readInvoice, history };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
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
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay13_%'`));
    await db.$disconnect();
  });

  it('a bank checkout that completes unpaid books one PROCESSING bank payment and leaves the balance and status alone', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await f.completed();

    const [payment, ...others] = await f.payments();
    expect(others).toHaveLength(0);
    expect(payment).toMatchObject({
      method: 'ACH', state: 'PROCESSING',
      bank_name: 'STRIPE TEST BANK', bank_last4: '6789',
      stripe_payment_intent_id: f.payIntent,
      stripe_charge_id: f.chargeId,
      stripe_checkout_session_id: `cs_pay13_${f.tag}`,
      stripe_account_id: f.account,
      card_brand: null, card_last4: null, wallet: null,
      created_by_source: 'CLIENT',
    });
    expect(Number(payment.amount)).toBe(500);
    expect(payment.paid_at.toISOString()).toBe(new Date(CHARGE_CREATED * 1000).toISOString());
    // Processing money is not collected: the balance and the status stay where they were.
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect(Number(invoice.net_collected ?? 0)).toBe(0);
    // Every other open checkout link for the invoice is closed.
    expect(vi.mocked(expireOpenCheckoutSessionsForInvoice)).toHaveBeenCalledWith(f.invoice, expect.anything());
    // Written down where the owner reads the invoice's history, in ServWave's words.
    const [started] = await f.history('PAYMENT_PROCESSING');
    expect(started.description).toBe('Bank payment started; it takes a few business days to clear');
  });

  it('while the debit clears, payable-now is down: a card checkout built for the whole balance is not applied', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    // A second link opened before the bank payment started, now paid by card for the whole $500.
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_card', latest_charge: null });
    await f.deliver('checkout.session.completed', f.session({
      id: `cs_pay13_card_${f.tag}`, payment_intent: `pi_pay13_card_${f.tag}`, payment_status: 'paid',
    }));

    expect((await f.payments()).map((p) => p.state)).toEqual(['PROCESSING']);
    const [unrecorded] = await db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } });
    expect(unrecorded.metadata).toMatchObject({ reason: 'AMOUNT_MISMATCH', expected_cents: 0, charged_cents: 50000 });
    expect((await f.readInvoice()).status).toBe('SENT');
  });

  it('PROCESSING -> SUCCEEDED: when the debit clears the invoice is PAID, paid at the charge time, once however often the event comes', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    const clearedId = `evt_pay13_${f.tag}_cleared`;
    await f.cleared({ id: clearedId });

    const [payment] = await f.payments();
    expect(payment.state).toBe('SUCCEEDED');
    // Paid-at stays the charge's creation time, not the time the debit cleared.
    expect(payment.paid_at.toISOString()).toBe(new Date(CHARGE_CREATED * 1000).toISOString());
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(500);
    const [clearedEntry] = await f.history('PAYMENT_RECEIVED');
    expect(clearedEntry.description).toBe('Bank payment cleared');
    expect(await f.history('INVOICE_PAID')).toHaveLength(1);

    // The same cleared event again (its own id) is answered as a duplicate, and the same outcome
    // under another event id changes nothing either.
    const replay = await f.cleared({ id: clearedId });
    expect(replay.body).toMatchObject({ duplicate: true });
    await f.cleared();
    expect((await f.payments()).map((p) => p.state)).toEqual(['SUCCEEDED']);
    expect(Number((await f.readInvoice()).amount_due)).toBe(0);
    expect(await f.history('INVOICE_PAID')).toHaveLength(1);
  });

  it('slice 39: an org that lost the online_payments plan AND bank after the session opened still has the debit recorded and cleared', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();
    await db.organization.update({ where: { id: f.org }, data: { accepted_payment_methods: [], feature_overrides: { online_payments: false } } });
    await f.cleared();
    expect((await f.payments()).map((p) => p.state)).toEqual(['SUCCEEDED']);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  /**
   * The hosted checkout's manual bank entry: the checkout completes first, and the processor only
   * creates the charge once the customer verifies the micro-deposits, days later. At completion the
   * payment intent has the bank account on its payment method and no charge yet.
   */
  function noChargeYet(f: Awaited<ReturnType<typeof orgWithInvoice>>) {
    retrievePaymentIntent.mockResolvedValue({
      id: f.payIntent,
      latest_charge: null,
      payment_method: { id: `pm_pay13_${f.tag}`, object: 'payment_method', type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
    });
  }
  /** The micro-deposits were verified: the debit's charge now exists. */
  const MICRO_CHARGE_CREATED = 1790100000;
  function chargeNowExists(f: Awaited<ReturnType<typeof orgWithInvoice>>) {
    retrievePaymentIntent.mockResolvedValue({
      id: f.payIntent,
      latest_charge: {
        id: f.chargeId, object: 'charge', created: MICRO_CHARGE_CREATED, amount: 50000,
        payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
      },
    });
  }

  it('micro-deposits verified after the checkout completed: when the debit clears, the payment carries the charge id, the bank and paid-at = the charge time', async () => {
    const f = await orgWithInvoice({ total: 500 });
    noChargeYet(f);
    await f.completed();
    // Booked PROCESSING at once with the bank the customer entered; the charge id comes later.
    expect((await f.payments()).map((p) => [p.state, p.stripe_charge_id, p.bank_name, p.bank_last4]))
      .toEqual([['PROCESSING', null, 'STRIPE TEST BANK', '6789']]);

    chargeNowExists(f);
    await f.cleared();

    const [payment, ...others] = await f.payments();
    expect(others).toHaveLength(0);
    expect(payment).toMatchObject({ state: 'SUCCEEDED', stripe_charge_id: f.chargeId, bank_name: 'STRIPE TEST BANK', bank_last4: '6789' });
    expect(payment.paid_at.toISOString()).toBe(new Date(MICRO_CHARGE_CREATED * 1000).toISOString());
    expect((await f.readInvoice()).status).toBe('PAID');
  });

  it('micro-deposits verified after the checkout completed: a debit that then fails keeps the charge id and bank on the FAILED payment', async () => {
    const f = await orgWithInvoice({ total: 500 });
    noChargeYet(f);
    await f.completed();

    chargeNowExists(f);
    await f.failed();

    const [payment] = await f.payments();
    expect(payment).toMatchObject({ state: 'FAILED', stripe_charge_id: f.chargeId, bank_last4: '6789' });
    expect(payment.paid_at.toISOString()).toBe(new Date(MICRO_CHARGE_CREATED * 1000).toISOString());
    expect(Number((await f.readInvoice()).amount_due)).toBe(500);
  });

  it('PROCESSING -> SUCCEEDED on a PARTIAL invoice: the debit for what was left clears it to PAID', async () => {
    const f = await orgWithInvoice({ total: 500, amountDue: 200, status: 'PARTIAL' });
    await f.completed();
    expect((await f.readInvoice()).status).toBe('PARTIAL');

    await f.cleared();

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
  });

  // V7-12a pin (no overpaid invoices, BE-14 row 5): a debit that clears for more than the balance (the
  // balance dropped while it was clearing) is split. The invoice is paid for the balance and never
  // goes over; the excess is an Unapplied OVERPAYMENT item for the office to refund or attach.
  it('a debit that clears for more than the balance: the invoice is PAID for the balance, the excess is an Unapplied OVERPAYMENT', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();
    // While the $500.00 debit clears, $200.00 of credit lowers the balance to $300.00.
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 300 } });

    await f.cleared();

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    const items = await db.unappliedCapture.findMany({ where: { invoice_id: f.invoice } });
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('OVERPAYMENT');
    expect(Number(items[0].amount)).toBe(200);
  });

  it('PROCESSING -> FAILED: the payment is FAILED, the balance is untouched and open for payment again', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await f.failed();

    const [payment] = await f.payments();
    expect(payment.state).toBe('FAILED');
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    const [failedEntry] = await f.history('PAYMENT_FAILED');
    expect(failedEntry.description).toBe('Bank payment failed; the balance is open for payment again');

    // A late "cleared" for the failed debit changes nothing.
    await f.cleared();
    expect((await f.payments()).map((p) => p.state)).toEqual(['FAILED']);

    // Payable-now is back up: a new checkout for the whole balance is booked.
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_again', latest_charge: null });
    await f.deliver('checkout.session.completed', f.session({
      id: `cs_pay13_again_${f.tag}`, payment_intent: `pi_pay13_again_${f.tag}`, payment_status: 'paid',
    }));
    expect((await f.payments()).map((p) => p.state).sort()).toEqual(['FAILED', 'SUCCEEDED']);
    expect((await f.readInvoice()).status).toBe('PAID');
  });

  /** The audit write is fire-and-forget: wait for it to land. */
  async function auditRows(org: string, action: string) {
    for (let i = 0; i < 50; i++) {
      const rows = await db.auditLog.findMany({ where: { org_id: org, action } });
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  }

  it('slice 28b: a bank payment that clears leaves one audit row, once however often the event comes', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await f.cleared();
    await f.cleared();

    const rows = await auditRows(f.org, 'invoice.bank_payment_cleared');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: 'Invoice', resource_id: f.invoice });
    expect(rows[0].metadata).toMatchObject({ amount: 500, method: 'ACH' });
  });

  it('slice 28b: a bank payment that fails leaves one audit row', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await f.failed();

    const rows = await auditRows(f.org, 'invoice.bank_payment_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: 'Invoice', resource_id: f.invoice });
    expect(rows[0].metadata).toMatchObject({ amount: 500, method: 'ACH' });
  });

  it('cleared before completed: the debit is booked SUCCEEDED and PAID once, and the late completion books nothing', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await f.cleared();
    await f.completed();

    const [payment, ...others] = await f.payments();
    expect(others).toHaveLength(0);
    expect(payment).toMatchObject({ method: 'ACH', state: 'SUCCEEDED', bank_last4: '6789', stripe_charge_id: f.chargeId });
    expect(payment.paid_at.toISOString()).toBe(new Date(CHARGE_CREATED * 1000).toISOString());
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(await f.history('INVOICE_PAID')).toHaveLength(1);
  });

  it('failed before completed: the failed debit is written down FAILED, and the late completion books no PROCESSING payment', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await f.failed();
    await f.completed();

    expect((await f.payments()).map((p) => [p.method, p.state])).toEqual([['ACH', 'FAILED']]);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
  });

  /** The invoice turned into the deposit of a signed (PENDING) estimate on a lead, under "deposit required". */
  async function asDeposit(f: Awaited<ReturnType<typeof orgWithInvoice>>) {
    const lead = randomUUID();
    const estimate = randomUUID();
    await db.lead.create({
      data: { id: lead, organization_id: f.org, lead_number: `L-${f.tag}`, customer_id: f.customer, service_request: 'Deposit by bank', status: 'ESTIMATED' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: f.org, lead_id: lead, customer_id: f.customer, created_by: f.user, estimate_number: `E-${f.tag}`,
        status: 'PENDING', signature_data: 'data:image/png;base64,AAAA', signature_at: new Date(), subtotal: 1000, tax_amount: 0, total_amount: 1000,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });
    const depositSession = (over: Record<string, unknown> = {}) =>
      f.session({ metadata: { invoiceId: f.invoice, organizationId: f.org, kind: 'deposit', payableNowCents: '50000', estimateId: estimate }, ...over });
    return {
      lead, estimate,
      completed: () => f.deliver('checkout.session.completed', depositSession()),
      cleared: () => f.deliver('checkout.session.async_payment_succeeded', depositSession({ payment_status: 'paid' })),
      failed: () => f.deliver('checkout.session.async_payment_failed', depositSession()),
      readEstimate: () => db.estimate.findUniqueOrThrow({ where: { id: estimate } }),
      readLead: () => db.lead.findUniqueOrThrow({ where: { id: lead } }),
      estimateHistory: (eventType: string) => db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: estimate, event_type: eventType } }),
    };
  }

  // Conductor ruling 4: a session minted before the close and paid anyway is recorded, not a win.
  it.each(['DECLINED', 'ARCHIVED', 'EXPIRED'] as const)('a deposit paid after its estimate was %s is recorded but does not win the estimate or lead', async (closed) => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);
    await db.estimate.update({ where: { id: d.estimate }, data: { status: closed } });

    await d.completed();

    expect((await d.readEstimate()).status).toBe(closed);
    expect((await d.readLead()).status).toBe('ESTIMATED');
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.approved' } })).toBe(0);
    expect((await f.payments()).map((p) => [p.method, p.state])).toEqual([['ACH', 'PROCESSING']]);
    // Staff can see money arrived on a closed estimate: one audit row naming all three.
    await vi.waitFor(async () => {
      const rows = await db.auditLog.findMany({ where: { org_id: f.org, action: 'estimate.deposit_paid_on_closed_estimate' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].resource_id).toBe(d.estimate);
      expect(rows[0].metadata).toMatchObject({ estimate_id: d.estimate, invoice_id: f.invoice, payment_id: (await f.payments())[0].id });
    });
  });

  it('a deposit paid by bank: the estimate and lead go WON when the debit starts, while the deposit is still owed', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);

    await d.completed();

    const estimate = await d.readEstimate();
    expect(estimate.status).toBe('WON');
    expect(estimate.approved_at).not.toBeNull();
    expect((await d.readLead()).status).toBe('WON');
    // The deposit itself is not collected yet.
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    // The approval is announced once, as any other approval is.
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.approved' } })).toBe(1);
    const [started] = await d.estimateHistory('DEPOSIT_PROCESSING');
    expect(started.description).toBe(`Deposit by bank payment started for estimate E-${f.tag}; it takes a few business days to clear`);
    expect(await d.estimateHistory('DEPOSIT_PAID')).toHaveLength(0);
  });

  it('a deposit paid by bank that clears: the deposit invoice is PAID and the estimate stays approved once', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);
    await d.completed();
    const approvedAt = (await d.readEstimate()).approved_at;

    await d.cleared();

    expect((await f.readInvoice()).status).toBe('PAID');
    const estimate = await d.readEstimate();
    expect(estimate.status).toBe('WON');
    expect(estimate.approved_at).toEqual(approvedAt);
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.approved' } })).toBe(1);
    const [paid] = await d.estimateHistory('DEPOSIT_PAID');
    expect(paid.description).toBe(`Deposit paid by bank payment for estimate E-${f.tag}`);
  });

  it('a deposit paid by bank that fails: the deposit invoice reopens for payment, the estimate and lead stay WON', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);
    await d.completed();

    await d.failed();

    expect((await f.payments()).map((p) => p.state)).toEqual(['FAILED']);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect((await d.readEstimate()).status).toBe('WON');
    expect((await d.readLead()).status).toBe('WON');
  });

  it('a deposit whose bank debit failed before ServWave heard it started approves nothing: the failed debit is written down, the deposit stays owed', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);

    await d.failed();
    await d.completed();

    // The failed debit is on the deposit, FAILED (counted nowhere), and the late completion booked
    // nothing more.
    expect((await f.payments()).map((p) => [p.method, p.state])).toEqual([['ACH', 'FAILED']]);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    // Nothing approved the estimate or won the lead, and no approval was announced.
    expect((await d.readEstimate()).status).toBe('PENDING');
    expect((await d.readLead()).status).toBe('ESTIMATED');
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.approved' } })).toBe(0);
  });

  it('a deposit whose bank debit failed, then paid by card on the pay-again link: the deposit-paid notice and emails go out, the approval is not announced again', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const d = await asDeposit(f);
    await db.customer.update({ where: { id: f.customer }, data: { email: `payer-${f.tag}@example.test` } });
    await d.completed();
    await d.failed();
    expect((await d.readEstimate()).status).toBe('WON');
    const approvedAt = (await d.readEstimate()).approved_at;
    vi.mocked(sendDepositPaymentConfirmation).mockClear();
    vi.mocked(sendDepositPaidAlert).mockClear();
    vi.mocked(sendPaymentReceivedEmail).mockClear();

    retrievePaymentIntent.mockResolvedValue({ id: `pi_pay13_card_${f.tag}`, latest_charge: null });
    await f.deliver('checkout.session.completed', f.session({
      id: `cs_pay13_card_${f.tag}`, payment_intent: `pi_pay13_card_${f.tag}`, payment_status: 'paid', payment_method_types: ['card'],
      metadata: { invoiceId: f.invoice, organizationId: f.org, kind: 'deposit', payableNowCents: '50000', estimateId: d.estimate },
    }));

    expect((await f.payments()).map((p) => [p.method, p.state]).sort()).toEqual([['ACH', 'FAILED'], ['CARD', 'SUCCEEDED']]);
    expect((await f.readInvoice()).status).toBe('PAID');
    // The deposit is paid: the owner and the estimate's creator hear it, the customer gets the deposit receipt.
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.deposit_paid' } })).toBeGreaterThan(0);
    expect(vi.mocked(sendDepositPaymentConfirmation)).toHaveBeenCalledWith(expect.objectContaining({ to: `payer-${f.tag}@example.test` }));
    expect(vi.mocked(sendDepositPaidAlert)).toHaveBeenCalledWith(expect.objectContaining({ to: `admin-${f.tag}@example.test` }));
    // ...and never the generic payment-received email for a deposit (#993).
    expect(vi.mocked(sendPaymentReceivedEmail)).not.toHaveBeenCalled();
    // The estimate was approved when the bank debit started: it is not approved or announced again.
    expect((await d.readEstimate()).approved_at).toEqual(approvedAt);
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'estimate.approved' } })).toBe(1);
    expect(await db.timelineEvent.count({ where: { organization_id: f.org, entity_id: d.lead } })).toBe(1);
  });

  it('concurrent delivery: the cleared event twice at once (same id and another id) lands the money once', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await Promise.all([
      f.cleared({ id: `evt_pay13_${f.tag}_same` }),
      f.cleared({ id: `evt_pay13_${f.tag}_same` }),
      f.cleared({ id: `evt_pay13_${f.tag}_other` }),
    ]);

    expect((await f.payments()).map((p) => p.state)).toEqual(['SUCCEEDED']);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(500);
    expect(await f.history('INVOICE_PAID')).toHaveLength(1);
    expect(await f.history('PAYMENT_RECEIVED')).toHaveLength(1);
  });

  it('concurrent delivery: the failed event twice at once fails the payment once', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await Promise.all([f.failed(), f.failed(), f.failed()]);

    expect((await f.payments()).map((p) => p.state)).toEqual(['FAILED']);
    expect(await f.history('PAYMENT_FAILED')).toHaveLength(1);
    expect(Number((await f.readInvoice()).amount_due)).toBe(500);
  });

  it('concurrent delivery: completed and cleared at the same moment book one payment, SUCCEEDED, and PAID once', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await Promise.all([f.completed(), f.cleared(), f.completed()]);

    expect((await f.payments()).map((p) => p.state)).toEqual(['SUCCEEDED']);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(await f.history('INVOICE_PAID')).toHaveLength(1);
  });

  // ---- Bank returns (slice 09 notes): once bank payments are booked, a return takes the normal path.

  /** A late bank return on this invoice's debit, in the processor's dispute payload shape. */
  const bankReturn = (f: Awaited<ReturnType<typeof orgWithInvoice>>, over: Record<string, unknown> = {}) => ({
    id: `dp_pay13_${f.tag}`, object: 'dispute', amount: 50000, currency: 'usd', status: 'lost', reason: 'insufficient_funds',
    charge: f.chargeId, payment_intent: f.payIntent, evidence_details: { due_by: null },
    payment_method_details: { type: 'us_bank_account' },
    ...over,
  });
  const disputes = (f: Awaited<ReturnType<typeof orgWithInvoice>>) => db.dispute.findMany({ where: { organization_id: f.org } });

  it('a bank return processed before the success event: the payment is FAILED, the return recorded, the balance never reopened, and the late success changes nothing', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();

    await f.deliver('charge.dispute.created', bankReturn(f));

    expect(await disputes(f)).toEqual([expect.objectContaining({ status: 'LOST', is_bank_return: true })]);
    expect((await f.payments()).map((p) => [p.state, p.voided_at])).toEqual([['FAILED', null]]);
    expect(await f.readInvoice()).toMatchObject({ status: 'SENT' });
    expect(Number((await f.readInvoice()).amount_due)).toBe(500);

    await f.cleared();

    expect((await f.payments()).map((p) => p.state)).toEqual(['FAILED']);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect(await f.history('INVOICE_PAID')).toHaveLength(0);
  });

  it('a bank return after the debit cleared: the payment is voided and the balance reopens', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.completed();
    await f.cleared();
    expect((await f.readInvoice()).status).toBe('PAID');

    await f.deliver('charge.dispute.created', bankReturn(f));

    const [payment] = await f.payments();
    expect(payment.state).toBe('SUCCEEDED');
    expect(payment.voided_at).not.toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect(await disputes(f)).toEqual([expect.objectContaining({ status: 'LOST', is_bank_return: true })]);
  });

  it('a bank return arriving before its checkout is booked is refused so the processor retries; once the debit is booked it takes the normal path', async () => {
    const f = await orgWithInvoice({ total: 500 });
    listSessions.mockResolvedValue({
      data: [{ id: `cs_pay13_${f.tag}`, payment_intent: f.payIntent, payment_method_types: ['us_bank_account'], metadata: { invoiceId: f.invoice, organizationId: f.org } }],
      has_more: false,
    });

    const early = await f.deliver('charge.dispute.created', bankReturn(f), { id: `evt_pay13_${f.tag}_return`, status: 503 });
    expect(early.body).toMatchObject({ retry: true });
    expect(await disputes(f)).toHaveLength(0);
    expect(await db.timelineEvent.count({ where: { organization_id: f.org, event_type: 'DISPUTE_ON_UNRECORDED_PAYMENT' } })).toBe(0);

    await f.completed();
    await f.deliver('charge.dispute.created', bankReturn(f), { id: `evt_pay13_${f.tag}_return` });

    expect(await disputes(f)).toEqual([expect.objectContaining({ status: 'LOST', is_bank_return: true })]);
    expect((await f.payments()).map((p) => p.state)).toEqual(['FAILED']);
    expect(Number((await f.readInvoice()).amount_due)).toBe(500);
  });

  // ---- A dispute on another payment opens while the debit clears (fix round 2).

  /**
   * A $100 invoice, PARTIAL after a $50 card payment, with a $50 bank debit booked PROCESSING for
   * the rest. Then the customer disputes the card payment, so the invoice reads DISPUTED.
   */
  async function debitClearingUnderACardDispute() {
    const f = await orgWithInvoice({ total: 100, amountDue: 50, status: 'PARTIAL' });
    const cardCharge = `ch_pay13_card_${f.tag}`;
    await db.payment.create({
      data: {
        invoice_id: f.invoice, amount: 50, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        created_by_source: 'CLIENT', stripe_payment_intent_id: `pi_pay13_card_${f.tag}`, stripe_charge_id: cardCharge,
      },
    });
    await f.completed();
    const cardDispute = (status: string) => ({
      id: `dp_pay13_card_${f.tag}`, object: 'dispute', amount: 5000, currency: 'usd', status, reason: 'fraudulent',
      charge: cardCharge, payment_intent: `pi_pay13_card_${f.tag}`, evidence_details: { due_by: null },
      payment_method_details: { type: 'card' },
    });
    await f.deliver('charge.dispute.created', cardDispute('needs_response'));
    expect((await f.readInvoice()).status).toBe('DISPUTED');
    const ach = async () => (await f.payments()).find((p) => p.method === 'ACH')!;
    return { ...f, cardDispute, ach };
  }

  it('a debit that clears while another payment on the invoice is disputed takes the balance down and keeps the invoice DISPUTED', async () => {
    const f = await debitClearingUnderACardDispute();

    await f.cleared();

    expect((await f.ach()).state).toBe('SUCCEEDED');
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('DISPUTED');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(100);
    // The money was applied, so nothing is written down as "not applied".
    expect(await f.history('PAYMENT_UNRECORDED')).toHaveLength(0);
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'billing.payment_unrecorded' } })).toBe(0);
  });

  it('...and when the dispute is then won, the invoice is PAID with nothing left to pay online', async () => {
    const f = await debitClearingUnderACardDispute();
    await f.cleared();

    vi.mocked(dispatchAutomationEvent).mockClear();

    await f.deliver('charge.dispute.closed', f.cardDispute('won'));

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(100);
    // Slice 29: landing on PAID here is the invoice being paid in full, like any other door: the
    // paid date, the history entry and the INVOICE_PAID automation, once.
    expect(invoice.paid_at).not.toBeNull();
    const [paid, ...more] = await f.history('INVOICE_PAID');
    expect(more).toHaveLength(0);
    expect(paid.description).toBe(`Invoice INV-${f.tag} paid in full`);
    const fired = vi.mocked(dispatchAutomationEvent).mock.calls.filter(([ev]) => ev?.type === 'INVOICE_PAID' && ev?.entity?.id === f.invoice);
    expect(fired).toHaveLength(1);
  });

  it('...and a won dispute on an invoice that was already PAID before it does not pay it a second time', async () => {
    // A $100 invoice paid in full by card, then disputed, then won.
    const f = await orgWithInvoice({ total: 100, amountDue: 0, status: 'PARTIAL' });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PAID', paid_at: new Date('2026-01-01T00:00:00Z') } });
    const cardCharge = `ch_pay13_paid_${f.tag}`;
    await db.payment.create({
      data: {
        invoice_id: f.invoice, amount: 100, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        created_by_source: 'CLIENT', stripe_payment_intent_id: `pi_pay13_paid_${f.tag}`, stripe_charge_id: cardCharge,
      },
    });
    const dispute = (status: string) => ({
      id: `dp_pay13_paid_${f.tag}`, object: 'dispute', amount: 10000, currency: 'usd', status, reason: 'fraudulent',
      charge: cardCharge, payment_intent: `pi_pay13_paid_${f.tag}`, evidence_details: { due_by: null },
      payment_method_details: { type: 'card' },
    });
    await f.deliver('charge.dispute.created', dispute('needs_response'));
    expect((await f.readInvoice()).status).toBe('DISPUTED');
    vi.mocked(dispatchAutomationEvent).mockClear();

    await f.deliver('charge.dispute.closed', dispute('won'));

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    // It was paid before the dispute: its paid date and its one INVOICE_PAID stand as they were.
    expect(invoice.paid_at?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(await f.history('INVOICE_PAID')).toHaveLength(0);
    expect(vi.mocked(dispatchAutomationEvent).mock.calls.filter(([ev]) => ev?.type === 'INVOICE_PAID')).toHaveLength(0);
  });

  it('...and when the dispute is then lost, only the card payment reopens: $50 owed, the bank payment still counted', async () => {
    const f = await debitClearingUnderACardDispute();
    await f.cleared();

    await f.deliver('charge.dispute.closed', f.cardDispute('lost'));

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PARTIAL');
    expect(Number(invoice.amount_due)).toBe(50);
    expect(Number(invoice.net_collected)).toBe(50);
    expect((await f.ach())).toMatchObject({ state: 'SUCCEEDED', voided_at: null });
  });
  // ---- V7-13 part 2 (N-13): the processor may send BOTH a bank return and async_payment_failed for one return. -----------
  // Either order: exactly one customer email, one history row and one failed payment (so one Needs-attention item).
  describe('one bank return, announced twice (a return and a failed debit), in either order', () => {
    async function withEmail() {
      const f = await orgWithInvoice({ total: 500 });
      await db.customer.update({ where: { id: f.customer }, data: { email: `pat-${f.tag}@example.test` } });
      await db.invoice.update({ where: { id: f.invoice }, data: { public_token: `tok-${f.tag}` } });
      return f;
    }
    const asked = (f: { org: string }) => db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } });
    const alerts = (f: { org: string }, verb: string) => db.notification.findMany({ where: { organization_id: f.org, verb } });

    it('the return first, then the failed event: one email, one history row, one failed payment', async () => {
      const f = await withEmail();
      await f.completed();
      await f.deliver('charge.dispute.created', bankReturn(f));
      await f.failed();

      expect(failedSender).toHaveBeenCalledTimes(1);
      expect(failedSender.mock.calls[0][0]).toMatchObject({ amount: 500, payUrl: expect.stringContaining(`/p/invoices/${f.invoice}`) });
      const payments = await f.payments();
      expect(payments.map((p) => p.state)).toEqual(['FAILED']);
      const rows = await asked(f);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ item_key: `failed_payment:${payments[0].id}` });
      expect(await alerts(f, 'billing.bank_payment_failed')).toHaveLength(0);
      const [alert, ...more] = await alerts(f, 'billing.chargeback');
      expect(more).toHaveLength(0);
      // Early return (the debit never cleared): never "taken back".
      expect(alert.body).toBe('The bank returned this payment before it cleared, so no money reached your ServWave Payments balance. The invoice is still open and we emailed the customer a link to pay again.');
      expect((await f.readInvoice()).status).toBe('SENT');
    });

    it('the failed event first, then the return: one email, one history row, one failed payment', async () => {
      const f = await withEmail();
      await f.completed();
      await f.failed();
      await f.deliver('charge.dispute.created', bankReturn(f));

      expect(failedSender).toHaveBeenCalledTimes(1);
      const payments = await f.payments();
      expect(payments.map((p) => p.state)).toEqual(['FAILED']);
      expect(await asked(f)).toHaveLength(1);
      expect(await alerts(f, 'billing.bank_payment_failed')).toHaveLength(1);
      // The return finds the payment already failed: it voids nothing, and its alert claims no balance and no customer step.
      expect((await alerts(f, 'billing.chargeback'))[0].body).toBeNull();
      expect(await disputes(f)).toEqual([expect.objectContaining({ status: 'LOST', is_bank_return: true })]);
      expect((await f.readInvoice()).status).toBe('SENT');
    });
  });

  // N-18: how the Payments table reads the payment after each kind of return.
  it('a late return reads "Charged back" in the Payments table and an early one reads "Failed"', async () => {
    const readStatus = async (f: Awaited<ReturnType<typeof orgWithInvoice>>) => {
      const [p] = await f.payments();
      return paymentDisplayStatus({
        state: p.state, amount: Number(p.amount), succeededRefundTotal: 0, voidedAt: p.voided_at, voidCategory: p.void_category,
        openDispute: false, refundFailedOpen: false,
      });
    };
    const late = await orgWithInvoice({ total: 500 });
    await late.completed();
    await late.cleared();
    await late.deliver('charge.dispute.created', bankReturn(late));
    expect(await readStatus(late)).toBe('Charged back');

    const early = await orgWithInvoice({ total: 500 });
    await early.completed();
    await early.deliver('charge.dispute.created', bankReturn(early));
    expect(await readStatus(early)).toBe('Failed');
  });
});
