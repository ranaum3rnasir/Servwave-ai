/* =============================================================================
   Payments go-live slice 14 - processor sandbox end to end: a payment recorded by hand closes the
   invoice's open checkout link AT THE PROCESSOR, and leaves another invoice's link open.

   Real everything except identity: a fresh no-dashboard connected account in the sandbox, real
   checkout sessions opened through the app's own session builder, the real record-payment route
   against a real migrated database, and the session read back from the processor afterwards.

   Opt-in, because it creates objects in the shared sandbox: runs only with TEST_DATABASE_URL set,
   STRIPE_SANDBOX_E2E=1, and a test-mode key (sk_test_) in backend/.env. It never runs in live mode.
   The connected account is deleted afterwards and every org it creates is removed.

     STRIPE_SANDBOX_E2E=1 TEST_DATABASE_URL=postgresql://...:5433/... \
       npx vitest run src/__tests__/close-open-checkout-links-sandbox-db.test.ts
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
import { supabaseAdmin } from '../lib/supabase';
import { STRIPE_API_VERSION, createCheckoutSession, createConnectedAccount, getStripeForOrg } from '../lib/stripe';
import { priceCheckout } from '../lib/checkout-pricing';

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

suite('sandbox: a payment recorded by hand expires the open checkout link at the processor', () => {
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
  }, 60000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
    for (const table of ['timeline_events', 'notifications', 'invoices']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
    for (const table of ['customers', 'users']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
    }
    await quietly(db.organization.deleteMany({ where: { id: org } }));
    await db.$disconnect();
    if (account) await quietly(platform.accounts.del(account.id));
  }, 60000);

  it('after a payment by hand, and after a line edit, the invoice\'s session reads back expired; the other invoice\'s stays open', async () => {
    account = await createConnectedAccount({
      orgId: org, email: `pay14-${tag}-owner@test.invalid`, businessName: `PAY14 ${tag} Verify Org`, mcc: '1731',
    });
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const other = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay14-sandbox-${tag}`, email: `pay14-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account.id, accepted_payment_methods: ['CARD'],
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
          id, organization_id: org, customer_id: customer, invoice_number: number, status: 'SENT', sent_at: new Date(),
          subtotal: 125, tax_amount: 0, total_amount: 125, amount_due: 125,
        },
      });
    }
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });

    const ctx = getStripeForOrg({ stripe_account_id: account.id });
    const open = async (invoiceId: string) => {
      const pricing = priceCheckout({ invoiceTotalCents: 12500, amountDueCents: 12500, method: 'card', description: `PAY14 ${tag}` });
      if (!pricing.ok) throw new Error(`pricing refused: ${pricing.error}`);
      return createCheckoutSession({
        pricing, method: 'card',
        document: { organizationId: org, invoiceId, kind: 'invoice' },
        successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel',
      }, ctx);
    };
    const mine = await open(invoice);
    const theirs = await open(other);
    const read = (id: string) => platform.checkout.sessions.retrieve(id, {}, { stripeAccount: account!.id });
    expect((await read(mine.id)).status).toBe('open');

    try {
      const res = await request(app)
        .post(`/api/invoices/${invoice}/payments`)
        .set('Authorization', `Bearer pay14-sandbox-${tag}`)
        .send({ amount: 40, method: 'CASH' });
      expect(res.status).toBe(201);

      await vi.waitFor(async () => expect((await read(mine.id)).status).toBe('expired'), { timeout: 30000, interval: 1000 });
      expect((await read(theirs.id)).status).toBe('open');

      // The localhost acceptance, by API: open a fresh link, edit a line, the link is dead.
      const fresh = await open(invoice);
      const edit = await request(app)
        .post(`/api/invoices/${invoice}/line-items`)
        .set('Authorization', `Bearer pay14-sandbox-${tag}`)
        .send({ description: 'Hinge', quantity: 1, unit_price: 25 });
      expect(edit.status).toBe(200);
      await vi.waitFor(async () => expect((await read(fresh.id)).status).toBe('expired'), { timeout: 30000, interval: 1000 });
      expect((await read(theirs.id)).status).toBe('open');
    } finally {
      await platform.checkout.sessions.expire(theirs.id, {}, { stripeAccount: account.id }).catch(() => undefined);
    }
  }, 90000);
});
