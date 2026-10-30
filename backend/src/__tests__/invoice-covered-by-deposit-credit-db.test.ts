/* =============================================================================
   Payments go-live, slice 32b item 1 - a final invoice whose deposit credit covers its whole total
   reads PAID. Nobody owes anything on it, so it is not an outstanding invoice, and Void (offered on
   a PAID invoice that holds no money taken) can be reached.

   Driven through the real doors (create from the job, payment link, send, line edit, a bounced
   deposit payment voided) against a real, migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('an invoice covered by its deposit credit reads Paid (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM job_line_items WHERE organization_id = '${org}'`));
      for (const table of ['timeline_events', 'notifications', 'invoices', 'jobs', 'estimates']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['mailbox_addresses', 'mailboxes', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A job of `jobTotal` whose estimate's $100 deposit was paid (by check): the next invoice draws it. */
  async function fixture(opts: { jobTotal: number; deposit?: number }) {
    const deposit = opts.deposit ?? 100;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const estimate = randomUUID();
    const depositInvoice = randomUUID();
    const job = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay32b-${tag}`, email: `pay32b-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    // The send goes out from the sender's own mailbox (PRD 10, S10.12), so the admin has one with an address.
    const mailbox = randomUUID();
    await db.mailbox.create({ data: { id: mailbox, organization_id: org, kind: 'user', user_id: user, holder_user_id: user, status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `admin-${tag}`, organization_id: org, mailbox_id: mailbox, is_primary: true } });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test`,
      },
    });
    const location = await db.serviceLocation.create({
      data: { customer_id: customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: 'PENDING', subtotal: opts.jobTotal, tax_amount: 0, total_amount: opts.jobTotal,
      },
    });
    await db.invoice.create({
      data: {
        id: depositInvoice, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
        invoice_number: `D-${tag}`, subtotal: deposit, tax_amount: 0, total_amount: deposit, amount_due: 0,
        net_collected: deposit, status: 'PAID', paid_at: new Date(),
      },
    });
    const depositPayment = await db.payment.create({
      data: { invoice_id: depositInvoice, amount: deposit, method: 'CHECK', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
    });
    await db.job.create({
      data: {
        id: job, organization_id: org, customer_id: customer, service_location_id: location.id, estimate_id: estimate,
        job_number: `J-${tag}`, status: 'SCHEDULED', tax_rate: 0,
      },
    });
    const line = await db.jobLineItem.create({
      data: {
        job_id: job, organization_id: org, sequence: 1, description: 'Service', quantity: 1,
        unit_price: opts.jobTotal, line_total: opts.jobTotal,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay32b-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body),
      patch: (path: string, body: object) => request(app).patch(path).set('Authorization', bearer).send(body),
    };
    /** Raise the final invoice from the job: a DRAFT that has drawn the deposit down. */
    const raiseInvoice = async () => {
      const res = await api.post('/api/invoices', { job_id: job });
      expect(res.status).toBe(201);
      return res.body.invoice.id as string;
    };
    const read = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });
    return { org, tag, job, line, deposit, depositInvoice, depositPayment, api, raiseInvoice, read };
  }

  it('sending an invoice its deposit credit fully covers makes it PAID, with a paid date', async () => {
    const f = await fixture({ jobTotal: 100 });
    const id = await f.raiseInvoice();
    expect(Number((await f.read(id)).amount_due)).toBe(0);

    expect((await f.api.post(`/api/invoices/${id}/send`)).status).toBe(200);

    const sent = await f.read(id);
    expect(sent.status).toBe('PAID');
    expect(sent.paid_at).not.toBeNull();
  });

  it('a payment link on a covered invoice leaves it DRAFT (W4: only Send and Mark as sent issue it)', async () => {
    const f = await fixture({ jobTotal: 100 });
    const id = await f.raiseInvoice();

    expect((await f.api.post(`/api/invoices/${id}/payment-link`)).status).toBe(200);

    expect((await f.read(id)).status).toBe('DRAFT');
  });

  it('an invoice the credit only part-covers stays SENT, still outstanding', async () => {
    const f = await fixture({ jobTotal: 250 });
    const id = await f.raiseInvoice();

    expect((await f.api.post(`/api/invoices/${id}/send`)).status).toBe(200);

    const sent = await f.read(id);
    expect(sent.status).toBe('SENT');
    expect(sent.paid_at).toBeNull();
    expect(Number(sent.amount_due)).toBe(150);
  });

  it('a covered invoice is in no unpaid list, and Void is offered on it', async () => {
    const f = await fixture({ jobTotal: 100 });
    const id = await f.raiseInvoice();
    await f.api.post(`/api/invoices/${id}/send`);
    expect((await f.read(id)).status).toBe('PAID');
    const number = (await f.read(id)).invoice_number;

    const aging = await f.api.get('/api/reports/ar-aging');
    expect(aging.status).toBe(200);
    expect(JSON.stringify(aging.body)).not.toContain(number);

    const voided = await f.api.post(`/api/invoices/${id}/void`, { voided_reason: 'Entered twice' });
    expect(voided.status).toBe(200);
    expect((await f.read(id)).status).toBe('VOIDED');
  });

  it('a covered invoice does not count its credit as money collected a second time', async () => {
    const f = await fixture({ jobTotal: 100 });
    const id = await f.raiseInvoice();
    await f.api.post(`/api/invoices/${id}/send`);

    const report = await f.api.get('/api/reports/payments');
    expect(report.status).toBe(200);
    // Two rows carry the $100: the deposit's own payment, and the credit that mirrors it on the
    // covered invoice. The credit is flagged, so the report's sums leave it out: collected once.
    const rows = report.body.payments as Array<{ amount: number; isDepositCredit: boolean }>;
    expect(rows).toHaveLength(2);
    const counted = rows.filter((r) => !r.isDepositCredit).reduce((sum, r) => sum + Number(r.amount), 0);
    expect(counted).toBe(100);
  });

  it('editing a SENT invoice down to its deposit credit settles it to PAID', async () => {
    const f = await fixture({ jobTotal: 250 });
    const id = await f.raiseInvoice();
    await f.api.post(`/api/invoices/${id}/send`);
    expect((await f.read(id)).status).toBe('SENT');
    const line = await db.invoiceLineItem.findFirstOrThrow({ where: { invoice_id: id } });

    const edit = await f.api.patch(`/api/invoices/${id}/line-items/${line.id}`, { unit_price: 100 });
    expect(edit.status).toBe(200);

    const after = await f.read(id);
    expect(Number(after.amount_due)).toBe(0);
    expect(after.status).toBe('PAID');
    expect(after.paid_at).not.toBeNull();
  });

  it('taking the credit back (the deposit payment voided) re-opens it to SENT with the balance back', async () => {
    const f = await fixture({ jobTotal: 100 });
    const id = await f.raiseInvoice();
    await f.api.post(`/api/invoices/${id}/send`);
    expect((await f.read(id)).status).toBe('PAID');

    const res = await f.api.post(`/api/invoices/${f.depositInvoice}/void-payment`, {
      payment_id: f.depositPayment.id, void_category: 'BOUNCED', reason: 'Check bounced',
    });
    expect(res.status).toBe(200);

    const after = await f.read(id);
    expect(after.status).toBe('SENT');
    expect(after.paid_at).toBeNull();
    expect(Number(after.amount_due)).toBe(100);
  });
});
