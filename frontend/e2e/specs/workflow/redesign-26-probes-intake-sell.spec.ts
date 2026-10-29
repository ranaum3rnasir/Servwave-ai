import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createSalesUser } from '../../helpers/workflow-builders';

/**
 * PROBES — intake + sell (catalog 🧪 rows INT-18 and SEL-31).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED.
 *
 * Catalog: md_files/specs/testing/lifecycle-regression-catalog.md §3 (INT-18, SEL-31),
 * §4 Wave-2 ("probes that pin suspected bugs"), §5 baseline contradiction #3 (L-02 vs INT-18).
 * Behavior maps:
 *  - md_files/specs/testing/segments/01-intake-customer-lead.md §4 Hard Blocker #1 (INT-18)
 *  - md_files/specs/testing/segments/02-sell-estimate-deposit.md §"T&C mechanics & #21" (SEL-31)
 *
 * SEL-31 was a bug-predicting PROBE pinning #21; #21 is now FIXED, so SEL-31 asserts the
 * corrected behavior (terms acceptance server-enforced) — the flagKnownBug flag is removed.
 *
 * Conventions: shared provisioned org, serial (workers:1), unique data via api.suffix +
 * uniquePhone(), @e2e-qa.invalid emails, delta/presence assertions only.
 *
 * NOTE ON BUILDERS: SEL-31 composes its seed chain by hand instead of using
 * leadToSentEstimate. That builder bottoms out in createCustomerWithLocation, whose
 * phone is the HARDCODED '5551234567' — with the duplicate-customer guard now active
 * (#42, redesign-21 coverage), the second builder-seeded customer in the shared org
 * 409s and the builder crashes. Unique email + uniquePhone() insulate this file.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/**
 * Unique 10-digit phone per call (digits analogue of api.suffix). Uniqueness is
 * load-bearing for INT-18: a reused phone would trip the duplicate-customer guard
 * (409) BEFORE the create this probe targets ever runs.
 */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq = (phoneSeq + 1) % 10;
  return `98${Date.now().toString().slice(-7)}${phoneSeq}`;
}

/**
 * Customer → lead → contacted → walkthrough(SALES performer) → completed → DRAFT
 * estimate → SENT (no deposit). Mirrors leadToSentEstimate but with guard-safe unique
 * contact data (see header note). Returns the SENT estimate + its public token.
 */
async function sentEstimateNoDeposit() {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `Sel31-${s}`, last_name: 'Probe',
    email: `sel31-${s}@e2e-qa.invalid`, phone: uniquePhone(),
  });
  const location = await api.addLocation(customer.id, {
    address_line1: '600 Terms Way', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
  });
  const { body: leadBody } = await api.createLead({
    customer_id: customer.id, service_request: `SEL-31 probe ${s}`, service_location_id: location.id,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24), performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'T&C probe service', quantity: 1, unit_price: 500, is_taxable: true }],
  });
  const estimateId = estBody.estimate.id;
  const { body: sentBody } = await api.sendEstimate(estimateId, { deposit_required: false });
  return { estimateId, publicToken: sentBody.estimate.public_token as string };
}

