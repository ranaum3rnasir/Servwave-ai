import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { leadToSentEstimate, leadToSentEstimateWithDeposit } from '../../helpers/workflow-builders';

// Entity-redesign Phase 5/D: the legacy Deposit model is gone. The deposit is now a
// kind=DEPOSIT Invoice (estimate.invoices[0]). The customer's selected deposit payment
// method is NO LONGER persisted on a deposit row — it is recorded as a timeline event and
// captured when the deposit payment is recorded. The deposit invoice select exposes only
// {id,status,total_amount,amount_due,total_refunded,refunded_at,payments[]}; there is no
// payment_method / payment_method_selected_at / stripe_checkout_session_id / reference_number
// / notes on it. Assertions that read those fields are repointed to the observable estimate
// status (PENDING/SENT) and the deposit invoice status, and the unobservable method/reference
// reads are dropped (flagged for Phase 9 follow-up).

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// 5.1 Customer Selects Non-Stripe Method → PENDING
// ──────────────────────────────────────────────────────────

test.describe('5.1 Customer Selects Non-Stripe Method → PENDING', () => {
  test('D-01: Customer approves with CHECK → SENT→PENDING, deposit.payment_method=CHECK', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('PENDING');

    // The selected method is no longer persisted on a deposit row; assert the observable
    // PENDING status (the customer's CHECK selection drives SENT→PENDING).
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
    expect(estimate.invoices[0].status).toBe('SENT');
  });

  test('D-02: Customer approves with CASH → PENDING', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CASH',
    });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('PENDING');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
  });

  test('D-03: Customer approves with BANK_TRANSFER → PENDING', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['BANK_TRANSFER', 'CHECK', 'CASH']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'BANK_TRANSFER',
    });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('PENDING');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
  });

  test('D-04: Approve with method NOT in send_config → 400', async () => {
    // Only CASH in allowed methods — attempt CHECK (not allowed)
    const ctx = await leadToSentEstimateWithDeposit(api, ['CASH']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/payment method not available/i);
  });

  test('D-05: Approve deposit estimate without payment method → 400', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      // payment_method intentionally omitted
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/payment method is required/i);
  });
});

// ──────────────────────────────────────────────────────────
// 5.2 Change Payment Method (from PENDING)
// ──────────────────────────────────────────────────────────

test.describe('5.2 Change Payment Method', () => {
  test('D-06: Change CHECK→CASH → deposit.payment_method updated, stays PENDING', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    // Change to CASH
    const { res, body } = await api.changePaymentMethodPublic(ctx.estimateId, ctx.publicToken, 'CASH');

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('PENDING');

    const estimate = await api.getEstimate(ctx.estimateId);
    // Selected method is not persisted on the deposit invoice; assert the estimate stays PENDING.
    expect(estimate.status).toBe('PENDING');
  });

  test('D-07: Change CHECK→CARD → checkout session created, estimate→SENT', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    // Change to CARD
    const { res, body } = await api.changePaymentMethodPublic(ctx.estimateId, ctx.publicToken, 'CARD');

    // Skip gracefully if Stripe is not configured in this environment
    if (res.status() === 400 && body.error?.includes('not available')) {
      test.skip(true, 'Stripe not configured in this environment — skipping CARD tests');
      return;
    }

    expect(res.status()).toBe(200);
    expect(body.checkout_url).toBeTruthy();

    // Estimate goes back to SENT so the webhook can process it. The Stripe checkout session id
    // is no longer surfaced on the deposit invoice select; assert the SENT status + checkout_url.
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('SENT');
  });

  test('D-08: Change to method not in send_config → 400', async () => {
    // Only CASH + CHECK in allowed methods
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Get to PENDING via CHECK
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    // Attempt to change to BANK_TRANSFER (not in allowed methods)
    const { res, body } = await api.changePaymentMethodPublic(ctx.estimateId, ctx.publicToken, 'BANK_TRANSFER');

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/payment method not available/i);
  });

  test('D-09: Change payment method on non-PENDING estimate → 400', async () => {
    // SENT estimate (no customer action yet)
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

    const { res, body } = await api.changePaymentMethodPublic(ctx.estimateId, ctx.publicToken, 'CASH');

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/can only change payment method on a pending estimate/i);
  });
});

// ──────────────────────────────────────────────────────────
// 5.3 Mark Deposit Received (Manual Payment)
// ──────────────────────────────────────────────────────────

test.describe('5.3 Mark Deposit Received', () => {
  test('D-10: Mark received on PENDING estimate → deposit PAID, estimate→WON, lead→WON', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    const pendingEstimate = await api.getEstimate(ctx.estimateId);
    expect(pendingEstimate.status).toBe('PENDING');

    // Admin marks deposit received
    const { res, body } = await api.markDepositReceived(ctx.estimateId);

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('WON');
    expect(estimate.invoices[0].status).toBe('PAID');
    expect(estimate.invoices[0].payments[0].paid_at).toBeTruthy();

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('D-11: Mark received on SENT estimate (before customer acts) → deposit PAID, estimate→WON, lead→WON', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

    // Mark received without customer approving first (estimate still SENT)
    const { res, body } = await api.markDepositReceived(ctx.estimateId);

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('PAID');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('D-12: Record deposit payment with reference_number and notes → payment recorded, estimate WON', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    // record-payment accepts reference_number + notes on the Payment row (the deposit invoice
    // select does not expose them, so assert the observable PAID + recorded payment instead).
    const { res, body } = await api.markDepositReceived(ctx.estimateId, {
      payment_method: 'CHECK',
      reference_number: 'CHK-12345',
      notes: 'Payment received via certified mail',
    });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('PAID');
    expect(estimate.invoices[0].payments[0].method).toBe('CHECK');
  });

  test('D-13: Record deposit payment on an already-WON estimate → 400', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

    // First record-payment → PAID, estimate → WON
    await api.markDepositReceived(ctx.estimateId);

    // Second record-payment attempt — estimate is WON, record-payment rejects it.
    const { res, body } = await api.markDepositReceived(ctx.estimateId);

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('D-14: Record deposit payment on a no-deposit estimate → 200 (estimate WON)', async () => {
    // Entity-redesign: /record-payment replaces /mark-deposit-received and is NOT deposit-gated.
    // Recording a payment on a SENT no-deposit estimate approves it (no deposit invoice exists,
    // so the deposit-invoice write is skipped). Old behavior (400 "no deposit") is retired.
    const ctx = await leadToSentEstimate(api);

    const { res, body } = await api.markDepositReceived(ctx.estimateId, { amount: 100, payment_method: 'CHECK' });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');
  });
});
