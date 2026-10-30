/* =============================================================================
   V7-09b (C-32) - a partial refund of unapplied money. The item stays OPEN with what is left
   (amount - refunded_amount); the refund's own events count each refund once (a replay, or the staff
   door and the event both reporting it) and never close the item before the whole amount is back.
   Real migrated database (TEST_DATABASE_URL); the processor is faked so it answers a repeated key
   with the same refund and refuses to give back more than was paid. Skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { createRefund, getStripeForOrg, listPaymentIntentRefunds, retrieveCapturePayerDetail } from '../lib/stripe';
import { addCapture, addInvoice, cleanupOrgs, backendPidOf, waitUntilBlockedBy, deliverEvent, fakeProcessor, seedOrg, signedInAs, type Fixture } from './helpers/unapplied-money-fixture';

const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const refundsOnProcessor = listPaymentIntentRefunds as unknown as ReturnType<typeof vi.fn>;
const payerRead = retrieveCapturePayerDetail as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

suite('partial refund of unapplied money (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  let processor: ReturnType<typeof fakeProcessor>;
  let evt = 0;
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  afterAll(async () => {
    await cleanupOrgs(db, orgs);
    await db.$disconnect();
  });
  beforeEach(() => {
    processorRefund.mockReset();
    refundsOnProcessor.mockReset();
    refundsOnProcessor.mockImplementation(async () => processor.refunds().map((r) => ({ ...r, metadata: { unapplied_capture_id: currentCaptureId } })));
    vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: undefined } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  let currentCaptureId = '';
  /** A $120 capture on the org itself, and a processor that holds exactly that much. */
  async function open(amount = 120) {
    const f = await seedOrg(db, orgs);
    const capture = await addCapture(db, f, { amount });
    currentCaptureId = capture.id;
    processor = fakeProcessor(() => amount * 100);
    processorRefund.mockImplementation(processor.create);
    return { f, capture, api: signedInAs(app, f.admin) };
  }
  const row = (id: string) => db.unappliedCapture.findUniqueOrThrow({ where: { id } });
  const refundEvent = (f: Fixture, captureId: string, intent: string, refund: { id: string; amount: number }, status = 'succeeded') =>
    ({ id: refund.id, object: 'refund', amount: refund.amount, currency: 'usd', status, payment_intent: intent, charge: 'ch_x', metadata: { source: 'in_app', unapplied_capture_id: captureId } });

  it('refuses an amount of zero, below zero, not a number or above what is left, with the two sentences, and sends nothing', async () => {
    const { capture, api } = await open(120);
    for (const amount of [0, -5, 'abc']) {
      const res = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Enter an amount above $0.00.');
    }
    const over = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 120.01 });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Enter $120.00 or less.');
    expect(processorRefund).not.toHaveBeenCalled();
    expect((await row(capture.id)).status).toBe('OPEN');
  });

  it('a partial refund leaves the item OPEN with what is left, and sends exactly that amount', async () => {
    const { capture, api } = await open(120);

    const res = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 });

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: capture.id, status: 'OPEN', amount: 80, can_refund: true });
    expect(processorRefund.mock.calls[0][2]).toBe(4000);
    const after = await row(capture.id);
    expect(after).toMatchObject({ status: 'OPEN', stripe_refund_id: null });
    expect(Number(after.refunded_amount)).toBe(40);
    expect(after.counted_refund_ids).toHaveLength(1);
  });

  it('the refund\'s own event for a partial refund does not close the item, and a replay counts nothing twice', async () => {
    const { f, capture, api } = await open(120);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    const sent = processor.refunds()[0];
    const intent = capture.stripe_payment_intent_id as string;

    expect((await deliverEvent(app, f, 'refund.created', refundEvent(f, capture.id, intent, sent), `evt_v709b_${++evt}`)).status).toBe(200);
    expect((await deliverEvent(app, f, 'refund.updated', refundEvent(f, capture.id, intent, sent), `evt_v709b_${++evt}`)).status).toBe(200);
    // The very same delivery again.
    const same = `evt_v709b_${++evt}`;
    await deliverEvent(app, f, 'refund.updated', refundEvent(f, capture.id, intent, sent), same);
    await deliverEvent(app, f, 'refund.updated', refundEvent(f, capture.id, intent, sent), same);

    const after = await row(capture.id);
    expect(after.status).toBe('OPEN');
    expect(Number(after.refunded_amount)).toBe(40);
    expect(after.counted_refund_ids).toEqual([sent.id]);
    // Nothing is written down as a refund made outside ServWave.
    expect(await db.timelineEvent.count({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } })).toBe(0);
  });

  it('a partial refund whose event lands before the staff door stores it is counted once', async () => {
    const { f, capture, api } = await open(120);
    const intent = capture.stripe_payment_intent_id as string;
    // The event wins the race: the processor answered the call slowly.
    const early = { id: 're_v709b_early', amount: 4000 };
    await deliverEvent(app, f, 'refund.created', refundEvent(f, capture.id, intent, early), `evt_v709b_${++evt}`);
    expect(Number((await row(capture.id)).refunded_amount)).toBe(40);

    processorRefund.mockResolvedValueOnce({ id: early.id, object: 'refund', status: 'succeeded', amount: 4000 });
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);

    const after = await row(capture.id);
    expect(Number(after.refunded_amount)).toBe(40);
    expect(after.counted_refund_ids).toEqual([early.id]);
    expect(after.status).toBe('OPEN');
  });

  it('refunding the rest closes the item, and the earlier partial refund is not mistaken for this one', async () => {
    const { capture, api } = await open(120);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);

    const res = await api.post(`/api/payments-needing-attention/${capture.id}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('REFUNDED');
    expect(processorRefund.mock.calls[1][2]).toBe(8000);
    const after = await row(capture.id);
    expect(after.status).toBe('REFUNDED');
    expect(Number(after.refunded_amount)).toBe(120);
    expect(after.counted_refund_ids).toHaveLength(2);
    expect(processor.total(capture.stripe_payment_intent_id as string)).toBe(12000);
  });

  it('a second refund, or an amount equal to what is left, closes the item; the amount left caps the next request', async () => {
    const { capture, api } = await open(120);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 100 }).expect(200);

    const tooMuch = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 20.01 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toBe('Enter $20.00 or less.');

    const exact = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 20 });
    expect(exact.status).toBe(200);
    expect(exact.body.item.status).toBe('REFUNDED');
  });

  it('the idempotency key carries the cents: a double click sends one refund, another amount sends another', async () => {
    const { capture, api } = await open(120);
    // Two clicks at once, same amount: one refund at the processor, one count.
    const [a, b] = await Promise.all([
      api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 30 }),
      api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 30 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(processor.refunds()).toHaveLength(1);
    expect(Number((await row(capture.id)).refunded_amount)).toBe(30);
    const keys = processorRefund.mock.calls.map((c) => c[3]?.idempotencyKey as string);
    expect(keys[0]).toMatch(new RegExp(`^unapplied-capture-refund:${capture.id}:\\d+:3000$`));

    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 25 }).expect(200);
    const last = processorRefund.mock.calls[processorRefund.mock.calls.length - 1][3]?.idempotencyKey as string;
    expect(last).toMatch(/:2500$/);
    expect(last).not.toBe(keys[0]);
    expect(Number((await row(capture.id)).refunded_amount)).toBe(55);
  });

  it('two different refunds at once that together exceed the payment cannot both succeed', async () => {
    const { capture, api } = await open(120);

    const [a, b] = await Promise.all([
      api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 80 }),
      api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 70 }),
    ]);

    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const after = await row(capture.id);
    expect(Number(after.refunded_amount)).toBeLessThanOrEqual(120);
    expect(Number(after.refunded_amount)).toBe(processor.total(capture.stripe_payment_intent_id as string) / 100);
  });

  it('a partial refund that fails puts its amount back on the item', async () => {
    const { f, capture, api } = await open(120);
    processorRefund.mockResolvedValueOnce({ id: 're_v709b_fail', object: 'refund', status: 'pending', amount: 4000 });
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    expect(Number((await row(capture.id)).refunded_amount)).toBe(40);

    await deliverEvent(app, f, 'refund.failed', refundEvent(f, capture.id, capture.stripe_payment_intent_id as string, { id: 're_v709b_fail', amount: 4000 }, 'failed'), `evt_v709b_${++evt}`);

    const after = await row(capture.id);
    expect(after.status).toBe('OPEN');
    expect(Number(after.refunded_amount)).toBe(0);
    expect(after.failed_refund_ids).toEqual(['re_v709b_fail']);
    const detail = await api.get(`/api/payments-needing-attention/${capture.id}`);
    expect(detail.body.amount).toBe(120);
  });

  it('the failure of an earlier partial refund, after later refunds closed the item, hands its cents to a new open item (note 5)', async () => {
    const { f, capture, api } = await open(120);
    processorRefund.mockResolvedValueOnce({ id: 're_v709b_a', object: 'refund', status: 'pending', amount: 4000 });
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    processorRefund.mockResolvedValueOnce({ id: 're_v709b_b', object: 'refund', status: 'succeeded', amount: 8000 });
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`).expect(200);
    expect((await row(capture.id)).status).toBe('REFUNDED');
    const failure = refundEvent(f, capture.id, capture.stripe_payment_intent_id as string, { id: 're_v709b_a', amount: 4000 }, 'failed');

    await deliverEvent(app, f, 'refund.failed', failure, `evt_v709b_${++evt}`);
    await deliverEvent(app, f, 'refund.failed', failure, `evt_v709b_${++evt}`);

    // The closed item keeps only what really went back; the $40 that came back is an open item of its own, once.
    const after = await row(capture.id);
    expect(after.status).toBe('REFUNDED');
    expect(Number(after.amount)).toBe(80);
    expect(Number(after.refunded_amount)).toBe(80);
    const returned = await db.unappliedCapture.findMany({ where: { organization_id: f.org, source_key: { startsWith: 'returned:' } } });
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ status: 'OPEN', stripe_payment_intent_id: capture.stripe_payment_intent_id, stripe_account_id: f.account, invoice_id: null });
    expect(Number(returned[0].amount)).toBe(40);
  });

  describe('a refund that fails after the item was attached (the money is never untracked)', () => {
    async function attachedAfterPartial() {
      const { f, capture, api } = await open(100);
      payerRead.mockResolvedValue({ method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: null });
      processorRefund.mockResolvedValueOnce({ id: 're_v709b_p30', object: 'refund', status: 'pending', amount: 3000 });
      await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 30 }).expect(200);
      const invoice = await addInvoice(db, f, { total: 70 });
      await api.post(`/api/payments-needing-attention/${capture.id}/attach`, { invoice_id: invoice.id }).expect(200);
      const failure = refundEvent(f, capture.id, capture.stripe_payment_intent_id as string, { id: 're_v709b_p30', amount: 3000 }, 'failed');
      return { f, capture, api, invoice, failure };
    }

    it('the returned cents become their own OPEN item: shown, refundable and attachable for exactly that amount, nothing double-bookable', async () => {
      const { f, capture, api, invoice, failure } = await attachedAfterPartial();

      await deliverEvent(app, f, 'refund.failed', failure, `evt_v709b_${++evt}`);

      const parent = await row(capture.id);
      expect(parent.status).toBe('RESOLVED');
      expect(Number(parent.amount)).toBe(70);
      expect(Number(parent.refunded_amount)).toBe(0);
      const [child] = await db.unappliedCapture.findMany({ where: { organization_id: f.org, source_key: `returned:${capture.id}:re_v709b_p30` } });
      expect(child).toMatchObject({ status: 'OPEN', stripe_checkout_session_id: null });
      expect(Number(child.amount)).toBe(30);
      // The office can see and act on it.
      const detail = await api.get(`/api/payments-needing-attention/${child.id}`);
      expect(detail.body.amount).toBe(30);
      expect(detail.body.actions).toEqual(expect.arrayContaining(['attach_to_invoice', 'refund']));
      // The attached item still shows what was booked, and cannot be taken twice.
      const attachedDetail = await api.get(`/api/payments-needing-attention/${capture.id}`);
      expect(attachedDetail.body.amount).toBe(70);
      const other = await addInvoice(db, f, { total: 500 });
      expect((await api.post(`/api/payments-needing-attention/${capture.id}/attach`, { invoice_id: other.id })).status).toBe(409);
      // The returned $30 attaches (to an invoice that owes it) and the two payments add up to the charge, no more.
      const small = await addInvoice(db, f, { total: 30 });
      await api.post(`/api/payments-needing-attention/${child.id}/attach`, { invoice_id: small.id }).expect(200);
      const booked = await db.payment.findMany({ where: { invoice: { organization_id: f.org } } });
      expect(booked.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(100);
      expect(invoice.id).toBeTruthy();
    });

    it('the returned item can be sent back instead, for exactly its amount', async () => {
      const { f, capture, api, failure } = await attachedAfterPartial();
      await deliverEvent(app, f, 'refund.failed', failure, `evt_v709b_${++evt}`);
      const [child] = await db.unappliedCapture.findMany({ where: { organization_id: f.org, source_key: { startsWith: 'returned:' } } });
      processorRefund.mockResolvedValueOnce({ id: 're_v709b_child', object: 'refund', status: 'succeeded', amount: 3000 });

      const res = await api.post(`/api/payments-needing-attention/${child.id}/refund`);

      expect(res.status).toBe(200);
      expect(processorRefund.mock.calls[processorRefund.mock.calls.length - 1][2]).toBe(3000);
      expect((await row(child.id)).status).toBe('REFUNDED');
      expect(capture.id).toBeTruthy();
    });

    it('a replayed failure (the same event again, or another event for the same refund) makes one item, once', async () => {
      const { f, capture, failure } = await attachedAfterPartial();

      const sameEvent = `evt_v709b_${++evt}`;
      await deliverEvent(app, f, 'refund.failed', failure, sameEvent);
      await deliverEvent(app, f, 'refund.failed', failure, sameEvent);
      await deliverEvent(app, f, 'refund.failed', failure, `evt_v709b_${++evt}`);
      await deliverEvent(app, f, 'refund.updated', { ...failure, status: 'succeeded' }, `evt_v709b_${++evt}`);

      const kids = await db.unappliedCapture.findMany({ where: { organization_id: f.org, source_key: { startsWith: 'returned:' } } });
      expect(kids).toHaveLength(1);
      expect(Number(kids[0].amount)).toBe(30);
      const parent = await row(capture.id);
      expect(Number(parent.amount)).toBe(70);
      expect(Number(parent.refunded_amount)).toBe(0);
      expect(parent.status).toBe('RESOLVED');
    });
  });

  it('a partial refund of money that sits on a payment row with a tip sends exactly what was typed', async () => {
    const f = await seedOrg(db, orgs);
    const invoice = await addInvoice(db, f, { total: 100, due: 0, status: 'VOIDED' });
    const payment = await db.payment.create({
      data: { invoice_id: invoice.id, amount: 100, tip_amount: 20, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date() },
    });
    const capture = await addCapture(db, f, { amount: 120, invoiceId: invoice.id, reason: 'INVOICE_NOT_PAYABLE', sourceKey: `payment:${payment.id}` });
    currentCaptureId = capture.id;
    processor = fakeProcessor(() => 12000);
    processorRefund.mockImplementation(processor.create);
    const api = signedInAs(app, f.admin);

    const res = await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 60 });

    expect(res.status).toBe(200);
    expect(processorRefund.mock.calls[0][2]).toBe(6000);
    expect(Number((await row(capture.id)).refunded_amount)).toBe(60);
    expect(res.body.item).toMatchObject({ status: 'OPEN', amount: 60 });
    // The rest goes back whole: tip included, nothing more than was paid.
    const rest = await api.post(`/api/payments-needing-attention/${capture.id}/refund`);
    expect(rest.status).toBe(200);
    expect(processorRefund.mock.calls[1][2]).toBe(6000);
    expect(processor.total(capture.stripe_payment_intent_id as string)).toBe(12000);
  });

  it('a refund claim is only taken on an item that is still OPEN: an attach that commits between the door\'s read and its claim wins', async () => {
    const { capture, api } = await open(120);
    let holderPid = 0;
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A transaction that holds the item (as an attach does) and closes it.
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${capture.id}::uuid FOR UPDATE`;
      holderPid = await backendPidOf(tx);
      locked();
      await gate;
      await tx.unappliedCapture.update({ where: { id: capture.id }, data: { status: 'RESOLVED', resolution_note: 'Attached to INV-1' } });
    }, { timeout: 30_000 });
    await lockedP;

    const pending = api.post(`/api/payments-needing-attention/${capture.id}/refund`).then((r) => r);
    await waitUntilBlockedBy(db, holderPid);
    release();
    await holder;
    const res = await pending;

    expect(res.status).toBe(409);
    expect(processorRefund).not.toHaveBeenCalled();
    expect((await row(capture.id)).refund_started_at).toBeNull();
   }, 60_000);

  it('an open item with nothing left in it cannot be refunded', async () => {
    const { capture, api } = await open(120);
    await db.unappliedCapture.update({ where: { id: capture.id }, data: { refunded_amount: 120 } });

    const res = await api.post(`/api/payments-needing-attention/${capture.id}/refund`);

    expect(res.status).toBe(409);
    expect(processorRefund).not.toHaveBeenCalled();
  });

  it('an item attached or resolved after a partial refund shows what it held, in the list and the detail alike', async () => {
    const { capture, api } = await open(120);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 45 }).expect(200);
    await api.post(`/api/payments-needing-attention/${capture.id}/resolve`).expect(200);

    const detail = await api.get(`/api/payments-needing-attention/${capture.id}`);
    const list = await api.get('/api/payments-page/attention?view=resolved');

    expect(detail.body.amount).toBe(75);
    const listed = (list.body.items as Array<{ key: string; amount: number }>).find((i) => i.key.endsWith(capture.id));
    expect(listed?.amount).toBe(75);
  });

  it('the item reads amount minus what went back in the list and the detail, and nothing is refundable once nothing is left', async () => {
    const { capture, api } = await open(120);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 45.5 }).expect(200);

    const detail = await api.get(`/api/payments-needing-attention/${capture.id}`);
    expect(detail.body.amount).toBe(74.5);
    expect(detail.body.actions).toContain('refund');
    const list = await api.get('/api/payments-page/attention?view=open');
    expect(list.status).toBe(200);
    const listed = (list.body.items as Array<{ key: string; amount: number }>).find((i) => i.key.endsWith(capture.id));
    expect(listed?.amount).toBe(74.5);

    await api.post(`/api/payments-needing-attention/${capture.id}/refund`).expect(200);
    const closed = await api.get(`/api/payments-needing-attention/${capture.id}`);
    expect(closed.body.actions).not.toContain('refund');
    expect(closed.body.status).toBe('resolved');
  });
  it('after a partial refund the suggestions and the Attach search work from what is left (amount - refunded)', async () => {
    const { f, capture, api } = await open(120);
    const exact = await addInvoice(db, f, { total: 80 });
    const less = await addInvoice(db, f, { total: 70 });
    const big = await addInvoice(db, f, { total: 120 });
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);

    const detail = await api.get(`/api/payments-needing-attention/${capture.id}`);
    const suggested = detail.body.suggested_invoices as Array<{ id: string; can_attach: boolean }>;
    // Owes exactly what is left: suggested and attachable. The $120 invoice is not "the same amount" any more.
    expect(suggested.map((s) => s.id)).toEqual([exact.id]);
    expect(suggested[0].can_attach).toBe(true);

    const search = await api.get(`/api/payments-needing-attention/${capture.id}/invoices`);
    const byId = Object.fromEntries((search.body.items as Array<{ id: string; can_attach: boolean }>).map((r) => [r.id, r.can_attach]));
    expect(byId).toMatchObject({ [exact.id]: true, [big.id]: true, [less.id]: false });
  });
});
