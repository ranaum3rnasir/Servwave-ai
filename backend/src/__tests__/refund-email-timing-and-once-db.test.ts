/* =============================================================================
   Payments go-live, slice 31 carry-overs from slice 30 - the refund email says how long the money takes
   FOR THE WAY IT WENT BACK, and goes out exactly once.

   Timing line: a card refund the card line, a bank refund the bank line, one recorded by hand none.
   Once: when the processor's refund event settles the row before the refund door's own completion
   runs (and the other way round), the customer is emailed one time, from both the Refund door and
   the Issue Credit give-back door. Real migrated database (TEST_DATABASE_URL); skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { createRefund, getStripeForOrg } from '../lib/stripe';
import { sendPaymentReceivedEmail, sendInvoiceRefundNotification } from '../lib/email';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const receiptSender = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;
const refundSender = sendInvoiceRefundNotification as unknown as ReturnType<typeof vi.fn>;
const retrievePaymentIntent = vi.fn();
const suite = realClient ? describe : describe.skip;

suite('receipt and refund emails from the real doors (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    receiptSender.mockClear();
    refundSender.mockClear();
    processorRefund.mockReset();
    retrievePaymentIntent.mockReset();
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
        checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  async function fixture(opts: { total: number; paid: boolean; method?: 'CARD' | 'ACH' | 'CASH' }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay31_${tag}`;
    const pi = `pi_pay31_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay31-${tag}`, email: `pay31-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'ACH'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test`,
      },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total,
        ...(opts.paid ? { status: 'PAID', amount_due: 0, paid_at: new Date() } : { status: 'SENT', amount_due: opts.total }),
      },
    });
    const payment = opts.paid
      ? await db.payment.create({
        data: {
          invoice_id: invoice, amount: opts.total, method: opts.method ?? 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
          ...(opts.method === 'CASH' ? {} : { stripe_payment_intent_id: pi, stripe_charge_id: `ch_pay31_${tag}`, stripe_account_id: account }), created_by_source: 'CLIENT',
        },
      })
      : null;
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay31-${tag}`;
    let seq = 0;
    const deliver = async (type: string, object: object) => {
      const event = { id: `evt_pay31_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, account, data: { object } };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
    };
    const refundObject = (id: string, amountCents: number, status: string) => ({
      id, object: 'refund', amount: amountCents, currency: 'usd', status, payment_intent: pi,
      charge: `ch_pay31_${tag}`, metadata: { source: 'in_app', invoiceId: invoice },
    });
    const doRefund = (amount: number) => request(app).post(`/api/invoices/${invoice}/refund`)
      .set('Authorization', bearer)
      .send({ amount, payment_id: payment?.id, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 30 test' });
    const doGiveBack = (amount: number) => request(app).post(`/api/invoices/${invoice}/credit`)
      .set('Authorization', bearer)
      .send({ amount, refund_instead: true, reason: 'slice 30 give-back' });
    return { org, tag, invoice, pi, account, doGiveBack, customerEmail: `pat-${tag}@example.test`, deliver, refundObject, doRefund };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay31_%'`));
    await db.$disconnect();
  });

  const timingOf = () => (refundSender.mock.calls[0][0] as { timing?: string }).timing;
  const rowIdOf = (call: unknown[]) => (call[3] as { metadata: Record<string, string> }).metadata.refund_row_id;

  it('a card refund carries the card timing', async () => {
    const f = await fixture({ total: 100, paid: true });
    processorRefund.mockResolvedValueOnce({ id: `re_pay31_${f.tag}`, object: 'refund', amount: 4000, status: 'succeeded' });
    expect((await f.doRefund(40)).status).toBe(200);
    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(timingOf()).toBe('card');
  });

  it('a bank refund, once the processor confirms it, carries the bank timing', async () => {
    const f = await fixture({ total: 100, paid: true, method: 'ACH' });
    const refundId = `re_pay31_ach_${f.tag}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'pending' });
    expect((await f.doRefund(50)).status).toBe(200);
    await f.deliver('refund.updated', f.refundObject(refundId, 5000, 'succeeded'));
    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(timingOf()).toBe('bank');
  });

  it('a refund recorded by hand (cash) is emailed with no timing line', async () => {
    const f = await fixture({ total: 100, paid: true, method: 'CASH' });
    expect((await f.doRefund(30)).status).toBe(200);
    expect(refundSender).toHaveBeenCalledTimes(1);
    expect(timingOf()).toBe('none');
  });

  it('Refund door: the processor event settles the row before the door completes it - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay31_first_${f.tag}`;
    processorRefund.mockImplementationOnce(async (...args: unknown[]) => {
      // The refund's own event lands while the door's call is still in flight.
      await f.deliver('refund.updated', {
        ...f.refundObject(refundId, 4000, 'succeeded'),
        metadata: { source: 'in_app', invoiceId: f.invoice, refund_row_id: rowIdOf(args) },
      });
      return { id: refundId, object: 'refund', amount: 4000, status: 'succeeded' };
    });

    expect((await f.doRefund(40)).status).toBe(200);

    expect(refundSender).toHaveBeenCalledTimes(1);
  });

  it('Refund door: the door completes the row first, then the event arrives - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay31_second_${f.tag}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 4000, status: 'succeeded' });

    expect((await f.doRefund(40)).status).toBe(200);
    await f.deliver('refund.updated', f.refundObject(refundId, 4000, 'succeeded'));

    expect(refundSender).toHaveBeenCalledTimes(1);
  });

  it('Issue Credit give-back door: the processor event settles the row before the door completes it - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay31_gbfirst_${f.tag}`;
    processorRefund.mockImplementationOnce(async (...args: unknown[]) => {
      await f.deliver('refund.updated', {
        ...f.refundObject(refundId, 3000, 'succeeded'),
        metadata: { source: 'in_app', invoiceId: f.invoice, refund_row_id: rowIdOf(args) },
      });
      return { id: refundId, object: 'refund', amount: 3000, status: 'succeeded' };
    });

    expect((await f.doGiveBack(30)).status).toBe(200);

    expect(refundSender).toHaveBeenCalledTimes(1);
  });
  // Slice 32b: the event recorded its OWN row (it did not carry the reservation's id), so the door's
  // completion folds the reservation into that row ("merged"). The customer is told once, whichever
  // of the door and the event settles the row.
  const ownRowObject = (f: Awaited<ReturnType<typeof fixture>>, id: string, cents: number, status: string) => ({
    ...f.refundObject(id, cents, status),
    metadata: { source: 'in_app', invoiceId: f.invoice },
  });

  it('Refund door, merged row: the event wrote its own pending row, the door settles it, then the event confirms - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay32b_merge_${f.tag}`;
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.created', ownRowObject(f, refundId, 4000, 'pending'));
      return { id: refundId, object: 'refund', amount: 4000, status: 'succeeded' };
    });

    expect((await f.doRefund(40)).status).toBe(200);
    await f.deliver('refund.updated', ownRowObject(f, refundId, 4000, 'succeeded'));

    expect(refundSender).toHaveBeenCalledTimes(1);
    const rows = await db.refund.findMany({ where: { invoice_id: f.invoice } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('SUCCEEDED');
  });

  it('Refund door, merged row: the event wrote and settled its own row first, then the door completes - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay32b_settled_${f.tag}`;
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.created', ownRowObject(f, refundId, 4000, 'pending'));
      await f.deliver('refund.updated', ownRowObject(f, refundId, 4000, 'succeeded'));
      return { id: refundId, object: 'refund', amount: 4000, status: 'succeeded' };
    });

    expect((await f.doRefund(40)).status).toBe(200);

    expect(refundSender).toHaveBeenCalledTimes(1);
  });

  it('Issue Credit give-back door, merged row: the event wrote its own pending row, the door settles it, then the event confirms - one email', async () => {
    const f = await fixture({ total: 100, paid: true });
    const refundId = `re_pay32b_gbmerge_${f.tag}`;
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.created', ownRowObject(f, refundId, 3000, 'pending'));
      return { id: refundId, object: 'refund', amount: 3000, status: 'succeeded' };
    });

    expect((await f.doGiveBack(30)).status).toBe(200);
    await f.deliver('refund.updated', ownRowObject(f, refundId, 3000, 'succeeded'));

    expect(refundSender).toHaveBeenCalledTimes(1);
  });
});
