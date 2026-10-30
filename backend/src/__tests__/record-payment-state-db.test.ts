/* =============================================================================
   Payments go-live, slice 04 - recording a manual payment still works after the ledger
   gained a state, and what it stores is SUCCEEDED.

   The record-payment route never names `state`; the column default is what makes a hand-
   recorded payment count. A mocked Prisma client cannot prove a column default, so this suite
   drives the real route (POST /api/invoices/:id/payments, through auth and the permission
   check) against a real, migrated database: the app's client is swapped for one pointed at
   TEST_DATABASE_URL, and only the identity provider stays mocked (it has no local stand-in).

   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('recording a manual payment (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // Imported only when the suite runs: without a database the app's client above is undefined.
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  async function fixture() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay04-record-${tag}`, email: `record-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
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
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'SENT',
        subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    return { invoice };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      // Children first; the invoice is held by Restrict foreign keys from payments.
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('a payment recorded by hand is stored SUCCEEDED and the invoice moves to PARTIAL', async () => {
    const { invoice } = await fixture();

    const res = await request(app)
      .post(`/api/invoices/${invoice}/payments`)
      .set('Authorization', 'Bearer local-db-test')
      .send({ amount: 120, method: 'BANK_TRANSFER', reference_number: 'wire-1' });

    expect(res.status).toBe(201);
    expect(res.body.payment.state).toBe('SUCCEEDED');

    const stored = await db.payment.findMany({ where: { invoice_id: invoice } });
    expect(stored.map((p) => [Number(p.amount), p.method, p.state])).toEqual([[120, 'BANK_TRANSFER', 'SUCCEEDED']]);
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect([after.status, Number(after.amount_due)]).toEqual(['PARTIAL', 380]);
  });
});
