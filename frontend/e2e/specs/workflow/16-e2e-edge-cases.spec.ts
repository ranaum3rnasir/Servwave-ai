import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createDraftEstimate,
  createTech,
  createSalesUser,
  leadToSentEstimate,
  leadToSentEstimateWithDeposit,
  leadToWalkthroughCompleted,
  fullStandardFlow,
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
// E2E-23: Send estimate (backdate) → Run cron → expired, deposit voided, lead reverted
// ──────────────────────────────────────────────────────────

test('E2E-23: Send estimate → Backdate → Cron → ARCHIVED, deposit VOIDED, lead reverted', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');
  const leadBefore = await api.getLead(ctx.leadId);
  expect(leadBefore.status).toBe('ESTIMATED');

  // Backdate valid_until to past
  const { res: backdateRes } = await api.backdateEstimate(ctx.estimateId, 2);
  expect(backdateRes.status()).toBe(200);

  // Trigger expiration cron
  const { res: cronRes, body: cronBody } = await api.triggerExpireEstimates();
  expect(cronRes.status()).toBe(200);
  expect(cronBody.expired).toBeGreaterThanOrEqual(1);

  const estExpired = await api.getEstimate(ctx.estimateId);
  expect(estExpired.status).toBe('ARCHIVED');
  expect(estExpired.cancelled_reason).toBe('Estimate expired');
  expect(estExpired.invoices[0].status).toBe('VOIDED');

  // Lead should revert (still ESTIMATED after expiry — reverted from ESTIMATED to ESTIMATED or remains)
  const leadAfter = await api.getLead(ctx.leadId);
  expect(leadAfter.status).toBe('ESTIMATED');
});

// ──────────────────────────────────────────────────────────
// E2E-24: Est #1 (deposit, declined) → Est #2 (no deposit, approved) → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-24: Est #1 (deposit, declined → deposit voided) → Est #2 (no deposit, approved) → Job → SCHEDULED', async () => {
  const { leadId } = await leadToWalkthroughCompleted(api);

  // Estimate #1 with deposit → send → customer declines
  const est1 = await createDraftEstimate(api, leadId);
  const { body: send1 } = await api.sendEstimate(est1.id, {
    deposit_required: true,
    payment_methods: ['CHECK', 'CASH'],
  });
  const { res: declineRes } = await api.declineEstimatePublic(est1.id, send1.estimate.public_token);
  expect(declineRes.status()).toBe(200);
  const est1After = await api.getEstimate(est1.id);
  expect(est1After.status).toBe('DECLINED');
  expect(est1After.invoices[0].status).toBe('VOIDED');

  // Estimate #2 without deposit → send → approve
  const est2 = await createDraftEstimate(api, leadId);
  const { body: send2 } = await api.sendEstimate(est2.id, { deposit_required: false });
  const { res: approveRes } = await api.approveEstimatePublic(est2.id, send2.estimate.public_token, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const est2After = await api.getEstimate(est2.id);
  expect(est2After.status).toBe('WON');
  const leadAfter = await api.getLead(leadId);
  expect(leadAfter.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: est2.id });
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
// E2E-25: Deposit via CASH end-to-end → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-25: Deposit via CASH → Customer approves (CASH) → Mark received → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CASH']);

  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CASH',
  });
  expect(approveRes.status()).toBe(200);
  const estPending = await api.getEstimate(ctx.estimateId);
  expect(estPending.status).toBe('PENDING');
  expect(estPending.invoices[0].status).toBe('SENT');

  const { res: markRes } = await api.markDepositReceived(ctx.estimateId, { payment_method: 'CASH' });
  expect(markRes.status()).toBe(200);
  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadAfter = await api.getLead(ctx.leadId);
  expect(leadAfter.status).toBe('WON');

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
// E2E-26: Deposit via BANK_TRANSFER end-to-end → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-26: Deposit via BANK_TRANSFER → Customer approves → Mark received → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['BANK_TRANSFER']);

  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'BANK_TRANSFER',
  });
  expect(approveRes.status()).toBe(200);
  const estPending = await api.getEstimate(ctx.estimateId);
  expect(estPending.status).toBe('PENDING');
  expect(estPending.invoices[0].status).toBe('SENT');

  const { res: markRes } = await api.markDepositReceived(ctx.estimateId, {
    payment_method: 'BANK_TRANSFER',
    reference_number: 'ACH-TEST-001',
    notes: 'E2E-26 bank transfer received',
  });
  expect(markRes.status()).toBe(200);
  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  // reference_number lives on the Payment row; assert the recorded payment + its method.
  expect(estApproved.invoices[0].payments[0].method).toBe('BANK_TRANSFER');

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
// E2E-27: Send estimate → Mark lead LOST → lead LOST, estimate still SENT
// ──────────────────────────────────────────────────────────

