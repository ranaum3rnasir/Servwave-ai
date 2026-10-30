/* =============================================================================
   Payments go-live, slice 16 - the accepted-methods gate (and the plan gate) only ever block
   CREATING a checkout. Events for a payment that already exists are processed whatever the org's
   accepted methods or plan say today (PRD Module 3, "Gating").

   The case that matters: an org that took a card payment, whose CARD has since left its accepted
   methods (the card capability lapsed while charges stayed on), and whose plan has since lost
   online payments. The refund and the dispute on that payment are still real money movements and
   must be recorded. Slices 08-10 routed the reconciler around the old gate; this pins it.

   Events are posted to the real webhook route in the processor's payload shape. Real migrated
   database (TEST_DATABASE_URL); skips when unset. Every org it creates is removed again.
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

const suite = realClient ? describe : describe.skip;

suite('payment events for an org that no longer accepts card (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    // The processor knows no ServWave checkout for a disputed charge beyond the booked payment.
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
        paymentIntents: { retrieve: vi.fn().mockResolvedValue({ latest_charge: null }) },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
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
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay16_%'`));
    await db.$disconnect();
  });

  /**
   * An org whose charges are still on but whose accepted methods hold no CARD (only CHECK), and
   * whose plan has online payments switched off, with one $400 invoice paid by card.
   */
  async function cardPaymentOnOrgWithoutCard() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const payment = randomUUID();
    const account = `acct_pay16_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay16-${tag}`, email: `pay16-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, stripe_charges_enabled: true, stripe_payouts_enabled: true,
        accepted_payment_methods: ['CHECK'],
        plan: 'PRO', feature_overrides: { online_payments: false },
      },
    });
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: 400, tax_amount: 0, total_amount: 400, amount_due: 0, net_collected: 400, status: 'PAID', paid_at: new Date(),
      },
    });
    await db.payment.create({
      data: {
        id: payment, invoice_id: invoice, amount: 400, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: `pi_pay16_${tag}`, stripe_charge_id: `ch_pay16_${tag}`, stripe_account_id: account,
        created_by_source: 'CLIENT',
      },
    });
    let seq = 0;
    const deliver = async (type: string, object: object) => {
      const event = {
        id: `evt_pay16_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia',
        type, created: 1790000000, account, data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
      return res;
    };
    return { org, tag, invoice, payment, deliver };
  }

  it('a refund on its card payment is recorded and comes off the invoice', async () => {
    const f = await cardPaymentOnOrgWithoutCard();

    await f.deliver('refund.created', {
      id: `re_pay16_${f.tag}`, object: 'refund', amount: 15000, currency: 'usd', status: 'succeeded',
      charge: `ch_pay16_${f.tag}`, payment_intent: `pi_pay16_${f.tag}`, metadata: {},
    });

    const refunds = await db.refund.findMany({ where: { organization_id: f.org } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ stripe_refund_id: `re_pay16_${f.tag}`, invoice_id: f.invoice, payment_id: f.payment, state: 'SUCCEEDED' });
    expect(Number(refunds[0].amount)).toBe(150);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).status).toBe('PARTIALLY_REFUNDED');
  });

  it('a dispute on its card payment is recorded and the invoice reads DISPUTED', async () => {
    const f = await cardPaymentOnOrgWithoutCard();

    await f.deliver('charge.dispute.created', {
      id: `dp_pay16_${f.tag}`, object: 'dispute', amount: 40000, currency: 'usd', status: 'needs_response',
      reason: 'fraudulent', charge: `ch_pay16_${f.tag}`, payment_intent: `pi_pay16_${f.tag}`,
      evidence_details: { due_by: 1791000000 }, metadata: {},
    });

    const disputes = await db.dispute.findMany({ where: { organization_id: f.org } });
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({ stripe_dispute_id: `dp_pay16_${f.tag}`, payment_id: f.payment, status: 'NEEDS_RESPONSE' });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).status).toBe('DISPUTED');
  });
});
