import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createDraftEstimate,
  createTech,
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
// E2E-08: Estimate #1 declined → Estimate #2 approved → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-08: Estimate #1 declined → Estimate #2 approved → Job → SCHEDULED', async () => {
  const { leadId } = await leadToWalkthroughCompleted(api);

  // Estimate #1 → Send → Decline
  const est1 = await createDraftEstimate(api, leadId);
  const { body: send1Body } = await api.sendEstimate(est1.id, { deposit_required: false });
  const token1 = send1Body.estimate.public_token;

  const { res: declineRes } = await api.declineEstimatePublic(est1.id, token1);
  expect(declineRes.status()).toBe(200);
  const est1After = await api.getEstimate(est1.id);
  expect(est1After.status).toBe('DECLINED');

  // Estimate #2 → Send → Approve
  const est2 = await createDraftEstimate(api, leadId);
  const { body: send2Body } = await api.sendEstimate(est2.id, { deposit_required: false });
  const token2 = send2Body.estimate.public_token;

  const { res: approveRes } = await api.approveEstimatePublic(est2.id, token2, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const est2After = await api.getEstimate(est2.id);
  expect(est2After.status).toBe('WON');
  const leadAfter = await api.getLead(leadId);
  expect(leadAfter.status).toBe('WON');

  // Create job + assign
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: est2.id });
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
});

// ──────────────────────────────────────────────────────────
// E2E-09: Estimate cancelled → Duplicate → Send → Approve → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-09: Estimate sent → Admin cancels → Duplicate → Send duplicate → Approve → Job → SCHEDULED', async () => {
  const ctx = await leadToSentEstimate(api);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');

  // Admin cancels
  const { res: cancelRes } = await api.cancelEstimate(ctx.estimateId, 'E2E-09 cancel');
  expect(cancelRes.status()).toBe(200);
  const estCancelled = await api.getEstimate(ctx.estimateId);
  expect(estCancelled.status).toBe('ARCHIVED');

  // Duplicate → new DRAFT
  const { res: dupRes, body: dupBody } = await api.duplicateEstimate(ctx.estimateId);
  expect(dupRes.status()).toBe(201);
  const dupEstId = dupBody.estimate.id;
  expect(dupBody.estimate.status).toBe('DRAFT');

  // Send the duplicate
  const { body: sendBody } = await api.sendEstimate(dupEstId, { deposit_required: false });
  const dupToken = sendBody.estimate.public_token;
  expect(sendBody.estimate.status).toBe('SENT');

  // Customer approves
  const { res: approveRes } = await api.approveEstimatePublic(dupEstId, dupToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const estApproved = await api.getEstimate(dupEstId);
  expect(estApproved.status).toBe('WON');
  const leadAfter = await api.getLead(ctx.leadId);
  expect(leadAfter.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: dupEstId });
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
// E2E-10: Deposit paid → Admin refunds → New estimate → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-10: Deposit paid → Admin refunds → Verify refunded → New flow → Job → SCHEDULED', async () => {
  test.slow(); // Two full flows — needs extra time
  // Get to WON with PAID deposit (no job yet)
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
    payment_method: 'CHECK',
  });
  await api.markDepositReceived(ctx.estimateId);
  const estApproved = await api.getEstimate(ctx.estimateId);
  expect(estApproved.status).toBe('WON');
  expect(estApproved.invoices[0].status).toBe('PAID');

  // Admin refunds the deposit via the unified invoice refund on the kind=DEPOSIT invoice.
  const { res: refundRes } = await api.refundDeposit(ctx.estimateId, {
    reason: 'E2E-10 refund test',
    reason_category: 'CUSTOMER_CANCELLATION',
  });
  expect(refundRes.status()).toBe(200);
  const estAfterRefund = await api.getEstimate(ctx.estimateId);
  expect(estAfterRefund.invoices[0].status).toBe('REFUNDED');
  // Entity-redesign: the unified refund no longer cancels the estimate (stays WON).
  expect(estAfterRefund.status).toBe('WON');
  // Lead stays WON (refund does not revert terminal lead status)
  const leadAfterRefund = await api.getLead(ctx.leadId);
  expect(leadAfterRefund.status).toBe('WON');

  // Create a fresh lead + flow for the new job (since original lead is WON — terminal)
  const freshCtx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(freshCtx.estimateId, freshCtx.publicToken, {
    signature_data: api.testSignature,
  });
  const freshEst = await api.getEstimate(freshCtx.estimateId);
  expect(freshEst.status).toBe('WON');

  // Create job + assign
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: freshCtx.estimateId });
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
});

// ──────────────────────────────────────────────────────────
// E2E-11: Reactivate deposit — FLOW REMOVED (entity-redesign Phase 5)
// ──────────────────────────────────────────────────────────
//
// The POST /api/estimates/:id/reactivate-deposit route was removed. There is no in-place
// reactivate of a voided deposit: the deposit invoice is voided, and a fresh one is reissued
// by revising the estimate (SENT→DRAFT) and re-sending. After a waive(cancel) the estimate is
// ARCHIVED (revise rejects ARCHIVED), so the original "waive→reactivate→approve→job" path is
// not reproducible. This test asserted a fabricated flow and is removed. The nearest
// equivalent (revise a SENT deposit estimate → re-send → approve) is covered in the QA
// checklist (§10 Estimate Revise).

