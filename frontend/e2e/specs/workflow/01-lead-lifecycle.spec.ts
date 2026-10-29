import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createNewLead,
  createContactedLead,
  createSalesUser,
  createTech,
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
// 1.1 Lead Creation
// ──────────────────────────────────────────────────────────

test.describe('1.1 Lead Creation', () => {
  test('L-01: Create lead with existing customer', async () => {
    const { customerId } = await createCustomerWithLocation(api);
    const { res, body } = await api.createLead({
      customer_id: customerId,
      service_request: `L-01 test ${api.suffix}`,
    });
    expect(res.status()).toBe(201);
    expect(body.lead.status).toBe('NEW');
    expect(body.lead.lead_number).toMatch(/^L\d{5}$/);
    expect(body.lead.customer_id).toBe(customerId);
  });

  // 2026-06-10: contradicts probe INT-18 (redesign-26) — baseline run decides which is right; see catalog §5.3.
  test('L-02: Create lead with new inline customer', async () => {
    const s = api.suffix;
    // `as any`: the typed createLead signature requires customer_id; the inline-new_customer
    // shape is the legitimate XOR alternative (behavior unchanged — type-hygiene only, 2026-06-10).
    const { res, body } = await api.createLead({
      new_customer: {
        first_name: `New-${s}`,
        last_name: 'InlineCustomer',
        email: `inline-${s}@e2e.local`,
        phone: '5559876543',
        location: {
          address_line1: '456 Inline Ave',
          city: 'Houston',
          state: 'TX',
          zip: '77001',
        },
      },
      service_request: `L-02 inline customer test ${s}`,
    } as any);
    expect(res.status()).toBe(201);
    expect(body.lead.status).toBe('NEW');
    expect(body.lead.lead_number).toMatch(/^L\d{5}$/);
    // Customer was created and linked
    expect(body.lead.customer.first_name).toContain(`New-${s}`);
  });

  test('L-03: Create lead with service address fields', async () => {
    const { customerId } = await createCustomerWithLocation(api);
    const { res, body } = await api.createLead({
      customer_id: customerId,
      service_request: `L-03 address test ${api.suffix}`,
      service_address_line1: '789 Service Blvd',
      service_city: 'Dallas',
      service_state: 'TX',
      service_zip: '75201',
    });
    expect(res.status()).toBe(201);
    expect(body.lead.service_address_line1).toBe('789 Service Blvd');
    expect(body.lead.service_city).toBe('Dallas');
    expect(body.lead.service_state).toBe('TX');
    expect(body.lead.service_zip).toBe('75201');
  });

  test('L-04a: Create lead with BOTH customer_id AND new_customer → 400', async () => {
    const { customerId } = await createCustomerWithLocation(api);
    const s = api.suffix;
    const { res } = await api.createLead({
      customer_id: customerId,
      new_customer: {
        first_name: `Both-${s}`,
        last_name: 'Test',
        email: `both-${s}@e2e.local`,
        phone: '5551111111',
        location: { address_line1: '1 Test St', city: 'Austin', state: 'TX', zip: '78701' },
      },
      service_request: `L-04a both test ${s}`,
    });
    expect(res.status()).toBe(400);
  });

  test('L-04b: Create lead with NEITHER customer_id nor new_customer → 400', async () => {
    const { res } = await api.createLead({
      service_request: `L-04b neither test ${api.suffix}`,
    } as any);
    expect(res.status()).toBe(400);
  });

  test('L-04c: Create lead with non-existent customer_id → 400', async () => {
    const { res, body } = await api.createLead({
      customer_id: '00000000-0000-0000-0000-000000000000',
      service_request: `L-04c bad customer ${api.suffix}`,
    });
    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/customer not found/i);
  });
});

// ──────────────────────────────────────────────────────────
// 1.2 Lead Update (PATCH)
// ──────────────────────────────────────────────────────────

