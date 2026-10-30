/* =============================================================================
   Payments go-live, slice 12 - the public invoice checkout offers payable-now: the amount due
   less the payments still PROCESSING on the invoice.

   A mocked Prisma client returns whatever the fixture says, so it cannot show WHICH payment rows
   the checkout counts as in flight. This suite drives the real route (POST
   /api/invoices/:id/public/checkout) against a real, migrated database holding one invoice with a
   payment in every state: only the live PROCESSING one may come off what is offered. A succeeded
   payment is already out of amount_due, and a failed or voided one is no money at all.

   The app's client is swapped for one pointed at TEST_DATABASE_URL, and only the processor SDK is
   replaced, by a recorder: the assertion is on the amount handed to it.

   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

// The suite-wide setup mocks the app's client; here it is a real one, built by the one factory.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const clientAt = (url: string) => new PrismaClient({ datasources: { db: { url } } });
  const url = process.env.TEST_DATABASE_URL;
  return { prisma: url ? clientAt(url) : undefined };
});

// The real session builder runs; only the processor SDK underneath it records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = {
      sessions: {
        create: sessionsCreate,
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        expire: vi.fn().mockResolvedValue({}),
      },
    };
  },
}));

import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('public invoice checkout offers payable-now (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  // Imported only when the suite runs: without a database the app's client above is undefined.
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_payable_now_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      // Children first; the invoice is held by Restrict foreign keys from payments.
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('a $150.00 invoice with $50.00 paid and $40.00 processing offers $60.00; failed and voided payments change nothing', async () => {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `tok-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay12-payable-${tag}`, email: `payable-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay12_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'PARTIAL',
        subtotal: 150, tax_amount: 0, total_amount: 150, amount_due: 100, public_token: token,
      },
    });
    const pay = (amount: number, state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED', voided = false) =>
      db.payment.create({
        data: {
          invoice_id: invoice, amount, method: state === 'SUCCEEDED' ? 'CHECK' : 'ACH', paid_at: new Date(), state,
          created_by_source: 'CLIENT', ...(voided ? { voided_at: new Date(), voided_reason: 'test' } : {}),
        },
      });
    await pay(50, 'SUCCEEDED');
    await pay(40, 'PROCESSING');
    await pay(5, 'PROCESSING', true);
    await pay(20, 'FAILED');
    sessionsCreate.mockResolvedValue({ id: `cs_${tag}`, url: 'https://checkout.example/payable-now' });

    const res = await request(app)
      .post(`/api/invoices/${invoice}/public/checkout?token=${token}`)
      .send({ method: 'card' });

    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.line_items.map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount)).toEqual([6000]);
    expect(params.metadata).toMatchObject({ organizationId: org, invoiceId: invoice, kind: 'invoice', payableNowCents: '6000' });
  });
});
