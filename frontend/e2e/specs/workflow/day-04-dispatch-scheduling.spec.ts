import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createContactedLead,
  createTech,
  createSalesUser,
  leadToSentEstimate,
} from '../../helpers/workflow-builders';

// ──────────────────────────────────────────────────────────
// Day 4 — Early afternoon: Amanda dispatches jobs.
// Conflicts, all-day scheduling, reassignment, walkthrough
// overlap detection.
// ──────────────────────────────────────────────────────────

let api: ApiClient;

// Shared state across tests
let sarahJobId: string;
let carlosId: string;
let tylerJobId: string;
let lisaId: string;
let lisaFirstJobId: string;
let lisaSecondJobId: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  await api.cleanup();
});

test.afterAll(async () => {
  await api.dispose();
});

// ──────────────────────────────────────────────────────────
// 1. Amanda creates job from approved estimate
// ──────────────────────────────────────────────────────────

test('Amanda creates job from approved estimate', async () => {
  // Lead → Estimate → Sent (no deposit) → Approve
  const ctx = await leadToSentEstimate(api);
  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.status()).toBe(200);

  // Create job from the approved estimate
  const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(res.status()).toBe(201);
  expect(body.job.status).toBe('UNASSIGNED');
  sarahJobId = body.job.id;
});

// ──────────────────────────────────────────────────────────
// 2. Assign Carlos to Sarah's job — SCHEDULED
// ──────────────────────────────────────────────────────────

