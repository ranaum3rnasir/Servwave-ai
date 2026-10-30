/* =============================================================================
   Payments go-live, slice 05 - only SUCCEEDED payments count; failed refunds don't.

   A bank debit sits in PROCESSING for days and may still fail, and a refund can be PENDING
   (bank) or FAILED. None of that is money collected or money given back. So:
     - amount paid, balance and invoice status move only on SUCCEEDED payments;
     - INVOICE_PAID fires once, when SUCCEEDED money reaches the total;
     - total_refunded sums SUCCEEDED refunds only;
     - "Collected" figures and the payments report leave PROCESSING and FAILED rows out.

   The state flips go through lib/payment-ledger (the door the processor events will use);
   everything else is driven through the real routes, against a real migrated database
   (TEST_DATABASE_URL), because the rules are WHERE clauses a mocked client cannot check.
   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

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
import { constructWebhookEvent } from '../lib/stripe';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const dispatched = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

suite('only SUCCEEDED payments count (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // A 127.0.0.1 listener, so a request can only reach this app (see loopback-app.ts).
  let app: Server;
  let ledger: typeof import('../lib/payment-ledger.js');
  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
    ledger = await import('../lib/payment-ledger.js');
  });
  beforeEach(() => dispatched.mockClear());

  async function fixture(opts: { total: number; onJob?: boolean }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay05-${tag}`, email: `pay05-${tag}@example.test`,
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
    const job = opts.onJob ? randomUUID() : null;
    if (job) {
      const location = await db.serviceLocation.create({
        data: { customer_id: customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
      });
      await db.job.create({
        data: {
          id: job, organization_id: org, customer_id: customer, service_location_id: location.id,
          job_number: `J-${tag}`, status: 'COMPLETED', amount_invoiced: opts.total,
        },
      });
    }
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, job_id: job, invoice_number: `INV-${tag}`, status: 'SENT',
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total, amount_due: opts.total,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer pay05-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    // A report fixture: a payment row written straight into the table, in any state.
    const seedPayment = async (amount: number, state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED') =>
      (await db.payment.create({
        data: { invoice_id: invoice, amount, method: 'ACH', paid_at: new Date(), state, created_by_source: 'CLIENT' },
      })).id;
    const readInvoice = async () => {
      const res = await api.get(`/api/invoices/${invoice}`);
      expect(res.status).toBe(200);
      return { status: res.body.invoice.status as string, amountDue: Number(res.body.invoice.amount_due), totalRefunded: Number(res.body.invoice.total_refunded) };
    };
    // A refund recorded by hand (cash back): no processor call, written SUCCEEDED.
    const refund = (amount: number) =>
      api.post(`/api/invoices/${invoice}/refund`, { amount, method: 'CASH', reason_category: 'CUSTOMER_REQUEST', reason: 'slice 05 test' });
    return { org, user, customer, job, invoice, api, seedPayment, readInvoice, refund };
  }

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      // Children first; the invoice is held by Restrict foreign keys from payments and refunds.
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay05_%'`));
    await db.$disconnect();
  });

  const invoicePaidDispatches = (invoiceId: string) =>
    dispatched.mock.calls.filter(([ev]) => ev?.type === 'INVOICE_PAID' && ev?.entity?.id === invoiceId);

  it('a PROCESSING payment leaves the invoice PARTIAL; once it SUCCEEDS the invoice is PAID and INVOICE_PAID fires once', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
    // The bank debit starts through the ledger's door (the one the processor's events use), so
    // the balance below is the door's doing, not a fixture's: it must not come down to $0.
    const processing = await ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 50, method: 'ACH', paymentIntentId: `pi_pay05_${randomUUID()}`,
    });

    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(0);
    // The door is tenant-scoped: another org cannot start a payment on this invoice.
    await expect(ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: randomUUID(), amount: 50, method: 'ACH', paymentIntentId: `pi_pay05_${randomUUID()}`,
    })).rejects.toThrow(/not found/);
    // The screens sum the payment history themselves, so every row carries its state.
    const detail = await f.api.get(`/api/invoices/${f.invoice}`);
    expect(detail.body.invoice.payments.map((p: { amount: string; state: string }) => [Number(p.amount), p.state]))
      .toEqual([[100, 'SUCCEEDED'], [50, 'PROCESSING']]);

    await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(1);

    // The same event delivered again changes nothing and fires nothing.
    await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(1);
  });

  it('a bank debit delivered twice, one after the other or at the same time, is one PROCESSING row and its money lands once', async () => {
    const f = await fixture({ total: 300 });
    const pi = `pi_pay05_dup_${f.org.slice(0, 8)}`;
    const start = () => ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 100, method: 'ACH', paymentIntentId: pi,
    });

    const first = await start();
    const [again, raced] = await Promise.all([start(), start()]);
    expect(again).toBe(first);
    expect(raced).toBe(first);
    // The processor's id is on the row, so its later "succeeded" event can find it.
    const rows = await db.payment.findMany({ where: { invoice_id: f.invoice }, select: { id: true, stripe_payment_intent_id: true } });
    expect(rows).toEqual([{ id: first, stripe_payment_intent_id: pi }]);

    await ledger.settlePayment({ paymentId: first, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 200 });
  });

  // What a person finds when money lands that the invoice cannot take: a timeline entry on the
  // invoice, an admin alert, and an audit row (the same record a refused card capture leaves).
  async function unappliedRecord(f: Awaited<ReturnType<typeof fixture>>) {
    const timeline = await f.api.get(`/api/invoices/${f.invoice}/timeline`);
    expect(timeline.status).toBe(200);
    const entries = (timeline.body.events as Array<{ event_type: string; description: string; metadata: Record<string, unknown> }>)
      .filter((e) => e.event_type === 'PAYMENT_UNRECORDED');
    const inbox = await f.api.get('/api/notifications');
    expect(inbox.status).toBe(200);
    const alerts = (inbox.body.items as Array<{ verb: string; title: string; body: string | null }>)
      .filter((n) => n.verb === 'billing.payment_unrecorded');
    // logAudit is fire-and-forget; give it a moment to land.
    let audits: Array<{ metadata: unknown }> = [];
    for (let i = 0; i < 20 && audits.length === 0; i++) {
      audits = await db.auditLog.findMany({ where: { org_id: f.org, action: 'billing.payment_unrecorded', resource_id: f.invoice } });
      if (audits.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    return { entries, alerts, audits };
  }

  it('a bank payment that clears after the invoice was closed for payment is SUCCEEDED and written down, never silently dropped', async () => {
    const f = await fixture({ total: 150 });
    const processing = await ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 50, method: 'ACH', paymentIntentId: `pi_pay05_${randomUUID()}`,
    });
    // The invoice is closed for payment while the bank debit is still clearing. Staff cannot record
    // the whole bill by hand meanwhile (slice 28b: Record Payment works from payable-now), so the
    // close is written directly, as any other path that settles the invoice would.
    await realClient!.invoice.update({ where: { id: f.invoice }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
    const paidFires = invoicePaidDispatches(f.invoice).length;

    const result = await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect(result).toEqual({ changed: true, becamePaid: false });

    // The invoice is not touched, and INVOICE_PAID does not fire a second time.
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(paidFires);
    const detail = await f.api.get(`/api/invoices/${f.invoice}`);
    expect(detail.body.invoice.payments.find((p: { id: string }) => p.id === processing)?.state).toBe('SUCCEEDED');

    // The $50 that landed is on record where a person finds it.
    const { entries, alerts, audits } = await unappliedRecord(f);
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ reason: 'INVOICE_NOT_PAYABLE', payment_id: processing, charged_cents: 5000, unapplied_cents: 5000 });
    expect(entries[0].description).toContain(`INV-${f.org.slice(0, 8)}`);
    // The words name no figure (M4); it is on the entry's metadata (charged_cents, unapplied_cents), behind See prices.
    expect(entries[0].description).not.toMatch(/\$\s*\d/);
    expect(entries[0].description).toContain('was not applied');
    expect(alerts).toHaveLength(1);
    expect(audits).toHaveLength(1);
    // Staff-facing copy names no vendor.
    for (const text of [entries[0].description, alerts[0].title, alerts[0].body ?? '']) {
      expect(text).not.toMatch(/stripe/i);
    }

    // A re-delivered event records nothing new.
    await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect((await unappliedRecord(f)).entries).toHaveLength(1);
  });

  it('a bank payment that clears for more than the balance settles the invoice to PAID and writes the excess down', async () => {
    const f = await fixture({ total: 100 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 30, method: 'CASH' })).status).toBe(201);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 70 });
    const processing = await ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 100, method: 'ACH', paymentIntentId: `pi_pay05_${randomUUID()}`,
    });

    const result = await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect(result).toEqual({ changed: true, becamePaid: true });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(1);

    // $70 settled the balance; the other $30 is on record, not clamped away.
    const { entries, alerts, audits } = await unappliedRecord(f);
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ reason: 'OVERPAYMENT', payment_id: processing, charged_cents: 10000, unapplied_cents: 3000 });
    expect(entries[0].description).not.toMatch(/\$\s*\d/);
    expect(entries[0].description).toContain('was more than the balance due');
    expect(alerts).toHaveLength(1);
    expect(audits).toHaveLength(1);
    for (const text of [entries[0].description, alerts[0].title, alerts[0].body ?? '']) {
      expect(text).not.toMatch(/stripe/i);
    }
  });

  it('a voided PROCESSING payment never lands: its late outcome applies no money (slice 13, from slice 09 review)', async () => {
    const f = await fixture({ total: 150 });
    const processing = await ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 150, method: 'ACH', paymentIntentId: `pi_pay13_void_${randomUUID()}`,
    });
    await db.payment.update({ where: { id: processing }, data: { voided_at: new Date(), voided_reason: 'test' } });

    const result = await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });

    expect(result).toEqual({ changed: false, becamePaid: false });
    expect(await f.readInvoice()).toMatchObject({ status: 'SENT', amountDue: 150 });
    expect((await db.payment.findUniqueOrThrow({ where: { id: processing } })).state).toBe('PROCESSING');
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(0);
  });

  it('a FAILED payment changes nothing: not the balance, not the status, not what can be refunded', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    const processing = await ledger.recordProcessingPayment({
      invoiceId: f.invoice, organizationId: f.org, amount: 50, method: 'ACH', paymentIntentId: `pi_pay05_${randomUUID()}`,
    });

    await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'FAILED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
    expect(invoicePaidDispatches(f.invoice)).toHaveLength(0);

    // The customer pays the rest another way; the failed $50 never counted as collected.
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 50, method: 'CHECK' })).status).toBe(201);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });

    expect((await f.refund(160)).status).toBe(400);
    expect((await f.refund(150)).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'REFUNDED', totalRefunded: 150 });
  });

  // A refund row as the processor's refund events write it (slices 07 and 29).
  const seedRefund = (f: Awaited<ReturnType<typeof fixture>>, amount: number, state: 'PENDING' | 'SUCCEEDED' | 'FAILED') =>
    db.refund.create({
      data: {
        invoice_id: f.invoice, organization_id: f.org, amount, method: 'ACH', state,
        reason_category: 'CUSTOMER_REQUEST', refunded_by: f.user,
      },
    }).then((r) => r.id);

  it('a FAILED refund does not move total_refunded, and gave nothing back that blocks a real refund', async () => {
    const f = await fixture({ total: 100 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await seedRefund(f, 40, 'FAILED');

    expect((await f.refund(30)).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 30 });
    const detail = await f.api.get(`/api/invoices/${f.invoice}`);
    expect(detail.body.invoice.refunds.map((r: { amount: string; state: string }) => [Number(r.amount), r.state]).sort())
      .toEqual([[30, 'SUCCEEDED'], [40, 'FAILED']]);

    // The failed $40 never left, so the remaining $70 can still go back.
    expect((await f.refund(70)).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'REFUNDED', totalRefunded: 100 });
  });

  it('a PENDING bank refund does not move total_refunded until it SUCCEEDS; one that FAILS never does', async () => {
    const f = await fixture({ total: 100 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    const pending = await seedRefund(f, 20, 'PENDING');

    expect((await f.refund(30)).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 30 });
    // The pending $20 is on its way back, so only $50 is left to refund.
    expect((await f.refund(51)).status).toBe(400);

    await ledger.settleRefund({ refundId: pending, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 50 });

    const failing = await seedRefund(f, 50, 'PENDING');
    await ledger.settleRefund({ refundId: failing, organizationId: f.org, to: 'FAILED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 50 });

    const last = await seedRefund(f, 50, 'PENDING');
    await ledger.settleRefund({ refundId: last, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'REFUNDED', totalRefunded: 100 });
  });

  it('a refund that goes PENDING then FAILED on a part-paid invoice leaves it PARTIAL, not PAID', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
    // A processor refund on a part-paid invoice: the refund door writes the row and marks the
    // invoice PARTIALLY_REFUNDED, whatever its balance.
    const pending = await seedRefund(f, 20, 'PENDING');
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIALLY_REFUNDED' } });

    await ledger.settleRefund({ refundId: pending, organizationId: f.org, to: 'FAILED' });
    // Nothing went back and $50 is still owed: PARTIAL, never PAID.
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50, totalRefunded: 0 });

    // Paid in full, the same bounce puts it back to PAID.
    const g = await fixture({ total: 100 });
    expect((await g.api.post(`/api/invoices/${g.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    const bounced = await seedRefund(g, 20, 'PENDING');
    await db.invoice.update({ where: { id: g.invoice }, data: { status: 'PARTIALLY_REFUNDED' } });
    await ledger.settleRefund({ refundId: bounced, organizationId: g.org, to: 'FAILED' });
    expect(await g.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0, totalRefunded: 0 });
  });

  it('the payments report and every Collected figure leave PROCESSING and FAILED payments out', async () => {
    const f = await fixture({ total: 300 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');
    await f.seedPayment(25, 'FAILED');

    const report = await f.api.get('/api/reports/payments');
    expect(report.status).toBe(200);
    expect(report.body.payments.map((p: { amount: number }) => p.amount)).toEqual([100]);

    const revenue = await f.api.get('/api/reports/revenue');
    expect(revenue.status).toBe(200);
    expect(revenue.body.totals.collected).toBe(100);

    const dashboard = await f.api.get('/api/dashboard');
    expect(dashboard.status).toBe(200);
    expect(Number(dashboard.body.data['kpi.revenue_mtd'].collected)).toBe(100);
    expect(Number(dashboard.body.data['kpi.collected_today'].amount)).toBe(100);
    // Summed over the chart: which slot a payment lands in is the chart's own (clock) concern.
    const charted = dashboard.body.data.revenue_chart.months.reduce((sum: number, m: { collected: number }) => sum + Number(m.collected), 0);
    expect(charted).toBe(100);

    const list = await f.api.get('/api/invoices');
    expect(list.status).toBe(200);
    expect(Number(list.body.stats.collected_this_month.total)).toBe(100);
    expect(list.body.stats.collected_this_month.count).toBe(1);

    const customer = await f.api.get(`/api/customers/${f.customer}`);
    expect(customer.status).toBe(200);
    expect(customer.body.summary.financials.lifetime_revenue).toBe(100);
  });

  it('deposit money that has not landed is never held or drawn down; a failed refund does not shrink it', async () => {
    const f = await fixture({ total: 300 });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT' } });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');
    await f.seedPayment(25, 'FAILED');
    await seedRefund(f, 10, 'FAILED');
    await seedRefund(f, 20, 'PENDING');

    // $100 landed; the pending $20 is on its way back to the customer, so $80 is left to apply.
    const { remainingDepositCredit } = await import('../lib/deposit-credit.js');
    // Through a transaction, as every caller does: the callback's client is the one the function
    // takes (handing it the suite's own client would relate two client types; see the header).
    expect(await db.$transaction((tx) => remainingDepositCredit(tx, f.invoice))).toBe(80);

    const list = await f.api.get('/api/invoices');
    expect(list.status).toBe(200);
    expect(list.body.stats.deposits_held).toBe(80);
  });

  it("the customer's statement shows only money that landed: no processing or failed payment, no pending or failed refund", async () => {
    const f = await fixture({ total: 300 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');
    await f.seedPayment(25, 'FAILED');
    await seedRefund(f, 10, 'SUCCEEDED');
    await seedRefund(f, 20, 'PENDING');
    await seedRefund(f, 30, 'FAILED');

    const res = await f.api.get(`/api/statements/customer/${f.customer}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ billed: 300, paid: 100, refunded: 10, balance: 210 });
    expect(res.body.lines.map((l: { type: string; amount: number }) => [l.type, l.amount]))
      .toEqual([['invoice', 300], ['payment', 100], ['refund', 10]]);
  });

  it("a job's financials carry each payment's state, so its Payments tab can leave uncleared money out", async () => {
    const f = await fixture({ total: 150, onJob: true });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');

    const res = await f.api.get(`/api/jobs/${f.job}/financials`);
    expect(res.status).toBe(200);
    expect(res.body.total_paid).toBe(100);
    expect(res.body.payments.map((p: { amount: string; state: string }) => [Number(p.amount), p.state]))
      .toEqual([[100, 'SUCCEEDED'], [50, 'PROCESSING']]);
  });

  it("the customer's own invoice page gets each payment's state, so it can total only money that landed", async () => {
    const f = await fixture({ total: 150 });
    const token = `pub-${randomUUID()}`;
    await db.invoice.update({ where: { id: f.invoice }, data: { public_token: token } });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');

    const res = await request(app).get(`/api/invoices/${f.invoice}/public?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.payments.map((p: { amount: string; state: string }) => [Number(p.amount), p.state]))
      .toEqual([[100, 'SUCCEEDED'], [50, 'PROCESSING']]);
  });

  it("the invoice PDF's Payments line counts only payments that landed", async () => {
    const f = await fixture({ total: 300 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    await f.seedPayment(50, 'PROCESSING');
    await f.seedPayment(25, 'FAILED');

    const { invoicePdfSelect, toInvoiceForPdf } = await import('../lib/pdf/invoice-select.js');
    const { activePaymentsTotal } = await import('../lib/pdf/templates/alpha-classic.js');
    const row = await db.invoice.findUniqueOrThrow({ where: { id: f.invoice }, select: invoicePdfSelect });
    expect(activePaymentsTotal(toInvoiceForPdf(row).payments)).toBe(100);
  });

  it('voiding cannot put back on the balance money that never came off it', async () => {
    const f = await fixture({ total: 150 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    const failed = await f.seedPayment(50, 'FAILED');

    const res = await f.api.post(`/api/invoices/${f.invoice}/void-payment`, { payment_id: failed, void_category: 'BOUNCED', reason: 'bounced' });
    expect(res.status).toBe(400);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
  });

  it('a refund made on the processor decides REFUNDED on the money paid, in cents, as the in-app door does', async () => {
    // $150 invoice: $50 applied deposit credit + $100 card. The processor refunds the whole $100
    // charge. All the money paid on this invoice went back, so it is REFUNDED - the in-app door's
    // rule (refundStatusFor over non-credit SUCCEEDED payments) - not PARTIALLY_REFUNDED because
    // $100 is short of the $150 total.
    const f = await fixture({ total: 150 });
    const tag = f.org.slice(0, 8);
    const pi = `pi_pay05_${tag}`;
    // The webhook acts only for an org that takes card payments.
    await db.organization.update({ where: { id: f.org }, data: { stripe_account_id: `acct_pay05_${tag}`, accepted_payment_methods: ['CARD'] } });
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 50, method: 'CARD', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT', created_by_source: 'SYSTEM' },
    });
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 100, method: 'CARD', paid_at: new Date(), stripe_payment_intent_id: pi, created_by_source: 'CLIENT' },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } });

    const event = {
      id: `evt_pay05_${tag}`,
      // Slice 07: refunds are recorded from the refund events, keyed on the refund id.
      type: 'refund.created',
      data: { object: { id: `re_pay05_${tag}`, object: 'refund', amount: 10000, status: 'succeeded', payment_intent: pi, metadata: {} } },
    };
    (constructWebhookEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(event);
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig')
      .send(Buffer.from(JSON.stringify(event)));
    expect(res.status).toBe(200);

    expect(await f.readInvoice()).toMatchObject({ status: 'REFUNDED', totalRefunded: 100 });
  });

  // ---- A second door landing while a ledger door holds the invoice ----
  // settlePayment and settleRefund change an invoice's totals under SELECT ... FOR UPDATE of the
  // invoice. Every other door that writes those totals must take the same lock and read under it,
  // or it writes back numbers from before the settle. To land a door in the middle of a settle
  // deterministically, the test holds the lock in its own transaction and makes the settle's
  // writes there, starts the door, waits until Postgres reports the door blocked on that
  // transaction, and only then commits. A door that never blocks fails the test: it would prove
  // nothing.
  async function whileASettleHoldsTheInvoice<T>(invoiceId: string, settleSql: string[], door: () => PromiseLike<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${invoiceId}' FOR UPDATE`);
      for (const sql of settleSql) await tx.$executeRawUnsafe(sql);
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the settle never held the lock'); })]);
    const result = Promise.resolve(door());
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the door never waited on the invoice lock').toBe(true);
    } finally {
      release();
      await holder;
    }
    return result;
  }

  it('a staff refund made while a bank refund settles counts both: the settled refund is not written over', async () => {
    const f = await fixture({ total: 100 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    const pending = await seedRefund(f, 60, 'PENDING');

    // settleRefund confirms the $60 bank refund (total_refunded 60) while staff refund $20 cash.
    const res = await whileASettleHoldsTheInvoice(f.invoice, [
      `UPDATE refunds SET state = 'SUCCEEDED' WHERE id = '${pending}'`,
      `UPDATE invoices SET total_refunded = 60, net_collected = 40, status = 'PARTIALLY_REFUNDED' WHERE id = '${f.invoice}'`,
    ], () => f.refund(20));

    expect(res.status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 80 });
  });

  it('a refund made on the processor while a bank refund settles counts both', async () => {
    const f = await fixture({ total: 100 });
    const tag = f.org.slice(0, 8);
    const pi = `pi_pay05_lock_${tag}`;
    await db.organization.update({ where: { id: f.org }, data: { stripe_account_id: `acct_pay05_${tag}`, accepted_payment_methods: ['CARD'] } });
    await db.payment.create({
      data: { invoice_id: f.invoice, amount: 100, method: 'CARD', paid_at: new Date(), stripe_payment_intent_id: pi, created_by_source: 'CLIENT' },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } });
    const pending = await seedRefund(f, 60, 'PENDING');

    const event = {
      id: `evt_pay05_lock_${tag}`,
      type: 'refund.created',
      data: { object: { id: `re_pay05_lock_${tag}`, object: 'refund', amount: 2000, status: 'succeeded', payment_intent: pi, metadata: {} } },
    };
    (constructWebhookEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(event);
    const res = await whileASettleHoldsTheInvoice(f.invoice, [
      `UPDATE refunds SET state = 'SUCCEEDED' WHERE id = '${pending}'`,
      `UPDATE invoices SET total_refunded = 60, net_collected = 40, status = 'PARTIALLY_REFUNDED' WHERE id = '${f.invoice}'`,
    ], () => request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig')
      .send(Buffer.from(JSON.stringify(event))));

    expect(res.status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 80 });
  });

  it('voiding a payment while a bank payment settles reopens only the voided amount on the settled balance', async () => {
    const f = await fixture({ total: 150 });
    const cash = await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 50, method: 'CASH' });
    expect(cash.status).toBe(201);
    const cashId = (await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice, method: 'CASH' }, select: { id: true } })).id;
    const processing = await f.seedPayment(100, 'PROCESSING');

    // settlePayment lands the $100 bank debit (balance 100 -> 0, PAID) while staff void the $50 cash.
    const res = await whileASettleHoldsTheInvoice(f.invoice, [
      `UPDATE payments SET state = 'SUCCEEDED' WHERE id = '${processing}'`,
      `UPDATE invoices SET amount_due = 0, status = 'PAID', paid_at = now() WHERE id = '${f.invoice}'`,
    ], () => f.api.post(`/api/invoices/${f.invoice}/void-payment`, { payment_id: cashId, void_category: 'ERROR', reason: 'entered twice' }));

    expect(res.status).toBe(200);
    // $100 of $150 landed: $50 is owed, not the $150 a stale balance would put back.
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIAL', amountDue: 50 });
  });

  // Slice 18 refuses the void at the door while the bank debit is still PROCESSING (money on its
  // way), so it no longer reaches the lock; the lock race itself is covered by
  // invoice-void-with-payments-db.test.ts.
  it('an invoice with a bank payment still settling cannot be voided, and stays as it is when the payment lands', async () => {
    const f = await fixture({ total: 100 });
    const processing = await f.seedPayment(100, 'PROCESSING');

    const res = await f.api.post(`/api/invoices/${f.invoice}/void`, { voided_reason: 'sent in error' });
    expect(res.status).toBe(409);

    await ledger.settlePayment({ paymentId: processing, organizationId: f.org, to: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', amountDue: 0 });
  });
});
