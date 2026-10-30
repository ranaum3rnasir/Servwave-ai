/* =============================================================================
   Payments go-live slice 26 - processor sandbox end to end: a homeowner pays $40 of a $100 invoice
   with a $6 tip through the public checkout door.

   Real everything except the card entry: a fresh no-dashboard connected account in the sandbox, the
   real public checkout route opening a real session (read back from the processor: it charges
   $46.00 in two lines and names the partial amount), then that session's completion handed to the
   real reconciler against a real migrated database: the payment row is the $40.00 partial, the tip
   is recorded separately, and the invoice reads PARTIAL with $60.00 due.

   Opt-in, because it creates objects in the shared sandbox: runs only with TEST_DATABASE_URL set,
   STRIPE_SANDBOX_E2E=1, and a test-mode key (sk_test_) in backend/.env. It never runs in live mode.
   The connected account is deleted afterwards and every org it creates is removed.

     STRIPE_SANDBOX_E2E=1 TEST_DATABASE_URL=postgresql://...:5433/... \
       npx vitest run src/__tests__/public-invoice-partial-tip-sandbox-db.test.ts
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl && process.env.STRIPE_SANDBOX_E2E === '1' ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup fakes the processor; here it is the real sandbox.
vi.unmock('../lib/stripe');

import Stripe from 'stripe';
import { env } from '../config/env';
import { STRIPE_API_VERSION, createConnectedAccount } from '../lib/stripe';

function sandboxKey(): string | undefined {
  try {
    const key = dotenv.parse(readFileSync(join(__dirname, '../../.env')))['STRIPE_SECRET_KEY']?.trim();
    return key?.startsWith('sk_test_') ? key : undefined;
  } catch {
    return undefined;
  }
}

const key = realClient ? sandboxKey() : undefined;
const suite = realClient && key ? describe : describe.skip;

suite('sandbox: a $40 partial payment with a $6 tip on a $100 invoice', () => {
  const db = realClient!;
  const org = randomUUID();
  const tag = org.slice(0, 8);
  let app: Parameters<typeof request>[0];
  let account: Stripe.Account | undefined;
  let platform: Stripe;

  beforeAll(async () => {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = key;
    platform = new Stripe(key!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 180000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id = 'evt_pay26_${tag}'`));
    for (const table of ['timeline_events', 'notifications', 'invoices', 'customers']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
    await quietly(db.organization.deleteMany({ where: { id: org } }));
    await db.$disconnect();
    if (account) await quietly(platform.accounts.del(account.id));
  }, 60000);

  it('opens a $46.00 session in two lines; its completion books $40.00 and the $6.00 tip apart and leaves the invoice PARTIAL with $60.00 due', async () => {
    account = await createConnectedAccount({
      orgId: org, email: `pay26-${tag}-owner@test.invalid`, businessName: `PAY26 ${tag} Verify Org`, mcc: '1731',
    });
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay26-sbx-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay26-sandbox-${tag}`, email: `pay26-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account.id, stripe_charges_enabled: true, accepted_payment_methods: ['CARD'],
        tips_enabled: true, tip_presets: [10, 15, 20],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'SENT', sent_at: new Date(),
        subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 100, public_token: token, allow_partial_payment: true,
      },
    });

    // 1. The public door opens a real session for $40 + $6.
    const res = await request(app)
      .post(`/api/invoices/${invoice}/public/checkout?token=${token}`)
      .send({ method: 'card', amount: 40, tip: 6, expected_amount: 100 });
    expect(res.status).toBe(200);
    const sessionId = String(res.body.checkout_url).match(/cs_test_[A-Za-z0-9]+/)?.[0];
    expect(sessionId).toBeTruthy();

    // 2. Read back from the processor: what the homeowner is charged.
    const session = await platform.checkout.sessions.retrieve(sessionId!, { expand: ['line_items'] }, { stripeAccount: account.id });
    expect(session.amount_total).toBe(4600);
    expect(session.line_items?.data.map((l) => l.amount_total)).toEqual([4000, 600]);
    expect(session.metadata).toMatchObject({ amountCents: '4000', tipCents: '600', payableNowCents: '10000' });

    // 3. The completion, handed to the real reconciler (a test cannot type a card number).
    const { reconcile } = await import('../services/payment-reconciler/index.js');
    const outcome = await reconcile(
      {
        id: `evt_pay26_${tag}`,
        type: 'checkout.session.completed',
        account: account.id,
        data: { object: { ...session, payment_status: 'paid', payment_intent: null } },
      },
      { id: org, name: null, accepted_payment_methods: ['CARD'], stripe_payouts_enabled: true },
    );
    expect(outcome).toBe('applied');

    const payments = await db.payment.findMany({ where: { invoice_id: invoice } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBe(40);
    expect(Number(payments[0]!.tip_amount)).toBe(6);
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(after.status).toBe('PARTIAL');
    expect(Number(after.amount_due)).toBe(60);
    await platform.checkout.sessions.expire(sessionId!, {}, { stripeAccount: account.id }).catch(() => undefined);
  }, 120000);
});
