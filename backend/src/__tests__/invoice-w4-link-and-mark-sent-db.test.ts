/* =============================================================================
   Payments go-live, slice W4 - a payment link never changes a DRAFT's status; "Mark as sent" does (no email).

   Driven through the real doors against a real, migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset.
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

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';
import { getStripeForOrg } from '../lib/stripe';

/** The charge the processor returns for a payment intent (latest_charge expanded). */
const retrievePaymentIntent = vi.fn();

const suite = realClient ? describe : describe.skip;

suite('payment link never issues a DRAFT; mark-sent does (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 120_000);

  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_x', latest_charge: null });
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: { paymentIntents: { retrieve: retrievePaymentIntent } },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_payw4_${org.slice(0, 8)}%'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A $50 standalone DRAFT invoice, no token. */
  async function fixture() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `payw4-${tag}`, email: `payw4-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_payw4_${tag}`, accepted_payment_methods: ['CARD'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test`,
      },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `I-${tag}`,
        subtotal: 50, tax_amount: 0, total_amount: 50, amount_due: 50, net_collected: 0, status: 'DRAFT',
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer payw4-${tag}`;
    const post = (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body);
    const read = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const link = () => post(`/api/invoices/${invoice}/payment-link`);
    const timeline = (event_type?: string) => db.timelineEvent.findMany({ where: { organization_id: org, entity_id: invoice, ...(event_type ? { event_type } : {}) } });
    /** A paid card checkout for this invoice, posted to the webhook route the way the processor delivers it. */
    const payByCard = async (amountDollars: number, partial = false) => {
      const event = {
        id: `evt_payw4_${tag}_${Math.random().toString(36).slice(2)}`, object: 'event', api_version: '2025-02-24.acacia',
        type: 'checkout.session.completed', created: 1790000000, account: `acct_payw4_${tag}`,
        data: {
          object: {
            id: `cs_payw4_${tag}_${Math.random().toString(36).slice(2)}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
            payment_intent: `pi_payw4_${tag}_${Math.random().toString(36).slice(2)}`, amount_total: amountDollars * 100, currency: 'usd',
            metadata: { invoiceId: invoice, ...(partial ? { amountCents: String(amountDollars * 100) } : {}) },
          },
        },
      };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    return { org, invoice, post, read, link, timeline, payByCard };
  }

  it('a payment link on a DRAFT leaves it DRAFT: token and due date set, no sent date, no INVOICE_SENT row', async () => {
    const f = await fixture();

    const res = await f.link();

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/p/invoices/');
    const after = await f.read();
    expect(after.status).toBe('DRAFT');
    expect(after.sent_at).toBeNull();
    expect(after.public_token).not.toBeNull();
    expect(after.due_date).not.toBeNull();
    expect(await f.timeline('INVOICE_SENT')).toHaveLength(0);
    const rows = await f.timeline('INVOICE_PAYMENT_LINK_CREATED');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe(`Payment link created for invoice ${after.invoice_number}`);
  });

  it('a card payment through the link of a DRAFT moves it to PAID, and a part payment moves it to PARTIAL', async () => {
    const full = await fixture();
    expect((await full.link()).status).toBe(200);
    expect((await full.read()).status).toBe('DRAFT');

    await full.payByCard(50);

    const paid = await full.read();
    expect(paid.status).toBe('PAID');
    expect(Number(paid.amount_due)).toBe(0);
    expect(paid.paid_at).not.toBeNull();

    const part = await fixture();
    expect((await part.link()).status).toBe(200);

    await part.payByCard(20, true);

    const partial = await part.read();
    expect(partial.status).toBe('PARTIAL');
    expect(Number(partial.amount_due)).toBe(30);
  });
});
