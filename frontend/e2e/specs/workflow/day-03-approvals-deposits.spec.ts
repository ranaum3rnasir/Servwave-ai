import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createContactedLead,
  createTaxExemptCustomerWithLocation,
  leadToSentEstimateWithDeposit,
} from '../../helpers/workflow-builders';

// ──────────────────────────────────────────────────────────
// Day 3 — Late morning: Customers approve estimates.
// Multiple deposit flows: CHECK, CARD/Stripe, tax-exempt,
// waiver, and payment-method changes.
// ──────────────────────────────────────────────────────────

let api: ApiClient;
let stripeAvailable = false;

// Shared state across tests
let sarahEstimateId: string;
let sarahPublicToken: string;
let sarahDepositId: string;

let apexEstimateId: string;
let apexPublicToken: string;
let apexDepositId: string;
let apexDepositAmountCents: number;

let austinIsdCustomerId: string;
let austinIsdLocationId: string;
let taxExemptEstimateId: string;
let taxExemptPublicToken: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  await api.cleanup();

  // Probe Stripe availability
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
// 1. Sarah approves estimate with CHECK deposit
// ──────────────────────────────────────────────────────────

test('Sarah approves estimate with CHECK deposit', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CARD']);
  sarahEstimateId = ctx.estimateId;
  sarahPublicToken = ctx.publicToken;

  const { res, body } = await api.approveEstimatePublic(sarahEstimateId, sarahPublicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  expect(res.status()).toBe(200);

  const estimate = await api.getEstimate(sarahEstimateId);
  expect(estimate.status).toBe('PENDING');
  // Selected method is no longer persisted on the deposit invoice; assert PENDING + capture the
  // deposit invoice id (entity-redesign: deposit = kind=DEPOSIT invoice at estimate.invoices[0]).
  expect(estimate.invoices[0].status).toBe('SENT');
  sarahDepositId = estimate.invoices[0].id;
});

// ──────────────────────────────────────────────────────────
// 2. Amanda marks Sarah's deposit received — estimate WON
// ──────────────────────────────────────────────────────────

test('Amanda marks Sarah\'s deposit received — estimate WON', async () => {
  const { res, body } = await api.markDepositReceived(sarahEstimateId, {
    reference_number: 'CHK-1247',
  });
  expect(res.status()).toBe(200);

  const estimate = await api.getEstimate(sarahEstimateId);
  expect(estimate.status).toBe('WON');
  expect(estimate.invoices[0].status).toBe('PAID');

  const lead = await api.getLead(estimate.lead_id);
  expect(lead.status).toBe('WON');
});

// ──────────────────────────────────────────────────────────
// 3. Apex approves via Stripe CARD — checkout URL returned
// ──────────────────────────────────────────────────────────

test('Apex approves via Stripe CARD — checkout URL returned', async () => {
  if (!stripeAvailable) {
    test.skip(true, 'Stripe not configured in this environment');
    return;
  }

  const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);
  apexEstimateId = ctx.estimateId;
  apexPublicToken = ctx.publicToken;

  const { res, body } = await api.approveEstimatePublic(apexEstimateId, apexPublicToken, {
    signature_data: api.testSignature,
    payment_method: 'CARD',
  });
  expect(res.status()).toBe(200);
  expect(body.checkout_url).toBeTruthy();

  const estimate = await api.getEstimate(apexEstimateId);
  apexDepositId = estimate.invoices[0].id;
  // Expected Stripe checkout total = amount_due, face value.
  const amountDue = Number(estimate.invoices[0].amount_due);
  apexDepositAmountCents = Math.round(amountDue * 100);
});

// ──────────────────────────────────────────────────────────
// 4. Stripe webhook confirms Apex deposit — estimate WON
// ──────────────────────────────────────────────────────────

test('Stripe webhook confirms Apex deposit — estimate WON', async () => {
  if (!stripeAvailable) {
    test.skip(true, 'Stripe not configured in this environment');
    return;
  }

  const { res } = await api.fireStripeInvoiceWebhook({
    invoiceId: apexDepositId,
    amount_total: apexDepositAmountCents,
  });
  expect(res.status()).toBe(200);

  const estimate = await api.getEstimate(apexEstimateId);
  expect(estimate.status).toBe('WON');
  expect(estimate.invoices[0].status).toBe('PAID');
});

// ──────────────────────────────────────────────────────────
// 5. Create Austin ISD — tax-exempt government customer
// ──────────────────────────────────────────────────────────

