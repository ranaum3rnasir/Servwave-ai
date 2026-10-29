import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createNewLead,
  createContactedLead,
  createDraftEstimate,
  createTech,
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

// ─── Helper: create a no-estimate job in a specific terminal state ────────────
// Entity-redesign Phase D: the urgent flow is retired — createJob no longer accepts
// is_urgent/urgency_reason. A no-estimate job ({customer_id, service_location_id}) is the
// schedulable fixture used by the job-transition guards below.

async function createUrgentJobInState(
  client: ApiClient,
  status: 'UNASSIGNED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
): Promise<string> {
  const { customerId, locationId } = await createCustomerWithLocation(client);
  const { body } = await client.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  const jobId: string = body.job.id;

  if (status === 'UNASSIGNED') return jobId;

  const techId = await createTech(client);
  await client.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: client.futureDate(24),
    scheduled_end: client.futureDate(26),
  });
  if (status === 'SCHEDULED') return jobId;

  await client.startJob(jobId);
  if (status === 'IN_PROGRESS') return jobId;

  if (status === 'COMPLETED') {
    await client.completeJob(jobId, 'All done');
    return jobId;
  }

  // CANCELLED
  await client.cancelJob(jobId, 'Guard test cancel');
  return jobId;
}

// ─── Helper: create a DECLINED estimate ──────────────────────────────────────

async function createDeclinedEstimate(client: ApiClient) {
  const ctx = await leadToSentEstimate(client);
  await client.declineEstimatePublic(ctx.estimateId, ctx.publicToken);
  return ctx;
}

// ─── Helper: create a PENDING estimate (approved with CHECK, deposit REQUESTED) ──

async function createPendingEstimate(client: ApiClient) {
  const ctx = await leadToSentEstimateWithDeposit(client, ['CHECK', 'CASH']);
  await client.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: client.testSignature,
    payment_method: 'CHECK',
  });
  return ctx;
}

// ─── Helper: create standard job from estimate ───────────────────────────────

async function createStandardJobFromEstimate(client: ApiClient) {
  const ctx = await leadToSentEstimate(client);
  await client.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: client.testSignature,
  });
  const { body } = await client.createJob({ estimate_id: ctx.estimateId });
  return { ...ctx, jobId: body.job.id };
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 20 — GUARD / NEGATIVE TESTS (G-01 to G-30)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('20.1 Job creation guards', () => {
  test('G-01: Create job from DRAFT estimate → 400', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    expect(estimate.status).toBe('DRAFT');

    const { res, body } = await api.createJob({ estimate_id: estimate.id });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-02: Create job from SENT estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('SENT');

    const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-03: Create job from WON estimate with REQUESTED deposit (PENDING state) → 400', async () => {
    // PENDING = customer approved with CHECK, deposit still REQUESTED (not yet paid)
    const ctx = await createPendingEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
    expect(estimate.invoices[0].status).toBe('SENT');

    const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-04: Create job from WON estimate with REFUNDED deposit → 201 (refund no longer blocks)', async () => {
    // Entity-redesign behavior change: the unified invoice refund no longer cancels the parent
    // estimate (stays WON), and the job-create deposit gate treats REFUNDED as OK
    // (DEPOSIT_OK = [PAID, VOIDED, PARTIALLY_REFUNDED, REFUNDED]). So a job CAN be created.
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH']);
    await api.markDepositReceived(ctx.estimateId);

    const paid = await api.getEstimate(ctx.estimateId);
    expect(paid.invoices[0].status).toBe('PAID');

    await api.refundDeposit(ctx.estimateId, {
      reason: 'Guard test refund',
      reason_category: 'CUSTOMER_CANCELLATION',
    });

    const refunded = await api.getEstimate(ctx.estimateId);
    expect(refunded.invoices[0].status).toBe('REFUNDED');
    expect(refunded.status).toBe('WON');

    const { res } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(res.status()).toBe(201);
  });

  test('G-27: Create job from WON estimate with REFUNDED deposit (same as G-04)', async () => {
    // Confirms a REFUNDED deposit passes the job-create deposit gate (estimate stays WON).
    const ctx = await leadToSentEstimateWithDeposit(api, ['CASH']);
    await api.markDepositReceived(ctx.estimateId);
    await api.refundDeposit(ctx.estimateId, {
      reason: 'Guard test G-27',
      reason_category: 'OTHER',
    });

    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('REFUNDED');
    expect(estimate.status).toBe('WON');

    const { res } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(res.status()).toBe(201);
  });
});

