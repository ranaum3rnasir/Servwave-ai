import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createContactedLead,
  createDraftEstimate,
  createTech,
  createSalesUser,
  leadToSentEstimate,
  leadToSentEstimateWithDeposit,
  leadToWalkthroughCompleted,
  fullStandardFlow,
} from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// E2E-16: Lead → Walkthrough scheduled → Mark LOST → walkthrough cancelled
// ──────────────────────────────────────────────────────────

test('E2E-16: Lead → Contact → Schedule walkthrough → Mark LOST → walkthrough auto-cancelled', async () => {
  const { leadId } = await createContactedLead(api);

  // Schedule walkthrough
  const salesId = await createSalesUser(api);
  const { res: wtRes } = await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: salesId,
  });
  expect(wtRes.status()).toBe(200);
  const leadScheduled = await api.getLead(leadId);
  expect(leadScheduled.status).toBe('WALKTHROUGH_SCHEDULED');
  expect(leadScheduled.walkthrough_scheduled_at).toBeTruthy();

  // Mark lead LOST → walkthrough should be auto-cancelled
  const { res: lostRes } = await api.markLeadLost(leadId, 'E2E-16 customer not interested');
  expect(lostRes.status()).toBe(200);

  const leadLost = await api.getLead(leadId);
  expect(leadLost.status).toBe('LOST');
  // walkthrough_scheduled_at is cleared; walkthrough_cancelled_at is set
  expect(leadLost.walkthrough_scheduled_at).toBeNull();
  expect(leadLost.walkthrough_cancelled_at).toBeTruthy();
});

// ──────────────────────────────────────────────────────────
// E2E-17: Lead → Walkthrough scheduled → Cancel lead → walkthrough cancelled
// ──────────────────────────────────────────────────────────

test('E2E-17: Lead → Contact → Schedule walkthrough → Cancel lead → walkthrough auto-cancelled', async () => {
  const { leadId } = await createContactedLead(api);

  // Schedule walkthrough
  const salesId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: salesId,
  });
  const leadScheduled = await api.getLead(leadId);
  expect(leadScheduled.status).toBe('WALKTHROUGH_SCHEDULED');

  // Cancel lead → walkthrough should be auto-cancelled
  const { res: cancelRes } = await api.cancelLead(leadId, 'E2E-17 project on hold');
  expect(cancelRes.status()).toBe(200);

  const leadCancelled = await api.getLead(leadId);
  expect(leadCancelled.status).toBe('CANCELLED');
  expect(leadCancelled.walkthrough_scheduled_at).toBeNull();
  expect(leadCancelled.walkthrough_cancelled_at).toBeTruthy();
});

// ──────────────────────────────────────────────────────────
// E2E-18: Estimate sent (with deposit) → Cancel estimate → deposit VOIDED
// ──────────────────────────────────────────────────────────

test('E2E-18: Lead → Send estimate (deposit) → Cancel estimate → estimate ARCHIVED, deposit VOIDED', async () => {
  const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);

  const estSent = await api.getEstimate(ctx.estimateId);
  expect(estSent.status).toBe('SENT');
  expect(estSent.invoices[0]).toBeTruthy();
  expect(estSent.invoices[0].status).toBe('SENT');

  // Admin cancels estimate
  const { res: cancelRes } = await api.cancelEstimate(ctx.estimateId, 'E2E-18 scope changed');
  expect(cancelRes.status()).toBe(200);

  const estCancelled = await api.getEstimate(ctx.estimateId);
  expect(estCancelled.status).toBe('ARCHIVED');
  expect(estCancelled.invoices[0].status).toBe('VOIDED');
  expect(estCancelled.cancelled_reason).toBe('E2E-18 scope changed');
});

// ──────────────────────────────────────────────────────────
// E2E-19: Full flow → Job SCHEDULED → Cancel job → CANCELLED
// ──────────────────────────────────────────────────────────

test('E2E-19: Full flow → Job SCHEDULED → Cancel job → CANCELLED', async () => {
  const { jobId } = await fullStandardFlow(api);

  const jobScheduled = await api.getJob(jobId);
  expect(jobScheduled.status).toBe('SCHEDULED');

  // Cancel the job
  const { res: cancelRes } = await api.cancelJob(jobId, 'E2E-19 customer cancelled');
  expect(cancelRes.status()).toBe(200);

  const jobCancelled = await api.getJob(jobId);
  expect(jobCancelled.status).toBe('CANCELLED');
  expect(jobCancelled.cancelled_reason).toBe('E2E-19 customer cancelled');
});

