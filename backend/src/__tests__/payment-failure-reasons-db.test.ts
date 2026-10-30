/* =============================================================================
   Payments go-live, slice P2 - ServWave keeps why a bank payment or a refund failed.

   Through the real webhook route, with a real migrated database (TEST_DATABASE_URL; skips when
   unset). A bank payment that fails stores the processor's code on the payment; a lookup that cannot
   be answered never blocks the state change; a refund that fails stores its code on the refund. The
   words a person reads come from describeFailure (payment-failure-reasons.test.ts).
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

import { getStripeForOrg, retrievePaymentIntentFailureCode } from '../lib/stripe';

const failureCodeLookup = retrievePaymentIntentFailureCode as unknown as ReturnType<typeof vi.fn>;
const retrievePaymentIntent = vi.fn();
const suite = realClient ? describe : describe.skip;

suite('failure reasons (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 180_000);

  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    failureCodeLookup.mockReset().mockResolvedValue(null);
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

  /** An org with an admin, a customer and a sent invoice; the door to deliver processor events to. */
  async function fixture(total = 500) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const user = randomUUID();
    const account = `acct_p2f_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `p2f-${tag}`, email: `p2f-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test` },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, status: 'SENT', public_token: `tok-${randomUUID()}`,
      },
    });
    const payIntent = `pi_p2f_${tag}`;
    retrievePaymentIntent.mockResolvedValue({
      id: payIntent,
      latest_charge: {
        id: `py_p2f_${tag}`, object: 'charge', created: 1789990000, amount: total * 100,
        payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'TEST BANK', last4: '6789' } },
      },
    });
    let seq = 0;
    const session = () => ({
      id: `cs_p2f_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'complete',
      payment_intent: payIntent, amount_total: total * 100, currency: 'usd', payment_method_types: ['us_bank_account'],
      metadata: { invoiceId: invoice, organizationId: org, kind: 'invoice', payableNowCents: String(total * 100) },
    });
    const deliver = async (type: string, object: object, onPlatform = false) => {
      const event = { id: `evt_p2f_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: 1790000000, ...(onPlatform ? {} : { account }), data: { object } };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    const payment = () => db.payment.findFirstOrThrow({ where: { invoice_id: invoice } });
    return {
      org, tag, user, invoice, account, payIntent, deliver, payment,
      started: (onPlatform = false) => deliver('checkout.session.completed', session(), onPlatform),
      failed: (onPlatform = false) => deliver('checkout.session.async_payment_failed', session(), onPlatform),
    };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
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
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_p2f_%'`));
    await db.$disconnect();
  });

  it('a bank payment that fails after it started stores the processor code on the payment', async () => {
    const f = await fixture();
    failureCodeLookup.mockResolvedValue('insufficient_funds');
    await f.started();
    expect((await f.payment()).state).toBe('PROCESSING');

    await f.failed();

    const payment = await f.payment();
    expect(payment).toMatchObject({ state: 'FAILED', failure_code: 'insufficient_funds' });
    expect(failureCodeLookup).toHaveBeenCalledWith(f.account, f.payIntent);
  });

  it('a bank payment first heard of as failed stores the code too', async () => {
    const f = await fixture();
    failureCodeLookup.mockResolvedValue('account_closed');

    await f.failed();

    expect(await f.payment()).toMatchObject({ state: 'FAILED', failure_code: 'account_closed' });
  });

  it('a payment that arrived on the platform account (no connected account) is looked up there and stores the code', async () => {
    const f = await fixture();
    failureCodeLookup.mockResolvedValue('no_account');

    await f.failed(true);

    const payment = await f.payment();
    expect(payment).toMatchObject({ state: 'FAILED', stripe_account_id: null, failure_code: 'no_account' });
    expect(failureCodeLookup).toHaveBeenCalledWith(null, f.payIntent);
  });

  it('a lookup that throws still marks the payment failed, with no code', async () => {
    const f = await fixture();
    await f.started();
    failureCodeLookup.mockRejectedValue(new Error('processor unreachable'));

    await f.failed();

    expect(await f.payment()).toMatchObject({ state: 'FAILED', failure_code: null });
  });

  it('a payment that did not fail has no failure code and is never looked up', async () => {
    const f = await fixture();

    await f.started();

    expect(await f.payment()).toMatchObject({ state: 'PROCESSING', failure_code: null });
    expect(failureCodeLookup).not.toHaveBeenCalled();
  });

  it('a refund that fails stores the processor code on the refund', async () => {
    const f = await fixture();
    await f.started();
    const payment = await f.payment();
    await db.payment.update({ where: { id: payment.id }, data: { state: 'SUCCEEDED' } });
    const refund = await db.refund.create({
      data: {
        invoice_id: f.invoice, payment_id: payment.id, amount: 50, method: 'ACH', reason_category: 'OTHER', refunded_by: f.user,
        organization_id: f.org, stripe_refund_id: `re_p2f_${f.tag}`, state: 'PENDING',
      },
    });

    await f.deliver('refund.failed', {
      id: `re_p2f_${f.tag}`, object: 'refund', amount: 5000, status: 'failed', payment_intent: f.payIntent, failure_reason: 'insufficient_funds', metadata: {},
    });

    expect(await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ state: 'FAILED', failure_code: 'insufficient_funds' });
  });
});
