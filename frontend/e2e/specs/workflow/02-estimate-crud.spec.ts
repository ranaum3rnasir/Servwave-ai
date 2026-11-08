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
// 2.1 Estimate Creation
// ──────────────────────────────────────────────────────────

test.describe('2.1 Estimate Creation', () => {
  test('E-01: Create estimate for CONTACTED lead → DRAFT', async () => {
    const { leadId } = await createContactedLead(api);
    const { res, body } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'HVAC Service', quantity: 1, unit_price: 450, is_taxable: true }],
      tax_rate: 0.0825,
      scope_notes: 'E-01 test',
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
    expect(body.estimate.estimate_number).toMatch(/^E\d{5}$/);
    expect(body.estimate.lead_id).toBe(leadId);
    expect(Number(body.estimate.total_amount)).toBeGreaterThan(0);
  });

  test('E-02: Create estimate for WALKTHROUGH_COMPLETED lead → DRAFT', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const { res, body } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Plumbing Repair', quantity: 2, unit_price: 200, is_taxable: true }],
      tax_rate: 0.08,
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
    expect(body.estimate.estimate_number).toMatch(/^E\d{5}$/);
  });

  test('E-03: Create estimate for NEW lead → DRAFT (not terminal)', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.createEstimate({
      lead_id: lead.id,
      line_items: [{ description: 'Electrical Work', quantity: 1, unit_price: 300, is_taxable: false }],
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });

  test('E-04: Create estimate for WALKTHROUGH_SCHEDULED lead → DRAFT', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Initial Assessment', quantity: 1, unit_price: 150, is_taxable: true }],
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });

  test('E-05: Create estimate for ESTIMATED lead (second estimate) → DRAFT', async () => {
    // First, advance lead to ESTIMATED by sending first estimate
    const { leadId } = await leadToWalkthroughCompleted(api);
    const firstEstimate = await createDraftEstimate(api, leadId);
    await api.sendEstimate(firstEstimate.id, { deposit_required: false });
    // Lead is now ESTIMATED — create second estimate
    const { res, body } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Revised Scope', quantity: 1, unit_price: 800, is_taxable: true }],
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });

  test('E-06: Create estimate for WON lead → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
    const { res } = await api.createEstimate({
      lead_id: ctx.leadId,
      line_items: [{ description: 'Should fail', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status()).toBe(400);
  });

  test('E-07: Create estimate for LOST lead → 400', async () => {
    const { lead } = await createNewLead(api);
    await api.markLeadLost(lead.id, 'Lost deal');
    const { res } = await api.createEstimate({
      lead_id: lead.id,
      line_items: [{ description: 'Should fail', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status()).toBe(400);
  });

  test('E-08: Create estimate for CANCELLED lead → 400', async () => {
    const { lead } = await createNewLead(api);
    await api.cancelLead(lead.id, 'Cancelled by customer');
    const { res } = await api.createEstimate({
      lead_id: lead.id,
      line_items: [{ description: 'Should fail', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status()).toBe(400);
  });

  test('E-09: Create estimate with no line items → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const { res } = await api.createEstimate({
      lead_id: leadId,
      line_items: [],
    });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 2.2 Estimate Edit
// ──────────────────────────────────────────────────────────

test.describe('2.2 Estimate Edit', () => {
  test('E-10: Update DRAFT estimate → totals recalculated', async () => {
    const { leadId } = await createContactedLead(api);
    const estimate = await createDraftEstimate(api, leadId);
    const originalTotal = estimate.total_amount;

    const { res, body } = await api.updateEstimate(estimate.id, {
      line_items: [
        { description: 'Updated Service', quantity: 3, unit_price: 1000, is_taxable: true },
      ],
      tax_rate: 0.1,
      scope_notes: 'Updated scope notes',
    });
    expect(res.ok()).toBe(true);
    expect(body.estimate.status).toBe('DRAFT');
    expect(body.estimate.scope_notes).toBe('Updated scope notes');
    // Totals should be recalculated: 3 * 1000 = 3000 subtotal, + 10% tax = 3300
    expect(Number(body.estimate.total_amount)).toBeGreaterThan(Number(originalTotal));
    expect(Number(body.estimate.subtotal)).toBeCloseTo(3000, 1);
  });

  test('E-11: Update SENT estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    const { res } = await api.updateEstimate(ctx.estimateId, {
      scope_notes: 'Should fail',
    });
    expect(res.status()).toBe(400);
  });

  test('E-12: Update WON estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const { res } = await api.updateEstimate(ctx.estimateId, {
      scope_notes: 'Should fail',
    });
    expect(res.status()).toBe(400);
  });

  test('E-13: Update PENDING estimate → 400', async () => {
    // PENDING = sent with deposit, then customer selects non-Stripe method
    const ctx = await leadToSentEstimate(api, { deposit: true, methods: ['CHECK'] });
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CHECK',
    });
    // Estimate should now be PENDING
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
    const { res } = await api.updateEstimate(ctx.estimateId, {
      scope_notes: 'Should fail',
    });
    expect(res.status()).toBe(400);
  });

  test('E-14: Update ARCHIVED estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.cancelEstimate(ctx.estimateId, 'Test cancellation');
    const { res } = await api.updateEstimate(ctx.estimateId, {
      scope_notes: 'Should fail',
    });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 2.3 Estimate Delete
// ──────────────────────────────────────────────────────────

test.describe('2.3 Estimate Delete', () => {
  test('E-15: Delete DRAFT estimate → success', async () => {
    const { leadId } = await createContactedLead(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res, status } = await api.deleteEstimate(estimate.id);
    expect(status).toBe(200);
    // Verify it's gone — getEstimate returns undefined (no .estimate key in 404 response)
    const getRes = await api.getEstimate(estimate.id);
    expect(getRes).toBeUndefined();
  });

  test('E-16: Delete SENT estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    const { status } = await api.deleteEstimate(ctx.estimateId);
    expect(status).toBe(400);
  });

  test('E-17: Delete PENDING estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api, { deposit: true, methods: ['CASH'] });
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
      payment_method: 'CASH',
    });
    const estimate = await api.getEstimate(ctx.estimateId);
    expect(estimate.status).toBe('PENDING');
    const { status } = await api.deleteEstimate(ctx.estimateId);
    expect(status).toBe(400);
  });

  test('E-18: Delete WON estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const { status } = await api.deleteEstimate(ctx.estimateId);
    expect(status).toBe(400);
  });

  test('E-19: Delete ARCHIVED estimate → 400', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.cancelEstimate(ctx.estimateId, 'Cancelling for delete test');
    const { status } = await api.deleteEstimate(ctx.estimateId);
    expect(status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 2.4 Estimate Duplicate
// ──────────────────────────────────────────────────────────

test.describe('2.4 Estimate Duplicate', () => {
  test('E-20: Duplicate DRAFT estimate → new DRAFT with same items', async () => {
    const { leadId } = await createContactedLead(api);
    const original = await createDraftEstimate(api, leadId);
    const { res, body } = await api.duplicateEstimate(original.id);
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
    expect(body.estimate.id).not.toBe(original.id);
    expect(body.estimate.estimate_number).not.toBe(original.estimate_number);
    expect(body.estimate.estimate_number).toMatch(/^E\d{5}$/);
    // Same line items count
    expect(body.estimate.line_items.length).toBe(original.line_items.length);
    // Same lead
    expect(body.estimate.lead_id).toBe(original.lead_id);
  });

  test('E-21: Duplicate SENT estimate → new DRAFT', async () => {
    const ctx = await leadToSentEstimate(api);
    const { res, body } = await api.duplicateEstimate(ctx.estimateId);
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
    expect(body.estimate.id).not.toBe(ctx.estimateId);
  });

  test('E-22: Duplicate WON estimate → new DRAFT', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const { res, body } = await api.duplicateEstimate(ctx.estimateId);
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });

  test('E-23: Duplicate DECLINED estimate → new DRAFT', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.declineEstimatePublic(ctx.estimateId, ctx.publicToken);
    const { res, body } = await api.duplicateEstimate(ctx.estimateId);
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });

  test('E-24: Duplicate ARCHIVED estimate → new DRAFT', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.cancelEstimate(ctx.estimateId, 'Cancelling to test duplicate');
    const { res, body } = await api.duplicateEstimate(ctx.estimateId);
    expect(res.status()).toBe(201);
    expect(body.estimate.status).toBe('DRAFT');
  });
});

