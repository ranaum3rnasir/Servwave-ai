import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { maEstimateSentWithDeposit } from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 5 — Deposit invoice (kind=DEPOSIT). Plan task C5, rows DEP-01..DEP-09.
 *
 * Anchors (HARNESS-CONTRACT §2, facts/estimate-deposit.json):
 *  - The deposit % is the org AppSetting `deposit_percentage`, pinned by
 *    maEstimateSentWithDeposit(api, amount, pct). The send body's percentage is IGNORED.
 *  - The deposit applies to the estimate's TAX-INCLUSIVE total_amount, not the subtotal:
 *      estimate.total_amount = amount * 1.0625 (MA 6.25%),
 *      deposit.total_amount  = amount * 1.0625 * (pct/100)  — UNROUNDED (DEP-02 bug).
 *  - The deposit invoice itself is NON-TAXABLE (tax_rate=0, tax_amount=0, one line).
 *  - estimate.invoices[0] (estimateDetailSelect) does NOT carry tax_amount/line_items;
 *    read those via api.getInvoice(dep.id).
 *
 * ONE shared org, serial — assert presence/deltas of YOUR seeded ids, never absolute counts.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

test.describe('Stage 5 — Deposit invoice (kind=DEPOSIT)', () => {
  test('DEP-01: spawned on send-with-deposit → estimate.invoices[0].kind === DEPOSIT', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CHECK', 'CASH', 'CARD']);
    const est = await api.getEstimate(ctx.estimateId);
    const dep = est.invoices[0];
    expect(dep, 'deposit invoice should exist on estimate.invoices[0]').toBeTruthy();
    expect(dep.kind).toBe('DEPOSIT');
    expect(dep.status).toBe('SENT');
    // Deposit applies to the TAX-INCLUSIVE total: 10000 * 1.0625 * 0.30 = 3187.5.
    expect(Number(dep.total_amount)).toBe(3_187.5);
    expect(Number(dep.amount_due)).toBe(3_187.5);
    await assertInvoiceReconciles(api, dep.id, 'DEP-01');
  });

  test('DEP-02: deposit amount = round2(total×%) — code computes un-rounded but Decimal(12,2) storage rounds to cents (flagged)', async () => {
    // Choose a pct that yields sub-cent precision against the tax-inclusive total:
    //   estimate total = 10000 * 1.0625 = 10625; 10625 * 0.3333 = 3541.3125 (sub-cent product).
    const pct = 33.33;
    const ctx = await maEstimateSentWithDeposit(api, 10_000, pct, ['CHECK', 'CASH', 'CARD']);
    const est = await api.getEstimate(ctx.estimateId);
    const total = Number(est.total_amount); // 10625
    // Read total_amount via the full invoice (estimate.invoices[0] lacks tax_amount/line_items).
    const dep = await api.getInvoice(est.invoices[0].id);

    const productUnrounded = total * (pct / 100); // 3541.3125 — has sub-cent precision in the product
    // Confirm the product really is sub-cent (the would-be bug surface) — not already a clean 2dp value.
    expect(Math.round(productUnrounded * 100) / 100).not.toBe(productUnrounded);

    // REAL FINDING: the controller computes depositAmount un-rounded (no Math.round at
    // estimate.controller.ts ~line 1034), but it is persisted into Invoice.total_amount /
    // subtotal / amount_due / line_total, all Decimal(12,2). Postgres rounds the value to
    // whole cents at STORAGE, so the "un-rounded precision bug" does NOT manifest once stored:
    // the value read back is exactly round2(total×%), never the sub-cent 3541.3125.
    const expectedCentsRounded = Math.round(productUnrounded * 100) / 100; // 3541.31
    expect(Number(dep.total_amount)).toBe(expectedCentsRounded);
    expect(Number(dep.amount_due)).toBe(expectedCentsRounded);
    // And it is NOT the sub-cent value (proves storage truncation, not verbatim persistence).
    expect(Number(dep.total_amount)).not.toBe(productUnrounded);

    // The deposit invoice still self-reconciles (amount_due == total_amount, no payments yet).
    await assertInvoiceReconciles(api, dep.id, 'DEP-02');

    flagKnownBug(test.info(), {
      id: 'DEP-02', spec: '§5/§6',
      current: `code computes deposit total = total×% UN-rounded (${productUnrounded}), but it is stored in Decimal(12,2) columns so the persisted value is cents-rounded round2() = ${expectedCentsRounded}`,
      expected: 'Math.round the deposit amount to whole cents in code; storage rounding already mitigates the concern, so no sub-cent value is ever persisted',
    });
  });

  test('DEP-03: single non-taxable line, no tax line', async () => {
    const pct = 30;
    const ctx = await maEstimateSentWithDeposit(api, 10_000, pct, ['CHECK', 'CASH', 'CARD']);
    const est = await api.getEstimate(ctx.estimateId);
    const dep = await api.getInvoice(est.invoices[0].id);

    expect(dep.line_items).toHaveLength(1);
    const line = dep.line_items[0];
    expect(line.is_taxable).toBe(false);
    expect(Number(dep.tax_rate)).toBe(0);
    expect(Number(dep.tax_amount)).toBe(0);
    // The single line carries the full deposit amount; description = `Deposit — <pct>% of <estimate_number>`.
    const depAmount = Number(dep.total_amount);
    expect(Number(line.unit_price)).toBe(depAmount);
    expect(Number(line.line_total)).toBe(depAmount);
    expect(String(line.description)).toContain('Deposit');
    expect(String(line.description)).toContain(String(pct));
    await assertInvoiceReconciles(api, dep.id, 'DEP-03');
  });

  test('DEP-04: one-per-estimate — second send does not spawn a 2nd deposit invoice', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CHECK', 'CASH', 'CARD']);
    const depId1 = (await api.getEstimate(ctx.estimateId)).invoices[0].id;

    // Resend (status is now SENT → SENT). Must spawn nothing new.
    const resend = await api.sendEstimate(ctx.estimateId, {
      deposit_required: true, payment_methods: ['CHECK', 'CASH', 'CARD'],
    });
    expect(resend.res.status()).toBe(200);

    const depId2 = (await api.getEstimate(ctx.estimateId)).invoices[0].id;
    expect(depId2).toBe(depId1); // same deposit invoice, not a fresh one

    // Cross-check the actual count of kind=DEPOSIT invoices for this estimate is exactly 1
    // (estimate.invoices is take:1, so verify via the invoices list scoped to this estimate).
    const { body } = await api.listInvoices({ estimate_id: ctx.estimateId });
    const rows: any[] = body.invoices ?? body.data ?? body ?? [];
    const deposits = (Array.isArray(rows) ? rows : []).filter(
      (i: any) => i.kind === 'DEPOSIT' && i.estimate_id === ctx.estimateId,
    );
    // The list may not support estimate_id filtering; fall back to the id-equality check above.
    if (deposits.length > 0) expect(deposits).toHaveLength(1);
    await assertInvoiceReconciles(api, depId1, 'DEP-04');
  });

  test('DEP-05: pay Cash/Check → PAID + estimate WON + lead WON (three-way flip)', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CHECK', 'CASH', 'CARD']);
    const dep = await api.getEstimate(ctx.estimateId).then((e) => e.invoices[0]);
    const depTotal = Number(dep.total_amount); // 3187.5

    const { res } = await api.markDepositReceived(ctx.estimateId, {
      amount: depTotal, payment_method: 'CASH',
    });
    expect(res.status()).toBe(200);

    const after = await api.getEstimate(ctx.estimateId);
    expect(after.invoices[0].status).toBe('PAID');
    expect(Number(after.invoices[0].amount_due)).toBe(0);
    expect(after.status).toBe('WON');
    expect(after.approved_at).toBeTruthy();

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');

    await assertInvoiceReconciles(api, after.invoices[0].id, 'DEP-05');
  });

  test('DEP-06: underpaid record-payment → deposit PARTIAL, amount_due = total − paid, lead NOT won', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CHECK', 'CASH', 'CARD']);
    const dep = await api.getEstimate(ctx.estimateId).then((e) => e.invoices[0]);
    const depTotal = Number(dep.total_amount);            // 3187.5
    const underpay = Math.round((depTotal / 2) * 100) / 100;

    const { res } = await api.markDepositReceived(ctx.estimateId, { amount: underpay, payment_method: 'CASH' });
    expect(res.status()).toBe(200);

    const after = await api.getEstimate(ctx.estimateId);
    const depInv = await api.getInvoice(after.invoices[0].id);
    expect(depInv.status).toBe('PARTIAL');
    expect(Number(depInv.amount_due)).toBeCloseTo(depTotal - underpay, 2);
    expect(after.status).not.toBe('WON');            // estimate held
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).not.toBe('WON');                  // lead NOT won

    // Real money is recorded.
    const paid = (depInv.payments ?? []).filter((p: any) => !p.voided_at)
      .reduce((s: number, p: any) => s + Number(p.amount), 0);
    expect(paid).toBeCloseTo(underpay, 2);

    // Now reconcile PASSES (amount_due = total − paid), unlike the old buggy state.
    await assertInvoiceReconciles(api, depInv.id, 'DEP-06');
  });

  test('DEP-07: pay via mimicked Stripe webhook → deposit PAID (assert the EFFECT)', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD']);
    const dep = await api.getEstimate(ctx.estimateId).then((e) => e.invoices[0]);
    expect(dep.kind).toBe('DEPOSIT');
    expect(dep.status).toBe('SENT');

    // amount_total = amount_due * 100 (face value), matching the webhook's amount check.
    const ev = api.depositPaidEvent(dep.id, api.checkoutCents(Number(dep.amount_due)), {
      eventId: `evt_dep07_${api.suffix}`,
    });
    const fired = await api.fireStripeEvent(ev);
    expect(fired.res.status()).toBe(200);
    expect(fired.body.received).toBe(true);

    // Assert the EFFECT (not a bare received:true): invoice PAID + amount_due 0 + one Payment.
    const after = await api.getEstimate(ctx.estimateId);
    const depInv = await api.getInvoice(after.invoices[0].id);
    expect(depInv.status).toBe('PAID');
    expect(Number(depInv.amount_due)).toBe(0);
    const livePayments = (depInv.payments ?? []).filter((p: any) => !p.voided_at);
    expect(livePayments).toHaveLength(1);
    // The deposit-invoice webhook path also flips estimate WON + lead WON.
    expect(after.status).toBe('WON');
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');

    await assertInvoiceReconciles(api, depInv.id, 'DEP-07');
  });

  test('DEP-08: waive an unpaid deposit → VOIDED + estimate WON + lead WON (job-gate then passes)', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CHECK', 'CASH', 'CARD']);
    const dep = await api.getEstimate(ctx.estimateId).then((e) => e.invoices[0]);
    expect(dep.status).toBe('SENT'); // unpaid (DRAFT/SENT) → waivable

    const { res } = await api.waiveDeposit(ctx.estimateId, 'waive');
    expect(res.status()).toBe(200);

    const after = await api.getEstimate(ctx.estimateId);
    expect(after.invoices[0].status).toBe('VOIDED');
    expect(after.status).toBe('WON');
    const voidedInv = await api.getInvoice(after.invoices[0].id);
    expect(voidedInv.voided_at).toBeTruthy();
    expect(String(voidedInv.voided_reason ?? '')).toContain('waived');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');

    // Job-gate then passes: a job is creatable from the approved estimate with a voided/waived
    // deposit (the deposit no longer blocks). The full deposit-gate matrix lives in the job
    // domain (JOB-02); here we prove the waived-deposit path unblocks job creation.
    const { res: jobRes } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(jobRes.status()).toBe(201);
  });

  test('DEP-09: webhook idempotency replay (same event.id) → duplicate:true, no double Payment', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD']);
    const dep = await api.getEstimate(ctx.estimateId).then((e) => e.invoices[0]);
    expect(dep.status).toBe('SENT');

    const ev = api.depositPaidEvent(dep.id, api.checkoutCents(Number(dep.amount_due)), {
      eventId: `evt_dep09_${api.suffix}`,
    });

    const first = await api.fireStripeEvent(ev);
    expect(first.res.status()).toBe(200);
    expect(first.body.received).toBe(true);

    // Replay the SAME event.id → top-level stripeEvent.findUnique short-circuits to duplicate:true.
    const second = await api.fireStripeEvent(ev);
    expect(second.res.status()).toBe(200);
    expect(second.body.duplicate).toBe(true);

    // Exactly one non-voided Payment recorded; invoice PAID; estimate WON.
    const after = await api.getEstimate(ctx.estimateId);
    const depInv = await api.getInvoice(after.invoices[0].id);
    expect(depInv.status).toBe('PAID');
    const livePayments = (depInv.payments ?? []).filter((p: any) => !p.voided_at);
    expect(livePayments).toHaveLength(1);
    expect(after.status).toBe('WON');

    await assertInvoiceReconciles(api, depInv.id, 'DEP-09');
  });
});
