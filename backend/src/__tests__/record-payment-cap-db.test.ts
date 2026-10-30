/* =============================================================================
   V7-12a - no overpaid invoices: a payment recorded by hand can never be larger than the
   balance (BE-14a). Drives the real route (POST /api/invoices/:id/payments) against a real,
   migrated database; only the identity provider is mocked. Skips when TEST_DATABASE_URL is unset.
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

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('hand-recorded payment cap (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  async function makeOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `v712a-${tag}`, email: `cap-${tag}@example.test`,
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
    return { org, user, customer, tag };
  }

  async function loginAs(user: string, tag: string) {
    token = `v712a-${tag}`;
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
  }

  async function fixture(opts: { total?: number; due?: number; status?: 'SENT' | 'PARTIAL' | 'DRAFT' } = {}) {
    const o = await makeOrg();
    const invoice = randomUUID();
    const total = opts.total ?? 100;
    await db.invoice.create({
      data: {
        id: invoice, organization_id: o.org, customer_id: o.customer, invoice_number: `INV-${o.tag}`,
        status: opts.status ?? 'SENT', subtotal: total, tax_amount: 0, total_amount: total, amount_due: opts.due ?? total,
      },
    });
    await loginAs(o.user, o.tag);
    return { ...o, invoice };
  }

  // The auth layer caches a token's user, so every org logs in with its own token.
  let token = '';
  const pay = (invoice: string, body: Record<string, unknown>) =>
    request(app).post(`/api/invoices/${invoice}/payments`).set('Authorization', `Bearer ${token}`).send({ method: 'BANK_TRANSFER', ...body });

  async function state(invoice: string) {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const payments = await db.payment.count({ where: { invoice_id: invoice } });
    const flagged = await db.timelineEvent.count({ where: { entity_id: invoice, event_type: 'OVERPAYMENT_FLAGGED' } });
    return { status: inv.status, due: Number(inv.amount_due), payments, flagged };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('refuses $100.01 on a $100.00 balance: 400 AMOUNT_ABOVE_BALANCE, nothing written', async () => {
    const { invoice } = await fixture();
    const res = await pay(invoice, { amount: 100.01 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_ABOVE_BALANCE');
    expect(res.body.error).toBe('That is more than the $100.00 balance due. Enter $100.00 or less.');
    expect(await state(invoice)).toEqual({ status: 'SENT', due: 100, payments: 0, flagged: 0 });
  });

  it('exactly the balance ends PAID, with no overpaid flag in the response', async () => {
    const { invoice } = await fixture();
    const res = await pay(invoice, { amount: 100 });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('overpaid');
    expect(await state(invoice)).toEqual({ status: 'PAID', due: 0, payments: 1, flagged: 0 });
  });

  it('a part payment leaves PARTIAL; the next one above the new balance is refused, the exact one completes', async () => {
    const { invoice } = await fixture();
    expect((await pay(invoice, { amount: 40 })).status).toBe(201);
    expect(await state(invoice)).toEqual({ status: 'PARTIAL', due: 60, payments: 1, flagged: 0 });

    const refused = await pay(invoice, { amount: 60.01 });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('That is more than the $60.00 balance due. Enter $60.00 or less.');
    expect(await state(invoice)).toEqual({ status: 'PARTIAL', due: 60, payments: 1, flagged: 0 });

    expect((await pay(invoice, { amount: 60 })).status).toBe(201);
    expect(await state(invoice)).toEqual({ status: 'PAID', due: 0, payments: 2, flagged: 0 });
  });

  it('a tip on top of exactly the balance is accepted and does not change the balance', async () => {
    const { invoice } = await fixture();
    const res = await pay(invoice, { amount: 100, tip_amount: 25 });
    expect(res.status).toBe(201);
    expect(Number(res.body.payment.tip_amount)).toBe(25);
    expect(await state(invoice)).toEqual({ status: 'PAID', due: 0, payments: 1, flagged: 0 });
  });

  it('a payable invoice with $0 due answers "There is nothing left to pay on this invoice."', async () => {
    const { invoice } = await fixture({ total: 100, due: 0, status: 'PARTIAL' });
    const res = await pay(invoice, { amount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_ABOVE_BALANCE');
    expect(res.body.error).toBe('There is nothing left to pay on this invoice.');
    expect((await state(invoice)).payments).toBe(0);
  });

  it('a DRAFT invoice is capped too', async () => {
    const { invoice } = await fixture({ status: 'DRAFT' });
    const res = await pay(invoice, { amount: 150 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_ABOVE_BALANCE');
    expect(await state(invoice)).toEqual({ status: 'DRAFT', due: 100, payments: 0, flagged: 0 });
  });

  it('formats a four-figure balance with a thousands separator', async () => {
    const { invoice } = await fixture({ total: 1234.5 });
    const res = await pay(invoice, { amount: 1300 });
    expect(res.body.error).toBe('That is more than the $1,234.50 balance due. Enter $1,234.50 or less.');
  });

  it('a bank payment still processing keeps its own 409 message, which wins over the cap message', async () => {
    const { invoice } = await fixture();
    await db.payment.create({
      data: { invoice_id: invoice, amount: 30, method: 'ACH', paid_at: new Date(), state: 'PROCESSING' },
    });
    // 80 is above payable-now ($70) AND below the balance: the processing refusal.
    const processing = await pay(invoice, { amount: 80 });
    expect(processing.status).toBe(409);
    expect(processing.body.error).toMatch(/still processing/);
    // 150 is above both: the processing message still comes first.
    const both = await pay(invoice, { amount: 150 });
    expect(both.status).toBe(409);
    expect(both.body.code).toBeUndefined();
    expect(both.body.error).toMatch(/still processing/);
  });

  it('another org cannot record on the invoice: 404, nothing written', async () => {
    const { invoice } = await fixture();
    const other = await makeOrg();
    await loginAs(other.user, other.tag);
    const res = await pay(invoice, { amount: 10 });
    expect(res.status).toBe(404);
    expect((await state(invoice)).payments).toBe(0);
  });

  it('two hand payments at the same moment, each for the full balance: one books, the other is refused', async () => {
    const { invoice } = await fixture();
    const [a, b] = await Promise.all([pay(invoice, { amount: 100 }), pay(invoice, { amount: 100 })]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(await state(invoice)).toEqual({ status: 'PAID', due: 0, payments: 1, flagged: 0 });
  });

  it('three simultaneous $60 payments on a $100 balance: exactly one books, two are refused by the cap, balance $40', async () => {
    const { invoice } = await fixture();
    const results = await Promise.all([pay(invoice, { amount: 60 }), pay(invoice, { amount: 60 }), pay(invoice, { amount: 60 })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    for (const r of results.filter((x) => x.status === 400)) expect(r.body.code).toBe('AMOUNT_ABOVE_BALANCE');
    expect(await state(invoice)).toEqual({ status: 'PARTIAL', due: 40, payments: 1, flagged: 0 });
  });
});
