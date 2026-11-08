import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createCustomerWithLocation, createTech } from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ─── Helper: create urgent job in a specific state ────────────────────────────

async function createJobInState(
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
// SECTION 15.1 — UNASSIGN (JS-01 to JS-05)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('15.1 Unassign', () => {
  test('JS-01: Unassign SCHEDULED job → UNASSIGNED, dates cleared', async () => {
    const jobId = await createJobInState(api, 'SCHEDULED');

    const { res, body } = await api.unassignJob(jobId);

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('UNASSIGNED');
    expect(body.job.assigned_to).toBeNull();
    expect(body.job.scheduled_start).toBeNull();
    expect(body.job.scheduled_end).toBeNull();
  });

  test('JS-02: Unassign UNASSIGNED job → 400', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');
    const { res } = await api.unassignJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-03: Unassign IN_PROGRESS job → 400', async () => {
    const jobId = await createJobInState(api, 'IN_PROGRESS');
    const { res } = await api.unassignJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-04: Unassign COMPLETED job → 400', async () => {
    const jobId = await createJobInState(api, 'COMPLETED');
    const { res } = await api.unassignJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-05: Unassign CANCELLED job → 400', async () => {
    const jobId = await createJobInState(api, 'CANCELLED');
    const { res } = await api.unassignJob(jobId);
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 15.2 — START (JS-06 to JS-10)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('15.2 Start', () => {
  test('JS-06: Start SCHEDULED job → IN_PROGRESS, started_at set', async () => {
    const jobId = await createJobInState(api, 'SCHEDULED');

    const { res, body } = await api.startJob(jobId);

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('IN_PROGRESS');
    expect(body.job.started_at).not.toBeNull();
  });

  test('JS-07: Start UNASSIGNED job → 400', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');
    const { res } = await api.startJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-08: Start IN_PROGRESS job → 400', async () => {
    const jobId = await createJobInState(api, 'IN_PROGRESS');
    const { res } = await api.startJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-09: Start COMPLETED job → 400', async () => {
    const jobId = await createJobInState(api, 'COMPLETED');
    const { res } = await api.startJob(jobId);
    expect(res.status()).toBe(400);
  });

  test('JS-10: Start CANCELLED job → 400', async () => {
    const jobId = await createJobInState(api, 'CANCELLED');
    const { res } = await api.startJob(jobId);
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 15.3 — COMPLETE (JS-11 to JS-16)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('15.3 Complete', () => {
  test('JS-11: Complete IN_PROGRESS job with notes → COMPLETED', async () => {
    const jobId = await createJobInState(api, 'IN_PROGRESS');

    const { res, body } = await api.completeJob(jobId, 'All work finished successfully');

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('COMPLETED');
    expect(body.job.completed_at).not.toBeNull();
    expect(body.job.completion_notes).toBe('All work finished successfully');
  });

  test('JS-12: Complete IN_PROGRESS job without notes → 200 COMPLETED (notes optional)', async () => {
    // 2026-06-10 catalog-§5 contradiction fix (§5.2): completeJobSchema (job.controller.ts) makes
    // completion_notes optional and the complete handler has no notes requirement — empty notes
    // complete fine; the old 400 expectation was stale. — verify at baseline run
    const jobId = await createJobInState(api, 'IN_PROGRESS');
    const { res, body } = await api.completeJob(jobId, '');
    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('COMPLETED');
  });

  test('JS-13: Complete UNASSIGNED job → 400', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');
    const { res } = await api.completeJob(jobId, 'Done');
    expect(res.status()).toBe(400);
  });

  test('JS-14: Complete SCHEDULED job → 400', async () => {
    const jobId = await createJobInState(api, 'SCHEDULED');
    const { res } = await api.completeJob(jobId, 'Done');
    expect(res.status()).toBe(400);
  });

  test('JS-15: Complete COMPLETED job → 400', async () => {
    const jobId = await createJobInState(api, 'COMPLETED');
    const { res } = await api.completeJob(jobId, 'Done again');
    expect(res.status()).toBe(400);
  });

  test('JS-16: Complete CANCELLED job → 400', async () => {
    const jobId = await createJobInState(api, 'CANCELLED');
    const { res } = await api.completeJob(jobId, 'Done');
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 15.4 — CANCEL (JS-17 to JS-22)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('15.4 Cancel', () => {
  test('JS-17: Cancel UNASSIGNED job → CANCELLED', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');

    const { res, body } = await api.cancelJob(jobId, 'No longer needed');

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('CANCELLED');
    expect(body.job.cancelled_reason).toBe('No longer needed');
    expect(body.job.cancelled_at).not.toBeNull();
  });

  test('JS-18: Cancel SCHEDULED job → CANCELLED', async () => {
    const jobId = await createJobInState(api, 'SCHEDULED');

    const { res, body } = await api.cancelJob(jobId, 'Customer cancelled');

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('CANCELLED');
  });

  test('JS-19: Cancel IN_PROGRESS job → CANCELLED', async () => {
    const jobId = await createJobInState(api, 'IN_PROGRESS');

    const { res, body } = await api.cancelJob(jobId, 'Emergency cancellation');

    expect(res.status()).toBe(200);
    expect(body.job.status).toBe('CANCELLED');
  });

  test('JS-20: Cancel COMPLETED job → 400', async () => {
    const jobId = await createJobInState(api, 'COMPLETED');
    const { res } = await api.cancelJob(jobId, 'Too late');
    expect(res.status()).toBe(400);
  });

  test('JS-21: Cancel already-CANCELLED job → 400', async () => {
    const jobId = await createJobInState(api, 'CANCELLED');
    const { res } = await api.cancelJob(jobId, 'Cancel again');
    expect(res.status()).toBe(400);
  });

  test('JS-22: Cancel job without reason → 400', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');
    const { res } = await api.cancelJob(jobId, '');
    expect(res.status()).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 15.5 — DELETE (JS-23 to JS-27)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('15.5 Delete', () => {
  test('JS-23: Delete UNASSIGNED job → deleted', async () => {
    const jobId = await createJobInState(api, 'UNASSIGNED');

    const { res, status } = await api.deleteJob(jobId);

    expect(status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Job deleted');
  });

  test('JS-24: Delete SCHEDULED job → 400', async () => {
    const jobId = await createJobInState(api, 'SCHEDULED');
    const { status } = await api.deleteJob(jobId);
    expect(status).toBe(400);
  });

  test('JS-25: Delete IN_PROGRESS job → 400', async () => {
    const jobId = await createJobInState(api, 'IN_PROGRESS');
    const { status } = await api.deleteJob(jobId);
    expect(status).toBe(400);
  });

  test('JS-26: Delete COMPLETED job → 400', async () => {
    const jobId = await createJobInState(api, 'COMPLETED');
    const { status } = await api.deleteJob(jobId);
    expect(status).toBe(400);
  });

  test('JS-27: Delete CANCELLED job → 400', async () => {
    const jobId = await createJobInState(api, 'CANCELLED');
    const { status } = await api.deleteJob(jobId);
    expect(status).toBe(400);
  });
});
