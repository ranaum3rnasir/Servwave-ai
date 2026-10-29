/**
 * job-lifecycle-notifications.test.ts
 *
 * TDD for Task 3.2: emit() hooks on the five remaining job/dispatch lifecycle
 * transitions in job.controller.ts:
 *
 *   1. dispatch.job_created — create(), !estimate_id branch
 *   2. job.started                — start()
 *   3. job.completed              — complete()
 *   4. job.cancelled              — cancel()
 *   5. job.reopened               — reopen()
 *
 * Strategy (mirrors job-assign-notifications.test.ts):
 *   - vi.mock captures emit calls.
 *   - Each test hits the real Express route via supertest.
 *   - Prisma is fully mocked (vi.mock in setup.ts); tests wire only the
 *     methods their handler calls.
 *   - emit() must be called with the correct verb, object, entity, and org.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  JOB_FIXTURE,
  ALPHA_ORG_ID,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TECH_USER = TEST_USERS.technician;
const SALES_USER = TEST_USERS.sales;

/** A job with an estimate → lead → commission_owner (sold_by). */
const JOB_WITH_COMMISSION = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
  estimate: {
    ...JOB_FIXTURE.estimate,
    lead: {
      commission_owner: {
        id: SALES_USER.id,
        first_name: 'Test',
        last_name: 'Sales',
      },
      commission_owner_id: SALES_USER.id,
    },
  },
};

/** A job fixture ready for cancel (SCHEDULED, no invoices). */
const SCHEDULED_NO_INVOICE_JOB = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
  invoices: [],
};

/** A job fixture ready for reopen (COMPLETED, no issued invoices). */
const COMPLETED_JOB = {
  ...JOB_FIXTURE,
  status: 'COMPLETED' as const,
  assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
  invoices: [],
  estimate: {
    ...JOB_FIXTURE.estimate,
    lead: {
      commission_owner: {
        id: SALES_USER.id,
        first_name: 'Test',
        last_name: 'Sales',
      },
      commission_owner_id: SALES_USER.id,
    },
  },
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  // Default: no deposit invoice present (deposit-gate used by some handlers).
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // loadGrantsFor() used by the canDo middleware.
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // canAccessRow uses prisma.job.findFirst for row-scope checks.
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });

  // mockAuthAs sets up findUnique + userPermissionOverride defaults.
});

// ─── 1. dispatch.job_created ──────────────────────────────────────────────────

describe('POST /api/jobs (direct create, no estimate) — dispatch.job_created', () => {
  it('emits dispatch.job_created after a direct (no estimate_id) job is created', async () => {
    mockAuthAs('dispatcher');

    // customer + location validation lookups.
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);

    // $transaction: allocateNumber (organization.findUnique) + job.create + timelineEvent.create.
    const createdJob = {
      ...JOB_FIXTURE,
      id: 'j0000000-0000-0000-0000-000000000099',
      job_number: 'J00099',
      estimate: null,
      assignees: [], visits: [{ assignees: [] }],
    };

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        organization: {
          findUnique: vi.fn().mockResolvedValue({ id: ALPHA_ORG_ID, job_counter: 0 }),
          update: vi.fn().mockResolvedValue({ id: ALPHA_ORG_ID, job_counter: 1 }),
        },
        job: { create: vi.fn().mockResolvedValue(createdJob) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    // withTags tag lookup (uses tagAssignment, not jobTag).
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        scope_notes: 'Urgent repair needed',
      });

    expect(res.status).toBe(201);

    const call = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_created',
    );
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.dispatcher.id);
    expect(args.object.type).toBe('JOB');
    expect(args.object.id).toBe(createdJob.id);
    expect(args.object.label).toBe(createdJob.job_number);
    // A directly-created job has no assignees at creation time.
    expect(Array.isArray(args.entity.assignee_ids)).toBe(true);
  });
});

