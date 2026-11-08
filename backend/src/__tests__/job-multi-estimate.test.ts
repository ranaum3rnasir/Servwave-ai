/**
 * SERV10X-61 Task 9 (MONEY PATH) - POST /api/jobs converts MULTIPLE WON estimates into ONE job.
 * job.controller.ts create(), the length > 1 branch. All selected estimates are ATTACHED to the
 * new job (Estimate.job_id / EstimateJobLink) and their line items feed the job's item list;
 * Job.estimate_id (1:1 provenance) is NULL for multi. A length-1 estimate_ids collapses to the
 * UNCHANGED single-estimate branch (byte-identical to estimate_id).
 *
 * The single-estimate path itself is covered exhaustively by jobs.test.ts /
 * job-create-from-estimate-lines.test.ts / comm-email-backfill.test.ts (all still green,
 * untouched) - this file only adds the multi-estimate + normalization coverage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID,
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  LEAD_FIXTURE,
  JOB_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

const mockPrisma = prisma as unknown as {
  estimate: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  serviceLocation: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  email: { updateMany: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// Shared lead's owner set - a row-scoped creator (unused for admin) must own EVERY estimate's lead.
const SHARED_LEAD = {
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: LOCATION_FIXTURE.id,
  service_address_line1: '123 Main St',
  job_type: null as string | null,
  customer: { id: CUSTOMER_FIXTURE.id },
  lead_assignees: [{ user_id: TEST_USERS.sales.id }],
};

// Estimate A - created FIRST (earlier created_at); 2 line items (seq 1, 2).
const ESTIMATE_A = {
  id: 'f0000000-0000-0000-0000-00000000000a',
  estimate_number: 'E00010',
  status: 'WON',
  lead_id: LEAD_FIXTURE.id,
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: LOCATION_FIXTURE.id,
  // Task 10b: every estimate on one job must share ONE rate - the from-job invoice inherits it.
  tax_rate: 0.0625,
  job_id: null as string | null,
  job: null as { id: string } | null,
  job_type: null as string | null,
  labor_hours: 8,
  overhead_mode: 'PERCENTAGE',
  overhead_value: 12,
  created_at: new Date('2026-02-01'),
  lead: SHARED_LEAD,
  line_items: [
    {
      sequence: 1,
      description: 'AC Unit replacement',
      quantity: 1,
      unit_price: 800,
      unit_cost: 500,
      is_taxable: true,
      line_total: 800,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'MATERIAL',
      price_book_item_id: 'pbi0000-0000-0000-0000-000000000001',
    },
    {
      sequence: 2,
      description: 'Labor',
      quantity: 2,
      unit_price: 100,
      unit_cost: null,
      is_taxable: true,
      line_total: 200,
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      discount_amount: 20,
      item_type: 'SERVICE',
      price_book_item_id: null,
    },
  ],
};

// Estimate B - created SECOND (later created_at); 1 line item (seq 1).
const ESTIMATE_B = {
  ...ESTIMATE_A,
  id: 'f0000000-0000-0000-0000-00000000000b',
  estimate_number: 'E00011',
  labor_hours: 4,
  overhead_mode: 'FIXED',
  overhead_value: 50,
  created_at: new Date('2026-02-05'),
  line_items: [
    {
      sequence: 1,
      description: 'Thermostat',
      quantity: 1,
      unit_price: 150,
      unit_cost: 90,
      is_taxable: true,
      line_total: 150,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'MATERIAL',
      price_book_item_id: 'pbi0000-0000-0000-0000-000000000002',
    },
  ],
};

let capturedJobCreateArgs: { data: Record<string, unknown> } | undefined;
let capturedEstimateUpdateManyArgs: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
let capturedLineCreateManyArgs: { data: Record<string, unknown>[] } | undefined;
let capturedEstimateUpdateArgs: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;

/**
 * Multi branch (length > 1) tx: job.create + estimate.updateMany + jobLineItem.createMany.
 * `attachedCount` overrides what the conditional updateMany reports as matched - the concurrency
 * guard compares it against the requested id count, so a short count means another request won
 * the attach race between the pre-flight check and the write.
 */
function mockMultiTransaction(jobFixture: unknown, attachedCount?: number) {
  capturedJobCreateArgs = undefined;
  capturedEstimateUpdateManyArgs = undefined;
  capturedLineCreateManyArgs = undefined;
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedJobCreateArgs = args;
          return Promise.resolve(jobFixture);
        }),
        // Scheduling-notifications PRD: a create carrying a scheduled_start also stamps the job's
        // once-per-job "scheduled announcement happened" guard in this same transaction.
        update: vi.fn().mockResolvedValue({}),
      },
      estimate: {
        updateMany: vi.fn().mockImplementation((args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          capturedEstimateUpdateManyArgs = args;
          return Promise.resolve({ count: attachedCount ?? args.where.id.in.length });
        }),
      },
      jobLineItem: {
        createMany: vi.fn().mockImplementation((args: { data: Record<string, unknown>[] }) => {
          capturedLineCreateManyArgs = args;
          return Promise.resolve({ count: args.data.length });
        }),
      },
      jobAssignee: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
      // transaction, so the tx fake has to answer the visit + org delegates.
      visit: {
        create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
    }),
  );
}

