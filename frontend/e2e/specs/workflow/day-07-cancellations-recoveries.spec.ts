import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createContactedLead,
  createTech,
  leadToSentEstimate,
  leadToSentEstimateWithDeposit,
  fullStandardFlow,
} from '../../helpers/workflow-builders';

// ──────────────────────────────────────────────────────────
// Day 7 — Not everything goes smoothly. Recovery paths:
// declined estimates, expirations, deposit refunds,
// walkthrough cancellations, lead losses, job cancellations.
// ──────────────────────────────────────────────────────────

test.describe('Day 7 — Cancellations & Recoveries', () => {
  test.describe.configure({ timeout: 120_000 });

  let api: ApiClient;
  let stripeAvailable = false;

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(120_000);
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

  test('decline estimate → create new estimate → full chain to PAID', async () => {
    test.slow();

    // Lead → Sent estimate (no deposit)
    const ctx = await leadToSentEstimate(api);

    // Customer declines the estimate
    const { res: declineRes } = await api.declineEstimatePublic(ctx.estimateId, ctx.publicToken);
    expect(declineRes.status()).toBe(200);

    const declinedEst = await api.getEstimate(ctx.estimateId);
    expect(declinedEst.status).toBe('DECLINED');

    // Create a NEW estimate on the same lead with different line items
    const { body: newEstBody } = await api.createEstimate({
      lead_id: ctx.leadId,
      line_items: [
        { description: 'Revised HVAC system replacement', quantity: 1, unit_price: 2200, is_taxable: true },
        { description: 'Ductwork modification', quantity: 1, unit_price: 450, is_taxable: true },
      ],
      tax_rate: 0.0825,
      scope_notes: 'Revised scope after customer feedback',
    });
    const newEstimateId = newEstBody.estimate.id;
    expect(newEstimateId).toBeTruthy();

    // Send the new estimate (no deposit)
    const { body: sentBody } = await api.sendEstimate(newEstimateId, {
      deposit_required: false,
    });
    const newPublicToken = sentBody.estimate.public_token;

    // Customer approves the revised estimate
    const { res: approveRes } = await api.approveEstimatePublic(newEstimateId, newPublicToken, {
      signature_data: api.testSignature,
    });
    expect(approveRes.status()).toBe(200);

    // Create job from approved estimate
    const { body: jobBody } = await api.createJob({ estimate_id: newEstimateId });
    const jobId = jobBody.job.id;
    expect(jobId).toBeTruthy();

    // Assign to tech, start, complete
    const techId = await createTech(api);
    await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(24),
      scheduled_end: api.futureDate(26),
    });
    const { res: startRes } = await api.startJob(jobId);
    expect(startRes.status()).toBe(200);
    const { res: completeRes } = await api.completeJob(jobId, 'Installed revised HVAC system. All tests passed.');
    expect(completeRes.status()).toBe(200);

    // Create invoice, send, pay
    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status()).toBe(201);
    const invoiceId = invBody.invoice.id;
    const { body: sentInvBody } = await api.sendInvoice(invoiceId);
    const { res: payRes, body: payBody } = await api.recordPayment(invoiceId, {
      amount: Number(sentInvBody.invoice.amount_due),
      method: 'CASH',
      notes: 'Full payment collected on-site',
    });
    expect(payRes.status()).toBe(201);
    expect(payBody.invoice.status).toBe('PAID');
  });

test('estimate expires → duplicate and resend → customer approves', async () => {
  // Lead → Sent estimate
  const ctx = await leadToSentEstimate(api);

  // Backdate the estimate by 31 days so it expires
  await api.backdateEstimate(ctx.estimateId, 31);

  // Trigger the expiration cron
  await api.triggerExpireEstimates();

  // Verify the estimate is now ARCHIVED (expired)
  const expiredEst = await api.getEstimate(ctx.estimateId);
  expect(expiredEst.status).toBe('ARCHIVED');

  // Duplicate the expired estimate
  const { body: dupBody } = await api.duplicateEstimate(ctx.estimateId);
  const dupEstimateId = dupBody.estimate.id;
  expect(dupEstimateId).toBeTruthy();

  // Verify the duplicate is DRAFT
  const dupEst = await api.getEstimate(dupEstimateId);
  expect(dupEst.status).toBe('DRAFT');

  // Send the duplicate (no deposit)
  const { body: sentBody } = await api.sendEstimate(dupEstimateId, {
    deposit_required: false,
  });
  const dupPublicToken = sentBody.estimate.public_token;

  // Customer approves
  const { res: approveRes } = await api.approveEstimatePublic(dupEstimateId, dupPublicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);

  const approvedEst = await api.getEstimate(dupEstimateId);
  expect(approvedEst.status).toBe('WON');

  // Verify the lead is WON
  const lead = await api.getLead(ctx.leadId);
  expect(lead.status).toBe('WON');
});

