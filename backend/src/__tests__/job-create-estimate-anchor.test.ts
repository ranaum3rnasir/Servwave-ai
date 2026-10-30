/**
 * SERV10X-61 - POST /api/jobs, the SINGLE-estimate branch, must respect the estimate's ANCHOR.
 *
 * Task 3 made Estimate.job_id settable at create time, so it is no longer a pure mirror of
 * Job.estimate_id: a JOB-anchored estimate carries job_id with NO Job pointing back at it. Two
 * money-path consequences the single branch did not handle:
 *
 *   1. The idempotency probe (job.findFirst({ estimate_id })) misses a job-anchored estimate, so
 *      conversion silently RE-POINTED it off its anchor job - the anchor job lost that estimate's
 *      paid deposit credit and its line items were billed twice. Now a 400, mirroring the multi
 *      branch. A genuine re-conversion (the estimate IS its own provenance job's estimate) still
 *      returns the existing job idempotently.
 *   2. The customer/service-location resolution read ONLY estimate.lead.*, so a CUSTOMER-anchored
 *      (lead-less) WON estimate - the point of this epic - 400'd on conversion. Both now fall back
 *      to the estimate's own denormalized columns, matching the multi branch.
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
  LEAD_FIXTURE,
  JOB_FIXTURE,
} from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  serviceLocation: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  email: { updateMany: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ANCHOR_JOB_ID = 'j0000000-0000-0000-0000-0000000000aa';
// A second ServiceLocation, distinct from the customer's primary, so "which location won" is
// observable rather than coincidental.
const ESTIMATE_LOCATION_ID = 'b0000000-0000-0000-0000-0000000000cc';

/** LEAD-anchored WON estimate, unattached - the pre-existing happy path. */
const LEAD_ANCHORED = {
  id: 'f0000000-0000-0000-0000-00000000000a',
  estimate_number: 'E00020',
  status: 'WON',
  lead_id: LEAD_FIXTURE.id,
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: ESTIMATE_LOCATION_ID,
  job_id: null as string | null,
  job: null as { id: string } | null,
  job_type: null as string | null,
  labor_hours: 8,
  overhead_mode: 'PERCENTAGE',
  overhead_value: 12,
  lead: {
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    service_address_line1: '123 Main St',
    job_type: null as string | null,
    customer: { id: CUSTOMER_FIXTURE.id },
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
  },
  line_items: [],
};

/** CUSTOMER-anchored (lead-less) WON estimate - no lead at all, own denormalized anchors. */
const LEAD_LESS = {
  ...LEAD_ANCHORED,
  id: 'f0000000-0000-0000-0000-00000000000b',
  estimate_number: 'E00021',
  lead_id: null as string | null,
  lead: null as typeof LEAD_ANCHORED.lead | null,
};

let capturedJobCreateArgs: { data: Record<string, unknown> } | undefined;

function mockSingleTransaction() {
  capturedJobCreateArgs = undefined;
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedJobCreateArgs = args;
          return Promise.resolve(JOB_FIXTURE);
        }),
      },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // The lead's own entries are carried onto the job in the same transaction (S05.15); none here.
      recordContactEntry: { findMany: vi.fn().mockResolvedValue([]) },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.invoice.findFirst.mockResolvedValue(null); // no blocking deposit invoice
  mockPrisma.job.findFirst.mockResolvedValue(null);     // nothing pre-existing
  // The customer's PRIMARY location - the last fallback in the precedence chain.
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  mockPrisma.email.updateMany.mockResolvedValue({ count: 0 });
  mockSingleTransaction();
});

