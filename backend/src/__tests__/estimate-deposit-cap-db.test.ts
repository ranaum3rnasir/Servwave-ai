/* =============================================================================
   V7-12a - no overpaid invoices: a deposit recorded by hand on an estimate is never more than the
   open deposit invoice still owes (BE-14c). Drives the real route (POST /api/estimates/:id/record-
   payment) against a real, migrated database; only the identity provider is mocked. Skips when
   TEST_DATABASE_URL is unset.
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

suite('hand-recorded deposit cap (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  let token = '';
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  /** A sent $1,000 estimate asking for a $500 deposit; `deposit` is its open deposit invoice, or none. */
  async function fixture(deposit: { due: number; status: 'SENT' | 'PARTIAL' } | null) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const estimate = randomUUID();
    const depositId = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `v712a-est-${tag}`, email: `cap-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000,
        public_token: `est-${tag}`, deposit_type: 'FIXED', deposit_value: 500,
        send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'CHECK'] } },
      },
    });
    if (deposit) {
      await db.invoice.create({
        data: {
          id: depositId, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
          invoice_number: `D-${tag}`, status: deposit.status, subtotal: 500, tax_amount: 0, total_amount: 500,
          amount_due: deposit.due, public_token: `dep-${tag}`,
        },
      });
    }
    token = `v712a-est-${tag}`;
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    return { org, estimate, depositId };
  }

  const record = (estimate: string, amount: number) =>
    request(app).post(`/api/estimates/${estimate}/record-payment`).set('Authorization', `Bearer ${token}`).send({ amount, payment_method: 'CHECK' });

  async function depositState(org: string) {
    const invs = await db.invoice.findMany({ where: { organization_id: org, kind: 'DEPOSIT' } });
    const payments = await db.payment.findMany({ where: { invoice: { organization_id: org } }, orderBy: [{ paid_at: 'asc' }, { created_at: 'asc' }, { id: 'asc' }] });
    return { invoices: invs.map((i) => [i.status, Number(i.amount_due)]), payments: payments.map((p) => Number(p.amount)) };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('refuses $100.01 on a $100.00 open deposit: 400 AMOUNT_ABOVE_BALANCE, nothing written', async () => {
    const { org, estimate } = await fixture({ due: 100, status: 'SENT' });
    const res = await record(estimate, 100.01);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_ABOVE_BALANCE');
    expect(res.body.error).toBe('That is more than the $100.00 deposit still due. Enter $100.00 or less.');
    expect(await depositState(org)).toEqual({ invoices: [['SENT', 100]], payments: [] });
  });

  it('a partial $30 leaves $70; $70.01 is refused and $70 completes the deposit', async () => {
    const { org, estimate } = await fixture({ due: 100, status: 'SENT' });
    expect((await record(estimate, 30)).status).toBe(200);
    expect((await depositState(org)).invoices).toEqual([['PARTIAL', 70]]);

    const refused = await record(estimate, 70.01);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('That is more than the $70.00 deposit still due. Enter $70.00 or less.');
    expect(await depositState(org)).toEqual({ invoices: [['PARTIAL', 70]], payments: [30] });

    expect((await record(estimate, 70)).status).toBe(200);
    expect(await depositState(org)).toEqual({ invoices: [['PAID', 0]], payments: [30, 70] });
  });

  it('with no deposit invoice yet, one is created for exactly the typed amount', async () => {
    const { org, estimate } = await fixture(null);
    const res = await record(estimate, 750);
    expect(res.status).toBe(200);
    expect(await depositState(org)).toEqual({ invoices: [['PAID', 0]], payments: [750] });
  });
});