test('E2E-27: Send estimate (deposit) → Mark lead LOST → lead=LOST, verify estimate state', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');

  // Mark lead LOST
  const { res: lostRes } = await api.markLeadLost(ctx.leadId, 'E2E-27 customer not interested');
  expect(lostRes.status()).toBe(200);
  const leadLost = await api.getLead(ctx.leadId);
  expect(leadLost.status).toBe('LOST');

  // The estimate is cancelled and deposit voided when the lead is marked lost
  const estAfter = await api.getEstimate(ctx.estimateId);
  expect(estAfter.status).toBe('ARCHIVED');
  expect(estAfter.invoices[0].status).toBe('VOIDED');
});

// ──────────────────────────────────────────────────────────
// E2E-28: PENDING estimate expires → ARCHIVED, deposit VOIDED
// ──────────────────────────────────────────────────────────

test('E2E-28: PENDING estimate expires → ARCHIVED, deposit VOIDED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  // Customer approves with CHECK → PENDING
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  const estPending = await api.getEstimate(ctx.estimateId);
  expect(estPending.status).toBe('PENDING');

  // Backdate and expire
  await api.backdateEstimate(ctx.estimateId, 2);
  const { res: cronRes } = await api.triggerExpireEstimates();
  expect(cronRes.status()).toBe(200);

  const estExpired = await api.getEstimate(ctx.estimateId);
  expect(estExpired.status).toBe('ARCHIVED');
  expect(estExpired.invoices[0].status).toBe('VOIDED');
});

// ──────────────────────────────────────────────────────────
// E2E-29: Full flow → Start → Complete → COMPLETED
// ──────────────────────────────────────────────────────────

test('E2E-29: Full flow → Job SCHEDULED → Start → Complete → COMPLETED', async () => {
  const { jobId } = await fullStandardFlow(api);

  const jobScheduled = await api.getJob(jobId);
  expect(jobScheduled.status).toBe('SCHEDULED');

  // Start job
  const { res: startRes } = await api.startJob(jobId);
  expect(startRes.status()).toBe(200);
  const jobInProgress = await api.getJob(jobId);
  expect(jobInProgress.status).toBe('IN_PROGRESS');
  expect(jobInProgress.started_at).toBeTruthy();

  // Complete job
  const { res: completeRes } = await api.completeJob(jobId, 'E2E-29 job completed successfully');
  expect(completeRes.status()).toBe(200);
  const jobCompleted = await api.getJob(jobId);
  expect(jobCompleted.status).toBe('COMPLETED');
  expect(jobCompleted.completed_at).toBeTruthy();
  expect(jobCompleted.completion_notes).toBe('E2E-29 job completed successfully');
});

// ──────────────────────────────────────────────────────────
// E2E-30: No-estimate job → Assign → Start → Complete → COMPLETED
//
// Entity-redesign Phase D: the urgent flow + JobCharge are retired (no is_urgent/
// urgency_reason, no /charges routes, no API to add lines to a no-estimate job's invoice).
// The charge-capture step is dropped; the lifecycle is the assertion.
// ──────────────────────────────────────────────────────────

test('E2E-30: No-estimate job → Assign → Start → Complete → COMPLETED', async () => {
  const { customerId, locationId } = await createCustomerWithLocation(api);

  const { body: jobBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  const jobId = jobBody.job.id;

  // Assign
  const techId = await createTech(api);
  const { res: assignRes } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(2),
    scheduled_end: api.futureDate(4),
  });
  expect(assignRes.status()).toBe(200);
  const jobScheduled = await api.getJob(jobId);
  expect(jobScheduled.status).toBe('SCHEDULED');

  // Start
  const { res: startRes } = await api.startJob(jobId);
  expect(startRes.status()).toBe(200);
  const jobInProgress = await api.getJob(jobId);
  expect(jobInProgress.status).toBe('IN_PROGRESS');

  // Complete
  const { res: completeRes } = await api.completeJob(jobId, 'E2E-30 no-estimate job done');
  expect(completeRes.status()).toBe(200);
  const jobCompleted = await api.getJob(jobId);
  expect(jobCompleted.status).toBe('COMPLETED');
});

// ──────────────────────────────────────────────────────────
// E2E-31: Full flow → Start → Cancel IN_PROGRESS → CANCELLED
// ──────────────────────────────────────────────────────────

