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
 * Started, cancelled and reopened go through M6's two-lane chain (S06.25): the route only QUEUES the alert, with the job's
 * stored Sold By, crew and Dispatcher, to be sent after the response. permission-job-lifecycle-alerts-db.test.ts covers who
 * it reaches; here the route is asked to queue the right job and people.
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
  stubReopenTransaction,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// The job completed alert walks M6's two lanes against the database (permission-job-completed-alert-db.test.ts covers
// who it reaches); here the route is only asked to hand it the right job.
vi.mock('../services/notifications/jobCompletedAlert', () => ({
  alertJobCompleted: vi.fn().mockResolvedValue(undefined),
}));

// The queue the three lifecycle alerts ride: here it only records what was queued (the request scope stays the real one).
vi.mock('../services/notifications/reviewAttentionQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notifications/reviewAttentionQueue')>()),
  queueReviewAttention: vi.fn(),
}));

// Job created is queued for after the response (S06.27); the queue entry point is what the route calls.
vi.mock('../services/notifications/jobSchedulingAlerts', () => ({
  queueJobSchedulingAlert: vi.fn(),
  queueJobUnassignedAlert: vi.fn(),
  queueStagingReadyAlert: vi.fn(),
}));

// Import AFTER mock is registered so we get the spy reference.
import { queueJobSchedulingAlert } from '../services/notifications/jobSchedulingAlerts';
import { emit } from '../services/notifications/notificationService';
import { alertJobCompleted } from '../services/notifications/jobCompletedAlert';
import { queueReviewAttention } from '../services/notifications/reviewAttentionQueue';
const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockQueueScheduling = queueJobSchedulingAlert as ReturnType<typeof vi.fn>;
const mockAlertJobCompleted = alertJobCompleted as ReturnType<typeof vi.fn>;
const mockQueue = queueReviewAttention as ReturnType<typeof vi.fn>;

/** The lifecycle alert a request queued, for one verb. */
const queuedLifecycle = (verb: string) => mockQueue.mock.calls.map((c: any[]) => c[0]).find((p: any) => p.lifecycle?.verb === verb);

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TECH_USER = TEST_USERS.technician;
const SALES_USER = TEST_USERS.sales;

/**
 * A job whose stored Sold By (S03.9) is the sales user, on an estimate whose lead is OWNED BY SOMEONE
 * ELSE: a notification that still walked job -> estimate -> lead -> owner would name the wrong person.
 */
const LEAD_OWNER_ID = 'u0000000-0000-0000-0000-0000000000ee';
const JOB_WITH_COMMISSION = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
  salesperson: { id: SALES_USER.id, first_name: 'Test', last_name: 'Sales' },
  dispatcher: { id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher' },
  estimate: {
    ...JOB_FIXTURE.estimate,
    lead: {
      commission_owner: { id: LEAD_OWNER_ID, first_name: 'Lead', last_name: 'Owner' },
      commission_owner_id: LEAD_OWNER_ID,
    },
  },
};

/** The same job once its Sold By has been cleared. The lead above still has an Owner. */
const JOB_WITH_NO_SOLD_BY = { ...JOB_WITH_COMMISSION, salesperson: null };

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
  dispatcher: { id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher' },
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

/** Stored Sold By set, and cleared: the second must reach nobody, whatever the lead's Owner is. */
const SOLD_BY_CASES: Array<[string, Record<string, unknown>, string | undefined]> = [
  ['stored Sold By is set', JOB_WITH_COMMISSION, SALES_USER.id],
  ['stored Sold By is empty', JOB_WITH_NO_SOLD_BY, undefined],
];

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // The job-level complete writes its visit cancels, history, status move and review round in one transaction (S06.1);
  // the stub runs that callback against the same mocked client.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

  // Default: no deposit invoice present (deposit-gate used by some handlers).
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // loadGrantsFor() used by the canDo middleware.

  // canAccessRow uses prisma.job.findFirst for row-scope checks.
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });

  // mockAuthAs sets up findUnique + userPermissionOverride defaults.
});

// ─── 1. dispatch.job_created ──────────────────────────────────────────────────

describe('POST /api/jobs (direct create, no estimate) — dispatch.job_created', () => {
  it('queues dispatch.job_created after a direct (no estimate_id) job is created', async () => {
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
        // The lead's own entries are carried onto the job in the same transaction (S05.15); none here.
        recordContactEntry: { findMany: vi.fn().mockResolvedValue([]) },
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

    // One alert, about the job just made, for the chain to walk after the response.
    expect(mockQueueScheduling).toHaveBeenCalledTimes(1);
    const args = mockQueueScheduling.mock.calls[0]![0];
    expect(args.verb).toBe('dispatch.job_created');
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.dispatcher.id);
    expect(args.jobId).toBe(createdJob.id);
    // Nobody is named by a create: the alert reads the job's people itself.
    expect(args.namedIds).toBeUndefined();
  });
});

// ─── 2. job.started ──────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/start — job.started', () => {
  it.each(SOLD_BY_CASES)('queues job.started with the crew and the stored Sold By when %s', async (_label, baseJob, expectedSoldBy) => {
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
      ...baseJob,
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

    // The alert goes through the chain's lanes after the response, never the role-list emit.
    expect(mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.started')).toBeUndefined();
    const queued = queuedLifecycle('job.started');
    expect(queued).toBeDefined();
    expect(queued).toMatchObject({ orgId: ALPHA_ORG_ID, actorId: TEST_USERS.admin.id, jobId: JOB_FIXTURE.id, onlyIfDone: false });
    expect(queued.lifecycle.job).toMatchObject({ jobNumber: JOB_FIXTURE.job_number, crewIds: [TECH_USER.id], soldById: expectedSoldBy ?? null, dispatcherId: TEST_USERS.dispatcher.id });
  });
});

