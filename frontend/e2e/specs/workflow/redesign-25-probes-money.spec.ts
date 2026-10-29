import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createSalesUser,
  leadToWalkthroughCompleted,
  createDraftEstimate,
  scheduleJobOnly,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 25 — Money-path PROBES + the public-checkout guard grid.
 *
 * Catalog rows: COL-20, COL-09, COL-14, COL-07, SEL-21 (all 🧪 PROBE) + COL-13 extension
 * (`md_files/specs/testing/lifecycle-regression-catalog.md`). Behavior map:
 * `md_files/specs/testing/job-lifecycle-e2e-map.md` §6 (suspected-broken register) and
 * `md_files/specs/testing/segments/04-collect-invoice-payment.md` (§2 happy path, §3 branch
 * table, §4 refusal contract, §5 Open Questions 1/2/4) + `segments/02` §5 Q8.
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED.
 *
 * A PROBE pins STATICALLY-PREDICTED behavior (controller reads, no runtime yet) and flags it
 * with flagKnownBug. The first baseline run confirms or refutes each prediction:
 *   - probe passes  → prediction confirmed → file the gh issue, keep the flag.
 *   - probe fails   → prediction wrong → investigate, flip the assertion, remove the flag.
 *
 * Code anchors (read 2026-06-10, branch proto/comm-job-surfaces):
 *   - invoice.controller.ts create() deposit-credit block (~396-504): credit drawn ONLY here,
 *     at creation, from `remainingDepositCredit` (deposit-credit.ts: paid − active apps − refunds).
 *   - remove() (~692-708): bare `prisma.invoice.delete`; Payment.invoice is `onDelete: Restrict`
 *     (schema.prisma Payment model) and DepositCreditApplication FKs default to Restrict.
 *   - voidInvoice() (~836-890): writes status/voided_at/voided_reason + amount_invoiced decrement
 *     ONLY — never touches DepositCreditApplication.reversed_at and never voids the synthetic
 *     DEPOSIT-CREDIT payment (reversal exists only in the void-PAYMENT cascades, ~1761-1807).
 *   - recordPayment() (~914-1073): SENT/PARTIAL guard, no `kind` check, no estimate/lead logic.
 *   - createPublicCheckout() (~1195-1255) guard ORDER: token PRESENCE → isStripeConfigured →
 *     token RESOLUTION (404) → status SENT/PARTIAL → org-CARD.
 *   - estimate.controller.ts recordEstimatePayment (~1290-1431): DRAFT branch — when no
 *     kind=DEPOSIT invoice exists it skips ALL money rows (no invoice, no Payment).
 *
 * ONE shared org, serial (api config: workers 1) — data accumulates. All seeded entities are
 * unique via api.suffix; assert presence/deltas only, never absolute counts. After every money
 * mutation: assertInvoiceReconciles — every probe below leaves states where the §3.1 ledger
 * invariant still HOLDS (verified arithmetically per-test); SEL-21's predicted gap means NO
 * invoice exists at all, so reconcile is inapplicable there (nothing to reconcile), not violated.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Local seeding helpers (mirrored from redesign-19-money-levers.spec.ts) ──────────────────

/**
 * Build a MA taxable estimate (sent, with deposit), pay the deposit by CHECK (estimate
 * record-payment door → deposit PAID + estimate WON + lead WON), drive the job to
 * COMPLETED, and spawn the STANDARD invoice (snapshots lines + draws the deposit credit).
 * Invoice is left in DRAFT. Worked example for (10000, 30): estimate total 10625,
 * deposit 3187.5, invoice total 10625, deposit_credit 3187.5, amount_due 7437.5.
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
  await api.completeJob(jobId, `PROBE seed completion ${api.suffix}`);
  const { body: invBody } = await api.createInvoice(jobId);
  const invoice = await api.getInvoice(invBody.invoice.id);
  return { ...ctx, jobId, depositInvoice: dep, invoice, invoiceId: invoice.id as string };
}

/**
 * Build a SENT MA standard invoice with a deterministic balance, WITHOUT any deposit
 * (amount_due == total_amount). Goes through the walkthrough gate by hand. Returns the
 * public_token from the send response (COL-13x exercises the public checkout).
 */
