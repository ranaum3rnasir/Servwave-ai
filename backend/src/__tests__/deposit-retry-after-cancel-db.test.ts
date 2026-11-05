/* =============================================================================
   #2979 - the journey: a customer signs, opens the card checkout, backs out without paying, comes
   back to the estimate page and pays the deposit from there.

   Sign (approval door, card) -> the checkout is abandoned -> the page read offers the deposit ->
   the retry opens the deposit's OWN checkout (never approval again) with the expected amount ->
   the first session is closed -> the processor reports the second one paid -> the estimate is Won,
   the deposit Paid, and History holds two "Customer started deposit checkout" rows.

   Every step is the real HTTP route on a real, migrated database. Only the processor SDK is
   replaced, by a recorder that keeps the sessions it minted (open / expired), so the session the
   webhook delivers is the one the retry door actually built. The payment-sandbox browser run of
   the same journey is done by the staging validator after the merge (RUN-RULES proof assignment).

   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

type RecordedSession = { id: string; url: string; created: number; status: 'open' | 'expired'; params: any };
const { processor } = vi.hoisted(() => {
  const sessions: RecordedSession[] = [];
  let n = 0;
  return {
    processor: {
      sessions,
      create: async (params: any) => {
        n += 1;
        const s: RecordedSession = { id: `cs_2979_${n}_${Date.now()}`, url: `https://checkout.example/2979/${n}`, created: 1790000000 + n, status: 'open', params };
        sessions.push(s);
        return { id: s.id, url: s.url, created: s.created, metadata: params.metadata };
      },
      list: async (q: { status?: string }) => ({
        data: sessions.filter((s) => !q?.status || s.status === q.status).map((s) => ({ id: s.id, created: s.created, metadata: s.params.metadata })),
        has_more: false,
      }),
      expire: async (id: string) => {
        const s = sessions.find((x) => x.id === id);
        if (s) s.status = 'expired';
        return { id, status: 'expired' };
      },
      retrievePaymentIntent: vi.fn(),
    },
  };
});

// The suite-wide setup mocks the app's client; here it is a real one.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const url = process.env.TEST_DATABASE_URL;
  return { prisma: url ? new PrismaClient({ datasources: { db: { url } } }) : undefined };
});

// The real session builder, sweep and webhook run; only the processor SDK underneath records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = { sessions: { create: processor.create, list: processor.list, expire: processor.expire } };
    paymentIntents = { retrieve: processor.retrievePaymentIntent };
    disputes = { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) };
    applicationFees = { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() };
  },
}));

import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

suite('a signed customer who backed out of the card checkout pays the deposit from the estimate page (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_deposit_retry_2979_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    processor.sessions.length = 0;
    processor.retrievePaymentIntent.mockReset();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_2979_%'`));
    await db.$disconnect();
  });

  /** A sent $1,000 estimate with terms, asking for a $500 deposit by card, bank or check. */
  async function sentEstimate() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const lead = randomUUID();
    const estimate = randomUUID();
    const deposit = randomUUID();
    const account = `acct_2979_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pb2979-${tag}`, email: `pb2979-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: 'Work is guaranteed for one year.', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, stripe_charges_enabled: true,
        accepted_payment_methods: ['CARD', 'ACH', 'CHECK'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.lead.create({
      data: { id: lead, organization_id: org, lead_number: `L-${tag}`, customer_id: customer, service_request: 'Garage door', status: 'ESTIMATED' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, lead_id: lead, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000, sent_at: new Date(),
        public_token: `est-${tag}`, deposit_type: 'FIXED', deposit_value: 500,
        // The terms the customer was shown: the retry used to re-check these and refuse.
        snapshot_terms: 'Work is guaranteed for one year.',
        send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'ACH', 'CHECK'] } },
      },
    });
    await db.invoice.create({
      data: {
        id: deposit, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
        invoice_number: `D-${tag}`, status: 'SENT', subtotal: 500, tax_amount: 0, total_amount: 500,
        amount_due: 500, public_token: `dep-${tag}`,
      },
    });
    return { org, tag, account, estimate, deposit, lead, estimateToken: `est-${tag}` };
  }

  it('sign, back out, retry from the estimate page, pay: Won, Paid, two checkout starts in History', async () => {
    const f = await sentEstimate();

    // 1. Sign and choose card: the approval door opens the first checkout.
    const signed = await request(app)
      .post(`/api/estimates/${f.estimate}/approve?token=${f.estimateToken}`)
      .send({ payment_method: 'CARD', signature_data: SIGNATURE, terms_accepted: true });
    expect(signed.status).toBe(200);
    expect(signed.body.checkout_url).toBe(processor.sessions[0].url);
    expect((await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } })).status).toBe('PENDING');

    // 2. The customer backs out: the processor sends them to the cancel address, nothing is paid.
    expect(processor.sessions[0].params.cancel_url).toMatch(new RegExp(`/p/estimates/${f.estimate}\\?token=${f.estimateToken}&payment=cancelled$`));

    // 3. Back on the estimate page: the page read offers the deposit and the door to pay it.
    const page = await request(app).get(`/api/estimates/${f.estimate}/public?token=${f.estimateToken}`);
    expect(page.status).toBe(200);
    expect(page.body.estimate.status).toBe('PENDING');
    expect(page.body.deposit).toMatchObject({ pay_state: 'PAYABLE', hold_reason: null, payable_now: 500 });
    expect(page.body.estimate.send_config.payment_methods).toEqual(expect.arrayContaining(['CARD', 'ACH']));
    const depositDoc = page.body.estimate.invoices[0];
    expect(depositDoc.id).toBe(f.deposit);

    // 4. The card row: the deposit's own checkout with the expected amount, back to the estimate.
    const retry = await request(app)
      .post(`/api/invoices/${depositDoc.id}/public/checkout?token=${depositDoc.public_token}`)
      .send({ method: 'card', expected_amount: page.body.deposit.payable_now, return_to: 'estimate' });
    expect(retry.status).toBe(200);
    expect(processor.sessions).toHaveLength(2);
    const second = processor.sessions[1];
    expect(retry.body.checkout_url).toBe(second.url);
    expect(second.params.line_items.map((li: any) => li.price_data.unit_amount)).toEqual([50000]);
    expect(second.params.metadata).toMatchObject({ invoiceId: f.deposit, kind: 'deposit', payableNowCents: '50000' });
    expect(second.params.success_url).toMatch(new RegExp(`/p/estimates/${f.estimate}\\?token=${f.estimateToken}&payment=success&method=card$`));
    expect(second.params.cancel_url).toMatch(new RegExp(`/p/estimates/${f.estimate}\\?token=${f.estimateToken}&payment=cancelled$`));
    // The abandoned session is closed: the deposit holds one live link.
    expect(processor.sessions.map((s) => s.status)).toEqual(['expired', 'open']);

    // 5. The processor reports the second session paid.
    processor.retrievePaymentIntent.mockResolvedValue({
      id: `pi_2979_${f.tag}`,
      latest_charge: {
        id: `ch_2979_${f.tag}`, object: 'charge', created: 1789990000, amount: 50000,
        payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
      },
    });
    const event = {
      id: `evt_2979_${f.tag}`, object: 'event', api_version: '2025-02-24.acacia', type: 'checkout.session.completed',
      created: 1790000100, account: f.account,
      data: {
        object: {
          id: second.id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
          payment_intent: `pi_2979_${f.tag}`, amount_total: 50000, currency: 'usd', metadata: second.params.metadata,
        },
      },
    };
    const hook = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig')
      .send(Buffer.from(JSON.stringify(event)));
    expect(hook.status).toBe(200);

    // 6. Won, Paid, and History shows both checkout starts.
    const estimate = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } });
    expect(estimate.status).toBe('WON');
    expect(estimate.approved_at).not.toBeNull();
    expect((await db.invoice.findUniqueOrThrow({ where: { id: f.deposit } })).status).toBe('PAID');
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead } })).status).toBe('WON');
    await vi.waitFor(async () => {
      const starts = await db.auditLog.findMany({
        where: { org_id: f.org, action: 'estimate.deposit_checkout_started', resource_type: 'Estimate', resource_id: f.estimate },
      });
      expect(starts).toHaveLength(2);
    });
  });

  it('a retry on the signed estimate never goes back through approval: the signature on file is untouched', async () => {
    const f = await sentEstimate();
    await request(app)
      .post(`/api/estimates/${f.estimate}/approve?token=${f.estimateToken}`)
      .send({ payment_method: 'CARD', signature_data: SIGNATURE, terms_accepted: true })
      .expect(200);
    const signedAt = (await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } })).signature_at;

    await request(app)
      .post(`/api/invoices/${f.deposit}/public/checkout?token=dep-${f.tag}`)
      .send({ method: 'bank', expected_amount: 500, return_to: 'estimate' })
      .expect(200);

    const after = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } });
    expect(after.status).toBe('PENDING');
    expect(after.signature_at?.toISOString()).toBe(signedAt?.toISOString());
    expect(processor.sessions[1].params.payment_method_types).toEqual(['us_bank_account']);
  });
});