test('create Austin ISD — tax-exempt government customer', async () => {
  const { customerId, locationId } = await createTaxExemptCustomerWithLocation(api);
  austinIsdCustomerId = customerId;
  austinIsdLocationId = locationId;
  expect(austinIsdCustomerId).toBeTruthy();
  expect(austinIsdLocationId).toBeTruthy();
});

// ──────────────────────────────────────────────────────────
// 6. Tax-exempt estimate — zero tax on all items
// ──────────────────────────────────────────────────────────

test('tax-exempt estimate — zero tax on all items', async () => {
  // Create a contacted lead for Austin ISD
  const { body: leadBody } = await api.createLead({
    customer_id: austinIsdCustomerId,
    service_request: `AISD HVAC maintenance ${api.suffix}`,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);

  // Create estimate with tax_rate: 0 (tax-exempt)
  const { res, body } = await api.createEstimate({
    lead_id: leadId,
    line_items: [
      { description: 'RTU inspection & filter replacement', quantity: 3, unit_price: 450, is_taxable: true },
      { description: 'Refrigerant recharge R-410A', quantity: 1, unit_price: 280, is_taxable: true },
    ],
    tax_rate: 0,
    scope_notes: 'Annual HVAC maintenance — Austin ISD campus',
  });
  expect(res.status()).toBe(201);

  const estimate = body.estimate;
  taxExemptEstimateId = estimate.id;
  expect(Number(estimate.tax_amount)).toBe(0);

  const subtotal = Number(estimate.subtotal);
  const total = Number(estimate.total_amount);
  expect(total).toBe(subtotal);
});

// ──────────────────────────────────────────────────────────
// 7. Send and approve tax-exempt estimate (no deposit, NET 60)
// ──────────────────────────────────────────────────────────

test('send and approve tax-exempt estimate (no deposit, NET 60)', async () => {
  const { res: sendRes, body: sendBody } = await api.sendEstimate(taxExemptEstimateId, {
    deposit_required: false,
  });
  expect(sendRes.status()).toBe(200);
  taxExemptPublicToken = sendBody.estimate.public_token;
  expect(taxExemptPublicToken).toBeTruthy();

  const { res: approveRes } = await api.approveEstimatePublic(taxExemptEstimateId, taxExemptPublicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);

  const estimate = await api.getEstimate(taxExemptEstimateId);
  expect(estimate.status).toBe('WON');

  const lead = await api.getLead(estimate.lead_id);
  expect(lead.status).toBe('WON');
});

// ──────────────────────────────────────────────────────────
// 8. Deposit waived by Marcus for trusted customer
// ──────────────────────────────────────────────────────────

test('deposit waived by Marcus for trusted customer', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api);
  const waivedEstimateId = ctx.estimateId;

  // Approve with CHECK first (customer selects offline payment)
  await api.approveEstimatePublic(waivedEstimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });

  // Marcus waives the deposit for a trusted customer
  const { res } = await api.waiveDeposit(waivedEstimateId, 'waive');
  expect(res.status()).toBe(200);

  const estimate = await api.getEstimate(waivedEstimateId);
  expect(estimate.status).toBe('WON');
  expect(estimate.invoices[0].status).toBe('VOIDED');

  const lead = await api.getLead(estimate.lead_id);
  expect(lead.status).toBe('WON');
});

// ──────────────────────────────────────────────────────────
// 9. Customer changes payment method CHECK → CASH before paying
// ──────────────────────────────────────────────────────────

test('customer changes payment method CHECK → CASH before paying', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

  // Customer approves with CHECK
  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  expect(approveRes.status()).toBe(200);

  // Customer changes mind — switch to CASH
  const { res: changeRes } = await api.changePaymentMethodPublic(ctx.estimateId, ctx.publicToken, 'CASH');
  expect(changeRes.status()).toBe(200);

  // Amanda marks the CASH deposit received
  const { res: receivedRes } = await api.markDepositReceived(ctx.estimateId);
  expect(receivedRes.status()).toBe(200);

  const estimate = await api.getEstimate(ctx.estimateId);
  expect(estimate.status).toBe('WON');
  expect(estimate.invoices[0].status).toBe('PAID');
  // Recorded payment method lives on the Payment row; assert the deposit payment was recorded.
  expect(estimate.invoices[0].payments[0]).toBeTruthy();
});