// ──────────────────────────────────────────────────────────
// E2E-20: Full flow → Job SCHEDULED → Unassign → UNASSIGNED → Reassign → SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-20: Full flow → Job SCHEDULED → Unassign → UNASSIGNED → Reassign → SCHEDULED again', async () => {
  const { jobId } = await fullStandardFlow(api);

  const jobScheduled = await api.getJob(jobId);
  expect(jobScheduled.status).toBe('SCHEDULED');

  // Unassign
  const { res: unassignRes } = await api.unassignJob(jobId);
  expect(unassignRes.status()).toBe(200);

  const jobUnassigned = await api.getJob(jobId);
  expect(jobUnassigned.status).toBe('UNASSIGNED');
  expect(jobUnassigned.assigned_to).toBeFalsy();
  expect(jobUnassigned.scheduled_start).toBeFalsy();
  expect(jobUnassigned.scheduled_end).toBeFalsy();

  // Reassign to a new tech
  const newTechId = await createTech(api);
  const { res: reassignRes, body: reassignBody } = await api.assignJob(jobId, {
    assigned_to: newTechId,
    scheduled_start: api.futureDate(96),
    scheduled_end: api.futureDate(98),
  });
  expect(reassignRes.status()).toBe(200);
  expect(reassignBody.job.status).toBe('SCHEDULED');
  expect(reassignBody.job.assigned_to).toBe(newTechId);

  const finalJob = await api.getJob(jobId);
  expect(finalJob.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-21: Walkthrough cancel → Reschedule → Complete → Estimate → Approve → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-21: Walkthrough cancel → Reschedule → Complete → Estimate → Approve → Job → SCHEDULED', async () => {
  const { leadId } = await createContactedLead(api);
  const salesId = await createSalesUser(api);

  // Schedule walkthrough
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: salesId,
  });
  const leadScheduled = await api.getLead(leadId);
  expect(leadScheduled.status).toBe('WALKTHROUGH_SCHEDULED');

  // Cancel walkthrough → back to CONTACTED
  const { res: cancelWtRes } = await api.cancelWalkthrough(leadId, 'E2E-21 rescheduling');
  expect(cancelWtRes.status()).toBe(200);
  const leadCancelledWt = await api.getLead(leadId);
  expect(leadCancelledWt.status).toBe('CONTACTED');

  // Reschedule walkthrough
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(48),
    walkthrough_assigned_to: salesId,
  });
  const leadRescheduled = await api.getLead(leadId);
  expect(leadRescheduled.status).toBe('WALKTHROUGH_SCHEDULED');

  // Complete walkthrough
  await api.completeWalkthrough(leadId);
  const leadCompleted = await api.getLead(leadId);
  expect(leadCompleted.status).toBe('WALKTHROUGH_COMPLETED');

  // Create estimate → send → approve
  const estimate = await createDraftEstimate(api, leadId);
  const { body: sendBody } = await api.sendEstimate(estimate.id, { deposit_required: false });
  const publicToken = sendBody.estimate.public_token;
  await api.approveEstimatePublic(estimate.id, publicToken, { signature_data: api.testSignature });
  const estApproved = await api.getEstimate(estimate.id);
  expect(estApproved.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: estimate.id });
  const jobId = jobBody.job.id;
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(72),
    scheduled_end: api.futureDate(74),
  });
  expect(assignRes.status()).toBe(200);
  expect(assignBody.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// E2E-22: 3 estimates (#1 declined, #2 declined, #3 approved) → Job SCHEDULED
// ──────────────────────────────────────────────────────────

test('E2E-22: 3 estimates — #1 declined, #2 declined, #3 approved → Job → SCHEDULED', async () => {
  test.slow(); // Three estimate cycles — needs extra time
  const { leadId } = await leadToWalkthroughCompleted(api);

  // Estimate #1 → Send → Decline
  const est1 = await createDraftEstimate(api, leadId);
  const { body: send1 } = await api.sendEstimate(est1.id, { deposit_required: false });
  await api.declineEstimatePublic(est1.id, send1.estimate.public_token);
  expect((await api.getEstimate(est1.id)).status).toBe('DECLINED');

  // Estimate #2 → Send → Decline
  const est2 = await createDraftEstimate(api, leadId);
  const { body: send2 } = await api.sendEstimate(est2.id, { deposit_required: false });
  await api.declineEstimatePublic(est2.id, send2.estimate.public_token);
  expect((await api.getEstimate(est2.id)).status).toBe('DECLINED');

  // Lead should still be ESTIMATED after both declines
  const leadAfterDeclines = await api.getLead(leadId);
  expect(leadAfterDeclines.status).toBe('ESTIMATED');

  // Estimate #3 → Send → Approve
  const est3 = await createDraftEstimate(api, leadId);
  const { body: send3 } = await api.sendEstimate(est3.id, { deposit_required: false });
  const { res: approveRes } = await api.approveEstimatePublic(est3.id, send3.estimate.public_token, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);
  const est3After = await api.getEstimate(est3.id);
  expect(est3After.status).toBe('WON');
  const leadAfterApprove = await api.getLead(leadId);
  expect(leadAfterApprove.status).toBe('WON');

  // Create job + assign
  const { body: jobBody } = await api.createJob({ estimate_id: est3.id });
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
