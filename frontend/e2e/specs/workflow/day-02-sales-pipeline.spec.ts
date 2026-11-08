import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';

let api: ApiClient;

// ─── Sarah Chen flow (tests 1-3) ────────────────────────
let sarahCustomerId: string;
let sarahLocationId: string;
let sarahLeadId: string;
let sarahTechId: string;
let sarahEstimateId: string;

// ─── Apex Property Group flow (tests 4-6) ───────────────
let apexCustomerId: string;
let apexLocationId1: string;
let apexLocationId2: string;
let apexLeadId: string;
let priyaTechId: string;

// ─── Robert Kim flow (tests 7-8) ────────────────────────
let robertCustomerId: string;
let robertLocationId: string;
let robertLeadId: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  await api.cleanup();

  // Pre-seed Sarah's walkthrough flow for tests 1-3
  const sarahCustomer = await api.createCustomer({
    first_name: 'Sarah',
    last_name: 'Chen',
    email: `sarah.chen.${api.suffix}@e2e.local`,
    phone: '5129876543',
  });
  sarahCustomerId = sarahCustomer.id;

  const sarahLocation = await api.addLocation(sarahCustomerId, {
    address_line1: '4521 Cedar Ridge Dr',
    city: 'Austin',
    state: 'TX',
    zip: '78749',
    is_primary: true,
  });
  sarahLocationId = sarahLocation.id;

  const { body: sarahLeadBody } = await api.createLead({
    customer_id: sarahCustomerId,
    service_request: 'AC unit not cooling — thermostat reads 78°F but house is 86°F',
  });
  sarahLeadId = sarahLeadBody.lead.id;

  await api.contactLead(
    sarahLeadId,
    undefined,
    'Spoke with Sarah — AC stopped cooling yesterday afternoon.',
  );

  // Create technician Carlos for walkthrough
  const { body: carlosBody } = await api.createUser({
    email: `carlos.mendez.${api.suffix}@e2e.local`,
    password: 'Test123!@#',
    first_name: 'Carlos',
    last_name: 'Mendez',
    role: 'TECHNICIAN',
  });
  sarahTechId = carlosBody.user.id;

  await api.scheduleWalkthrough(sarahLeadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: sarahTechId,
  });
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// Day 2 — Mid-morning: Sales works pipelines. Multiple
// personas handling different customer types.
// ──────────────────────────────────────────────────────────

test('Carlos completes Sarah\'s walkthrough with detailed notes', async () => {
  const { res: completeRes } = await api.completeWalkthrough(sarahLeadId);
  expect(completeRes.status()).toBe(200);

  const { res: notesRes } = await api.updateWalkthroughNotes(sarahLeadId, {
    walkthrough_notes: 'Inspected outdoor unit — Trane XR15, 12 years old. Evaporator coil showing signs of corrosion and micro-leaks. Refrigerant level low (~2 lbs under spec). Recommend full coil replacement + recharge. Ductwork in good condition. Customer prefers repair over full system replacement.',
    walkthrough_condition: 'Evaporator coil corroded, refrigerant low',
  });
  expect(notesRes.status()).toBe(200);

  const lead = await api.getLead(sarahLeadId);
  expect(lead.status).toBe('WALKTHROUGH_COMPLETED');
});

test('Jennifer creates estimate with mixed taxable items', async () => {
  const { res, body } = await api.createEstimate({
    lead_id: sarahLeadId,
    line_items: [
      {
        description: 'Replace evaporator coil — Trane XR15 compatible',
        quantity: 1,
        unit_price: 1200,
        is_taxable: true,
      },
      {
        description: 'R-410A refrigerant recharge (3 lbs)',
        quantity: 3,
        unit_price: 85,
        is_taxable: true,
      },
      {
        description: 'City permit fee',
        quantity: 1,
        unit_price: 150,
        is_taxable: false,
      },
    ],
    tax_rate: 0.0825,
    scope_notes: 'Replace corroded evaporator coil and recharge refrigerant to manufacturer spec.',
  });
  expect(res.status()).toBe(201);
  sarahEstimateId = body.estimate.id;

  const estimate = body.estimate;
  expect(estimate.status).toBe('DRAFT');

  // Verify subtotal: 1*1200 + 3*85 + 1*150 = 1605
  const subtotal = Number(estimate.subtotal);
  expect(subtotal).toBe(1605);

  // Verify tax only on taxable items: (1200 + 255) * 0.0825 = 120.04 (rounded)
  const taxAmount = Number(estimate.tax_amount);
  const expectedTax = Math.round((1200 + 255) * 0.0825 * 100) / 100;
  expect(taxAmount).toBeCloseTo(expectedTax, 2);
});

