/**
 * SRVW-85 - the two invoice doors must bill the same thing.
 *
 * Door 1 (whole job):  POST /api/invoices { job_id }        - invoice.controller.create()
 * Door 2 (part of job): POST /api/jobs/:id/invoices          - job.controller.createInvoiceFromJob()
 *
 * Before this card door 1 snapshotted the ESTIMATE's line items and never once read
 * JobLineItem, so an Items-tab edit was silently discarded and the same work could be billed
 * twice (once per door). This suite pins the redirect: when a job has Items-tab lines, door 1
 * bills THOSE, with the job door's tax rule and the job door's multi-deposit drawdown, and the
 * itemized half of door 2 refuses to re-bill a job line that is already on a live invoice.
 *
 * New file rather than an append to invoices.test.ts: that file is 6,400+ lines and ends with a
 * shared-mock race pin that must stay defined last.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  CUSTOMER_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
  INVOICE_FIXTURE,
  PAYMENT_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  invoiceLineItem: { findMany: ReturnType<typeof vi.fn> };
  payment: { create: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
  depositCreditApplication: { create: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
  refund: { aggregate: ReturnType<typeof vi.fn> };
  stateTaxRate: { findFirst: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;
const LINE_A = 'aa000000-0000-0000-0000-000000000001';
const LINE_B = 'aa000000-0000-0000-0000-000000000002';
const DEP_A = 'depa0000-0000-0000-0000-000000000001';
const DEP_B = 'depb0000-0000-0000-0000-000000000002';
const EST_A = 'e1000000-0000-0000-0000-000000000001';
const EST_B = 'e2000000-0000-0000-0000-000000000002';

/**
 * One fixture shaped for BOTH doors' selects at once: invoice.controller's job include
 * (customer/service_location/assignees/estimate/job_line_items/linked_estimates) UNION
 * job.controller's jobInvoiceGuardSelect (adds job_number/scopes/invoices). Every job fixture
 * here MUST carry job_line_items and linked_estimates - both doors dereference them
 * unconditionally.
 */
function parityJob(overrides: Record<string, any> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00001',
    status: 'COMPLETED',
    source_plan_id: null,
    assignees: [{ user_id: TEST_USERS.technician.id }],
    customer_id: CUSTOMER_FIXTURE.id,
    customer: { id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false },
    service_location: { state: 'TX' },
    labor_hours: null,
    overhead_mode: null,
    overhead_value: null,
    // E1/E2 (job-owns-tax-discount) - both doors read these straight off the JOB now, not
    // through `estimate` (kept below only for the deposit-credit union, id-only in production
    // but still carrying the legacy tax_rate/discount_amount keys here since a few fixtures
    // below still set them for documentation - production no longer reads them).
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    estimate: { id: ESTIMATE_APPROVED_FIXTURE.id, tax_rate: 0, discount_amount: 0 },
    linked_estimates: [],
    job_line_items: [jobLine({})],
    scopes: [],
    invoices: [],
    ...overrides,
  };
}

