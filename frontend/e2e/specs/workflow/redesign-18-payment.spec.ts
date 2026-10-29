import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createTech,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 8 — Payment (Task C8, rows PAY-01..PAY-06).
 *
 * Facts: md_files/plans/entity-redesign/facts/invoice-payment-money.json
 * Endpoint under test: POST /api/invoices/:id/payments
 *   recordPaymentSchema = { amount:positive, method: CARD|EXTERNAL_CARD|CASH|CHECK|BANK_TRANSFER,
 *                           paid_at?, reference_number?, notes? }
 *   Response 201 -> { invoice (detail), payment, overpaid }  (overpaid is a TOP-LEVEL number)
 *   Status guard: ONLY SENT or PARTIAL pass; DRAFT/PAID/VOIDED/REFUNDED/PARTIALLY_REFUNDED -> 400.
 *   Overpayment is ALLOWED: clamps amount_due at 0, status PAID, overpaid>0, NO auto-Refund row.
 *
 * ONE shared org, serial — data accumulates. All seeded entities are unique via api.suffix.
 * Never assert absolute list/stat counts; assert presence/deltas of THIS run's ids.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/**
 * Seed a STANDARD invoice on a fully-completed job, with the deposit already PAID so the
 * invoice draws a deposit credit. Returns the STANDARD invoice context.
 *
 * amount / pct are MA taxable worked-example numbers:
 *   estimate total = amount*1.0625 ; deposit total = round2(amount*1.0625*pct/100)
 *   STANDARD: subtotal=amount, tax=amount*0.0625, total=amount*1.0625,
 *             deposit_credit=deposit total, amount_due = total - deposit_credit.
 */
