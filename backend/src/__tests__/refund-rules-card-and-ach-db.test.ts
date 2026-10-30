/* =============================================================================
   Payments go-live, slice 29 - refund rules for card and bank payments (D17).

   Bank payers are refunded like card payers, with the bank-specific rules made visible:
   - a cleared bank payment can be refunded in full or in part; the refund is PENDING until the
     processor confirms it;
   - a bank payment still processing is cancelled, never refunded;
   - past 180 days a bank payment is refused before the processor is asked;
   - a refund the processor refuses for a low balance says so, in ServWave's words;
   - a partial refund returns the tip in proportion (there is no service fee any more).

   Staff calls go through the real routes, refund events through the real webhook route in the
   processor's payload shape for the pinned version. Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import { createRefund, cancelPaymentIntent } from '../lib/stripe';
import { settlePayment } from '../lib/payment-ledger';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const cancelDebit = cancelPaymentIntent as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

type PaymentSpec = {
  amount: number;
  method: 'CARD' | 'ACH' | 'CASH';
  state?: 'SUCCEEDED' | 'PROCESSING';
  daysAgo?: number;
  tip?: number;
  serviceFee?: number;
  /** Paid through the processor (has a payment intent). Defaults to true for CARD and ACH. */
  online?: boolean;
};

suite('refund rules for card and bank payments (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    processorRefund.mockReset();
    processorRefund.mockResolvedValue({});
    cancelDebit.mockReset();
  });

  /** An org with an admin, a customer, and one invoice paid by the given payments. */
  async function paidInvoice(opts: { total: number; payments: PaymentSpec[]; status?: 'PAID' | 'PARTIAL' | 'SENT' }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay29_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay29-${tag}`, email: `pay29-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const landed = opts.payments.filter((p) => (p.state ?? 'SUCCEEDED') === 'SUCCEEDED').reduce((s, p) => s + p.amount, 0);
    const amountDue = Math.max(opts.total - landed, 0);
    const status = opts.status ?? (amountDue === 0 ? 'PAID' : landed > 0 ? 'PARTIAL' : 'SENT');
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total, amount_due: amountDue, status,
        net_collected: landed, ...(status === 'PAID' ? { paid_at: new Date() } : {}),
      },
    });
    const payments: Array<{ id: string; pi: string | null }> = [];
    for (const [i, p] of opts.payments.entries()) {
      const online = p.online ?? p.method !== 'CASH';
      const pi = online ? `pi_pay29_${tag}_${i}` : null;
      const row = await db.payment.create({
        data: {
          invoice_id: invoice, amount: p.amount, method: p.method, state: p.state ?? 'SUCCEEDED',
          paid_at: new Date(Date.now() - (p.daysAgo ?? 0) * DAY - (opts.payments.length - i) * 1000),
          tip_amount: p.tip ?? null, service_fee_amount: p.serviceFee ?? null,
          ...(online
            ? { stripe_payment_intent_id: pi, stripe_charge_id: `ch_pay29_${tag}_${i}`, stripe_account_id: account, created_by_source: 'CLIENT' }
            : {}),
        },
      });
      payments.push({ id: row.id, pi });
    }
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer pay29-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    const refund = (body: object) =>
      api.post(`/api/invoices/${invoice}/refund`, { reason_category: 'CUSTOMER_REQUEST', reason: 'slice 29 test', ...body });
    let seq = 0;
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object) => {
      const event = { id: `evt_pay29_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, account, data: { object } };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
      return res;
    };
    const readInvoice = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const refundRows = () => db.refund.findMany({ where: { invoice_id: invoice }, orderBy: { created_at: 'asc' } });
    return { org, tag, invoice, account, payments, api, refund, deliver, readInvoice, refundRows };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM credits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['unapplied_captures', 'timeline_events', 'notifications', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay29_%'`));
    await db.$disconnect();
  });

  describe('the 180-day bank refund window', () => {
    it('a bank payment made 181 days ago is refused before the processor is asked', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', daysAgo: 181 }] });

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.',
      );
      expect(processorRefund).not.toHaveBeenCalled();
      expect(await f.refundRows()).toHaveLength(0);
    });

    it('past 180 days, a refund handed back another way (a chosen method) is recorded here, without the processor', async () => {
      const f = await paidInvoice({ total: 150, payments: [{ amount: 150, method: 'ACH', daysAgo: 200 }] });

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id, method: 'CHECK', reference_number: 'CHK-1001' });

      expect(res.status).toBe(200);
      expect(processorRefund).not.toHaveBeenCalled();
      const [row, ...others] = await f.refundRows();
      expect(others).toHaveLength(0);
      expect(row).toMatchObject({ state: 'SUCCEEDED', stripe_refund_id: null, method: 'CHECK', payment_id: f.payments[0].id });
      expect(Number(row.amount)).toBe(50);
      const invoice = await f.readInvoice();
      expect(invoice.status).toBe('PARTIALLY_REFUNDED');
      expect(Number(invoice.total_refunded)).toBe(50);
      expect(Number(invoice.net_collected)).toBe(100);
    });

    it('past 180 days, the same hand refund left on "Auto / oldest" is recorded against the bank payment', async () => {
      const f = await paidInvoice({ total: 150, payments: [{ amount: 150, method: 'ACH', daysAgo: 200 }] });

      const res = await f.refund({ amount: 150, method: 'CASH' });

      expect(res.status).toBe(200);
      expect(processorRefund).not.toHaveBeenCalled();
      const [row] = await f.refundRows();
      expect(row).toMatchObject({ state: 'SUCCEEDED', stripe_refund_id: null, method: 'CASH', payment_id: f.payments[0].id });
      expect((await f.readInvoice()).status).toBe('REFUNDED');
    });

    it('a bank payment made 179 days ago is still refunded through the processor', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', daysAgo: 179 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_${f.tag}`, status: 'pending' });

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.status).toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);
    });

    it('the window is a bank rule: a card payment made 181 days ago is still refunded', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'CARD', daysAgo: 181 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_${f.tag}`, status: 'succeeded' });

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.status).toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);
    });
  });

  describe('a cleared bank payment is refunded like a card payment', () => {
    it('a partial bank refund is PENDING from the moment the processor is asked until it confirms, then counts as refunded', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH' }] });
      const refundId = `re_pay29_ach_${f.tag}`;
      let heldWhileAsked: Array<[number, string, string | null]> = [];
      processorRefund.mockImplementationOnce(async () => {
        // While the processor is still being asked, the $100 is already held on the payment.
        heldWhileAsked = (await f.refundRows()).map((r) => [Number(r.amount), r.state, r.payment_id]);
        return { id: refundId, object: 'refund', amount: 10000, status: 'pending' };
      });

      const res = await f.refund({ amount: 100, payment_id: f.payments[0].id });
      expect(heldWhileAsked).toEqual([[100, 'PENDING', f.payments[0].id]]);
      // The processor echoes the metadata it was sent on the refund's events.
      const sentMetadata = processorRefund.mock.calls[0][3].metadata;

      expect(res.status).toBe(200);
      const [pending, ...others] = await f.refundRows();
      expect(others).toHaveLength(0);
      expect(pending).toMatchObject({ stripe_refund_id: refundId, state: 'PENDING', payment_id: f.payments[0].id, method: 'ACH' });
      expect(Number(pending.amount)).toBe(100);
      // Nothing has gone back yet: the invoice still reads paid in full.
      const before = await f.readInvoice();
      expect(before.status).toBe('PAID');
      expect(Number(before.total_refunded ?? 0)).toBe(0);
      expect(Number(before.net_collected)).toBe(300);

      // The processor confirms the refund.
      await f.deliver('refund.updated', {
        id: refundId, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded',
        payment_intent: f.payments[0].pi, metadata: sentMetadata,
      });

      const rows = await f.refundRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('SUCCEEDED');
      const after = await f.readInvoice();
      expect(after.status).toBe('PARTIALLY_REFUNDED');
      expect(Number(after.total_refunded)).toBe(100);
      expect(Number(after.net_collected)).toBe(200);
    });

    it('a partial refund returns the tip in proportion, and no service fee', async () => {
      // A legacy card charge still carries a service fee; it is no longer given back (D9).
      const f = await paidInvoice({ total: 200, payments: [{ amount: 200, method: 'CARD', tip: 20, serviceFee: 6 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_tip_${f.tag}`, status: 'succeeded' });

      expect((await f.refund({ amount: 100, payment_id: f.payments[0].id })).status).toBe(200);

      // Half the face amount: $100, plus half the $20 tip.
      expect(processorRefund.mock.calls[0][2]).toBe(11000);
      const [row] = await f.refundRows();
      expect(Number(row.amount)).toBe(100);
    });

    it('a bank payment with a tip returns its share of the tip too, when "Auto / oldest" picks it among several payments', async () => {
      const f = await paidInvoice({ total: 500, payments: [{ amount: 400, method: 'ACH', tip: 40, daysAgo: 3 }, { amount: 100, method: 'CASH', daysAgo: 1 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_achtip_${f.tag}`, status: 'pending' });

      expect((await f.refund({ amount: 100 })).status).toBe(200);

      // A quarter of the $400 debit goes back to the bank, with a quarter of its $40 tip.
      expect(processorRefund).toHaveBeenCalledTimes(1);
      expect(processorRefund.mock.calls[0][0]).toBe(f.payments[0].pi);
      expect(processorRefund.mock.calls[0][2]).toBe(11000);
      const [row] = await f.refundRows();
      expect(row).toMatchObject({ payment_id: f.payments[0].id, state: 'PENDING' });
      expect(Number(row.amount)).toBe(100);
    });
  });

  describe('a refund holds its money before the processor is asked', () => {
    it('two refunds at the same moment never send back more than was paid: the second is refused before the processor is asked', async () => {
      const f = await paidInvoice({ total: 150, payments: [{ amount: 150, method: 'CARD' }] });
      // The first refund's processor call is slow; the second arrives while it is out.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      processorRefund.mockImplementationOnce(async () => {
        await gate;
        return { id: `re_pay29_first_${f.tag}`, status: 'succeeded' };
      });

      const first = f.refund({ amount: 100, payment_id: f.payments[0].id }).then((r) => r);
      // Wait until the first refund is with the processor.
      for (let i = 0; i < 100 && processorRefund.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(processorRefund).toHaveBeenCalledTimes(1);

      const second = await f.refund({ amount: 100, payment_id: f.payments[0].id });
      expect(second.status).toBe(400);
      expect(processorRefund).toHaveBeenCalledTimes(1);

      release();
      expect((await first).status).toBe(200);
      const rows = await f.refundRows();
      expect(rows.map((r) => [Number(r.amount), r.state])).toEqual([[100, 'SUCCEEDED']]);
      const invoice = await f.readInvoice();
      expect(Number(invoice.total_refunded)).toBe(100);
      expect(invoice.status).toBe('PARTIALLY_REFUNDED');
    });

    it('a refund event that lands while the processor call is still answering completes the same row', async () => {
      const f = await paidInvoice({ total: 200, payments: [{ amount: 200, method: 'CARD' }] });
      const refundId = `re_pay29_race_${f.tag}`;
      let onRecordWhileAnswering: Array<Record<string, unknown>> = [];
      processorRefund.mockImplementationOnce(async (pi: string, _ctx: unknown, cents: number, opts: { metadata: Record<string, string> }) => {
        // The processor sends the refund's event before the call has returned to ServWave.
        await f.deliver('refund.created', {
          id: refundId, object: 'refund', amount: cents, currency: 'usd', status: 'succeeded', payment_intent: pi, metadata: opts.metadata,
        });
        // Were ServWave to stop here, the refund is already on record once, with who made it and why.
        onRecordWhileAnswering = (await f.refundRows()).map((r) => ({
          stripe_refund_id: r.stripe_refund_id, amount: Number(r.amount), payment_id: r.payment_id,
          reason: r.reason, reason_category: r.reason_category, has_refunded_by: r.refunded_by !== null,
        }));
        return { id: refundId, status: 'succeeded' };
      });

      expect((await f.refund({ amount: 60, payment_id: f.payments[0].id })).status).toBe(200);
      expect(onRecordWhileAnswering).toEqual([{
        stripe_refund_id: refundId, amount: 60, payment_id: f.payments[0].id,
        reason: 'slice 29 test', reason_category: 'CUSTOMER_REQUEST', has_refunded_by: true,
      }]);

      const rows = await f.refundRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ stripe_refund_id: refundId, state: 'SUCCEEDED', reason: 'slice 29 test', reason_category: 'CUSTOMER_REQUEST' });
      expect(rows[0].refunded_by).not.toBeNull();
      expect(Number((await f.readInvoice()).total_refunded)).toBe(60);
    });

    it('a refund the processor refuses leaves nothing held: the full amount can be refunded again', async () => {
      const f = await paidInvoice({ total: 200, payments: [{ amount: 200, method: 'CARD' }] });
      processorRefund.mockRejectedValueOnce(Object.assign(new Error('declined'), { type: 'StripeInvalidRequestError', statusCode: 400 }));
      expect((await f.refund({ amount: 200, payment_id: f.payments[0].id })).status).toBe(500);
      expect(await f.refundRows()).toHaveLength(0);

      processorRefund.mockResolvedValueOnce({ id: `re_pay29_retry_${f.tag}`, status: 'succeeded' });
      expect((await f.refund({ amount: 200, payment_id: f.payments[0].id })).status).toBe(200);
      expect((await f.readInvoice()).status).toBe('REFUNDED');
    });
  });

  describe('a refund whose answer never arrived', () => {
    it('keeps its money held, so a retry cannot send a second refund', async () => {
      const f = await paidInvoice({ total: 200, payments: [{ amount: 200, method: 'CARD' }] });
      // A dropped connection: the processor may already have created the refund.
      processorRefund.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
      expect((await f.refund({ amount: 200, payment_id: f.payments[0].id })).status).toBe(502);
      const held = await f.refundRows();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ state: 'PENDING', stripe_refund_id: null });

      const retry = await f.refund({ amount: 200, payment_id: f.payments[0].id });
      expect(retry.status).not.toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);
      expect(await f.refundRows()).toHaveLength(1);
    });
  });

  describe('"Auto / oldest" picks the payment the refund comes from', () => {
    it('with several payments, the refund comes from the oldest one with room, and names it', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 100, method: 'CARD', daysAgo: 3 }, { amount: 200, method: 'CASH', daysAgo: 1 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_oldest_${f.tag}`, status: 'succeeded' });

      expect((await f.refund({ amount: 50 })).status).toBe(200);

      // The card payment is the oldest: the refund goes back to the card.
      expect(processorRefund).toHaveBeenCalledTimes(1);
      expect(processorRefund.mock.calls[0][0]).toBe(f.payments[0].pi);
      const [row] = await f.refundRows();
      expect(row.payment_id).toBe(f.payments[0].id);
      const card = await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } });
      expect(Number(card.refunded_amount)).toBe(50);
    });

    it('a payment already given back in full is passed over for the next oldest', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 100, method: 'CARD', daysAgo: 3 }, { amount: 200, method: 'CASH', daysAgo: 1 }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_full_${f.tag}`, status: 'succeeded' });
      expect((await f.refund({ amount: 100, payment_id: f.payments[0].id })).status).toBe(200);

      expect((await f.refund({ amount: 50 })).status).toBe(200);

      expect(processorRefund).toHaveBeenCalledTimes(1);
      const rows = await f.refundRows();
      expect(rows[1].payment_id).toBe(f.payments[1].id);
      expect(rows[1].method).toBe('CASH');
    });

    it('a hand refund no one payment can return is spread over the payments, oldest first, one row each', async () => {
      const f = await paidInvoice({ total: 150, payments: [{ amount: 100, method: 'CASH', daysAgo: 3 }, { amount: 50, method: 'CASH', daysAgo: 1 }] });

      expect((await f.refund({ amount: 150 })).status).toBe(200);

      const rows = await f.refundRows();
      expect(rows.map((r) => [r.payment_id, Number(r.amount)]).sort()).toEqual(
        [[f.payments[0].id, 100], [f.payments[1].id, 50]].sort(),
      );
      expect((await f.readInvoice()).status).toBe('REFUNDED');
    });

    it('more than any one payment can return is refused, asking for one refund per payment', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 100, method: 'CARD', daysAgo: 3 }, { amount: 200, method: 'CASH', daysAgo: 1 }] });

      const res = await f.refund({ amount: 250 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This refund is more than any one payment on the invoice. Refund each payment separately.');
      expect(processorRefund).not.toHaveBeenCalled();
      expect(await f.refundRows()).toHaveLength(0);
    });
  });

  describe('the refund door uses the ledger\'s one rule for what was given back', () => {
    const seedRefund = (f: { invoice: string; org: string }, paymentId: string, amount: number, extra: { from_unapplied_capture?: boolean } = {}) =>
      db.user.findFirstOrThrow({ where: { organization_id: f.org } }).then((u) => db.refund.create({
        data: {
          invoice_id: f.invoice, organization_id: f.org, payment_id: paymentId, amount, method: 'CARD', state: 'SUCCEEDED',
          reason_category: 'CUSTOMER_REQUEST', refunded_by: u.id, ...extra,
        },
      }));

    it('a refund that left with a charged-back payment does not hold back the money paid again', async () => {
      // A $100 card payment was partly refunded ($40), then charged back; the customer paid again in cash.
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CARD', daysAgo: 5 }, { amount: 100, method: 'CASH', daysAgo: 1 }] });
      await seedRefund(f, f.payments[0].id, 40);
      await db.payment.update({ where: { id: f.payments[0].id }, data: { voided_at: new Date(), voided_reason: 'Chargeback' } });

      // The business holds the $100 cash payment, and all of it can go back.
      const res = await f.refund({ amount: 100, payment_id: f.payments[1].id });

      expect(res.status).toBe(200);
      const invoice = await f.readInvoice();
      expect(invoice.status).toBe('REFUNDED');
      expect(Number(invoice.net_collected)).toBe(0);
    });

    it('money sent back from "Payments needing attention" does not move the invoice\'s refund status', async () => {
      // A $150 bank payment on a $100 invoice; the $50 excess was sent back from the list.
      const f = await paidInvoice({ total: 100, payments: [{ amount: 150, method: 'ACH' }] });
      await seedRefund(f, f.payments[0].id, 50, { from_unapplied_capture: true });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_unapplied_${f.tag}`, status: 'pending' });

      // A bank refund of $30 is on its way: nothing of the invoice's own money has gone back yet.
      expect((await f.refund({ amount: 30, payment_id: f.payments[0].id })).status).toBe(200);

      const invoice = await f.readInvoice();
      expect(invoice.status).toBe('PAID');
      expect(Number(invoice.net_collected)).toBe(100);
      expect(Number(invoice.total_refunded)).toBe(50);
    });
  });

  describe('a hand-entered refund never claims to be an online bank debit', () => {
    it('the refund door refuses a chosen method of ACH', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });

      const res = await f.refund({ amount: 20, method: 'ACH' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/choose Bank Transfer/);
      expect(await f.refundRows()).toHaveLength(0);
    });

    it('the credit door refuses a chosen give-back method of ACH', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });

      const res = await f.api.post(`/api/invoices/${f.invoice}/credit`, { amount: 20, reason: 'goodwill', method: 'ACH' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/choose Bank Transfer/);
      expect(await f.refundRows()).toHaveLength(0);
    });

    it('a bank payment refunded with the method left on Auto is recorded as a bank refund', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'ACH' }] });
      processorRefund.mockResolvedValueOnce({ id: `re_pay29_auto_${f.tag}`, status: 'pending' });

      expect((await f.refund({ amount: 20 })).status).toBe(200);
      expect((await f.refundRows())[0].method).toBe('ACH');
    });
  });

  describe('the credit door\'s cash give-back follows the same refund rules', () => {
    const credit = (f: { api: { post: (p: string, b: object) => request.Test }; invoice: string }, body: object) =>
      f.api.post(`/api/invoices/${f.invoice}/credit`, { reason: 'slice 29 give-back', ...body });

    it('a give-back handed back by hand names the payment it came from', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });

      expect((await credit(f, { amount: 30 })).status).toBe(200);

      const [row] = await f.refundRows();
      expect(row.payment_id).toBe(f.payments[0].id);
      const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } });
      // The payment's refund stamp and the invoice's refunded total agree.
      expect(Number(payment.refunded_amount)).toBe(30);
      expect(Number((await f.readInvoice()).total_refunded)).toBe(30);
    });

    it('a give-back from a bank payment past 180 days is refused before the processor is asked', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'ACH', daysAgo: 200 }] });

      const res = await credit(f, { amount: 30 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.',
      );
      expect(processorRefund).not.toHaveBeenCalled();
    });

    it('a give-back from a bank payment past 180 days, handed back by hand, is recorded against it', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'ACH', daysAgo: 200 }] });

      const res = await credit(f, { amount: 30, method: 'CHECK' });

      expect(res.status).toBe(200);
      expect(processorRefund).not.toHaveBeenCalled();
      const [row, ...others] = await f.refundRows();
      expect(others).toHaveLength(0);
      expect(row).toMatchObject({ state: 'SUCCEEDED', stripe_refund_id: null, method: 'CHECK', payment_id: f.payments[0].id });
      expect(Number(row.amount)).toBe(30);
      const invoice = await f.readInvoice();
      expect(Number(invoice.total_refunded)).toBe(30);
      expect(Number(invoice.net_collected)).toBe(70);
    });

    it('a give-back and a refund at the same moment never send back more than was paid', async () => {
      const f = await paidInvoice({ total: 150, payments: [{ amount: 150, method: 'CARD' }] });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      processorRefund.mockImplementationOnce(async () => {
        await gate;
        return { id: `re_pay29_giveback_${f.tag}`, status: 'succeeded' };
      });

      const first = credit(f, { amount: 100 }).then((r) => r);
      for (let i = 0; i < 100 && processorRefund.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(processorRefund).toHaveBeenCalledTimes(1);

      const second = await f.refund({ amount: 100, payment_id: f.payments[0].id });
      expect(second.status).toBe(400);
      expect(processorRefund).toHaveBeenCalledTimes(1);

      release();
      expect((await first).status).toBe(200);
      const rows = await f.refundRows();
      expect(rows.map((r) => [Number(r.amount), r.state, r.payment_id])).toEqual([[100, 'SUCCEEDED', f.payments[0].id]]);
    });

    it('the credit half is decided on the balance under the lock, not the one read before the processor call', async () => {
      // $300 invoice, $200 paid by card: $100 owed. A $150 give-back credits the $100 and sends $50 back.
      const f = await paidInvoice({ total: 300, payments: [{ amount: 200, method: 'CARD' }] });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      processorRefund.mockImplementationOnce(async () => {
        await gate;
        return { id: `re_pay29_split_${f.tag}`, status: 'succeeded' };
      });

      const first = credit(f, { amount: 150 }).then((r) => r);
      for (let i = 0; i < 100 && processorRefund.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      // While the $50 is with the processor, the customer pays the $100 in cash.
      expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);

      release();
      expect((await first).status).toBe(200);
      // Nothing is owed any more, so no credit is written against a balance that is no longer there.
      const credits = await db.credit.findMany({ where: { invoice_id: f.invoice } });
      expect(credits.reduce((sum, c) => sum + Number(c.amount), 0)).toBe(0);
      const invoice = await f.readInvoice();
      expect(Number(invoice.amount_due)).toBe(0);
      expect(Number(invoice.total_refunded)).toBe(50);
    });
  });

  describe('"Payments needing attention" sends back money by the same rules', () => {
    /** A record for money on a payment row that no invoice balance accounts for. */
    const attentionRecord = (f: { org: string; invoice: string; account: string }, payment: { id: string; pi: string | null }, reason: string, amount: number) =>
      db.unappliedCapture.create({
        data: {
          organization_id: f.org, invoice_id: f.invoice, reason, amount,
          stripe_payment_intent_id: payment.pi, stripe_account_id: f.account, source_key: `payment:${payment.id}`,
        },
      });

    it('a list refund and an invoice refund on the same payment at once never send back more than it paid', async () => {
      // A $150 bank payment on a $100 invoice: $50 of it was never applied.
      const f = await paidInvoice({ total: 100, payments: [{ amount: 150, method: 'ACH' }] });
      const record = await attentionRecord(f, f.payments[0], 'OVERPAYMENT', 50);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      processorRefund.mockImplementationOnce(async () => {
        await gate;
        return { id: `re_pay29_list_${f.tag}`, status: 'pending' };
      });

      const listRefund = f.api.post(`/api/payments-needing-attention/${record.id}/refund`, {}).then((r) => r);
      for (let i = 0; i < 100 && processorRefund.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(processorRefund).toHaveBeenCalledTimes(1);

      // The whole payment from the invoice while the $50 is on its way back: refused.
      const invoiceRefund = await f.refund({ amount: 150, payment_id: f.payments[0].id });
      expect(invoiceRefund.status).toBe(400);
      expect(processorRefund).toHaveBeenCalledTimes(1);

      release();
      expect((await listRefund).status).toBe(200);
      const rows = await f.refundRows();
      expect(rows.map((r) => [Number(r.amount), r.from_unapplied_capture])).toEqual([[50, true]]);
    });

    it('a bank payment with a tip that cleared onto a closed invoice is listed and sent back whole, tip included', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'ACH', state: 'PROCESSING', tip: 10 }], status: 'SENT' });
      await db.invoice.update({ where: { id: f.invoice }, data: { status: 'VOIDED', voided_at: new Date() } });

      // The debit clears onto the voided invoice.
      await settlePayment({ paymentId: f.payments[0].id, organizationId: f.org, to: 'SUCCEEDED' });
      const record = await db.unappliedCapture.findFirstOrThrow({ where: { organization_id: f.org } });
      expect(Number(record.amount)).toBe(110);

      processorRefund.mockResolvedValueOnce({ id: `re_pay29_tipback_${f.tag}`, status: 'pending' });
      expect((await f.api.post(`/api/payments-needing-attention/${record.id}/refund`, {})).status).toBe(200);

      // The customer gets the whole debit back; the ledger books the face amount (the tip never
      // entered it).
      expect(processorRefund.mock.calls[0][2]).toBe(11000);
      const [row] = await f.refundRows();
      expect(Number(row.amount)).toBe(100);
    });
  });

  describe('an older refund that names no payment', () => {
    it('is tied to the invoice\'s one payment when the invoice\'s money is next written, so the payment\'s refund stamp counts it', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });
      const user = await db.user.findFirstOrThrow({ where: { organization_id: f.org } });
      // A refund recorded before every refund named its payment.
      const legacy = await db.refund.create({
        data: {
          invoice_id: f.invoice, organization_id: f.org, payment_id: null, amount: 30, method: 'CASH', state: 'SUCCEEDED',
          reason_category: 'CUSTOMER_REQUEST', refunded_by: user.id,
        },
      });

      expect((await f.refund({ amount: 20 })).status).toBe(200);

      expect((await db.refund.findUniqueOrThrow({ where: { id: legacy.id } })).payment_id).toBe(f.payments[0].id);
      const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } });
      expect(Number(payment.refunded_amount)).toBe(50);
      expect(Number((await f.readInvoice()).total_refunded)).toBe(50);
    });

    it('is left as it is when the invoice has several payments (its source cannot be told)', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 60, method: 'CASH' }, { amount: 40, method: 'CASH' }] });
      const user = await db.user.findFirstOrThrow({ where: { organization_id: f.org } });
      const legacy = await db.refund.create({
        data: {
          invoice_id: f.invoice, organization_id: f.org, payment_id: null, amount: 10, method: 'CASH', state: 'SUCCEEDED',
          reason_category: 'CUSTOMER_REQUEST', refunded_by: user.id,
        },
      });

      expect((await f.refund({ amount: 20, payment_id: f.payments[0].id })).status).toBe(200);

      expect((await db.refund.findUniqueOrThrow({ where: { id: legacy.id } })).payment_id).toBeNull();
    });
  });

  describe('voiding an invoice whose money is settled', () => {
    const voidIt = (f: { api: { post: (p: string, b: object) => request.Test }; invoice: string }) =>
      f.api.post(`/api/invoices/${f.invoice}/void`, { voided_reason: 'Billed in error' });

    it('a REFUNDED invoice is final: Void is refused and changes nothing', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });
      expect((await f.refund({ amount: 100 })).status).toBe(200);
      expect((await f.readInvoice()).status).toBe('REFUNDED');

      const res = await voidIt(f);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A refunded invoice is final and cannot be voided.');
      expect((await f.readInvoice()).status).toBe('REFUNDED');
    });

    it('a REFUNDED invoice stays final even when no money is held on it any more', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });
      expect((await f.refund({ amount: 100 })).status).toBe(200);
      await db.payment.update({ where: { id: f.payments[0].id }, data: { voided_at: new Date(), voided_reason: 'test' } });

      const res = await voidIt(f);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A refunded invoice is final and cannot be voided.');
      expect((await f.readInvoice()).status).toBe('REFUNDED');
    });

    it('when money is still held, the refusal keeps asking to void or refund the payments', async () => {
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CASH' }] });
      expect((await f.refund({ amount: 40 })).status).toBe(200);

      const res = await voidIt(f);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This invoice has payments. Void or refund them first.');
    });

    /**
     * An invoice paid in full by credit drawn from the job's deposit (no money taken on it), with
     * the deposit's money on its own invoice. Both sit on one job.
     */
    async function paidByDepositCredit() {
      const f = await paidInvoice({ total: 100, payments: [], status: 'PAID' });
      const { customer_id } = await f.readInvoice();
      const location = await db.serviceLocation.create({
        data: { customer_id, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
      });
      const job = await db.job.create({
        data: { organization_id: f.org, customer_id, service_location_id: location.id, job_number: `J-${f.tag}`, status: 'SCHEDULED', amount_invoiced: 100 },
      });
      await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 0, job_id: job.id } });
      const deposit = await db.invoice.create({
        data: {
          organization_id: f.org, customer_id, job_id: job.id, invoice_number: `DEP-${f.tag}`, kind: 'DEPOSIT',
          subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 0, status: 'PAID',
        },
      });
      await db.payment.create({ data: { invoice_id: deposit.id, amount: 100, method: 'CASH', state: 'SUCCEEDED', paid_at: new Date() } });
      const application = await db.depositCreditApplication.create({
        data: { organization_id: f.org, deposit_invoice_id: deposit.id, target_invoice_id: f.invoice, amount: 100 },
      });
      const synthetic = await db.payment.create({
        data: { invoice_id: f.invoice, amount: 100, method: 'OTHER', state: 'SUCCEEDED', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT' },
      });
      const creditReleased = async () => ({
        application: (await db.depositCreditApplication.findUniqueOrThrow({ where: { id: application.id } })).reversed_at !== null,
        synthetic: (await db.payment.findUniqueOrThrow({ where: { id: synthetic.id } })).voided_at !== null,
      });
      const cancelJob = (body: object) => f.api.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'OTHER', cancelled_reason: 'Customer moved away', ...body });
      return { ...f, job: job.id, deposit: deposit.id, creditReleased, cancelJob };
    }

    it('an invoice paid only by a drawn deposit credit (no money taken on it) voids and releases the credit', async () => {
      const f = await paidByDepositCredit();

      const res = await voidIt(f);

      expect(res.status).toBe(200);
      expect((await f.readInvoice()).status).toBe('VOIDED');
      // The credit goes back to the deposit, to be drawn again or refunded from there.
      expect(await f.creditReleased()).toEqual({ application: true, synthetic: true });
    });

    it('cancelling its job voids the same invoice and releases the credit, as its own Void does; the deposit is kept', async () => {
      const f = await paidByDepositCredit();

      // The deposit carries money, so the cancel first asks what happens to the job's invoices,
      // and lists the credit-paid invoice as one the void choice decides.
      const asked = await f.cancelJob({});
      expect(asked.status).toBe(409);
      expect(asked.body.invoices).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: f.invoice, status: 'PAID', has_payments: false }),
        expect.objectContaining({ id: f.deposit, has_payments: true }),
      ]));

      const res = await f.cancelJob({ void_invoices: true });

      expect(res.status).toBe(200);
      expect((await f.readInvoice()).status).toBe('VOIDED');
      expect(await f.creditReleased()).toEqual({ application: true, synthetic: true });
      expect((await db.invoice.findUniqueOrThrow({ where: { id: f.deposit } })).status).toBe('PAID');
    });

    it('cancelling its job and keeping the invoices leaves it paid by the credit', async () => {
      const f = await paidByDepositCredit();

      expect((await f.cancelJob({ void_invoices: false })).status).toBe(200);

      expect((await f.readInvoice()).status).toBe('PAID');
      expect(await f.creditReleased()).toEqual({ application: false, synthetic: false });
    });

    it('cancelling a job never voids its REFUNDED invoice', async () => {
      const f = await paidByDepositCredit();
      await db.invoice.update({ where: { id: f.invoice }, data: { status: 'REFUNDED' } });

      expect((await f.cancelJob({ void_invoices: true })).status).toBe(200);

      expect((await f.readInvoice()).status).toBe('REFUNDED');
      expect(await f.creditReleased()).toEqual({ application: false, synthetic: false });
    });
  });

  describe('a payment recorded by hand', () => {
    it('writes the stored net collected under the lock, as every money writer does', async () => {
      const f = await paidInvoice({ total: 100, payments: [] });

      expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 40, method: 'CASH' })).status).toBe(201);

      expect(Number((await f.readInvoice()).net_collected)).toBe(40);
    });
  });

  describe('a deposit\'s credit', () => {
    it('a refund that left with a charged-back deposit payment does not hold back the deposit paid again', async () => {
      // A $100 deposit paid by card, $30 of it refunded, then charged back; the customer paid the
      // deposit again in cash. The deposit holds $100, and all of it can be refunded.
      const f = await paidInvoice({ total: 100, payments: [{ amount: 100, method: 'CARD', daysAgo: 5 }, { amount: 100, method: 'CASH', daysAgo: 1 }] });
      await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT' } });
      const user = await db.user.findFirstOrThrow({ where: { organization_id: f.org } });
      await db.refund.create({
        data: {
          invoice_id: f.invoice, organization_id: f.org, payment_id: f.payments[0].id, amount: 30, method: 'CARD', state: 'SUCCEEDED',
          reason_category: 'CUSTOMER_REQUEST', refunded_by: user.id,
        },
      });
      await db.payment.update({ where: { id: f.payments[0].id }, data: { voided_at: new Date(), voided_reason: 'Chargeback' } });

      const res = await f.refund({ amount: 100, payment_id: f.payments[1].id });

      expect(res.status).toBe(200);
    });
  });

  describe('a bank payment still processing is cancelled, not refunded', () => {
    it('a refund naming a processing bank payment is refused, pointing at Cancel payment', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }], status: 'PAID' });

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This bank payment is still processing. Cancel the payment instead of refunding it.');
      expect(processorRefund).not.toHaveBeenCalled();
    });

    it('Cancel payment cancels the debit at the processor; the payment is failed and the balance stays open', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }] });
      cancelDebit.mockResolvedValueOnce({ id: f.payments[0].pi, status: 'canceled' });

      const res = await f.api.post(`/api/invoices/${f.invoice}/cancel-bank-payment`, { payment_id: f.payments[0].id });

      expect(res.status).toBe(200);
      expect(cancelDebit).toHaveBeenCalledTimes(1);
      expect(cancelDebit.mock.calls[0][0]).toBe(f.payments[0].pi);
      const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } });
      expect(payment.state).toBe('FAILED');
      const invoice = await f.readInvoice();
      expect(invoice.status).toBe('SENT');
      expect(Number(invoice.amount_due)).toBe(300);
      // The owner reads it in the invoice's history, in ServWave's words.
      const [entry] = await db.timelineEvent.findMany({ where: { entity_id: f.invoice, event_type: 'PAYMENT_CANCELED' } });
      expect(entry.description).toBe('Bank payment canceled before it cleared');

      // The processor's own "failed" event for the cancelled debit then changes nothing.
      const again = await f.api.post(`/api/invoices/${f.invoice}/cancel-bank-payment`, { payment_id: f.payments[0].id });
      expect(again.status).toBe(400);
      expect(cancelDebit).toHaveBeenCalledTimes(1);
    });

    it('a debit the processor will no longer cancel is left processing, with the reason', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }] });
      cancelDebit.mockRejectedValueOnce(Object.assign(new Error('This PaymentIntent could not be canceled'), {
        type: 'StripeInvalidRequestError', code: 'payment_intent_unexpected_state', statusCode: 400,
      }));

      const res = await f.api.post(`/api/invoices/${f.invoice}/cancel-bank-payment`, { payment_id: f.payments[0].id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This bank payment can no longer be cancelled. It can be refunded once it clears.');
      expect((await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } })).state).toBe('PROCESSING');
    });

    it('only a processing bank payment can be cancelled: a cleared one is refunded instead', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH' }] });

      const res = await f.api.post(`/api/invoices/${f.invoice}/cancel-bank-payment`, { payment_id: f.payments[0].id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Only a bank payment that is still processing can be cancelled.');
      expect(cancelDebit).not.toHaveBeenCalled();
    });

    it('another org cancels its own processing bank payment, but never one of ours', async () => {
      const mine = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }] });
      const theirs = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }] });
      cancelDebit.mockResolvedValue({ status: 'canceled' });
      const auditRows = (invoiceId: string) =>
        db.auditLog.findMany({ where: { resource_id: invoiceId, action: 'invoice.bank_payment_canceled' } });

      // Their own: cancelled, and on record in their audit trail.
      const own = await theirs.api.post(`/api/invoices/${theirs.invoice}/cancel-bank-payment`, { payment_id: theirs.payments[0].id });
      expect(own.status).toBe(200);
      expect((await db.payment.findUniqueOrThrow({ where: { id: theirs.payments[0].id } })).state).toBe('FAILED');
      for (let i = 0; i < 40 && (await auditRows(theirs.invoice)).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
      expect(await auditRows(theirs.invoice)).toHaveLength(1);

      // Ours, by its ids: not found, and nothing about it changes.
      const res = await theirs.api.post(`/api/invoices/${mine.invoice}/cancel-bank-payment`, { payment_id: mine.payments[0].id });
      expect(res.status).toBe(404);
      expect(cancelDebit).toHaveBeenCalledTimes(1);
      expect(cancelDebit.mock.calls[0][0]).toBe(theirs.payments[0].pi);
      await new Promise((r) => setTimeout(r, 200));
      expect((await db.payment.findUniqueOrThrow({ where: { id: mine.payments[0].id } })).state).toBe('PROCESSING');
      expect(await mine.refundRows()).toHaveLength(0);
      expect(await auditRows(mine.invoice)).toHaveLength(0);
      expect(await db.timelineEvent.count({ where: { entity_id: mine.invoice, event_type: 'PAYMENT_CANCELED' } })).toBe(0);
    });
  });

  describe('only someone who may refund payments can send money back or stop a bank payment', () => {
    /** A technician of the fixture's org, holding every Invoice switch except "Refund payments". */
    async function technicianOf(f: { org: string; tag: string }) {
      const id = randomUUID();
      await db.user.create({
        data: { id, organization_id: f.org, email: `tech-${f.tag}@example.test`, first_name: 'Test', last_name: 'Tech', role: 'TECHNICIAN' },
      });
      (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { user: { id, email: `tech-${f.tag}@example.test` } },
        error: null,
      });
      const bearer = `Bearer pay29-tech-${f.tag}`;
      return { post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body) };
    }

    it('a technician cannot cancel a processing bank payment', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'ACH', state: 'PROCESSING' }] });
      cancelDebit.mockResolvedValue({ status: 'canceled' });
      const tech = await technicianOf(f);

      const res = await tech.post(`/api/invoices/${f.invoice}/cancel-bank-payment`, { payment_id: f.payments[0].id });

      expect(res.status).toBe(403);
      expect(cancelDebit).not.toHaveBeenCalled();
      expect((await db.payment.findUniqueOrThrow({ where: { id: f.payments[0].id } })).state).toBe('PROCESSING');
    });

    it('a technician cannot refund a payment', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'CARD' }] });
      processorRefund.mockResolvedValue({ id: `re_pay29_tech_${f.tag}`, status: 'succeeded' });
      const tech = await technicianOf(f);

      const res = await tech.post(`/api/invoices/${f.invoice}/refund`, {
        amount: 50, payment_id: f.payments[0].id, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 29 test',
      });

      expect(res.status).toBe(403);
      expect(processorRefund).not.toHaveBeenCalled();
      expect(await f.refundRows()).toHaveLength(0);
    });
  });

  describe('a payout balance too low to send the refund', () => {
    const BALANCE_MESSAGE =
      'Your ServWave Payments balance is too low to send this refund. It will be possible once new payments arrive, or refund the customer another way.';

    it('the processor refusing for a low balance is shown in ServWave\'s words, and nothing is recorded', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'CARD' }] });
      // The processor's error for a refund the account's balance cannot cover.
      processorRefund.mockRejectedValueOnce(Object.assign(new Error('Insufficient funds in Stripe account.'), {
        type: 'StripeInvalidRequestError', code: 'balance_insufficient', statusCode: 400,
      }));

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(BALANCE_MESSAGE);
      expect(await f.refundRows()).toHaveLength(0);
      expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
    });

    it('any other refusal keeps the general "couldn\'t be sent" message', async () => {
      const f = await paidInvoice({ total: 300, payments: [{ amount: 300, method: 'CARD' }] });
      processorRefund.mockRejectedValueOnce(Object.assign(new Error('Charge has already been refunded.'), {
        type: 'StripeInvalidRequestError', code: 'charge_already_refunded', statusCode: 400,
      }));

      const res = await f.refund({ amount: 50, payment_id: f.payments[0].id });

      expect(res.body.error).toBe(
        "This refund couldn't be sent through ServWave Payments. Refund the customer another way, then record it here.",
      );
      expect(await f.refundRows()).toHaveLength(0);
    });
  });
});