/** Single branch (length 1) tx: job.create + estimate.update (single mirror) + jobLineItem.createMany. */
function mockSingleTransaction(jobFixture: unknown) {
  capturedJobCreateArgs = undefined;
  capturedEstimateUpdateArgs = undefined;
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedJobCreateArgs = args;
          return Promise.resolve(jobFixture);
        }),
        // Scheduling-notifications PRD: a create carrying a scheduled_start also stamps the job's
        // once-per-job "scheduled announcement happened" guard in this same transaction.
        update: vi.fn().mockResolvedValue({}),
      },
      estimate: {
        update: vi.fn().mockImplementation((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          capturedEstimateUpdateArgs = args;
          return Promise.resolve({});
        }),
      },
      jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // MV-BOARD-15: a create carrying a scheduled_start now books visit 1 in this same
      // transaction, so the tx fake has to answer the visit + org delegates.
      visit: {
        create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  // Deposit gate off by default on BOTH read shapes (single = findFirst, multi = findMany).
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  // Idempotent find-or-create (single branch): nothing pre-existing by default.
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  mockPrisma.email.updateMany.mockResolvedValue({ count: 0 });
});

describe('POST /api/jobs - multi-estimate money path (SERV10X-61 Task 9)', () => {
  it('length-1 estimate_ids:[id] behaves like estimate_id:id (single-estimate provenance path)', async () => {
    mockAuthAs('admin');
    // Length 1 routes to the UNCHANGED single branch - which reads estimate.findUnique, sets
    // Job.estimate_id, and mirrors via estimate.update (NOT updateMany).
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_A,
      lead: SHARED_LEAD,
    });
    mockSingleTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id] });

    expect(res.status).toBe(201);
    // Provenance (1:1) IS set for a single-estimate conversion.
    expect(capturedJobCreateArgs!.data.estimate_id).toBe(ESTIMATE_A.id);
    // Single-mirror write path (estimate.update), proving the single branch ran - not the multi
    // one. The where is tenant-scoped (project rule: every authed where spreads tenantWhere).
    expect(capturedEstimateUpdateArgs).toEqual({
      where: { id: ESTIMATE_A.id, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_FIXTURE.id },
    });
    // The multi branch's findMany was never touched.
    expect(mockPrisma.estimate.findMany).not.toHaveBeenCalled();
  });

  it('TWO WON estimates on the SAME lead → one job: provenance NULL, BOTH attached, UNION re-sequenced 1..N', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A, ESTIMATE_B]); // created_at asc
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(201);

    // Provenance (1:1) is NULL for multi.
    expect(capturedJobCreateArgs!.data.estimate_id).toBeNull();
    // Cost basis is left null for multi (org default via resolveOverhead).
    expect(capturedJobCreateArgs!.data.labor_hours).toBeNull();
    expect(capturedJobCreateArgs!.data.overhead_mode).toBeNull();
    expect(capturedJobCreateArgs!.data.overhead_value).toBeNull();

    // BOTH estimates attached (Estimate.job_id) via a single updateMany over the id set. The
    // where carries the tenant guard (project rule) AND `job_id: null`, which makes the attach
    // CONDITIONAL on the estimates still being unattached - Estimate.job_id is deliberately not
    // @unique, so the pre-flight check alone cannot stop two concurrent creates.
    expect(capturedEstimateUpdateManyArgs).toEqual({
      where: {
        id: { in: [ESTIMATE_A.id, ESTIMATE_B.id] },
        organization_id: ALPHA_ORG_ID,
        job_id: null,
      },
      data: { job_id: JOB_FIXTURE.id },
    });

    // Line UNION: A's 2 lines then B's 1 line (created_at order), re-sequenced CONTINUOUSLY 1,2,3.
    expect(capturedLineCreateManyArgs!.data).toHaveLength(3);
    expect(capturedLineCreateManyArgs!.data.map((d) => d.sequence)).toEqual([1, 2, 3]);
    expect(capturedLineCreateManyArgs!.data.map((d) => d.description)).toEqual([
      'AC Unit replacement',
      'Labor',
      'Thermostat',
    ]);
    // The 3rd row is B's line, re-sequenced to 3 - full field mapping (incl. NOT_TRACKED).
    expect(capturedLineCreateManyArgs!.data[2]).toEqual({
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      sequence: 3,
      description: 'Thermostat',
      quantity: 1,
      unit_price: 150,
      unit_cost: 90,
      markup_percent: null,
      is_taxable: true,
      line_total: 150,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'MATERIAL',
      price_book_item_id: 'pbi0000-0000-0000-0000-000000000002',
      stock_status: 'NOT_TRACKED',
    });
  });

  // #2090 slice 3d - the inversion of the slice-1 interim this replaces. The union carries
  // SELECTED lines only, and the filter runs BEFORE the continuous 1..N re-sequence, so the
  // job's sequence numbers have no holes where a declined add-on used to be.
  it('#2053: the union OMITS a declined optional line and re-sequences without a hole', async () => {
    mockAuthAs('admin');
    const estimateBWithDeclinedOption = {
      ...ESTIMATE_B,
      line_items: [
        ...ESTIMATE_B.line_items,
        {
          sequence: 2,
          description: 'DECLINED optional add-on',
          quantity: 1,
          unit_price: 5000,
          unit_cost: 3000,
          is_taxable: true,
          line_total: 5000,
          discount_type: null,
          discount_value: null,
          discount_amount: 0,
          item_type: 'MATERIAL',
          price_book_item_id: null,
          // Source estimate line is optional and explicitly NOT selected — the customer
          // declined it. JobLineItem carries neither column, so the copy below is flagless.
          is_optional: true,
          is_selected: false,
        },
      ],
    };
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A, estimateBWithDeclinedOption]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, estimateBWithDeclinedOption.id] });

    expect(res.status).toBe(201);
    // A's 2 lines + B's 1 kept line. The declined one never reaches the union.
    const lines = capturedLineCreateManyArgs!.data as Record<string, unknown>[];
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.description)).not.toContain('DECLINED optional add-on');
    // Continuous 1..3 - the filter ran BEFORE the re-sequence, so there is no gap at 3.
    expect(lines.map((l) => l.sequence)).toEqual([1, 2, 3]);
    for (const line of lines) {
      expect(line).not.toHaveProperty('is_optional');
      expect(line).not.toHaveProperty('is_selected');
    }
  });

  it('returns 400 when ANY selected estimate is not WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      ESTIMATE_A,
      { ...ESTIMATE_B, status: 'DRAFT' },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('All estimates must be WON to create a job');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when the selected estimates belong to DIFFERENT leads', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      ESTIMATE_A,
      { ...ESTIMATE_B, lead_id: 'e0000000-0000-0000-0000-0000000000ff' },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('All estimates must belong to the same lead');
  });

  it('returns 400 when ANY selected estimate is already attached to a job (job_id set)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      ESTIMATE_A,
      { ...ESTIMATE_B, job_id: 'j0000000-0000-0000-0000-0000000000ff' },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Estimate ${ESTIMATE_B.estimate_number} is already attached to a job`);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ANY selected estimate has a still-unpaid (SENT) deposit invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A, ESTIMATE_B]);
    mockPrisma.invoice.findMany.mockResolvedValue([{ estimate_id: ESTIMATE_A.id, status: 'SENT' }]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deposit/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 when one of the selected estimates is missing / cross-org', async () => {
    mockAuthAs('admin');
    // Two ids requested, only one found.
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('One or more estimates not found');
    // The "cross-org" half of this case is what the tenant guard buys - the prisma mock answers
    // regardless of `where`, so assert the query rather than trusting the shortened list.
    expect(mockPrisma.estimate.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [ESTIMATE_A.id, ESTIMATE_B.id] },
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('single-estimate idempotency is preserved via estimate_ids:[id] (returns the existing job 200)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...ESTIMATE_A, lead: SHARED_LEAD });
    // The find-or-create short-circuits BEFORE the transaction - an existing job is returned.
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, id: 'existing-job-1' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id] });

    expect(res.status).toBe(200); // idempotent - not a fresh 201
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 403 when a row-scoped creator does not own EVERY selected estimate\'s lead', async () => {
    // A granted OWN-scoped `create Job` technician: the route guard lets them in, but the multi
    // branch requires ownership of ALL the selected estimates' leads, not just one.
    mockAuthAs('technician');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Job', effect: 'allow' },
    ]);
    mockPrisma.estimate.findMany.mockResolvedValue([
      { ...ESTIMATE_A, lead: { ...SHARED_LEAD, lead_assignees: [{ user_id: TEST_USERS.technician.id }] } },
      { ...ESTIMATE_B, lead: { ...SHARED_LEAD, lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }] } },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when the selected estimates resolve to DIFFERENT customers', async () => {
    mockAuthAs('admin');
    // Two LEAD-LESS estimates (same null lead_id, so the same-lead check passes) anchored to
    // DIFFERENT customers - one job cannot belong to two customers.
    mockPrisma.estimate.findMany.mockResolvedValue([
      { ...ESTIMATE_A, lead_id: null, lead: null },
      { ...ESTIMATE_B, lead_id: null, lead: null, customer_id: 'c0000000-0000-0000-0000-0000000000ff' },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('All estimates must belong to the same customer');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('converts TWO LEAD-LESS (customer-anchored) estimates, resolving customer + location from the estimates', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      { ...ESTIMATE_A, lead_id: null, lead: null },
      { ...ESTIMATE_B, lead_id: null, lead: null },
    ]);
    // A DIFFERENT primary location, so "the estimate's own anchor won" is observable.
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: 'b0000000-0000-0000-0000-0000000000ee' });
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(capturedJobCreateArgs!.data.service_location_id).toBe(LOCATION_FIXTURE.id);
    // Both lead-less estimates still get attached.
    expect(capturedEstimateUpdateManyArgs!.where.id).toEqual({ in: [ESTIMATE_A.id, ESTIMATE_B.id] });
  });

  it('returns 400 when the selected estimates carry DIFFERENT tax rates', async () => {
    // Task 10b derives the from-job invoice's tax from "any" of the job's estimates on the
    // premise that they all share one rate. Nothing enforced that premise - so enforce it here,
    // at the only site that can put two estimates on one job.
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      ESTIMATE_A,                          // 6.25%
      { ...ESTIMATE_B, tax_rate: 0.08 },   // 8%
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('All estimates must have the same tax rate');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // The rate must actually be LOADED - the prisma mock answers regardless of `select`.
    expect(mockPrisma.estimate.findMany.mock.calls[0][0].select.tax_rate).toBe(true);
  });

  it('accepts estimates whose tax rates are equal but differently-shaped Decimals', async () => {
    // tax_rate is a Prisma Decimal; `===` on two Decimal objects is always false. Compare by value.
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([
      { ...ESTIMATE_A, tax_rate: '0.06250' },
      { ...ESTIMATE_B, tax_rate: 0.0625 },
    ]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(201);
  });

  it('rolls back with 409 when a concurrent create attached one of the estimates first', async () => {
    // The pre-flight "unattached" check is check-then-act and Estimate.job_id is not @unique, so
    // two concurrent requests can both pass it. The conditional updateMany is the real guard: a
    // short count means someone else won, and the whole job creation must roll back rather than
    // leave a second job carrying the full union of line items.
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A, ESTIMATE_B]);
    mockMultiTransaction(JOB_FIXTURE, 1); // only 1 of the 2 was still unattached

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/attached to another job/i);
  });

  it('rejects more than 50 estimate_ids (unbounded IN clause + unbounded createMany)', async () => {
    mockAuthAs('admin');
    const ids = Array.from({ length: 51 }, (_, i) =>
      `f0000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: ids });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details[0].message).toMatch(/50/);
    expect(mockPrisma.estimate.findMany).not.toHaveBeenCalled();
  });

  // SRVW-87 - the standalone create branch already writes `status: 'SCHEDULED'` when a
  // scheduled_start is supplied; both estimate-conversion branches did not, so converting a WON
  // estimate straight onto the calendar produced a scheduled-but-UNSCHEDULED job - the same
  // badge-vs-lifecycle-bar disagreement the card is about, from a second producer.
  it('single-estimate conversion with a scheduled_start creates the job as SCHEDULED', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...ESTIMATE_A, lead: SHARED_LEAD });
    mockSingleTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        estimate_ids: [ESTIMATE_A.id],
        scheduled_start: '2026-09-01T09:00:00.000Z',
        scheduled_end: '2026-09-01T11:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.status).toBe('SCHEDULED');
  });

  it('multi-estimate conversion with a scheduled_start creates the job as SCHEDULED', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_A, ESTIMATE_B]);
    mockMultiTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        estimate_ids: [ESTIMATE_A.id, ESTIMATE_B.id],
        scheduled_start: '2026-09-01T09:00:00.000Z',
        scheduled_end: '2026-09-01T11:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.status).toBe('SCHEDULED');
  });

  it('an estimate conversion with no scheduled_start still defaults to UNSCHEDULED', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...ESTIMATE_A, lead: SHARED_LEAD });
    mockSingleTransaction(JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_ids: [ESTIMATE_A.id] });

    expect(res.status).toBe(201);
    // No status key at all, so Prisma's @default(UNSCHEDULED) still applies.
    expect('status' in capturedJobCreateArgs!.data).toBe(false);
  });
});
