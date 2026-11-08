import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  ALPHA_ORG_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  LEAD_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
  STANDALONE_JOB_FIXTURE,
  TEST_USERS,
} from './helpers';

const mockPrisma = prisma as any;

// Communication ↔ Jobs (story 5): estimate-time transactional emails persist with
// customer/lead only — the job doesn't exist yet (correct attach-by-origin). When the
// job materializes from the estimate, the controller backfills those system Email rows
// (account 'system', job_id NULL, the estimate's lead) with the new job_id + job_label
// so the estimate email appears on the job timeline.

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // The global prisma mock (setup.ts) does not include email.updateMany yet — the
  // backfill is its first caller. Attach it here (scoped to this test file's module).
  mockPrisma.email.updateMany = vi.fn().mockResolvedValue({ count: 2 });
  // Deposit gate off by default (no kind=DEPOSIT invoice).
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
});

/** Mock the full from-estimate job-creation happy path. */
function mockEstimateJobCreation(estimateOverrides: Record<string, unknown> = {}) {
  mockPrisma.estimate.findUnique.mockResolvedValue({
    ...ESTIMATE_APPROVED_FIXTURE,
    // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal ('APPROVED'); the job-from-
    // estimate guard checks ESTIMATE_STATUS.WON, so override it explicitly here.
    status: 'WON',
    lead: {
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      service_address_line1: '123 Main St',
      customer: { id: CUSTOMER_FIXTURE.id },
      assigned_to: TEST_USERS.sales.id,
    },
    ...estimateOverrides,
  });
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(JOB_FIXTURE),
      },
      // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
      estimate: { update: vi.fn().mockResolvedValue({}) },
      // SERV10X-38 Task 6b — estimate branch copies line_items onto the new job.
      jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
}

describe('POST /api/jobs — estimate-email backfill (story 5)', () => {
  it('backfills system estimate emails onto the new job (exact where/data shape)', async () => {
    mockAuthAs('admin');
    mockEstimateJobCreation();

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.email.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.email.updateMany).toHaveBeenCalledWith({
      where: {
        organization_id: ALPHA_ORG_ID, // tenant-scoped
        account: 'system',             // transactional rows only
        job_id: null,                  // never re-attribute
        lead_id: LEAD_FIXTURE.id,      // only this estimate's lead
      },
      data: { job_id: JOB_FIXTURE.id, job_label: JOB_FIXTURE.job_number },
    });
  });

  it('does NOT backfill when the job is created standalone (no estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT backfill when the estimate has no lead_id (guards the null-lead mass-match)', async () => {
    mockAuthAs('admin');
    mockEstimateJobCreation({ lead_id: null });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  it('job creation still succeeds when the backfill throws (fire-and-forget)', async () => {
    mockAuthAs('admin');
    mockEstimateJobCreation();
    mockPrisma.email.updateMany.mockRejectedValue(new Error('backfill db error'));

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
    expect(mockPrisma.email.updateMany).toHaveBeenCalledTimes(1);
  });
});
