import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createTech,
} from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

/** Create an urgent job in UNASSIGNED state. */
async function makeUrgentJob(a: ApiClient) {
  const { customerId, locationId } = await createCustomerWithLocation(a);
  const { body } = await a.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  return body.job.id as string;
}

// ──────────────────────────────────────────────────────────
// SECTION 14 — JOB ASSIGNMENT & SCHEDULING (JA-01 to JA-12)
// ──────────────────────────────────────────────────────────

test.describe('14.1 Assignment — happy paths', () => {
  test('JA-01: Assign UNASSIGNED job to active tech with dates → SCHEDULED', async () => {
    const jobId = await makeUrgentJob(api);
    const techId = await createTech(api);

    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('SCHEDULED');
    expect(body.job.assigned_to).toBe(techId);
    expect(body.job.scheduled_start).toBeTruthy();
    expect(body.job.scheduled_end).toBeTruthy();
  });

  test('JA-02: Assign as all-day (is_all_day=true) → SCHEDULED, scheduled_end auto-computed', async () => {
    const jobId = await makeUrgentJob(api);
    const techId = await createTech(api);
    const start = api.futureDate(72);

    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: start,
      is_all_day: true,
    });

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('SCHEDULED');
    expect(body.job.is_all_day).toBe(true);
    // End should be auto-computed (start + 24h)
    const startMs = new Date(start).getTime();
    const endMs = new Date(body.job.scheduled_end).getTime();
    expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);
  });

  test('JA-03: Reassign SCHEDULED job to different technician → stays SCHEDULED, new tech', async () => {
    const jobId = await makeUrgentJob(api);
    const tech1 = await createTech(api);
    const tech2 = await createTech(api);

    // Assign to tech1
    await api.assignJob(jobId, {
      assigned_to: tech1,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    // Reassign to tech2
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: tech2,
      scheduled_start: api.futureDate(72),
      scheduled_end: api.futureDate(74),
    });

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('SCHEDULED');
    expect(body.job.assigned_to).toBe(tech2);
  });
});

test.describe('14.2 Assignment — conflict detection', () => {
  test('JA-04: Assign with scheduling conflict (no force) → 409', async () => {
    const techId = await createTech(api);

    // Create and assign job #1 to tech at 10am-12pm
    const job1 = await makeUrgentJob(api);
    const base = new Date(Date.now() + 96 * 3600000); // 4 days from now
    base.setHours(10, 0, 0, 0);
    const slot10am = base.toISOString();
    const slot12pm = new Date(base.getTime() + 2 * 3600000).toISOString();

    await api.assignJob(job1, {
      assigned_to: techId,
      scheduled_start: slot10am,
      scheduled_end: slot12pm,
    });

    // Try to assign job #2 to same tech at 11am-1pm (overlaps)
    const job2 = await makeUrgentJob(api);
    const slot11am = new Date(base.getTime() + 1 * 3600000).toISOString();
    const slot1pm = new Date(base.getTime() + 3 * 3600000).toISOString();

    const { res, body } = await api.assignJob(job2, {
      assigned_to: techId,
      scheduled_start: slot11am,
      scheduled_end: slot1pm,
    });

    expect(res.status()).toBe(409);
    expect(body.error).toMatch(/conflict/i);
    expect(body.conflicts).toBeDefined();
    expect(body.conflicts.length).toBeGreaterThan(0);
  });

  test('JA-05: Assign with conflict + force=true → SCHEDULED (conflict ignored)', async () => {
    const techId = await createTech(api);

    // Assign job #1 at 10am-12pm
    const job1 = await makeUrgentJob(api);
    const base = new Date(Date.now() + 120 * 3600000); // 5 days from now
    base.setHours(10, 0, 0, 0);
    const slot10am = base.toISOString();
    const slot12pm = new Date(base.getTime() + 2 * 3600000).toISOString();

    await api.assignJob(job1, {
      assigned_to: techId,
      scheduled_start: slot10am,
      scheduled_end: slot12pm,
    });

    // Assign job #2 at 11am-1pm (conflict) with force=true
    const job2 = await makeUrgentJob(api);
    const slot11am = new Date(base.getTime() + 1 * 3600000).toISOString();
    const slot1pm = new Date(base.getTime() + 3 * 3600000).toISOString();

    const { res, body } = await api.assignJob(job2, {
      assigned_to: techId,
      scheduled_start: slot11am,
      scheduled_end: slot1pm,
      force: true,
    });

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('SCHEDULED');
    expect(body.job.assigned_to).toBe(techId);
  });

  test('JA-06: Assign with walkthrough conflict (no force) → 409', async () => {
    const techId = await createTech(api);

    // Create a lead with a scheduled walkthrough assigned to this tech
    const { customerId } = await createCustomerWithLocation(api);
    const { body: leadBody } = await api.createLead({
      customer_id: customerId,
      service_request: 'Walkthrough conflict test',
    });
    const leadId = leadBody.lead.id;

    await api.contactLead(leadId);

    // Schedule walkthrough for the tech at a specific time (144h from now)
    const wtBase = new Date(Date.now() + 144 * 3600000);
    wtBase.setHours(10, 0, 0, 0);
    const wtStart = wtBase.toISOString();

    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: wtStart,
      walkthrough_assigned_to: techId,
      walkthrough_duration_minutes: 60,
      force: true,
    });

    // Now try to assign a job to the same tech overlapping the walkthrough window
    const jobId = await makeUrgentJob(api);
    const jobStart = new Date(wtBase.getTime() + 30 * 60000).toISOString(); // 30 min into walkthrough
    const jobEnd = new Date(wtBase.getTime() + 90 * 60000).toISOString();

    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: jobStart,
      scheduled_end: jobEnd,
    });

    expect(res.status()).toBe(409);
    expect(body.error).toMatch(/conflict/i);
    expect(body.conflicts).toBeDefined();
    const wtConflict = body.conflicts.find((c: any) => c.type === 'walkthrough');
    expect(wtConflict).toBeDefined();
  });
});

