/* =============================================================================
   Payments go-live, slice 09 - disputes and late bank returns go through the reconciler.

   Before: the webhook controller's switch flagged the invoice DISPUTED and kept one dispute id on
   it, with no record of the dispute's status, reason, amount or evidence deadline. A won dispute put
   the invoice back to PAID whatever its refunds said, and an org that had since turned card off had
   every dispute event dropped by the accepted-methods gate.

   Events are posted to the real webhook route in the processor's payload shape for the pinned
   version (a dispute names its charge and payment intent). Real migrated database
   (TEST_DATABASE_URL); skips when unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import { supabaseAdmin } from '../lib/supabase';
import { applyActions } from '../services/payment-reconciler/apply';
import { systemVoidPaymentForChargeback } from '../controllers/invoice.controller';
import { rederiveRefundTotals, settlePayment } from '../lib/payment-ledger';
import type { LedgerAction } from '../services/payment-reconciler/decide';

const suite = realClient ? describe : describe.skip;

/** The processor's checkout sessions, as the unmatched-dispute check lists them by payment intent. */
const sessionsList = vi.fn();

suite('disputes through the reconciler (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    // By default the processor knows no ServWave checkout for the disputed charge.
    sessionsList.mockReset().mockResolvedValue({ data: [], has_more: false });
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        checkout: { sessions: { list: sessionsList } },
        paymentIntents: { retrieve: vi.fn().mockResolvedValue({ latest_charge: null }) },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  /**
   * An org with a connected account, an admin, a customer and one invoice of $total, paid online by
   * one SUCCEEDED payment (card by default) the processor can dispute.
   */
  async function paidInvoice(opts: { total?: number; tip?: number; method?: 'CARD' | 'ACH'; accepts?: ('CARD' | 'ACH')[] } = {}) {
    const total = opts.total ?? 500;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const payment = randomUUID();
    const account = `acct_pay09_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay09-${tag}`, email: `pay09-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: opts.accepts ?? ['CARD'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: 0, net_collected: total, status: 'PAID', paid_at: new Date(),
      },
    });
    await db.payment.create({
      data: {
        id: payment, invoice_id: invoice, amount: total, tip_amount: opts.tip ?? null, method: opts.method ?? 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: `pi_pay09_${tag}`, stripe_charge_id: `ch_pay09_${tag}`, stripe_account_id: account,
        created_by_source: 'CLIENT',
      },
    });
    let seq = 0;
    /** A dispute object, as charge.dispute.* carries it. */
    const dispute = (over: Record<string, unknown> = {}) => ({
      id: `dp_pay09_${tag}`, object: 'dispute', amount: total * 100, currency: 'usd', status: 'needs_response',
      reason: 'fraudulent', charge: `ch_pay09_${tag}`, payment_intent: `pi_pay09_${tag}`,
      evidence_details: { due_by: 1791000000, has_evidence: false, past_due: false, submission_count: 0 },
      is_charge_refundable: false, livemode: false, metadata: {},
      ...over,
    });
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object, opts2: { id?: string; account?: string; status?: number } = {}) => {
      const event = {
        id: opts2.id ?? `evt_pay09_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia',
        type, created: 1790000000, account: opts2.account ?? account,
        data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(opts2.status ?? 200);
      return res;
    };
    const disputes = () => db.dispute.findMany({ where: { organization_id: org } });
    const readInvoice = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const readPayment = () => db.payment.findUniqueOrThrow({ where: { id: payment } });
    const timeline = (eventType: string) => db.timelineEvent.findMany({ where: { organization_id: org, event_type: eventType } });
    const notifications = (verb: string) => db.notification.findMany({ where: { organization_id: org, verb } });
    return { org, tag, invoice, payment, account, user, customer, dispute, deliver, disputes, readInvoice, readPayment, timeline, notifications };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
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
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay09_%'`));
    await db.$disconnect();
  });

  it('a dispute opened on a card payment is recorded once, with its status, reason, amount and evidence deadline; the invoice reads DISPUTED', async () => {
    const f = await paidInvoice({ total: 500 });

    await f.deliver('charge.dispute.created', f.dispute());

    const [row, ...others] = await f.disputes();
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({
      stripe_dispute_id: `dp_pay09_${f.tag}`, invoice_id: f.invoice, payment_id: f.payment,
      status: 'NEEDS_RESPONSE', reason: 'fraudulent', is_bank_return: false, closed_at: null,
    });
    expect(Number(row.amount)).toBe(500);
    expect(row.evidence_due_by?.toISOString()).toBe(new Date(1791000000 * 1000).toISOString());
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('DISPUTED');
    expect(Number(invoice.amount_due)).toBe(0);
    // The owner is told (no user behind it, one alert per dispute id), and the history says so
    // without naming the processor.
    const [alert, ...more] = await f.notifications('billing.disputed');
    expect(more).toHaveLength(0);
    expect(alert).toMatchObject({ actor_id: null, object_id: f.invoice, dedup_key: expect.stringContaining(`dp_pay09_${f.tag}`) });
    expect(alert.title).not.toMatch(/stripe/i);
    const [entry] = await f.timeline('INVOICE_DISPUTED');
    expect(entry.description).not.toMatch(/stripe/i);
  });

  it('an update moves the recorded dispute to its new status; the invoice stays DISPUTED and the money is untouched', async () => {
    const f = await paidInvoice();
    await f.deliver('charge.dispute.created', f.dispute());
    await f.deliver('charge.dispute.updated', f.dispute({ status: 'under_review', evidence_details: { due_by: 1791086400 } }));

    const [row] = await f.disputes();
    expect(row).toMatchObject({ status: 'UNDER_REVIEW', closed_at: null });
    expect(row.evidence_due_by?.toISOString()).toBe(new Date(1791086400 * 1000).toISOString());
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
    expect((await f.readPayment()).voided_at).toBeNull();
  });

  it('closed won: the invoice returns to PAID, the payment stands, net collected unchanged', async () => {
    const f = await paidInvoice({ total: 500 });
    await f.deliver('charge.dispute.created', f.dispute());
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'won' }));

    const [row] = await f.disputes();
    expect(row.status).toBe('WON');
    expect(row.closed_at).not.toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice).toMatchObject({ status: 'PAID', stripe_dispute_id: null });
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(500);
    expect((await f.readPayment()).voided_at).toBeNull();
    const [won] = await f.timeline('INVOICE_DISPUTE_WON');
    expect(won.description).not.toMatch(/stripe/i);
  });

  it('closed won on an invoice partly refunded before the dispute: back to PARTIALLY_REFUNDED, not PAID', async () => {
    const f = await paidInvoice({ total: 500 });
    await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payment, amount: 150, method: 'CARD', reason_category: 'CUSTOMER_REQUEST',
        state: 'SUCCEEDED', refunded_by: f.user, organization_id: f.org, stripe_refund_id: `re_pay09_${f.tag}`,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIALLY_REFUNDED', total_refunded: 150, net_collected: 350 } });

    await f.deliver('charge.dispute.created', f.dispute({ amount: 35000 }));
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 35000, status: 'won' }));

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PARTIALLY_REFUNDED');
    expect(Number(invoice.total_refunded)).toBe(150);
    expect(Number(invoice.net_collected)).toBe(350);
  });

  it('closed lost: the payment is voided as a chargeback and the balance reopens', async () => {
    const f = await paidInvoice({ total: 500 });
    await f.deliver('charge.dispute.created', f.dispute());
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'lost' }));

    const [row] = await f.disputes();
    expect(row.status).toBe('LOST');
    const payment = await f.readPayment();
    expect(payment.voided_at).not.toBeNull();
    expect(payment.void_category).toBe('CHARGEBACK');
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect(Number(invoice.net_collected)).toBe(0);
    expect(invoice.stripe_dispute_id).toBeNull(); // a lost dispute leaves no pointer on the payable-again invoice (slice 35)
    const [chargeback, ...more] = await f.notifications('billing.chargeback');
    expect(more).toHaveLength(0);
    expect(chargeback).toMatchObject({ actor_id: null, object_id: f.invoice, dedup_key: expect.stringContaining(`dp_pay09_${f.tag}`) });
  });

  // Conductor ruling 2026-10-07: voiding the whole payment would reopen more than the processor
  // took back, so a partial loss leaves the payment and the balance alone and is flagged instead.
  it('closed lost for less than the payment ($40 of $100): recorded LOST, the payment stands, the balance is not reopened, the owner is told to review it', async () => {
    const f = await paidInvoice({ total: 100 });
    await f.deliver('charge.dispute.created', f.dispute({ amount: 4000 }));
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 4000, status: 'lost' }));

    const [row] = await f.disputes();
    expect(row.status).toBe('LOST');
    expect(Number(row.amount)).toBe(40);
    expect((await f.readPayment()).voided_at).toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect(Number(invoice.net_collected)).toBe(100);
    expect(await f.timeline('CHARGEBACK')).toHaveLength(0);
    const [flag, ...more] = await f.timeline('CHARGEBACK_PARTIAL');
    expect(more).toHaveLength(0);
    expect(flag.description).toMatch(/\$40\.00/);
    expect(flag.description).toMatch(/manual review/i);
    expect(flag.description).not.toMatch(/stripe/i);
    const [alert] = await f.notifications('billing.chargeback');
    expect(alert.title).toMatch(/part of a payment/i);
    expect(alert.title).not.toMatch(/stripe/i);
  });

  // The dispute amount is what the card was charged (the tip included); the payment row holds the
  // face amount and the tip apart. A $100 invoice paid with a $20 tip was charged $120.
  it('a tipped payment ($100 + $20 tip) lost for the whole $120 charged: the payment is voided and the $100 balance reopens', async () => {
    const f = await paidInvoice({ total: 100, tip: 20 });
    await f.deliver('charge.dispute.created', f.dispute({ amount: 12000 }));
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 12000, status: 'lost' }));

    expect((await f.readPayment()).voided_at).not.toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(100);
    expect(await f.timeline('CHARGEBACK_PARTIAL')).toHaveLength(0);
  });

  it('a tipped payment ($100 + $20 tip) lost for only $100: $20 is still held, so nothing is voided or reopened and the balance is flagged', async () => {
    const f = await paidInvoice({ total: 100, tip: 20 });
    await f.deliver('charge.dispute.created', f.dispute({ amount: 10000 }));
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 10000, status: 'lost' }));

    expect((await f.readPayment()).voided_at).toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    const [flag, ...more] = await f.timeline('CHARGEBACK_PARTIAL');
    expect(more).toHaveLength(0);
    expect(flag.description).toMatch(/\$100\.00 of the \$120\.00 payment/);
  });

  it('closed lost for exactly what is left of a partly refunded payment keeps void-and-reopen', async () => {
    const f = await paidInvoice({ total: 100 });
    await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payment, amount: 60, method: 'CARD', reason_category: 'CUSTOMER_REQUEST',
        state: 'SUCCEEDED', refunded_by: f.user, organization_id: f.org, stripe_refund_id: `re_pay09_${f.tag}`,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIALLY_REFUNDED', total_refunded: 60, net_collected: 40 } });
    // $60 went back as a refund and the dispute took the other $40: the contractor kept nothing.
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 4000, status: 'lost' }));

    const [row, ...others] = await f.disputes();
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({ status: 'LOST', payment_id: f.payment });
    expect(Number(row.amount)).toBe(40);
    const payment = await f.readPayment();
    expect(payment.voided_at).not.toBeNull();
    expect(payment.void_category).toBe('CHARGEBACK');
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(100);
    expect(Number(invoice.net_collected)).toBe(0);
    expect(Number(invoice.total_refunded)).toBe(60);
    expect(await f.timeline('CHARGEBACK')).toHaveLength(1);
    expect(await f.timeline('CHARGEBACK_PARTIAL')).toHaveLength(0);
  });

  it('an inquiry that closed without a chargeback is written as closed, not as won', async () => {
    const f = await paidInvoice({ total: 500 });
    await f.deliver('charge.dispute.created', f.dispute({ status: 'warning_needs_response' }));
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'warning_closed' }));

    expect((await f.disputes())[0].status).toBe('CLOSED');
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', stripe_dispute_id: null });
    expect(await f.timeline('INVOICE_DISPUTE_WON')).toHaveLength(0);
    const [closed] = await f.timeline('INVOICE_DISPUTE_CLOSED');
    expect(closed.description).not.toMatch(/in your favor/i);
    expect(closed.description).toMatch(/closed without a chargeback/i);
  });

  it("after a lost dispute the customer's invoice page no longer lists the payment the processor took back", async () => {
    const f = await paidInvoice({ total: 500 });
    const token = `pt_pay09_${f.tag}`;
    await db.invoice.update({ where: { id: f.invoice }, data: { public_token: token } });
    await f.deliver('charge.dispute.created', f.dispute());
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'lost' }));

    const res = await request(app).get(`/api/invoices/${f.invoice}/public`).query({ token });
    expect(res.status).toBe(200);
    expect(res.body.invoice.payments).toEqual([]);
    expect(Number(res.body.invoice.amount_due)).toBe(500);
  });

  // A voided payment did not happen, whoever voided it: the page hides staff voids too.
  it("the customer's invoice page does not list a payment staff voided either", async () => {
    const f = await paidInvoice({ total: 500 });
    const token = `pt_pay09_${f.tag}_staff`;
    await db.invoice.update({ where: { id: f.invoice }, data: { public_token: token, status: 'SENT', amount_due: 500, net_collected: 0 } });
    await db.payment.update({
      where: { id: f.payment },
      data: { voided_at: new Date(), voided_by: f.user, voided_reason: 'Recorded in error', void_category: 'ERROR' },
    });
    const kept = await db.payment.create({
      data: { invoice_id: f.invoice, amount: 100, method: 'CASH', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
    });

    const res = await request(app).get(`/api/invoices/${f.invoice}/public`).query({ token });
    expect(res.status).toBe(200);
    expect(res.body.invoice.payments.map((p: { id: string }) => p.id)).toEqual([kept.id]);
  });

  // A voided payment is not counted, so a dispute on it never marks the invoice DISPUTED.
  it('a dispute on a payment staff already voided is recorded, and the SENT invoice stays SENT', async () => {
    const f = await paidInvoice({ total: 500 });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'SENT', amount_due: 500, net_collected: 0, paid_at: null } });
    await db.payment.update({
      where: { id: f.payment },
      data: { voided_at: new Date(), voided_by: f.user, voided_reason: 'Recorded in error', void_category: 'ERROR' },
    });
    await f.deliver('charge.dispute.created', f.dispute());

    const [row, ...others] = await f.disputes();
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({ status: 'NEEDS_RESPONSE', payment_id: f.payment });
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
  });

  it('closed lost on a payment partly refunded before the dispute: net collected is 0, not minus the refund', async () => {
    const f = await paidInvoice({ total: 500 });
    await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payment, amount: 150, method: 'CARD', reason_category: 'CUSTOMER_REQUEST',
        state: 'SUCCEEDED', refunded_by: f.user, organization_id: f.org, stripe_refund_id: `re_pay09_${f.tag}`,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIALLY_REFUNDED', total_refunded: 150, net_collected: 350 } });

    // The customer disputed what was left (350) and won it back: the contractor kept nothing.
    await f.deliver('charge.dispute.created', f.dispute({ amount: 35000 }));
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 35000, status: 'lost' }));

    const invoice = await f.readInvoice();
    expect((await f.readPayment()).voided_at).not.toBeNull();
    expect(Number(invoice.net_collected)).toBe(0);
    // The refund still happened: it stays on record.
    expect(Number(invoice.total_refunded)).toBe(150);
  });

  /**
   * A $500 invoice whose first payment was partly refunded ($150) and then charged back (the dispute
   * took the other $350), and which the customer then paid again in full with a second card payment.
   */
  async function repaidAfterChargeback() {
    const f = await paidInvoice({ total: 500 });
    await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: f.payment, amount: 150, method: 'CARD', reason_category: 'CUSTOMER_REQUEST',
        state: 'SUCCEEDED', refunded_by: f.user, organization_id: f.org, stripe_refund_id: `re_pay09_${f.tag}`,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIALLY_REFUNDED', total_refunded: 150, net_collected: 350 } });
    await f.deliver('charge.dispute.closed', f.dispute({ amount: 35000, status: 'lost' }));
    expect(await f.readInvoice()).toMatchObject({ status: 'SENT' });
    const repaid = await db.payment.create({
      data: {
        invoice_id: f.invoice, amount: 500, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: `pi_pay09_${f.tag}_b`, stripe_charge_id: `ch_pay09_${f.tag}_b`, stripe_account_id: f.account,
        created_by_source: 'CLIENT',
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PAID', amount_due: 0, net_collected: 500, paid_at: new Date() } });
    const disputeB = (over: Record<string, unknown> = {}) => f.dispute({
      id: `dp_pay09_${f.tag}_b`, charge: `ch_pay09_${f.tag}_b`, payment_intent: `pi_pay09_${f.tag}_b`, ...over,
    });
    return { ...f, repaid: repaid.id, disputeB };
  }

  // A refund on a payment that was charged back came out of money that has left the ledger whole:
  // it is no more part of the invoice's refund status than of its net collected.
  it('a won dispute on an invoice re-paid in full after a charged-back, partly refunded payment returns it to PAID, not PARTIALLY_REFUNDED', async () => {
    const f = await repaidAfterChargeback();
    await f.deliver('charge.dispute.created', f.disputeB());
    await f.deliver('charge.dispute.closed', f.disputeB({ status: 'won' }));

    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.net_collected)).toBe(500);
    expect(Number(invoice.total_refunded)).toBe(150);
    // Each dispute keeps its own record: the first stays lost, the second closes won.
    const byId = new Map((await f.disputes()).map((d) => [d.stripe_dispute_id, d]));
    expect(byId.get(`dp_pay09_${f.tag}`)).toMatchObject({ status: 'LOST', payment_id: f.payment });
    expect(byId.get(`dp_pay09_${f.tag}_b`)).toMatchObject({ status: 'WON', payment_id: f.repaid });
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.repaid } })).voided_at).toBeNull();
  });

  /** Staff signed in as the fixture's admin; one token per fixture (the auth layer caches by token). */
  function signedIn(f: { tag: string; user: string }) {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: f.user, email: `admin-${f.tag}@example.test` } },
      error: null,
    });
    return (path: string, body: object) => request(app).post(path).set('Authorization', `Bearer pay09-${f.tag}`).send(body);
  }

  it('an in-app refund on an invoice holding a charged-back, refunded payment leaves that refund out of net collected', async () => {
    const f = await repaidAfterChargeback();
    const post = signedIn(f);

    const res = await post(`/api/invoices/${f.invoice}/refund`, {
      amount: 100, payment_id: f.repaid, reason_category: 'CUSTOMER_REQUEST', reason: 'Goodwill on the second payment',
    });
    expect(res.status).toBe(200);

    const invoice = await f.readInvoice();
    // Paid $500 that still stands, $100 of it given back; the $150 refund left with the charged-back payment.
    expect(Number(invoice.net_collected)).toBe(400);
    expect(Number(invoice.total_refunded)).toBe(250);
    expect(invoice.status).toBe('PARTIALLY_REFUNDED');
  });

  it('a give-back through the credit door on an invoice holding a charged-back, refunded payment leaves that refund out of net collected', async () => {
    const f = await repaidAfterChargeback();
    const post = signedIn(f);

    const res = await post(`/api/invoices/${f.invoice}/credit`, { amount: 100, reason: 'Overpaid by the customer' });
    expect(res.status).toBe(200);

    const invoice = await f.readInvoice();
    expect(Number(invoice.net_collected)).toBe(400);
    expect(Number(invoice.total_refunded)).toBe(250);
  });

  /**
   * A $1,000 invoice that took a $400 card payment and was then voided by staff (voidInvoice
   * refuses only PAID and VOIDED, so a PARTIAL invoice carrying a real card payment can be voided).
   */
  async function voidedInvoiceWithCardPayment(opts: { method?: 'CARD' | 'ACH'; accepts?: ('CARD' | 'ACH')[] } = {}) {
    const f = await paidInvoice({ total: 400, ...opts });
    await db.invoice.update({
      where: { id: f.invoice },
      data: { total_amount: 1000, subtotal: 1000, amount_due: 600, net_collected: 400, status: 'VOIDED', paid_at: null, voided_at: new Date(), voided_reason: 'Customer cancelled' },
    });
    return f;
  }

  it('closed lost on a payment that sits on a voided invoice: the payment is voided, the invoice stays VOIDED with its balance untouched', async () => {
    const f = await voidedInvoiceWithCardPayment();
    await f.deliver('charge.dispute.created', f.dispute());
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'lost' }));

    const [row] = await f.disputes();
    expect(row.status).toBe('LOST');
    const payment = await f.readPayment();
    expect(payment.voided_at).not.toBeNull();
    expect(payment.void_category).toBe('CHARGEBACK');
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('VOIDED');
    expect(Number(invoice.amount_due)).toBe(600);
    expect(invoice.voided_at).not.toBeNull();
    const [chargeback] = await f.timeline('CHARGEBACK');
    expect(chargeback.description).not.toMatch(/balance reopened/i);
  });

  it('a late bank return on a payment that sits on a voided invoice leaves the invoice VOIDED with its balance untouched', async () => {
    const f = await voidedInvoiceWithCardPayment({ method: 'ACH', accepts: ['ACH'] });
    await f.deliver('charge.dispute.created', f.dispute({
      status: 'lost', reason: 'insufficient_funds', payment_method_details: { type: 'us_bank_account' },
    }));

    expect((await f.disputes())[0]).toMatchObject({ status: 'LOST', is_bank_return: true });
    expect((await f.readPayment()).voided_at).not.toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('VOIDED');
    expect(Number(invoice.amount_due)).toBe(600);
  });

  it('a late bank return (a dispute on a bank payment, lost when raised) takes the same path, worded as a bank return', async () => {
    const f = await paidInvoice({ total: 500, method: 'ACH', accepts: ['ACH'] });
    await f.deliver('charge.dispute.created', f.dispute({
      status: 'lost', reason: 'insufficient_funds', payment_method_details: { type: 'us_bank_account' },
    }));

    const [row, ...others] = await f.disputes();
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({ status: 'LOST', is_bank_return: true, reason: 'insufficient_funds' });
    expect((await f.readPayment()).voided_at).not.toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    const [opened] = await f.notifications('billing.disputed');
    expect(opened.title).toMatch(/bank returned/i);
    const [chargeback] = await f.timeline('CHARGEBACK');
    expect(chargeback.description).toMatch(/bank returned the payment/i);
  });

  // Webhook order is not guaranteed: a bank return can arrive while the bank payment is still
  // PROCESSING (its "cleared" event not yet processed, or being retried). That payment never took
  // the balance down, so voiding it and adding its amount back would bill the customer twice.
  it('a bank return on a bank payment still clearing fails the payment; the balance it never took down is not reopened, and the later cleared event changes nothing', async () => {
    const f = await paidInvoice({ total: 500, method: 'ACH', accepts: ['ACH'] });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'SENT', amount_due: 500, net_collected: 0, paid_at: null } });
    await db.payment.update({ where: { id: f.payment }, data: { state: 'PROCESSING' } });

    await f.deliver('charge.dispute.created', f.dispute({
      status: 'lost', reason: 'insufficient_funds', payment_method_details: { type: 'us_bank_account' },
    }));

    expect((await f.disputes())[0]).toMatchObject({ status: 'LOST', is_bank_return: true });
    expect(await f.readPayment()).toMatchObject({ state: 'FAILED', voided_at: null });
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    expect(await f.timeline('CHARGEBACK')).toHaveLength(0);
    const [entry, ...more] = await f.timeline('PAYMENT_RETURNED');
    expect(more).toHaveLength(0);
    expect(entry.description).toMatch(/bank returned the payment of \$500\.00/i);
    expect(entry.description).not.toMatch(/stripe/i);
    const [alert] = await f.notifications('billing.chargeback');
    expect(alert.title).toMatch(/bank payment returned/i);

    // The cleared event lands late: the payment is no longer clearing, so nothing is applied.
    const late = await settlePayment({ paymentId: f.payment, organizationId: f.org, to: 'SUCCEEDED' });
    expect(late.changed).toBe(false);
    const after = await f.readInvoice();
    expect(after.status).toBe('SENT');
    expect(Number(after.amount_due)).toBe(500);
    expect((await f.readPayment()).state).toBe('FAILED');
  });

  // The void re-reads the payment under the invoice lock: one that is not SUCCEEDED (it moved
  // after the snapshot, or a stale action names it) never had its amount taken off the balance.
  it('the chargeback void, handed a payment still clearing, neither voids it nor reopens the balance', async () => {
    const f = await paidInvoice({ total: 500, method: 'ACH', accepts: ['ACH'] });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'SENT', amount_due: 500, net_collected: 0, paid_at: null } });
    await db.payment.update({ where: { id: f.payment }, data: { state: 'PROCESSING' } });

    await db.$transaction((tx) => applyActions(tx, [{
      type: 'void_disputed_payment', paymentId: f.payment, invoiceId: f.invoice, processorDisputeId: `dp_pay09_${f.tag}`,
      bankReturn: true, stayDisputed: false,
    }], { organizationId: f.org, eventId: `evt_pay09_${f.tag}_stale` }));

    expect(await f.readPayment()).toMatchObject({ state: 'PROCESSING', voided_at: null });
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
  });

  it('the same dispute delivered again, under the same or another event id, is recorded once and announced once', async () => {
    const f = await paidInvoice();
    await f.deliver('charge.dispute.created', f.dispute(), { id: `evt_pay09_${f.tag}_dup` });
    const replay = await f.deliver('charge.dispute.created', f.dispute(), { id: `evt_pay09_${f.tag}_dup` });
    expect(replay.body).toMatchObject({ duplicate: true });
    await f.deliver('charge.dispute.created', f.dispute());
    expect(await f.disputes()).toHaveLength(1);
    expect(await f.notifications('billing.disputed')).toHaveLength(1);
    expect(await f.timeline('INVOICE_DISPUTED')).toHaveLength(1);
  });

  it('two deliveries of a new dispute at the same moment record it once', async () => {
    const f = await paidInvoice();
    await Promise.all([1, 2, 3].map((n) => f.deliver('charge.dispute.created', f.dispute(), { id: `evt_pay09_${f.tag}_race${n}` })));
    expect(await f.disputes()).toHaveLength(1);
    expect(await f.timeline('INVOICE_DISPUTED')).toHaveLength(1);
  });

  it('closed arriving before created: recorded and closed once; the late created event changes nothing', async () => {
    const f = await paidInvoice({ total: 500 });
    await f.deliver('charge.dispute.closed', f.dispute({ status: 'won' }));
    await f.deliver('charge.dispute.created', f.dispute());

    const [row, ...others] = await f.disputes();
    expect(others).toHaveLength(0);
    expect(row.status).toBe('WON');
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  // The processor can send a dispute before the payment it names is booked (its dispute test card
  // does, half a second ahead of the completed checkout). That event must not be marked processed,
  // or its retry or resend is answered as a duplicate and the dispute is lost.
  it('a dispute that arrives before its ServWave checkout payment is booked is refused so the processor retries; delivered again once the payment exists, it is recorded', async () => {
    const f = await paidInvoice({ total: 500 });
    const early = f.dispute({ charge: `ch_pay09_${f.tag}_late`, payment_intent: `pi_pay09_${f.tag}_late` });
    const id = `evt_pay09_${f.tag}_early`;
    // The processor knows the charge's checkout: ServWave built it for this org's invoice.
    sessionsList.mockResolvedValue({
      data: [{ id: `cs_pay09_${f.tag}`, payment_intent: `pi_pay09_${f.tag}_late`, metadata: { invoiceId: f.invoice, organizationId: f.org } }],
      has_more: false,
    });

    const first = await f.deliver('charge.dispute.created', early, { id, status: 503 });
    expect(first.body).not.toMatchObject({ received: true });
    expect(sessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: `pi_pay09_${f.tag}_late` }),
      { stripeAccount: f.account },
    );
    expect(await f.disputes()).toHaveLength(0);

    // The checkout is booked: the payment now carries the charge the dispute names.
    await db.payment.update({
      where: { id: f.payment },
      data: { stripe_charge_id: `ch_pay09_${f.tag}_late`, stripe_payment_intent_id: `pi_pay09_${f.tag}_late` },
    });
    const again = await f.deliver('charge.dispute.created', early, { id });
    expect(again.body).not.toMatchObject({ duplicate: true });
    expect(await f.disputes()).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
    expect(await f.notifications('billing.disputed')).toHaveLength(1);
  });

  // The unmatched-dispute check (conductor ruling 2026-10-07): a dispute whose charge matches no
  // payment is ignored only once the processor shows no ServWave checkout behind it. With no payment
  // intent there is nothing to look up, so it is acknowledged without asking.
  it('a dispute on a charge ServWave never created is ignored once the processor shows no ServWave checkout behind it; one naming no payment intent is ignored without asking', async () => {
    const f = await paidInvoice({ total: 500 });
    const foreign = f.dispute({ id: `dp_pay09_${f.tag}_foreign`, charge: `ch_pay09_${f.tag}_foreign`, payment_intent: `pi_pay09_${f.tag}_foreign` });

    const res = await f.deliver('charge.dispute.created', foreign, { status: 200 });
    expect(res.body).toMatchObject({ received: true });
    expect(sessionsList).toHaveBeenCalledTimes(1);
    expect(sessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: `pi_pay09_${f.tag}_foreign` }),
      { stripeAccount: f.account },
    );
    expect(await f.disputes()).toHaveLength(0);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });

    sessionsList.mockClear();
    const none = f.dispute({ id: `dp_pay09_${f.tag}_none`, charge: `ch_pay09_${f.tag}_none`, payment_intent: null });
    const res2 = await f.deliver('charge.dispute.created', none, { status: 200 });
    expect(res2.body).toMatchObject({ received: true });
    expect(sessionsList).not.toHaveBeenCalled();
    expect(await f.disputes()).toHaveLength(0);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  // A checkout the reconciler wrote down as an unapplied capture (not payable, wrong amount, deposit
  // on hold, another document) never gets a payment row, so a dispute on it can never be matched
  // by retrying. It is acknowledged, written down where the capture is, and the owner is told:
  // money sitting in "needs attention" is exactly what an owner might refund, crediting the
  // customer twice.
  it('a dispute on a checkout written down as an unapplied capture is acknowledged, recorded once where the capture sits, and the owner is alerted', async () => {
    const f = await paidInvoice({ total: 500 });
    const session = `cs_pay09_${f.tag}_unapplied`;
    const pi = `pi_pay09_${f.tag}_unapplied`;
    await db.timelineEvent.create({
      data: {
        organization_id: f.org, entity_type: 'INVOICE', entity_id: f.invoice, event_type: 'PAYMENT_UNRECORDED',
        description: 'Card payment was not recorded: the amount paid does not match the amount owed.',
        metadata: { reason: 'AMOUNT_MISMATCH', checkout_session: session, payment_intent: pi, expected_cents: 50000, charged_cents: 45000 },
      },
    });
    sessionsList.mockResolvedValue({
      data: [{ id: session, payment_intent: pi, payment_method_types: ['card'], metadata: { invoiceId: f.invoice, organizationId: f.org } }],
      has_more: false,
    });
    const onCapture = f.dispute({ id: `dp_pay09_${f.tag}_unapplied`, amount: 45000, charge: `ch_pay09_${f.tag}_unapplied`, payment_intent: pi });

    const res = await f.deliver('charge.dispute.created', onCapture, { status: 200 });
    expect(res.body).toMatchObject({ received: true });
    await f.deliver('charge.dispute.created', onCapture, { status: 200 });

    expect(await f.disputes()).toHaveLength(0);
    const [entry, ...more] = await f.timeline('DISPUTE_ON_UNRECORDED_PAYMENT');
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({ entity_type: 'INVOICE', entity_id: f.invoice });
    expect(entry.description).toMatch(/disputed a card payment of \$450\.00 on invoice INV-/i);
    expect(entry.description).toMatch(/not recorded/i);
    expect(entry.description).not.toMatch(/stripe/i);
    const [alert, ...moreAlerts] = await f.notifications('billing.disputed');
    expect(moreAlerts).toHaveLength(0);
    expect(alert).toMatchObject({ object_type: 'INVOICE', object_id: f.invoice });
    expect(alert.body).toMatch(/not recorded/i);
    expect(`${alert.title} ${alert.body}`).not.toMatch(/stripe/i);

    // Lost: the money left; nothing ServWave recorded changes, and the owner is told.
    await f.deliver('charge.dispute.closed', { ...onCapture, status: 'lost' }, { status: 200 });
    expect(await f.timeline('DISPUTE_ON_UNRECORDED_PAYMENT')).toHaveLength(2);
    const [lost] = await f.notifications('billing.chargeback');
    expect(lost).toMatchObject({ object_id: f.invoice });
    expect(lost.body).toMatch(/not recorded/i);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    expect((await f.readPayment()).voided_at).toBeNull();
  });

  // Slice 13 books bank checkouts like card ones, so a return on one not booked yet is retried (see
  // ach-payment-lifecycle-db.test.ts). A bank debit that cleared on an invoice that could not take
  // it was written down as unapplied and never gets a payment row; staff may have recorded the money
  // by hand with no processor ids. A late bank return on it can never be matched by retrying.
  it('a bank return on a bank checkout written down as not applied is acknowledged, recorded on its invoice, and the owner is told to check any hand-recorded payment', async () => {
    const f = await paidInvoice({ total: 500, method: 'ACH', accepts: ['ACH'] });
    // Recorded by hand: no processor ids on the payment.
    await db.payment.update({ where: { id: f.payment }, data: { stripe_payment_intent_id: null, stripe_charge_id: null, created_by_source: 'USER' } });
    const pi = `pi_pay09_${f.tag}_bank`;
    sessionsList.mockResolvedValue({
      data: [{ id: `cs_pay09_${f.tag}_bank`, payment_intent: pi, payment_method_types: ['us_bank_account'], metadata: { invoiceId: f.invoice, organizationId: f.org } }],
      has_more: false,
    });
    // The reconciler wrote the cleared debit down as a bank payment not applied, on its invoice.
    await db.timelineEvent.create({
      data: {
        organization_id: f.org, entity_type: 'INVOICE', entity_id: f.invoice, event_type: 'PAYMENT_UNRECORDED',
        description: 'Bank payment was not recorded', metadata: { reason: 'INVOICE_NOT_PAYABLE', checkout_session: `cs_pay09_${f.tag}_bank` },
      },
    });

    const res = await f.deliver('charge.dispute.created', f.dispute({
      id: `dp_pay09_${f.tag}_bank`, status: 'lost', reason: 'insufficient_funds', charge: `ch_pay09_${f.tag}_bank`, payment_intent: pi,
      payment_method_details: { type: 'us_bank_account' },
    }), { status: 200 });
    expect(res.body).toMatchObject({ received: true });

    expect(await f.disputes()).toHaveLength(0);
    const [entry, ...more] = await f.timeline('DISPUTE_ON_UNRECORDED_PAYMENT');
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({ entity_type: 'INVOICE', entity_id: f.invoice });
    expect(entry.description).toMatch(/bank returned a payment of \$500\.00 on invoice INV-/i);
    expect(entry.description).toMatch(/recorded by hand/i);
    const [alert] = await f.notifications('billing.chargeback');
    expect(alert.title).toMatch(/bank payment returned/i);
    expect(alert.body).toMatch(/recorded by hand/i);
    // ServWave cannot tell which hand-recorded payment it was: nothing is voided or reopened.
    expect((await f.readPayment()).voided_at).toBeNull();
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);

    // A raised event arriving after the final one adds nothing.
    await f.deliver('charge.dispute.created', f.dispute({
      id: `dp_pay09_${f.tag}_bank`, status: 'needs_response', charge: `ch_pay09_${f.tag}_bank`, payment_intent: pi,
      payment_method_details: { type: 'us_bank_account' },
    }), { status: 200 });
    expect(await f.timeline('DISPUTE_ON_UNRECORDED_PAYMENT')).toHaveLength(1);
    expect(await f.notifications('billing.disputed')).toHaveLength(0);
  });

  it('a dispute on money written down on the org (no invoice of this org carries it) is recorded on the org, never on another invoice', async () => {
    const f = await paidInvoice({ total: 500 });
    const theirs = await paidInvoice({ total: 500 });
    const session = `cs_pay09_${f.tag}_onorg`;
    const pi = `pi_pay09_${f.tag}_onorg`;
    await db.timelineEvent.create({
      data: {
        organization_id: f.org, entity_type: 'ORGANIZATION', entity_id: f.org, event_type: 'PAYMENT_UNRECORDED',
        description: 'Card payment was not recorded: it does not belong to any invoice in this account.',
        metadata: { reason: 'WRONG_ORG', checkout_session: session, payment_intent: pi },
      },
    });
    sessionsList.mockResolvedValue({
      data: [{ id: session, payment_intent: pi, payment_method_types: ['card'], metadata: { invoiceId: theirs.invoice } }],
      has_more: false,
    });

    await f.deliver('charge.dispute.created', f.dispute({ id: `dp_pay09_${f.tag}_onorg`, charge: `ch_pay09_${f.tag}_onorg`, payment_intent: pi }), { status: 200 });

    const [entry] = await f.timeline('DISPUTE_ON_UNRECORDED_PAYMENT');
    expect(entry).toMatchObject({ entity_type: 'ORGANIZATION', entity_id: f.org });
    expect(entry.description).toMatch(/in this account/);
    expect(entry.description).not.toContain(`INV-${theirs.tag}`);
    const [alert] = await f.notifications('billing.disputed');
    expect(alert).toMatchObject({ object_type: 'ORGANIZATION', object_id: f.org });
    expect(await theirs.timeline('DISPUTE_ON_UNRECORDED_PAYMENT')).toHaveLength(0);
    expect(await theirs.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  it('an org that has since stopped accepting card still gets the dispute on the card payment it already took', async () => {
    const f = await paidInvoice({ accepts: [] });
    await f.deliver('charge.dispute.created', f.dispute());
    expect(await f.disputes()).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
  });

  it("an event on one org's account naming another org's charge never touches that org's invoice or payment", async () => {
    const victim = await paidInvoice();
    const other = await paidInvoice();
    await other.deliver('charge.dispute.created', victim.dispute());
    await other.deliver('charge.dispute.closed', victim.dispute({ status: 'lost' }));

    expect(await victim.disputes()).toHaveLength(0);
    expect(await victim.readInvoice()).toMatchObject({ status: 'PAID' });
    expect((await victim.readPayment()).voided_at).toBeNull();
    expect(await other.disputes()).toHaveLength(0);
    expect(await other.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  // The credit cascade predates slice 09 (the old chargeback branch ran the same system void); the
  // dispute record and the re-derived net collected are new.
  it('a lost dispute on a deposit un-applies the credit it gave the job invoice, and is recorded as LOST', async () => {
    const f = await paidInvoice({ total: 200 });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT' } });
    const target = randomUUID();
    await db.invoice.create({
      data: {
        id: target, organization_id: f.org, customer_id: f.customer, invoice_number: `INV-${f.tag}-J`,
        subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 800, status: 'PARTIAL',
      },
    });
    await db.payment.create({
      data: { invoice_id: target, amount: 200, method: 'OTHER', state: 'SUCCEEDED', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT' },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO deposit_credit_applications (id, deposit_invoice_id, target_invoice_id, amount, organization_id) VALUES ('${randomUUID()}', '${f.invoice}', '${target}', 200, '${f.org}')`,
    );

    await f.deliver('charge.dispute.closed', f.dispute({ amount: 20000, status: 'lost' }));

    const app = await db.depositCreditApplication.findFirstOrThrow({ where: { deposit_invoice_id: f.invoice } });
    expect(app.reversed_at).not.toBeNull();
    const job = await db.invoice.findUniqueOrThrow({ where: { id: target } });
    expect(Number(job.amount_due)).toBe(1000);
    const credit = await db.payment.findFirstOrThrow({ where: { invoice_id: target, reference_number: 'DEPOSIT-CREDIT' } });
    expect(credit.void_category).toBe('CHARGEBACK');
    // New with slice 09: the lost dispute is on record, and the deposit's stored net collected is
    // re-derived under the lock (nothing collected is left on it).
    const [row] = await f.disputes();
    expect(row).toMatchObject({ status: 'LOST', invoice_id: f.invoice, payment_id: f.payment });
    expect(Number((await f.readInvoice()).net_collected)).toBe(0);
  });

  // Fix round 1: the credit un-apply raises the job invoice's balance by writing an absolute value.
  // It must read that balance under the job invoice's lock (the lock every payment door takes, and
  // staff voidPayment's cascade takes since slice 18), or a payment booked on the job invoice at
  // the same moment is written over with the stale balance.
  it('a lost dispute on a deposit, while a payment is booking on the job invoice, reopens the credit on top of that payment, not over it', async () => {
    const f = await paidInvoice({ total: 200 });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT' } });
    const target = randomUUID();
    await db.invoice.create({
      data: {
        id: target, organization_id: f.org, customer_id: f.customer, invoice_number: `INV-${f.tag}-J`,
        subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 800, status: 'PARTIAL',
      },
    });
    await db.payment.create({
      data: { invoice_id: target, amount: 200, method: 'OTHER', state: 'SUCCEEDED', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT' },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO deposit_credit_applications (id, deposit_invoice_id, target_invoice_id, amount, organization_id) VALUES ('${randomUUID()}', '${f.invoice}', '${target}', 200, '${f.org}')`,
    );

    // A $300 cash payment books on the job invoice the way a payment door does: lock, book, lower
    // the balance from $800 to $500. The dispute arrives while it holds the lock.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${target}' FOR UPDATE`);
      await tx.$executeRawUnsafe(
        `INSERT INTO payments (id, invoice_id, amount, method, state, paid_at, created_by_source) VALUES ('${randomUUID()}', '${target}', 300, 'CASH', 'SUCCEEDED', now(), 'USER')`,
      );
      await tx.$executeRawUnsafe(`UPDATE invoices SET amount_due = 500 WHERE id = '${target}'`);
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the payment never held the lock'); })]);
    const delivered = f.deliver('charge.dispute.closed', f.dispute({ amount: 20000, status: 'lost' }));
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the dispute never waited on the job invoice').toBe(true);
    } finally {
      release();
      await holder;
    }
    await delivered;

    // $500 left after the cash payment, plus the $200 credit taken back: $700, still partly paid.
    const job = await db.invoice.findUniqueOrThrow({ where: { id: target } });
    expect(Number(job.amount_due)).toBe(700);
    expect(job.status).toBe('PARTIAL');
    const credit = await db.payment.findFirstOrThrow({ where: { invoice_id: target, reference_number: 'DEPOSIT-CREDIT' } });
    expect(credit.void_category).toBe('CHARGEBACK');
  });

  // Every reconciler write is scoped by the org the event arrived on, not only the reads that led
  // to it: an action naming another org's invoice changes nothing there and fails the event.
  describe("an action naming another org's invoice, applied in this org", () => {
    const applyIn = (org: string, action: LedgerAction) =>
      db.$transaction((tx) => applyActions(tx, [action], { organizationId: org, eventId: `evt_pay09_tenancy_${randomUUID()}` }));

    it('open_dispute does not mark that invoice DISPUTED', async () => {
      const ours = await paidInvoice();
      const theirs = await paidInvoice();
      await expect(applyIn(ours.org, {
        type: 'open_dispute', organizationId: ours.org, processorDisputeId: `dp_pay09_${ours.tag}_x`, invoiceId: theirs.invoice,
        paymentId: theirs.payment, status: 'NEEDS_RESPONSE', reason: null, amountCents: 100, evidenceDueBy: null,
        bankReturn: false, markInvoiceDisputed: true,
      })).rejects.toThrow();
      expect(await theirs.readInvoice()).toMatchObject({ status: 'PAID', stripe_dispute_id: null });
    });

    it('restore_invoice_status does not change that invoice', async () => {
      const ours = await paidInvoice();
      const theirs = await paidInvoice();
      await db.invoice.update({ where: { id: theirs.invoice }, data: { status: 'DISPUTED' } });
      await expect(applyIn(ours.org, {
        type: 'restore_invoice_status', invoiceId: theirs.invoice, to: 'PAID', processorDisputeId: `dp_pay09_${ours.tag}_x`, outcome: 'WON',
      })).rejects.toThrow();
      expect(await theirs.readInvoice()).toMatchObject({ status: 'DISPUTED' });
    });

    it('record_outside_refund_history does not stamp that invoice', async () => {
      const ours = await paidInvoice();
      const theirs = await paidInvoice();
      await db.refund.create({
        data: {
          invoice_id: ours.invoice, payment_id: ours.payment, amount: 10, method: 'CARD', reason_category: 'OTHER',
          state: 'SUCCEEDED', refunded_by: ours.user, organization_id: ours.org, stripe_refund_id: `re_pay09_${ours.tag}_x`,
        },
      });
      await expect(applyIn(ours.org, {
        type: 'record_outside_refund_history', processorRefundId: `re_pay09_${ours.tag}_x`, invoiceId: theirs.invoice,
      })).rejects.toThrow();
      expect((await theirs.readInvoice()).refunded_at).toBeNull();
    });

    // The lost-dispute void writes the payment and the invoice itself: those writes carry the org too.
    it('the chargeback void does not void that payment or reopen that invoice', async () => {
      const ours = await paidInvoice();
      const theirs = await paidInvoice();
      const payment = await theirs.readPayment();
      const invoice = await theirs.readInvoice();
      await expect(db.$transaction((tx) => systemVoidPaymentForChargeback(tx, {
        payment, invoice, disputeId: `dp_pay09_${ours.tag}_x`, orgId: ours.org,
      }))).rejects.toThrow();
      expect((await theirs.readPayment()).voided_at).toBeNull();
      expect(await theirs.readInvoice()).toMatchObject({ status: 'PAID', stripe_dispute_id: null });
      expect(Number((await theirs.readInvoice()).amount_due)).toBe(0);
    });

    // rederiveRefundTotals reads under the org first, so a foreign invoice already throws before its
    // write; the write itself must carry the org as well. Every call goes to the real transaction;
    // the proxy only records what the invoice write was scoped by.
    it('the refund-totals re-derive writes the invoice scoped by the org, not by its id alone', async () => {
      const ours = await paidInvoice();
      const wheres: unknown[] = [];
      await db.$transaction(async (tx) => {
        const invoiceDelegate = new Proxy(tx.invoice, {
          get(target, key, receiver) {
            if (key === 'update') {
              return (args: { where: unknown }) => {
                wheres.push(args.where);
                return target.update(args as Parameters<typeof target.update>[0]);
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
        const recording = new Proxy(tx, {
          get: (target, key, receiver) => (key === 'invoice' ? invoiceDelegate : Reflect.get(target, key, receiver)),
        });
        await rederiveRefundTotals(recording, { invoiceId: ours.invoice, organizationId: ours.org });
      });
      expect(wheres).toEqual([{ id: ours.invoice, organization_id: ours.org }]);
    });
  });

  // A dispute holds its invoice and payment (ON DELETE RESTRICT), so every path that deletes
  // payments deletes disputes first. The e2e test-data cleanup route is one of them.
  it('the e2e test-data cleanup removes a disputed payment and its dispute', async () => {
    const f = await paidInvoice();
    const location = randomUUID();
    const job = randomUUID();
    await db.customer.update({ where: { id: f.customer }, data: { email: `pay09-${f.tag}@e2e.local` } });
    await db.serviceLocation.create({ data: { id: location, customer_id: f.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' } });
    await db.job.create({ data: { id: job, organization_id: f.org, customer_id: f.customer, service_location_id: location, job_number: `J-${f.tag}` } });
    await db.invoice.update({ where: { id: f.invoice }, data: { job_id: job } });
    await f.deliver('charge.dispute.created', f.dispute());
    expect(await f.disputes()).toHaveLength(1);

    const res = await request(app).post('/api/test/cleanup');
    expect(res.body.details ?? null).toBeNull();
    expect(res.status).toBe(200);
    expect(await f.disputes()).toHaveLength(0);
    expect(await db.payment.count({ where: { id: f.payment } })).toBe(0);
  });

  // Behaviour that predates slice 09: a legacy charge on the platform account (no connected
  // account on the event) is resolved by its payment intent.
  it('a dispute on a legacy platform-account charge is resolved through its payment and recorded', async () => {
    const f = await paidInvoice();
    await db.payment.update({ where: { id: f.payment }, data: { stripe_account_id: null } });
    const event = {
      id: `evt_pay09_${f.tag}_platform`, object: 'event', api_version: '2025-02-24.acacia', type: 'charge.dispute.created',
      created: 1790000000, data: { object: f.dispute({ charge: `ch_pay09_${f.tag}_unknown` }) },
    };
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig')
      .send(Buffer.from(JSON.stringify(event)));
    expect(res.status).toBe(200);
    expect(await f.disputes()).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
  });
});