describe('POST /api/jobs - single estimate already attached to a job (SERV10X-61)', () => {
  it('rejects a JOB-anchored estimate with 400 instead of re-pointing it off its anchor job', async () => {
    mockAuthAs('admin');
    // Anchored to ANCHOR_JOB_ID, but NO Job points back (job: null) - so the idempotency probe
    // below finds nothing and the pre-fix code silently stole the estimate from its anchor job.
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...LEAD_ANCHORED, job_id: ANCHOR_JOB_ID, job: null });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Estimate ${LEAD_ANCHORED.estimate_number} is already attached to a job`);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('LOADS the anchor columns it decides on (select carries job_id + the provenance job)', async () => {
    // The prisma mock answers regardless of `select`, so the rejection above would still pass if
    // the columns were never selected. Assert the query itself.
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...LEAD_ANCHORED, job_id: ANCHOR_JOB_ID, job: null });

    await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    const select = mockPrisma.estimate.findUnique.mock.calls[0][0].select;
    expect(select.job_id).toBe(true);
    expect(select.job).toEqual({ select: { id: true } });
  });

  it('KEEPS idempotent find-or-create: re-converting an estimate that owns its provenance job returns it (200)', async () => {
    mockAuthAs('admin');
    // The R6 mirror state of a normal conversion: job_id set AND that same job's provenance
    // estimate is this estimate. Must NOT 400 - the find-or-create still answers with the job.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...LEAD_ANCHORED,
      job_id: ANCHOR_JOB_ID,
      job: { id: ANCHOR_JOB_ID },
    });
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, id: ANCHOR_JOB_ID });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs - customer-anchored (lead-less) estimate conversion (SERV10X-61)', () => {
  it('converts a LEAD-LESS WON estimate, resolving the customer from the estimate itself', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_LESS);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_LESS.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(capturedJobCreateArgs!.data.estimate_id).toBe(LEAD_LESS.id);
  });

  it("falls back to the estimate's own service_location_id when there is no lead", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_LESS);
    // The customer's primary location is a DIFFERENT row - if the estimate's own anchor were
    // ignored, the job would land on this one instead.
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_LESS.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.service_location_id).toBe(ESTIMATE_LOCATION_ID);
  });

  it('LOADS the anchor columns it resolves from (select carries customer_id + service_location_id)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_LESS);

    await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_LESS.id });

    const select = mockPrisma.estimate.findUnique.mock.calls[0][0].select;
    expect(select.customer_id).toBe(true);
    expect(select.service_location_id).toBe(true);
  });

  it("a LEAD-anchored estimate still prefers the LEAD's location (behavior preserved)", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_ANCHORED);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.service_location_id).toBe(LOCATION_FIXTURE.id);
    expect(capturedJobCreateArgs!.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });
});

/**
 * #2188 slice 15 — the regression guard for the whole report. An operator saw no Create Job
 * control on a lead's SECOND estimate and concluded that converting the first had spent the
 * lead's only chance. It had not: the second estimate was merely SENT, and the control was
 * hidden rather than disabled-with-a-reason. A lead may hold as many jobs as it has won
 * estimates, and this pins that at the API door so the belief cannot become true by accident.
 */
describe('POST /api/jobs - a lead may hold more than one job (#2188)', () => {
  const SIBLING_JOB_ID = 'j0000000-0000-0000-0000-0000000000bb';

  /** The lead's FIRST estimate, already converted: both pointers set, at its own job. */
  const SIBLING_CONVERTED = {
    ...LEAD_ANCHORED,
    id: 'f0000000-0000-0000-0000-00000000000c',
    estimate_number: 'E00022',
    job_id: SIBLING_JOB_ID,
    job: { id: SIBLING_JOB_ID },
  };

  /** The lead's SECOND estimate: won, unattached, on the SAME lead. */
  const SECOND_ESTIMATE = {
    ...LEAD_ANCHORED,
    id: 'f0000000-0000-0000-0000-00000000000d',
    estimate_number: 'E00023',
  };

  /** The job the FIRST estimate produced. It hangs off the same lead - which is the whole point. */
  const SIBLING_JOB = {
    ...JOB_FIXTURE,
    id: SIBLING_JOB_ID,
    estimate_id: SIBLING_CONVERTED.id,
    lead_id: LEAD_FIXTURE.id,
  };

  /** Every estimate row the conversion writes, and whether it ever touched the LEAD. */
  let estimateUpdateWheres: Record<string, unknown>[];
  let leadUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    estimateUpdateWheres = [];
    leadUpdate = vi.fn();
    capturedJobCreateArgs = undefined;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: {
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            capturedJobCreateArgs = args;
            return Promise.resolve({ ...JOB_FIXTURE, id: 'j0000000-0000-0000-0000-0000000000cc' });
          }),
        },
        estimate: {
          update: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
            estimateUpdateWheres.push(args.where);
            return Promise.resolve({});
          }),
        },
        // A lead write would be a timestamp the second conversion moved. There is none.
        lead: { update: leadUpdate },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // The lead's own entries are carried onto the job in the same transaction (S05.15); none here.
        recordContactEntry: { findMany: vi.fn().mockResolvedValue([]) },
      }),
    );
    // A findFirst that actually FILTERS, rather than answering the same row to every query: the
    // sibling's job matches only a where-clause it really satisfies. Without this, a probe keyed
    // on the LEAD ("does this lead already have a job?") would slip through the double and the
    // second conversion would look fine while really being the sibling's job handed back.
    mockPrisma.job.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      const keys = ['id', 'estimate_id', 'lead_id'] as const;
      const named = keys.filter((k) => where[k] !== undefined);
      if (named.length === 0) return null;
      return named.every((k) => where[k] === SIBLING_JOB[k]) ? SIBLING_JOB : null;
    });
  });

  it('converts a SECOND won estimate on a lead whose sibling estimate is already a job', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(SECOND_ESTIMATE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: SECOND_ESTIMATE.id });

    expect(res.status).toBe(201);
    // A SECOND job, on the SAME lead - not the sibling's job handed back.
    expect(capturedJobCreateArgs!.data.estimate_id).toBe(SECOND_ESTIMATE.id);
    expect(capturedJobCreateArgs!.data.lead_id).toBe(LEAD_FIXTURE.id);
  });

  it('touches only the second estimate: the sibling keeps its job, and the lead is not rewritten', async () => {
    // Each converted estimate's money (its DEPOSIT invoice hangs off the estimate, and is drawn
    // onto the job through that estimate's own pointers) must stay with ITS job. And nothing on
    // the lead moves - a second conversion is not a second "won" moment.
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(SECOND_ESTIMATE);

    await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: SECOND_ESTIMATE.id });

    expect(estimateUpdateWheres.map((w) => w.id)).toEqual([SECOND_ESTIMATE.id]);
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it("the sibling's own re-conversion still answers with the sibling's job, untouched (200)", async () => {
    // Each converted estimate keeps its OWN job: converting the second must not re-point the first.
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(SIBLING_CONVERTED);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: SIBLING_CONVERTED.id });

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(SIBLING_JOB_ID);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * #2188 slice 15 — the THREE refusals the single-estimate branch enforces, pinned as messages.
 *
 * `frontend/src/features/estimate-workspace/lib/convertToJob.ts` mirrors these rules to explain a
 * disabled "Create Job" control (the frontend cannot import backend code). If a gate here is
 * reworded, retired or reordered, this suite goes red — which is the signal to update that mirror
 * rather than let the UI promise something the API refuses.
 */
describe('POST /api/jobs - the three single-estimate refusals (#2188)', () => {
  it('refuses an estimate that is not WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...LEAD_ANCHORED, status: 'SENT' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Estimate must be WON to create a job');
  });

  it('refuses an estimate attached to a DIFFERENT job', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...LEAD_ANCHORED, job_id: ANCHOR_JOB_ID, job: null });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Estimate ${LEAD_ANCHORED.estimate_number} is already attached to a job`);
  });

  it('refuses while a DEPOSIT invoice is still pre-payment, naming the next step', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_ANCHORED);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'inv-dep-1', status: 'SENT' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: LEAD_ANCHORED.id });

    expect(res.status).toBe(400);
    // Byte-identical to CONVERT_DEPOSIT_BLOCKED_REASON in convertToJob.ts.
    expect(res.body.error).toBe(
      'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.',
    );
  });

  it.each(['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'])(
    'accepts a %s deposit - settled money does not block',
    async (status) => {
      mockAuthAs('admin');
      mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_ANCHORED);
      mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'inv-dep-1', status });

      const res = await request(app)
        .post('/api/jobs')
        .set(authHeader('admin'))
        .send({ estimate_id: LEAD_ANCHORED.id });

      expect(res.status).toBe(201);
    },
  );
});