test.describe('1.2 Lead Update', () => {
  test('L-04: Update lead fields (service_request, notes, job_type, job_source)', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.updateLead(lead.id, {
      service_request: `Updated request ${api.suffix}`,
      notes: 'Updated notes',
      job_type: 'HVAC',
      job_source: 'Referral',
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.service_request).toContain('Updated request');
    expect(body.lead.notes).toBe('Updated notes');
    expect(body.lead.job_type).toBe('HVAC');
    expect(body.lead.job_source).toBe('Referral');
  });

  // L-05 removed (Walkthrough-as-entity redesign, PR-D2): asserted "set walkthrough_needed=false
  // while WALKTHROUGH_SCHEDULED -> 400", a guard removed in PR-B2 (bucket intent and visit state
  // are separate concerns) against a lead status retired in PR-C2. walkthrough_needed itself is
  // now deleted entirely (Ran's call - see the spec's "Decision update" note), so there is no
  // remaining behavior for this test to assert.
});

// ──────────────────────────────────────────────────────────
// 1.3 Lead Contact
// ──────────────────────────────────────────────────────────

test.describe('1.3 Lead Contact', () => {
  test('L-06: Contact a NEW lead → CONTACTED', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.contactLead(lead.id);
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CONTACTED');
    expect(body.lead.contacted_at).toBeTruthy();
  });

  test('L-07: Contact a CONTACTED lead → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const { res } = await api.contactLead(leadId);
    expect(res.status()).toBe(400);
  });

  test('L-08: Contact an ESTIMATED lead → 400', async () => {
    // Build ESTIMATED lead via walkthrough complete + send estimate
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    await api.sendEstimate(estimate.id, { deposit_required: false });
    // Lead should now be ESTIMATED
    const lead = await api.getLead(leadId);
    expect(lead.status).toBe('ESTIMATED');
    const { res } = await api.contactLead(leadId);
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.4 Walkthrough Scheduling
// ──────────────────────────────────────────────────────────

test.describe('1.4 Walkthrough Scheduling', () => {
  test('L-09: Schedule walkthrough on CONTACTED lead → WALKTHROUGH_SCHEDULED', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    const { res, body } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('WALKTHROUGH_SCHEDULED');
    expect(body.lead.walkthrough_assigned_to).toBe(salesId);
  });

  test('L-10: Schedule walkthrough on WALKTHROUGH_COMPLETED lead → WALKTHROUGH_SCHEDULED (reschedule)', async () => {
    const { leadId, techId } = await leadToWalkthroughCompleted(api);
    const { res, body } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(48),
      walkthrough_assigned_to: techId,
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('WALKTHROUGH_SCHEDULED');
  });

  test('L-11: Reschedule walkthrough on WALKTHROUGH_SCHEDULED lead — stays WALKTHROUGH_SCHEDULED, dates updated', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const newTime = api.futureDate(48);
    const { res, body } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: newTime,
      walkthrough_assigned_to: salesId,
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('WALKTHROUGH_SCHEDULED');
    // Scheduled date should be updated
    expect(new Date(body.lead.walkthrough_scheduled_at).getTime()).toBeCloseTo(
      new Date(newTime).getTime(), -4
    );
  });

  test('L-12: Schedule walkthrough with conflict (no force) → 409', async () => {
    const salesId = await createSalesUser(api);
    const conflictTime = api.futureDate(72);

    // Schedule first walkthrough for this performer
    const { leadId: leadId1 } = await createContactedLead(api);
    await api.scheduleWalkthrough(leadId1, {
      walkthrough_scheduled_at: conflictTime,
      walkthrough_assigned_to: salesId,
      walkthrough_duration_minutes: 60,
    });

    // Attempt second walkthrough at same time for same performer, no force
    const { leadId: leadId2 } = await createContactedLead(api);
    const { res, body } = await api.scheduleWalkthrough(leadId2, {
      walkthrough_scheduled_at: conflictTime,
      walkthrough_assigned_to: salesId,
      walkthrough_duration_minutes: 60,
      force: false,
    });
    expect(res.status()).toBe(409);
    expect(body.conflicts).toBeDefined();
    expect(body.conflicts.length).toBeGreaterThan(0);
  });

  test('L-13: Schedule walkthrough with conflict + force=true → succeeds', async () => {
    const salesId = await createSalesUser(api);
    const conflictTime = api.futureDate(96);

    // Schedule first walkthrough
    const { leadId: leadId1 } = await createContactedLead(api);
    await api.scheduleWalkthrough(leadId1, {
      walkthrough_scheduled_at: conflictTime,
      walkthrough_assigned_to: salesId,
      walkthrough_duration_minutes: 60,
    });

    // Force-schedule second walkthrough at same time
    const { leadId: leadId2 } = await createContactedLead(api);
    const { res, body } = await api.scheduleWalkthrough(leadId2, {
      walkthrough_scheduled_at: conflictTime,
      walkthrough_assigned_to: salesId,
      walkthrough_duration_minutes: 60,
      force: true,
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('WALKTHROUGH_SCHEDULED');
  });

  test('L-14: Schedule walkthrough on NEW lead → 400', async () => {
    const { lead } = await createNewLead(api);
    const salesId = await createSalesUser(api);
    const { res } = await api.scheduleWalkthrough(lead.id, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.status()).toBe(400);
  });

  test('L-15: Schedule walkthrough on ESTIMATED lead → 400', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    await api.sendEstimate(estimate.id, { deposit_required: false });
    const salesId = await createSalesUser(api);
    const { res } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.status()).toBe(400);
  });

  test('L-15a: Schedule walkthrough on WON lead → 400', async () => {
    // Build WON lead: send estimate + public approve
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const salesId = await createSalesUser(api);
    const { res } = await api.scheduleWalkthrough(ctx.leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.status()).toBe(400);
  });

  test('L-15b: Schedule walkthrough on LOST lead → 400', async () => {
    const { lead } = await createNewLead(api);
    await api.markLeadLost(lead.id, 'Already lost');
    const salesId = await createSalesUser(api);
    const { res } = await api.scheduleWalkthrough(lead.id, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.status()).toBe(400);
  });

  test('L-15c: Schedule walkthrough on CANCELLED lead → 400', async () => {
    const { lead } = await createNewLead(api);
    await api.cancelLead(lead.id, 'Already cancelled');
    const salesId = await createSalesUser(api);
    const { res } = await api.scheduleWalkthrough(lead.id, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    expect(res.status()).toBe(400);
  });

  test('L-15d: Schedule walkthrough with non-existent performer → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const { res } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status()).toBe(400);
  });

  test('L-15e: Schedule walkthrough with performer wrong role (ADMIN) → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const s = api.suffix;
    const { body: adminBody } = await api.createUser({
      email: `admin-${s}@e2e.local`,
      password: 'Test123!@#',
      first_name: 'Admin',
      last_name: s,
      role: 'ADMIN',
    });
    const adminId = adminBody.user.id;
    const { res } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: adminId,
    });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.5 Walkthrough Completion
// ──────────────────────────────────────────────────────────

test.describe('1.5 Walkthrough Completion', () => {
  test('L-16: Complete walkthrough on WALKTHROUGH_SCHEDULED lead → WALKTHROUGH_COMPLETED', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.completeWalkthrough(leadId);
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('WALKTHROUGH_COMPLETED');
    expect(body.lead.walkthrough_completed_at).toBeTruthy();
  });

  test('L-17: Complete walkthrough on non-WALKTHROUGH_SCHEDULED lead → 400', async () => {
    const { leadId } = await createContactedLead(api);
    // CONTACTED — no walkthrough scheduled
    const { res } = await api.completeWalkthrough(leadId);
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.6 Walkthrough Cancellation
// ──────────────────────────────────────────────────────────

test.describe('1.6 Walkthrough Cancellation', () => {
  test('L-18: Cancel walkthrough on WALKTHROUGH_SCHEDULED lead → CONTACTED', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.cancelWalkthrough(leadId, 'No longer needed');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CONTACTED');
    expect(body.lead.walkthrough_scheduled_at).toBeNull();
    expect(body.lead.walkthrough_cancelled_at).toBeTruthy();
  });

  test('L-19: Cancel walkthrough on non-WALKTHROUGH_SCHEDULED lead → 400', async () => {
    const { leadId } = await createContactedLead(api);
    // CONTACTED — no walkthrough scheduled
    const { res } = await api.cancelWalkthrough(leadId, 'Nothing to cancel');
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.7 Walkthrough Notes & Duration Update
// ──────────────────────────────────────────────────────────

test.describe('1.7 Walkthrough Notes & Duration Update', () => {
  test('L-20: Update walkthrough notes on any lead', async () => {
    const { leadId } = await createContactedLead(api);
    const { res, body } = await api.updateWalkthroughNotes(leadId, {
      walkthrough_notes: 'Customer wants HVAC inspection in garage',
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.walkthrough_notes).toBe('Customer wants HVAC inspection in garage');
  });

  test('L-21: Update walkthrough duration (valid: 15-480 min)', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.updateWalkthroughNotes(leadId, {
      walkthrough_duration_minutes: 90,
    });
    expect(res.ok()).toBe(true);
    expect(body.lead.walkthrough_duration_minutes).toBe(90);
  });

  test('L-22: Update walkthrough duration out of range (<15) → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const { res } = await api.updateWalkthroughNotes(leadId, {
      walkthrough_duration_minutes: 10,
    });
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.8 Lead Assignment
// ──────────────────────────────────────────────────────────

test.describe('1.8 Lead Assignment', () => {
  test('L-23: Assign lead to active SALES user', async () => {
    const { lead } = await createNewLead(api);
    const salesId = await createSalesUser(api);
    const { res, body } = await api.assignLead(lead.id, salesId);
    expect(res.ok()).toBe(true);
    expect(body.lead.assigned_to).toBe(salesId);
  });

  test('L-24: Assign lead to non-existent user → 400', async () => {
    const { lead } = await createNewLead(api);
    const { res } = await api.assignLead(lead.id, '00000000-0000-0000-0000-000000000000');
    expect(res.status()).toBe(400);
  });

  test('L-25: Assign lead to non-SALES role user → 400', async () => {
    const { lead } = await createNewLead(api);
    const techId = await createTech(api);
    const { res } = await api.assignLead(lead.id, techId);
    expect(res.status()).toBe(400);
  });

  test('L-26: Reassign lead where walkthrough_assigned_to matches old owner → walkthrough_assigned_to auto-updates', async () => {
    // Create lead, assign to salesUser1, schedule walkthrough (performer = salesUser1)
    const { lead } = await createNewLead(api);
    const salesId1 = await createSalesUser(api);
    const salesId2 = await createSalesUser(api);
    await api.assignLead(lead.id, salesId1);
    await api.contactLead(lead.id);
    await api.scheduleWalkthrough(lead.id, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId1,
    });
    // Verify walkthrough performer = salesId1 and assigned_to = salesId1
    const before = await api.getLead(lead.id);
    expect(before.walkthrough_assigned_to).toBe(salesId1);
    expect(before.assigned_to).toBe(salesId1);

    // Reassign to salesId2 — walkthrough performer should auto-update
    const { res, body } = await api.assignLead(lead.id, salesId2);
    expect(res.ok()).toBe(true);
    expect(body.lead.assigned_to).toBe(salesId2);
    expect(body.lead.walkthrough_assigned_to).toBe(salesId2);
  });
});

// ──────────────────────────────────────────────────────────
// 1.9 Lead Termination — Mark Lost
// ──────────────────────────────────────────────────────────

test.describe('1.9 Lead Termination — Mark Lost', () => {
  test('L-27: Mark NEW lead as lost', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.markLeadLost(lead.id, 'Customer unresponsive');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('LOST');
    expect(body.lead.lost_reason).toBe('Customer unresponsive');
    expect(body.lead.lost_at).toBeTruthy();
  });

  test('L-28: Mark CONTACTED lead as lost', async () => {
    const { leadId } = await createContactedLead(api);
    const { res, body } = await api.markLeadLost(leadId, 'Changed mind');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('LOST');
  });

  test('L-29: Mark WALKTHROUGH_SCHEDULED lead as lost → walkthrough auto-cancelled', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.markLeadLost(leadId, 'Budget cut');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('LOST');
    expect(body.lead.walkthrough_scheduled_at).toBeNull();
    expect(body.lead.walkthrough_cancelled_at).toBeTruthy();
  });

  test('L-30: Mark WALKTHROUGH_COMPLETED lead as lost', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const { res, body } = await api.markLeadLost(leadId, 'Went with competitor');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('LOST');
  });

  test('L-31: Mark ESTIMATED lead as lost', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    await api.sendEstimate(estimate.id, { deposit_required: false });
    const { res, body } = await api.markLeadLost(leadId, 'Price too high');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('LOST');
  });

  test('L-32: Mark WON lead as lost → 400 (terminal)', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
    const { res } = await api.markLeadLost(ctx.leadId, 'Should fail');
    expect(res.status()).toBe(400);
  });

  test('L-33: Mark LOST lead as lost → 400 (already terminal)', async () => {
    const { lead } = await createNewLead(api);
    await api.markLeadLost(lead.id, 'First loss');
    const { res } = await api.markLeadLost(lead.id, 'Already lost');
    expect(res.status()).toBe(400);
  });

  test('L-34: Mark CANCELLED lead as lost → 400 (terminal)', async () => {
    const { lead } = await createNewLead(api);
    await api.cancelLead(lead.id, 'Cancelled');
    const { res } = await api.markLeadLost(lead.id, 'Should fail');
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.10 Lead Termination — Cancel
// ──────────────────────────────────────────────────────────

test.describe('1.10 Lead Termination — Cancel', () => {
  test('L-35: Cancel NEW lead → CANCELLED', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.cancelLead(lead.id, 'Test cancellation');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CANCELLED');
    expect(body.lead.cancelled_reason).toBe('Test cancellation');
    expect(body.lead.cancelled_at).toBeTruthy();
  });

  test('L-36: Cancel CONTACTED lead → CANCELLED', async () => {
    const { leadId } = await createContactedLead(api);
    const { res, body } = await api.cancelLead(leadId, 'No longer interested');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CANCELLED');
  });

  test('L-37: Cancel WALKTHROUGH_SCHEDULED lead → CANCELLED, walkthrough auto-cancelled', async () => {
    const { leadId } = await createContactedLead(api);
    const salesId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    const { res, body } = await api.cancelLead(leadId, 'Customer cancelled');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CANCELLED');
    expect(body.lead.walkthrough_scheduled_at).toBeNull();
    expect(body.lead.walkthrough_cancelled_at).toBeTruthy();
  });

  test('L-38: Cancel WALKTHROUGH_COMPLETED lead → CANCELLED', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const { res, body } = await api.cancelLead(leadId, 'Customer request');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CANCELLED');
  });

  test('L-39: Cancel ESTIMATED lead → CANCELLED', async () => {
    const { leadId } = await leadToWalkthroughCompleted(api);
    const estimate = await createDraftEstimate(api, leadId);
    await api.sendEstimate(estimate.id, { deposit_required: false });
    const { res, body } = await api.cancelLead(leadId, 'Budget cut');
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CANCELLED');
  });

  test('L-40a: Cancel WON lead → 400 (terminal)', async () => {
    const ctx = await leadToSentEstimate(api);
    await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature,
    });
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');
    const { res } = await api.cancelLead(ctx.leadId, 'Should fail');
    expect(res.status()).toBe(400);
  });

  test('L-40b: Cancel LOST lead → 400 (terminal)', async () => {
    const { lead } = await createNewLead(api);
    await api.markLeadLost(lead.id, 'Lost');
    const { res } = await api.cancelLead(lead.id, 'Should fail');
    expect(res.status()).toBe(400);
  });

  test('L-40c: Cancel CANCELLED lead → 400 (terminal)', async () => {
    const { lead } = await createNewLead(api);
    await api.cancelLead(lead.id, 'Cancelled');
    const { res } = await api.cancelLead(lead.id, 'Should fail');
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────
// 1.11 Lead Notes
// ──────────────────────────────────────────────────────────

test.describe('1.11 Lead Notes', () => {
  test('L-41: Add note to lead', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.addLeadNote(lead.id, 'This is a test note');
    expect(res.ok()).toBe(true);
    expect(body.note).toBeDefined();
    expect(body.note.content).toBe('This is a test note');
    expect(body.note.creator).toBeDefined();
  });

  test('L-42: List notes for lead — newest first', async () => {
    const { lead } = await createNewLead(api);
    await api.addLeadNote(lead.id, 'First note');
    await api.addLeadNote(lead.id, 'Second note');
    await api.addLeadNote(lead.id, 'Third note');
    const notesResponse = await api.getLeadNotes(lead.id);
    expect(notesResponse.notes).toBeDefined();
    expect(notesResponse.notes.length).toBeGreaterThanOrEqual(3);
    // Newest first: "Third note" should appear before "First note"
    const contents = notesResponse.notes.map((n: any) => n.content);
    const thirdIdx = contents.indexOf('Third note');
    const firstIdx = contents.indexOf('First note');
    expect(thirdIdx).toBeLessThan(firstIdx);
  });
});
