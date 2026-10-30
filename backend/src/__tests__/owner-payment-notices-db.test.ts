/* =============================================================================
   Payments go-live, slice 32 - the owner hears about every payment event that needs them.

   Through the real webhook route, with a real migrated database (TEST_DATABASE_URL; skips when
   unset). Each reconciler action produces ONE in-app notification and ONE owner email; a replayed
   event produces none; a notice whose payment this event did not move is not sent at all. The
   words themselves are covered in services/notifications/__tests__/owner-payment-templates.test.ts.
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

import { getStripeForOrg, createRefund, listPaymentIntentRefunds } from '../lib/stripe';
import { sendOwnerPaymentNoticeEmail, sendBankPaymentProcessingEmail, sendBankPaymentFailedEmail, sendPaymentReceivedEmail } from '../lib/email';
import { applyActions } from '../services/payment-reconciler/apply';
import { supabaseAdmin } from '../lib/supabase';

const ownerEmail = sendOwnerPaymentNoticeEmail as unknown as ReturnType<typeof vi.fn>;
const processingSender = sendBankPaymentProcessingEmail as unknown as ReturnType<typeof vi.fn>;
const failedSender = sendBankPaymentFailedEmail as unknown as ReturnType<typeof vi.fn>;
const receiptSender = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;
const retrievePaymentIntent = vi.fn();
const sessionsList = vi.fn();
/** Bearer token -> the admin it signs in as (each org's admin has its own). */
const sessions = new Map<string, { id: string; email: string }>();
const refundsCreate = createRefund as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;
const VENDOR_NAMES = /stripe|connect\b|plaid|resend|supabase|render\.com|\bach\b/i;