test('assign Carlos to Sarah\'s job — SCHEDULED', async () => {
  const s = api.suffix;
  const { body: userBody } = await api.createUser({
    email: `carlos-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Carlos', last_name: 'Ramirez', role: 'TECHNICIAN',
  });
  carlosId = userBody.user.id;

  const { res, body } = await api.assignJob(sarahJobId, {
    assigned_to: carlosId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(52),
  });
  expect(res.status()).toBe(200);
  expect(body.job.status).toBe('SCHEDULED');
  expect(body.job.assigned_to).toBe(carlosId);
});

// ──────────────────────────────────────────────────────────
// 3. Assign Tyler to urgent plumbing job
// ──────────────────────────────────────────────────────────

test('assign Tyler to urgent plumbing job', async () => {
  // Create customer + contacted lead for urgent job
  const { customerId, locationId } = await createCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId,
    service_request: `Burst pipe emergency — ${api.suffix}`,
  });
  await api.contactLead(leadBody.lead.id);

  // Create urgent job (no estimate/deposit required)
  const { res: jobRes, body: jobBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  expect(jobRes.status()).toBe(201);
  tylerJobId = jobBody.job.id;

  // Create Tyler
  const s = api.suffix;
  const { body: userBody } = await api.createUser({
    email: `tyler-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Tyler', last_name: 'Brooks', role: 'TECHNICIAN',
  });
  const tylerId = userBody.user.id;

  const { res, body } = await api.assignJob(tylerJobId, {
    assigned_to: tylerId,
    scheduled_start: api.futureDate(2),
    scheduled_end: api.futureDate(6),
  });
  expect(res.status()).toBe(200);
  expect(body.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// 4. Scheduling conflict — Lisa double-booked
// ──────────────────────────────────────────────────────────

test('scheduling conflict — Lisa double-booked', async () => {
  // Create Lisa
  const s = api.suffix;
  const { body: userBody } = await api.createUser({
    email: `lisa-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Lisa', last_name: 'Chen', role: 'TECHNICIAN',
  });
  lisaId = userBody.user.id;

  // Create first job and assign to Lisa
  const ctx1 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx1.estimateId, ctx1.publicToken, {
    signature_data: api.testSignature,
  });
  const { body: job1Body } = await api.createJob({ estimate_id: ctx1.estimateId });
  lisaFirstJobId = job1Body.job.id;

  await api.assignJob(lisaFirstJobId, {
    assigned_to: lisaId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(52),
  });

  // Create second job
  const ctx2 = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx2.estimateId, ctx2.publicToken, {
    signature_data: api.testSignature,
  });
  const { body: job2Body } = await api.createJob({ estimate_id: ctx2.estimateId });
  lisaSecondJobId = job2Body.job.id;

  // Try to assign Lisa at overlapping time — should fail with 409
  const { res } = await api.assignJob(lisaSecondJobId, {
    assigned_to: lisaId,
    scheduled_start: api.futureDate(49),
    scheduled_end: api.futureDate(53),
  });
  expect(res.status()).toBe(409);
});

// ──────────────────────────────────────────────────────────
// 5. Force-assign Lisa despite conflict
// ──────────────────────────────────────────────────────────

test('force-assign Lisa despite conflict', async () => {
  const { res, body } = await api.assignJob(lisaSecondJobId, {
    assigned_to: lisaId,
    scheduled_start: api.futureDate(49),
    scheduled_end: api.futureDate(53),
    force: true,
  });
  expect(res.status()).toBe(200);
  expect(body.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// 6. All-day job for Raj — electrical panel upgrade
// ──────────────────────────────────────────────────────────

test('all-day job for Raj — electrical panel upgrade', async () => {
  // Create job
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;

  // Create Raj
  const s = api.suffix;
  const { body: userBody } = await api.createUser({
    email: `raj-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Raj', last_name: 'Patel', role: 'TECHNICIAN',
  });
  const rajId = userBody.user.id;

  const { res, body } = await api.assignJob(jobId, {
    assigned_to: rajId,
    is_all_day: true,
    scheduled_start: api.futureDate(72),
  });
  expect(res.status()).toBe(200);
  expect(body.job.status).toBe('SCHEDULED');
});

// ──────────────────────────────────────────────────────────
// 7. Unassign and reassign — swap tech
// ──────────────────────────────────────────────────────────

test('unassign and reassign — swap tech', async () => {
  // Create a new job to swap techs on
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;

  // Assign to first tech
  const tech1Id = await createTech(api);
  await api.assignJob(jobId, {
    assigned_to: tech1Id,
    scheduled_start: api.futureDate(60),
    scheduled_end: api.futureDate(64),
  });

  // Unassign
  const { res: unRes, body: unBody } = await api.unassignJob(jobId);
  expect(unRes.status()).toBe(200);
  expect(unBody.job.status).toBe('UNASSIGNED');

  // Reassign to a different tech
  const tech2Id = await createTech(api);
  const { res: reRes, body: reBody } = await api.assignJob(jobId, {
    assigned_to: tech2Id,
    scheduled_start: api.futureDate(60),
    scheduled_end: api.futureDate(64),
  });
  expect(reRes.status()).toBe(200);
  expect(reBody.job.status).toBe('SCHEDULED');
  expect(reBody.job.assigned_to).toBe(tech2Id);
});

// ──────────────────────────────────────────────────────────
// 8. Walkthrough conflict blocks job assignment
// ──────────────────────────────────────────────────────────

test('walkthrough conflict blocks job assignment', async () => {
  // Create a tech who has a walkthrough scheduled
  const s = api.suffix;
  const { body: userBody } = await api.createUser({
    email: `dana-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Dana', last_name: 'Ortiz', role: 'TECHNICIAN',
  });
  const danaId = userBody.user.id;

  // Schedule a walkthrough for Dana at futureDate(96)-futureDate(97)
  const { leadId: wtLeadId } = await createContactedLead(api);
  await api.scheduleWalkthrough(wtLeadId, {
    walkthrough_scheduled_at: api.futureDate(96),
    walkthrough_assigned_to: danaId,
    walkthrough_duration_minutes: 60,
  });

  // Create a job to assign at overlapping time
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;

  // Try to assign Dana at overlapping time — should conflict (409)
  const { res: conflictRes } = await api.assignJob(jobId, {
    assigned_to: danaId,
    scheduled_start: api.futureDate(96),
    scheduled_end: api.futureDate(98),
  });
  expect(conflictRes.status()).toBe(409);

  // Force-assign overrides the walkthrough conflict
  const { res: forceRes, body: forceBody } = await api.assignJob(jobId, {
    assigned_to: danaId,
    scheduled_start: api.futureDate(96),
    scheduled_end: api.futureDate(98),
    force: true,
  });
  expect(forceRes.status()).toBe(200);
  expect(forceBody.job.status).toBe('SCHEDULED');
});