// ─── 3. job.completed ────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/complete — job.completed', () => {
  it.each(SOLD_BY_CASES)('hands the alert the job\'s crew, Dispatcher and stored Sold By when %s', async (_label, baseJob, expectedSoldBy) => {
    mockAuthAs('admin');

    mockPrisma.job.findUnique.mockResolvedValueOnce({
      id: JOB_FIXTURE.id,
      status: 'IN_PROGRESS',
      assignees: [{ user_id: TECH_USER.id }], visits: [{ assignees: [{ user_id: TECH_USER.id }] }],
      job_number: JOB_FIXTURE.job_number,
      source_plan_id: null,
      // The stored field, whatever the estimate's lead has as a commission owner.
      salesperson_id: expectedSoldBy ?? null,
      dispatcher_id: TEST_USERS.dispatcher.id,
    });

    const updatedJob = {
      ...baseJob,
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

    expect(mockAlertJobCompleted).toHaveBeenCalledTimes(1);
    const args = mockAlertJobCompleted.mock.calls[0]![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.job).toEqual({
      id: JOB_FIXTURE.id,
      job_number: JOB_FIXTURE.job_number,
      salesperson_id: expectedSoldBy ?? null,
      dispatcher_id: TEST_USERS.dispatcher.id,
      crewIds: [TECH_USER.id],
    });
    // The alert is not raised through the role-list path any more.
    expect(mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.completed')).toBeUndefined();
  });
});

// ─── 4. job.cancelled ────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/cancel — job.cancelled', () => {
  it.each(SOLD_BY_CASES)('queues job.cancelled with the crew and the stored Sold By when %s', async (_label, baseJob, expectedSoldBy) => {
    mockAuthAs('admin');

    // cancel() reads the job with invoices.
    mockPrisma.job.findUnique.mockResolvedValueOnce({
      ...SCHEDULED_NO_INVOICE_JOB,
      estimate: {
        lead: {
          commission_owner: { id: LEAD_OWNER_ID, first_name: 'Lead', last_name: 'Owner' },
          commission_owner_id: LEAD_OWNER_ID,
        },
      },
    });

    // cancel() uses a $transaction; tx.job.update returns the jobDetailSelect shape.
    // S8 (D6): jobDetailSelect returns crew through the TRIPS - there is no top-level
    // `assignees` key on a job row any more, and a fixture that keeps one alive is how a
    // notification that reaches nobody stays green.
    const cancelledJob = {
      ...baseJob,
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
        // The lead's own entries are carried onto the job in the same transaction (S05.15); none here.
        recordContactEntry: { findMany: vi.fn().mockResolvedValue([]) },
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
      .send({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer no-show' });

    expect(res.status).toBe(200);

    expect(mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.cancelled')).toBeUndefined();
    const queued = queuedLifecycle('job.cancelled');
    expect(queued).toBeDefined();
    expect(queued).toMatchObject({ orgId: ALPHA_ORG_ID, actorId: TEST_USERS.admin.id, jobId: JOB_FIXTURE.id, onlyIfDone: false });
    expect(queued.lifecycle.job).toMatchObject({ jobNumber: JOB_FIXTURE.job_number, crewIds: [TECH_USER.id], soldById: expectedSoldBy ?? null, dispatcherId: TEST_USERS.dispatcher.id });
    // The reason rides with the alert; "Lost" is a lead word and never a job's.
    expect(queued.lifecycle.data).toEqual({ cancelled_reason: 'Customer no-show' });
  });
});

// ─── 5. job.reopened ─────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/reopen — job.reopened', () => {
  it('queues job.reopened with the crew after status reverts to IN_PROGRESS', async () => {
    mockAuthAs('admin');

    stubReopenTransaction({ status: 'COMPLETED', job_number: COMPLETED_JOB.job_number });

    // S8 (D6): the detail select's crew lives on the visits. See the cancel test above.
    const reopenedJob = {
      ...COMPLETED_JOB,
      status: 'IN_PROGRESS',
      completed_at: null,
      assignees: undefined,
      visits: [{ assignees: [{ user_id: TECH_USER.id, user: { id: TECH_USER.id, first_name: 'Test', last_name: 'Tech' } }] }],
    };
    mockPrisma.job.findUnique.mockResolvedValue(reopenedJob);
    mockPrisma.job.update.mockResolvedValue(reopenedJob);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/reopen`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    expect(mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'job.reopened')).toBeUndefined();
    const queued = queuedLifecycle('job.reopened');
    expect(queued).toBeDefined();
    expect(queued).toMatchObject({ orgId: ALPHA_ORG_ID, actorId: TEST_USERS.admin.id, jobId: JOB_FIXTURE.id, onlyIfDone: false });
    expect(queued.lifecycle.job).toMatchObject({ jobNumber: JOB_FIXTURE.job_number, crewIds: [TECH_USER.id], dispatcherId: TEST_USERS.dispatcher.id });
  });
});
