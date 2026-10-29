/**
 * SERV10X-38 Task 6b — estimate→job conversion copies the estimate's line items onto the
 * job's OWN JobLineItem rows (job.controller.ts create(), estimate branch, ~line 909-1055).
 * Before this, an estimate-backed job's Items tab was always empty: job_line_items is a new
 * table (Task 3) and nothing populated it on conversion. Per Ran's principle, lead→job must
 * carry ALL information with no loss — see .superpowers/sdd/artifacts/task-6b-brief.md.
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
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
  STANDALONE_JOB_FIXTURE,
} from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  customer: { findUnique: ReturnType<typeof vi.fn> };
  serviceLocation: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// Full-fidelity estimate line items — exercises every field the brief's mapping copies
// (unit_cost / discount_* / item_type / price_book_item_id), unlike the shared ESTIMATE_FIXTURE
// (which only carries the bare minimum fields used by estimate-total math elsewhere).
const ESTIMATE_LINES = [
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
];

let capturedCreateManyArgs: { data: Record<string, unknown>[] } | undefined;
let capturedJobCreateArgs: { data: Record<string, unknown> } | undefined;
let txPriceBookFindMany: ReturnType<typeof vi.fn>;
// job-owns-tax-discount (E1) - the standalone-job tax_rate lookup; a test can override its
// resolved value (default: no state-tax row → 0%).
let txStateTaxRateFindFirst: ReturnType<typeof vi.fn>;

/** Wires $transaction to an inline tx mock covering everything the create() branches touch.
 *  `trackedItems` answers the §5.1 conversion-stamping lookup (org-scoped, track_inventory:
 *  true) — default [] stamps every copied line NOT_TRACKED. */
function mockTransaction(jobFixture: unknown, trackedItems: { id: string }[] = []) {
  capturedCreateManyArgs = undefined;
  capturedJobCreateArgs = undefined;
  txPriceBookFindMany = vi.fn().mockResolvedValue(trackedItems);
  txStateTaxRateFindFirst = vi.fn().mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedJobCreateArgs = args;
          return Promise.resolve(jobFixture);
        }),
      },
      // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
      estimate: { update: vi.fn().mockResolvedValue({}) },
      jobLineItem: {
        createMany: vi.fn().mockImplementation((args: { data: Record<string, unknown>[] }) => {
          capturedCreateManyArgs = args;
          return Promise.resolve({ count: args.data.length });
        }),
      },
      priceBookItem: { findMany: txPriceBookFindMany },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: txStateTaxRateFindFirst },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
}