test.describe('14.3 Assignment — technician validation failures', () => {
  test('JA-07: Assign to inactive technician → 400', async () => {
    const jobId = await makeUrgentJob(api);

    // Create a tech then deactivate them
    const techId = await createTech(api);
    await api.updateUser(techId, { is_active: false });

    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/inactive/i);
  });

  test('JA-08: Assign to non-TECHNICIAN role → 400', async () => {
    const jobId = await makeUrgentJob(api);

    // Create a SALES user (not a technician)
    const { body: salesBody } = await api.createUser({
      email: `sales-ja08-${api.suffix}@e2e.local`, password: 'Test123!@#',
      first_name: 'Sales', last_name: 'JA08', role: 'SALES',
    });
    const salesId = salesBody.user.id;

    const { res, body } = await api.assignJob(jobId, {
      assigned_to: salesId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/TECHNICIAN/i);
  });

  test('JA-09: Assign without dates (just technician) → SCHEDULED with null dates', async () => {
    const jobId = await makeUrgentJob(api);
    const techId = await createTech(api);

    // Per assignJobSchema: both start and end can be omitted together
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
    });

    // Should succeed — SCHEDULED with null scheduled times
    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('SCHEDULED');
    expect(body.job.assigned_to).toBe(techId);
  });
});

test.describe('14.4 Assignment — terminal/wrong-status job failures', () => {
  test('JA-10: Assign COMPLETED job → 400', async () => {
    const jobId = await makeUrgentJob(api);
    const techId = await createTech(api);

    await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });
    await api.startJob(jobId);
    await api.completeJob(jobId, 'Done for JA-10');

    const job = await api.getJob(jobId);
    expect(job.status).toBe('COMPLETED');

    const tech2 = await createTech(api);
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: tech2,
      scheduled_start: api.futureDate(96),
      scheduled_end: api.futureDate(98),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/completed/i);
  });

  test('JA-11: Assign CANCELLED job → 400', async () => {
    const jobId = await makeUrgentJob(api);
    await api.cancelJob(jobId, 'Cancelled for JA-11');

    const job = await api.getJob(jobId);
    expect(job.status).toBe('CANCELLED');

    const techId = await createTech(api);
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/cancelled/i);
  });

  test('JA-12: Assign IN_PROGRESS job → 400', async () => {
    const jobId = await makeUrgentJob(api);
    const techId = await createTech(api);

    await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });
    await api.startJob(jobId);

    const job = await api.getJob(jobId);
    expect(job.status).toBe('IN_PROGRESS');

    const tech2 = await createTech(api);
    const { res, body } = await api.assignJob(jobId, {
      assigned_to: tech2,
      scheduled_start: api.futureDate(96),
      scheduled_end: api.futureDate(98),
    });

    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/in_progress/i);
  });
});
