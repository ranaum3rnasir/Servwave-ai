import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createContactedLead,
  createNewLead,
  createDraftEstimate,
  createTech,
  createSalesUser,
  leadToSentEstimate,
  leadToSentEstimateWithDeposit,
  leadToWalkthroughCompleted,
} from '../../helpers/workflow-builders';

let api: ApiClient;
let stripeAvailable = false;

test.beforeAll(async () => {
  api = await new ApiClient().init();

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
// E2E-01: New customer → full flow → Job SCHEDULED (no deposit)
// ──────────────────────────────────────────────────────────

test('E2E-01: New customer → Contact → Walkthrough → Estimate → Send (no deposit) → Approve → Job → Assign → SCHEDULED', async () => {
  // Create customer + lead
  const { customerId } = await createCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId,
    service_request: `E2E-01 ${api.suffix}`,
  });
  const leadId = leadBody.lead.id;
  expect(leadBody.lead.status).toBe('NEW');

  // Contact
  const { res: cRes } = await api.contactLead(leadId);
  expect(cRes.status()).toBe(200);
  const leadAfterContact = await api.getLead(leadId);
  expect(leadAfterContact.status).toBe('CONTACTED');

  // Schedule walkthrough
  const salesId = await createSalesUser(api);
  const { res: wtSchedRes } = await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: salesId,
  });
  expect(wtSchedRes.status()).toBe(200);
  const leadAfterSched = await api.getLead(leadId);
  expect(leadAfterSched.status).toBe('WALKTHROUGH_SCHEDULED');

  // Complete walkthrough
  const { res: wtCompRes } = await api.completeWalkthrough(leadId);
  expect(wtCompRes.status()).toBe(200);
  const leadAfterComplete = await api.getLead(leadId);
  expect(leadAfterComplete.status).toBe('WALKTHROUGH_COMPLETED');

  // Create estimate
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'HVAC Repair', quantity: 1, unit_price: 800, is_taxable: true }],
    tax_rate: 0.0825,
    scope_notes: 'E2E-01 estimate',
  });
  const estimateId = estBody.estimate.id;
  expect(estBody.estimate.status).toBe('DRAFT');

  // Send (no deposit)
  const { res: sendRes, body: sendBody } = await api.sendEstimate(estimateId, {
    deposit_required: false,
  });
  expect(sendRes.status()).toBe(200);
  expect(sendBody.estimate.status).toBe('SENT');
  const publicToken = sendBody.estimate.public_token;
  expect(publicToken).toBeTruthy();
  const leadAfterSend = await api.getLead(leadId);
  expect(leadAfterSend.status).toBe('ESTIMATED');

  // Customer approves
  const { res: approveRes } = await api.approveEstimatePublic(estimateId, publicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const estimateAfterApprove = await api.getEstimate(estimateId);
  expect(estimateAfterApprove.status).toBe('WON');
  const leadAfterApprove = await api.getLead(leadId);
  expect(leadAfterApprove.status).toBe('WON');

  // Create job
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: estimateId });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;
  expect(jobBody.job.status).toBe('UNASSIGNED');

  // Assign to tech
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  // Final verification
  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
  expect(finalJob.assigned_to).toBe(techId);
});

