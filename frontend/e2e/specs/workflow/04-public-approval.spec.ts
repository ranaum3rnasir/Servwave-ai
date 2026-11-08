import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { leadToSentEstimate } from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// Section 4: Public Approval (no deposit)
// ──────────────────────────────────────────────────────────

test.describe('4. Public Approval (No Deposit)', () => {
  test('P-01: Approve SENT estimate (no deposit), valid signature → WON, lead→WON', async () => {
    const ctx = await leadToSentEstimate(api);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(200);
    expect(body.estimate.status).toBe('WON');
    expect(body.estimate.signature_data).toBe(api.testSignature);
    expect(body.estimate.approved_at).toBeTruthy();

    // Verify lead transitioned to WON
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
  });

  test('P-02: Approve with missing signature → 400', async () => {
    const ctx = await leadToSentEstimate(api);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: '',
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test('P-02a: Approve with invalid signature format (not data:image/) → 400', async () => {
    const ctx = await leadToSentEstimate(api);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: 'not-a-valid-data-uri',
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/invalid signature format/i);
  });

  test('P-03: Approve expired estimate → 400', async () => {
    // 2026-06-10 catalog-§5 contradiction fix (§5.4): stale skip — the backdate test door DOES
    // exist (api.backdateEstimate → PATCH /api/test/backdate-estimate/:id, already used by
    // EX-01..) and approvePublic (estimate.controller.ts) rejects a past valid_until with
    // 400 'Estimate has expired'. Un-skipped + implemented. — verify at baseline run
    const ctx = await leadToSentEstimate(api);

    // Push valid_until into the past — status stays SENT, so approve hits the expiry guard
    // (not the cron; do NOT trigger expire-estimates here or the status guard fires first).
    const { res: backdateRes } = await api.backdateEstimate(ctx.estimateId, 2);
    expect(backdateRes.status()).toBe(200);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toBe('Estimate has expired');
  });

  test('P-04: Approve with wrong token → 404', async () => {
    const ctx = await leadToSentEstimate(api);

    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, 'wrong-token-abc123', {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('P-05: Approve already-WON estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);

    // First approval
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    // Second approval attempt
    const { res, body } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/cannot approve a won estimate/i);
  });
});
