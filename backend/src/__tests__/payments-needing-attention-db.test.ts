/* =============================================================================
   Payments go-live, slice 11 - "Payments needing attention", with a one-click refund.

   Before: money the processor captured that ServWave could not apply to an invoice (the invoice
   was voided or already paid, the session named no invoice of the org, the amount did not match,
   the deposit was on hold...) was written down only as a timeline row, an in-app alert and an
   audit row. Nothing listed those captures, and nothing let a person send the money back: the
   customer's money sat in limbo until someone went to the processor by hand.

   Now every unapplied capture is also a record (OPEN, REFUNDED or RESOLVED). Settings > Payments
   lists them for the people allowed to refund, and "Refund" sends the whole capture back and marks
   the record REFUNDED. The refund id is kept on the record, so the refund's own events do not
   write the money down a second time.

   Events are posted to the real webhook route in the processor's payload shape for the pinned
   version; staff calls go through the real routes with a real role. Real migrated database
   (TEST_DATABASE_URL); skips when unset. Every org it creates is removed again.
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
import { REFUND_ROW_METADATA_KEY } from '../lib/in-app-refund';
import { createRefund, getStripeForOrg, listPaymentIntentRefunds } from '../lib/stripe';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { ATTENTION_REFUND_NOT_SENT } from '../controllers/payment-attention.controller';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
/** The refunds the processor already holds on a payment intent. */
const refundsOnProcessor = listPaymentIntentRefunds as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

/** The charge the processor returns for a payment intent (latest_charge expanded). */
const retrievePaymentIntent = vi.fn();