// ──────────────────────────────────────────────────────────
// 2.5 Estimate Notes
// ──────────────────────────────────────────────────────────

test.describe('2.5 Estimate Notes', () => {
  test('E-25: Add note to estimate', async () => {
    const { leadId } = await createContactedLead(api);
    const estimate = await createDraftEstimate(api, leadId);
    const { res, body } = await api.addEstimateNote(estimate.id, 'Customer requested rush service');
    expect(res.ok()).toBe(true);
    expect(body.note).toBeDefined();
    expect(body.note.content).toBe('Customer requested rush service');
    expect(body.note.creator).toBeDefined();
  });

  test('E-26: List notes for estimate — newest first', async () => {
    const { leadId } = await createContactedLead(api);
    const estimate = await createDraftEstimate(api, leadId);
    await api.addEstimateNote(estimate.id, 'First note');
    await api.addEstimateNote(estimate.id, 'Second note');
    await api.addEstimateNote(estimate.id, 'Third note');
    const notesResponse = await api.getEstimateNotes(estimate.id);
    expect(notesResponse.notes).toBeDefined();
    expect(notesResponse.notes.length).toBeGreaterThanOrEqual(3);
    // Newest first: "Third note" should appear before "First note"
    const contents = notesResponse.notes.map((n: any) => n.content);
    const thirdIdx = contents.indexOf('Third note');
    const firstIdx = contents.indexOf('First note');
    expect(thirdIdx).toBeLessThan(firstIdx);
  });
});
