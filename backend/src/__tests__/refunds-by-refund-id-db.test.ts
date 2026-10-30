/* =============================================================================
   Payments go-live, slice 07 - a refund is recorded once, keyed on the processor's refund id.

   The bug: at our pinned API version a charge event no longer carries its refunds list, so the
   charge.refunded handler could not tell an in-app refund from one made elsewhere. It wrote a
   second Refund row for every in-app refund and booked the charge's RUNNING refunded total as
   that refund's own amount: one $50 refund became two rows and $100 refunded.

   Now the in-app refund writes its row with the processor's refund id, the refund.* events only
   move that row's state, and a refund ServWave never saw is recorded once. charge.refunded
   records nothing.

   Events are posted to the real webhook route in the processor's payload shape for our pinned
   version (2025-02-24.acacia): a charge object with NO embedded refunds list, and refund objects
   on the refund.* events. Real migrated database (TEST_DATABASE_URL); skips when unset. Every org
   it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'http';
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
import { createRefund } from '../lib/stripe';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

suite('refunds recorded once, keyed on the refund id (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // ONE listening server for the whole file. Handing supertest the bare app makes it open and close a
  // server on an ephemeral port for every request; the keep-alive socket of one request can then be
  // reused against the NEXT server that is given the same port, and that request dies with "socket
  // hang up" (or "Parse Error: Expected HTTP/"). A request that never reaches the app leaves the
  // processor-mock answer its test queued unconsumed, and the next test would receive it.
  let server: http.Server;
  let app: http.Server;
  beforeAll(async () => {
    const expressApp = (await import('../app.js')).default as unknown as http.RequestListener;
    server = http.createServer(expressApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    app = server;
  });

  // Every test starts with an empty processor mock, and a test must use up what it queued: an answer
  // left over from a failed attempt (or a retry) would otherwise be handed to a later test's
  // refund and fail it with an error that points nowhere near the cause.
  beforeEach(() => {
    processorRefund.mockReset();
    processorRefund.mockResolvedValue({});
  });
  afterEach(async () => {
    const leftover = await Promise.resolve((processorRefund as unknown as () => unknown)()).then((v) => v, (e) => e);
    processorRefund.mockReset();
    expect(leftover, 'a processor answer this test queued was never used').toEqual({});
  });

  /** An org that takes card payments, with one $total invoice paid in full by one card charge. */
  async function paidByCard(opts: { total: number; method?: 'CARD' | 'ACH'; unpaid?: boolean }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay07_${tag}`;
    const pi = `pi_pay07_${tag}`;
    const charge = `ch_pay07_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay07-${tag}`, email: `pay07-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
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
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: opts.total, tax_amount: 0, total_amount: opts.total,
        ...(opts.unpaid ? { status: 'SENT', amount_due: opts.total } : { status: 'PAID', amount_due: 0, paid_at: new Date() }),
      },
    });
    const payment = opts.unpaid ? null : await db.payment.create({
      data: {
        invoice_id: invoice, amount: opts.total, method: opts.method ?? 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
        stripe_payment_intent_id: pi, stripe_charge_id: charge, stripe_account_id: account, created_by_source: 'CLIENT',
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer pay07-${tag}`;
    const api = {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body),
    };
    let seq = 0;
    const eventId = () => `evt_pay07_${tag}_${++seq}`;

    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object, id = eventId()) => {
      const event = { id, object: 'event', api_version: '2025-02-24.acacia', type, account, data: { object } };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
      return res;
    };
    /** A refund object, as the refund.* events carry it. */
    const refundObject = (id: string, amountCents: number, status: string, inApp: boolean) => ({
      id, object: 'refund', amount: amountCents, currency: 'usd', status, charge, payment_intent: pi,
      metadata: inApp ? { source: 'in_app', invoiceId: invoice } : {},
    });
    /** A charge object at the pinned version: the running refunded total, and NO refunds list. */
    const chargeObject = (amountRefundedCents: number) => ({
      id: charge, object: 'charge', amount: opts.total * 100, amount_refunded: amountRefundedCents,
      refunded: amountRefundedCents >= opts.total * 100, payment_intent: pi, metadata: { invoiceId: invoice },
    });
    const readInvoice = async () => {
      const res = await api.get(`/api/invoices/${invoice}`);
      expect(res.status).toBe(200);
      return {
        status: res.body.invoice.status as string,
        totalRefunded: Number(res.body.invoice.total_refunded),
        netCollected: Number(res.body.invoice.net_collected),
      };
    };
    const refundRows = () => db.refund.findMany({ where: { invoice_id: invoice }, orderBy: { created_at: 'asc' } });
    return { org, invoice, payment: payment?.id ?? '', api, deliver, refundObject, chargeObject, readInvoice, refundRows };
  }

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay07_%'`));
    await db.$disconnect();
  });

  it('one in-app $50 refund and its events leave exactly one Refund row and $50 refunded', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'succeeded' });

    const res = await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 50, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    });
    expect(res.status).toBe(200);

    // The processor then sends the charge event and the refund event for it.
    await f.deliver('charge.refunded', f.chargeObject(5000));
    await f.deliver('refund.created', f.refundObject(refundId, 5000, 'succeeded', true));

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_refund_id: refundId, state: 'SUCCEEDED' });
    expect(Number(rows[0].amount)).toBe(50);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 50, netCollected: 50 });
  });

  it('two partial refunds on one charge are booked at their own amounts, not the running total', async () => {
    const f = await paidByCard({ total: 100 });
    const tag = f.org.slice(0, 8);
    // Two refunds made outside ServWave: $30, then $20. The charge's running total reads 30, then 50.
    await f.deliver('charge.refunded', f.chargeObject(3000));
    await f.deliver('refund.created', f.refundObject(`re_pay07_a_${tag}`, 3000, 'succeeded', false));
    await f.deliver('charge.refunded', f.chargeObject(5000));
    await f.deliver('refund.created', f.refundObject(`re_pay07_b_${tag}`, 2000, 'succeeded', false));

    const rows = await f.refundRows();
    expect(rows.map((r) => [r.stripe_refund_id, Number(r.amount), r.state])).toEqual([
      [`re_pay07_a_${tag}`, 30, 'SUCCEEDED'],
      [`re_pay07_b_${tag}`, 20, 'SUCCEEDED'],
    ]);
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 50, netCollected: 50 });
  });

  it('a refund that fails stops counting: total refunded goes back to what it was', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_fail_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 4000, status: 'succeeded' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 40, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    })).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 40 });

    await f.deliver('refund.failed', f.refundObject(refundId, 4000, 'failed', true));

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('FAILED');
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', totalRefunded: 0, netCollected: 100 });
  });

  it('a new bank refund is written PENDING, counts nothing until it lands, then counts once', async () => {
    const f = await paidByCard({ total: 100, method: 'ACH' });
    const refundId = `re_pay07_ach_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'pending' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 50, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    })).status).toBe(200);

    const [pending] = await f.refundRows();
    expect(pending).toMatchObject({ stripe_refund_id: refundId, state: 'PENDING' });
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', totalRefunded: 0 });

    await f.deliver('refund.created', f.refundObject(refundId, 5000, 'pending', true));
    await f.deliver('refund.updated', f.refundObject(refundId, 5000, 'succeeded', true));

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('SUCCEEDED');
    expect(await f.readInvoice()).toMatchObject({ status: 'PARTIALLY_REFUNDED', totalRefunded: 50, netCollected: 50 });
  });

  it('refund.updated arriving before refund.created, and a replayed event, still make one row', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_ooo_${f.org.slice(0, 8)}`;
    const updated = `evt_pay07_${f.org.slice(0, 8)}_upd`;
    await f.deliver('refund.updated', f.refundObject(refundId, 2500, 'succeeded', false), updated);
    await f.deliver('refund.created', f.refundObject(refundId, 2500, 'succeeded', false));
    const replay = await f.deliver('refund.updated', f.refundObject(refundId, 2500, 'succeeded', false), updated);
    expect(replay.body).toMatchObject({ duplicate: true });

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 25 });
    // A refund made outside ServWave names no processor in the invoice history.
    expect(rows[0].reason).toBe('Refunded outside ServWave');
  });

  it('the refund event landing before the in-app write still leaves one row, with the staff details', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_race_${f.org.slice(0, 8)}`;
    await f.deliver('refund.created', f.refundObject(refundId, 5000, 'succeeded', true));
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'succeeded' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 50, payment_id: f.payment, reason_category: 'GOODWILL', reason: 'staff reason',
    })).status).toBe(200);

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_refund_id: refundId, reason: 'staff reason', reason_category: 'GOODWILL', state: 'SUCCEEDED' });
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 50 });
  });

  it('a refund event never touches another org: the payment is looked up inside the owning org', async () => {
    const mine = await paidByCard({ total: 100 });
    const theirs = await paidByCard({ total: 100 });
    // Arrives on MY connected account but names THEIR payment.
    const event = {
      id: `evt_pay07_${mine.org.slice(0, 8)}_xorg`, object: 'event', type: 'refund.created',
      account: `acct_pay07_${mine.org.slice(0, 8)}`,
      data: { object: { id: `re_pay07_xorg_${mine.org.slice(0, 8)}`, object: 'refund', amount: 5000, status: 'succeeded', payment_intent: `pi_pay07_${theirs.org.slice(0, 8)}`, metadata: {} } },
    };
    const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
    expect(res.status).toBe(200);
    expect(await theirs.refundRows()).toHaveLength(0);
    expect(await theirs.readInvoice()).toMatchObject({ status: 'PAID', totalRefunded: 0 });
  });

  it('a refund the processor refuses answers in ServWave words and writes nothing', async () => {
    const f = await paidByCard({ total: 100 });
    processorRefund.mockRejectedValueOnce(Object.assign(new Error('insufficient balance'), { statusCode: 400 }));
    const res = await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 50, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("This refund couldn't be sent through ServWave Payments. Refund the customer another way, then record it here.");
    expect(JSON.stringify(res.body)).not.toMatch(/stripe/i);
    expect(await f.refundRows()).toHaveLength(0);
  });

  /** A cash give-back through the credit door: the invoice is paid in full, so all of it goes back. */
  const giveBack = (f: Awaited<ReturnType<typeof paidByCard>>, amount: number) =>
    f.api.post(`/api/invoices/${f.invoice}/credit`, { amount, reason: 'slice 07 give-back' });

  it('a give-back whose refund event lands first, as already gone back, is counted once the give-back is written', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_gbev_${f.org.slice(0, 8)}`;
    // The event lands while the processor call is still answering, and the answer itself says pending.
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.created', f.refundObject(refundId, 5000, 'succeeded', true));
      return { id: refundId, object: 'refund', amount: 5000, status: 'pending' };
    });
    expect((await giveBack(f, 50)).status).toBe(200);

    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_refund_id: refundId, state: 'SUCCEEDED', reason: 'slice 07 give-back' });
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 50, netCollected: 50 });
  });

  it('a refund that settles while a give-back is on its way out is still counted after the give-back', async () => {
    const f = await paidByCard({ total: 100 });
    const tag = f.org.slice(0, 8);
    const earlier = `re_pay07_gbe_${tag}`;
    const giveBackId = `re_pay07_gbl_${tag}`;
    // An earlier $30 refund the processor still reports pending.
    processorRefund.mockResolvedValueOnce({ id: earlier, object: 'refund', amount: 3000, status: 'pending' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 30, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    })).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 0 });

    // It lands while the $20 give-back is being sent.
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.updated', f.refundObject(earlier, 3000, 'succeeded', true));
      return { id: giveBackId, object: 'refund', amount: 2000, status: 'succeeded' };
    });
    expect((await giveBack(f, 20)).status).toBe(200);

    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 50, netCollected: 50 });
    const stored = await db.invoice.findUniqueOrThrow({ where: { id: f.invoice }, select: { total_refunded: true, net_collected: true } });
    expect([Number(stored.total_refunded), Number(stored.net_collected)]).toEqual([50, 50]);
  });

  it('a refund event recording the give-back at the same moment it is written leaves one row and no lost credit', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay07_gbrace_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 5000, status: 'succeeded' });

    // The reconciler's write for this refund's event, held open mid-transaction: it holds the
    // invoice lock (as every ledger door does) and has written the row, but not committed yet.
    let rowWritten!: () => void;
    let release!: () => void;
    let reconcilerPid = 0;
    const written = new Promise<void>((r) => { rowWritten = r; });
    const released = new Promise<void>((r) => { release = r; });
    const reconciler = db.$transaction(async (tx) => {
      reconcilerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${f.invoice}::uuid AND organization_id = ${f.org}::uuid FOR UPDATE`;
      const admin = await tx.user.findFirstOrThrow({ where: { organization_id: f.org }, select: { id: true } });
      await tx.refund.create({
        data: {
          invoice_id: f.invoice, payment_id: f.payment, amount: 50, tax_portion: 0, non_taxable_concession: false,
          method: 'CARD', reason: 'Refund sent from ServWave', reason_category: 'OTHER', stripe_refund_id: refundId,
          state: 'SUCCEEDED', refunded_by: admin.id, organization_id: f.org,
        },
      });
      rowWritten();
      await released;
    }, { timeout: 20_000 });
    await written;

    // The give-back is written meanwhile. Wait until it is held up by THIS transaction (not by any
    // lock wait in the shared database): some backend is blocked behind the reconciler's pid.
    const response = giveBack(f, 50).then((r) => r);
    const waiting = async () => (await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND ${reconcilerPid}::int = ANY(pg_blocking_pids(pid))`)[0].n;
    for (let i = 0; i < 100 && (await waiting()) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await waiting()).toBeGreaterThan(0);
    release();
    await reconciler;

    const res = await response;
    expect(res.status).toBe(200);
    const rows = await f.refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_refund_id: refundId, state: 'SUCCEEDED', reason: 'slice 07 give-back', reason_category: 'OVERPAYMENT' });
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 50, netCollected: 50 });
  });

  // ─── Slice 08: the refund gaps the slice 07 review left ─────────────────────────────────────

  /** The payment's refund stamp, as the fees report reads it. */
  const stamp = async (paymentId: string) => {
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refunded_amount: true, refunded_at: true } });
    return { amount: p.refunded_amount == null ? null : Number(p.refunded_amount), stamped: p.refunded_at != null };
  };
  const history = (invoice: string) => db.timelineEvent.findMany({ where: { entity_id: invoice, event_type: 'INVOICE_REFUNDED' } });
  /** The fire-and-forget audit rows land just after the response. */
  const auditRows = async (org: string, action: string) => {
    for (let i = 0; i < 40; i++) {
      const rows = await db.auditLog.findMany({ where: { org_id: org, action } });
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  };

  it('a refund event matching no payment in the org is written down as not recorded, once per refund', async () => {
    const f = await paidByCard({ total: 100 });
    const tag = f.org.slice(0, 8);
    const stray = { id: `re_pay08_stray_${tag}`, object: 'refund', amount: 2500, currency: 'usd', status: 'succeeded', payment_intent: `pi_pay08_unknown_${tag}`, metadata: {} };
    await f.deliver('refund.created', stray);
    await f.deliver('refund.updated', stray);

    const rows = await db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'ORGANIZATION', entity_id: f.org });
    expect(rows[0].metadata).toMatchObject({ reason: 'REFUND_UNMATCHED', charged_cents: 2500, processor_refund_id: stray.id });
    expect(rows[0].description).not.toMatch(/stripe/i);
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'billing.payment_unrecorded' } })).toBe(1);
    expect(await f.refundRows()).toHaveLength(0);
  });

  // Payments go-live slice 09 (conductor note from slice 08 review): the once-per-refund check is
  // read and written under a per-refund lock, so deliveries at the same moment cannot both pass it.
  it('a stray refund delivered by several events at the same moment is written down once', async () => {
    const f = await paidByCard({ total: 100 });
    const tag = f.org.slice(0, 8);
    const stray = { id: `re_pay09_race_${tag}`, object: 'refund', amount: 2500, currency: 'usd', status: 'succeeded', payment_intent: `pi_pay09_unknown_${tag}`, metadata: {} };
    await Promise.all(['refund.created', ...Array(7).fill('refund.updated')].map((type) => f.deliver(type, stray)));

    const rows = await db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } });
    expect(rows).toHaveLength(1);
  });

  it("the payment's refund stamp follows its SUCCEEDED refunds: an outside refund adds to it, a failed one comes off it", async () => {
    const f = await paidByCard({ total: 100 });
    const tag = f.org.slice(0, 8);
    // $30 made outside ServWave lands: stamped.
    await f.deliver('refund.created', f.refundObject(`re_pay08_out_${tag}`, 3000, 'succeeded', false));
    expect(await stamp(f.payment)).toEqual({ amount: 30, stamped: true });

    // $20 in-app, then the processor reports it failed: off the stamp again.
    const inApp = `re_pay08_inapp_${tag}`;
    processorRefund.mockResolvedValueOnce({ id: inApp, object: 'refund', amount: 2000, status: 'succeeded' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 20, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 08 test',
    })).status).toBe(200);
    expect(await stamp(f.payment)).toEqual({ amount: 50, stamped: true });
    await f.deliver('refund.failed', f.refundObject(inApp, 2000, 'failed', true));
    expect(await stamp(f.payment)).toEqual({ amount: 30, stamped: true });

    // The outside refund fails too: nothing has gone back, so nothing is stamped.
    await f.deliver('refund.failed', f.refundObject(`re_pay08_out_${tag}`, 3000, 'failed', false));
    expect(await stamp(f.payment)).toEqual({ amount: null, stamped: false });
  });

  it('a bank refund in flight is not stamped until it lands', async () => {
    const f = await paidByCard({ total: 100, method: 'ACH' });
    const refundId = `re_pay08_achs_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 4000, status: 'pending' });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 40, payment_id: f.payment, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 08 test',
    })).status).toBe(200);
    expect(await stamp(f.payment)).toEqual({ amount: null, stamped: false });
    await f.deliver('refund.updated', f.refundObject(refundId, 4000, 'succeeded', true));
    expect(await stamp(f.payment)).toEqual({ amount: 40, stamped: true });
  });

  it('a refund made outside ServWave that arrives PENDING gets its history only once it lands, and never if it fails', async () => {
    const f = await paidByCard({ total: 100, method: 'ACH' });
    const tag = f.org.slice(0, 8);
    const landing = `re_pay08_outp_${tag}`;
    await f.deliver('refund.created', f.refundObject(landing, 3000, 'pending', false));
    expect(await history(f.invoice)).toHaveLength(0);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).refunded_at).toBeNull();

    await f.deliver('refund.updated', f.refundObject(landing, 3000, 'succeeded', false));
    await f.deliver('refund.updated', f.refundObject(landing, 3000, 'succeeded', false));
    const rows = await history(f.invoice);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Refund made outside ServWave recorded');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: f.invoice } })).refunded_at).not.toBeNull();

    const failing = `re_pay08_outf_${tag}`;
    await f.deliver('refund.created', f.refundObject(failing, 1000, 'pending', false));
    await f.deliver('refund.failed', f.refundObject(failing, 1000, 'failed', false));
    expect(await history(f.invoice)).toHaveLength(1);
  });

  it("a refund carrying ServWave's in-app marker but no row is booked as made outside ServWave, with its audit row", async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay08_mark_${f.org.slice(0, 8)}`;
    await f.deliver('refund.created', f.refundObject(refundId, 2500, 'succeeded', true));

    const [row] = await f.refundRows();
    expect(row).toMatchObject({ stripe_refund_id: refundId, reason: 'Refunded outside ServWave' });
    expect(await history(f.invoice)).toHaveLength(1);
    const audits = await auditRows(f.org, 'invoice.refunded_outside_servwave');
    expect(audits).toHaveLength(1);
  });

  it('a refund that names no payment is stored against the one payment it was taken from, and stamps it', async () => {
    const f = await paidByCard({ total: 100 });
    const refundId = `re_pay08_auto_${f.org.slice(0, 8)}`;
    processorRefund.mockResolvedValueOnce({ id: refundId, object: 'refund', amount: 3000, status: 'succeeded' });
    // "Auto": no payment named; the invoice has one payment, so that is the one refunded.
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 30, reason_category: 'CUSTOMER_REQUEST', reason: 'slice 08 test',
    })).status).toBe(200);

    const [row] = await f.refundRows();
    expect(row.payment_id).toBe(f.payment);
    expect(await stamp(f.payment)).toEqual({ amount: 30, stamped: true });
  });

  it('net collected is derived from the ledger on every money door, not only the refund doors', async () => {
    // Paid by hand, then part refunded by hand: no processor, no webhook.
    const f = await paidByCard({ total: 100, unpaid: true });
    expect((await f.api.post(`/api/invoices/${f.invoice}/payments`, { amount: 100, method: 'CASH' })).status).toBe(201);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID', netCollected: 100 });
    expect((await f.api.post(`/api/invoices/${f.invoice}/refund`, {
      amount: 30, method: 'CASH', reason_category: 'CUSTOMER_REQUEST', reason: 'slice 07 test',
    })).status).toBe(200);
    expect(await f.readInvoice()).toMatchObject({ totalRefunded: 30, netCollected: 70 });
  });
});