function mockApprovedEstimate(overrides: Record<string, unknown> = {}) {
  mockPrisma.estimate.findUnique.mockResolvedValue({
    ...ESTIMATE_APPROVED_FIXTURE,
    // ESTIMATE_APPROVED_FIXTURE.status is the pre-rename literal ('APPROVED'); the job-from-
    // estimate guard checks ESTIMATE_STATUS.WON, so override it explicitly here.
    status: 'WON',
    line_items: ESTIMATE_LINES,
    // R3b (2026-07-21) — cost model (D2/D8/D18): copied onto the new job's row (not a line item).
    labor_hours: 8,
    overhead_mode: 'PERCENTAGE',
    overhead_value: 12,
    lead: {
      customer_id: CUSTOMER_FIXTURE.id,
      service_address_line1: '123 Main St',
      customer: { id: CUSTOMER_FIXTURE.id },
      assigned_to: TEST_USERS.sales.id,
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.invoice.findFirst.mockResolvedValue(null); // no deposit-invoice gate
  mockPrisma.job.findFirst.mockResolvedValue(null); // idempotent find-or-create: nothing pre-existing
  mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  mockTransaction(JOB_FIXTURE);
});

describe('POST /api/jobs — copies estimate line items to JobLineItem (SERV10X-38 Task 6b)', () => {
  it('copies the estimate line items onto the new job inside the creation transaction', async () => {
    mockAuthAs('admin');
    mockApprovedEstimate();

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedCreateManyArgs).toBeDefined();
    expect(capturedCreateManyArgs!.data).toHaveLength(2);
    expect(capturedCreateManyArgs!.data[0]).toEqual({
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      sequence: 1,
      description: 'AC Unit replacement',
      quantity: 1,
      unit_price: 800,
      unit_cost: 500,
      markup_percent: null,
      is_taxable: true,
      line_total: 800,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'MATERIAL',
      price_book_item_id: 'pbi0000-0000-0000-0000-000000000001',
      // Inventory P1 (§5.1): the default mock resolves no tracked items ⇒ NOT_TRACKED.
      stock_status: 'NOT_TRACKED',
    });
    expect(capturedCreateManyArgs!.data[1]).toEqual({
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      sequence: 2,
      description: 'Labor',
      quantity: 2,
      unit_price: 100,
      unit_cost: null,
      markup_percent: null,
      is_taxable: true,
      line_total: 200,
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      discount_amount: 20,
      item_type: 'SERVICE',
      price_book_item_id: null,
      stock_status: 'NOT_TRACKED',
    });
  });

  it('stamps a copied line NOT_TRACKED even when its catalog item is tracked — LO-4 retired the tracked→UNSYNCED stamp (QA-401)', async () => {
    // LO-4: Logistic Orders own all stock deduction, so estimate→job copies never land UNSYNCED
    // and there is NO track_inventory join at conversion — every copied line stamps NOT_TRACKED.
    mockAuthAs('admin');
    mockApprovedEstimate();
    mockTransaction(JOB_FIXTURE, [{ id: 'pbi0000-0000-0000-0000-000000000001' }]);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // No track_inventory join anymore — the estimate→job trackedIds lookup was deleted.
    expect(txPriceBookFindMany).not.toHaveBeenCalled();
    expect(capturedCreateManyArgs!.data[0].stock_status).toBe('NOT_TRACKED');
    expect(capturedCreateManyArgs!.data[1].stock_status).toBe('NOT_TRACKED');
  });

  it('is idempotent: does not re-copy lines when the estimate already has a job (find-or-create, Bug #23)', async () => {
    mockAuthAs('admin');
    mockApprovedEstimate();
    // The find-or-create short-circuits BEFORE the transaction — simulate a job that already exists.
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE, id: 'existing-job-1' });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(200); // idempotent path returns the existing job, not a fresh 201
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(capturedCreateManyArgs).toBeUndefined();
  });

  it('does not copy job lines on the standalone (no-estimate) create path', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockTransaction(STANDALONE_JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedCreateManyArgs).toBeUndefined();
  });

  // R3b (2026-07-21) — cost model (D2/D8/D18): the estimate's cost basis copies onto the job row
  // itself (not a line item), same "no information loss on conversion" principle as the lines above.
  it('copies the estimate labor_hours/overhead_mode/overhead_value onto the new job row', async () => {
    mockAuthAs('admin');
    mockApprovedEstimate();

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs).toBeDefined();
    expect(capturedJobCreateArgs!.data.labor_hours).toBe(8);
    expect(capturedJobCreateArgs!.data.overhead_mode).toBe('PERCENTAGE');
    expect(capturedJobCreateArgs!.data.overhead_value).toBe(12);
  });

  it('leaves labor_hours/overhead_mode/overhead_value null on a from-scratch (no-estimate) job', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockTransaction(STANDALONE_JOB_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    // The standalone branch never sets these fields at all — undefined (schema default: null).
    expect(capturedJobCreateArgs!.data.labor_hours).toBeUndefined();
  });

  // job-owns-tax-discount (E1/E2): a job converted from a WON estimate inherits that estimate's
  // ALREADY-RESOLVED tax rate and discount, one time, at conversion - same "no information loss"
  // precedent as the cost basis above, not a fresh service-location lookup.
  it("copies the estimate's tax_rate and discount onto the new job row", async () => {
    mockAuthAs('admin');
    mockApprovedEstimate({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 20 });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs).toBeDefined();
    expect(capturedJobCreateArgs!.data.tax_rate).toBe(0.0625); // ESTIMATE_FIXTURE.tax_rate
    expect(capturedJobCreateArgs!.data.discount_type).toBe('PERCENTAGE');
    expect(capturedJobCreateArgs!.data.discount_value).toBe(10);
    expect(capturedJobCreateArgs!.data.discount_amount).toBe(20);
  });

  // job-owns-tax-discount (E1): a standalone job has no estimate to inherit from, so it stamps
  // its own tax_rate from the service location it was created at - the same lookup
  // estimate.controller.ts uses for a customer-anchored estimate.
  // #2090 slice 3d - the inversion of the slice-1 interim this replaces. Convert-to-job now
  // carries SELECTED lines only: a declined optional line is the work the customer said no to,
  // and copying it onto the job made it fully billable with nothing left to say it was declined
  // (JobLineItem carries neither flag). The estimate keeps it, with its "Declined" caption.
  it('#2053: OMITS a WON estimate\'s optional-unselected line from the job', async () => {
    mockAuthAs('admin');
    mockApprovedEstimate({
      line_items: [
        ...ESTIMATE_LINES,
        {
          sequence: 3,
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
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // The estimate's two real lines, and only those.
    expect(capturedCreateManyArgs!.data).toHaveLength(2);
    const descriptions = (capturedCreateManyArgs!.data as Record<string, unknown>[]).map((l) => l.description);
    expect(descriptions).not.toContain('DECLINED optional add-on');
    // An optional line the customer DID take is still copied, and still flagless - JobLineItem
    // has no such columns, and a taken add-on is ordinary work.
    for (const line of capturedCreateManyArgs!.data as Record<string, unknown>[]) {
      expect(line).not.toHaveProperty('is_optional');
      expect(line).not.toHaveProperty('is_selected');
    }
  });

  it('#2053: KEEPS an optional line the customer accepted', async () => {
    mockAuthAs('admin');
    mockApprovedEstimate({
      line_items: [
        ...ESTIMATE_LINES,
        {
          sequence: 3,
          description: 'ACCEPTED optional add-on',
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
          is_optional: true,
          is_selected: true,
        },
      ],
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedCreateManyArgs!.data).toHaveLength(3);
    expect((capturedCreateManyArgs!.data[2] as Record<string, unknown>).description).toBe('ACCEPTED optional add-on');
  });

  it('stamps tax_rate from the service location on a from-scratch (no-estimate) job', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE); // state: 'TX'
    mockTransaction(STANDALONE_JOB_FIXTURE);
    txStateTaxRateFindFirst.mockResolvedValue({ tax_rate: 0.0625 });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreateArgs!.data.tax_rate).toBe(0.0625);
    // No estimate to inherit a discount from — left at the schema default.
    expect(capturedJobCreateArgs!.data.discount_type).toBeUndefined();
  });
});
