/* =============================================================================
   V7-12b - no overpaid invoices: an invoice edit that would take the total below what is already
   paid or credited is refused (BE-14d, D-16) and the write that came before the recompute rolls
   back. Drives the real line and scope routes against a real, migrated database; only the identity provider is mocked. Skips when TEST_DATABASE_URL is unset.
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

suite('refuse an edit below what is covered (real database)', () => {
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
        id: org, name: `v712b-${tag}`, email: `edit-${tag}@example.test`,
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
    token = `v712b-${tag}`;
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
  }

  const SCOPE = '11111111-1111-4111-8111-111111111111';

  /** Invoice: line 500 + scope 500 = total 1000 (no tax), $600 collected -> due 400, covered 600. */
  async function fixture() {
    const o = await makeOrg();
    const invoice = randomUUID();
    const line = randomUUID();
    await db.invoice.create({
      data: {
        id: invoice, organization_id: o.org, customer_id: o.customer, invoice_number: `INV-${o.tag}`,
        status: 'PARTIAL', subtotal: 1000, tax_rate: 0, tax_amount: 0, total_amount: 1000, amount_due: 400,
        scopes: [{ id: SCOPE, title: 'Permit', body: '', flat_price: 500, is_taxable: false, internal_cost: null }],
      },
    });
    await db.invoiceLineItem.create({
      data: { id: line, invoice_id: invoice, sequence: 1, description: 'Labor', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 },
    });
    await loginAs(o.user, o.tag);
    return { ...o, invoice, line };
  }

  let token = '';
  const call = (method: 'post' | 'patch' | 'delete', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${token}`);

  async function state(invoice: string) {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const lines = await db.invoiceLineItem.findMany({ where: { invoice_id: invoice }, orderBy: { sequence: 'asc' } });
    return {
      status: inv.status, total: Number(inv.total_amount), due: Number(inv.amount_due),
      lines: lines.map((l) => Number(l.unit_price)), scopes: (inv.scopes as Array<{ flat_price: number }>).map((s) => s.flat_price),
    };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  const UNTOUCHED = { status: 'PARTIAL', total: 1000, due: 400, lines: [500], scopes: [500] };

  it('a line price cut below what is paid answers 409 and the line is left as it was', async () => {
    const { invoice, line } = await fixture();
    const res = await call('patch', `/api/invoices/${invoice}/line-items/${line}`).send({ unit_price: 50 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOTAL_BELOW_PAID');
    expect(res.body.error).toBe(
      'This change would bring the invoice to $550.00, which is less than the $600.00 already paid or credited on it. Keep the total at $600.00 or more.',
    );
    expect(await state(invoice)).toEqual(UNTOUCHED);
  });

  it('deleting the line below what is paid answers 409 and the row survives', async () => {
    const { invoice, line } = await fixture();
    const res = await call('delete', `/api/invoices/${invoice}/line-items/${line}`);
    expect(res.status).toBe(409);
    expect(await state(invoice)).toEqual(UNTOUCHED);
  });

  it('a scope price cut below what is paid answers 409 and the scope write rolls back', async () => {
    const { invoice } = await fixture();
    const res = await call('patch', `/api/invoices/${invoice}/scopes/0`).send({ flat_price: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOTAL_BELOW_PAID');
    expect(await state(invoice)).toEqual(UNTOUCHED);
  });

  it('deleting the scope below what is paid answers 409 and the scope is still there', async () => {
    const { invoice } = await fixture();
    const res = await call('delete', `/api/invoices/${invoice}/scopes/0`);
    expect(res.status).toBe(409);
    expect(await state(invoice)).toEqual(UNTOUCHED);
  });

  it('an edit that lands exactly on what is paid saves: PAID and locked', async () => {
    const { invoice } = await fixture();
    const res = await call('patch', `/api/invoices/${invoice}/scopes/0`).send({ flat_price: 100 });
    expect(res.status).toBe(200);
    expect(await state(invoice)).toEqual({ status: 'PAID', total: 600, due: 0, lines: [500], scopes: [100] });
  });

  it('a raise saves, keeping the payment: due grows by exactly the raise', async () => {
    const { invoice, line } = await fixture();
    const res = await call('patch', `/api/invoices/${invoice}/line-items/${line}`).send({ unit_price: 800 });
    expect(res.status).toBe(200);
    expect(await state(invoice)).toEqual({ status: 'PARTIAL', total: 1300, due: 700, lines: [800], scopes: [500] });
  });

  it('a reorder on an invoice with payments saves', async () => {
    const { invoice, line } = await fixture();
    const res = await call('patch', `/api/invoices/${invoice}/line-items/reorder`).send({ order: [line] });
    expect(res.status).toBe(200);
    expect(await state(invoice)).toEqual(UNTOUCHED);
  });
});