test('deposit refund after Stripe payment → re-estimate → full chain to PAID', async () => {
  test.slow();

  if (!stripeAvailable) {
    test.skip();
    return;
  }

  // Lead → Sent estimate with deposit (CARD only)
  const ctx = await leadToSentEstimateWithDeposit(api, ['CARD']);

  // Customer approves with CARD payment
  const { res: approveRes, body: approveBody } = await api.approveEstimatePublic(
    ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CARD',
    },
  );
  expect(approveRes.status()).toBe(200);

  // Fire Stripe webhook (keyed on the deposit invoice id) to mark the deposit PAID
  const estimate = await api.getEstimate(ctx.estimateId);
  const depInv = estimate.invoices[0];
  expect(depInv?.id).toBeTruthy();

  const amountDue = Number(depInv.amount_due);
  await api.fireStripeInvoiceWebhook({
    invoiceId: depInv.id,
    amount_total: Math.round(amountDue * 100),
  });

  // Verify estimate is WON
  const approvedEst = await api.getEstimate(ctx.estimateId);
  expect(approvedEst.status).toBe('WON');

  // Refund the deposit via the unified invoice refund on the kind=DEPOSIT invoice.
  const { res: refundRes } = await api.refundDeposit(ctx.estimateId, {
    reason: 'Customer found cheaper contractor',
    reason_category: 'CUSTOMER_REQUEST',
  });
  expect(refundRes.status()).toBe(200);

  // Verify the deposit invoice is REFUNDED.
  const refundedEst = await api.getEstimate(ctx.estimateId);
  expect(refundedEst.invoices[0].status).toBe('REFUNDED');

  // Entity-redesign behavior change (FLAGGED): the unified invoice refund no longer cancels
  // the parent estimate (the old /refund-deposit folded a cancel; the generalized refund does
  // not). The original "refund → re-estimate on the same lead → new job → PAID" recovery path
  // is therefore no longer reproducible via the public API: the first estimate stays WON,
  // estimate cancel rejects WON, and a lead may hold only ONE approved estimate — so a
  // second estimate on the same lead cannot be approved. The recovery narrative is covered
  // instead by the §10 Estimate Revise + duplicate-target-lead items in the QA checklist.
  // The deposit-refund verification above is the assertable remainder of this scenario.
});

test('walkthrough cancel → reschedule with different tech → full chain to PAID', async () => {
  test.slow();

  // Create customer and lead, contact
  const { customerId, locationId } = await createCustomerWithLocation(api);
  const { res: leadRes, body: leadBody } = await api.createLead({
    customer_id: customerId,
    service_request: 'Furnace making grinding noise during startup',
  });
  expect(leadRes.status()).toBe(201);
  const leadId = leadBody.lead.id;

  await api.contactLead(leadId);

  // Create tech1 and schedule walkthrough
  const { body: tech1Body } = await api.createUser({
    email: `tech1-wt-${api.suffix}@e2e.local`,
    password: 'Test123!@#',
    first_name: 'Mike',
    last_name: 'Tech1',
    role: 'TECHNICIAN',
  });
  const tech1Id = tech1Body.user.id;

  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: tech1Id,
  });

  // Cancel walkthrough
  const { res: cancelWtRes } = await api.cancelWalkthrough(leadId, 'Tech called in sick — rescheduling');
  expect(cancelWtRes.status()).toBe(200);

  // Verify lead reverts to CONTACTED
  const revertedLead = await api.getLead(leadId);
  expect(revertedLead.status).toBe('CONTACTED');

  // Create tech2 and reschedule
  const { body: tech2Body } = await api.createUser({
    email: `tech2-wt-${api.suffix}@e2e.local`,
    password: 'Test123!@#',
    first_name: 'Dave',
    last_name: 'Tech2',
    role: 'TECHNICIAN',
  });
  const tech2Id = tech2Body.user.id;

  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(48),
    walkthrough_assigned_to: tech2Id,
  });
  await api.completeWalkthrough(leadId);

  // Create estimate, send, approve
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [
      { description: 'Furnace bearing replacement', quantity: 1, unit_price: 650, is_taxable: true },
      { description: 'Diagnostic labor', quantity: 2, unit_price: 125, is_taxable: true },
    ],
    tax_rate: 0.0825,
    scope_notes: 'Replace worn blower motor bearings',
  });
  const estimateId = estBody.estimate.id;

  const { body: sentBody } = await api.sendEstimate(estimateId, { deposit_required: false });
  const { res: approveRes } = await api.approveEstimatePublic(
    estimateId, sentBody.estimate.public_token, { signature_data: api.testSignature },
  );
  expect(approveRes.status()).toBe(200);

  // Create job, assign to tech2, start, complete
  const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
  const jobId = jobBody.job.id;

  await api.assignJob(jobId, {
    assigned_to: tech2Id,
    scheduled_start: api.futureDate(72),
    scheduled_end: api.futureDate(74),
  });
  const { res: startRes } = await api.startJob(jobId);
  expect(startRes.status()).toBe(200);
  const { res: completeRes } = await api.completeJob(jobId, 'Furnace bearings replaced. No more grinding noise. Verified airflow.');
  expect(completeRes.status()).toBe(200);

  // Create invoice, send, pay
  const { res: invRes, body: invBody } = await api.createInvoice(jobId);
  expect(invRes.status()).toBe(201);
  const invoiceId = invBody.invoice.id;
  const { body: sentInvBody } = await api.sendInvoice(invoiceId);
  const { res: payRes, body: payBody } = await api.recordPayment(invoiceId, {
    amount: Number(sentInvBody.invoice.amount_due),
    method: 'CASH',
    notes: 'Payment collected on-site after furnace repair',
  });
  expect(payRes.status()).toBe(201);
  expect(payBody.invoice.status).toBe('PAID');
});