async function seedSentStandardNoDeposit(amount: number) {
  const { customerId, locationId } = await createMaCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `probe-${api.suffix}`, service_location_id: locationId,
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
  await api.completeJob(jobId, `PROBE no-deposit completion ${api.suffix}`);
  const { body: invBody } = await api.createInvoice(jobId);
  const invoiceId = invBody.invoice.id as string;
  const { body: sendBody } = await api.sendInvoice(invoiceId);
  const invoice = await api.getInvoice(invoiceId);
  return {
    customerId, locationId, leadId, estimateId, jobId, invoiceId, invoice,
    publicToken: sendBody.invoice.public_token as string,
  };
}

const DEPOSIT_CREDIT_REF = 'DEPOSIT-CREDIT';

test.describe('Stage 25 — Money-path probes (COL-20/09/14/07, SEL-21) + COL-13x grid', () => {

  test('COL-20: void-and-reissue re-frees the deposit credit — reissued invoice re-draws it', async () => {
    // FIXED (issue #181): voidInvoice now reverses the DepositCreditApplication rows targeting
    // the voided invoice and voids its synthetic DEPOSIT-CREDIT payment, so the credit is
    // re-freed and the reissued invoice re-draws it.
    const seed = await seedStandardInvoiceFromDeposit(10_000, 30);

    // Invoice #1 carries the credit: deposit_credit > 0 + the synthetic DEPOSIT-CREDIT payment.
    const inv1 = seed.invoice;
    const credit1 = Number(inv1.deposit_credit);
    expect(credit1, 'invoice #1 drew a deposit credit').toBeGreaterThan(0);
    const synthetic1 = (inv1.payments ?? []).find(
      (p: any) => p.reference_number === DEPOSIT_CREDIT_REF && !p.voided_at,
    );
    expect(synthetic1, 'synthetic DEPOSIT-CREDIT payment exists on invoice #1').toBeTruthy();
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-20-created');

    // Send → void (void requires SENT; DRAFT → "Use DELETE").
    await api.sendInvoice(seed.invoiceId);
    const { res: voidRes, body: voidBody } = await api.voidInvoice(seed.invoiceId, 'COL-20 void-and-reissue probe');
    expect(voidRes.status()).toBe(200);
    expect(voidBody.invoice.status).toBe('VOIDED');

    // FIXED: voidInvoice now voids the synthetic DEPOSIT-CREDIT payment on the dead doc.
    const voided1 = await api.getInvoice(seed.invoiceId);
    const synthAfterVoid = (voided1.payments ?? []).find(
      (p: any) => p.reference_number === DEPOSIT_CREDIT_REF,
    );
    expect(synthAfterVoid?.voided_at ?? null, 'synthetic payment voided by invoice-void').not.toBeNull();
    // Reconcile still holds on the VOIDED doc.
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-20-voided');

    // Reissue: invoice #1 is VOIDED so the one-active-invoice 409 unlocks. The deposit invoice
    // is still PAID → create() finds it, and remainingDepositCredit = paid − ACTIVE apps > 0
    // because the DepositCreditApplication was reversed.
    const { res: inv2Res, body: inv2Body } = await api.createInvoice(seed.jobId);
    expect(inv2Res.status()).toBe(201);
    const inv2 = await api.getInvoice(inv2Body.invoice.id);

    // FIXED: invoice #2 re-draws the freed deposit credit.
    expect(Number(inv2.deposit_credit), 'reissued invoice re-draws the freed deposit credit').toBeGreaterThan(0);
    expect(Number(inv2.deposit_credit)).toBeCloseTo(credit1, 2);   // same credit, fully re-freed
    expect(Number(inv2.amount_due)).toBeLessThan(Number(inv2.total_amount));
    const synthetic2 = (inv2.payments ?? []).find(
      (p: any) => p.reference_number === DEPOSIT_CREDIT_REF && !p.voided_at,
    );
    expect(synthetic2, 'reissue has a live synthetic DEPOSIT-CREDIT payment').toBeTruthy();

    // Reconcile both documents.
    await assertInvoiceReconciles(api, inv2.id, 'COL-20-reissue');
    await assertInvoiceReconciles(api, seed.depositInvoice.id, 'COL-20-deposit');
  });

  test('COL-09: DELETE a DRAFT invoice carrying deposit credit → 500 (FK restrict on synthetic payment)', async () => {
    // PROBE — STATIC PREDICTION (catalog COL-09, map §6.9 / segments/04 §5 Q2). If this fails
    // at baseline, the prediction was wrong → investigate, flip the assertion, remove the flag.
    //
    // remove() (invoice.controller.ts ~692-708) is a bare `prisma.invoice.delete` behind a
    // DRAFT-only guard. A deposit-credited invoice is born (DRAFT) with a synthetic
    // DEPOSIT-CREDIT Payment row, and Payment.invoice is `onDelete: Restrict` (schema.prisma) —
    // the DepositCreditApplication target FK also defaults to Restrict. The delete throws
    // P2003 → catch-all → 500 'Internal server error', and the row survives (tx rollback).
    //
    // NOTE: this probe deliberately leaves an orphanish DRAFT invoice (plus its job/estimate
    // chain) in the run org — acceptable: the throwaway e2e-qa org is torn down after the run.
    const seed = await seedStandardInvoiceFromDeposit(8_000, 25);
    expect(seed.invoice.status).toBe('DRAFT'); // never sent — passes remove()'s DRAFT guard
    expect(Number(seed.invoice.deposit_credit)).toBeGreaterThan(0);

    // api.deleteInvoice discards the response body; raw() surfaces the 500 error shape.
    const { res, body } = await api.raw('delete', `/api/invoices/${seed.invoiceId}`);
    expect(res.status(), 'bare prisma delete hits the Payment FK restrict').toBe(500);
    expect(String(body.error)).toMatch(/internal server error/i);

    // Nothing was deleted: the DRAFT invoice still exists, credit + synthetic payment intact.
    const after = await api.getInvoice(seed.invoiceId);
    expect(after, 'invoice survived the failed delete').toBeTruthy();
    expect(after.status).toBe('DRAFT');
    expect(Number(after.deposit_credit)).toBe(Number(seed.invoice.deposit_credit));
    const synthetic = (after.payments ?? []).find(
      (p: any) => p.reference_number === DEPOSIT_CREDIT_REF && !p.voided_at,
    );
    expect(synthetic, 'synthetic DEPOSIT-CREDIT payment intact').toBeTruthy();

    // No money moved — the invariant holds on both documents.
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-09-survivor');
    await assertInvoiceReconciles(api, seed.depositInvoice.id, 'COL-09-deposit');

    flagKnownBug(test.info(), {
      id: 'COL-09',
      spec: 'map §6.9 / segments/04 Q2',
      current: 'DELETE on a DRAFT invoice carrying deposit credit 500s — bare prisma.invoice.delete '
        + 'vs Payment onDelete: Restrict (the synthetic DEPOSIT-CREDIT payment) + the '
        + 'DepositCreditApplication FK; the invoice is left undeletable with no usable error.',
      expected: 'DRAFT delete should either cascade-clean the synthetic payment + reverse the '
        + 'ledger row, or 400 with a clear message.',
    });
  });

  test('COL-14: generic record-payment on a kind=DEPOSIT invoice → PAID + estimate WON + lead WON', async () => {
    // FIXED #184: paying the deposit invoice via the generic door now cascades approve-win.
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    const dep = await api.getDepositInvoice(ctx.estimateId);
    expect(dep.kind).toBe('DEPOSIT');
    expect(dep.status).toBe('SENT');
    const depDue = Number(dep.amount_due);

    // GENERIC invoice payments door — NOT POST /api/estimates/:id/record-payment.
    const { res, body } = await api.recordPayment(dep.id, { amount: depDue, method: 'CHECK' });
    expect(res.status()).toBe(201);
    expect(body.invoice.status).toBe('PAID');
    expect(Number(body.invoice.amount_due)).toBe(0);

    // FIXED #184: paying the deposit invoice via the generic door cascades approve-win.
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status, 'estimate WON via the generic deposit-payment cascade').toBe('WON');
    expect(estimate.approved_at ?? null, 'approved_at stamped').not.toBeNull();
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status, 'lead WON').toBe('WON');

    await assertInvoiceReconciles(api, dep.id, 'COL-14-deposit');
  });

  test('COL-07: deposit re-paid AFTER invoice creation is never retroactively applied', async () => {
    // PROBE — STATIC PREDICTION (catalog COL-07, map §5 D8 / segments/04 §3 branch table:
    // "Deposit paid AFTER the final invoice was created is never retroactively applied").
    // If this fails at baseline, the prediction was wrong → investigate, flip the assertion,
    // remove the flag.
    //
    // REACHABILITY (verified in code — a reachable unpaid-deposit + existing-invoice sequence
    // EXISTS, so this probe uses it rather than the structural-absence fallback):
    //   The job-creation deposit gate (job.controller.ts ~469-478) blocks while the deposit
    //   invoice is DRAFT/SENT/PARTIAL, so on the FIRST pass a payable deposit can never coexist
    //   with an invoice (record-payment both PAYS the deposit and APPROVES the estimate;
    //   waive VOIDs it, making it unpayable — recordPayment requires SENT/PARTIAL).
    //   BUT: void-payment on the deposit's CHECK payment (the MON-18 cascade,
    //   invoice.controller.ts ~1761-1807) reopens the deposit invoice to SENT *after* the
    //   STANDARD invoice exists (reversing its drawdown + voiding its synthetic payment).
    //   The deposit is then payable again, with the invoice already created — the exact
    //   "deposit paid after invoice creation" shape.
    //
    // PREDICTION: re-paying the reopened deposit (generic record-payment) marks the deposit
    // PAID and touches NOTHING else. The credit attaches ONLY inside invoice create()
    // (~414-481); no other code path applies it, and NO re-apply endpoint exists —
    // invoice.routes.ts actions are exactly: send, resend, void, refund, credit (give-back,
    // NOT deposit re-application), void-payment, payments, notes, tags. Retroactive
    // application is structurally absent.
    const seed = await seedStandardInvoiceFromDeposit(12_000, 30);
    const invTotal = Number(seed.invoice.total_amount); // 12750
    const credit = Number(seed.invoice.deposit_credit); // 3825
    expect(credit).toBeGreaterThan(0);

    // Void the deposit's CHECK payment → deposit reopens to SENT; cascade un-applies the
    // credit on invoice #1 (amount_due back to full; synthetic payment voided; status
    // recomputed to SENT since raisedDue == total — runtime-verified shape per MON-18).
    const depInv = await api.getInvoice(seed.depositInvoice.id);
    const depPayment = (depInv.payments ?? []).find(
      (p: any) => !p.voided_at && p.reference_number !== DEPOSIT_CREDIT_REF,
    );
    expect(depPayment, 'manual deposit CHECK payment exists').toBeTruthy();
    const { res: voidRes } = await api.voidPayment(depInv.id, {
      payment_id: depPayment.id, void_category: 'BOUNCED', reason: 'COL-07 reopen the deposit',
    });
    expect(voidRes.status()).toBe(200);

    const depReopened = await api.getInvoice(depInv.id);
    expect(depReopened.status, 'deposit invoice payable again').toBe('SENT');
    const inv1AfterVoid = await api.getInvoice(seed.invoiceId);
    expect(Number(inv1AfterVoid.amount_due), 'credit un-applied → full balance').toBe(invTotal);
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-07-unapplied');
    await assertInvoiceReconciles(api, depInv.id, 'COL-07-deposit-reopened');

    // THE COL-07 MOMENT: the STANDARD invoice exists with an open balance, and the deposit is
    // now paid (again). Re-pay in full via the generic door (the estimate is already WON,
    // so the estimate record-payment door 400s here — generic is the only re-pay path).
    const { res: repayRes, body: repayBody } = await api.recordPayment(depInv.id, {
      amount: Number(depReopened.amount_due), method: 'CHECK',
      reference_number: `col07-${api.suffix}`,
    });
    expect(repayRes.status()).toBe(201);
    expect(repayBody.invoice.status).toBe('PAID');

    // PREDICTED bug state: nothing re-applies to the existing invoice.
    const inv1Final = await api.getInvoice(seed.invoiceId);
    // amount_due is STILL the full total — the freshly-paid deposit was not drawn down.
    expect(Number(inv1Final.amount_due), 'no retroactive credit application').toBe(invTotal);
    // No new live synthetic DEPOSIT-CREDIT payment appeared (all such rows remain voided).
    const liveSynthetics = (inv1Final.payments ?? []).filter(
      (p: any) => p.reference_number === DEPOSIT_CREDIT_REF && !p.voided_at,
    );
    expect(liveSynthetics, 'no new synthetic credit payment').toHaveLength(0);
    // The deposit_credit COLUMN is left stale at the original applied amount (the cascade
    // never resets it — display-only drift; the live ledger is payments[], which reconciles).
    expect(Number(inv1Final.deposit_credit)).toBe(credit);

    // Invariant holds on both documents even in the gap state: the re-paid deposit's money
    // sits as unapplied credit on the deposit invoice (remaining = paid − 0 active apps),
    // while the STANDARD invoice simply owes its full total.
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-07-final');
    await assertInvoiceReconciles(api, depInv.id, 'COL-07-deposit-final');

    flagKnownBug(test.info(), {
      id: 'COL-07',
      spec: 'map D8 / segments/04 §3',
      current: 'a deposit (re)paid after the STANDARD invoice exists is never retroactively '
        + 'applied — drawdown happens only inside invoice create(); no apply-credit endpoint '
        + 'exists (route table read), so the credit is parked until a void-and-reissue.',
      expected: 'paying a deposit while a live STANDARD invoice has an open balance should '
        + '(re)apply the credit to it, or an explicit apply-credit action should exist.',
    });
  });

  test('SEL-21: record-payment on a never-sent DRAFT estimate creates the deposit invoice + Payment row', async () => {
    // FIXED #183: recordEstimatePayment now find-or-creates the kind=DEPOSIT invoice (a never-sent
    // DRAFT has none yet — it was created only at send), opens it with amount_due = body.amount,
    // and ALWAYS writes the Payment row. Full coverage → invoice PAID, estimate WON, lead WON.
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    expect(estimate.status).toBe('DRAFT');
    const before = await api.getEstimate(estimate.id);
    expect((before.invoices ?? []).length, 'no deposit invoice before record-payment on DRAFT').toBe(0);

    const paidAmount = 750;
    // markDepositReceived posts to POST /api/estimates/:id/record-payment.
    const { res } = await api.markDepositReceived(estimate.id, {
      amount: paidAmount, payment_method: 'CHECK',
    });
    expect(res.status()).toBe(200);

    const after = await api.getEstimate(estimate.id);
    expect(after.status, 'estimate WON').toBe('WON');
    expect(after.approved_at).toBeTruthy();
    expect(after.public_token, 'archival token generated on the DRAFT path').toBeTruthy();

    // FIXED: a real kind=DEPOSIT invoice was lazily created, PAID, with the Payment row recorded.
    expect((after.invoices ?? []).length, 'deposit invoice created from DRAFT').toBe(1);
    const dep = after.invoices[0];
    expect(dep.kind, 'invoice kind DEPOSIT').toBe('DEPOSIT');
    expect(dep.status, 'deposit invoice PAID').toBe('PAID');
    expect(Number(dep.amount_due), 'amount_due 0 after full payment').toBe(0);
    expect(dep.payments?.length, 'a Payment row exists on the deposit invoice').toBeGreaterThanOrEqual(1);
    expect(Number(dep.payments[0].amount), 'payment amount matches recorded amount').toBe(paidAmount);

    const lead = await api.getLead(leadId);
    expect(lead.status).toBe('WON');

    // The deposit invoice now reconciles — the silent money gap is closed.
    await assertInvoiceReconciles(api, dep.id, 'SEL-21-deposit');
  });

  test('COL-13x: public-checkout 4xx guard grid — token presence → Stripe-configured → (404/status/org-CARD)', async () => {
    // NOT a probe — pins the EXACT createPublicCheckout guard contract in CONTROLLER ORDER
    // (invoice.controller.ts ~1195-1231):
    //   1. token PRESENCE        → 400 'Token required'
    //   2. isStripeConfigured()  → 400 'Card payments are not configured'   (!!STRIPE_SECRET_KEY)
    //   3. token RESOLUTION      → 404 'Invoice not found'
    //   4. status SENT/PARTIAL   → 400 'Invoice is not payable'
    //   5. org accepts CARD      → 400 'Card payments are not enabled for this organization'
    //
    // On staging Stripe is OFF (STRIPE_SECRET_KEY unset) → after the presence guard, EVERY
    // request dies at guard 2. Consequence: the catalog's "wrong token → 404" is only
    // observable with Stripe ON, because the token-RESOLUTION guard sits BEHIND the Stripe
    // guard (only the bare-PRESENCE check precedes it). Guards 4/5 are likewise unreachable
    // on staging and are exercised here only opportunistically when Stripe is configured.
    const seed = await seedSentStandardNoDeposit(1_500);
    expect(seed.invoice.status).toBe('SENT');
    expect(seed.publicToken).toBeTruthy();

    // (a) missing token → 400 'Token required' (presence guard is first, env-independent).
    const missing = await api.createInvoiceCheckout(seed.invoiceId, '');
    expect(missing.res.status()).toBe(400);
    expect(String(missing.body.error)).toMatch(/token required/i);

    // (b) wrong (but present) token. Stripe OFF → 400 not-configured (the 404 is MASKED by
    //     guard order); Stripe ON → 404 'Invoice not found'.
    const wrong = await api.createInvoiceCheckout(seed.invoiceId, `wrong-${api.suffix}`);
    expect([400, 404]).toContain(wrong.res.status());
    if (wrong.res.status() === 400) {
      // Expected staging shape: the Stripe guard fires before the token resolves.
      expect(String(wrong.body.error)).toMatch(/card payments are not configured/i);
    } else {
      // Stripe ON: the token-resolution guard is reachable → documented 404.
      expect(String(wrong.body.error)).toMatch(/not found/i);
    }

    // (c) valid token. Staging baseline: 400 'Card payments are not configured' (guards 4/5
    //     unreachable). If Stripe is unexpectedly ON, a checkout_url (org accepts CARD) or the
    //     org-CARD 400 comes back instead — then exercise the documented STATUS guard by
    //     voiding the invoice and retrying → 400 'Invoice is not payable' (guard 4 precedes
    //     guard 5, so this holds regardless of the org's CARD setting; public_token survives
    //     the void — voidInvoice never clears it).
    const valid = await api.createInvoiceCheckout(seed.invoiceId, seed.publicToken);
    if (valid.res.status() === 200 && valid.body.checkout_url) {
      // Stripe ON + org accepts CARD: a session was created (nothing recorded locally).
      const { res: voidRes } = await api.voidInvoice(seed.invoiceId, 'COL-13x status-guard probe');
      expect(voidRes.status()).toBe(200);
      const retried = await api.createInvoiceCheckout(seed.invoiceId, seed.publicToken);
      expect(retried.res.status()).toBe(400);
      expect(String(retried.body.error)).toMatch(/invoice is not payable/i);
    } else {
      expect(valid.res.status()).toBe(400);
      // Staging baseline = not-configured; org-CARD shape accepted only under Stripe ON.
      expect(String(valid.body.error)).toMatch(
        /card payments are not configured|card payments are not enabled for this organization/i,
      );
    }

    // No money moved by any checkout attempt (and a possible void changes no balances) —
    // the seeded invoice still reconciles.
    await assertInvoiceReconciles(api, seed.invoiceId, 'COL-13x');
  });
});