// ──────────────────────────────────────────────────────────
// E2E-02: Existing customer → deposit (CHECK) → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-02: Existing customer → Contact → Walkthrough → Send (deposit CHECK/CASH) → Approve (CHECK) → Mark received → Job → SCHEDULED', async () => {
  // Create customer with location first (existing customer scenario)
  const { customerId } = await createCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId,
    service_request: `E2E-02 ${api.suffix}`,
  });
  const leadId = leadBody.lead.id;

  // Contact
  await api.contactLead(leadId);
  const leadAfterContact = await api.getLead(leadId);
  expect(leadAfterContact.status).toBe('CONTACTED');

  // Walkthrough
  const salesId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: salesId,
  });
  await api.completeWalkthrough(leadId);
  const leadAfterWt = await api.getLead(leadId);
  expect(leadAfterWt.status).toBe('WALKTHROUGH_COMPLETED');

  // Create + send estimate with deposit (CHECK, CASH)
  const estimate = await createDraftEstimate(api, leadId);
  const { body: sendBody } = await api.sendEstimate(estimate.id, {
    deposit_required: true,
    payment_methods: ['CHECK', 'CASH'],
  });
  const publicToken = sendBody.estimate.public_token;
  const estimateId = estimate.id;
  const estAfterSend = await api.getEstimate(estimateId);
  expect(estAfterSend.status).toBe('SENT');
  expect(estAfterSend.invoices[0]).toBeTruthy();

  // Customer approves with CHECK → PENDING
  const { res: approveRes } = await api.approveEstimatePublic(estimateId, publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  expect(approveRes.status()).toBe(200);
  const estPending = await api.getEstimate(estimateId);
  expect(estPending.status).toBe('PENDING');
  // Selected method no longer persisted on the deposit invoice; assert the PENDING status.
  expect(estPending.invoices[0].status).toBe('SENT');

  // Admin marks deposit received → WON
  const { res: markRes } = await api.markDepositReceived(estimateId);
  expect(markRes.status()).toBe(200);
  const estApproved = await api.getEstimate(estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadAfterApprove = await api.getLead(leadId);
  expect(leadAfterApprove.status).toBe('WON');

  // Create job
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: estimateId });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;

  // Assign to tech
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-03: Deposit via CARD (Stripe) → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-03: Lead → Walkthrough → Send (deposit CARD) → Approve (CARD) → Stripe webhook → Job → SCHEDULED', async () => {
  if (!stripeAvailable) {
    test.skip(true, 'Stripe not configured in this environment');
    return;
  }

  const { leadId } = await leadToWalkthroughCompleted(api);
  const estimate = await createDraftEstimate(api, leadId);
  const { body: sendBody } = await api.sendEstimate(estimate.id, {
    deposit_required: true,
    payment_methods: ['CARD'],
  });
  const publicToken = sendBody.estimate.public_token;
  const estimateId = estimate.id;

  // Customer selects CARD → checkout session
  const { res: approveRes, body: approveBody } = await api.approveEstimatePublic(estimateId, publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CARD',
  });
  expect(approveRes.status()).toBe(200);
  expect(approveBody.checkout_url).toBeTruthy();
  const estAfterCard = await api.getEstimate(estimateId);
  expect(estAfterCard.status).toBe('SENT');
  expect(estAfterCard.invoices[0].status).toBe('SENT');

  // Simulate the Stripe webhook keyed on the deposit invoice id (amount_due, face value).
  const deposit = estAfterCard.invoices[0];
  const depositAmount = Number(deposit.amount_due);
  const amount_total = Math.round(depositAmount * 100);

  const { res: webhookRes } = await api.fireStripeInvoiceWebhook({
    invoiceId: deposit.id,
    amount_total,
  });
  expect(webhookRes.status()).toBe(200);

  const estApproved = await api.getEstimate(estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadAfterWebhook = await api.getLead(leadId);
  expect(leadAfterWebhook.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
  const jobId = jobBody.job.id;
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-04: Deposit waived (action=waive) → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-04: Lead → Walkthrough → Send (deposit) → Admin waives (waive) → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');
  expect(estSent.invoices[0]).toBeTruthy();

  // Admin waives deposit
  const { res: waiveRes, body: waiveBody } = await api.waiveDeposit(ctx.estimateId, 'waive');
  expect(waiveRes.status()).toBe(200);
  expect(waiveBody.estimate.status).toBe('WON');

  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('VOIDED');
  const leadAfterWaive = await api.getLead(ctx.leadId);
  expect(leadAfterWaive.status).toBe('WON');

  // Create job + assign
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;

  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-05: Customer changes payment method CHECK→CASH → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-05: Send (deposit CHECK/CARD/CASH) → Approve (CHECK) → Change to CASH → Mark received → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CARD', 'CASH']);

  // Customer approves with CHECK → PENDING
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  const estPending = await api.getEstimate(ctx.estimateId);
  expect(estPending.status).toBe('PENDING');

  // Customer changes to CASH
  const { res: changeRes, body: changeBody } = await api.changePaymentMethodPublic(
    ctx.estimateId, ctx.publicToken, 'CASH'
  );
  expect(changeRes.status()).toBe(200);
  expect(changeBody.estimate.status).toBe('PENDING');
  const estAfterChange = await api.getEstimate(ctx.estimateId);
  // Selected method not persisted on the deposit invoice; assert estimate stays PENDING.
  expect(estAfterChange.status).toBe('PENDING');

  // Admin marks received → WON
  const { res: markRes } = await api.markDepositReceived(ctx.estimateId);
  expect(markRes.status()).toBe(200);
  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadAfterApprove = await api.getLead(ctx.leadId);
  expect(leadAfterApprove.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-06: Customer changes CHECK→CARD (Stripe) → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-06: Send (deposit CHECK/CARD) → Approve (CHECK, PENDING) → Change to CARD → Stripe webhook → Job → SCHEDULED', async () => {
  if (!stripeAvailable) {
    test.skip(true, 'Stripe not configured in this environment');
    return;
  }

  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CARD']);

  // Customer approves with CHECK → PENDING
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  const estPending = await api.getEstimate(ctx.estimateId);
  expect(estPending.status).toBe('PENDING');

  // Customer changes to CARD → estimate goes back to SENT (Stripe creates session)
  const { res: changeRes, body: changeBody } = await api.changePaymentMethodPublic(
    ctx.estimateId, ctx.publicToken, 'CARD'
  );
  expect(changeRes.status()).toBe(200);
  expect(changeBody.checkout_url).toBeTruthy();
  const estAfterChange = await api.getEstimate(ctx.estimateId);
  expect(estAfterChange.status).toBe('SENT');
  expect(estAfterChange.invoices[0].status).toBe('SENT');

  // Fire the Stripe webhook keyed on the deposit invoice id (amount_due, face value).
  const deposit = estAfterChange.invoices[0];
  const depAmount = Number(deposit.amount_due);
  const amount_total = Math.round(depAmount * 100);
  const { res: webhookRes } = await api.fireStripeInvoiceWebhook({
    invoiceId: deposit.id,
    amount_total,
  });
  expect(webhookRes.status()).toBe(200);

  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadFinal = await api.getLead(ctx.leadId);
  expect(leadFinal.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-07: Skip walkthrough → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-07: Lead → Contact → Create estimate (skip walkthrough) → Send (no deposit) → Approve → Job → SCHEDULED', async () => {
  // Create lead and contact — skip walkthrough entirely
  const { leadId } = await createContactedLead(api);
  const leadAfterContact = await api.getLead(leadId);
  expect(leadAfterContact.status).toBe('CONTACTED');

  // Create estimate directly from CONTACTED lead
  const estimate = await createDraftEstimate(api, leadId);
  expect(estimate.status).toBe('DRAFT');

  // Send (no deposit)
  const { body: sendBody } = await api.sendEstimate(estimate.id, {
    deposit_required: false,
  });
  const publicToken = sendBody.estimate.public_token;
  expect(sendBody.estimate.status).toBe('SENT');
  const leadAfterSend = await api.getLead(leadId);
  expect(leadAfterSend.status).toBe('ESTIMATED');

  // Customer approves
  const { res: approveRes } = await api.approveEstimatePublic(estimate.id, publicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const estApproved = await api.getEstimate(estimate.id);
  expect(estApproved.status).toBe('WON');
  const leadAfterApprove = await api.getLead(leadId);
  expect(leadAfterApprove.status).toBe('WON');

  // Create job + assign
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: estimate.id });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;

  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
});
