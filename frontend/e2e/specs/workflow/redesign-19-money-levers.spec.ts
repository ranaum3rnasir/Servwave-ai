import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createSalesUser,
  scheduleJobOnly,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 9 — Money levers §8 (Task C9, rows MON-01..MON-22).
 *
 * Facts: md_files/plans/entity-redesign/facts/invoice-payment-money.json
 *
 * Endpoints under test (all on /api/invoices/:id):
 *   POST /refund        → { success:true, refund }            (NOT the invoice — re-GET)
 *   POST /credit        → { invoice }                          (credit uses `category`, not reason_category)
 *   POST /void-payment  → { invoice }                          (payment_id + void_category + reason)
 *   POST /void          → { invoice }                          (voided_reason)
 *   GET  /statements/job/:jobId                                (lines[] + totals)
 *   POST /api/test/stripe-webhook + /api/test/seed-payment-intent  (charge.refunded / disputes)
 *
 * Response-shape traps (contract §5):
 *   - refundInvoice does NOT return the invoice → re-GET api.getInvoice(id).
 *   - Field is `subtotal`/`tax_amount`/`amount_due`; payments[] keeps voided rows (voided_at set)
 *     and includes the synthetic DEPOSIT-CREDIT payment.
 *
 * Request-body traps:
 *   - refund  { amount?, payment_id?, reason, reason_category(enum) }
 *   - credit  { amount, reason, category?, refund_instead? }   (category is a free string)
 *   - voidPayment { payment_id, void_category(BOUNCED|ERROR|DUPLICATE|WRONG_INVOICE), reason }
 *
 * ONE shared org, serial — data accumulates. All seeded entities are unique via api.suffix;
 * never assert absolute list/stat counts. After every money mutation: assertInvoiceReconciles.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Local seeding helpers (documented ApiClient surface only) ───────────────

/**
 * Build a MA taxable estimate (sent, with deposit), pay the deposit by CHECK, drive the
 * job to COMPLETED, and spawn the STANDARD invoice (snapshots lines + draws the deposit
 * credit). Returns the deposit + estimate + job context plus the (re-GET'd) STANDARD invoice.
 *
 * Worked example for (100000, 30): subtotal 100000, tax 6250, total 106250,
 * deposit_credit 31875, amount_due 74375.
 */
async function seedStandardInvoiceFromDeposit(amount: number, depositPct: number) {
  const ctx = await maEstimateSentWithDeposit(api, amount, depositPct);
  const dep = await api.getDepositInvoice(ctx.estimateId);
  await api.markDepositReceived(ctx.estimateId, {
    payment_method: 'CHECK', amount: Number(dep.total_amount),
  });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id as string;
  await scheduleJobOnly(api, jobId);
  await api.startJob(jobId);
  await api.completeJob(jobId, `MON seed completion ${api.suffix}`);
  const { body: invBody } = await api.createInvoice(jobId);
  const invoice = await api.getInvoice(invBody.invoice.id);
  return { ...ctx, jobId, depositInvoice: dep, invoice, invoiceId: invoice.id as string };
}

/**
 * Build a SENT MA standard invoice with a deterministic balance, WITHOUT any deposit
 * (so amount_due == total_amount). Used by the refund/credit/void rows that need a clean,
 * fully-controlled payable invoice. Goes through the walkthrough gate by hand.
 */
async function seedSentStandardNoDeposit(amount: number) {
  const { customerId, locationId } = await createMaCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `mon-${api.suffix}`, service_location_id: locationId,
  });
  const leadId = leadBody.lead.id as string;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'Full job', quantity: 1, unit_price: amount, is_taxable: true }],
  });
  const estimateId = estBody.estimate.id as string;
  const { body: sentBody } = await api.sendEstimate(estimateId, {
    deposit_required: false, payment_methods: ['CHECK', 'CASH', 'CARD'],
  });
  await api.approveEstimatePublic(estimateId, sentBody.estimate.public_token, {
    signature_data: api.testSignature,
  });
  const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
  const jobId = jobBody.job.id as string;
  await scheduleJobOnly(api, jobId);
  await api.startJob(jobId);
  await api.completeJob(jobId, `MON no-deposit completion ${api.suffix}`);
  const { body: invBody } = await api.createInvoice(jobId);
  const invoiceId = invBody.invoice.id as string;
  await api.sendInvoice(invoiceId);
  const invoice = await api.getInvoice(invoiceId);
  return { customerId, locationId, leadId, estimateId, jobId, invoiceId, invoice };
}