function jobLine(overrides: Record<string, any> = {}) {
  return {
    id: LINE_A,
    sequence: 1,
    description: 'AC unit',
    quantity: 1,
    unit_price: 800,
    is_taxable: true,
    line_total: 800,
    item_type: 'MATERIAL',
    price_book_item_id: null,
    unit_cost: null,
    markup_percent: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockAuthAs('admin');
  // Door 1's one-active-invoice guard: nothing live on the job.
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  // No PAID deposit invoices unless a test says otherwise.
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  // Door 2's already-billed-line guard: nothing billed unless a test says otherwise.
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
  mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({
    ...INVOICE_FIXTURE,
    ...data,
    id: INVOICE_FIXTURE.id,
  }));
  mockPrisma.job.update.mockResolvedValue({});
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.payment.create.mockImplementation(async ({ data }: any) => ({ ...PAYMENT_FIXTURE, ...data }));
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockPrisma.depositCreditApplication.create.mockImplementation(async ({ data }: any) => ({ id: 'dca-1', ...data }));
  mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

function createdData(callIndex = 0): any {
  return mockPrisma.invoice.create.mock.calls[callIndex][0].data;
}

describe('POST /api/invoices { job_id } - bills the job Items tab (SRVW-85)', () => {
  it('bills the job Items-tab lines, not the estimate snapshot', async () => {
    // The estimate still says $500; the Items tab was edited to $800 after conversion.
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: {
        id: ESTIMATE_APPROVED_FIXTURE.id,
        tax_rate: 0,
        discount_amount: 0,
        line_items: [
          { id: 'li-1', sequence: 1, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: true, line_total: 500 },
        ],
      },
      job_line_items: [jobLine({ description: 'AC unit (upsized on site)', unit_price: 800, line_total: 800 })],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.subtotal)).toBe(800);
    expect(data.line_items.create).toHaveLength(1);
    expect(data.line_items.create[0].description).toBe('AC unit (upsized on site)');
    expect(Number(data.line_items.create[0].unit_price)).toBe(800);
  });

  it('stamps job_line_item_id, unit_cost and markup_percent on every copied line', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      job_line_items: [
        jobLine({ id: LINE_A, unit_cost: 400, markup_percent: 100 }),
        jobLine({ id: LINE_B, sequence: 2, description: 'Labor', unit_price: 200, line_total: 200, item_type: 'SERVICE' }),
      ],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const lines = createdData().line_items.create;
    expect(lines).toHaveLength(2);
    expect(lines[0].job_line_item_id).toBe(LINE_A);
    expect(Number(lines[0].unit_cost)).toBe(400);
    expect(Number(lines[0].markup_percent)).toBe(100);
    // Inventory P1 (§5.2 / D2): job-copied lines are stamped NOT_TRACKED so copies never
    // double-deduct - matching job.controller's itemized path exactly.
    expect(lines[0].stock_status).toBe('NOT_TRACKED');
    expect(lines[0].stock_location_id).toBeNull();
    expect(lines[1].job_line_item_id).toBe(LINE_B);
    // The second line carries neither cost column, so neither key is emitted at all.
    expect(lines[1]).not.toHaveProperty('unit_cost');
    expect(lines[1]).not.toHaveProperty('markup_percent');
  });

  it('an estimate-less job with Items-tab lines bills them at tax_rate 0 (no service-location lookup)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: null,
      linked_estimates: [],
      job_line_items: [jobLine({ unit_price: 800, line_total: 800 })],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.subtotal)).toBe(800);
    expect(Number(data.tax_rate)).toBe(0);
    expect(Number(data.tax_amount)).toBe(0);
    // The job door's rule won: an estimate-less job is untaxed, NOT service-location looked up.
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  it("an estimate-less job with NO Items-tab lines still authors body line_items, at the job's own tax_rate", async () => {
    // E1 (job-owns-tax-discount): this branch (from-scratch authoring on a job with nothing on
    // its Items tab) now reads job.tax_rate directly too - no more service-location lookup at
    // invoice-creation time, same as branch (a).
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: null,
      linked_estimates: [],
      job_line_items: [],
      tax_rate: 0.0625,
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        job_id: JOB_ID,
        line_items: [{ description: 'Emergency call-out', quantity: 1, unit_price: 400, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.subtotal)).toBe(400);
    expect(Number(data.tax_amount)).toBe(25);
    expect(Number(data.total_amount)).toBe(425);
  });

  it('Items-tab lines take precedence over body line_items', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: null,
      linked_estimates: [],
      job_line_items: [jobLine({ unit_price: 800, line_total: 800 })],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        job_id: JOB_ID,
        line_items: [{ description: 'Bogus', quantity: 1, unit_price: 1, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(data.line_items.create).toHaveLength(1);
    expect(Number(data.subtotal)).toBe(800);
    expect(data.line_items.create[0].job_line_item_id).toBe(LINE_A);
  });

  it('credits a deposit paid on a LINKED (non-provenance) estimate', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: null,
      linked_estimates: [{ id: EST_A, tax_rate: 0 }],
      job_line_items: [jobLine({ unit_price: 800, line_total: 800, is_taxable: false })],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 300 } });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.deposit_credit)).toBe(300);
    expect(Number(data.amount_due)).toBe(500);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.payment.create.mock.calls[0][0].data.reference_number).toBe('DEPOSIT-CREDIT');
  });

  it('clamps cumulative credit across two deposits to the invoice total', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      estimate: null,
      linked_estimates: [{ id: EST_A, tax_rate: 0 }, { id: EST_B, tax_rate: 0 }],
      job_line_items: [jobLine({ unit_price: 500, line_total: 500, is_taxable: false })],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }, { id: DEP_B }]);
    // Each deposit has $300 of unapplied credit; the invoice total is $500.
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 300 } });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    expect(Number(createdData().deposit_credit)).toBe(500);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledTimes(2);
    const amounts = mockPrisma.depositCreditApplication.create.mock.calls.map((c: any) => Number(c[0].data.amount));
    expect(amounts).toEqual([300, 200]);
  });

  it("clamps the job's frozen discount_amount to the job-line subtotal (no negative total)", async () => {
    // E2: discount_amount is passed straight through, unlike the old rate-based re-derivation -
    // but Door 1 still defensively clamps it to THIS invoice's own subtotal, in case the item
    // set shrank after the discount was resolved (see invoice.controller.ts's create()).
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      discount_amount: 900,
      job_line_items: [jobLine({ unit_price: 500, line_total: 500 })],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.discount_amount)).toBe(500);
    expect(Number(data.total_amount)).toBe(0);
    expect(Number(data.amount_due)).toBe(0);
    expect(mockPrisma.job.update.mock.calls[0][0].data.amount_invoiced).toEqual({ increment: 0 });
  });

  it('increments job.amount_invoiced once, by the job-line total plus tax', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(parityJob({
      tax_rate: 0.1,
      estimate: {
        id: ESTIMATE_APPROVED_FIXTURE.id,
        tax_rate: 0.1,
        discount_amount: 0,
        // The estimate still says $500 - the increment must NOT follow it.
        line_items: [
          { id: 'li-1', sequence: 1, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: true, line_total: 500 },
        ],
      },
      job_line_items: [jobLine({ unit_price: 800, line_total: 800, is_taxable: true })],
    }));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(201);
    const data = createdData();
    expect(Number(data.total_amount)).toBe(880);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.update.mock.calls[0][0].data.amount_invoiced).toEqual({ increment: 880 });
  });

  it('cross-org job_id still 404s through the whole-job door', async () => {
    // Honest note: GREEN before the fix too - a tenancy regression lock, not proof of the bug.
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: '00000000-0000-0000-0000-0000000000ff' });

    expect(res.status).toBe(404);
    const where = mockPrisma.job.findUnique.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.id).toBe('00000000-0000-0000-0000-0000000000ff');
  });
});

