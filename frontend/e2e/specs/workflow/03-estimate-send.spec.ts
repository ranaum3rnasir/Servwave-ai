import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createNewLead,
  createContactedLead,
  createSalesUser,
  leadToWalkthroughCompleted,
  createDraftEstimate,
  leadToSentEstimate,
} from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// 3.1 Send Without Deposit
// ──────────────────────────────────────────────────────────

test.describe('3.1 Send Without Deposit', () => {
  test('S-01: Send estimate, deposit_required=false → DRAFT→SENT, public_token, valid_until', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res, body } = await api.sendEstimate(estimate.id, {
      deposit_required: false,
    });
    expect(res.ok()).toBe(true);
    expect(body.estimate.status).toBe('SENT');
    expect(body.estimate.public_token).toBeTruthy();
    expect(body.estimate.valid_until).toBeTruthy();
    // No deposit invoice should be created (entity-redesign: deposit = kind=DEPOSIT invoice)
    expect(body.estimate.invoices ?? []).toHaveLength(0);
    expect(body.estimate.sent_at).toBeTruthy();
  });

  test('S-02: Send for CONTACTED lead → lead auto-transitions to ESTIMATED', async () => {
    const { leadId } = await createContactedLead(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res } = await api.sendEstimate(estimate.id, { deposit_required: false });
    expect(res.ok()).toBe(true);
    const lead = await api.getLead(leadId);
    expect(lead.status).toBe('ESTIMATED');
  });

  test('S-03: Send for WALKTHROUGH_COMPLETED lead → lead auto-transitions to ESTIMATED', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res } = await api.sendEstimate(estimate.id, { deposit_required: false });
    expect(res.ok()).toBe(true);
    const lead = await api.getLead(leadId);
    expect(lead.status).toBe('ESTIMATED');
  });

  test('S-04: Send second estimate for already-ESTIMATED lead → lead stays ESTIMATED', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    // First estimate → lead becomes ESTIMATED
    const first = await createDraftEstimate(api, leadId);
    await api.sendEstimate(first.id, { deposit_required: false });
    const leadAfterFirst = await api.getLead(leadId);
    expect(leadAfterFirst.status).toBe('ESTIMATED');
    // Second estimate
    const second = await createDraftEstimate(api, leadId);
    const { res } = await api.sendEstimate(second.id, { deposit_required: false });
    expect(res.ok()).toBe(true);
    const leadAfterSecond = await api.getLead(leadId);
    // Lead stays ESTIMATED, no double-transition
    expect(leadAfterSecond.status).toBe('ESTIMATED');
  });

  test('S-04a: Send for NEW lead → lead stays NEW', async () => {
    const { lead } = await createNewLead(api);
    const estimate = await createDraftEstimate(api, lead.id);
    const { res } = await api.sendEstimate(estimate.id, { deposit_required: false });
    expect(res.ok()).toBe(true);
    const updatedLead = await api.getLead(lead.id);
    // NEW is not in the auto-transition list (CONTACTED/WALKTHROUGH_COMPLETED only)
    expect(updatedLead.status).toBe('NEW');
  });

  test('S-04b: Send for WALKTHROUGH_SCHEDULED lead → 400 (walkthrough guard)', async () => {
    // The controller blocks sending while walkthrough is scheduled
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const estimate = await createDraftEstimate(api, leadId);
    const { res } = await api.sendEstimate(estimate.id, { deposit_required: false });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 3.2 Send With Deposit
// ──────────────────────────────────────────────────────────

test.describe('3.2 Send With Deposit', () => {
  test('S-05: Send deposit_required=true, methods=[CARD,CHECK,CASH] → Deposit created REQUESTED', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res, body } = await api.sendEstimate(estimate.id, {
      deposit_required: true,
      payment_methods: ['CARD', 'CHECK', 'CASH'],
    });
    expect(res.ok()).toBe(true);
    expect(body.estimate.status).toBe('SENT');
    expect(body.estimate.public_token).toBeTruthy();
    expect(body.estimate.valid_until).toBeTruthy();
    // Fetch full estimate to verify deposit (send response may not include freshly-created deposit)
    const full = await api.getEstimate(estimate.id);
    expect(full.invoices[0]).toBeTruthy();
    expect(full.invoices[0].status).toBe('SENT');
    expect(Number(full.invoices[0].total_amount)).toBeGreaterThan(0);
    // Send config should reflect the methods
    expect(full.send_config).toBeDefined();
    expect(full.send_config.deposit_required).toBe(true);
    expect(full.send_config.payment_methods).toEqual(
      expect.arrayContaining(['CARD', 'CHECK', 'CASH'])
    );
  });

  test('S-06: Send deposit_required=true, methods=[BANK_TRANSFER] → single method', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res, body } = await api.sendEstimate(estimate.id, {
      deposit_required: true,
      payment_methods: ['BANK_TRANSFER'],
    });
    expect(res.ok()).toBe(true);
    expect(body.estimate.status).toBe('SENT');
    // Fetch full estimate to verify deposit
    const full = await api.getEstimate(estimate.id);
    expect(full.invoices[0]).toBeTruthy();
    expect(full.invoices[0].status).toBe('SENT');
    expect(full.send_config.payment_methods).toEqual(['BANK_TRANSFER']);
  });

  test('S-07: Send deposit_required=true, methods=[] → 400', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res } = await api.sendEstimate(estimate.id, {
      deposit_required: true,
      payment_methods: [],
    });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 3.3 Send Guards