/** Seed a SENT no-deposit invoice and pay it in FULL by a manual method (default CHECK). */
async function seedPaidByManual(amount: number, method = 'CHECK') {
  const seed = await seedSentStandardNoDeposit(amount);
  const due = Number(seed.invoice.amount_due);
  expect(due, 'seed invoice must have a positive balance').toBeGreaterThan(0);
  const { res, body } = await api.recordPayment(seed.invoiceId, { amount: due, method });
  expect(res.status()).toBe(201);
  expect(body.invoice.status).toBe('PAID');
  return { ...seed, paidAmount: due, invoice: await api.getInvoice(seed.invoiceId) };
}

/**
 * Seed a SENT no-deposit invoice and pay it in FULL via the Stripe webhook door, producing a
 * CARD Payment carrying a known stripe_payment_intent_id (for charge.refunded / dispute rows).
 * Returns the invoice + the PI.
 */
async function seedPaidByCardWebhook(amount: number) {
  const seed = await seedSentStandardNoDeposit(amount);
  const due = Number(seed.invoice.amount_due);
  expect(due).toBeGreaterThan(0);
  const pi = `pi_mon_${api.suffix}`;
  const ev = api.depositPaidEvent(seed.invoiceId, api.checkoutCents(due), {
    eventId: `evt_mon_pay_${api.suffix}`, paymentIntent: pi,
  });
  const fired = await api.fireStripeEvent(ev);
  expect(fired.body.received).toBe(true);
  const invoice = await api.getInvoice(seed.invoiceId);
  expect(invoice.status).toBe('PAID');
  // The webhook records a CARD payment carrying the PI; confirm it is present.
  const cardPay = (invoice.payments ?? []).find((p: any) => p.stripe_payment_intent_id === pi);
  expect(cardPay, 'card payment with the seeded PI exists').toBeTruthy();
  return { ...seed, paidAmount: due, pi, cardPaymentId: cardPay.id as string, invoice };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

test.describe('Stage 9 — Money levers §8 (MON-01..MON-22)', () => {
  // ─── Refund (MON-01..MON-09) ───────────────────────────────────────────────

  test('MON-01: partial refund → PARTIALLY_REFUNDED, amount_due unchanged', async () => {
    const seed = await seedPaidByManual(1000, 'CHECK');
    const beforeDue = Number(seed.invoice.amount_due); // 0 (paid in full)
    const part = round2(seed.paidAmount / 2);

    const { res } = await api.refundInvoice(seed.invoiceId, {
      amount: part, reason: 'partial refund', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(res.status()).toBe(200);

    const inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('PARTIALLY_REFUNDED');
    expect((inv.refunds ?? []).length).toBe(1);
    expect(Number(inv.refunds[0].amount)).toBe(part);
    // A refund NEVER reopens amount_due.
    expect(Number(inv.amount_due)).toBe(beforeDue);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-01');
  });

  test('MON-02: full refund → REFUNDED', async () => {
    const seed = await seedPaidByManual(900, 'CHECK');
    // Omit amount → defaults to the full net-paid.
    const { res } = await api.refundInvoice(seed.invoiceId, {
      reason: 'full refund', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(res.status()).toBe(200);

    const inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('REFUNDED');
    const refunded = (inv.refunds ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    expect(round2(refunded)).toBe(seed.paidAmount);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-02');
  });

  test('MON-03: refund > net-paid → 400 "Refund exceeds net paid"', async () => {
    const seed = await seedPaidByManual(700, 'CHECK');
    const { res, body } = await api.refundInvoice(seed.invoiceId, {
      amount: round2(seed.paidAmount + 1), reason: 'too much', reason_category: 'ERROR',
    });
    expect(res.status()).toBe(400);
    expect(String(body.error)).toMatch(/exceeds net paid/i);
    // Nothing changed.
    const inv = await api.getInvoice(seed.invoiceId);
    expect((inv.refunds ?? []).length).toBe(0);
    expect(inv.status).toBe('PAID');
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-03');
  });

  test('MON-04: per-payment cap with payment_id', async () => {
    // Two manual payments on one invoice → refund capped at the named payment's balance.
    const seed = await seedSentStandardNoDeposit(1000);
    const due = Number(seed.invoice.amount_due);
    const p1 = round2(due * 0.4);
    const p2 = round2(due - p1);
    const { body: b1 } = await api.recordPayment(seed.invoiceId, { amount: p1, method: 'CHECK' });
    expect(b1.invoice.status).toBe('PARTIAL');
    const { body: b2 } = await api.recordPayment(seed.invoiceId, { amount: p2, method: 'CASH' });
    expect(b2.invoice.status).toBe('PAID');

    const inv0 = await api.getInvoice(seed.invoiceId);
    const pay1 = (inv0.payments ?? []).find((p: any) => Number(p.amount) === p1 && !p.voided_at);
    expect(pay1, 'first payment present').toBeTruthy();

    // Over the named payment's balance → 400 'Refund exceeds payment balance'.
    const { res: overRes, body: overBody } = await api.refundInvoice(seed.invoiceId, {
      payment_id: pay1.id, amount: round2(p1 + 1),
      reason: 'over-payment-cap', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(overRes.status()).toBe(400);
    expect(String(overBody.error)).toMatch(/exceeds payment balance/i);

    // Within the named payment's balance → 200.
    const { res: okRes } = await api.refundInvoice(seed.invoiceId, {
      payment_id: pay1.id, amount: p1,
      reason: 'within-cap', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(okRes.status()).toBe(200);
    const inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('PARTIALLY_REFUNDED');
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-04');
  });

  test('MON-05: refund tax_portion is the proportional share', async () => {
    // MA total 1062.5 (subtotal 1000, tax 62.5). Refund a partial and check the tax slice.
    const seed = await seedPaidByManual(1000, 'CHECK');
    const inv0 = await api.getInvoice(seed.invoiceId);
    const total = Number(inv0.total_amount);
    const tax = Number(inv0.tax_amount);
    expect(tax).toBeGreaterThan(0);

    const amount = round2(total / 4);
    const { res, body } = await api.refundInvoice(seed.invoiceId, {
      amount, reason: 'partial w/ tax', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(res.status()).toBe(200);
    const expectedTax = round2(amount * tax / total);
    expect(round2(Number(body.refund.tax_portion))).toBe(expectedTax);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-05');
  });

  test('MON-06: non_taxable_concession → $0 tax_portion', async () => {
    const seed = await seedPaidByManual(1000, 'CHECK');
    const inv0 = await api.getInvoice(seed.invoiceId);
    const amount = round2(Number(inv0.total_amount) / 4);
    const { res, body } = await api.refundInvoice(seed.invoiceId, {
      amount, non_taxable_concession: true,
      reason: 'concession', reason_category: 'GOODWILL',
    });
    expect(res.status()).toBe(200);
    expect(Number(body.refund.tax_portion)).toBe(0);
    expect(body.refund.non_taxable_concession).toBe(true);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-06');
  });

  test('MON-07: in-app refund idempotency — charge.refunded replay does NOT double-record', async () => {
    // The pure in-app double-POST is capped by netPaid (not stripe_refund_id), so we exercise the
    // determinable idempotency: a charge.refunded webhook carrying the SAME stripe_refund_id as an
    // existing in-app Refund records the event only (existingRefund guard, webhook.controller:431).
    // NOTE: in-app refund of a CARD/PI payment calls the REAL Stripe createRefund. Against the test
    // org (no live Stripe), that 500s — so we record the Refund via the dashboard webhook path first,
    // then replay with the same refund id and assert no second Refund row is written. (humanCheck:
    // the original "in-app re_ replay" intent depends on a stubbed Stripe createRefund.)
    const seed = await seedPaidByCardWebhook(800);
    const stripeRefundId = `re_mon07_${api.suffix}`;
    const refundCents = Math.round(seed.paidAmount * 100);

    // First charge.refunded (dashboard-origin) creates the Refund row carrying stripe_refund_id.
    const ev1 = api.chargeRefundedEvent({
      eventId: `evt_mon07_a_${api.suffix}`, paymentIntent: seed.pi,
      amountRefundedCents: refundCents, stripeRefundId, source: 'dashboard',
    });
    const f1 = await api.fireStripeEvent(ev1);
    expect(f1.body.received).toBe(true);
    const after1 = await api.getInvoice(seed.invoiceId);
    const refundsAfter1 = (after1.refunds ?? []).filter((r: any) => r.stripe_refund_id === stripeRefundId);
    expect(refundsAfter1.length, 'one Refund row after first event').toBe(1);

    // Replay with a NEW event.id but the SAME stripe_refund_id → existingRefund guard → no 2nd row.
    const ev2 = api.chargeRefundedEvent({
      eventId: `evt_mon07_b_${api.suffix}`, paymentIntent: seed.pi,
      amountRefundedCents: refundCents, stripeRefundId, source: 'dashboard',
    });
    const f2 = await api.fireStripeEvent(ev2);
    expect(f2.body.received).toBe(true);
    const after2 = await api.getInvoice(seed.invoiceId);
    const refundsAfter2 = (after2.refunds ?? []).filter((r: any) => r.stripe_refund_id === stripeRefundId);
    expect(refundsAfter2.length, 'still one Refund row after same-refund-id replay').toBe(1);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-07');

    flagKnownBug(test.info(), {
      id: 'MON-07',
      spec: '§8',
      current: 'refund idempotency verified via the charge.refunded webhook existingRefund guard '
        + '(same stripe_refund_id → record-only). The pure in-app re_ double-POST is capped by netPaid, '
        + 'and in-app refund of a CARD/PI payment calls real Stripe (500 against the test org).',
      expected: 'an in-app refund replay carrying the same stripe_refund_id is a no-op (1 Refund row) '
        + 'with a stubbed Stripe createRefund — confirm test intent + a Stripe stub with a human.',
    });
  });

  test('MON-08: charge.refunded event idempotency — same event.id → duplicate, one Refund row', async () => {
    const seed = await seedPaidByCardWebhook(600);
    const stripeRefundId = `re_mon08_${api.suffix}`;
    const eventId = `evt_mon08_${api.suffix}`;
    const refundCents = Math.round(seed.paidAmount * 100);

    const ev = api.chargeRefundedEvent({
      eventId, paymentIntent: seed.pi, amountRefundedCents: refundCents,
      stripeRefundId, source: 'dashboard',
    });
    const f1 = await api.fireStripeEvent(ev);
    expect(f1.body.received).toBe(true);
    const after1 = await api.getInvoice(seed.invoiceId);
    expect((after1.refunds ?? []).filter((r: any) => r.stripe_refund_id === stripeRefundId).length).toBe(1);

    // Replay the SAME event.id → StripeEvent uniqueness → duplicate:true, no new Refund.
    const f2 = await api.fireStripeEvent(ev);
    expect(f2.body.duplicate, 'same event.id → duplicate').toBe(true);
    const after2 = await api.getInvoice(seed.invoiceId);
    expect((after2.refunds ?? []).filter((r: any) => r.stripe_refund_id === stripeRefundId).length).toBe(1);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-08');
  });

  test('MON-09: deposit over-refund — refund capped at drawdown-aware remaining credit', async () => {
    // Positive control for the deposit-drawdown cap (invoice.controller.ts refundInvoice):
    // a DEPOSIT invoice's refundable balance is remainingDepositCredit = paid − applied − refunded,
    // NOT the raw net-paid. A $30k-class deposit fully drawn down onto the job's STANDARD invoice
    // has $0 remaining credit, so it is NO LONGER refundable — refunding it would double-spend.
    const seed = await seedStandardInvoiceFromDeposit(100_000, 30);
    const dep = await api.getDepositInvoice(seed.estimateId);
    const depTotal = Number(dep.total_amount); // 31,875 paid
    const applied = Number(seed.invoice.deposit_credit); // 31,875 drawn down to the work invoice
    expect(applied).toBeGreaterThan(0);
    // This scenario fully applies the deposit (paid == applied), so remaining credit is $0.
    expect(round2(applied)).toBe(round2(depTotal));

    // Fully applied → remaining credit 0 → refund of any amount is rejected with the
    // deposit-specific message (cap is 0, not the raw $31,875 net-paid).
    const { res, body } = await api.refundInvoice(dep.id, {
      amount: depTotal, reason: 'over-refund probe', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(res.status()).toBe(400);
    expect(String(body.error)).toMatch(/nothing left to refund/i);

    // Even a tiny refund is rejected — there is no remaining credit at all.
    const { res: tinyRes, body: tinyBody } = await api.refundInvoice(dep.id, {
      amount: 1, reason: 'tiny over-refund probe', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(tinyRes.status()).toBe(400);
    expect(String(tinyBody.error)).toMatch(/nothing left to refund/i);

    // Nothing changed: the deposit invoice has no Refund rows and stays PAID.
    const depAfter = await api.getInvoice(dep.id);
    expect((depAfter.refunds ?? []).length).toBe(0);
    expect(depAfter.status).toBe('PAID');
    await assertInvoiceReconciles(api, dep.id, 'MON-09');
  });

  // ─── Credit / give-back (MON-10..MON-14) ───────────────────────────────────

  test('MON-10: credit (a) owe70/give20 → owe50, no cash, 1 Credit row', async () => {
    // SENT invoice with a balance of 70 (nothing paid).
    const seed = await seedSentStandardNoDeposit(70 / 1.0625); // subtotal s.t. total ≈ 70? use balance directly
    // Use the actual balance — the credit math keys off amount_due, not a magic 70.
    const inv0 = await api.getInvoice(seed.invoiceId);
    const owed = Number(inv0.amount_due);
    expect(owed).toBeGreaterThan(20);

    const give = round2(owed - 50 > 0 ? owed - 50 : owed / 2); // credit so the remainder is the rest
    const { res, body } = await api.creditInvoice(seed.invoiceId, { amount: give, reason: 'goodwill credit' });
    expect(res.status()).toBe(200);
    const inv = body.invoice;
    expect(Number(inv.amount_due)).toBe(round2(owed - give));
    expect((inv.credits ?? []).length).toBe(1);
    expect((inv.refunds ?? []).length).toBe(0); // credit-only, no cash out
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-10');
  });

  test('MON-11: credit (b) give > owed with enough net-paid → owe0 + cash excess', async () => {
    // total 90, pay 20 → amount_due 70, netPaid 20. Credit 90 → creditPart 70 (owe 0) + refundPart 20.
    const seed = await seedSentStandardNoDeposit(90 / 1.0625);
    const inv0 = await api.getInvoice(seed.invoiceId);
    const owed = Number(inv0.amount_due);
    // Pay a partial so netPaid >= the cash-excess we will give back.
    const partPay = round2(owed * 0.25);
    const { body: payBody } = await api.recordPayment(seed.invoiceId, { amount: partPay, method: 'CHECK' });
    const owedAfterPay = Number(payBody.invoice.amount_due); // ≈ owed - partPay

    // Give back the FULL original owed → creditPart = owedAfterPay, refundPart = owed - owedAfterPay = partPay.
    const give = round2(owedAfterPay + partPay);
    const { res, body } = await api.creditInvoice(seed.invoiceId, { amount: give, reason: 'overcredit' });
    expect(res.status()).toBe(200);
    const inv = body.invoice;
    expect(Number(inv.amount_due)).toBe(0);
    const creditSum = (inv.credits ?? []).reduce((s: number, c: any) => s + Number(c.amount), 0);
    const refundSum = (inv.refunds ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    expect(round2(creditSum)).toBe(owedAfterPay);   // credited the remaining balance
    expect(round2(refundSum)).toBe(round2(partPay)); // cash excess == the previously collected money
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-11');
  });

  test('MON-12: credit (c) on a PAID invoice → all-cash refund, amount_due unchanged', async () => {
    const seed = await seedPaidByManual(500, 'CHECK');
    const give = round2(seed.paidAmount / 5);
    const { res, body } = await api.creditInvoice(seed.invoiceId, { amount: give, reason: 'paid give-back' });
    expect(res.status()).toBe(200);
    const inv = body.invoice;
    // amount_due was 0 → creditPart 0, refundPart = give. No new credit; one cash refund.
    expect((inv.credits ?? []).length).toBe(0);
    const refundSum = (inv.refunds ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    expect(round2(refundSum)).toBe(give);
    expect(Number(inv.amount_due)).toBe(0); // unchanged
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-12');
  });

  test('MON-13: credit (d) give-back > owed with nothing paid → 400; give ≤ owed accepted', async () => {
    const seed = await seedSentStandardNoDeposit(70 / 1.0625);
    const inv0 = await api.getInvoice(seed.invoiceId);
    const owed = Number(inv0.amount_due);

    // Give back MORE than owed with netPaid=0 → refundPart>0 but no money collected → 400.
    const { res: badRes, body: badBody } = await api.creditInvoice(seed.invoiceId, {
      amount: round2(owed + 20), reason: 'give-back over owed',
    });
    expect(badRes.status()).toBe(400);
    expect(String(badBody.error)).toMatch(/give-back exceeds net paid/i);

    // Give back exactly owed (refundPart 0) → 200, amount_due 0.
    const { res: okRes, body: okBody } = await api.creditInvoice(seed.invoiceId, {
      amount: owed, reason: 'credit the balance',
    });
    expect(okRes.status()).toBe(200);
    expect(Number(okBody.invoice.amount_due)).toBe(0);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-13');
  });

  test('MON-14: credit-first default vs refund_instead override (+ proportional tax)', async () => {
    // Two full seed chains (a SENT no-deposit invoice + a PAID no-deposit invoice), each running
    // the lead→walkthrough→estimate→approve→job→invoice spine, so the default 75s budget is tight.
    test.setTimeout(120_000);
    // A PAID invoice so net-paid covers a forced cash refund. Default credit on a balance vs
    // refund_instead forcing cash.
    // (a) default credit-first on a SENT invoice with a balance → credits[] grows, refunds[] empty.
    const sentSeed = await seedSentStandardNoDeposit(2000);
    const sentInv0 = await api.getInvoice(sentSeed.invoiceId);
    const owed = Number(sentInv0.amount_due);
    const total = Number(sentInv0.total_amount);
    const tax = Number(sentInv0.tax_amount);
    const give = round2(owed / 4);
    const { res: cRes, body: cBody } = await api.creditInvoice(sentSeed.invoiceId, {
      amount: give, reason: 'default credit-first',
    });
    expect(cRes.status()).toBe(200);
    expect((cBody.invoice.credits ?? []).length).toBe(1);
    expect((cBody.invoice.refunds ?? []).length).toBe(0);
    // Credit tax_portion is proportional.
    const credit = cBody.invoice.credits[0];
    expect(round2(Number(credit.tax_portion))).toBe(round2(give * tax / total));
    await assertInvoiceReconciles(api, sentSeed.invoiceId, 'MON-14a');

    // (b) refund_instead on a PAID invoice → forces a cash Refund (reason_category CUSTOMER_REQUEST),
    //     no new credit.
    const paidSeed = await seedPaidByManual(2000, 'CHECK');
    const paidInv0 = await api.getInvoice(paidSeed.invoiceId);
    const rGive = round2(Number(paidInv0.total_amount) / 4);
    const { res: rRes, body: rBody } = await api.creditInvoice(paidSeed.invoiceId, {
      amount: rGive, refund_instead: true, reason: 'forced cash',
    });
    expect(rRes.status()).toBe(200);
    expect((rBody.invoice.credits ?? []).length).toBe(0);
    const forcedRefund = (rBody.invoice.refunds ?? []).find((x: any) => Number(x.amount) === rGive);
    expect(forcedRefund, 'a forced cash refund exists').toBeTruthy();
    expect(forcedRefund.reason_category).toBe('CUSTOMER_REQUEST');
    await assertInvoiceReconciles(api, paidSeed.invoiceId, 'MON-14b');
  });

  // ─── Void payment (MON-15..MON-18) ─────────────────────────────────────────

  test('MON-15: void a (bounced) manual payment → reopens + excluded from totals', async () => {
    const seed = await seedPaidByManual(1500, 'CHECK');
    const inv0 = await api.getInvoice(seed.invoiceId);
    const paidAmount = seed.paidAmount;
    expect(inv0.status).toBe('PAID');
    const payment = (inv0.payments ?? []).find((p: any) => !p.voided_at && p.reference_number !== 'DEPOSIT-CREDIT');
    expect(payment).toBeTruthy();

    const { res, body } = await api.voidPayment(seed.invoiceId, {
      payment_id: payment.id, void_category: 'BOUNCED', reason: 'check bounced',
    });
    expect(res.status()).toBe(200);
    const inv = body.invoice;
    // amount_due reopened by the voided amount; status back to SENT (full balance reopened).
    expect(Number(inv.amount_due)).toBe(round2(Number(inv0.amount_due) + paidAmount));
    expect(['SENT', 'PARTIAL']).toContain(inv.status);
    // The payment stays in payments[] with voided_at + void_category set.
    const voided = (inv.payments ?? []).find((p: any) => p.id === payment.id);
    expect(voided.voided_at).toBeTruthy();
    expect(voided.void_category).toBe('BOUNCED');
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-15');
  });

  test('MON-16: void-payment rejects a CARD/PI payment → 400', async () => {
    const seed = await seedPaidByCardWebhook(700);
    const { res, body } = await api.voidPayment(seed.invoiceId, {
      payment_id: seed.cardPaymentId, void_category: 'ERROR', reason: 'try void card',
    });
    expect(res.status()).toBe(400);
    expect(String(body.error)).toMatch(/card payments are reversed by refund/i);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-16');
  });

  test('MON-17: void-payment on a terminal invoice → 400', async () => {
    // Make the invoice REFUNDED (terminal), then try to void its payment.
    const seed = await seedPaidByManual(800, 'CHECK');
    const inv0 = await api.getInvoice(seed.invoiceId);
    const payment = (inv0.payments ?? []).find((p: any) => !p.voided_at && p.reference_number !== 'DEPOSIT-CREDIT');
    // Full refund → REFUNDED.
    const { res: refRes } = await api.refundInvoice(seed.invoiceId, {
      reason: 'full', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refRes.status()).toBe(200);
    const refunded = await api.getInvoice(seed.invoiceId);
    expect(refunded.status).toBe('REFUNDED');

    const { res, body } = await api.voidPayment(seed.invoiceId, {
      payment_id: payment.id, void_category: 'BOUNCED', reason: 'too late',
    });
    expect(res.status()).toBe(400);
    expect(String(body.error)).toMatch(/cannot void a payment on a/i);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-17');
  });

  test('MON-18: void a deposit (CHECK) payment un-applies its credit → work invoice amount_due rises', async () => {
    const seed = await seedStandardInvoiceFromDeposit(100_000, 30);
    const before = Number((await api.getInvoice(seed.invoiceId)).amount_due); // 74,375
    const dep = await api.getDepositInvoice(seed.estimateId);
    const depInvoice = await api.getInvoice(dep.id);
    const depPayment = (depInvoice.payments ?? []).find(
      (p: any) => !p.voided_at && p.reference_number !== 'DEPOSIT-CREDIT',
    );
    expect(depPayment, 'manual deposit CHECK payment exists').toBeTruthy();
    expect(depPayment.method).not.toBe('CARD'); // cascade only fires for non-CARD deposit payments

    const { res } = await api.voidPayment(dep.id, {
      payment_id: depPayment.id, void_category: 'BOUNCED', reason: 'deposit check bounced',
    });
    expect(res.status()).toBe(200);

    const after = Number((await api.getInvoice(seed.invoiceId)).amount_due);
    expect(after).toBeGreaterThan(before); // credit un-applied → work invoice balance rises
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-18-work');
    await assertInvoiceReconciles(api, dep.id, 'MON-18-deposit');
  });

  // ─── Void invoice → statement (MON-19) ─────────────────────────────────────

  test('MON-19: voided invoice contributes $0 to the job statement balance', async () => {
    const seed = await seedStandardInvoiceFromDeposit(40_000, 30);
    // Statement before void: the billed line for this invoice is present.
    const { body: before } = await api.getJobStatement(seed.jobId);
    const billedBefore = (before.lines ?? []).find(
      (l: any) => l.type === 'invoice' && l.invoice_id === seed.invoiceId,
    );
    expect(billedBefore, 'billed line present before void').toBeTruthy();
    const balBefore = Number(before.totals.balance);

    // Void requires a SENT invoice (DRAFT → "Use DELETE").
    await api.sendInvoice(seed.invoiceId);
    const { res: voidRes, body: voidBody } = await api.voidInvoice(seed.invoiceId, 'void to drop from statement');
    expect(voidRes.status()).toBe(200);
    expect(voidBody.invoice.status).toBe('VOIDED');

    const { body: after } = await api.getJobStatement(seed.jobId);
    // The VOIDED invoice's billed line is skipped → no 'invoice' line for it.
    const billedAfter = (after.lines ?? []).filter(
      (l: any) => l.type === 'invoice' && l.invoice_id === seed.invoiceId,
    );
    expect(billedAfter.length, 'voided invoice billed line is excluded').toBe(0);
    // Its total no longer contributes to the running balance/totals.
    expect(Number(after.totals.balance)).toBeLessThan(balBefore);
  });

  // ─── Stripe-origin money events (MON-20..MON-22) ───────────────────────────

  test('MON-20: dashboard charge.refunded → first-class Refund attributed to the org admin', async () => {
    const seed = await seedPaidByCardWebhook(1000);
    const stripeRefundId = `re_mon20_${api.suffix}`;
    const ev = api.chargeRefundedEvent({
      eventId: `evt_mon20_${api.suffix}`, paymentIntent: seed.pi,
      amountRefundedCents: Math.round(seed.paidAmount * 100), stripeRefundId, source: 'dashboard',
    });
    const fired = await api.fireStripeEvent(ev);
    expect(fired.body.received).toBe(true);

    const inv = await api.getInvoice(seed.invoiceId);
    const refund = (inv.refunds ?? []).find((r: any) => r.stripe_refund_id === stripeRefundId);
    expect(refund, 'a first-class Refund row was created from the dashboard event').toBeTruthy();
    expect(refund.reason_category).toBe('OTHER');
    expect(refund.method).toBe('CARD');
    expect(Number(refund.tax_portion)).toBe(0);
    expect(['REFUNDED', 'PARTIALLY_REFUNDED']).toContain(inv.status);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-20');

    flagKnownBug(test.info(), {
      id: 'MON-20',
      spec: '§8',
      current: 'dashboard-origin charge.refunded writes a Refund attributed to the org first-ADMIN '
        + '(refunded_by) with reason_category OTHER, method CARD, tax_portion 0 — verified via the '
        + 'test door + a seeded PI. The system-actor attribution is asserted indirectly (Refund exists, '
        + 'OTHER/CARD/0-tax); refunded_by==admin.id is not surfaced on the invoice detail select.',
      expected: 'human confirms the Refund is attributed to the org ADMIN in the DB (refunded_by) and '
        + 'the dashboard-refund flow against a real connected account.',
    });
  });

  test('MON-21: dispute created → DISPUTED; closed-won → PAID; closed-lost → CHARGEBACK void reopens', async () => {
    // Two full card-webhook seed chains (each a lead→…→invoice spine paid via the Stripe door)
    // plus the dispute event replays, so the default 75s budget is too tight.
    test.setTimeout(120_000);
    // (1) created → DISPUTED.
    const seed = await seedPaidByCardWebhook(1200);
    const disputeId1 = `dp_mon21a_${api.suffix}`;
    const created = await api.fireStripeEvent(api.disputeCreatedEvent({
      eventId: `evt_mon21_created_${api.suffix}`, disputeId: disputeId1, paymentIntent: seed.pi,
    }));
    expect(created.body.received).toBe(true);
    let inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('DISPUTED');
    expect(inv.stripe_dispute_id).toBe(disputeId1);

    // (2) closed(won) on the SAME dispute (only acts while DISPUTED) → PAID, dispute id cleared.
    const won = await api.fireStripeEvent(api.disputeClosedEvent({
      eventId: `evt_mon21_won_${api.suffix}`, disputeId: disputeId1, paymentIntent: seed.pi, status: 'won',
    }));
    expect(won.body.received).toBe(true);
    inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('PAID');
    expect(inv.stripe_dispute_id == null).toBe(true);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-21-won');

    // (3) A FRESH dispute, then closed(lost) → systemVoidPaymentForChargeback voids the CARD payment
    //     (void_category CHARGEBACK), amount_due reopens, status SENT/PARTIAL.
    const lostSeed = await seedPaidByCardWebhook(1200);
    const dueBefore = Number((await api.getInvoice(lostSeed.invoiceId)).amount_due); // 0 (paid)
    const disputeId2 = `dp_mon21b_${api.suffix}`;
    await api.fireStripeEvent(api.disputeCreatedEvent({
      eventId: `evt_mon21_created2_${api.suffix}`, disputeId: disputeId2, paymentIntent: lostSeed.pi,
    }));
    const lost = await api.fireStripeEvent(api.disputeClosedEvent({
      eventId: `evt_mon21_lost_${api.suffix}`, disputeId: disputeId2, paymentIntent: lostSeed.pi, status: 'lost',
    }));
    expect(lost.body.received).toBe(true);
    const lostInv = await api.getInvoice(lostSeed.invoiceId);
    expect(['SENT', 'PARTIAL']).toContain(lostInv.status);
    expect(Number(lostInv.amount_due)).toBeGreaterThan(dueBefore); // money clawed back → reopened
    const chargebackPay = (lostInv.payments ?? []).find((p: any) => p.id === lostSeed.cardPaymentId);
    expect(chargebackPay.voided_at).toBeTruthy();
    expect(chargebackPay.void_category).toBe('CHARGEBACK');
    await assertInvoiceReconciles(api, lostSeed.invoiceId, 'MON-21-lost');

    flagKnownBug(test.info(), {
      id: 'MON-21',
      spec: '§8',
      current: 'all three dispute transitions verified via the test door + seeded PI: created→DISPUTED, '
        + 'closed-won→PAID (dispute id cleared), closed-lost→CHARGEBACK void reopens amount_due.',
      expected: 'human confirms the same three transitions against a real Stripe connected account '
        + '(event.account-resolved org), including any DEPOSIT-cascade on a lost chargeback.',
    });
  });

  test('MON-22: dispute idempotency — created-replay no-op + non-lost close record-only', async () => {
    const seed = await seedPaidByCardWebhook(900);
    const disputeId = `dp_mon22_${api.suffix}`;
    // created → DISPUTED.
    await api.fireStripeEvent(api.disputeCreatedEvent({
      eventId: `evt_mon22_created_${api.suffix}`, disputeId, paymentIntent: seed.pi,
    }));
    let inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('DISPUTED');
    const dueAfterCreate = Number(inv.amount_due);

    // created replay (same dispute id, NEW event.id) → idempotent no-op (status unchanged).
    const replay = await api.fireStripeEvent(api.disputeCreatedEvent({
      eventId: `evt_mon22_created_replay_${api.suffix}`, disputeId, paymentIntent: seed.pi,
    }));
    expect(replay.body.received).toBe(true);
    inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status).toBe('DISPUTED');
    expect(Number(inv.amount_due)).toBe(dueAfterCreate);

    // A non-won/non-lost close (warning_closed) → record-only, no state change. The disputeClosedEvent
    // helper only types 'won'|'lost', so build the warning_closed event by hand via fireStripeEvent.
    const warn = await api.fireStripeEvent({
      id: `evt_mon22_warn_${api.suffix}`,
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, payment_intent: seed.pi, status: 'warning_closed' } },
    });
    expect(warn.body.received).toBe(true);
    inv = await api.getInvoice(seed.invoiceId);
    expect(inv.status, 'warning_closed is record-only').toBe('DISPUTED');
    expect(Number(inv.amount_due)).toBe(dueAfterCreate);
    await assertInvoiceReconciles(api, seed.invoiceId, 'MON-22');

    flagKnownBug(test.info(), {
      id: 'MON-22',
      spec: '§8',
      current: 'dispute idempotency verified via the test door + seeded PI: a created-replay (same '
        + 'dispute id) is a no-op, and a warning_closed close is record-only (no status/amount change).',
      expected: 'human confirms replays do not double-apply against a real Stripe connected account.',
    });
  });
});