test('Jennifer sends estimate with 50% deposit (CHECK/CARD)', async () => {
  const { res, body } = await api.sendEstimate(sarahEstimateId, {
    deposit_required: true,
    payment_methods: ['CHECK', 'CARD'],
  });
  expect(res.status()).toBe(200);
  expect(body.estimate.status).toBe('SENT');

  // Re-fetch to get the full estimate with its kind=DEPOSIT invoice.
  const estimate = await api.getEstimate(sarahEstimateId);
  expect(estimate.invoices[0]).toBeTruthy();

  // Verify lead advanced to ESTIMATED
  const lead = await api.getLead(sarahLeadId);
  expect(lead.status).toBe('ESTIMATED');
});

test('David creates Apex Property Group — commercial account', async () => {
  const customer = await api.createCustomer({
    first_name: 'Diana',
    last_name: 'Reeves',
    email: `dreeves.${api.suffix}@e2e.local`,
    phone: '5124321098',
    company_name: 'Apex Property Group',
    allow_billing: true,
    payment_type: 'NET 30',
  } as any);
  apexCustomerId = customer.id;
  expect(apexCustomerId).toBeTruthy();
  expect(customer.company_name).toBe('Apex Property Group');

  // Add two service locations
  const loc1 = await api.addLocation(apexCustomerId, {
    address_line1: '8900 Shoal Creek Blvd',
    city: 'Austin',
    state: 'TX',
    zip: '78757',
    is_primary: true,
  });
  apexLocationId1 = loc1.id;

  const loc2 = await api.addLocation(apexCustomerId, {
    address_line1: '2200 S Lamar Blvd',
    city: 'Austin',
    state: 'TX',
    zip: '78704',
  });
  apexLocationId2 = loc2.id;

  expect(apexLocationId1).toBeTruthy();
  expect(apexLocationId2).toBeTruthy();
});

test('David creates commercial HVAC lead for Apex', async () => {
  const { res, body } = await api.createLead({
    customer_id: apexCustomerId,
    service_request: 'Annual maintenance for 2 rooftop units — last serviced March 2025',
  });
  expect(res.status()).toBe(201);
  apexLeadId = body.lead.id;

  const { res: contactRes } = await api.contactLead(
    apexLeadId,
    undefined,
    'Spoke with Diana — wants maintenance before summer. Flexible on scheduling.',
  );
  expect(contactRes.status()).toBe(200);

  const lead = await api.getLead(apexLeadId);
  expect(lead.status).toBe('CONTACTED');
});

test('David schedules Priya for commercial walkthrough', async () => {
  const { body: priyaBody } = await api.createUser({
    email: `priya.patel.${api.suffix}@e2e.local`,
    password: 'Test123!@#',
    first_name: 'Priya',
    last_name: 'Patel',
    role: 'TECHNICIAN',
  });
  priyaTechId = priyaBody.user.id;
  expect(priyaTechId).toBeTruthy();

  const { res } = await api.scheduleWalkthrough(apexLeadId, {
    walkthrough_scheduled_at: api.futureDate(48),
    walkthrough_assigned_to: priyaTechId,
  });
  expect(res.status()).toBe(200);

  const lead = await api.getLead(apexLeadId);
  expect(lead.status).toBe('WALKTHROUGH_SCHEDULED');
});

test('Robert Kim (landlord) — urgent burst pipe at rental', async () => {
  const customer = await api.createCustomer({
    first_name: 'Robert',
    last_name: 'Kim',
    email: `rkim.${api.suffix}@e2e.local`,
    phone: '5125432109',
  });
  robertCustomerId = customer.id;
  expect(robertCustomerId).toBeTruthy();

  // Add three rental properties
  const loc1 = await api.addLocation(robertCustomerId, {
    address_line1: '1100 E Riverside Dr',
    city: 'Austin',
    state: 'TX',
    zip: '78741',
    is_primary: true,
  });
  robertLocationId = loc1.id;

  await api.addLocation(robertCustomerId, {
    address_line1: '3300 Manchaca Rd',
    city: 'Austin',
    state: 'TX',
    zip: '78704',
  });

  await api.addLocation(robertCustomerId, {
    address_line1: '5600 N Lamar Blvd',
    city: 'Austin',
    state: 'TX',
    zip: '78756',
  });

  const { res, body } = await api.createLead({
    customer_id: robertCustomerId,
    service_request: 'Tenant says pipe burst in basement — water actively leaking',
  });
  expect(res.status()).toBe(201);
  robertLeadId = body.lead.id;

  const { res: contactRes } = await api.contactLead(
    robertLeadId,
    undefined,
    'Robert called — tenant at Riverside property reports active water leak in basement. Cannot find shutoff valve.',
  );
  expect(contactRes.status()).toBe(200);

  const lead = await api.getLead(robertLeadId);
  expect(lead.status).toBe('CONTACTED');
});

test('landlord lead fast-tracked to a no-estimate job', async () => {
  // Entity-redesign Phase D: the urgent flow is retired — a fast-track job is a plain
  // no-estimate job ({customer_id, service_location_id}); is_urgent/urgency_reason are gone.
  const { res, body } = await api.createJob({
    customer_id: robertCustomerId,
    service_location_id: robertLocationId,
  });
  expect(res.status()).toBe(201);

  const job = body.job;
  expect(job.status).toBe('UNASSIGNED');
});