test.describe('20.2 Estimate send/approval guards', () => {
  test('G-05: Send estimate while walkthrough is scheduled on lead → 400', async () => {
    // Lead is in WALKTHROUGH_SCHEDULED state (not yet completed)
    const { leadId } = await createContactedLead(api);
    const salesId = await (async () => {
      const { body } = await api.createUser({
        email: `sales-g05-${api.suffix}@e2e.local`,
        password: 'Test123!@#',
        first_name: 'Sales',
        last_name: 'G05',
        role: 'SALES',
      });
      return body.user.id as string;
    })();
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    // Lead is now WALKTHROUGH_SCHEDULED; complete so we can create an estimate
    // Actually — we want WALKTHROUGH_SCHEDULED when we try to send, so skip complete
    // But we need an estimate to send — create draft first (estimate creation requires WALKTHROUGH_COMPLETED or similar)
    // Per the codebase, estimate can be created on any lead that has had a walkthrough.
    // Let's complete the walkthrough, create and send the estimate, then re-schedule a new walkthrough to test the guard.
    // Actually the guard is: send estimate while lead is WALKTHROUGH_SCHEDULED. So we need:
    // 1. Complete walkthrough → create DRAFT estimate
    // 2. Re-schedule walkthrough (lead → WALKTHROUGH_SCHEDULED again)
    // 3. Try to send the draft → 400
    await api.completeWalkthrough(leadId);
    const estimate = await createDraftEstimate(api, leadId);
    // Re-schedule walkthrough on the lead (WALKTHROUGH_COMPLETED → WALKTHROUGH_SCHEDULED)
    const { body: salesBody2 } = await api.createUser({
      email: `sales-g05b-${api.suffix}@e2e.local`,
      password: 'Test123!@#',
      first_name: 'Sales',
      last_name: 'G05b',
      role: 'SALES',
    });
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(48),
      walkthrough_assigned_to: salesBody2.user.id,
    });

    const lead = await api.getLead(leadId);
    expect(lead.status).toBe('WALKTHROUGH_SCHEDULED');

    const { res, body } = await api.sendEstimate(estimate.id, {
      deposit_required: false,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/walkthrough/i);
  });

  test('G-06: Approve EXPIRED estimate (public) → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    // Backdate the estimate so valid_until is in the past
    await api.backdateEstimate(ctx.estimateId, 10);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-07: Approve PENDING estimate (public) → 400 (only SENT can be approved)', async () => {
    const ctx = await createPendingEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-08: Decline WON estimate → 400', async () => {
    // Get to WON (no deposit)
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const approved = await api.getEstimate(ctx.estimateId);
    expect(approved.status).toBe('WON');

    const { res, body } = await api.declineEstimatePublic(ctx.estimateId, ctx.publicToken);

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-09: Decline DECLINED estimate → 400', async () => {
    const ctx = await createDeclinedEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('DECLINED');

    const { res, body } = await api.declineEstimatePublic(ctx.estimateId, ctx.publicToken);

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-28: Approve PENDING estimate (public) → 400 (duplicate of G-07 for regression)', async () => {
    const ctx = await createPendingEstimate(api);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

test.describe('20.3 Lead state guards', () => {
  test('G-10: Mark lost on WON lead → 400', async () => {
    // WON = estimate approved, lead status = WON
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');

    const { res, body } = await api.markLeadLost(ctx.leadId, 'Should fail — WON is terminal');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

test.describe('20.4 Job status transition guards', () => {
  test('G-11: Cancel COMPLETED job → 400', async () => {
    const jobId = await createUrgentJobInState(api, 'COMPLETED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('COMPLETED');

    const { res, body } = await api.cancelJob(jobId, 'Should fail — COMPLETED');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-12: Start UNASSIGNED job → 400', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('UNASSIGNED');

    const { res, body } = await api.startJob(jobId);

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-13: Complete SCHEDULED job (not started) → 400', async () => {
    const jobId = await createUrgentJobInState(api, 'SCHEDULED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('SCHEDULED');

    const { res, body } = await api.completeJob(jobId, 'Should fail — not IN_PROGRESS');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-14: Delete SCHEDULED job → 400 (only UNASSIGNED allowed)', async () => {
    const jobId = await createUrgentJobInState(api, 'SCHEDULED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('SCHEDULED');

    const { res } = await api.deleteJob(jobId);

    expect(res.status()).toBe(400);
  });

  test('G-22: Assign COMPLETED job → 400', async () => {
    const jobId = await createUrgentJobInState(api, 'COMPLETED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('COMPLETED');

    const techId = await createTech(api);
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-23: Assign CANCELLED job → 400', async () => {
    const jobId = await createUrgentJobInState(api, 'CANCELLED');
    const job = await api.getJob(jobId);
    expect(job.status).toBe('CANCELLED');

    const techId = await createTech(api);
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

// 20.5 Charge guards — REMOVED (entity-redesign Phase D).
// JobCharge is retired and the /jobs/:id/charges routes are gone (the Invoice owns line
// items). G-15 (add charge to a standard job → 400) and G-16 (add charge to a COMPLETED
// urgent job → 400) tested routes that no longer exist and have been removed.

test.describe('20.6 Deposit management guards', () => {
  test('G-17: Refund unpaid (SENT) deposit invoice → 4xx (must be PAID)', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('SENT');

    const { res, body } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Should fail',
      reason_category: 'OTHER',
    });

    // Unified invoice refund rejects a non-PAID invoice ("Invoice must be PAID to refund").
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });

  // G-18 (Reactivate PAID deposit → 400): FLOW REMOVED. The reactivate-deposit route is gone
  // (entity-redesign Phase 5) — there is no in-place reactivate, so this guard no longer
  // applies and has been removed.

  test('G-19: Waive PAID deposit → 400 (no active DRAFT/SENT deposit invoice)', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);
    await api.markDepositReceived(ctx.estimateId);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('PAID');
    expect(estimate.status).toBe('WON');

    // Waive on WON estimate with PAID deposit invoice → 400 (no active deposit to waive)
    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'waive');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-20: Waive VOIDED deposit → 400 (no active DRAFT/SENT deposit invoice)', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);
    // Waive once → deposit invoice VOIDED + estimate WON
    await api.waiveDeposit(ctx.estimateId, 'waive');
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('VOIDED');

    // Try to waive again → 400
    const { res, body } = await api.waiveDeposit(ctx.estimateId, 'waive');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-24: Change payment method on no-deposit estimate → 400', async () => {
    // Estimate sent without deposit — no deposit invoice exists (invoices is []).
    const ctx = await leadToSentEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('SENT');
    expect(estimate.invoices ?? []).toHaveLength(0);

    const { res, body } = await api.changePaymentMethodPublic(
      ctx.estimateId,
      ctx.publicToken,
      'CASH',
    );

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-25: Record deposit payment on DECLINED estimate → 400', async () => {
    const ctx = await createDeclinedEstimate(api);
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('DECLINED');

    // record-payment rejects a terminal (DECLINED) estimate.
    const { res, body } = await api.markDepositReceived(ctx.estimateId, { amount: 100, payment_method: 'CHECK' });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('G-26: Refund VOIDED deposit invoice → 4xx (must be PAID)', async () => {
    const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK']);
    // Waive to void the deposit invoice
    await api.waiveDeposit(ctx.estimateId, 'cancel');
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.invoices[0].status).toBe('VOIDED');

    const { res, body } = await api.refundDeposit(ctx.estimateId, {
      reason: 'Should fail — VOIDED',
      reason_category: 'OTHER',
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });
});

test.describe('20.7 Job walkthrough guard', () => {
  test('G-21: Job walkthrough on an estimate-derived job → 400', async () => {
    // Job-level walkthrough is only for no-estimate jobs; an estimate-derived job is rejected.
    const ctx = await createStandardJobFromEstimate(api);
    const job = await api.getJob(ctx.jobId);
    expect(job.estimate?.id ?? job.estimate_id).toBeTruthy();

    const { res, body } = await api.createJobWalkthrough(ctx.jobId, 'Should fail — has an estimate');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

test.describe('20.8 Validation guards', () => {
  test('G-29: Cancel job without reason → 400 (validation error)', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');

    // Empty string cancelled_reason should fail Zod validation (min length 1)
    const { res, body } = await api.cancelJob(jobId, '');

    expect(res.status()).toBe(400);
  });

  test('G-30: Complete job without completion_notes → 200 COMPLETED (notes optional)', async () => {
    // 2026-06-10 catalog-§5 contradiction fix (§5.2): completeJobSchema (job.controller.ts) is
    // all-optional — empty completion_notes passes validation and the job completes; the old
    // "Zod requires non-empty notes" 400 expectation was stale. — verify at baseline run
    const jobId = await createUrgentJobInState(api, 'IN_PROGRESS');

    // Complete with empty notes — accepted, notes stored as null
    const { res, body } = await api.completeJob(jobId, '');

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('COMPLETED');
  });
});