async function seedStandardInvoiceWithDeposit(amount: number, pct: number) {
  const ctx = await maEstimateSentWithDeposit(api, amount, pct, ['CHECK', 'CASH']);
  // Approve (public) then pay the deposit by CHECK → deposit invoice PAID, estimate WON.
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' });

  // Create + drive the job to COMPLETED.
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id as string;
  const techId = await createTech(api);
  await api.assignJob(jobId, {
    assignee_ids: [techId],
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  await api.startJob(jobId);
  await api.completeJob(jobId, `PAY seed completion ${api.suffix}`);

  // Spawn the STANDARD invoice (snapshots estimate lines + draws the deposit credit).
  const { body: invBody } = await api.createInvoice(jobId);
  return { ...ctx, jobId, invoice: invBody.invoice, invoiceId: invBody.invoice.id as string };
}

/**
 * Seed a SENT STANDARD invoice (deposit fully required + paid, then drawn down) and return
 * it after sending. amount_due is whatever remains after the deposit credit.
 */
async function seedSentStandardInvoiceWithDeposit(amount: number, pct: number) {
  const seed = await seedStandardInvoiceWithDeposit(amount, pct);
  const { body: sentBody } = await api.sendInvoice(seed.invoiceId);
  return { ...seed, invoice: sentBody.invoice };
}

test.describe('Stage 8 — Payment (PAY-01..PAY-06)', () => {
  test('PAY-01: many payments per invoice — two partials sum to total, reconciles', async () => {
    // Tax-inclusive MA total of 1000 → 1062.5. No deposit credit needed for partials math;
    // we use a small deposit (paid then drawn) and pay the REMAINING amount_due in two halves.
    const seed = await seedSentStandardInvoiceWithDeposit(1000, 10);
    const inv0 = await api.getInvoice(seed.invoiceId);
    const due = Number(inv0.amount_due);
    expect(due, 'seed invoice should have a positive balance to split').toBeGreaterThan(0);

    const first = Math.round((due / 2) * 100) / 100;
    const second = Math.round((due - first) * 100) / 100;

    // First partial → status PARTIAL, balance not yet zero.
    const { res: r1, body: b1 } = await api.recordPayment(seed.invoiceId, { amount: first, method: 'CHECK' });
    expect(r1.status()).toBe(201);
    expect(b1.invoice.status).toBe('PARTIAL');
    expect(Number(b1.invoice.amount_due)).toBeGreaterThan(0);
    await assertInvoiceReconciles(api, seed.invoiceId, 'PAY-01 after first partial');

    // Second partial covering the rest → status PAID, balance 0.
    const { res: r2, body: b2 } = await api.recordPayment(seed.invoiceId, { amount: second, method: 'CHECK' });
    expect(r2.status()).toBe(201);
    expect(b2.invoice.status).toBe('PAID');
    expect(Number(b2.invoice.amount_due)).toBe(0);

    // The two manual payments sum to the original due (deposit-credit payment is separate).
    const inv = await api.getInvoice(seed.invoiceId);
    const manualPaid = (inv.payments ?? [])
      .filter((p: any) => !p.voided_at && p.reference_number !== 'DEPOSIT-CREDIT')
      .reduce((s: number, p: any) => s + Number(p.amount), 0);
    expect(Math.round(manualPaid * 100) / 100).toBe(due);
    await assertInvoiceReconciles(api, seed.invoiceId, 'PAY-01 paid');
  });

  test('PAY-02: each manual method (CASH/CHECK/BANK_TRANSFER/EXTERNAL_CARD) records', async () => {
    // The first STANDARD invoice on a job snapshots lines; subsequent ones are empty. So each
    // method needs its OWN seeded invoice with a balance. We record one partial per invoice and
    // assert the recorded payment carries that method back.
    // Four full seed-chains (lead→walkthrough→estimate→deposit→job→invoice) run in series, so the
    // 75s global cap is too tight — this is legitimate seeding cost, not a hang.
    test.setTimeout(120_000);
    const methods = ['CASH', 'CHECK', 'BANK_TRANSFER', 'EXTERNAL_CARD'] as const;
    for (const method of methods) {
      const seed = await seedSentStandardInvoiceWithDeposit(500, 10);
      const inv0 = await api.getInvoice(seed.invoiceId);
      const due = Number(inv0.amount_due);
      expect(due, `seed for ${method} must have a balance`).toBeGreaterThan(0);

      // Pay a partial (a fraction) so the invoice stays valid for the next method run; the
      // assertion is purely on the returned payment.method.
      const partial = Math.round((due / 2) * 100) / 100;
      const { res, body } = await api.recordPayment(seed.invoiceId, { amount: partial, method });
      expect(res.status(), `record ${method}`).toBe(201);
      expect(body.payment.method, `payment.method echoes ${method}`).toBe(method);
      await assertInvoiceReconciles(api, seed.invoiceId, `PAY-02 ${method}`);
    }
  });

  test('PAY-03: deposit credit is a post-tax DEPOSIT-CREDIT payment, subtotal/tax unchanged', async () => {
    // Worked example (STD-05 corrected): $100,000 / 30% MA.
    // estimate total = 106250 ; deposit total = 31875.
    // STANDARD: subtotal 100000, tax 6250, total 106250, deposit_credit 31875,
    //           amount_due = 106250 - 31875 = 74375.
    const seed = await seedStandardInvoiceWithDeposit(100_000, 30);
    const inv = await api.getInvoice(seed.invoiceId);

    expect(Number(inv.subtotal)).toBe(100_000);
    expect(Number(inv.tax_amount)).toBe(6_250);
    expect(Number(inv.total_amount)).toBe(106_250);
    expect(Number(inv.deposit_credit)).toBe(31_875);
    expect(Number(inv.amount_due)).toBe(74_375);

    // The drawdown is a Payment with reference_number 'DEPOSIT-CREDIT', NOT a discount line.
    const depCredit = (inv.payments ?? []).find((p: any) => p.reference_number === 'DEPOSIT-CREDIT');
    expect(depCredit, 'deposit credit recorded as a payment line').toBeTruthy();
    expect(Number(depCredit.amount)).toBe(31_875);

    // subtotal/tax are the pre-credit values (tax charged ONCE); amount_due == total - credit.
    expect(Number(inv.amount_due)).toBe(Number(inv.total_amount) - Number(inv.deposit_credit));
    // discount_amount untouched (deposit is not modeled as a discount).
    expect(Number(inv.discount_amount ?? 0)).toBe(0);
    await assertInvoiceReconciles(api, seed.invoiceId, 'PAY-03');
  });

  test('PAY-04: overpayment flags overpaid + NO auto-Refund row (§6, flagged)', async () => {
    const seed = await seedSentStandardInvoiceWithDeposit(1000, 10);
    const inv0 = await api.getInvoice(seed.invoiceId);
    const due = Number(inv0.amount_due);
    expect(due).toBeGreaterThan(0);

    const over = Math.round((due + 50) * 100) / 100; // pay $50 more than owed
    const { res, body } = await api.recordPayment(seed.invoiceId, { amount: over, method: 'CASH' });
    expect(res.status()).toBe(201);

    // Top-level overpaid > 0 (round(amount-due)). Invoice clamps to PAID / amount_due 0.
    expect(Number(body.overpaid)).toBeGreaterThan(0);
    expect(body.invoice.status).toBe('PAID');
    expect(Number(body.invoice.amount_due)).toBe(0);

    // CURRENT behavior: no auto-Refund is created (only an OVERPAYMENT_FLAGGED timeline event).
    const inv = await api.getInvoice(seed.invoiceId);
    expect((inv.refunds ?? []).length).toBe(0);
    await assertInvoiceReconciles(api, seed.invoiceId, 'PAY-04');

    flagKnownBug(test.info(), {
      id: 'PAY-04',
      spec: '§6',
      current: 'overpayment is accepted and flagged (overpaid>0) but creates NO Refund row; '
        + 'amount_due clamps to 0 and the surplus is silently retained on the books.',
      expected: 'an overpayment should auto-create (or prompt) a Refund/Credit for the surplus, '
        + 'not just emit an OVERPAYMENT_FLAGGED timeline event.',
    });
  });

  test('PAY-05: payment on DRAFT / PAID / VOIDED is rejected (4xx each)', async () => {
    // One DRAFT seed-chain + two SENT seed-chains run in series (each negative case is then a
    // single quick recordPayment request, not a re-seed), so the 75s global cap is too tight for
    // legitimate seeding cost, not a hang.
    test.setTimeout(120_000);
    // --- DRAFT: create a STANDARD invoice and DO NOT send it. ---
    const draftSeed = await seedStandardInvoiceWithDeposit(800, 10); // createInvoice → DRAFT
    const draftInv = await api.getInvoice(draftSeed.invoiceId);
    expect(draftInv.status).toBe('DRAFT');
    const draftDue = Number(draftInv.amount_due);
    const { res: draftRes } = await api.recordPayment(draftSeed.invoiceId, {
      amount: draftDue > 0 ? draftDue : 1, method: 'CASH',
    });
    expect(draftRes.status(), 'payment on DRAFT rejected').toBeGreaterThanOrEqual(400);
    expect(draftRes.status()).toBeLessThan(500);

    // --- PAID: seed a SENT invoice, pay it in full → PAID, then try again. ---
    const paidSeed = await seedSentStandardInvoiceWithDeposit(800, 10);
    const paidInv0 = await api.getInvoice(paidSeed.invoiceId);
    const paidDue = Number(paidInv0.amount_due);
    expect(paidDue).toBeGreaterThan(0);
    const { body: payBody } = await api.recordPayment(paidSeed.invoiceId, { amount: paidDue, method: 'CHECK' });
    expect(payBody.invoice.status).toBe('PAID');
    const { res: paidRes } = await api.recordPayment(paidSeed.invoiceId, { amount: 1, method: 'CASH' });
    expect(paidRes.status(), 'payment on PAID rejected').toBeGreaterThanOrEqual(400);
    expect(paidRes.status()).toBeLessThan(500);

    // --- VOIDED: seed a SENT invoice, void it, then try to pay. ---
    const voidSeed = await seedSentStandardInvoiceWithDeposit(800, 10);
    const { res: voidRes } = await api.voidInvoice(voidSeed.invoiceId, `PAY-05 void ${api.suffix}`);
    expect(voidRes.status()).toBe(200);
    const voidedInv = await api.getInvoice(voidSeed.invoiceId);
    expect(voidedInv.status).toBe('VOIDED');
    const { res: voidedPayRes } = await api.recordPayment(voidSeed.invoiceId, { amount: 1, method: 'CASH' });
    expect(voidedPayRes.status(), 'payment on VOIDED rejected').toBeGreaterThanOrEqual(400);
    expect(voidedPayRes.status()).toBeLessThan(500);
  });

  test('PAY-06: a recorded payment appears on the invoice ledger AND the job statement', async () => {
    const seed = await seedSentStandardInvoiceWithDeposit(1200, 10);
    const inv0 = await api.getInvoice(seed.invoiceId);
    const due = Number(inv0.amount_due);
    expect(due).toBeGreaterThan(0);

    const payAmount = Math.round((due / 2) * 100) / 100; // a partial so the invoice stays open
    const ref = `PAY06-${api.suffix}`;
    const { res, body } = await api.recordPayment(seed.invoiceId, {
      amount: payAmount, method: 'CHECK', reference_number: ref,
    });
    expect(res.status()).toBe(201);
    const paymentId = body.payment.id as string;

    // (a) Invoice ledger: payments[] includes THIS payment.
    const inv = await api.getInvoice(seed.invoiceId);
    const onInvoice = (inv.payments ?? []).find((p: any) => p.id === paymentId);
    expect(onInvoice, 'payment present on invoice.payments[]').toBeTruthy();
    expect(Number(onInvoice.amount)).toBe(payAmount);

    // (b) Job statement: a type:'payment' line for this invoice with the payment amount.
    const { body: stmt } = await api.getJobStatement(seed.jobId);
    const paymentLines = (stmt.lines ?? []).filter(
      (l: any) => l.type === 'payment' && l.invoice_id === seed.invoiceId,
    );
    expect(paymentLines.length, 'a payment line exists on the job statement').toBeGreaterThan(0);
    const matched = paymentLines.find((l: any) => Math.abs(Number(l.amount)) === payAmount);
    expect(matched, 'statement payment line matches the recorded amount').toBeTruthy();

    await assertInvoiceReconciles(api, seed.invoiceId, 'PAY-06');
  });
});
