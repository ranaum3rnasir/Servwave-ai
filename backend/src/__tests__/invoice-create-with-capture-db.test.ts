/* =============================================================================
   V7-09b (BE-11, BE-14 rows 10 and 11) - create a standalone invoice that records an unapplied payment.
   Real migrated database (TEST_DATABASE_URL), the real route and a real role; only the processor and the
   identity provider are faked. Skips when unset.

   The rule under test: the invoice is created AND the whole payment is booked on it in one transaction, or
   nothing is. A total below the payment creates no invoice and leaves the item as it was.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { getStripeForOrg, listPaymentIntentRefunds, retrieveCapturePayerDetail } from '../lib/stripe';
import { sendPaymentReceivedEmail } from '../lib/email';
import { addCapture, cleanupOrgs, seedOrg, signedInAs } from './helpers/unapplied-money-fixture';

const suite = realClient ? describe : describe.skip;
const payerRead = retrieveCapturePayerDetail as unknown as ReturnType<typeof vi.fn>;
const receipt = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;

suite('create an invoice for an unapplied payment (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  afterAll(async () => {
    await cleanupOrgs(db, orgs);
    await db.$disconnect();
  });
  beforeEach(() => {
    payerRead.mockReset();
    payerRead.mockResolvedValue({ method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: null });
    receipt.mockClear();
    vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: undefined } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  const line = (unit_price: number, is_taxable = false) => ({ description: 'Service call', quantity: 1, unit_price, is_taxable });
  const create = (api: ReturnType<typeof signedInAs>, f: { customer: string }, captureId: string | undefined, items = [line(120)]) =>
    api.post('/api/invoices', { customer_id: f.customer, line_items: items, ...(captureId ? { unapplied_capture_id: captureId } : {}) });
  const capRow = (id: string) => db.unappliedCapture.findUniqueOrThrow({ where: { id } });
  const invoicesOf = (org: string) => db.invoice.findMany({ where: { organization_id: org } });

  it('a total equal to the payment: the invoice is PAID, the payment is on it, the item is RESOLVED', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    const api = signedInAs(app, f.admin);

    const res = await create(api, f, capture.id);

    expect(res.status).toBe(201);
    expect(res.body.attached_capture).toBe(true);
    const [invoice] = await invoicesOf(f.org);
    expect(invoice).toMatchObject({ status: 'PAID', kind: 'STANDARD' });
    expect(Number(invoice.amount_due)).toBe(0);
    expect(res.body.invoice).toMatchObject({ id: invoice.id, status: 'PAID' });
    const payments = await db.payment.findMany({ where: { invoice_id: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'CARD', state: 'SUCCEEDED', card_brand: 'visa', card_last4: '4242', stripe_payment_intent_id: capture.stripe_payment_intent_id });
    expect(Number(payments[0].amount)).toBe(120);
    expect(await capRow(capture.id)).toMatchObject({
      status: 'RESOLVED', resolution_note: `Invoice ${invoice.invoice_number} created, payment recorded`, resolved_by: f.admin.id,
    });
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledTimes(1));
  });

  it('a total larger than the payment: the invoice is PARTIAL with the rest due', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });

    const res = await create(signedInAs(app, f.admin), f, capture.id, [line(200)]);

    expect(res.status).toBe(201);
    const [invoice] = await invoicesOf(f.org);
    expect(invoice.status).toBe('PARTIAL');
    expect(Number(invoice.amount_due)).toBe(80);
    expect((await capRow(capture.id)).status).toBe('RESOLVED');
  });

  it('a total below the payment: 400 INVOICE_TOTAL_BELOW_PAYMENT, no invoice, the item unchanged', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });

    const res = await create(signedInAs(app, f.admin), f, capture.id, [line(119.99)]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVOICE_TOTAL_BELOW_PAYMENT', error: 'The invoice must be at least $120.00 so the payment fits.' });
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect(await db.payment.count({ where: { invoice: { organization_id: f.org } } })).toBe(0);
    expect(await capRow(capture.id)).toMatchObject({ status: 'OPEN', resolution_note: null });
    // No number was consumed: the next invoice made without a payment still gets the first one.
    const next = await create(signedInAs(app, f.admin), f, undefined, [line(10)]);
    expect(next.status).toBe(201);
    expect(next.body.invoice.invoice_number).toMatch(/00001$/);
  });

  it('tax counts: a subtotal below the payment with a total at or above it is allowed', async () => {
    const f = await seedOrg(db, orgs);
    await db.serviceLocation.create({ data: { customer_id: f.customer, address_line1: '1 Main St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true } });
    await db.orgTaxRate.create({ data: { organization_id: f.org, name: 'MA', rate: 0.1, state_code: 'MA' } });
    const capture = await addCapture(db, f, { amount: 105 });

    const res = await create(signedInAs(app, f.admin), f, capture.id, [line(100, true)]);

    expect(res.status).toBe(201);
    const [invoice] = await invoicesOf(f.org);
    expect(Number(invoice.total_amount)).toBe(110);
    expect(invoice.status).toBe('PARTIAL');
    expect(Number(invoice.amount_due)).toBe(5);
    await db.orgTaxRate.deleteMany({ where: { organization_id: f.org } });
  });

  it('an item already resolved or refunded is refused 409 and nothing is created', async () => {
    const f = await seedOrg(db, orgs);
    const resolved = await addCapture(db, f, { amount: 120, status: 'RESOLVED' });
    const refunded = await addCapture(db, f, { amount: 120, status: 'REFUNDED' });
    const api = signedInAs(app, f.admin);

    for (const c of [resolved, refunded]) {
      const res = await create(api, f, c.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This payment was already attached, refunded or resolved.');
    }
    expect(await invoicesOf(f.org)).toHaveLength(0);
  });

  it('money on a payment row (a payment: key) is refused 409 and nothing is created (C-46)', async () => {
    const f = await seedOrg(db, orgs);
    const onRow = await addCapture(db, f, { amount: 30, sourceKey: `payment:${randomUUID()}`, reason: 'OVERPAYMENT' });

    const res = await create(signedInAs(app, f.admin), f, onRow.id, [line(40)]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_PAYMENT_ROW');
    expect(await invoicesOf(f.org)).toHaveLength(0);
  });

  it('a stray refund is not a payment to record: refused, nothing created', async () => {
    const f = await seedOrg(db, orgs);
    const stray = await addCapture(db, f, { amount: 30, reason: 'REFUND_UNMATCHED' });

    const res = await create(signedInAs(app, f.admin), f, stray.id, [line(40)]);

    expect(res.status).toBe(409);
    expect(await invoicesOf(f.org)).toHaveLength(0);
  });

  it('a job anchor with a payment is 400', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });

    const res = await signedInAs(app, f.admin).post('/api/invoices', { job_id: randomUUID(), unapplied_capture_id: capture.id });

    expect(res.status).toBe(400);
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('someone who may create invoices but not send money back is refused 403, nothing created', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    const sales = { id: randomUUID(), email: `sales-${f.tag}@example.test` };
    await db.user.create({ data: { id: sales.id, organization_id: f.org, email: sales.email, first_name: 'Sam', last_name: 'Sales', role: 'TECHNICIAN' } });

    const res = await create(signedInAs(app, sales), f, capture.id);

    expect([401, 403]).toContain(res.status);
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('a caller whose invoice reach is narrowed cannot record an item that sits outside it', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    const rep = { id: randomUUID(), email: `rep-${f.tag}@example.test` };
    await db.user.create({ data: { id: rep.id, organization_id: f.org, email: rep.email, first_name: 'Rae', last_name: 'Rep', role: 'SALES' } });
    await setRoleSwitchValues({
      organizationId: f.org, roleKey: 'SALES', actorId: null, reason: 'manual',
      values: { invoices_scope: 'attached', refund_payments: true, view_payments: true, create_invoices: true, standalone_invoices: true },
    });
    clearPermissionCache(f.org);

    const res = await create(signedInAs(app, rep), f, capture.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
    // The same switches without the item are an ordinary invoice, so the refusal is about the item.
    expect((await create(signedInAs(app, rep), f, undefined, [line(10)])).status).toBe(201);
  });

  it('a refund of the money at the processor that the item has not counted refuses the new invoice too', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    const refunds = listPaymentIntentRefunds as unknown as ReturnType<typeof vi.fn>;
    refunds.mockResolvedValueOnce([{ id: 're_v709b_lost', status: 'pending', amount: 5000, metadata: {} }]);

    const res = await create(signedInAs(app, f.admin), f, capture.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_IN_PROGRESS');
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('another company\'s item is not found', async () => {
    const f = await seedOrg(db, orgs);
    const other = await seedOrg(db, orgs);
    const theirs = await addCapture(db, other, { amount: 50 });

    const res = await create(signedInAs(app, f.admin), f, theirs.id);

    expect(res.status).toBe(404);
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(theirs.id)).status).toBe('OPEN');
  });

  it('a payer read that fails creates nothing', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    payerRead.mockResolvedValue(null);

    const res = await create(signedInAs(app, f.admin), f, capture.id);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PAYER_UNAVAILABLE');
    expect(await invoicesOf(f.org)).toHaveLength(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('two invoices created for one payment at once: the payment is booked once, whatever the loser answers', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120 });
    const api = signedInAs(app, f.admin);

    const [a, b] = await Promise.all([create(api, f, capture.id), create(api, f, capture.id)]);

    // One invoice carries the payment; the other request made nothing. (Two invoices made at the very same instant can
    // also meet the existing invoice-number race, which answers 500: that is not new here, and it books nothing either.)
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 201 || s === 409 || s === 500)).toHaveLength(2);
    expect(await invoicesOf(f.org)).toHaveLength(1);
    expect(await db.payment.count({ where: { invoice: { organization_id: f.org } } })).toBe(1);
    expect((await capRow(capture.id)).status).toBe('RESOLVED');
  });

  it('a payment partly refunded books only what is left, and the invoice must cover that', async () => {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount: 120, refunded: 40 });
    const api = signedInAs(app, f.admin);

    expect((await create(api, f, capture.id, [line(79)])).status).toBe(400);
    const ok = await create(api, f, capture.id, [line(80)]);

    expect(ok.status).toBe(201);
    const [invoice] = await invoicesOf(f.org);
    expect(invoice.status).toBe('PAID');
    const [payment] = await db.payment.findMany({ where: { invoice_id: invoice.id } });
    expect(Number(payment.amount)).toBe(80);
  });

  it('an invoice without a payment is created exactly as before (no payment, no attached_capture)', async () => {
    const f = await seedOrg(db, orgs);

    const res = await create(signedInAs(app, f.admin), f, undefined, [line(50)]);

    expect(res.status).toBe(201);
    expect(res.body.attached_capture).toBeUndefined();
    const [invoice] = await invoicesOf(f.org);
    expect(invoice.status).toBe('DRAFT');
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
  });
});