// ──────────────────────────────────────────────────────────

test.describe('3.3 Send Guards', () => {
  test('S-08: Send estimate while walkthrough scheduled → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(48),
      walkthrough_assigned_to: salesId,
    });
    const estimate = await createDraftEstimate(api, leadId);
    const { res, body } = await api.sendEstimate(estimate.id, { deposit_required: false });
    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/walkthrough/i);
  });

  test('S-09: Resend already-SENT estimate → stays SENT, message updated', async () => {
    const ctx = await leadToSentEstimate(api);
    // Resend with updated message
    const newMessage = `Updated message ${api.suffix}`;
    const { res, body } = await api.sendEstimate(ctx.estimateId, {
      deposit_required: false,
      message_body: newMessage,
    });
    expect(res.ok()).toBe(true);
    expect(body.estimate.status).toBe('SENT');
    expect(body.estimate.id).toBe(ctx.estimateId);
    // public_token and valid_until should be unchanged
    expect(body.estimate.public_token).toBe(ctx.publicToken);
    // send_config message_body updated
    expect(body.estimate.send_config?.message_body).toBe(newMessage);
  });

  test('S-10: Resend SENT estimate that already has deposit → deposit unchanged', async () => {
    const ctx = await leadToSentEstimate(api, { deposit: true, methods: ['CHECK', 'CASH'] });
    // Fetch full estimate to get the deposit that was created on first send
    const beforeResend = await api.getEstimate(ctx.estimateId);
    expect(beforeResend.invoices[0]).toBeTruthy();
    expect(beforeResend.invoices[0].status).toBe('SENT');
    const depositIdBefore = beforeResend.invoices[0].id;
    // Resend
    const { res } = await api.sendEstimate(ctx.estimateId, {
      deposit_required: false,
      message_body: 'Resending with updated note',
    });
    expect(res.ok()).toBe(true);
    // Fetch again to verify the deposit invoice is unchanged
    const afterResend = await api.getEstimate(ctx.estimateId);
    expect(afterResend.status).toBe('SENT');
    expect(afterResend.invoices[0]).toBeTruthy();
    expect(afterResend.invoices[0].id).toBe(depositIdBefore);
    expect(afterResend.invoices[0].status).toBe('SENT');
  });

  test('S-11: Send WON estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('WON');
    const { res } = await api.sendEstimate(ctx.estimateId, { deposit_required: false });
    expect(res.status()).toBe(400);
  });
});
