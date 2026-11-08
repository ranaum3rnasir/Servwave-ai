import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';

let api: ApiClient;

// Shared state across tests
let customerId: string;
let locationId: string;
let leadId: string;
let techId: string;
let baselineLeadStats: any;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  await api.cleanup();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// Day 1 — 7:30 AM: Marcus opens the office, system health
// check, first walk-in lead intake.
// ──────────────────────────────────────────────────────────

test('system health — API responds and auth works', async () => {
  const { res: leadsRes } = await api.listLeads();
  expect(leadsRes.status()).toBe(200);

  const { res: jobsRes } = await api.listJobs();
  expect(jobsRes.status()).toBe(200);

  const { res: estimatesRes } = await api.listEstimates();
  expect(estimatesRes.status()).toBe(200);
});

test('capture morning baseline stats', async () => {
  const leadStats = await api.getLeadStats();
  expect(leadStats).toBeDefined();
  baselineLeadStats = leadStats;

  const jobStats = await api.getJobStats();
  expect(jobStats).toBeDefined();
});

test('first walk-in lead — Sarah Chen, AC not cooling', async () => {
  // Create customer
  const customer = await api.createCustomer({
    first_name: 'Sarah',
    last_name: 'Chen',
    email: `sarah.chen.${api.suffix}@e2e.local`,
    phone: '5129876543',
  });
  customerId = customer.id;
  expect(customerId).toBeTruthy();

  // Add primary service location
  const location = await api.addLocation(customerId, {
    address_line1: '4521 Cedar Ridge Dr',
    city: 'Austin',
    state: 'TX',
    zip: '78749',
    is_primary: true,
  });
  locationId = location.id;
  expect(locationId).toBeTruthy();

  // Create lead
  const { res, body } = await api.createLead({
    customer_id: customerId,
    service_request: 'AC unit not cooling — thermostat reads 78°F but house is 86°F',
  });
  expect(res.status()).toBe(201);
  leadId = body.lead.id;
  expect(body.lead.status).toBe('NEW');
});

test('Jennifer contacts Sarah — phone consultation', async () => {
  const { res } = await api.contactLead(
    leadId,
    undefined,
    'Spoke with Sarah — AC stopped cooling yesterday afternoon. No unusual noises. Filter was replaced last month.',
  );
  expect(res.status()).toBe(200);

  const lead = await api.getLead(leadId);
  expect(lead.status).toBe('CONTACTED');
});

test('Jennifer schedules walkthrough for Carlos', async () => {
  // Create technician (Carlos)
  const { body: userBody } = await api.createUser({
    email: `carlos.mendez.${api.suffix}@e2e.local`,
    password: 'Test123!@#',
    first_name: 'Carlos',
    last_name: 'Mendez',
    role: 'TECHNICIAN',
  });
  techId = userBody.user.id;
  expect(techId).toBeTruthy();

  // Schedule walkthrough
  const { res } = await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: techId,
  });
  expect(res.status()).toBe(200);

  const lead = await api.getLead(leadId);
  expect(lead.status).toBe('WALKTHROUGH_SCHEDULED');
});

test('lead stats increased after morning intake', async () => {
  const currentStats = await api.getLeadStats();
  expect(currentStats).toBeDefined();

  // At least one more lead than baseline (the Sarah Chen lead)
  const baselineTotal = baselineLeadStats.total ?? 0;
  const currentTotal = currentStats.total ?? 0;
  expect(currentTotal).toBeGreaterThan(baselineTotal);
});