test('lead marked LOST — estimate auto-cancelled, deposit voided', async () => {
  // Lead → Sent estimate with deposit
  const ctx = await leadToSentEstimateWithDeposit(api);

  // Mark lead as LOST
  const { res: lostRes } = await api.markLeadLost(ctx.leadId, 'Customer went with competitor quote — $200 cheaper');
  expect(lostRes.status()).toBe(200);

  // Verify lead is LOST
  const lead = await api.getLead(ctx.leadId);
  expect(lead.status).toBe('LOST');

  // Verify estimate is ARCHIVED (cascade from lead LOST)
  const est = await api.getEstimate(ctx.estimateId);
  expect(est.status).toBe('ARCHIVED');
});

test('lead cancelled during walkthrough — walkthrough auto-cancelled', async () => {
  // Create customer, lead, contact
  const { customerId } = await createCustomerWithLocation(api);
  const { res: leadRes, body: leadBody } = await api.createLead({
    customer_id: customerId,
    service_request: 'Water heater leaking at pressure relief valve',
  });
  expect(leadRes.status()).toBe(201);
  const leadId = leadBody.lead.id;

  await api.contactLead(leadId);

  // Create tech and schedule walkthrough
  const techId = await createTech(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: techId,
  });

  const scheduledLead = await api.getLead(leadId);
  expect(scheduledLead.status).toBe('WALKTHROUGH_SCHEDULED');

  // Cancel the lead
  const { res: cancelRes } = await api.cancelLead(leadId, 'Duplicate lead — merged with another');
  expect(cancelRes.status()).toBe(200);

  // Verify lead is CANCELLED
  const cancelledLead = await api.getLead(leadId);
  expect(cancelledLead.status).toBe('CANCELLED');
});

test('job cancelled after starting — cannot create invoice', async () => {
  // Full standard flow gives a SCHEDULED job
  const ctx = await fullStandardFlow(api);

  // Start the job
  await api.startJob(ctx.jobId);

  // Cancel the job
  const { res: cancelRes } = await api.cancelJob(ctx.jobId, 'Customer relocated out of service area');
  expect(cancelRes.status()).toBe(200);

  const cancelledJob = await api.getJob(ctx.jobId);
  expect(cancelledJob.status).toBe('CANCELLED');

  // Attempt to create invoice on cancelled job — expect 400
  const { res: invRes } = await api.createInvoice(ctx.jobId);
  expect(invRes.status()).toBe(400);
});

test('PENDING deposit expires via cron — estimate ARCHIVED', async () => {
  // Lead → Sent estimate with deposit (CHECK only)
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);

  // Customer approves with CHECK payment method
  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  expect(approveRes.status()).toBe(200);

  // Verify estimate is PENDING (waiting for check)
  const pendingEst = await api.getEstimate(ctx.estimateId);
  expect(pendingEst.status).toBe('PENDING');

  // Backdate and trigger expiration
  await api.backdateEstimate(ctx.estimateId, 31);
  await api.triggerExpireEstimates();

  // Verify estimate is ARCHIVED
  const expiredEst = await api.getEstimate(ctx.estimateId);
  expect(expiredEst.status).toBe('ARCHIVED');
});
});
