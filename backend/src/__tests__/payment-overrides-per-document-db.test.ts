/* =============================================================================
   Payments go-live, slice 21 - a document's payment-option override belongs to that document.

   Office users make one invoice bank-only with partial payments allowed, or let one estimate's
   customer approve now and pay the deposit later. Each override must land on that document only:
   its sibling in the same org keeps following the org defaults, both in the staff API and in what
   the customer's public page is offered.

   What each test guards:
   - "an estimate created with a deposit-policy override keeps it" is this slice's own change (the
     create path used to drop the field). It is red on the code before slice 21.
   - The other three pin the per-document storage that slice 19 built and that the Payment options
     card and the estimate send dialog now write through. They are green on the code before slice
     21 by design. Each was shown red against a broken write instead: the invoice PATCH dropping
     the override, the PATCH treating a null reset as "leave unchanged", the override written to
     every invoice in the org, and the estimate PATCH dropping deposit_policy.

   Drives the real routes against a real, migrated database (the overrides are separate columns on
   separate rows, which a mocked client cannot prove). Only the identity provider stays mocked.
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
// ...and so is the numbering allocator (the setup's stub hands every estimate the same number).
vi.unmock('../lib/numbering');

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('payment-option overrides are stored per document (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  /** One org that can take card and bank payments, an admin, a customer and two sent invoices. */
  async function tenant() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    // One bearer per tenant: the auth layer caches a verified token.
    const bearer = `local-db-test-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay21-overrides-${tag}`, email: `overrides-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay21_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const invoice = async (n: number) => {
      const id = randomUUID();
      const token = `pay21-${randomUUID()}`;
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}-${n}`, status: 'SENT',
          subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500, public_token: token,
        },
      });
      return { id, token };
    };
    const addCustomer = async () => {
      const id = randomUUID();
      await db.customer.create({
        data: { id, organization_id: org, customer_number: 'C00002', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Sam', last_name: 'Sibling' },
      });
      return id;
    };
    const first = await invoice(1);
    const second = await invoice(2);
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const auth = { Authorization: `Bearer ${bearer}` };
    const publicOptions = async (inv: { id: string; token: string }) => {
      const res = await request(app).get(`/api/invoices/${inv.id}/public`).query({ token: inv.token });
      expect(res.status).toBe(200);
      return { methods: res.body.payment_options.methods as string[], allow_partial: res.body.payment_options.allow_partial as boolean };
    };
    const staffInvoice = async (id: string) => {
      const res = await request(app).get(`/api/invoices/${id}`).set(auth);
      expect(res.status).toBe(200);
      return {
        payment_methods_override: res.body.invoice.payment_methods_override,
        allow_partial_payment: res.body.invoice.allow_partial_payment,
      };
    };
    return { org, customer, addCustomer, auth, first, second, publicOptions, staffInvoice };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'settings_audit_logs', 'app_settings', 'invoices', 'estimates', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('one invoice made bank-only with partial payments allowed; its sibling keeps the org default', async () => {
    const t = await tenant();

    const saved = await request(app).patch(`/api/invoices/${t.first.id}`).set(t.auth)
      .send({ payment_methods_override: ['ACH'], allow_partial_payment: true });
    expect(saved.status).toBe(200);

    expect(await t.staffInvoice(t.first.id)).toEqual({ payment_methods_override: ['ACH'], allow_partial_payment: true });
    expect(await t.staffInvoice(t.second.id)).toEqual({ payment_methods_override: null, allow_partial_payment: null });

    expect(await t.publicOptions(t.first)).toEqual({ methods: ['ACH'], allow_partial: true });
    expect(await t.publicOptions(t.second)).toEqual({ methods: ['CHECK', 'CARD', 'ACH'], allow_partial: false });
  });

  it('resetting the invoice returns it to the org default', async () => {
    const t = await tenant();
    await request(app).patch(`/api/invoices/${t.first.id}`).set(t.auth)
      .send({ payment_methods_override: ['ACH'], allow_partial_payment: true });

    const reset = await request(app).patch(`/api/invoices/${t.first.id}`).set(t.auth)
      .send({ payment_methods_override: null, allow_partial_payment: null });
    expect(reset.status).toBe(200);

    expect(await t.staffInvoice(t.first.id)).toEqual({ payment_methods_override: null, allow_partial_payment: null });
    expect(await t.publicOptions(t.first)).toEqual({ methods: ['CHECK', 'CARD', 'ACH'], allow_partial: false });
  });

  it('one estimate allowed to pay the deposit later; its sibling keeps the org policy', async () => {
    const t = await tenant();
    // One estimate on each of two customers.
    const other = await t.addCustomer();
    const create = (customer_id: string) => request(app).post('/api/estimates').set(t.auth).send({ customer_id });
    const [a, b] = [await create(t.customer), await create(other)];
    expect([a.status, b.status]).toEqual([201, 201]);

    const saved = await request(app).patch(`/api/estimates/${a.body.estimate.id}`).set(t.auth).send({ deposit_policy: 'PAY_LATER' });
    expect(saved.status).toBe(200);

    const read = async (id: string) => (await request(app).get(`/api/estimates/${id}`).set(t.auth)).body.estimate.deposit_policy;
    expect(await read(a.body.estimate.id)).toBe('PAY_LATER');
    expect(await read(b.body.estimate.id)).toBeNull();
  });

  // Conductor note from slice 19: the create path accepted deposit_policy with no error and saved
  // null, so an override chosen while creating an estimate was silently lost.
  it('an estimate created with a deposit-policy override keeps it', async () => {
    const t = await tenant();
    const created = await request(app).post('/api/estimates').set(t.auth)
      .send({ customer_id: t.customer, deposit_policy: 'PAY_LATER' });
    expect(created.status).toBe(201);
    expect(created.body.estimate.deposit_policy).toBe('PAY_LATER');

    const read = await request(app).get(`/api/estimates/${created.body.estimate.id}`).set(t.auth);
    expect(read.body.estimate.deposit_policy).toBe('PAY_LATER');
  });
});