describe('the two doors cannot bill the same work twice (SRVW-85 AC 3)', () => {
  it('door 1 then door 2 on the same lines is refused', async () => {
    const job = parityJob({
      estimate: { id: ESTIMATE_APPROVED_FIXTURE.id, tax_rate: 0, discount_amount: 0 },
      job_line_items: [jobLine({ id: LINE_A, unit_price: 800, line_total: 800, is_taxable: false })],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const first = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });
    expect(first.status).toBe(201);
    expect(createdData().line_items.create[0].job_line_item_id).toBe(LINE_A);

    // The first invoice now owns LINE_A.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { job_line_item_id: LINE_A, invoice: { invoice_number: 'I00001' } },
    ]);

    const second = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(second.status).toBe(409);
    expect(second.body.error).toContain('I00001');
    expect(mockPrisma.invoice.create).toHaveBeenCalledTimes(1);
  });

  it('both doors produce the same subtotal, tax_rate, tax_amount, deposit_credit, total_amount and amount_due', async () => {
    // due_date, labor_hours and overhead_* are deliberately excluded from this comparison: the
    // job door leaves all four null by design (progress draws must not carry the whole-job cost
    // basis), and send() backfills due_date. Both are recorded as follow-ups on the card.
    const job = parityJob({
      tax_rate: 0.0625,
      estimate: { id: EST_A, tax_rate: 0.0625, discount_amount: 0 },
      linked_estimates: [{ id: EST_A, tax_rate: 0.0625 }],
      job_line_items: [
        jobLine({ id: LINE_A, unit_price: 800, line_total: 800, is_taxable: true }),
        jobLine({ id: LINE_B, sequence: 2, description: 'Labor', unit_price: 200, line_total: 200, is_taxable: false, item_type: 'SERVICE' }),
      ],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 250 } });

    const viaWholeJobDoor = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID });
    expect(viaWholeJobDoor.status).toBe(201);

    const viaJobDoor = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A, LINE_B] });
    expect(viaJobDoor.status).toBe(201);

    const a = createdData(0);
    const b = createdData(1);
    for (const field of ['subtotal', 'tax_rate', 'tax_amount', 'deposit_credit', 'total_amount', 'amount_due']) {
      expect(`${field}=${Number(a[field])}`).toBe(`${field}=${Number(b[field])}`);
    }
    // And the shared numbers are the job's, not the estimate's.
    expect(Number(a.subtotal)).toBe(1000);
    expect(Number(a.tax_amount)).toBe(50);
    expect(Number(a.deposit_credit)).toBe(250);
  });
});