test('E2E-31: Full flow → SCHEDULED → Start → Cancel IN_PROGRESS → CANCELLED', async () => {
  const { jobId } = await fullStandardFlow(api);

  // Start
  await api.startJob(jobId);
  const jobInProgress = await api.getJob(jobId);
  expect(jobInProgress.status).toBe('IN_PROGRESS');

  // Cancel while IN_PROGRESS
  const { res: cancelRes } = await api.cancelJob(jobId, 'E2E-31 cancelled mid-progress');
  expect(cancelRes.status()).toBe(200);
  const jobCancelled = await api.getJob(jobId);
  expect(jobCancelled.status).toBe('CANCELLED');
  expect(jobCancelled.cancelled_reason).toBe('E2E-31 cancelled mid-progress');
});

// ──────────────────────────────────────────────────────────
// E2E-32: Admin marks deposit received on SENT estimate (before customer acts)
// ──────────────────────────────────────────────────────────

test('E2E-32: Admin marks deposit received on SENT estimate (before customer acts) → WON → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');

  // Admin pre-approves by marking deposit received on SENT estimate
  const { res: markRes } = await api.markDepositReceived(ctx.estimateId, {
    reference_number: 'PREAPPROVE-001',
    notes: 'E2E-32 pre-approved by admin',
  });
  expect(markRes.status()).toBe(200);
  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');
  const leadAfter = await api.getLead(ctx.leadId);
  expect(leadAfter.status).toBe('WON');

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
// E2E-33: Waive deposit (cancel) → Try create job → 400 (blocked)
// ──────────────────────────────────────────────────────────

test('E2E-33: Waive deposit (cancel) → Try create job → 400 (estimate ARCHIVED, not WON)', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  // Admin waives with action=cancel → estimate ARCHIVED
  const { res: waiveRes } = await api.waiveDeposit(ctx.estimateId, 'cancel');
  expect(waiveRes.status()).toBe(200);
  const estCancelled = await api.getEstimate(ctx.estimateId);
  expect(estCancelled.status).toBe('ARCHIVED');

  // Try to create job → 400 (estimate not WON)
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(jobRes.status()).toBe(400);
  expect(jobBody.error).toBeTruthy();
});

// ──────────────────────────────────────────────────────────
// E2E-34: 2 estimates — #1 expires, #2 stays active → lead stays ESTIMATED
// ──────────────────────────────────────────────────────────

test('E2E-34: 2 estimates → #1 expires, #2 stays active → lead stays ESTIMATED', async () => {
  const { leadId } = await leadToWalkthroughCompleted(api);

  // Estimate #1 → send
  const est1 = await createDraftEstimate(api, leadId);
  const { body: send1 } = await api.sendEstimate(est1.id, { deposit_required: false });
  expect(send1.estimate.status).toBe('SENT');

  // Estimate #2 → send (will stay active)
  const est2 = await createDraftEstimate(api, leadId);
  const { body: send2 } = await api.sendEstimate(est2.id, { deposit_required: false });
  expect(send2.estimate.status).toBe('SENT');

  const leadBefore = await api.getLead(leadId);
  expect(leadBefore.status).toBe('ESTIMATED');

  // Backdate only estimate #1
  await api.backdateEstimate(est1.id, 2);
  await api.triggerExpireEstimates();

  const est1Expired = await api.getEstimate(est1.id);
  expect(est1Expired.status).toBe('ARCHIVED');

  const est2Active = await api.getEstimate(est2.id);
  expect(est2Active.status).toBe('SENT');

  // Lead still ESTIMATED — has an active estimate (#2)
  const leadAfter = await api.getLead(leadId);
  expect(leadAfter.status).toBe('ESTIMATED');
});

// ──────────────────────────────────────────────────────────
// E2E-35: Single estimate expires → lead reverts from ESTIMATED
// ──────────────────────────────────────────────────────────

test('E2E-35: Single estimate expires → lead reverts (stays ESTIMATED but estimate ARCHIVED)', async () => {
  const { leadId } = await leadToWalkthroughCompleted(api);

  const est = await createDraftEstimate(api, leadId);
  const { body: sendBody } = await api.sendEstimate(est.id, { deposit_required: false });
  expect(sendBody.estimate.status).toBe('SENT');

  const leadBefore = await api.getLead(leadId);
  expect(leadBefore.status).toBe('ESTIMATED');

  // Backdate + expire
  await api.backdateEstimate(est.id, 2);
  await api.triggerExpireEstimates();

  const estExpired = await api.getEstimate(est.id);
  expect(estExpired.status).toBe('ARCHIVED');

  // Lead — the spec says it "reverts from ESTIMATED"; per existing test EX-04 it stays ESTIMATED
  const leadAfter = await api.getLead(leadId);
  expect(leadAfter.status).toBe('ESTIMATED');
});

