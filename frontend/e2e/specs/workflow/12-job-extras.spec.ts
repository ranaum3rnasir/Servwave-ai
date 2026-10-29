import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createTech,
  fullStandardFlow,
} from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ─── Helper: create a no-estimate job in a specific state ─────────────────────
// Entity-redesign Phase D: the urgent flow is retired — a no-estimate job
// ({customer_id, service_location_id}) is the schedulable fixture used below.

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
    await client.completeJob(jobId, 'Done');
    return jobId;
  }

  if (status === 'CANCELLED') {
    await client.cancelJob(jobId, 'Test cancel');
    return jobId;
  }

  return jobId;
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 16 — JOB NOTES & TIMELINE (JN-01 to JN-03)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('16 Job Notes & Timeline', () => {
  test('JN-01: Add note to job → created with entity_type JOB', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');

    const { res, body } = await api.addJobNote(jobId, 'Test note for job');

    expect(res.status()).toBe(201);
    expect(body.note.content).toBe('Test note for job');
    expect(body.note.id).toBeTruthy();
    expect(body.note.creator).toBeTruthy();
  });

  test('JN-02: List notes for job → returned newest-first', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');

    await api.addJobNote(jobId, 'First note');
    await api.addJobNote(jobId, 'Second note');

    const data = await api.getJobNotes(jobId);

    expect(Array.isArray(data.notes)).toBe(true);
    expect(data.notes.length).toBeGreaterThanOrEqual(2);
    // Newest-first: second note should come before first
    const idx1 = data.notes.findIndex((n: { content: string }) => n.content === 'First note');
    const idx2 = data.notes.findIndex((n: { content: string }) => n.content === 'Second note');
    expect(idx2).toBeLessThan(idx1);
  });

  test('JN-03: Get job timeline → events returned including CREATED', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');

    const data = await api.getJobTimeline(jobId);

    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    const createdEvent = data.events.find((e: { event_type: string }) => e.event_type === 'CREATED');
    expect(createdEvent).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 17 — JOB WALKTHROUGH (JW-01 to JW-02)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('17 Job Walkthrough', () => {
  test('JW-01: Complete walkthrough on a no-estimate job with notes → set', async () => {
    const jobId = await createUrgentJobInState(api, 'UNASSIGNED');

    const { res, body } = await api.createJobWalkthrough(jobId, 'Customer showed us the leaking pipe under the sink');

    expect(res.status()).toBe(200);
    expect(body.job.walkthrough_notes).toBe('Customer showed us the leaking pipe under the sink');
    expect(body.job.walkthrough_completed_at).not.toBeNull();
  });

  test('JW-02: Complete walkthrough on an estimate-derived job → 400 (no-estimate only)', async () => {
    // Create a standard (estimate-derived) job via the full flow
    const ctx = await fullStandardFlow(api);

    const { res, body } = await api.createJobWalkthrough(ctx.jobId, 'Some notes');

    expect(res.status()).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 18 — Urgent Job Charges (UC-01 to UC-08): REMOVED
//
// Entity-redesign Phase D retires the urgent flow + JobCharge. The /jobs/:id/charges
// add/update/remove/getCharges routes are gone (the Invoice owns line items now), and there
// is no API to add lines to a no-estimate job's invoice. The entire UC-01..UC-08 block tested
// routes that no longer exist and has been removed. Invoice line-item behavior + the money
// model are covered by the invoice specs (invoice-workflow, day-06) and the QA checklist.
// ──────────────────────────────────────────────────────────────────────────────
