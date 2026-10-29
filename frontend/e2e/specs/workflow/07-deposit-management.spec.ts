import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { leadToSentEstimate, leadToSentEstimateWithDeposit } from '../../helpers/workflow-builders';

// Entity-redesign Phase 5/D: the legacy Deposit model is gone. The deposit is now a
// kind=DEPOSIT Invoice exposed at estimate.invoices[0]. Deposit state is read off that
// invoice (status: DRAFT/SENT/PAID/VOIDED/REFUNDED/PARTIALLY_REFUNDED), the deposit is
// "received" via POST /:id/record-payment, and the deposit refund is the unified Invoice
// refund (POST /api/invoices/:id/refund). The removed routes /:id/refund-deposit and
// /:id/reactivate-deposit are gone (404).
//
// NOTE (flagged): the unified invoice refund returns { success, refund } and does NOT
// cancel the parent estimate (the old refund-deposit folded a cancel; the new generalized
// refund does not). Assertions now target the deposit invoice (REFUNDED) and the refund
// row, not estimate→ARCHIVED.

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// 7.1 Waive Deposit
// ──────────────────────────────────────────────────────────

test.describe('7.1 Waive Deposit', () => {
  test('DM-01: Waive (action=waive) on SENT estimate → deposit invoice VOIDED, estimate WON, lead WON', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'waive');

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('WON');
    expect(estimate.invoices[0].status).toBe('VOIDED');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('DM-02: Waive (action=waive) on PENDING estimate → deposit invoice VOIDED, estimate WON, lead WON', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    const pending = await api.getEstimate(ctx.estimateId);
    expect(pending.status).toBe('PENDING');

    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'waive');

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('VOIDED');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('DM-03: Waive (action=cancel) on SENT estimate → deposit invoice VOIDED, estimate ARCHIVED', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'cancel');

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('ARCHIVED');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('ARCHIVED');
    expect(estimate.invoices[0].status).toBe('VOIDED');
  });

  test('DM-04: Waive (action=cancel) on PENDING estimate → deposit invoice VOIDED, estimate ARCHIVED', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Customer selects CASH → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CASH',
    });

    const pending = await api.getEstimate(ctx.estimateId);
    expect(pending.status).toBe('PENDING');

    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'cancel');

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('ARCHIVED');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('VOIDED');
  });

  test('DM-05: Waive on WON estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);

    // Approve without deposit
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    const approved = await api.getEstimate(ctx.estimateId);
    expect(approved.status).toBe('WON');

    // Attempt waive on WON (no active deposit)
    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'waive');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────
// 7.2 Refund Deposit (unified invoice refund on the kind=DEPOSIT invoice)
// ──────────────────────────────────────────────────────────

test.describe('7.2 Refund Deposit', () => {
  test('DM-06: Refund PAID deposit (non-Stripe) → deposit invoice REFUNDED', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Record the deposit payment (SENT → PAID; estimate → WON).
    await api.markDepositReceived(ctx.estimateId);

    const paid = await api.getEstimate(ctx.estimateId);
    expect(paid.status).toBe('WON');
    expect(paid.invoices[0].status).toBe('PAID');

    // Refund the deposit via the unified invoice refund (CUSTOMER_CANCELLATION → CUSTOMER_REQUEST).
    const { res } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Customer cancelled the job',
      reason_category: 'CUSTOMER_CANCELLATION',
    });

    expect(res.status()).toBe(200);

    const estimate = await api.getEstimate(ctx.estimateId);
    // The deposit invoice is now REFUNDED; the unified refund does NOT cancel the estimate.
    expect(estimate.invoices[0].status).toBe('REFUNDED');
    expect(Number(estimate.invoices[0].total_refunded)).toBeGreaterThan(0);
    expect(estimate.invoices[0].refunded_at).toBeTruthy();
  });

  test('DM-07: Refund PAID deposit (Stripe) → skipped (no real payment_intent in test env)', async () => {
    // The refund execution keys off the source payment's stripe_payment_intent_id. In the
    // test environment there is no real Stripe payment intent, so a CARD-paid deposit refund
    // would call the real Stripe API. Kept skipped (no mock bypass).
    test.skip(true, 'Stripe refund requires real payment_intent — no mock bypass available in test env');
  });

  test('DM-08: Refund non-PAID (SENT, unpaid) deposit invoice → 4xx', async () => {
    // Deposit invoice in SENT state (just sent, no payment recorded).
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

    const { res, body } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Should fail',
      reason_category: 'OTHER',
    });

    // The unified refund rejects a non-PAID invoice (message: "Invoice must be PAID to refund").
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────
// 7.3 Refund Guards
// ──────────────────────────────────────────────────────────

test.describe('7.3 Refund Guards', () => {
  test('DM-09: Refund VOIDED deposit invoice → 4xx', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

    // Waive (cancel) → deposit invoice VOIDED
    await api.waiveDeposit(ctx.estimateId, 'cancel');

    const voided = await api.getEstimate(ctx.estimateId);
    expect(voided.invoices[0].status).toBe('VOIDED');

    const { res, body } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Should fail',
      reason_category: 'OTHER',
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });

  test('DM-10: Refund already-REFUNDED deposit invoice → 4xx (nothing left to refund)', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

    // Record payment → PAID, then refund → REFUNDED
    await api.markDepositReceived(ctx.estimateId);
    await api.refundDeposit(ctx.estimateId, {
      reason: 'First refund',
      reason_category: 'CUSTOMER_CANCELLATION',
    });

    const refunded = await api.getEstimate(ctx.estimateId);
    expect(refunded.invoices[0].status).toBe('REFUNDED');

    // Second refund attempt → rejected (no remaining net-paid balance).
    const { res, body } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Second refund — should fail',
      reason_category: 'OTHER',
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────
// 7.4 Reactivate Deposit — FLOW REMOVED (entity-redesign Phase 5)
// ──────────────────────────────────────────────────────────
//
// The POST /api/estimates/:id/reactivate-deposit route was removed. There is NO in-place
// "reactivate" of a voided deposit in the new model: the deposit invoice is voided and a
// fresh one is reissued by revising the estimate (SENT→DRAFT) and re-sending. The original
// DM-11..DM-14 cases asserted a fabricated flow and have been removed.
//
// The nearest "bring the deposit back" equivalent is exercised in the QA checklist
// (§10 Estimate Revise): waive(cancel) → revise → re-send with deposit → record-payment.