// ─── 2. job.started ──────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/start — job.started', () => {
  it('emits job.started with assignee_ids and sold_by_id after status → IN_PROGRESS', async () => {
    mockAuthAs('admin');

    // findUnique for guard lookup (status + assignees check).
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_WITH_COMMISSION.id,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      job_number: JOB_WITH_COMMISSION.job_number,
    });

    // prisma.job.update returns the full detail-select shape including estimate → lead.
    const updatedJob = {
      ...JOB_WITH_COMMISSION,
      status: 'IN_PROGRESS',
      started_at: new Date(),
    };
    mockPrisma.job.update.mockResolvedValue(updatedJob);

    // timelineEvent.create (called outside tx).
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    // withTags.
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.started');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('JOB');
    expect(args.object.id).toBe(JOB_FIXTURE.id);
    expect(args.object.label).toBe(JOB_FIXTURE.job_number);
    expect(args.entity.assignee_ids).toContain(TECH_USER.id);
    expect(args.entity.sold_by_id).toBe(SALES_USER.id);
  });
});

// ─── 3. job.completed ────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/complete — job.completed', () => {
  it('emits job.completed with assignee_ids and sold_by_id after status → COMPLETED', async () => {
    mockAuthAs('admin');

    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      job_number: JOB_FIXTURE.job_number,
      source_plan_id: null,
    });

    const updatedJob = {
      ...JOB_WITH_COMMISSION,
      status: 'COMPLETED',
      completed_at: new Date(),
    };
    mockPrisma.job.update.mockResolvedValue(updatedJob);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('admin'))
      .send({ completion_notes: 'Done' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.completed');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('JOB');
    expect(args.object.id).toBe(JOB_FIXTURE.id);
    expect(args.object.label).toBe(JOB_FIXTURE.job_number);
    expect(args.entity.assignee_ids).toContain(TECH_USER.id);
    expect(args.entity.sold_by_id).toBe(SALES_USER.id);
  });
});

// ─── 4. job.cancelled ────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/cancel — job.cancelled', () => {
  it('emits job.cancelled with assignee_ids and sold_by_id after status → CANCELLED', async () => {
    mockAuthAs('admin');

    // cancel() reads the job with invoices.
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      ...SCHEDULED_NO_INVOICE_JOB,
      estimate: {
        lead: {
          commission_owner: { id: SALES_USER.id, first_name: 'Test', last_name: 'Sales' },
          commission_owner_id: SALES_USER.id,
        },
      },
    });

    // cancel() uses a $transaction; tx.job.update returns the jobDetailSelect shape.
    // S8 (D6): jobDetailSelect returns crew through the TRIPS - there is no top-level
    // `assignees` key on a job row any more, and a fixture that keeps one alive is how a
    // notification that reaches nobody stays green.
    const cancelledJob = {
      ...JOB_WITH_COMMISSION,
      status: 'CANCELLED',
      cancelled_at: new Date(),
      assignees: undefined,
      visits: [{ assignees: [{ user_id: TECH_USER.id, user: { id: TECH_USER.id, first_name: 'Test', last_name: 'Tech' } }] }],
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue(cancelledJob) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Inventory P1 (§4.2): cancel's auto-return pass — nothing SYNCED in this flow.
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer no-show' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.cancelled');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('JOB');
    expect(args.object.id).toBe(JOB_FIXTURE.id);
    expect(args.object.label).toBe(JOB_FIXTURE.job_number);
    expect(args.entity.assignee_ids).toContain(TECH_USER.id);
    expect(args.entity.sold_by_id).toBe(SALES_USER.id);
  });
});

// ─── 5. job.reopened ─────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/reopen — job.reopened', () => {
  it('emits job.reopened with assignee_ids after status reverts to IN_PROGRESS', async () => {
    mockAuthAs('admin');

    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: COMPLETED_JOB.id,
      status: 'COMPLETED',
      job_number: COMPLETED_JOB.job_number,
      invoices: [],
    });

    // S8 (D6): the detail select's crew lives on the visits. See the cancel test above.
    const reopenedJob = {
      ...COMPLETED_JOB,
      status: 'IN_PROGRESS',
      completed_at: null,
      assignees: undefined,
      visits: [{ assignees: [{ user_id: TECH_USER.id, user: { id: TECH_USER.id, first_name: 'Test', last_name: 'Tech' } }] }],
    };
    mockPrisma.job.update.mockResolvedValue(reopenedJob);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.reopened');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('JOB');
    expect(args.object.id).toBe(JOB_FIXTURE.id);
    expect(args.object.label).toBe(JOB_FIXTURE.job_number);
    expect(args.entity.assignee_ids).toContain(TECH_USER.id);
    // job.reopened does NOT carry sold_by_id per the task spec.
    expect(args.entity).not.toHaveProperty('sold_by_id');
  });
});