// ──────────────────────────────────────────────────────────
// E2E-12: Full flow → Assign as all-day → SCHEDULED (is_all_day)
// ──────────────────────────────────────────────────────────

test('E2E-12: Full flow → Assign as all-day → SCHEDULED (is_all_day=true)', async () => {
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });

  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;

  const techId = await createTech(api);
  const start = api.futureDate(72);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: start,
    is_all_day: true,
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');
  expect(assignBody.job.is_all_day).toBe(true);

  // End auto-computed: start + 24h
  const startMs = new Date(start).getTime();
  const endMs = new Date(assignBody.job.scheduled_end).getTime();
  expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
  expect(finalJob.is_all_day).toBe(true);
});

// ──────────────────────────────────────────────────────────
// E2E-13: 2 jobs → Assign #1 → Assign #2 same tech/time → 409 → Force → Both SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-13: 2 jobs same tech overlapping time → 409 → Force → Both SCHEDULED', async () => {
  test.slow(); // Two full flows + conflict detection — needs extra time
  const techId = await createTech(api);

  // Job #1: from standard flow
  const ctx1 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx1.estimateId, ctx1.publicToken, { signature_data: api.testSignature });
  const { body: job1Body } = await api.createJob({ estimate_id: ctx1.estimateId });
  const job1Id = job1Body.job.id;

  // Job #2: from a second standard flow
  const ctx2 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx2.estimateId, ctx2.publicToken, { signature_data: api.testSignature });
  const { body: job2Body } = await api.createJob({ estimate_id: ctx2.estimateId });
  const job2Id = job2Body.job.id;

  // Assign job #1 to tech at time T
  const start = api.futureDate(48);
  const end = api.futureDate(50);
  const { res: assign1Res } = await api.assignJob(job1Id, {
    assigned_to: techId,
    scheduled_start: start,
    scheduled_end: end,
  });
  expect(assign1Res.status()).toBe(200);

  // Assign job #2 to same tech at same time → 409
  const { res: conflictRes, body: conflictBody } = await api.assignJob(job2Id, {
    assigned_to: techId,
    scheduled_start: start,
    scheduled_end: end,
    force: false,
  });
  expect(conflictRes.status()).toBe(409);
  expect(conflictBody.conflicts).toBeDefined();
  expect(conflictBody.conflicts.length).toBeGreaterThan(0);

  // Force assign → SCHEDULED
  const { res: forceRes, body: forceBody } = await api.assignJob(job2Id, {
    assigned_to: techId,
    scheduled_start: start,
    scheduled_end: end,
    force: true,
  });
  expect(forceRes.status()).toBe(200);
  expect(forceBody.job.status).toBe('SCHEDULED');

  // Verify both are SCHEDULED
  const job1Final = await api.getJob(job1Id);
  const job2Final = await api.getJob(job2Id);
  expect(job1Final.status).toBe('SCHEDULED');
  expect(job2Final.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-14: No-estimate job → Assign → SCHEDULED
//
// Entity-redesign Phase D: the urgent flow + JobCharge are retired. createJob no longer
// accepts is_urgent/urgency_reason, the /jobs/:id/charges routes are gone, and there is no
// API to add line items to a no-estimate job's (empty) invoice. The charge-capture steps are
// dropped; the money model is covered by the invoice-refund/credit specs + the QA checklist.
// ──────────────────────────────────────────────────────────

test('E2E-14: No-estimate job → Assign → SCHEDULED', async () => {
  const { customerId, locationId } = await createCustomerWithLocation(api);

  const { res: jobRes, body: jobBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  expect(jobRes.status()).toBe(201);
  const jobId = jobBody.job.id;
  expect(jobBody.job.status).toBe('UNASSIGNED');

  // Assign to tech
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(4),
    scheduled_end: api.futureDate(6),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-15: No-estimate job → Job walkthrough (notes) → Assign → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-15: No-estimate job → Job walkthrough (notes) → Assign → SCHEDULED', async () => {
  const { customerId, locationId } = await createCustomerWithLocation(api);

  const { body: jobBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  const jobId = jobBody.job.id;

  // Complete the job walkthrough (notes)
  const { res: wtRes, body: wtBody } = await api.createJobWalkthrough(
    jobId,
    'Site visited, identified root cause: faulty capacitor'
  );
  expect(wtRes.status()).toBe(200);
  expect(wtBody.job.walkthrough_notes).toBeTruthy();
  expect(wtBody.job.walkthrough_completed_at).toBeTruthy();

  // Assign to tech
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(6),
    scheduled_end: api.futureDate(8),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
  expect(finalJob.walkthrough_notes).toBeTruthy();
});
