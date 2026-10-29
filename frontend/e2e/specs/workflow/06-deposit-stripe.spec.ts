import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { leadToSentEstimateWithDeposit } from '../../helpers/workflow-builders';

// Entity-redesign Phase 5/D: the deposit is a kind=DEPOSIT Invoice (estimate.invoices[0]).
// The Stripe deposit checkout now carries metadata.invoiceId (the deposit invoice), so the
// webhook is fired via fireStripeInvoiceWebhook(depositInvoiceId, ...). The expected
// checkout total = amount_due, face value (matches createPublicCheckout + the webhook's
// amount-verification). The deposit invoice select no longer exposes
// payment_method / stripe_checkout_session_id, so those reads are dropped (flagged).

let api: ApiClient;
let stripeAvailable = false;

/** Expected Stripe checkout total in cents for a deposit invoice (face value, amount_due). */
function checkoutCents(amountDue: number): number {
  return Math.round(amountDue * 100);
}

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // Probe whether Stripe is configured by attempting a CARD approval.
  const probeCtx = await leadToSentEstimateWithDeposit(api, ['CARD']);
  const { res } = await api.approveEstimatePublic(probeCtx.estimateId, probeCtx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CARD',
  });
  stripeAvailable = res.status() === 200;
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// Section 6: Stripe Deposit Flow
// ──────────────────────────────────────────────────────────

test.describe('6. Stripe Deposit Flow', () => {
  test('STR-01: Customer selects CARD → checkout session created', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CARD', 'CHECK']);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    });

    expect(res.status()).toBe(200);
    expect(body.checkout_url).toBeTruthy();

    // Estimate stays SENT (not PENDING) for the Stripe branch; deposit invoice stays SENT.
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('SENT');
    expect(estimate.invoices[0].status).toBe('SENT');
  });

  test('STR-02: Stripe webhook fires → deposit PAID, estimate WON, lead WON', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);

    // Customer selects CARD → checkout session
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    });

    // Read the deposit invoice and compute the expected checkout total.
    const estimate = await api.getEstimate(ctx.estimateId);
    const depInv = estimate.invoices[0];
    expect(depInv).toBeTruthy();

    // Fire simulated Stripe webhook keyed on the deposit invoice id.
    const { res, body } = await api.fireStripeInvoiceWebhook({
      invoiceId: depInv.id,
      amount_total: checkoutCents(Number(depInv.amount_due)),
    });

    expect(res.status()).toBe(200);
    expect(body.received).toBe(true);

    // Verify final state
    const finalEstimate = await api.getEstimate(ctx.estimateId);
    expect(finalEstimate.status).toBe('WON');
    expect(finalEstimate.invoices[0].status).toBe('PAID');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('STR-03: Webhook with mismatched amount → no state change (webhook recorded silently)', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);

    // Customer selects CARD
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    });

    const estimate = await api.getEstimate(ctx.estimateId);
    const depInv = estimate.invoices[0];
    // Deliberately wrong amount.
    const wrongTotal = checkoutCents(Number(depInv.amount_due)) + 999;

    const { res, body } = await api.fireStripeInvoiceWebhook({
      invoiceId: depInv.id,
      amount_total: wrongTotal,
    });

    // Webhook always returns 200 (amount mismatch is logged, not rejected)
    expect(res.status()).toBe(200);
    expect(body.received).toBe(true);

    // Estimate and deposit invoice should NOT have changed state
    const finalEstimate = await api.getEstimate(ctx.estimateId);
    expect(finalEstimate.status).toBe('SENT');
    expect(finalEstimate.invoices[0].status).toBe('SENT');
  });

  test('STR-04: Webhook with duplicate event ID → 200 with duplicate:true', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);

    // Customer selects CARD
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    });

    const estimate = await api.getEstimate(ctx.estimateId);
    const depInv = estimate.invoices[0];
    const amount_total = checkoutCents(Number(depInv.amount_due));

    // First webhook — success
    const first = await api.fireStripeInvoiceWebhook({
      invoiceId: depInv.id,
      amount_total,
    });
    expect(first.res.status()).toBe(200);
    expect(first.body.received).toBe(true);

    // Second webhook with SAME event ID → duplicate
    const { request } = await import('@playwright/test');
    const noAuthCtx = await request.newContext({ baseURL: 'http://localhost:3000' });
    const res2 = await noAuthCtx.post('/api/webhooks/stripe', {
      headers: { 'stripe-signature': 'test_bypass', 'content-type': 'application/json' },
      data: JSON.stringify({
        id: first.eventId,   // same event ID — idempotency key
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { invoiceId: depInv.id },
            amount_total,
            payment_intent: `pi_test_dup_${Date.now()}`,
          },
        },
      }),
    });
    const body2 = await res2.json();
    await noAuthCtx.dispose();

    expect(res2.status()).toBe(200);
    expect(body2.duplicate).toBe(true);
  });

  test('STR-05: Abandoned checkout (no webhook) → deposit stays SENT, estimate stays SENT', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);

    // Customer selects CARD → checkout session created
    const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    });
    expect(approveRes.status()).toBe(200);

    // No webhook fired — simply check state is unchanged
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('SENT');
    expect(estimate.invoices[0].status).toBe('SENT');
  });

  test('STR-06: PENDING→change to CARD→webhook → full flow', async () => {
    if (!stripeAvailable) {
      test.skip(true, 'Stripe not configured in this environment');
      return;
    }

    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CARD', 'CASH']);

    // Customer selects CHECK → PENDING
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });

    const pendingEstimate = await api.getEstimate(ctx.estimateId);
    expect(pendingEstimate.status).toBe('PENDING');

    // Customer changes to CARD → SENT + checkout session
    const { res: changeRes, body: changeBody } = await api.changePaymentMethodPublic(
      ctx.estimateId, ctx.publicToken, 'CARD'
    );
    expect(changeRes.status()).toBe(200);
    expect(changeBody.checkout_url).toBeTruthy();

    const sentEstimate = await api.getEstimate(ctx.estimateId);
    expect(sentEstimate.status).toBe('SENT');

    // Webhook fires
    const depInv = sentEstimate.invoices[0];
    const amount_total = checkoutCents(Number(depInv.amount_due));

    const { res: webhookRes, body: webhookBody } = await api.fireStripeInvoiceWebhook({
      invoiceId: depInv.id,
      amount_total,
    });

    expect(webhookRes.status()).toBe(200);
    expect(webhookBody.received).toBe(true);

    // Final state: WON, deposit invoice PAID
    const finalEstimate = await api.getEstimate(ctx.estimateId);
    expect(finalEstimate.status).toBe('WON');
    expect(finalEstimate.invoices[0].status).toBe('PAID');

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });
});