suite('payments needing attention (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_x', latest_charge: null });
    processorRefund.mockReset();
    refundsOnProcessor.mockReset();
    refundsOnProcessor.mockResolvedValue([]);
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

  /** Sign in as this user for the next calls (the auth layer caches the resolved user by token). */
  function signedInAs(user: { id: string; email: string }) {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user.id, email: user.email } },
      error: null,
    });
    const bearer = `Bearer pay11-${user.id}`;
    return {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body),
    };
  }

  /** An org with a connected account, an admin, a customer and one invoice of $total. */
  async function orgWithInvoice(opts: { total?: number; status?: 'SENT' | 'VOIDED' | 'PAID' } = {}) {
    const total = opts.total ?? 500;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const admin = { id: randomUUID(), email: `admin-${tag}@example.test` };
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay11_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay11-${tag}`, email: `pay11-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
      },
    });
    await db.user.create({
      data: { id: admin.id, organization_id: org, email: admin.email, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, status: opts.status ?? 'SENT',
      },
    });
    let seq = 0;
    /** A paid card checkout session, as checkout.session.completed carries it. */
    const session = (over: Record<string, unknown> = {}) => ({
      id: `cs_pay11_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
      payment_intent: `pi_pay11_${tag}`, amount_total: total * 100, currency: 'usd',
      metadata: { invoiceId: invoice },
      ...over,
    });
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object, id = `evt_pay11_${tag}_${++seq}`) => {
      const event = { id, object: 'event', api_version: '2025-02-24.acacia', type, account, created: 1790000000, data: { object } };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
      return res;
    };
    return { org, tag, admin, customer, invoice, account, session, deliver };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM unapplied_captures WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM role_permissions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['permission_change_log', 'permission_role_switches', 'timeline_events', 'notifications', 'invoices', 'visit_assignees', 'visits', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay11_%'`));
    await db.$disconnect();
  });

  it('a card payment that completes on a voided invoice is listed once, OPEN, with its amount, reason and invoice', async () => {
    const f = await orgWithInvoice({ total: 500, status: 'VOIDED' });

    await f.deliver('checkout.session.completed', f.session());

    const res = await signedInAs(f.admin).get('/api/payments-needing-attention');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      status: 'OPEN',
      kind: 'PAYMENT',
      reason: 'INVOICE_NOT_PAYABLE',
      amount: 500,
      invoice: { id: f.invoice, invoice_number: `INV-${f.tag}`, status: 'VOIDED' },
      can_refund: true,
    });
    expect(typeof res.body.items[0].created_at).toBe('string');
  });

  it('a replayed event, or the same money under another event id, makes no second record', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });

    await f.deliver('checkout.session.completed', f.session(), `evt_pay11_${f.tag}_same`);
    await f.deliver('checkout.session.completed', f.session(), `evt_pay11_${f.tag}_same`);
    await f.deliver('checkout.session.completed', f.session(), `evt_pay11_${f.tag}_other`);

    const res = await signedInAs(f.admin).get('/api/payments-needing-attention');
    expect(res.body.items).toHaveLength(1);
    expect(await db.unappliedCapture.count({ where: { organization_id: f.org } })).toBe(1);
  });

  it('the list is tenant-scoped: another org sees none of this org\'s records', async () => {
    const a = await orgWithInvoice({ total: 300, status: 'VOIDED' });
    const b = await orgWithInvoice({ total: 75, status: 'PAID' });
    await a.deliver('checkout.session.completed', a.session());
    await b.deliver('checkout.session.completed', b.session());

    const seenByA = await signedInAs(a.admin).get('/api/payments-needing-attention');
    const seenByB = await signedInAs(b.admin).get('/api/payments-needing-attention');

    expect(seenByA.body.items.map((i: { amount: number }) => i.amount)).toEqual([300]);
    expect(seenByB.body.items.map((i: { amount: number }) => i.amount)).toEqual([75]);
    expect(seenByB.body.items[0].invoice.id).toBe(b.invoice);
  });

  it('money no invoice of the org can carry is listed on the org, and a stray refund is listed as a refund', async () => {
    const f = await orgWithInvoice({ total: 200 });
    // The session names an invoice ServWave has never had.
    await f.deliver('checkout.session.completed', f.session({ id: `cs_pay11_${f.tag}_lost`, payment_intent: `pi_pay11_${f.tag}_lost`, metadata: { invoiceId: randomUUID() } }));
    // A refund went out of the account for a payment ServWave never recorded.
    await f.deliver('refund.created', {
      id: `re_pay11_${f.tag}_stray`, object: 'refund', amount: 4200, currency: 'usd', status: 'succeeded',
      payment_intent: `pi_pay11_${f.tag}_unknown`, charge: `ch_pay11_${f.tag}_unknown`, metadata: {},
    });

    const res = await signedInAs(f.admin).get('/api/payments-needing-attention');
    const byReason = Object.fromEntries(res.body.items.map((i: { reason: string }) => [i.reason, i]));
    expect(res.body.items).toHaveLength(2);
    expect(byReason.INVOICE_NOT_FOUND).toMatchObject({ kind: 'PAYMENT', amount: 200, invoice: null, status: 'OPEN', can_refund: true });
    expect(byReason.REFUND_UNMATCHED).toMatchObject({ kind: 'REFUND', amount: 42, invoice: null, status: 'OPEN', can_refund: false });
  });

  it('Refund sends the whole capture back out of the account it landed in, and the record reads REFUNDED', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });

    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: item.id, status: 'REFUNDED', can_refund: false });
    expect(processorRefund).toHaveBeenCalledTimes(1);
    const [pi, , cents] = processorRefund.mock.calls[0];
    expect(pi).toBe(`pi_pay11_${f.tag}`);
    expect(cents).toBe(12000);
    expect(vi.mocked(getStripeForOrg)).toHaveBeenCalledWith({ stripe_account_id: f.account });
    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'REFUNDED', can_refund: false });
    expect(typeof after[0].refunded_at).toBe('string');
  });

  /** A refund object as the refund.* events carry it, for the refund ServWave sent for a record. */
  const attentionRefund = (f: { tag: string }, recordId: string, status: string) => ({
    id: `re_pay11_${f.tag}`, object: 'refund', amount: 12000, currency: 'usd', status,
    payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
    metadata: { source: 'in_app', unapplied_capture_id: recordId },
  });

  it('the refund\'s own events write nothing down a second time', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

    await f.deliver('refund.created', attentionRefund(f, item.id, 'succeeded'));
    await f.deliver('refund.updated', attentionRefund(f, item.id, 'succeeded'));

    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: item.id, status: 'REFUNDED', kind: 'PAYMENT' });
    // The only "not recorded" history row is the capture's own.
    expect(await db.timelineEvent.count({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } })).toBe(1);
  });

  it('a refund that lands before the list has stored it still marks its record REFUNDED, once', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;

    // The processor answered the refund call slowly; its event came first.
    await f.deliver('refund.created', attentionRefund(f, item.id, 'succeeded'));

    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: item.id, status: 'REFUNDED', can_refund: false });
  });

  it('a refund that fails puts the payment back on the list, and Refund then sends a new refund', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'pending', amount: 12000 });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

    await f.deliver('refund.failed', attentionRefund(f, item.id, 'failed'));

    const reopened = (await api.get('/api/payments-needing-attention')).body.items;
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ id: item.id, status: 'OPEN', can_refund: true });

    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_2`, object: 'refund', status: 'succeeded', amount: 12000 });
    const again = await api.post(`/api/payments-needing-attention/${item.id}/refund`);
    expect(again.status).toBe(200);
    expect(again.body.item.status).toBe('REFUNDED');
    const keys = processorRefund.mock.calls.map((c) => c[3]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    // The first refund failed: replaying its key would only hand back the failed refund.
    expect(keys[1]).not.toBe(keys[0]);
  });

  // Fix round 2: the processor does not promise event order. A refund that failed never leaves its
  // record reading REFUNDED, whatever arrives after the failure.
  it('a created or updated event that lands after its refund failed leaves the payment open', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'pending', amount: 12000 });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);
    await f.deliver('refund.failed', attentionRefund(f, item.id, 'failed'));

    // A retried delivery from before the failure arrives late.
    await f.deliver('refund.created', attentionRefund(f, item.id, 'pending'));
    await f.deliver('refund.updated', attentionRefund(f, item.id, 'succeeded'));

    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: item.id, status: 'OPEN', can_refund: true, refunded_at: null });
  });

  it('a refund that fails before the list stores it leaves the payment open and says it was not sent', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    // The processor took the refund, then reported it failed before its answer reached ServWave.
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.failed', attentionRefund(f, item.id, 'failed'));
      return { id: `re_pay11_${f.tag}`, object: 'refund', status: 'pending', amount: 12000 };
    });

    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe(ATTENTION_REFUND_NOT_SENT);
    await f.deliver('refund.created', attentionRefund(f, item.id, 'pending'));
    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after[0]).toMatchObject({ id: item.id, status: 'OPEN', can_refund: true });

    // The next click sends a new refund, not a replay of the failed one.
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_2`, object: 'refund', status: 'succeeded', amount: 12000 });
    expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(200);
    const keys = processorRefund.mock.calls.map((c) => c[3]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a bank payment whose refund fails before the list stores it stays open, and nothing comes off the invoice', async () => {
    const f = await orgWithInvoice({ total: 300 });
    const bank = bankSession(f);
    await f.deliver('checkout.session.completed', bank());
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'VOIDED' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    const failed = {
      id: `re_pay11_${f.tag}_bank`, object: 'refund', amount: 30000, currency: 'usd', status: 'failed',
      payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
      metadata: { source: 'in_app', unapplied_capture_id: item.id },
    };
    processorRefund.mockImplementationOnce(async () => {
      await f.deliver('refund.failed', failed);
      return { id: failed.id, object: 'refund', status: 'pending', amount: 30000 };
    });

    expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
    await f.deliver('refund.updated', { ...failed, status: 'pending' });

    expect((await api.get('/api/payments-needing-attention')).body.items[0]).toMatchObject({ id: item.id, status: 'OPEN', can_refund: true });
    const { invoice } = (await api.get(`/api/invoices/${f.invoice}`).expect(200)).body;
    expect(invoice.refunds.map((r: { state: string }) => r.state)).toEqual(['FAILED']);
    expect(Number(invoice.total_refunded)).toBe(0);
  });

  // Conductor fix round: the reconciler handles one refund at a time under that refund's lock. Its
  // refund.failed read the record OPEN, and is about to keep the failure on it, when the list's own
  // commit for the same refund arrives. The list waits for that event, then sees the failure.
  it('a refund failure the reconciler is mid-way through storing is never overwritten by the list marking it refunded', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    const refundId = `re_pay11_${f.tag}`;
    processorRefund.mockResolvedValue({ id: refundId, object: 'refund', status: 'pending', amount: 12000 });

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      // What reconcileEvent does for refund.failed: the refund's lock, then the record read (OPEN,
      // no failure kept yet), then - once it has decided - the failure kept on the record.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${refundId}`}, 0))`;
      const seen = await tx.unappliedCapture.findFirstOrThrow({ where: { id: item.id }, select: { status: true, failed_refund_ids: true } });
      expect(seen).toEqual({ status: 'OPEN', failed_refund_ids: [] });
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
      await tx.unappliedCapture.updateMany({
        where: { id: item.id, organization_id: f.org, NOT: { failed_refund_ids: { has: refundId } } },
        data: { failed_refund_ids: { push: refundId } },
      });
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the reconciler never held the lock'); })]);

    let settled = false;
    const clicked = api.post(`/api/payments-needing-attention/${item.id}/refund`).then((r) => { settled = true; return r; });
    let blocked = false;
    try {
      for (let i = 0; i < 100 && !blocked && !settled; i++) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      release();
      await holder;
    }
    const res = await clicked;

    const stored = await db.unappliedCapture.findUniqueOrThrow({ where: { id: item.id }, select: { status: true, stripe_refund_id: true, failed_refund_ids: true } });
    expect(stored).toEqual({ status: 'OPEN', stripe_refund_id: null, failed_refund_ids: [refundId] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(ATTENTION_REFUND_NOT_SENT);
    expect(blocked, 'the list never waited on the refund the reconciler held').toBe(true);
  });

  // Conductor fix round: the processor replays the first answer to an idempotency key for a day,
  // failures included. A refund the processor refused, or answered failed, must not be the answer to
  // every later click.
  describe('the idempotency key of a refund sent from the list', () => {
    const keysSent = () => processorRefund.mock.calls.map((c) => c[3]?.idempotencyKey as string);
    /** An error the processor answered with (it carries the HTTP status it returned). */
    const answered = (statusCode: number, code: string) =>
      Object.assign(new Error(code), { type: statusCode < 500 ? 'StripeInvalidRequestError' : 'StripeAPIError', statusCode, code });

    async function openRecord() {
      const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
      await f.deliver('checkout.session.completed', f.session());
      const api = signedInAs(f.admin);
      const [item] = (await api.get('/api/payments-needing-attention')).body.items;
      return { f, api, item };
    }

    it('a retry after the processor refused the refund (4xx) is sent under a new key, and goes out', async () => {
      const { f, api, item } = await openRecord();
      processorRefund.mockRejectedValueOnce(answered(400, 'balance_insufficient'));
      // Slice 29: a refund the payout balance cannot cover says so, in ServWave's words.
      const refused = await api.post(`/api/payments-needing-attention/${item.id}/refund`);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/^Your ServWave Payments balance is too low to send this refund\./);

      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });
      const again = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

      expect(again.status).toBe(200);
      const [first, second] = keysSent();
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });

    it('a retry after a processor error (5xx), or a refund answered failed, is sent under a new key', async () => {
      const { f, api, item } = await openRecord();
      processorRefund.mockRejectedValueOnce(answered(500, 'api_error'));
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}_x`, object: 'refund', status: 'failed', amount: 12000 });
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(200);

      expect(new Set(keysSent()).size).toBe(3);
    });

    it('a retry after a lost answer (no reply reached ServWave) reuses the key, so the processor sends one refund', async () => {
      const { f, api, item } = await openRecord();
      processorRefund.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(200);

      const [first, second] = keysSent();
      expect(second).toBe(first);
    });

    // Conductor fix round 2: an error is not always a "no". A 5xx may mean the refund went out; a
    // 409 or 429 means another request under the key is still running, or this one never ran.
    it.each([
      [409, 'idempotency_key_in_use'],
      [429, 'lock_timeout'],
    ])('a retry after a %i (%s) reuses the key, so a refund still running is never sent twice', async (status, code) => {
      const { f, api, item } = await openRecord();
      processorRefund.mockRejectedValueOnce(answered(status, code));
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(200);

      const [first, second] = keysSent();
      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it('a processor error (5xx) on a refund that went out anyway: the money stays held, no second refund goes out, and the refund\'s own event completes it', async () => {
      // A $300 bank payment onto an invoice that owed $200: $100 sits on the payment, needing attention.
      const f = await orgWithInvoice({ total: 300 });
      const bank = bankSession(f);
      await f.deliver('checkout.session.completed', bank());
      await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 200, status: 'PARTIAL' } });
      await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
      const api = signedInAs(f.admin);
      const [item] = (await api.get('/api/payments-needing-attention')).body.items;
      expect(item).toMatchObject({ reason: 'OVERPAYMENT', amount: 100 });

      // Attempt 1 answers 500, but the processor did create the refund.
      processorRefund.mockRejectedValueOnce(answered(500, 'api_error'));
      expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
      const held = await db.refund.findMany({ where: { invoice_id: f.invoice }, select: { id: true, state: true, stripe_refund_id: true } });
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ state: 'PENDING', stripe_refund_id: null });

      // Were a second refund sent, the processor would take it: $200 is still refundable.
      processorRefund.mockResolvedValueOnce({ id: `re_pay11_${f.tag}_second`, object: 'refund', status: 'pending', amount: 10000 });
      const again = await api.post(`/api/payments-needing-attention/${item.id}/refund`);
      expect(again.status).not.toBe(200);
      expect(processorRefund).toHaveBeenCalledTimes(1);

      // The refund that did go out reports itself, naming the held row: that row is completed.
      const madeAnyway = `re_pay11_${f.tag}_made`;
      const landed = {
        id: madeAnyway, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded',
        payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
        metadata: { source: 'in_app', unapplied_capture_id: item.id, [REFUND_ROW_METADATA_KEY]: held[0].id },
      };
      await f.deliver('refund.created', { ...landed, status: 'pending' });
      await f.deliver('refund.updated', landed);

      const rows = await db.refund.findMany({ where: { invoice_id: f.invoice }, select: { amount: true, stripe_refund_id: true } });
      expect(rows.map((r) => [Number(r.amount), r.stripe_refund_id])).toEqual([[100, madeAnyway]]);
      const record = await db.unappliedCapture.findFirstOrThrow({ where: { id: item.id }, select: { status: true, stripe_refund_id: true } });
      expect(record).toEqual({ status: 'REFUNDED', stripe_refund_id: madeAnyway });
    });

    it('when the refunds already sent cannot be read, nothing is sent and the payment stays open', async () => {
      const { api, item } = await openRecord();
      refundsOnProcessor.mockRejectedValueOnce(Object.assign(new Error('api_error'), { statusCode: 500 }));

      const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

      expect(res.status).toBe(502);
      expect(res.body.error).toBe(ATTENTION_REFUND_NOT_SENT);
      expect(processorRefund).not.toHaveBeenCalled();
      expect((await api.get('/api/payments-needing-attention')).body.items[0].status).toBe('OPEN');
    });

    it('a double click sends both requests under one key', async () => {
      const { f, api, item } = await openRecord();
      // Both clicks reach the processor before either answer comes back.
      let open!: () => void;
      const bothSent = new Promise<void>((r) => { open = r; });
      processorRefund.mockImplementation(async () => {
        if (processorRefund.mock.calls.length === 2) open();
        await Promise.race([bothSent, new Promise((r) => setTimeout(r, 3000))]);
        return { id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 };
      });

      await Promise.all([
        api.post(`/api/payments-needing-attention/${item.id}/refund`),
        api.post(`/api/payments-needing-attention/${item.id}/refund`),
      ]);

      const keys = keysSent();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });
  });

  it('the list and the refund need the refund permission; a role given it sees the list', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const [item] = (await signedInAs(f.admin).get('/api/payments-needing-attention')).body.items;
    const dispatcher = { id: randomUUID(), email: `dispatch-${f.tag}@example.test` };
    await db.user.create({
      data: { id: dispatcher.id, organization_id: f.org, email: dispatcher.email, first_name: 'Dee', last_name: 'Spatch', role: 'DISPATCHER' },
    });
    // The role may read invoices, but not refund them.
    await db.rolePermission.create({ data: { organization_id: f.org, role: 'DISPATCHER', action: 'read', subject: 'Invoice' } });

    const without = signedInAs(dispatcher);
    expect((await without.get('/api/payments-needing-attention')).status).toBe(403);
    expect((await without.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(403);
    expect(processorRefund).not.toHaveBeenCalled();
    expect((await signedInAs(f.admin).get('/api/payments-needing-attention')).body.items[0].status).toBe('OPEN');

    // The role is given the Refund payments switch.
    await setRoleSwitchValues({ organizationId: f.org, roleKey: 'DISPATCHER', values: { refund_payments: true, view_payments: true }, actorId: null, reason: 'manual' });
    clearPermissionCache(f.org);
    const listed = await signedInAs(dispatcher).get('/api/payments-needing-attention');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
  });

  it('another org cannot refund this org\'s payment, even by id', async () => {
    const a = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    const b = await orgWithInvoice({ total: 80 });
    await a.deliver('checkout.session.completed', a.session());
    const [item] = (await signedInAs(a.admin).get('/api/payments-needing-attention')).body.items;

    const res = await signedInAs(b.admin).post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(404);
    expect(processorRefund).not.toHaveBeenCalled();
    expect((await signedInAs(a.admin).get('/api/payments-needing-attention')).body.items[0].status).toBe('OPEN');
  });

  it('a bank payment that clears for more than the balance lists the excess, and Refund sends back only that', async () => {
    const f = await orgWithInvoice({ total: 300 });
    const bank = (over: Record<string, unknown> = {}) => f.session({
      payment_status: 'unpaid', payment_method_types: ['us_bank_account'],
      metadata: { invoiceId: f.invoice, organizationId: f.org, kind: 'invoice', payableNowCents: '30000' },
      ...over,
    });
    await f.deliver('checkout.session.completed', bank());
    // While the debit cleared, $100 of the balance was settled another way.
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 200, status: 'PARTIAL' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));

    const api = signedInAs(f.admin);
    const [item, ...others] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(others).toHaveLength(0);
    expect(item).toMatchObject({ reason: 'OVERPAYMENT', amount: 100, status: 'OPEN', can_refund: true, invoice: { id: f.invoice } });

    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_excess`, object: 'refund', status: 'pending', amount: 10000 });
    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('REFUNDED');
    const [pi, , cents] = processorRefund.mock.calls[0];
    expect(pi).toBe(`pi_pay11_${f.tag}`);
    expect(cents).toBe(10000);
    expect(vi.mocked(getStripeForOrg)).toHaveBeenLastCalledWith({ stripe_account_id: f.account });
  });

  /** A $300 bank checkout on this org's invoice, as the processing and cleared events carry it. */
  const bankSession = (f: Awaited<ReturnType<typeof orgWithInvoice>>) => (over: Record<string, unknown> = {}) => f.session({
    payment_status: 'unpaid', payment_method_types: ['us_bank_account'],
    metadata: { invoiceId: f.invoice, organizationId: f.org, kind: 'invoice', payableNowCents: '30000' },
    ...over,
  });

  // Fix round 1 (PRD story 40): money sent back from the list that sat on a payment row comes off
  // that payment in the invoice's totals, exactly once.
  it('refunding the excess of a bank overpayment takes it off the invoice\'s totals once, and the invoice keeps reading PAID', async () => {
    const f = await orgWithInvoice({ total: 300 });
    const bank = bankSession(f);
    await f.deliver('checkout.session.completed', bank());
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 200, status: 'PARTIAL' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;

    // A bank refund is pending at first, then lands.
    const refundId = `re_pay11_${f.tag}_excess`;
    processorRefund.mockResolvedValue({ id: refundId, object: 'refund', status: 'pending', amount: 10000 });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

    // While it is on its way back, the invoice refund door cannot send the same dollars again.
    const twice = await api.post(`/api/invoices/${f.invoice}/refund`).send({ amount: 250, reason_category: 'OTHER', reason: 'Again' });
    expect(twice.status).toBe(400);

    const landed = {
      id: refundId, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded',
      payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
      metadata: { source: 'in_app', unapplied_capture_id: item.id },
    };
    await f.deliver('refund.created', { ...landed, status: 'pending' });
    await f.deliver('refund.updated', landed);
    await f.deliver('refund.updated', landed, `evt_pay11_${f.tag}_again`);

    const { invoice } = (await api.get(`/api/invoices/${f.invoice}`).expect(200)).body;
    expect(invoice.refunds).toHaveLength(1);
    expect(invoice.refunds[0]).toMatchObject({ amount: '100', state: 'SUCCEEDED' });
    // The invoice response never carries a processor id; the stored row holds it, once.
    expect(invoice.refunds[0]).not.toHaveProperty('stripe_refund_id');
    const storedRefunds = await db.refund.findMany({ where: { invoice_id: f.invoice, stripe_refund_id: refundId }, select: { amount: true, state: true } });
    expect(storedRefunds).toHaveLength(1);
    expect(storedRefunds[0]).toMatchObject({ state: 'SUCCEEDED' });
    expect(Number(invoice.total_refunded)).toBe(100);
    expect(Number(invoice.net_collected)).toBe(200);
    expect(invoice.status).toBe('PAID');
    const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice }, select: { amount: true, refunded_amount: true } });
    expect(Number(payment.amount)).toBe(300);
    expect(Number(payment.refunded_amount)).toBe(100);
    expect((await api.get('/api/payments-needing-attention')).body.items[0]).toMatchObject({ id: item.id, status: 'REFUNDED' });
  });

  // Slice 29 fix round 2: an answer that never arrived is not a "no". The refund may exist, so the
  // money held for it stays held and the invoice refund door cannot send the same dollars again.
  it('a list refund whose answer never arrived keeps its money held, so the invoice door cannot send it again', async () => {
    const f = await orgWithInvoice({ total: 300 });
    const bank = bankSession(f);
    await f.deliver('checkout.session.completed', bank());
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 200, status: 'PARTIAL' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;

    processorRefund.mockClear();
    processorRefund.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);

    const held = await db.refund.findMany({ where: { organization_id: f.org, state: 'PENDING', stripe_refund_id: null } });
    expect(held).toHaveLength(1);
    const twice = await api.post(`/api/invoices/${f.invoice}/refund`).send({ amount: 250, reason_category: 'OTHER', reason: 'Again' });
    expect(twice.status).toBe(400);
    expect(processorRefund).toHaveBeenCalledTimes(1);
  });

  // Conductor fix round: a staff refund is told apart from money sent back from the list by a
  // marker on the row, never by the words a person typed as its reason.
  it('a staff refund from the invoice whose reason reads like the list\'s own is counted as a normal refund', async () => {
    const f = await orgWithInvoice({ total: 200 });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    expect((await api.get(`/api/invoices/${f.invoice}`).expect(200)).body.invoice.status).toBe('PAID');
    // The processor takes the refund as pending; its refund.updated settles it, and the invoice's
    // refund totals are re-derived from the rows.
    const staff = {
      id: `re_pay11_${f.tag}_staff`, object: 'refund', amount: 5000, currency: 'usd', status: 'pending',
      payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`, metadata: { source: 'in_app' },
    };
    processorRefund.mockResolvedValue(staff);

    await api.post(`/api/invoices/${f.invoice}/refund`)
      .send({ amount: 50, reason_category: 'OTHER', reason: 'Payment needing attention sent back' })
      .expect(200);
    await f.deliver('refund.updated', { ...staff, status: 'succeeded' });

    const { invoice } = (await api.get(`/api/invoices/${f.invoice}`).expect(200)).body;
    expect(Number(invoice.total_refunded)).toBe(50);
    expect(Number(invoice.net_collected)).toBe(150);
    expect(invoice.status).toBe('PARTIALLY_REFUNDED');
  });

  it('a bank payment that clears on a voided invoice, refunded from the list, comes off that payment once, even when its event lands first', async () => {
    const f = await orgWithInvoice({ total: 300 });
    const bank = bankSession(f);
    await f.deliver('checkout.session.completed', bank());
    // The invoice was voided while the debit cleared: the whole payment needs attention.
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'VOIDED' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(item).toMatchObject({ reason: 'INVOICE_NOT_PAYABLE', amount: 300, can_refund: true });

    const refundId = `re_pay11_${f.tag}_voided`;
    const sent = {
      id: refundId, object: 'refund', amount: 30000, currency: 'usd', status: 'succeeded',
      payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
      metadata: { source: 'in_app', unapplied_capture_id: item.id },
    };
    // The processor answered the refund call slowly: its event landed before the answer did.
    processorRefund.mockImplementation(async () => {
      await f.deliver('refund.created', sent);
      return { id: refundId, object: 'refund', status: 'succeeded', amount: 30000 };
    });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);
    await f.deliver('refund.updated', sent);

    const { invoice } = (await api.get(`/api/invoices/${f.invoice}`).expect(200)).body;
    expect(invoice.refunds).toHaveLength(1);
    expect(invoice.refunds[0]).toMatchObject({ amount: '300', state: 'SUCCEEDED' });
    // The invoice response never carries a processor id; the stored row holds it, once.
    expect(invoice.refunds[0]).not.toHaveProperty('stripe_refund_id');
    const storedRefunds = await db.refund.findMany({ where: { invoice_id: f.invoice, stripe_refund_id: refundId }, select: { amount: true, state: true } });
    expect(storedRefunds).toHaveLength(1);
    expect(storedRefunds[0]).toMatchObject({ state: 'SUCCEEDED' });
    expect(invoice.refunds[0].reason).not.toMatch(/outside/i);
    expect(Number(invoice.total_refunded)).toBe(300);
    expect(Number(invoice.net_collected)).toBe(0);
    expect(invoice.status).toBe('VOIDED');
    const refundRow = await db.refund.findFirstOrThrow({ where: { stripe_refund_id: refundId }, select: { refunded_by: true } });
    // The staff member who clicked Refund is on the row, not the system.
    expect(refundRow.refunded_by).toBe(f.admin.id);
    const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice }, select: { state: true, refunded_amount: true } });
    expect(payment.state).toBe('SUCCEEDED');
    expect(Number(payment.refunded_amount)).toBe(300);
    // Never a refund "made outside ServWave": no such history row.
    expect(await db.timelineEvent.count({ where: { organization_id: f.org, entity_id: f.invoice, event_type: 'INVOICE_REFUNDED' } })).toBe(0);
  });

  // Fix round 2: the excess of an overpayment sits on a payment the invoice refund door can also
  // refund. Whatever already came off that payment comes off the excess first, so the same dollars
  // never go back twice.
  /** A $300 bank payment that cleared on a $200 balance: an OPEN $100 record on its payment. */
  async function overpaidByBank() {
    const f = await orgWithInvoice({ total: 300 });
    const bank = bankSession(f);
    await f.deliver('checkout.session.completed', bank());
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 200, status: 'PARTIAL' } });
    await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(item).toMatchObject({ reason: 'OVERPAYMENT', amount: 100, status: 'OPEN' });
    const payment = await db.payment.findFirstOrThrow({ where: { invoice_id: f.invoice }, select: { id: true } });
    return { f, api, item, paymentId: payment.id };
  }

  it('an excess already sent back from the invoice is not sent back again from the list', async () => {
    const { f, api, item, paymentId } = await overpaidByBank();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_door`, object: 'refund', status: 'pending', amount: 10000 });
    await api.post(`/api/invoices/${f.invoice}/refund`)
      .send({ amount: 100, payment_id: paymentId, reason_category: 'OVERPAYMENT', reason: 'Overpaid' })
      .expect(200);
    processorRefund.mockClear();

    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
    expect(res.body.error).not.toMatch(/stripe/i);
    expect(processorRefund).not.toHaveBeenCalled();
    const { invoice } = (await api.get(`/api/invoices/${f.invoice}`).expect(200)).body;
    expect(invoice.refunds).toHaveLength(1);
  });

  it('when part of the excess was sent back from the invoice, the list sends back only the rest', async () => {
    const { f, api, item, paymentId } = await overpaidByBank();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_door`, object: 'refund', status: 'succeeded', amount: 4000 });
    await api.post(`/api/invoices/${f.invoice}/refund`)
      .send({ amount: 40, payment_id: paymentId, reason_category: 'OVERPAYMENT', reason: 'Overpaid' })
      .expect(200);
    processorRefund.mockReset();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_rest`, object: 'refund', status: 'pending', amount: 6000 });

    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(200);
    expect(processorRefund).toHaveBeenCalledTimes(1);
    expect(processorRefund.mock.calls[0][2]).toBe(6000);
    const rest = await db.refund.findFirstOrThrow({ where: { stripe_refund_id: `re_pay11_${f.tag}_rest` }, select: { amount: true } });
    expect(Number(rest.amount)).toBe(60);
  });

  // Fix round 1: a row nobody can refund (a stray refund) must not sit on the list as "needs
  // attention" for good. A person who dealt with it marks it resolved.
  it('a person with the refund permission marks a stray refund resolved; it stays listed, closed, and only in its own org', async () => {
    const f = await orgWithInvoice({ total: 200 });
    const other = await orgWithInvoice({ total: 80 });
    await f.deliver('refund.created', {
      id: `re_pay11_${f.tag}_stray`, object: 'refund', amount: 4200, currency: 'usd', status: 'succeeded',
      payment_intent: `pi_pay11_${f.tag}_unknown`, charge: `ch_pay11_${f.tag}_unknown`, metadata: {},
    });
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(item).toMatchObject({ kind: 'REFUND', status: 'OPEN', can_refund: false, can_resolve: true });

    // Another org cannot close it, even by id.
    expect((await signedInAs(other.admin).post(`/api/payments-needing-attention/${item.id}/resolve`)).status).toBe(404);
    // A role without the refund permission cannot either.
    const dispatcher = { id: randomUUID(), email: `dispatch-r-${f.tag}@example.test` };
    await db.user.create({
      data: { id: dispatcher.id, organization_id: f.org, email: dispatcher.email, first_name: 'Dee', last_name: 'Spatch', role: 'DISPATCHER' },
    });
    await db.rolePermission.create({ data: { organization_id: f.org, role: 'DISPATCHER', action: 'read', subject: 'Invoice' } });
    clearPermissionCache(f.org);
    expect((await signedInAs(dispatcher).post(`/api/payments-needing-attention/${item.id}/resolve`)).status).toBe(403);
    expect((await api.get('/api/payments-needing-attention')).body.items[0].status).toBe('OPEN');

    const res = await api.post(`/api/payments-needing-attention/${item.id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: item.id, status: 'RESOLVED', can_refund: false, can_resolve: false });
    expect(processorRefund).not.toHaveBeenCalled();
    const after = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: item.id, status: 'RESOLVED' });
    // Closed is closed: a second click changes nothing.
    expect((await api.post(`/api/payments-needing-attention/${item.id}/resolve`)).status).toBe(409);
  });

  it('an open payment dealt with another way can be marked resolved, and is then never sent back', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(item).toMatchObject({ kind: 'PAYMENT', can_refund: true, can_resolve: true });

    const res = await api.post(`/api/payments-needing-attention/${item.id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'RESOLVED', can_refund: false, can_resolve: false });
    // Resolved money is not sent back afterwards by a stale click.
    expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(409);
    expect(processorRefund).not.toHaveBeenCalled();
  });

  // Conductor fix round 3 (security): the refund permission is not the right to see every invoice.
  // A person whose invoices are scoped (their own, attached...) sees and acts only on records whose
  // invoice they can open; a record on the org itself is for people who see every invoice.
  it('a person whose invoices are scoped lists, refunds and resolves only records on invoices they can open', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    const rep = { id: randomUUID(), email: `rep-${f.tag}@example.test` };
    await db.user.create({
      data: { id: rep.id, organization_id: f.org, email: rep.email, first_name: 'Rae', last_name: 'Rep', role: 'SALES' },
    });
    // Which invoices the rep can open is the Invoices scope switch (Attached: invoices on a job they are on
    // the crew of); the refund right itself is the Refund payments switch.
    await setRoleSwitchValues({ organizationId: f.org, roleKey: 'SALES', values: { invoices_scope: 'attached', refund_payments: true, view_payments: true }, actorId: null, reason: 'manual' });
    clearPermissionCache(f.org);
    // The rep's own invoice, voided, paid by card, on a job they are on the crew of.
    const ownInvoice = randomUUID();
    const location = randomUUID();
    const ownJob = randomUUID();
    const ownVisit = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: f.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    await db.job.create({
      data: {
        id: ownJob, organization_id: f.org, customer_id: f.customer, service_location_id: location,
        job_number: `J-${f.tag}-own`, status: 'SCHEDULED',
      },
    });
    await db.visit.create({
      data: {
        id: ownVisit, organization_id: f.org, job_id: ownJob, purpose: 'WORK', visit_seq: 1, status: 'SCHEDULED',
        scheduled_at: new Date(Date.now() + 86_400_000), scheduled_end: new Date(Date.now() + 90_000_000),
      },
    });
    await db.visitAssignee.create({ data: { visit_id: ownVisit, user_id: rep.id, organization_id: f.org } });
    await db.invoice.create({
      data: {
        id: ownInvoice, organization_id: f.org, customer_id: f.customer, invoice_number: `INV-${f.tag}-own`,
        subtotal: 90, tax_amount: 0, total_amount: 90, amount_due: 90, status: 'VOIDED', created_by_id: rep.id, job_id: ownJob,
      },
    });
    await f.deliver('checkout.session.completed', f.session());
    await f.deliver('checkout.session.completed', f.session({
      id: `cs_pay11_${f.tag}_own`, payment_intent: `pi_pay11_${f.tag}_own`, amount_total: 9000, metadata: { invoiceId: ownInvoice },
    }));
    await f.deliver('checkout.session.completed', f.session({
      id: `cs_pay11_${f.tag}_lost`, payment_intent: `pi_pay11_${f.tag}_lost`, amount_total: 4500, metadata: { invoiceId: randomUUID() },
    }));
    const all = (await signedInAs(f.admin).get('/api/payments-needing-attention')).body.items as Array<{ id: string; amount: number; invoice: { id: string } | null }>;
    expect(all).toHaveLength(3);
    const onOther = all.find((i) => i.invoice?.id === f.invoice)!;
    const onOrg = all.find((i) => i.invoice === null)!;
    const onOwn = all.find((i) => i.invoice?.id === ownInvoice)!;

    const rep_ = signedInAs(rep);
    const listed = await rep_.get('/api/payments-needing-attention');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([onOwn.id]);

    for (const hidden of [onOther, onOrg]) {
      expect((await rep_.post(`/api/payments-needing-attention/${hidden.id}/refund`)).status).toBe(403);
      expect((await rep_.post(`/api/payments-needing-attention/${hidden.id}/resolve`)).status).toBe(403);
    }
    expect(processorRefund).not.toHaveBeenCalled();
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(0);
    const afterHidden = (await signedInAs(f.admin).get('/api/payments-needing-attention')).body.items as Array<{ status: string }>;
    expect(afterHidden.map((i) => i.status)).toEqual(['OPEN', 'OPEN', 'OPEN']);

    // Their own invoice's record they can send back.
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_own`, object: 'refund', status: 'succeeded', amount: 9000 });
    const sent = await signedInAs(rep).post(`/api/payments-needing-attention/${onOwn.id}/refund`);
    expect(sent.status).toBe(200);
    expect(sent.body.item).toMatchObject({ id: onOwn.id, status: 'REFUNDED' });
  });

  // Conductor fix round 3 (money): a record that does not say which connected account the money
  // landed in is never refunded from ServWave's own balance. It stays open, and can be resolved.
  it('a payment with no connected account on record is never sent back, stays open, and can be marked resolved', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    // A record written before the account was kept, or from an event that named none.
    await db.unappliedCapture.update({ where: { id: item.id }, data: { stripe_account_id: null } });
    vi.mocked(getStripeForOrg).mockClear();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}`, object: 'refund', status: 'succeeded', amount: 12000 });

    expect((await api.get('/api/payments-needing-attention')).body.items[0]).toMatchObject({ id: item.id, can_refund: false, can_resolve: true });
    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ServWave/);
    expect(res.body.error).not.toMatch(/stripe/i);
    expect(processorRefund).not.toHaveBeenCalled();
    expect(refundsOnProcessor).not.toHaveBeenCalled();
    expect(vi.mocked(getStripeForOrg)).not.toHaveBeenCalled();
    expect((await api.get('/api/payments-needing-attention')).body.items[0]).toMatchObject({ status: 'OPEN' });
    const resolved = await api.post(`/api/payments-needing-attention/${item.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.item.status).toBe('RESOLVED');
  });

  // Conductor fix round 3 (money): "Mark resolved" clicked while a refund is on its way out never
  // hides that the money went back.
  it('a refund that goes out while someone marks the payment resolved is still stored, and the payment reads REFUNDED', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    const refundId = `re_pay11_${f.tag}_race`;
    // The processor answers slowly; meanwhile a second person marks the payment resolved.
    processorRefund.mockImplementation(async () => {
      expect((await api.post(`/api/payments-needing-attention/${item.id}/resolve`)).status).toBe(200);
      return { id: refundId, object: 'refund', status: 'succeeded', amount: 12000 };
    });

    const res = await api.post(`/api/payments-needing-attention/${item.id}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: item.id, status: 'REFUNDED' });
    const row = await db.unappliedCapture.findUniqueOrThrow({ where: { id: item.id }, select: { status: true, stripe_refund_id: true, refunded_at: true } });
    expect(row.status).toBe('REFUNDED');
    expect(row.stripe_refund_id).toBe(refundId);
    expect(row.refunded_at).not.toBeNull();
  });

  // Fix round 1 (money): the refund's own event stores a refund that went out on a record someone
  // marked resolved, the same as the list's own commit does; and its failure lists the money again.
  it('a refund whose answer was lost is stored by its event even after the payment was marked resolved, and its failure reopens it', async () => {
    const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
    await f.deliver('checkout.session.completed', f.session());
    const api = signedInAs(f.admin);
    const [item] = (await api.get('/api/payments-needing-attention')).body.items;
    // The processor made the refund, but answered the call with a server error.
    processorRefund.mockRejectedValueOnce(Object.assign(new Error('api_error'), { statusCode: 500 }));
    expect((await api.post(`/api/payments-needing-attention/${item.id}/refund`)).status).toBe(502);
    // The customer was paid back another way, and the payment marked resolved.
    expect((await api.post(`/api/payments-needing-attention/${item.id}/resolve`)).status).toBe(200);

    await f.deliver('refund.created', attentionRefund(f, item.id, 'succeeded'));

    const refunded = await db.unappliedCapture.findUniqueOrThrow({ where: { id: item.id }, select: { status: true, stripe_refund_id: true, refunded_at: true } });
    expect(refunded).toMatchObject({ status: 'REFUNDED', stripe_refund_id: `re_pay11_${f.tag}` });
    expect(refunded.refunded_at).not.toBeNull();

    // The refund then fails: the money is back in the account, so the payment is listed open again.
    await f.deliver('refund.failed', attentionRefund(f, item.id, 'failed'));
    const [after] = (await api.get('/api/payments-needing-attention')).body.items;
    expect(after).toMatchObject({ id: item.id, status: 'OPEN', can_refund: true, refunded_at: null });
  });

  // Conductor fix round 3 (spec): the excess sent back from the list was never the invoice's money,
  // in the invoice's own totals and when a won dispute puts the invoice back where it was.
  it('a won dispute on a bank overpayment whose excess went back from the list returns the invoice to PAID', async () => {
    const { f, api, item } = await overpaidByBank();
    const refundId = `re_pay11_${f.tag}_excess`;
    processorRefund.mockResolvedValue({ id: refundId, object: 'refund', status: 'pending', amount: 10000 });
    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);
    await f.deliver('refund.updated', {
      id: refundId, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded',
      payment_intent: `pi_pay11_${f.tag}`, charge: `ch_pay11_${f.tag}`,
      metadata: { source: 'in_app', unapplied_capture_id: item.id },
    });
    expect((await api.get(`/api/invoices/${f.invoice}`).expect(200)).body.invoice.status).toBe('PAID');

    const dispute = (status: string) => ({
      id: `dp_pay11_${f.tag}`, object: 'dispute', amount: 20000, currency: 'usd', status,
      reason: 'fraudulent', charge: `ch_pay11_${f.tag}`, payment_intent: `pi_pay11_${f.tag}`,
      evidence_details: { due_by: 1791000000, has_evidence: false, past_due: false, submission_count: 0 },
      is_charge_refundable: false, livemode: false, metadata: {},
    });
    await f.deliver('charge.dispute.created', dispute('needs_response'));
    expect((await api.get(`/api/invoices/${f.invoice}`).expect(200)).body.invoice.status).toBe('DISPUTED');
    await f.deliver('charge.dispute.closed', dispute('won'));

    expect((await api.get(`/api/invoices/${f.invoice}`).expect(200)).body.invoice.status).toBe('PAID');
    // The won dispute's history names the status the invoice went back to: PAID, never a refund
    // status for money that was never the invoice's.
    const [won] = await db.timelineEvent.findMany({
      where: { organization_id: f.org, entity_id: f.invoice, event_type: 'INVOICE_DISPUTE_WON' },
      select: { metadata: true },
    });
    expect(won.metadata).toMatchObject({ restored_status: 'PAID' });
  });

  // Conductor fix round 3 (money): the audit trail says what actually went back.
  it('the audit row of a refund sent from the list logs the amount sent, not the whole record', async () => {
    const { f, api, item, paymentId } = await overpaidByBank();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_door`, object: 'refund', status: 'succeeded', amount: 4000 });
    await api.post(`/api/invoices/${f.invoice}/refund`)
      .send({ amount: 40, payment_id: paymentId, reason_category: 'OVERPAYMENT', reason: 'Overpaid' })
      .expect(200);
    processorRefund.mockReset();
    processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_rest`, object: 'refund', status: 'pending', amount: 6000 });

    await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

    // The audit write is fire-and-forget: wait for it to land.
    let audit: { metadata: unknown } | null = null;
    for (let i = 0; i < 50 && !audit; i++) {
      audit = await db.auditLog.findFirst({ where: { org_id: f.org, action: 'billing.unapplied_capture_refunded' }, select: { metadata: true } });
      if (!audit) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit?.metadata).toMatchObject({ unapplied_capture_id: item.id, amount: 60 });
  });

  // Slice 28b (from the slice 11 review and acceptance): the refund row carries a category that
  // matches why the money was there, and the invoice's own history says it was sent back.
  describe('money sent back from the list, as the invoice\'s history reads it', () => {
    /** A $300 bank payment that cleared onto an invoice voided meanwhile; its record, signed in. */
    async function clearedOntoVoided() {
      const f = await orgWithInvoice({ total: 300 });
      const bank = bankSession(f);
      await f.deliver('checkout.session.completed', bank());
      await db.invoice.update({ where: { id: f.invoice }, data: { status: 'VOIDED' } });
      await f.deliver('checkout.session.async_payment_succeeded', bank({ payment_status: 'paid' }));
      const api = signedInAs(f.admin);
      const [item] = (await api.get('/api/payments-needing-attention')).body.items;
      return { f, api, item };
    }

    it('a debit that cleared onto a voided invoice is not recorded as an overpayment', async () => {
      const { f, api, item } = await clearedOntoVoided();
      processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_cat`, object: 'refund', status: 'succeeded', amount: 30000 });

      await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

      const row = await db.refund.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      expect(row.reason_category).toBe('OTHER');
    });

    it('the excess of a bank overpayment is still recorded as an overpayment', async () => {
      const { f, api, item } = await overpaidByBank();
      processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_over`, object: 'refund', status: 'pending', amount: 10000 });

      await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

      const row = await db.refund.findFirstOrThrow({ where: { invoice_id: f.invoice } });
      expect(row.reason_category).toBe('OVERPAYMENT');
    });

    it('a voided invoice\'s timeline says the money was sent back', async () => {
      const { f, api, item } = await clearedOntoVoided();
      processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_tl`, object: 'refund', status: 'succeeded', amount: 30000 });

      await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

      const rows = await db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: f.invoice, event_type: 'PAYMENT_SENT_BACK' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('$300.00 that could not be recorded on this invoice was sent back to the customer');
    });

    it('a card payment that completed on a voided invoice (no payment row) leaves the same timeline entry', async () => {
      const f = await orgWithInvoice({ total: 120, status: 'VOIDED' });
      await f.deliver('checkout.session.completed', f.session());
      const api = signedInAs(f.admin);
      const [item] = (await api.get('/api/payments-needing-attention')).body.items;
      processorRefund.mockResolvedValue({ id: `re_pay11_${f.tag}_card`, object: 'refund', status: 'succeeded', amount: 12000 });

      await api.post(`/api/payments-needing-attention/${item.id}/refund`).expect(200);

      const rows = await db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: f.invoice, event_type: 'PAYMENT_SENT_BACK' } });
      expect(rows.map((r) => r.description)).toEqual(['$120.00 that could not be recorded on this invoice was sent back to the customer']);
    });
  });
});