test.describe('Probes — intake & sell (INT-18, SEL-31)', () => {
  // ─── INT-18: inline new_customer lead create — predicted 500 ──────────────────────
  // RESOLVED — baseline 2026-06-12 returned 201, not the predicted 500. GH #102 is fixed
  // on servwave: the lead.controller.ts create() new_customer branch now allocates a
  // customer_number and defaults kind/segment, so the inline create succeeds (and this
  // now agrees with legacy L-02, which also asserts 201). Probe flipped to assert success.
  test('INT-18: fully-valid new_customer lead create → 201 (customer auto-created with number + kind/segment defaults)', async () => {
    const s = api.suffix;
    const email = `int18-${s}@e2e-qa.invalid`;
    // Fully valid per createLeadSchema/newCustomerSchema: first/last/email/phone + full
    // location + service_request. Email AND phone unique → the duplicate guard passes
    // and the request reaches the inline create (the half INT-14 deliberately avoids).
    // raw() because the typed createLead wrapper requires customer_id, which the inline
    // new_customer shape legitimately omits (createLeadSchema XOR).
    const { res, body } = await api.raw('post', '/api/leads', {
      new_customer: {
        first_name: `Int18-${s}`, last_name: 'Probe',
        email, phone: uniquePhone(),
        location: { address_line1: '500 Probe Way', city: 'Boston', state: 'MA', zip: '02108' },
      },
      service_request: `INT-18 inline-create probe ${s}`,
    });

    // GH #102 is fixed on servwave: the inline new_customer branch now allocates a
    // customer_number and defaults kind/segment, so the create succeeds.
    expect(res.status()).toBe(201);
    expect(body.lead?.id, 'lead created').toBeTruthy();

    // The customer was persisted with an allocated number + defaulted kind/segment.
    const search = await api.raw('get', `/api/customers?search=${encodeURIComponent(email)}&include_archived=true`);
    const customers = (search.body.customers ?? []) as any[];
    expect(customers.length, 'customer auto-created').toBe(1);
    expect(customers[0].customer_number, 'customer_number allocated').toBeTruthy();
    expect(customers[0].kind, 'kind defaulted').toBeTruthy();
    expect(customers[0].segment, 'segment defaulted').toBeTruthy();
  });

  // ─── SEL-31: T&C acceptance is now server-enforced (#21 FIXED) ─────────────────────
  // Fix #21: approve gates on the terms PRESENTED at send time (snapshot_terms, captured in
  // send()) — approvePublicSchema accepts a terms_accepted boolean, the controller 400s when
  // snapshot_terms is set but terms_accepted !== true ('Terms acceptance is required'), and on
  // acceptance persists terms_accepted + terms_accepted_at. The public GET echoes all three.
  test('SEL-31: T&C enforced (#21) — approve without acceptance → 400, with acceptance → 200 + persisted', async () => {
    // Seed a SENT estimate (no deposit → approve Branch 1 = immediate WON). Sent while the
    // org has terms (provisionTestOrg seeds estimate_terms='E2E terms') → snapshot_terms captured.
    const { estimateId, publicToken } = await sentEstimateNoDeposit();

    // Premise pin: the public payload now surfaces the snapshot terms (the terms THIS estimate
    // presented) — assert non-empty so the probe fails loudly if the fixture ever drops them.
    const pub = await api.getPublicEstimate(estimateId, publicToken);
    expect(pub.res.status()).toBe(200);
    expect(pub.body.organization?.estimate_terms, 'org terms must exist for the gate premise').toBeTruthy();
    expect(pub.body.terms_accepted ?? false, 'not yet accepted').toBeFalsy();

    // NEGATIVE: approve with a valid signature but NO terms acceptance → server rejects 400.
    // Explicit terms_accepted:false (the shared helper now defaults true) so this still hits the gate.
    const bypass = await api.approveEstimatePublic(estimateId, publicToken, {
      signature_data: api.testSignature,
      terms_accepted: false,
    });
    expect(bypass.res.status()).toBe(400);
    expect(bypass.body.error).toBe('Terms acceptance is required');

    // The estimate is untouched — still SENT, no acceptance persisted.
    const stillSent = await api.getEstimate(estimateId);
    expect(stillSent.status).toBe('SENT');
    expect(stillSent.terms_accepted ?? false).toBeFalsy();

    // POSITIVE control: approve WITH terms_accepted:true → 200 WON + acceptance persisted.
    const ok = await api.approveEstimatePublic(estimateId, publicToken, {
      signature_data: api.testSignature,
      terms_accepted: true,
    });
    expect(ok.res.status()).toBe(200);
    expect(ok.body.estimate.status).toBe('WON');
    expect(ok.body.estimate.terms_accepted).toBe(true);
    expect(ok.body.estimate.terms_accepted_at).toBeTruthy();

    // Authed re-read: WON stuck, signature trio + acceptance record both persisted.
    const fresh = await api.getEstimate(estimateId);
    expect(fresh.status).toBe('WON');
    expect(fresh.signature_data).toBeTruthy();
    expect(fresh.terms_accepted).toBe(true);
    expect(fresh.terms_accepted_at).toBeTruthy();
  });
});
