/* =============================================================================
   V7-09b (BE-10, C-33, C-34) - attach unapplied money to an invoice. Real migrated database
   (TEST_DATABASE_URL), real routes, a real role; only the processor and the identity provider are
   faked. Skips when unset.

   The rule under test: the whole amount still on the item goes on the invoice, or nothing is written.
   An invoice that owes less than the payment is refused (no overpaid invoices), two attaches of one item
   book once, and an attach never runs alongside a refund of the same money.
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

import { createRefund, getStripeForOrg, listPaymentIntentRefunds, retrieveCapturePayerDetail } from '../lib/stripe';
import { sendPaymentReceivedEmail } from '../lib/email';
import { addCapture, addInvoice, cleanupOrgs, backendPidOf, waitUntilBlockedBy, fakeProcessor, seedOrg, signedInAs } from './helpers/unapplied-money-fixture';

const suite = realClient ? describe : describe.skip;
const payerRead = retrieveCapturePayerDetail as unknown as ReturnType<typeof vi.fn>;
const processorRefund = createRefund as unknown as ReturnType<typeof vi.fn>;
const refundsOnProcessor = listPaymentIntentRefunds as unknown as ReturnType<typeof vi.fn>;
const receipt = sendPaymentReceivedEmail as unknown as ReturnType<typeof vi.fn>;

const VISA = { method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: null };

suite('attach unapplied money to an invoice (real database)', () => {
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
    payerRead.mockResolvedValue(VISA);
    processorRefund.mockReset();
    refundsOnProcessor.mockReset();
    refundsOnProcessor.mockResolvedValue([]);
    receipt.mockClear();
    vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: undefined } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  const attach = (api: ReturnType<typeof signedInAs>, captureId: string, invoiceId: string) =>
    api.post(`/api/payments-needing-attention/${captureId}/attach`, { invoice_id: invoiceId });
  const invoiceRow = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });
  const capRow = (id: string) => db.unappliedCapture.findUniqueOrThrow({ where: { id } });

  async function setup(opts: { capture?: number; invoiceTotal?: number; invoiceDue?: number; reason?: string } = {}) {
    const f = await seedOrg(db, orgs);
    const invoice = await addInvoice(db, f, { total: opts.invoiceTotal ?? 200, due: opts.invoiceDue });
    const capture = await addCapture(db, f, { amount: opts.capture ?? 120, reason: opts.reason });
    return { f, invoice, capture, api: signedInAs(app, f.admin) };
  }

  it('a payment the same as the balance is booked whole: invoice PAID, payment row with the method read from the processor, item RESOLVED', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 120 });

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: capture.id, status: 'RESOLVED' });
    expect(res.body.invoice).toMatchObject({ id: invoice.id, status: 'PAID' });
    const inv = await invoiceRow(invoice.id);
    expect(inv.status).toBe('PAID');
    expect(Number(inv.amount_due)).toBe(0);
    const payments = await db.payment.findMany({ where: { invoice_id: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'CARD', state: 'SUCCEEDED', card_brand: 'visa', card_last4: '4242', stripe_payment_intent_id: capture.stripe_payment_intent_id });
    expect(Number(payments[0].amount)).toBe(120);
    expect(payerRead).toHaveBeenCalledWith(f.account, capture.stripe_payment_intent_id);
    const after = await capRow(capture.id);
    expect(after).toMatchObject({ status: 'RESOLVED', resolution_note: `Attached to ${invoice.number}`, resolved_by: f.admin.id, resolved_by_name: 'Test Admin' });
    expect(after.resolved_at).toBeInstanceOf(Date);
    const history = await db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: invoice.id }, select: { event_type: true, description: true } });
    expect(history.map((h) => h.event_type)).toEqual(expect.arrayContaining(['PAYMENT_RECEIVED', 'PAYMENT_ATTACHED', 'INVOICE_PAID']));
    expect(history.find((h) => h.event_type === 'PAYMENT_ATTACHED')?.description).toContain('Test Admin');
    expect(await db.auditLog.count({ where: { org_id: f.org, action: 'billing.unapplied_capture_attached' } })).toBe(1);
  });

  it('a payment smaller than the balance leaves the invoice PARTIAL with the rest due', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 200 });

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('PARTIAL');
    const inv = await invoiceRow(invoice.id);
    expect(inv.status).toBe('PARTIAL');
    expect(Number(inv.amount_due)).toBe(80);
  });

  it('the customer gets the normal receipt for that invoice (C-34)', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 120 });

    await attach(api, capture.id, invoice.id).expect(200);

    await vi.waitFor(() => expect(receipt).toHaveBeenCalledTimes(1));
    expect(receipt.mock.calls[0][0]).toMatchObject({ invoiceNumber: invoice.number, amount: 120, method: 'CARD', newBalance: 0 });
  });

  it('a payment larger than the balance is refused 409 INVOICE_BALANCE_BELOW_PAYMENT and nothing is written', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 100 });

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVOICE_BALANCE_BELOW_PAYMENT', error: `Only $100.00 is due on ${invoice.number}, less than this $120.00 payment.` });
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    const inv = await invoiceRow(invoice.id);
    expect(Number(inv.amount_due)).toBe(100);
    expect(inv.status).toBe('SENT');
    expect(await capRow(capture.id)).toMatchObject({ status: 'OPEN', resolution_note: null });
    expect(await db.auditLog.count({ where: { org_id: f.org, action: 'billing.unapplied_capture_attached' } })).toBe(0);
    expect(receipt).not.toHaveBeenCalled();
  });

  it('a balance lowered between the dialog opening and the confirm refuses the attach', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 200 });
    // Someone records a hand payment in the meantime: the balance is now 50.
    await db.invoice.update({ where: { id: invoice.id }, data: { amount_due: 50, status: 'PARTIAL' } });

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_BALANCE_BELOW_PAYMENT');
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('the balance is read under the invoice lock: a payment recorded while the attach waits for it is seen, not overwritten', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 200 });
    let holderPid = 0;
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Someone holds the invoice and lowers its balance to 50 (as a hand payment does), committing after the attach has started.
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid FOR UPDATE`;
      holderPid = await backendPidOf(tx);
      locked();
      await gate;
      await tx.invoice.update({ where: { id: invoice.id }, data: { amount_due: 50, status: 'PARTIAL' } });
    }, { timeout: 30_000 });
    await lockedP;

    const pending = attach(api, capture.id, invoice.id).then((r) => r);
    await waitUntilBlockedBy(db, holderPid);
    release();
    await holder;
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_BALANCE_BELOW_PAYMENT');
    expect(res.body.error).toBe(`Only $50.00 is due on ${invoice.number}, less than this $120.00 payment.`);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    expect(Number((await invoiceRow(invoice.id)).amount_due)).toBe(50);
   }, 60_000);

  it('an item attached after a partial refund shows what was booked, not the original amount', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 80 });
    const processor = fakeProcessor(() => 12000);
    processorRefund.mockImplementation(processor.create);
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    await attach(api, capture.id, invoice.id).expect(200);

    const detail = await api.get(`/api/payments-needing-attention/${capture.id}`);

    expect(detail.body.amount).toBe(80);
    expect(detail.body.status).toBe('resolved');
    const list = await api.get('/api/payments-page/attention?view=resolved');
    expect((list.body.items as Array<{ key: string; amount: number }>).find((i) => i.key.endsWith(capture.id))?.amount).toBe(80);
  });

  it('a bank debit still clearing on the invoice counts against what it can take now', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 150 });
    await db.payment.create({ data: { invoice_id: invoice.id, amount: 100, method: 'ACH', state: 'PROCESSING', paid_at: new Date() } });

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_BALANCE_BELOW_PAYMENT');
    expect(res.body.error).toBe(`Only $50.00 is due on ${invoice.number}, less than this $120.00 payment.`);
  });

  it('two attaches of one item at once book once: one wins, the other is refused, one payment row', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    const second = await addInvoice(db, f, { total: 500 });

    const [a, b] = await Promise.all([attach(api, capture.id, invoice.id), attach(api, capture.id, second.id)]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toBe('This payment was already attached, refunded or resolved.');
    const rows = await db.payment.findMany({ where: { invoice: { organization_id: f.org } } });
    expect(rows).toHaveLength(1);
    expect(Number((await invoiceRow(rows[0].invoice_id)).amount_due)).toBe(380);
  });

  it('a double click on the same invoice books once', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });

    const [a, b] = await Promise.all([attach(api, capture.id, invoice.id), attach(api, capture.id, invoice.id)]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(1);
    expect(Number((await invoiceRow(invoice.id)).amount_due)).toBe(380);
  });

  it('an attach and a refund of the same money at once: only one of them takes it', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    const processor = fakeProcessor(() => 12000);
    processorRefund.mockImplementation(processor.create);

    const [a, r] = await Promise.all([
      attach(api, capture.id, invoice.id),
      api.post(`/api/payments-needing-attention/${capture.id}/refund`),
    ]);

    // Exactly one door won. Either the money is on the invoice and nothing went back, or it went back and the invoice is untouched.
    const payments = await db.payment.count({ where: { invoice: { organization_id: f.org } } });
    const refunded = processor.refunds().length;
    expect(payments + refunded).toBe(1);
    if (payments === 1) expect([a.status, r.status]).toEqual([200, 409]);
    else expect([a.status, r.status]).toEqual([409, 200]);
  });

  it('an attach waits while a refund of the item is on its way out', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    await db.$executeRaw`UPDATE unapplied_captures SET refund_started_at = now() WHERE id = ${capture.id}::uuid`;

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_IN_PROGRESS');
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);

    // A claim that went stale (nothing cleared it) no longer holds the item.
    await db.$executeRaw`UPDATE unapplied_captures SET refund_started_at = now() - interval '10 minutes' WHERE id = ${capture.id}::uuid`;
    expect((await attach(api, capture.id, invoice.id)).status).toBe(200);
  });

  it('a refund of this money at the processor that the item has not counted refuses the attach, however old (lost answer)', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    // Sent long ago, its answer lost, its event not landed: the claim has expired, the processor still knows it.
    await db.$executeRaw`UPDATE unapplied_captures SET refund_started_at = now() - interval '1 hour' WHERE id = ${capture.id}::uuid`;
    refundsOnProcessor.mockResolvedValue([{ id: 're_v709b_lost', status: 'succeeded', amount: 5000, metadata: { unapplied_capture_id: capture.id } }]);

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_IN_PROGRESS');
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
    // A refund that failed or was cancelled sent nothing back and does not hold the item.
    refundsOnProcessor.mockResolvedValue([{ id: 're_v709b_failed', status: 'failed', amount: 5000, metadata: {} }, { id: 're_v709b_cx', status: 'canceled', amount: 1, metadata: {} }]);
    expect((await attach(api, capture.id, invoice.id)).status).toBe(200);
  });

  it('refunds the item has counted do not hold it; a processor read that fails refuses the attach and books nothing', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 80 });
    const processor = fakeProcessor(() => 12000);
    processorRefund.mockImplementation(processor.create);
    refundsOnProcessor.mockImplementation(async () => processor.refunds().map((r) => ({ ...r, metadata: { unapplied_capture_id: capture.id } })));
    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    refundsOnProcessor.mockRejectedValueOnce(new Error('processor down'));

    const down = await attach(api, capture.id, invoice.id);
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('PAYER_UNAVAILABLE');
    expect(JSON.stringify(down.body)).not.toMatch(/processor down|stripe|acct_|pi_/i);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);

    expect((await attach(api, capture.id, invoice.id)).status).toBe(200);
  });

  it('refund the extra, then attach the remainder: the invoice ends PAID, never over', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 80 });
    const processor = fakeProcessor(() => 12000);
    processorRefund.mockImplementation(processor.create);
    // The first attempt is refused: 120 does not fit on an 80 invoice.
    expect((await attach(api, capture.id, invoice.id)).body.code).toBe('INVOICE_BALANCE_BELOW_PAYMENT');

    await api.post(`/api/payments-needing-attention/${capture.id}/refund`, { amount: 40 }).expect(200);
    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(200);
    const inv = await invoiceRow(invoice.id);
    expect(inv.status).toBe('PAID');
    expect(Number(inv.amount_due)).toBe(0);
    const payments = await db.payment.findMany({ where: { invoice_id: invoice.id } });
    expect(payments.map((p) => Number(p.amount))).toEqual([80]);
    expect(processor.total(capture.stripe_payment_intent_id as string)).toBe(4000);
    expect(f.org).toBeTruthy();
  });

  it('another company\'s invoice, or an unknown one, is not found and nothing changes', async () => {
    const { capture, api } = await setup({ capture: 120 });
    const other = await seedOrg(db, orgs);
    const theirs = await addInvoice(db, other, { total: 500 });

    const res = await attach(api, capture.id, theirs.id);
    expect(res.status).toBe(404);
    expect((await attach(api, capture.id, randomUUID())).status).toBe(404);
    expect((await invoiceRow(theirs.id)).status).toBe('SENT');
    expect(await db.payment.count({ where: { invoice_id: theirs.id } })).toBe(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('another company\'s item is not found', async () => {
    const { invoice } = await setup({ capture: 120 });
    const other = await seedOrg(db, orgs);
    const theirs = await addCapture(db, other, { amount: 50 });

    const res = await attach(signedInAs(app, other.admin), theirs.id, invoice.id);

    expect(res.status).toBe(404);
    expect((await capRow(theirs.id)).status).toBe('OPEN');
  });

  it('an item already resolved, refunded or attached is refused 409', async () => {
    const { f, invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    await db.unappliedCapture.update({ where: { id: capture.id }, data: { status: 'RESOLVED' } });
    expect((await attach(api, capture.id, invoice.id)).status).toBe(409);
    const refunded = await addCapture(db, f, { amount: 20, status: 'REFUNDED' });
    expect((await attach(api, refunded.id, invoice.id)).status).toBe(409);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
  });

  it('money that already sits on a payment row (a payment: key) is refused and not offered the action (C-34)', async () => {
    const { f, invoice, api } = await setup({ capture: 120, invoiceTotal: 500 });
    const onRow = await addCapture(db, f, { amount: 30, sourceKey: `payment:${randomUUID()}`, reason: 'OVERPAYMENT' });

    const res = await attach(api, onRow.id, invoice.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_PAYMENT_ROW');
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    const detail = await api.get(`/api/payments-needing-attention/${onRow.id}`);
    expect(detail.body.actions).not.toContain('attach_to_invoice');
  });

  it('a deposit invoice is not an attach target (C-34)', async () => {
    const f = await seedOrg(db, orgs);
    const deposit = await addInvoice(db, f, { total: 500, kind: 'DEPOSIT' });
    const capture = await addCapture(db, f, { amount: 120 });

    const res = await attach(signedInAs(app, f.admin), capture.id, deposit.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_IS_DEPOSIT');
    expect(await db.payment.count({ where: { invoice_id: deposit.id } })).toBe(0);
  });

  it('a voided or already paid invoice is not payable', async () => {
    const f = await seedOrg(db, orgs);
    const voided = await addInvoice(db, f, { total: 500, status: 'VOIDED' });
    const paid = await addInvoice(db, f, { total: 500, due: 0, status: 'PAID' });
    const capture = await addCapture(db, f, { amount: 120 });
    const api = signedInAs(app, f.admin);

    expect((await attach(api, capture.id, voided.id)).body.code).toBe('INVOICE_NOT_PAYABLE');
    expect((await attach(api, capture.id, paid.id)).body.code).toBe('INVOICE_NOT_PAYABLE');
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('a payer read that fails refuses the attach and writes nothing; no guessed method is booked', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 500 });
    payerRead.mockResolvedValue(null);

    const res = await attach(api, capture.id, invoice.id);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PAYER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/stripe|pi_|acct_/i);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('a bank payment is booked as a bank payment with its bank and last four', async () => {
    const { invoice, capture, api } = await setup({ capture: 120, invoiceTotal: 120 });
    payerRead.mockResolvedValue({ method: 'bank', brand: null, last4: '6789', bank_name: 'Test Bank', description: null });

    await attach(api, capture.id, invoice.id).expect(200);

    const [payment] = await db.payment.findMany({ where: { invoice_id: invoice.id } });
    expect(payment).toMatchObject({ method: 'ACH', state: 'SUCCEEDED', bank_name: 'Test Bank', bank_last4: '6789', card_brand: null });
  });

  it('the attach needs the refund permission; a person who can only view payments reads the item but cannot attach it (C-29)', async () => {
    const { f, invoice, capture } = await setup({ capture: 120, invoiceTotal: 500 });
    const viewer = { id: randomUUID(), email: `viewer-${f.tag}@example.test` };
    await db.user.create({ data: { id: viewer.id, organization_id: f.org, email: viewer.email, first_name: 'View', last_name: 'Only', role: 'TECHNICIAN' } });
    const api = signedInAs(app, viewer);

    const res = await attach(api, capture.id, invoice.id);

    expect([401, 403]).toContain(res.status);
    expect(await db.payment.count({ where: { invoice_id: invoice.id } })).toBe(0);
    expect((await capRow(capture.id)).status).toBe('OPEN');
  });

  it('a body without an invoice is a 400 "Choose an invoice."', async () => {
    const { capture, api } = await setup({ capture: 120 });

    const res = await api.post(`/api/payments-needing-attention/${capture.id}/attach`, {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Choose an invoice.');
  });

  describe('a stray refund (refund kind)', () => {
    async function withRefund(opts: { paid?: number; refund?: number; voided?: boolean } = {}) {
      const f = await seedOrg(db, orgs);
      const invoice = await addInvoice(db, f, { total: 200, due: 0, status: opts.voided ? 'VOIDED' : 'PAID' });
      await db.payment.create({ data: { invoice_id: invoice.id, amount: opts.paid ?? 200, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date() } });
      const refundId = `re_v709b_${randomUUID().slice(0, 8)}`;
      const capture = await addCapture(db, f, { amount: opts.refund ?? 50, reason: 'REFUND_UNMATCHED', sourceKey: `refund:${refundId}` });
      await db.unappliedCapture.update({ where: { id: capture.id }, data: { stripe_refund_id: refundId } });
      return { f, invoice, capture, refundId, api: signedInAs(app, f.admin) };
    }

    it('is recorded against the invoice\'s payment that has enough left, and the item is resolved', async () => {
      const { invoice, capture, refundId, api } = await withRefund({ paid: 200, refund: 50 });

      const res = await attach(api, capture.id, invoice.id);

      expect(res.status).toBe(200);
      expect(res.body.item.status).toBe('RESOLVED');
      const refunds = await db.refund.findMany({ where: { invoice_id: invoice.id } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ state: 'SUCCEEDED', stripe_refund_id: refundId });
      expect(Number(refunds[0].amount)).toBe(50);
      expect((await capRow(capture.id)).resolution_note).toBe(`Attached to ${invoice.number}`);
    });

    it('is refused when no payment on the invoice has that much left to give back', async () => {
      const { invoice, capture, api } = await withRefund({ paid: 40, refund: 50 });

      const res = await attach(api, capture.id, invoice.id);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_PAYMENT_FOR_REFUND');
      expect(await db.refund.count({ where: { invoice_id: invoice.id } })).toBe(0);
      expect((await capRow(capture.id)).status).toBe('OPEN');
    });

    it('is never recorded on a voided invoice, and a second attach records nothing twice', async () => {
      const voided = await withRefund({ voided: true });
      expect((await attach(voided.api, voided.capture.id, voided.invoice.id)).status).toBe(409);
      expect(await db.refund.count({ where: { invoice_id: voided.invoice.id } })).toBe(0);

      const ok = await withRefund({ paid: 200, refund: 50 });
      await attach(ok.api, ok.capture.id, ok.invoice.id).expect(200);
      expect((await attach(ok.api, ok.capture.id, ok.invoice.id)).status).toBe(409);
      expect(await db.refund.count({ where: { invoice_id: ok.invoice.id } })).toBe(1);
    });
  });
});