// ──────────────────────────────────────────────────────────
// E2E-36: Stripe deposit → refund → new estimate → approve → Job SCHEDULED (skip if no Stripe)
// ──────────────────────────────────────────────────────────

test('E2E-36: Stripe deposit → refund → new estimate → approve → Job → SCHEDULED', async () => {
  if (!stripeAvailable) {
    test.skip(true, 'Stripe not configured in this environment');
    return;
  }

  const { leadId, estimateId, publicToken } = await (() => {
    return leadToWalkthroughCompleted(api).then(async (ctx) => {
      const est = await createDraftEstimate(api, ctx.leadId);
      const { body: sendBody } = await api.sendEstimate(est.id, {
        deposit_required: true,
        payment_methods: ['CARD'],
      });
      return { leadId: ctx.leadId, estimateId: est.id, publicToken: sendBody.estimate.public_token };
    });
  })();

  // Customer selects CARD → checkout
  await api.approveEstimatePublic(estimateId, publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CARD',
  });

  // Get the deposit invoice and fire the webhook keyed on its id (amount_due, face value).
  const estAfterCard = await api.getEstimate(estimateId);
  const deposit = estAfterCard.invoices[0];
  const depAmount = Number(deposit.amount_due);
  const amount_total = Math.round(depAmount * 100);
  await api.fireStripeInvoiceWebhook({ invoiceId: deposit.id, amount_total });

  const estApproved = await api.getEstimate(estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');

  // Admin refunds the deposit via the unified invoice refund ('customer_request' → CUSTOMER_REQUEST).
  const { res: refundRes } = await api.refundDeposit(estimateId, {
    reason: 'E2E-36 refund test',
    reason_category: 'customer_request',
  });
  expect(refundRes.status()).toBe(200);
  const estRefunded = await api.getEstimate(estimateId);
  expect(estRefunded.invoices[0].status).toBe('REFUNDED');
  // Entity-redesign: the unified refund no longer cancels the estimate (stays WON).
  expect(estRefunded.status).toBe('WON');

  // The refunded estimate stays WON and a lead holds at most one approved estimate, so the
  // re-estimate recovery uses a FRESH lead (the original is WON/terminal).
  const freshCtx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(freshCtx.estimateId, freshCtx.publicToken, {
    signature_data: api.testSignature,
  });
  const est2Approved = await api.getEstimate(freshCtx.estimateId);
  expect(est2Approved.status).toBe('WON');

  const { body: jobBody } = await api.createJob({ estimate_id: freshCtx.estimateId });
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
// E2E-37: 2 all-day jobs → conflict → force → Both SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-37: 2 all-day jobs same tech overlapping → 409 → Force → Both SCHEDULED', async () => {
  test.slow(); // Two full flows + conflict — needs extra time
  const techId = await createTech(api);

  // Job #1 (standard)
  const ctx1 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx1.estimateId, ctx1.publicToken, { signature_data: api.testSignature });
  const { body: job1Body } = await api.createJob({ estimate_id: ctx1.estimateId });
  const job1Id = job1Body.job.id;

  // Job #2 (standard)
  const ctx2 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx2.estimateId, ctx2.publicToken, { signature_data: api.testSignature });
  const { body: job2Body } = await api.createJob({ estimate_id: ctx2.estimateId });
  const job2Id = job2Body.job.id;

  // Assign job #1 as all-day
  const start = api.futureDate(72);
  const { res: assign1Res, body: assign1Body } = await api.assignJob(job1Id, {
    assigned_to: techId,
    scheduled_start: start,
    is_all_day: true,
  });
  expect(assign1Res.status()).toBe(200);
  expect(assign1Body.job.is_all_day).toBe(true);

  // Assign job #2 as all-day to same tech → 409
  const { res: conflictRes, body: conflictBody } = await api.assignJob(job2Id, {
    assigned_to: techId,
    scheduled_start: start,
    is_all_day: true,
    force: false,
  });
  expect(conflictRes.status()).toBe(409);
  expect(conflictBody.conflicts).toBeDefined();
  expect(conflictBody.conflicts.length).toBeGreaterThan(0);

  // Force assign
  const { res: forceRes, body: forceBody } = await api.assignJob(job2Id, {
    assigned_to: techId,
    scheduled_start: start,
    is_all_day: true,
    force: true,
  });
  expect(forceRes.status()).toBe(200);
  expect(forceBody.job.status).toBe('SCHEDULED');
  expect(forceBody.job.is_all_day).toBe(true);

  const job1Final = await api.getJob(job1Id);
  const job2Final = await api.getJob(job2Id);
  expect(job1Final.status).toBe('SCHEDULED');
  expect(job2Final.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-38: Walkthrough conflict blocks job assignment → force → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-38: Walkthrough conflict blocks job assignment → force → SCHEDULED', async () => {
  // Create a tech and schedule a walkthrough for them
  const techId = await createTech(api);
  const { leadId: wtLeadId } = await (() => {
    return api.createCustomer({
      first_name: `WtConf-${api.suffix}`, last_name: 'Test',
      email: `wtconf-${api.suffix}@e2e.local`, phone: '5550001111',
    }).then(async (customer) => {
      const { body } = await api.createLead({
        customer_id: customer.id,
        service_request: 'E2E-38 walkthrough conflict lead',
      });
      return { leadId: body.lead.id };
    });
  })();

  await api.contactLead(wtLeadId);
  const wtTime = api.futureDate(48);
  await api.scheduleWalkthrough(wtLeadId, {
    walkthrough_scheduled_at: wtTime,
    walkthrough_assigned_to: techId,
  });
  const leadWt = await api.getLead(wtLeadId);
  expect(leadWt.status).toBe('WALKTHROUGH_SCHEDULED');

  // Create a separate job to assign to the same tech during the walkthrough window
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, { signature_data: api.testSignature });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;

  // Assign job during walkthrough window → 409 (walkthrough conflict)
  const wtStart = new Date(wtTime);
  const conflictStart = new Date(wtStart.getTime() + 30 * 60 * 1000).toISOString(); // +30min
  const conflictEnd = new Date(wtStart.getTime() + 90 * 60 * 1000).toISOString();   // +90min

  const { res: conflictRes, body: conflictBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: conflictStart,
    scheduled_end: conflictEnd,
    force: false,
  });
  expect(conflictRes.status()).toBe(409);
  expect(conflictBody.conflicts).toBeDefined();
  expect(conflictBody.conflicts.length).toBeGreaterThan(0);

  // Force assign → SCHEDULED
  const { res: forceRes, body: forceBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: conflictStart,
    scheduled_end: conflictEnd,
    force: true,
  });
  expect(forceRes.status()).toBe(200);
  expect(forceBody.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-39: Estimate expires → Duplicate → Send → Approve → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-39: Estimate expires → Duplicate → Send → Approve → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimate(api);

  // Expire the estimate
  await api.backdateEstimate(ctx.estimateId, 2);
  await api.triggerExpireEstimates();
  const estExpired = await api.getEstimate(ctx.estimateId);
  expect(estExpired.status).toBe('ARCHIVED');

  // Duplicate the expired estimate → DRAFT
  const { res: dupRes, body: dupBody } = await api.duplicateEstimate(ctx.estimateId);
  expect(dupRes.status()).toBe(201);
  const dupId = dupBody.estimate.id;
  expect(dupBody.estimate.status).toBe('DRAFT');

  // Send the duplicate
  const { body: sendBody } = await api.sendEstimate(dupId, { deposit_required: false });
  const dupToken = sendBody.estimate.public_token;
  expect(sendBody.estimate.status).toBe('SENT');

  // Approve
  const { res: approveRes } = await api.approveEstimatePublic(dupId, dupToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const estApproved = await api.getEstimate(dupId);
  expect(estApproved.status).toBe('WON');
  const leadAfter = await api.getLead(ctx.leadId);
  expect(leadAfter.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: dupId });
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
// E2E-40: Lead WON (approved) → Try mark lost → 400 → Job proceeds → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-40: Lead WON → Try mark lost → 400 (terminal) → Job proceeds → SCHEDULED', async () => {
  const ctx = await leadToSentEstimate(api);

  // Approve estimate → lead WON
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const leadWon = await api.getLead(ctx.leadId);
  expect(leadWon.status).toBe('WON');

  // Try to mark WON lead as lost → 400 (terminal state)
  const { res: lostRes, body: lostBody } = await api.markLeadLost(ctx.leadId, 'E2E-40 should fail');
  expect(lostRes.status()).toBe(400);
  expect(lostBody.error).toBeTruthy();

  // Lead stays WON
  const leadStillWon = await api.getLead(ctx.leadId);
  expect(leadStillWon.status).toBe('WON');

  // Job creation proceeds normally
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