suite('owner payment notifications (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 90_000);
  beforeEach(() => {
    for (const fn of [ownerEmail, processingSender, failedSender, receiptSender]) fn.mockClear();
    retrievePaymentIntent.mockReset();
    sessionsList.mockReset().mockResolvedValue({ data: [], has_more: false });
    refundsCreate.mockReset();
    vi.mocked(supabaseAdmin.auth.getUser).mockImplementation((async (token: string) => (
      sessions.has(token) ? { data: { user: sessions.get(token) }, error: null } : { data: { user: null }, error: { message: 'invalid token' } }
    )) as never);
    vi.mocked(listPaymentIntentRefunds).mockReset().mockResolvedValue([]);
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
        checkout: { sessions: { list: sessionsList } },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  /** An org with an admin, a customer and a sent invoice; the doors to deliver processor events to. */
  async function fixture(opts: { total?: number; status?: 'SENT' | 'PAID' | 'PARTIAL' } = {}) {
    const total = opts.total ?? 500;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay32_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay32-${tag}`, email: `pay32-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    const user = randomUUID();
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    // A second active admin and an inactive one: the email goes to active admins only.
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `admin2-${tag}@example.test`, first_name: 'Second', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `gone-${tag}@example.test`, first_name: 'Gone', last_name: 'Admin', role: 'ADMIN', is_active: false },
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
        status: opts.status ?? 'SENT', public_token: `tok-${randomUUID()}`,
      },
    });
    const payIntent = `pi_pay32_${tag}`;
    retrievePaymentIntent.mockResolvedValue({
      id: payIntent,
      latest_charge: {
        id: `py_pay32_${tag}`, object: 'charge', created: 1789990000, amount: total * 100,
        payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
      },
    });
    let seq = 0;
    const session = (over: Record<string, unknown> = {}) => ({
      id: `cs_pay32_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'complete',
      payment_intent: payIntent, amount_total: total * 100, currency: 'usd', payment_method_types: ['us_bank_account'],
      metadata: { invoiceId: invoice, organizationId: org, kind: 'invoice', payableNowCents: String(total * 100) },
      ...over,
    });
    const deliver = async (type: string, object: object, id?: string) => {
      const event = { id: id ?? `evt_pay32_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: 1790000000, account, data: { object } };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    const notices = (verb: string) => db.notification.findMany({ where: { organization_id: org, verb }, orderBy: { created_at: 'asc' } });
    /** The owner emails sent for this org, newest call last. */
    const ownerEmails = () => ownerEmail.mock.calls.map((c) => c[0] as {
      organizationId: string; to: string; subject: string; heading: string; lines: string[]; actionUrl: string; actionLabel: string;
    }).filter((m) => m.organizationId === org);
    return {
      org, tag, invoice, customer, user, total, account, payIntent, session, deliver, notices, ownerEmails,
      adminEmails: [`admin-${tag}@example.test`, `admin2-${tag}@example.test`],
      completed: (id?: string) => deliver('checkout.session.completed', session(), id),
      cleared: (id?: string) => deliver('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' }), id),
      failed: (id?: string) => deliver('checkout.session.async_payment_failed', session(), id),
    };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM unapplied_captures WHERE organization_id = '${org}'`));
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
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay32_%'`));
    await db.$disconnect();
  });

  // ---- bank payments ------------------------------------------------------------------------

  describe('a bank payment', () => {
    it('starting notifies the owner once, in-app and by email to every active admin, with the invoice link', async () => {
      const f = await fixture({ total: 500 });

      await f.completed();

      await vi.waitFor(async () => expect(await f.notices('billing.bank_payment_started')).toHaveLength(1));
      const [notice] = await f.notices('billing.bank_payment_started');
      expect(notice.title).toBe(`Bank payment started for INV-${f.tag} — Pat Payer`);
      expect(notice.body).toContain('$500.00');
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      expect(f.ownerEmails().map((m) => m.to).sort()).toEqual([...f.adminEmails].sort());
      expect(f.ownerEmails()[0]).toMatchObject({ subject: notice.title, actionUrl: `http://localhost:5173/invoices/${f.invoice}` });
      expect(f.ownerEmails()[0].lines.join(' ')).toContain('$500.00');
    });

    it('clearing notifies the owner once; the same outcome again (another event id) notifies nobody, owner or customer', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));

      await f.cleared();
      await f.cleared();

      await vi.waitFor(async () => expect(await f.notices('billing.bank_payment_cleared')).toHaveLength(1));
      const [notice] = await f.notices('billing.bank_payment_cleared');
      expect(notice.title).toBe(`Bank payment cleared for INV-${f.tag} — Pat Payer`);
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(4));
      expect(f.ownerEmails().filter((m) => m.subject === notice.title)).toHaveLength(2);
      expect(receiptSender).toHaveBeenCalledTimes(1);
    });

    it('a debit that clears before its completion arrives still notifies the owner once', async () => {
      const f = await fixture({ total: 500 });

      await f.cleared();

      await vi.waitFor(async () => expect(await f.notices('billing.bank_payment_cleared')).toHaveLength(1));
    });

    it('failing interrupts the owner once, saying the customer was sent a link to pay again', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();

      await f.failed();

      await vi.waitFor(async () => expect(await f.notices('billing.bank_payment_failed')).toHaveLength(1));
      const [notice] = await f.notices('billing.bank_payment_failed');
      expect(notice).toMatchObject({ priority: 'INTERRUPT', needs_action: true, title: `Bank payment failed for INV-${f.tag} — Pat Payer` });
      expect(notice.body).toMatch(/pay again/i);
      const mails = f.ownerEmails().filter((m) => m.subject === notice.title);
      expect(mails.map((m) => m.to).sort()).toEqual([...f.adminEmails].sort());
    });

    it('the same event delivered twice notifies the owner once', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      const id = `evt_pay32_${f.tag}_dup`;

      await f.cleared(id);
      await f.cleared(id);

      await vi.waitFor(async () => expect(await f.notices('billing.bank_payment_cleared')).toHaveLength(1));
      expect(f.ownerEmails().filter((m) => m.subject.startsWith('Bank payment cleared'))).toHaveLength(2);
    });

    it('notices name no vendor', async () => {
      const f = await fixture({ total: 500 });
      await f.completed();
      await f.cleared();
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(4));

      const rows = await db.notification.findMany({ where: { organization_id: f.org } });
      for (const row of rows) expect(`${row.title} ${row.body ?? ''}`).not.toMatch(VENDOR_NAMES);
      for (const mail of f.ownerEmails()) expect(`${mail.subject} ${mail.heading} ${mail.lines.join(' ')} ${mail.actionLabel}`).not.toMatch(VENDOR_NAMES);
    });
  });

  // ---- disputes -----------------------------------------------------------------------------

  describe('a dispute', () => {
    const DUE_BY = Math.floor(new Date('2026-10-20T12:00:00Z').getTime() / 1000);

    /** A paid invoice with one succeeded payment, by card or by bank, and the disputes against it. */
    async function paid(method: 'CARD' | 'ACH') {
      const f = await fixture({ total: 300, status: 'PAID' });
      const charge = `ch_pay32_${f.tag}`;
      await db.payment.create({
        data: {
          invoice_id: f.invoice, amount: 300, method, state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'CLIENT',
          stripe_payment_intent_id: f.payIntent, stripe_charge_id: charge, stripe_account_id: f.account,
        },
      });
      const dispute = (status: string, over: Record<string, unknown> = {}) => ({
        id: `dp_pay32_${f.tag}`, object: 'dispute', amount: 30000, currency: 'usd', status,
        reason: method === 'CARD' ? 'fraudulent' : 'insufficient_funds', charge, payment_intent: f.payIntent,
        evidence_details: { due_by: method === 'CARD' ? DUE_BY : null },
        payment_method_details: { type: method === 'CARD' ? 'card' : 'us_bank_account' },
        ...over,
      });
      return { f, dispute };
    }

    it('opening tells the owner the amount, the reason and the evidence deadline, once, in-app and by email', async () => {
      const { f, dispute } = await paid('CARD');

      await f.deliver('charge.dispute.created', dispute('needs_response'));

      await vi.waitFor(async () => expect(await f.notices('billing.disputed')).toHaveLength(1));
      const [notice] = await f.notices('billing.disputed');
      expect(notice.title).toBe(`Payment disputed for INV-${f.tag} — Pat Payer`);
      expect(notice.body).toBe('Amount: $300.00. Reason: Fraudulent. Respond by October 20, 2026.');
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      expect(f.ownerEmails().map((m) => m.to).sort()).toEqual([...f.adminEmails].sort());
      // Slice 33b: the bell and the email both open the disputes tab, where the owner answers.
      expect(notice.data).toMatchObject({ link_path: '/payments?tab=payments&chip=disputed' });
      expect(f.ownerEmails()[0]).toMatchObject({ subject: notice.title, actionUrl: 'http://localhost:5173/payments?tab=payments&chip=disputed' });
      expect(f.ownerEmails()[0].lines).toEqual([notice.body]);
    });

    it('an update to the same dispute, or a replay of the opening, tells nobody again', async () => {
      const { f, dispute } = await paid('CARD');
      const id = `evt_pay32_${f.tag}_open`;
      await f.deliver('charge.dispute.created', dispute('needs_response'), id);
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));

      await f.deliver('charge.dispute.created', dispute('needs_response'), id);
      await f.deliver('charge.dispute.updated', dispute('under_review'));

      expect(await f.notices('billing.disputed')).toHaveLength(1);
      expect(f.ownerEmails()).toHaveLength(2);
    });

    it('a lost dispute tells the owner how much was taken back, once', async () => {
      const { f, dispute } = await paid('CARD');
      await f.deliver('charge.dispute.created', dispute('needs_response'));

      await f.deliver('charge.dispute.closed', dispute('lost'));

      await vi.waitFor(async () => expect(await f.notices('billing.chargeback')).toHaveLength(1));
      const [notice] = await f.notices('billing.chargeback');
      expect(notice.body).toBe('Amount: $300.00 was taken back from your ServWave Payments balance.');
      await vi.waitFor(() => expect(f.ownerEmails().filter((m) => m.subject === notice.title)).toHaveLength(2));
    });

    it('a lost and a closed dispute also open the disputes tab', async () => {
      const { f, dispute } = await paid('CARD');
      await f.deliver('charge.dispute.created', dispute('needs_response'));
      await f.deliver('charge.dispute.closed', dispute('lost'));
      await vi.waitFor(async () => expect(await f.notices('billing.chargeback')).toHaveLength(1));
      const [lost] = await f.notices('billing.chargeback');
      expect(lost.data).toMatchObject({ link_path: '/payments?tab=payments&chip=disputed' });

      const other = await paid('CARD');
      await other.f.deliver('charge.dispute.created', other.dispute('needs_response'));
      await other.f.deliver('charge.dispute.closed', other.dispute('won'));
      await vi.waitFor(async () => expect(await other.f.notices('billing.dispute_closed')).toHaveLength(1));
      const [won] = await other.f.notices('billing.dispute_closed');
      expect(won.data).toMatchObject({ link_path: '/payments?tab=payments&chip=disputed' });
    });

    it('a won dispute tells the owner it was won, once', async () => {
      const { f, dispute } = await paid('CARD');
      await f.deliver('charge.dispute.created', dispute('needs_response'));

      await f.deliver('charge.dispute.closed', dispute('won'));

      await vi.waitFor(async () => expect(await f.notices('billing.dispute_closed')).toHaveLength(1));
      const [notice] = await f.notices('billing.dispute_closed');
      expect(notice.title).toBe(`Dispute won for INV-${f.tag} — Pat Payer`);
      expect(notice.body).toBe('Amount: $300.00. It was decided in your favor and the payment stands.');
      await vi.waitFor(() => expect(f.ownerEmails().filter((m) => m.subject === notice.title)).toHaveLength(2));
    });

    it('a dispute that ends without a chargeback says so', async () => {
      const { f, dispute } = await paid('CARD');
      await f.deliver('charge.dispute.created', dispute('warning_needs_response'));

      await f.deliver('charge.dispute.closed', dispute('warning_closed'));

      await vi.waitFor(async () => expect(await f.notices('billing.dispute_closed')).toHaveLength(1));
      expect((await f.notices('billing.dispute_closed'))[0].title).toBe(`Dispute closed for INV-${f.tag} — Pat Payer`);
    });

    it('a dispute on money written down as not applied still reaches the owner, by email too, with the amount', async () => {
      const f = await fixture({ total: 450, status: 'PAID' });
      const session = `cs_pay32_${f.tag}_unapplied`;
      const pi = `pi_pay32_${f.tag}_unapplied`;
      await db.timelineEvent.create({
        data: {
          organization_id: f.org, entity_type: 'INVOICE', entity_id: f.invoice, event_type: 'PAYMENT_UNRECORDED',
          description: 'Card payment was not recorded.', metadata: { reason: 'AMOUNT_MISMATCH', checkout_session: session, payment_intent: pi },
        },
      });
      sessionsList.mockResolvedValue({
        data: [{ id: session, payment_intent: pi, payment_method_types: ['card'], metadata: { invoiceId: f.invoice, organizationId: f.org } }],
        has_more: false,
      });

      await f.deliver('charge.dispute.created', {
        id: `dp_pay32_${f.tag}_unapplied`, object: 'dispute', amount: 45000, currency: 'usd', status: 'needs_response', reason: 'fraudulent',
        charge: `ch_pay32_${f.tag}_unapplied`, payment_intent: pi, evidence_details: { due_by: null }, payment_method_details: { type: 'card' },
      });

      const [notice] = await f.notices('billing.disputed');
      expect(notice).toBeDefined();
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      expect(f.ownerEmails()[0].subject).toBe(notice.title);
      expect(f.ownerEmails()[0].lines[0]).toMatch(/not recorded/i);
    });

    it('a bank payment returned after it cleared is worded as the bank taking it back', async () => {
      const { f, dispute } = await paid('ACH');

      await f.deliver('charge.dispute.created', dispute('needs_response'));

      await vi.waitFor(async () => expect(await f.notices('billing.disputed')).toHaveLength(1));
      const [notice] = await f.notices('billing.disputed');
      expect(notice.title).toBe(`Bank returned the payment for INV-${f.tag} — Pat Payer`);
      expect(notice.body).toBe('The bank took back $300.00. Reason: Insufficient funds.');
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      for (const mail of f.ownerEmails()) expect(`${mail.subject} ${mail.lines.join(' ')}`).not.toMatch(VENDOR_NAMES);
    });
  });

  // ---- refunds that fail --------------------------------------------------------------------

  describe('a refund that fails', () => {
    /** A paid invoice with one succeeded payment and a refund of it still on its way out. */
    async function refundOnItsWay(method: 'CARD' | 'ACH') {
      const f = await fixture({ total: 100, status: 'PAID' });
      const payment = await db.payment.create({
        data: {
          invoice_id: f.invoice, amount: 100, method, state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'CLIENT',
          stripe_payment_intent_id: f.payIntent, stripe_charge_id: `ch_pay32_${f.tag}`, stripe_account_id: f.account,
        },
      });
      const refundId = `re_pay32_${f.tag}`;
      await db.refund.create({
        data: {
          invoice_id: f.invoice, payment_id: payment.id, amount: 40, tax_portion: 0, non_taxable_concession: false, method,
          reason: 'slice 32 test', reason_category: 'CUSTOMER_REQUEST', from_unapplied_capture: false,
          stripe_refund_id: refundId, state: 'PENDING', refunded_by: f.user, organization_id: f.org,
        },
      });
      const failedEvent = (id?: string, status = 'failed') => f.deliver(status === 'failed' ? 'refund.failed' : 'refund.updated', {
        id: refundId, object: 'refund', amount: 4000, currency: 'usd', status, payment_intent: f.payIntent, charge: `ch_pay32_${f.tag}`,
      }, id);
      return { f, payment, refundId, failedEvent };
    }

    it('a bank refund that fails tells the owner the money is back and the customer still needs repaying, once', async () => {
      const { f, failedEvent } = await refundOnItsWay('ACH');
      const id = `evt_pay32_${f.tag}_refund_fail`;

      await failedEvent(id);
      await failedEvent(id);
      await failedEvent();

      await vi.waitFor(async () => expect(await f.notices('billing.refund_failed')).toHaveLength(1));
      const [notice] = await f.notices('billing.refund_failed');
      expect(notice).toMatchObject({ priority: 'INTERRUPT', needs_action: true, title: `Refund failed for INV-${f.tag} — Pat Payer` });
      expect(notice.body).toBe('A bank refund of $40.00 to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.');
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      expect(f.ownerEmails().map((m) => m.to).sort()).toEqual([...f.adminEmails].sort());
      expect(f.ownerEmails()[0]).toMatchObject({ subject: notice.title, lines: [notice.body], actionUrl: `http://localhost:5173/invoices/${f.invoice}` });
      expect(f.ownerEmails()).toHaveLength(2);
    });

    it('a card refund that fails says "A refund"', async () => {
      const { f, failedEvent } = await refundOnItsWay('CARD');

      await failedEvent();

      await vi.waitFor(async () => expect(await f.notices('billing.refund_failed')).toHaveLength(1));
      expect((await f.notices('billing.refund_failed'))[0].body).toMatch(/^A refund of \$40\.00 to Pat Payer failed\./);
    });

    it('a refund sent for a payment needing attention that fails tells the owner too', async () => {
      const f = await fixture({ total: 100, status: 'PAID' });
      const payment = await db.payment.create({
        data: {
          invoice_id: f.invoice, amount: 150, method: 'ACH', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'CLIENT',
          stripe_payment_intent_id: f.payIntent, stripe_account_id: f.account,
        },
      });
      const refundId = `re_pay32_${f.tag}_list`;
      await db.unappliedCapture.create({
        data: {
          organization_id: f.org, invoice_id: f.invoice, reason: 'OVERPAYMENT', amount: 50, status: 'REFUNDED',
          stripe_refund_id: refundId, refunded_at: new Date(), stripe_payment_intent_id: f.payIntent, stripe_account_id: f.account,
          source_key: `payment:${payment.id}`,
        },
      });

      await f.deliver('refund.failed', {
        id: refundId, object: 'refund', amount: 5000, currency: 'usd', status: 'failed', payment_intent: f.payIntent, charge: `ch_pay32_${f.tag}`,
      });

      await vi.waitFor(async () => expect(await f.notices('billing.refund_failed')).toHaveLength(1));
      expect((await f.notices('billing.refund_failed'))[0].body).toBe('A bank refund of $50.00 to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.');
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
    });

    it('a refund that succeeds notifies nobody of a failure', async () => {
      const { f, failedEvent } = await refundOnItsWay('ACH');

      await failedEvent(undefined, 'succeeded');

      expect(await f.notices('billing.refund_failed')).toHaveLength(0);
      expect(f.ownerEmails()).toHaveLength(0);
    });
  });

  // ---- money that could not be applied ------------------------------------------------------

  describe('a card payment', () => {
    it('payment received shows its amount (slice 33b)', async () => {
      const f = await fixture({ total: 500 });

      await f.deliver('checkout.session.completed', f.session({ payment_status: 'paid', payment_method_types: ['card'], amount_total: 50000 }));

      await vi.waitFor(async () => expect(await f.notices('billing.payment_received')).toHaveLength(1));
      const [notice] = await f.notices('billing.payment_received');
      expect(notice.body).toBe('Amount: $500.00');
    });
  });

  describe('money that could not be applied', () => {
    /** A card checkout paid for the wrong amount: the system refuses to apply it and writes it down. */
    async function refusedCapture() {
      const f = await fixture({ total: 500 });
      sessions.set(`pay32-${f.tag}`, { id: f.user, email: `admin-${f.tag}@example.test` });
      await f.deliver('checkout.session.completed', f.session({ payment_status: 'paid', payment_method_types: ['card'], amount_total: 40000 }));
      await vi.waitFor(async () => expect(await f.notices('billing.payment_unrecorded')).toHaveLength(1));
      const [alert] = await f.notices('billing.payment_unrecorded');
      const record = await db.unappliedCapture.findFirstOrThrow({ where: { organization_id: f.org } });
      const bearer = `Bearer pay32-${f.tag}`;
      const unreadFor = () => db.notificationRecipient.count({ where: { notification_id: alert.id, read_at: null } });
      return { f, alert, record, bearer, unreadFor };
    }

    it('notifies the owner once, in-app and by email, and both open the Payments page on the attention chip', async () => {
      const { f, alert } = await refusedCapture();

      expect(alert.data).toMatchObject({ link_path: '/payments?tab=payments&chip=attention' });
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));
      expect(f.ownerEmails().map((m) => m.to).sort()).toEqual([...f.adminEmails].sort());
      expect(f.ownerEmails()[0]).toMatchObject({ subject: alert.title, lines: [alert.body], actionUrl: 'http://localhost:5173/payments?tab=payments&chip=attention' });
      expect(`${alert.title} ${alert.body}`).not.toMatch(VENDOR_NAMES);
    });

    it('a replay of the same event notifies nobody again', async () => {
      const f = await fixture({ total: 500 });
      const id = `evt_pay32_${f.tag}_capture`;
      const paid = f.session({ payment_status: 'paid', payment_method_types: ['card'], amount_total: 40000 });
      await f.deliver('checkout.session.completed', paid, id);
      await vi.waitFor(() => expect(f.ownerEmails()).toHaveLength(2));

      await f.deliver('checkout.session.completed', paid, id);

      expect(await f.notices('billing.payment_unrecorded')).toHaveLength(1);
      expect(f.ownerEmails()).toHaveLength(2);
    });

    it('marking the row resolved clears the alert', async () => {
      const { f, record, bearer, unreadFor } = await refusedCapture();
      expect(await unreadFor()).toBeGreaterThan(0);

      const res = await request(app).post(`/api/payments-needing-attention/${record.id}/resolve`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(await unreadFor()).toBe(0);
      expect(f.org).toBeTruthy();
    });

    it('refunding the row from the list clears the alert', async () => {
      const { record, bearer, unreadFor } = await refusedCapture();
      refundsCreate.mockResolvedValue({ id: `re_pay32_${record.id.slice(0, 8)}`, object: 'refund', status: 'succeeded', amount: 40000 });

      const res = await request(app).post(`/api/payments-needing-attention/${record.id}/refund`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(await unreadFor()).toBe(0);
    });

    it('the processor confirming a refund sent for the row clears the alert', async () => {
      const { f, record, unreadFor } = await refusedCapture();
      expect(await unreadFor()).toBeGreaterThan(0);

      await f.deliver('refund.created', {
        id: `re_pay32_${f.tag}_event`, object: 'refund', amount: 40000, currency: 'usd', status: 'succeeded',
        payment_intent: f.payIntent, charge: null, metadata: { unapplied_capture_id: record.id },
      });

      expect(await unreadFor()).toBe(0);
    });

    /** What an alert raised before slice 32 looks like: the same row, but no source key in its data. */
    const asOlderAlert = (alertId: string) => db.$executeRaw`
      UPDATE notifications SET data = data - 'source_key' WHERE id = ${alertId}::uuid`;

    it('an alert raised before slice 32 (no source key) clears too after Mark resolved', async () => {
      const { alert, record, bearer, unreadFor } = await refusedCapture();
      await asOlderAlert(alert.id);
      expect(await unreadFor()).toBeGreaterThan(0);

      const res = await request(app).post(`/api/payments-needing-attention/${record.id}/resolve`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(await unreadFor()).toBe(0);
    });

    it('an alert raised before slice 32 clears after Refund', async () => {
      const { alert, record, bearer, unreadFor } = await refusedCapture();
      await asOlderAlert(alert.id);
      refundsCreate.mockResolvedValue({ id: `re_pay33b_${record.id.slice(0, 8)}`, object: 'refund', status: 'succeeded', amount: 40000 });

      const res = await request(app).post(`/api/payments-needing-attention/${record.id}/refund`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(await unreadFor()).toBe(0);
    });

    it('an older alert of another org is left alone', async () => {
      const mine = await refusedCapture();
      const theirs = await refusedCapture();
      await asOlderAlert(mine.alert.id);
      await asOlderAlert(theirs.alert.id);

      await request(app).post(`/api/payments-needing-attention/${mine.record.id}/resolve`).set('Authorization', mine.bearer);

      expect(await mine.unreadFor()).toBe(0);
      expect(await theirs.unreadFor()).toBeGreaterThan(0);
    });

    it('another org\'s alert is left alone', async () => {
      const mine = await refusedCapture();
      const theirs = await refusedCapture();

      await request(app).post(`/api/payments-needing-attention/${mine.record.id}/resolve`).set('Authorization', mine.bearer);

      expect(await mine.unreadFor()).toBe(0);
      expect(await theirs.unreadFor()).toBeGreaterThan(0);
    });
  });

  // ---- a notice goes out only when this event moved the payment ------------------------------

  describe('a bank notice that this event did not cause', () => {
    /** A payment that already left PROCESSING, and the decision a stale snapshot would have made. */
    async function settledElsewhere(kind: 'cleared' | 'failed') {
      const f = await fixture({ total: 500 });
      const payment = await db.payment.create({
        data: {
          invoice_id: f.invoice, amount: 500, method: 'ACH', state: kind === 'cleared' ? 'FAILED' : 'SUCCEEDED', paid_at: new Date(),
          created_by_source: 'CLIENT', stripe_payment_intent_id: f.payIntent, stripe_account_id: f.account,
        },
      });
      return { f, payment };
    }

    for (const kind of ['cleared', 'failed'] as const) {
      it(`a "${kind}" notice is dropped when the payment had already left processing`, async () => {
        const { f, payment } = await settledElsewhere(kind);

        const effects = await db.$transaction((tx) => applyActions(tx, [
          { type: 'settle_payment', paymentId: payment.id, invoiceId: f.invoice, to: kind === 'cleared' ? 'SUCCEEDED' : 'FAILED' },
          { type: 'notify_bank_payment', kind, invoiceId: f.invoice, amountCents: 50000, deposit: false, payAgain: kind === 'failed' },
        ], { organizationId: f.org, eventId: `evt_pay32_${f.tag}_stale` }));

        expect(effects.bankNotices).toEqual([]);
      });
    }

    it('control: the same pair on a payment that is still processing keeps its notice, tagged with the event', async () => {
      const f = await fixture({ total: 500 });
      const payment = await db.payment.create({
        data: {
          invoice_id: f.invoice, amount: 500, method: 'ACH', state: 'PROCESSING', paid_at: new Date(),
          created_by_source: 'CLIENT', stripe_payment_intent_id: f.payIntent, stripe_account_id: f.account,
        },
      });

      const effects = await db.$transaction((tx) => applyActions(tx, [
        { type: 'settle_payment', paymentId: payment.id, invoiceId: f.invoice, to: 'FAILED' },
        { type: 'notify_bank_payment', kind: 'failed', invoiceId: f.invoice, amountCents: 50000, deposit: false, payAgain: true },
      ], { organizationId: f.org, eventId: `evt_pay32_${f.tag}_live` }));

      expect(effects.bankNotices).toHaveLength(1);
      expect(effects.bankNotices[0]).toMatchObject({ kind: 'failed', eventId: `evt_pay32_${f.tag}_live` });
    });
  });
});
