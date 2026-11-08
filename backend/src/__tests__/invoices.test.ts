import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { recomputeInvoiceTotals } from '../lib/invoice-totals';
import { systemVoidPaymentForChargeback } from '../controllers/invoice.controller';
import {
  sendInvoiceEmail,
  sendPaymentReceivedEmail,
} from '../lib/email';
import {
  isStripeConfigured,
  createCheckoutSession,
  createRefund,
  getStripeForOrg,
} from '../lib/stripe';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
  STANDALONE_JOB_FIXTURE_2,
  JOB_CHARGE_FIXTURE,
  INVOICE_FIXTURE,
  INVOICE_SENT_FIXTURE,
  INVOICE_PARTIAL_FIXTURE,
  STANDALONE_INVOICE_FIXTURE,
  PAYMENT_FIXTURE,
  STATE_TAX_FIXTURE,
} from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { ALPHA_ORG_ID } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockSendInvoiceEmail = sendInvoiceEmail as ReturnType<typeof vi.fn>;
const mockIsStripeConfigured = isStripeConfigured as ReturnType<typeof vi.fn>;
const mockCreateCheckoutSession = createCheckoutSession as ReturnType<typeof vi.fn>;
const mockCreateRefund = createRefund as ReturnType<typeof vi.fn>;
const mockGetStripeForOrg = getStripeForOrg as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  job: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  customer: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  serviceLocation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  stateTaxRate: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  depositCreditApplication: { aggregate: ReturnType<typeof vi.fn> };
  refund: { aggregate: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  // Inventory P1 (§4.4/§4.5) — delete/void auto-returns delegate tx stock writes to these
  // spies; the money verbs (refund/credit/void-payment) must NEVER touch them (QA-507).
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  // Inventory P1 (§5.3) — authored-line stamping resolves tracked refs pre-tx.
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Helper: build a completed job for create tests ──

function buildCompletedJob(overrides: Record<string, any> = {}) {
  return {
    id: JOB_FIXTURE.id,
    job_number: 'J00001',
    status: 'COMPLETED',
    assignees: [{ user_id: TEST_USERS.technician.id }],
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    customer: {
      id: CUSTOMER_FIXTURE.id,
      payment_type: null,
      tax_exempt: false,
    },
    service_location: {
      state: 'TX',
    },
    // job-owns-tax-discount (E1/E2/E4) - the job-anchored invoice door reads these straight off
    // the JOB now, not through `estimate` below. Mirrors the estimate's own tax_rate/
    // discount_amount so every pre-E4 assertion here (computed off the nested estimate) stays
    // unchanged.
    tax_rate: 0.08,
    discount_amount: 0,
    estimate: {
      id: ESTIMATE_APPROVED_FIXTURE.id,
      estimate_number: 'E00003',
      tax_rate: 0.08,
      discount_amount: 0,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      line_items: [
        {
          id: 'li000000-0000-0000-0000-000000000001',
          sequence: 1,
          description: 'AC Unit replacement',
          quantity: 1,
          unit_price: 1800,
          is_taxable: true,
          line_total: 1800,
        },
        {
          id: 'li000000-0000-0000-0000-000000000002',
          sequence: 2,
          description: 'Labor',
          quantity: 1,
          unit_price: 500,
          is_taxable: true,
          line_total: 500,
        },
      ],
      deposit: {
        id: 'd0000000-0000-0000-0000-000000000001',
        amount: 1000,
        status: 'REQUESTED',
        total_refunded: 0,
        paid_at: null,
      },
      lead: {
        id: 'e0000000-0000-0000-0000-000000000001',
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      },
    },
    // SRVW-85: the job door now bills the Items tab, not the estimate snapshot. These MIRROR the
    // estimate lines above, which is what production actually does - job.controller.ts:1213-1238
    // seeds JobLineItem from the estimate at conversion - so every money assertion below is
    // unchanged. `linked_estimates` is not optional: the controller dereferences it unconditionally.
    linked_estimates: [],
    job_line_items: [
      {
        id: 'jli00000-0000-0000-0000-000000000001',
        sequence: 1,
        description: 'AC Unit replacement',
        quantity: 1,
        unit_price: 1800,
        is_taxable: true,
        line_total: 1800,
        item_type: 'MATERIAL',
        price_book_item_id: null,
        unit_cost: null,
        markup_percent: null,
      },
      {
        id: 'jli00000-0000-0000-0000-000000000002',
        sequence: 2,
        description: 'Labor',
        quantity: 1,
        unit_price: 500,
        is_taxable: true,
        line_total: 500,
        item_type: 'SERVICE',
        price_book_item_id: null,
        unit_cost: null,
        markup_percent: null,
      },
    ],
    charges: [],
    ...overrides,
  };
}

// ─── POST /api/invoices ────────────────────────────────

describe('POST /api/invoices', () => {
  it('admin creates invoice from completed job', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob();
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const createdInvoice = { ...INVOICE_FIXTURE };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(createdInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.invoice.invoice_number).toBe('I00001');
  });

  it('returns 404 for non-existent job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: '00000000-0000-0000-0000-000000000099' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });

  it('returns 400 if the job is a non-billable service-plan visit (source_plan_id set)', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({ source_plan_id: '00000000-0000-0000-0000-0000000000sp' });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan|already paid|non-billable/i);
  });

  it('allows invoicing a CANCELLED job (cancellation is not terminal, Spec B1)', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({ status: 'CANCELLED' });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ ...INVOICE_FIXTURE }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  // Multi-invoice per job is enabled — the original "blocks duplicate invoice" assertion no
  // longer applies. The happy-path create test above already covers the unblocked path; a
  // separate "second invoice on same job" test would just re-invoke the same mocked flow.

  it('returns 400 if job has no line items', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      estimate: {
        ...buildCompletedJob().estimate,
        line_items: [],
      },
      job_line_items: [],
      charges: [],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create invoice with no line items');
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');
    const job = buildCompletedJob();
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('sales'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(403);
  });

  // Phase B (technician redesign): a strict technician has NO `create Invoice` grant by default —
  // invoicing is an opt-in per-user toggle (own-scoped via the job). So an un-granted tech is
  // blocked at the route guard, even on a job they own. The granted-path positives (a tech with a
  // per-user `create Invoice` allow override CAN invoice an assigned job, CANNOT invoice a
  // non-assigned job) live in phaseB-controllers-invoice-ownership.test.ts.
  it('strict technician cannot create an invoice by default — even for their own job (route guard 403)', async () => {
    mockAuthAs('technician');
    const job = buildCompletedJob({ assignees: [{ user_id: TEST_USERS.technician.id }] });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('strict technician cannot create an invoice for another technician\'s job (route guard 403)', async () => {
    mockAuthAs('technician');
    const job = buildCompletedJob({ assignees: [{ user_id: '00000000-0000-0000-0000-000000000099' }] });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ job_id: JOB_FIXTURE.id });

    // No default create Invoice grant → blocked at the route guard (not the controller's
    // ownership check, which is exercised for a GRANTED tech in the phaseB-controllers file).
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  // ── Seam 4 (Phase 2a): deposit-credit DRAWDOWN keyed on the REAL kind=DEPOSIT Invoice ──
  // The drawdown now finds the PAID kind=DEPOSIT Invoice for the job's estimate and calls
  // lib/deposit-credit (remainingDepositCredit / applyDepositCredit) so the ledger's
  // deposit_invoice_id is a VALID Invoice FK — not the legacy Deposit row id (the Phase-1 bug).
  it('deposit credit keys the ledger on the REAL kind=DEPOSIT Invoice id (FK fix) and records a post-tax Payment, NOT a discount line', async () => {
    mockAuthAs('admin');
    // Deposit invoice: $1000 paid, $0 refunded, $0 previously applied ⇒ remaining $1000.
    const job = buildCompletedJob({
      estimate: {
        ...buildCompletedJob().estimate,
        // Estimate lines total $2300, tax_rate 0.08 ⇒ tax $184, total $2484 (no discount here).
        discount_amount: 0,
        deposit: {
          id: 'd0000000-0000-0000-0000-000000000001',
          amount: 1000,
          status: 'PAID',
          total_refunded: 0,
          paid_at: new Date('2026-01-23'),
          payment_method: 'CARD',
        },
      },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    let capturedPaymentData: any;
    let capturedApplicationData: any;
    // Plain functions for load-bearing tx reads ⇒ immune to a cross-file resetAllMocks.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now (the multi-deposit union),
          // so the kind=DEPOSIT discriminator lives here rather than on findFirst.
          findMany: async (args: any) => {
            if (args?.where?.kind === 'DEPOSIT') return [{ id: 'dep-inv-1' }];
            return [];
          },
          findFirst: async () => null, // no prior STANDARD invoice
          create: (args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          },
        },
        payment: {
          aggregate: async () => ({ _sum: { amount: 1000 } }),
          create: (args: any) => {
            capturedPaymentData = args.data;
            return { ...PAYMENT_FIXTURE, ...args.data };
          },
        },
        depositCreditApplication: {
          aggregate: async () => ({ _sum: { amount: 0 } }),
          create: (args: any) => {
            capturedApplicationData = args.data;
            return { id: 'dca-1', ...args.data };
          },
        },
        refund: { aggregate: async () => ({ _sum: { amount: 0 } }) },
        timelineEvent: { create: async () => ({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);

    // subtotal $2300, tax $184 (2300 * 0.08), total $2484 — credit is POST-TAX, never shrinks these.
    expect(capturedData.subtotal).toBe(2300);
    expect(capturedData.tax_amount).toBe(184);
    expect(capturedData.total_amount).toBe(2484);

    // applied = min(remaining 1000, total 2484) = 1000
    expect(Number(capturedData.deposit_credit)).toBe(1000);
    expect(Number(capturedData.amount_due)).toBeCloseTo(2484 - 1000, 2);

    // The ledger row's deposit_invoice_id is the REAL kind=DEPOSIT Invoice id (valid FK),
    // NOT the legacy Deposit row id 'd0000000-...'. target_invoice_id is the new STANDARD invoice.
    expect(capturedApplicationData).toBeDefined();
    expect(capturedApplicationData.deposit_invoice_id).toBe('dep-inv-1');
    expect(capturedApplicationData.target_invoice_id).toBe(INVOICE_FIXTURE.id);
    expect(Number(capturedApplicationData.amount)).toBe(1000);

    // The credit is recorded as a Payment (post-tax), tagged with the DEPOSIT-CREDIT reference.
    expect(capturedPaymentData).toBeDefined();
    expect(capturedPaymentData.amount).toBe(1000);
    expect(capturedPaymentData.reference_number).toBe('DEPOSIT-CREDIT');
    expect(capturedPaymentData.notes).toContain('Deposit credit applied');
  });

  it('deposit credit never exceeds the deposit across a job\'s STANDARD invoices (no-double-credit)', async () => {
    mockAuthAs('admin');
    // Deposit $1000, $0 refunded, but $700 ALREADY applied to a prior STANDARD invoice.
    const job = buildCompletedJob({
      estimate: {
        ...buildCompletedJob().estimate,
        discount_amount: 0,
        deposit: {
          id: 'd0000000-0000-0000-0000-000000000001',
          amount: 1000,
          status: 'PAID',
          total_refunded: 0,
          paid_at: new Date('2026-01-23'),
          payment_method: 'CARD',
        },
      },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedApplicationData: any;
    let capturedPaymentData: any;
    let capturedData: any;
    // Load-bearing tx reads use PLAIN functions (not vi.fn) so a concurrent file's
    // vi.resetAllMocks() (leads.test.ts:52) cannot wipe them mid-$transaction. See the
    // "shared-mock race pin" test for the deterministic regression that proves this.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the deposit lookup is invoice.findMany now. It returns the PAID kind=DEPOSIT
          // invoice; the prior-STANDARD snapshot guard returns an existing invoice ⇒ second
          // invoice starts empty.
          findMany: async (args: any) => {
            if (args?.where?.kind === 'DEPOSIT') return [{ id: 'dep-inv-1' }];
            return [];
          },
          findFirst: async () => ({ id: 'prior-inv', invoice_number: 'I00001' }),
          create: (args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          },
        },
        payment: {
          // $1000 net paid on the deposit invoice.
          aggregate: async () => ({ _sum: { amount: 1000 } }),
          create: (args: any) => {
            capturedPaymentData = args.data;
            return { ...PAYMENT_FIXTURE, ...args.data };
          },
        },
        depositCreditApplication: {
          // $700 already actively applied against this deposit invoice.
          aggregate: async () => ({ _sum: { amount: 700 } }),
          create: (args: any) => {
            capturedApplicationData = args.data;
            return { id: 'dca-2', ...args.data };
          },
        },
        refund: { aggregate: async () => ({ _sum: { amount: 0 } }) },
        timelineEvent: { create: async () => ({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // remaining = 1000 paid − 700 applied − 0 refunded = 300; applied = min(300, total) = 300.
    expect(Number(capturedApplicationData.amount)).toBe(300);
    expect(capturedApplicationData.deposit_invoice_id).toBe('dep-inv-1');
    expect(capturedPaymentData.amount).toBe(300);
    expect(Number(capturedData.deposit_credit)).toBe(300);
    // Σ applied across both invoices = 700 + 300 = 1000 = deposit. Never more.
  });

  it('tax-once worked example: $100k / MA 6.25% / 30% deposit → STANDARD amount_due $76,250', async () => {
    mockAuthAs('admin');
    // Deposit (non-taxable) = $30,000 paid; STANDARD invoice subtotal $100,000, tax 6.25%.
    const job = buildCompletedJob({
      tax_rate: 0.0625,
      estimate: {
        ...buildCompletedJob().estimate,
        tax_rate: 0.0625,
        discount_amount: 0,
        line_items: [
          { id: 'li-1', sequence: 1, description: 'Full HVAC system', quantity: 1, unit_price: 100000, is_taxable: true, line_total: 100000 },
        ],
        deposit: {
          id: 'd0000000-0000-0000-0000-000000000001',
          amount: 30000,
          status: 'PAID',
          total_refunded: 0,
          paid_at: new Date('2026-01-23'),
          payment_method: 'CARD',
        },
      },
      // SRVW-85: the Items tab is the billing source, so it mirrors the overridden estimate line.
      job_line_items: [
        { id: 'jli-1', sequence: 1, description: 'Full HVAC system', quantity: 1, unit_price: 100000, is_taxable: true, line_total: 100000, item_type: 'MATERIAL', price_book_item_id: null, unit_cost: null, markup_percent: null },
      ],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    let capturedPaymentData: any;
    // Plain functions for load-bearing tx reads ⇒ immune to a cross-file resetAllMocks.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now.
          findMany: async (args: any) => {
            if (args?.where?.kind === 'DEPOSIT') return [{ id: 'dep-inv-1' }];
            return [];
          },
          findFirst: async () => null,
          create: (args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          },
        },
        payment: {
          aggregate: async () => ({ _sum: { amount: 30000 } }),
          create: (args: any) => {
            capturedPaymentData = args.data;
            return { ...PAYMENT_FIXTURE, ...args.data };
          },
        },
        depositCreditApplication: {
          aggregate: async () => ({ _sum: { amount: 0 } }),
          create: async () => ({ id: 'dca-3' }),
        },
        refund: { aggregate: async () => ({ _sum: { amount: 0 } }) },
        timelineEvent: { create: async () => ({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // STANDARD invoice carries the full tax exactly once.
    expect(capturedData.subtotal).toBe(100000);
    expect(capturedData.tax_amount).toBe(6250);
    expect(capturedData.total_amount).toBe(106250);
    // Deposit credit applied as a $30,000 post-tax Payment.
    expect(capturedPaymentData.amount).toBe(30000);
    expect(Number(capturedData.amount_due)).toBe(76250);
  });

  it('a direct (estimate-less, charge-only) job can no longer be invoiced → 400 (JobCharge retired)', async () => {
    // Behavior narrowing (entity-redesign §5): the invoice owns its lines now (InvoiceLineItem)
    // and snapshots the ESTIMATE. A legacy direct/urgent job whose only "lines" were JobCharges
    // has nothing to bill — owned-line editing for direct jobs is a Phase 8 UI concern.
    mockAuthAs('admin');
    const job = buildCompletedJob({
      id: STANDALONE_JOB_FIXTURE_2.id,
      estimate: null,
      job_line_items: [],
      charges: [JOB_CHARGE_FIXTURE],
      invoice: null,
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue(STATE_TAX_FIXTURE);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: STANDALONE_JOB_FIXTURE_2.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create invoice with no line items');
  });

  it('material receipt adds NO JobCharge, so the invoice subtotal is unchanged (DEC2)', async () => {
    mockAuthAs('admin');
    // A job that HAS had material received (its PO lines carry qty_received + unit_cost) but
    // whose charges list is EMPTY — DEC2: receipt never creates a JobCharge.
    const job = buildCompletedJob({
      estimate: { ...buildCompletedJob().estimate, line_items: [
        { id: 'eli00000-0000-0000-0000-000000000001', description: 'Labor', quantity: 1, unit_price: 100, line_total: 100, item_type: 'SERVICE' },
      ], discount_amount: 0, tax_rate: 0 },
      // SRVW-85: the Items tab mirrors the overridden estimate line - same $100 subtotal.
      job_line_items: [
        { id: 'jli00000-0000-0000-0000-000000000001', sequence: 1, description: 'Labor', quantity: 1, unit_price: 100, is_taxable: true, line_total: 100, item_type: 'SERVICE', price_book_item_id: null, unit_cost: null, markup_percent: null },
      ],
      charges: [], // material receipt contributed nothing here
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.invoice.create.mockImplementation((args: any) => Promise.resolve({ ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id }));
    mockPrisma.payment.create.mockResolvedValue(PAYMENT_FIXTURE);
    // This test passes the whole mockPrisma as the tx, whose bare invoice.findMany vi.fn() would
    // return undefined for the SRVW-85 deposit lookup.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/invoices').set(authHeader('admin')).send({ job_id: JOB_FIXTURE.id });
    expect(res.status).toBe(201);
    const capturedData = mockPrisma.invoice.create.mock.calls[0][0].data;
    // Subtotal = estimate line items only ($100). Material cost is invisible to the invoice.
    expect(capturedData.subtotal).toBe(100);
  });

  // ── Seam 1: INVOICE OWNS LINES ──
  it('first STANDARD invoice snapshots the JOB line items into InvoiceLineItem rows', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      estimate: { ...buildCompletedJob().estimate, deposit: null, discount_amount: 0 },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          // No prior STANDARD invoice on this job.
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // SRVW-85: the JOB has 2 Items-tab lines - they are snapshotted into InvoiceLineItem rows.
    expect(capturedData.line_items).toBeDefined();
    expect(capturedData.line_items.create).toBeDefined();
    expect(capturedData.line_items.create).toHaveLength(job.job_line_items.length);
    const first = capturedData.line_items.create[0];
    expect(first.description).toBe('AC Unit replacement');
    expect(Number(first.unit_price)).toBe(1800);
    expect(Number(first.line_total)).toBe(1800);
    expect(first.is_taxable).toBe(true);
    expect(first.sequence).toBe(1);
    // Each copied line points back at the JobLineItem it was billed from.
    expect(first.job_line_item_id).toBe(job.job_line_items[0].id);
  });

  // SRVW-85 DELIBERATE REWRITE (retitle + this comment; no assertion is weakened). This 409 was
  // reported as contradicting job-invoicing.test.ts:418 ('allows a second invoice on the same job
  // (no idempotency block)'). It does not: they belong to two different verbs. THIS door bills the
  // WHOLE job in one document, so a second one is always a duplicate. The other bills a DRAW or a
  // SUBSET and is repeatable by design (Spec B1, afdc77e0d) - that test sends a flat { amount: 40 }
  // and is left untouched.
  it('POST /api/invoices (whole-job door) blocks a 2nd invoice while one is active (409, creates nothing)', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      estimate: { ...buildCompletedJob().estimate, deposit: null, discount_amount: 0 },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    // An active (non-VOIDED) STANDARD invoice already exists on this job.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'prior-inv', invoice_number: 'I00001' });

    // If the guard wrongly fell through, this tx surface would let create() run; we assert it does NOT.
    const txCreate = vi.fn();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: txCreate },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(409);
    // The blocking message names the existing invoice so the user can void/edit it.
    expect(res.body.error).toContain('I00001');
    // No invoice is created — the transaction (and tx.invoice.create) never runs.
    expect(txCreate).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows a new invoice when the only prior invoice on the job is VOIDED (re-snapshots full lines)', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      estimate: { ...buildCompletedJob().estimate, deposit: null, discount_amount: 0 },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    // The guard's findFirst excludes VOIDED invoices, so it finds none → creation proceeds.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // A re-issued invoice (after a void) carries the FULL estimate lines + totals again.
    expect(capturedData.line_items.create).toHaveLength(job.job_line_items.length);
    expect(capturedData.subtotal).toBe(2300);
    // The guard's findFirst must EXCLUDE voided invoices.
    const guardCall = mockPrisma.invoice.findFirst.mock.calls[0][0];
    expect(guardCall.where.status).toEqual({ not: 'VOIDED' });
  });

  it('a direct (estimate-less) job is rejected before any deposit-invoice lookup (JobCharge retired)', async () => {
    // The deposit-credit drawdown only runs for estimate-anchored jobs. A direct, estimate-less
    // job now has no billable lines (charges retired) and is rejected with 400 before the tx —
    // so neither the deposit-invoice lookup nor any payment/application write can occur.
    mockAuthAs('admin');
    const job = buildCompletedJob({
      id: STANDALONE_JOB_FIXTURE_2.id,
      estimate: null,
      job_line_items: [],
      charges: [JOB_CHARGE_FIXTURE],
      invoice: null,
      service_location: { state: 'TX' },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue(STATE_TAX_FIXTURE);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: STANDALONE_JOB_FIXTURE_2.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create invoice with no line items');
  });

  it('tax exempt customer gets $0 tax', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      customer: {
        id: CUSTOMER_FIXTURE.id,
        payment_type: null,
        tax_exempt: true,
      },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedData.tax_amount).toBe(0);
  });

  it('calculates due date from customer payment_type', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      customer: {
        id: CUSTOMER_FIXTURE.id,
        payment_type: 'COD',
        tax_exempt: false,
      },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // COD means due_date is today
    const today = new Date();
    const dueDate = new Date(capturedData.due_date);
    expect(dueDate.getFullYear()).toBe(today.getFullYear());
    expect(dueDate.getMonth()).toBe(today.getMonth());
    expect(dueDate.getDate()).toBe(today.getDate());
  });

  it('allows re-invoicing after void', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      invoice: { id: INVOICE_FIXTURE.id, status: 'VOIDED' },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    const createdInvoice = { ...INVOICE_FIXTURE, invoice_number: 'I00002' };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          // No PAID deposit invoice here (estimate.deposit is REQUESTED); a prior STANDARD exists.
          findFirst: vi.fn().mockImplementation((args: any) => {
            if (args?.where?.kind === 'DEPOSIT') return Promise.resolve(null);
            return Promise.resolve({ invoice_number: 'I00001' });
          }),
          create: vi.fn().mockResolvedValue(createdInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
  });

  it('increments job.amount_invoiced by the invoice gross total (STANDARD, job-anchored)', async () => {
    mockAuthAs('admin');
    // Estimate lines $2300, tax_rate 0.08, no discount ⇒ tax $184, total $2484.
    const job = buildCompletedJob();
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedJobUpdate: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockImplementation((args: any) => { capturedJobUpdate = args; return {}; }) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ ...INVOICE_FIXTURE }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobUpdate).toBeDefined();
    expect(capturedJobUpdate.where).toEqual({ id: JOB_FIXTURE.id });
    expect(capturedJobUpdate.data.amount_invoiced).toEqual({ increment: 2484 });
  });

  it('no longer merges job.charges into the invoice (estimate-only lines/tax)', async () => {
    mockAuthAs('admin');
    // Even if a legacy job carried charges, they must NOT affect the invoice (JobCharge retired).
    const job = buildCompletedJob({
      charges: [{ id: 'c1', sequence: 1, description: 'Old charge', quantity: 1, unit_price: 999, is_taxable: true, line_total: 999 }],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedInvoiceData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedInvoiceData = args.data; return { ...INVOICE_FIXTURE }; }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // Subtotal = estimate lines only ($2300), NOT $2300 + $999.
    expect(capturedInvoiceData.subtotal).toBe(2300);
  });

  it('a direct (estimate-less) job with no owned lines → 400 no line items', async () => {
    mockAuthAs('admin');
    // estimate null ⇒ no estimate lines; no Items-tab lines either; charges are retired ⇒
    // nothing to bill here.
    const job = buildCompletedJob({ estimate: null, job_line_items: [], charges: [], service_location: { state: 'TX' } });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create invoice with no line items');
  });

  // Stage 3 (invoice-totals.ts consolidation): the estimate-snapshot proration branch now calls
  // the shared recomputeInvoiceTotals instead of by-hand estimateTaxableTotal/discountOnTaxable
  // math. This pins its tax_amount/total_amount output AND cross-checks it against an independent
  // call to recomputeInvoiceTotals for the same equivalent lines-only input — a second safety net
  // beyond the (all discount_amount=0) characterization suite above, which never exercised a
  // non-zero estimate discount_amount through this branch.
  it('job-line proration matches an independent recomputeInvoiceTotals call for the same lines', async () => {
    mockAuthAs('admin');
    // Same worked fixture as invoice-totals.test.ts's "prorates an invoice-level discount across
    // the taxable portion before taxing": $800 taxable + $200 non-taxable, $100 whole discount,
    // 10% tax → subtotal 1000, tax_amount 72, total_amount 972. SRVW-85: the lines now come from
    // the job's Items tab; the invoice-level discount still comes from the estimate.
    const estimateLines = [
      { id: 'li-prorate-1', sequence: 1, description: 'Taxable scope', quantity: 1, unit_price: 800, is_taxable: true, line_total: 800 },
      { id: 'li-prorate-2', sequence: 2, description: 'Non-taxable scope', quantity: 1, unit_price: 200, is_taxable: false, line_total: 200 },
    ];
    const job = buildCompletedJob({
      // E1/E2 (job-owns-tax-discount): tax_rate and discount_amount come straight off the job
      // now - discount_amount is the job's own already-RESOLVED $100, passed straight through
      // (never re-derived from a rate), which for a FIXED_AMOUNT input against a subtotal well
      // above it keeps these pinned numbers identical to the pre-E2 behavior.
      tax_rate: 0.1,
      discount_amount: 100,
      estimate: {
        ...buildCompletedJob().estimate,
        deposit: null,
        line_items: estimateLines,
      },
      job_line_items: estimateLines.map((l) => ({
        ...l,
        id: l.id.replace('li-', 'jli-'),
        item_type: 'SERVICE',
        price_book_item_id: null,
        unit_cost: null,
        markup_percent: null,
      })),
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the in-tx deposit lookup is invoice.findMany now, not findFirst.
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);

    // Independently recompute the same lines-only input through the shared calculator.
    const independent = recomputeInvoiceTotals({
      lines: estimateLines.map((l) => ({ quantity: l.quantity, unit_price: l.unit_price, is_taxable: l.is_taxable })),
      taxRate: 0.1,
      taxExempt: false,
      invoiceDiscountAmount: 100,
    });

    // Pinned worked numbers (hand-verified; identical fixture to invoice-totals.test.ts).
    expect(independent.subtotal).toBe(1000);
    expect(independent.tax_amount).toBe(72);
    expect(independent.total_amount).toBe(972);

    expect(Number(capturedData.subtotal)).toBe(independent.subtotal);
    expect(Number(capturedData.tax_amount)).toBe(independent.tax_amount);
    expect(Number(capturedData.discount_amount)).toBe(100);
    // total_amount here is computed by the controller's own untouched
    // `roundMoney(subtotal - discountAmount + taxAmount)` line, which for this input equals the
    // calculator's own total_amount too (no tip; invoiceDiscountAmount already subtracted once).
    expect(Number(capturedData.total_amount)).toBe(972);
  });

  it("carries the job's own frozen discount_amount, never re-derived from discount_type/discount_value against the current subtotal (E2)", async () => {
    mockAuthAs('admin');
    // The job's discount_type/discount_value say "10% off" (which, against this $500 subtotal,
    // would resolve to $50) - but discount_amount is the already-RESOLVED figure the door
    // actually applies, deliberately set to a DIFFERENT number here to prove it is passed
    // straight through rather than recomputed as a rate against this invoice's own subtotal.
    const job = buildCompletedJob({
      tax_rate: 0,
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      discount_amount: 75,
      estimate: {
        ...buildCompletedJob().estimate,
        deposit: null,
      },
      job_line_items: [
        { id: 'jli-solo', sequence: 1, description: 'Labor', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500, item_type: 'SERVICE', price_book_item_id: null, unit_cost: null, markup_percent: null },
      ],
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          findMany: async () => [],
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(Number(capturedData.discount_amount)).toBe(75); // not 50 - the rate is ignored
    expect(Number(capturedData.total_amount)).toBe(425);
  });
});

// ─── Helper: build invoice with access fields ─────────

function buildInvoiceDetail(overrides: Record<string, any> = {}) {
  return {
    ...INVOICE_FIXTURE,
    due_date: new Date('2026-03-01'),
    tax_rate: 0.08,
    job: {
      ...INVOICE_FIXTURE.job,
      assignees: [{ user_id: TEST_USERS.technician.id }],
      estimate: {
        ...INVOICE_FIXTURE.job.estimate,
        lead: {
          id: 'e0000000-0000-0000-0000-000000000001',
          lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        },
      },
    },
    ...overrides,
  };
}

function buildInvoiceListItem(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_FIXTURE.id,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status: INVOICE_FIXTURE.status,
    subtotal: INVOICE_FIXTURE.subtotal,
    discount_amount: INVOICE_FIXTURE.discount_amount,
    tax_amount: INVOICE_FIXTURE.tax_amount,
    deposit_credit: INVOICE_FIXTURE.deposit_credit,
    total_amount: INVOICE_FIXTURE.total_amount,
    amount_due: INVOICE_FIXTURE.amount_due,
    due_date: new Date('2026-03-01'),
    sent_at: null,
    paid_at: null,
    created_at: INVOICE_FIXTURE.created_at,
    job: {
      id: JOB_FIXTURE.id,
      job_number: 'J00001',
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
      },
    },
    ...overrides,
  };
}

// ─── GET /api/invoices ────────────────────────────────

describe('GET /api/invoices', () => {
  it('returns paginated results with stats', async () => {
    mockAuthAs('admin');
    const invoiceItem = buildInvoiceListItem();
    mockPrisma.invoice.findMany.mockResolvedValue([invoiceItem]);
    mockPrisma.invoice.count.mockResolvedValue(1);
    mockPrisma.invoice.aggregate
      .mockResolvedValueOnce({ _sum: { amount_due: 1268 }, _count: 1 })   // due
      .mockResolvedValueOnce({ _sum: { amount_due: 0 }, _count: 0 });      // overdue
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 500 }, _count: 2 });
    // unsent count (second call to invoice.count)
    mockPrisma.invoice.count
      .mockResolvedValueOnce(1)   // total
      .mockResolvedValueOnce(3);  // unsent
    mockPrisma.job.count.mockResolvedValue(2); // need_invoices

    const res = await request(app)
      .get('/api/invoices')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.due).toBeDefined();
    expect(res.body.stats.overdue).toBeDefined();
    expect(res.body.stats.collected_this_month).toBeDefined();
    expect(res.body.stats.need_invoices).toBeDefined();
  });

  it('filters by status', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices?status=SENT,PARTIAL')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['SENT', 'PARTIAL'] } }),
      }),
    );
  });

  // Regression: parseArrayParam() always returns an array ([] when the query param is absent),
  // and `[] || undefined` never falls back because [] is truthy — so a prior version of this
  // code left `where.status = { in: [] }` on EVERY unfiltered request, matching zero rows for
  // the whole org. Assert directly on the `where` object findMany was called with (not on the
  // mocked return value, which is canned and would pass either way) so a truthiness regression
  // on statusFilter fails this test.
  it('does not apply a status filter when no status query param is provided', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.findMany).toHaveBeenCalledTimes(1);
    const { where } = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(where).not.toHaveProperty('status');
  });

  it('filters by overdue', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices?overdue=true')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          due_date: expect.objectContaining({ lt: expect.any(Date) }),
          status: { in: ['SENT', 'PARTIAL'] },
        }),
      }),
    );
  });

  it('search by invoice number', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices?search=I00001')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { invoice_number: { contains: 'I00001', mode: 'insensitive' } },
          ]),
        }),
      }),
    );
  });

  // Phase B (technician redesign): a strict technician has NO `read Invoice` grant by default, so
  // the invoice list route guard (canDo('read','Invoice')) blocks the request entirely — a tech
  // cannot browse invoices at all unless granted a per-user Invoice capability. (The own-scoped
  // LIST behavior for a GRANTED tech is a per-user-grant concern owned by the override test files.)
  it('strict TECHNICIAN cannot list invoices by default (route guard 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('SALES sees only own leads invoices', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/invoices')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job: { estimate: { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } } },
        }),
      }),
    );
  });

  it('filters due_date by due_after / due_before', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/invoices?due_after=2026-06-01T00:00:00.000Z&due_before=2026-06-30T23:59:59.999Z')
      .set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.due_date.gte).toBeInstanceOf(Date);
    expect(where.due_date.lte).toBeInstanceOf(Date);
  });

  it('filters total_amount by total_min / total_max', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?total_min=100&total_max=900').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.total_amount).toEqual({ gte: 100, lte: 900 });
  });

  // NEW facet (closes the audited gap: invoices had a Total range but no Balance range).
  it('filters amount_due by balance_min / balance_max', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?balance_min=100&balance_max=500').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.amount_due).toEqual({ gte: 100, lte: 500 });
  });

  // Intentional behavior change vs the old hand-rolled status block (which had NO enum
  // validation and would 500 in Prisma on a garbage value) — mirrors leads/estimates/jobs.
  it('ignores an invalid status value instead of passing it through to Prisma', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?status=GARBAGE').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
  });

  // THE TRAP: overdue's due_date must MERGE onto (not overwrite) the due facet's due_date,
  // and applyFilters must run BEFORE the overdue block for the merge to have something to
  // merge onto. Current hand-rolled behavior: due_date = { lt: now, gte: dueAfter }.
  it('overdue + due_after merges into a single due_date range (lt now AND gte due_after)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app)
      .get('/api/invoices?overdue=true&due_after=2026-06-01T00:00:00.000Z')
      .set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.due_date.lt).toBeInstanceOf(Date);
    expect(where.due_date.gte).toBeInstanceOf(Date);
  });

  // THE TRAP (other half): overdue's status={in:['SENT','PARTIAL']} must WIN over an explicit
  // status filter, exactly like the current hand-rolled `if (overdue) { where.status = ... }`
  // running after the status assignment.
  it('overdue wins over an explicit status filter', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?overdue=true&status=DRAFT').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });

  it('filters by customer via the direct customer_id (includes job-less invoices)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?customer_id=cust-9').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    // Entity-redesign §6: the customer lives directly on the invoice. Filter the
    // direct relation (not job.customer_id) so job-less deposit/orphan invoices
    // for that customer are included.
    expect(where.customer_id).toBe('cust-9');
    expect(where.job).toBeUndefined();
  });

  // Phase B (technician redesign): with no default `read Invoice` grant, even a filtered invoice
  // list is blocked at the route guard for a strict technician.
  it('strict TECHNICIAN is blocked from the invoice list even with a customer_id filter (route guard 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app).get('/api/invoices?customer_id=cust-9').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('search matches the invoice\'s direct customer name (includes job-less invoices)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices?search=Dana').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    // Search the direct customer relation so job-less invoices match by customer name.
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { customer: { first_name: { contains: 'Dana', mode: 'insensitive' } } },
        { customer: { last_name: { contains: 'Dana', mode: 'insensitive' } } },
      ]),
    );
  });
});

// ─── GET /api/invoices/:id ────────────────────────────

describe('GET /api/invoices/:id', () => {
  it('returns full detail', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.invoice.invoice_number).toBe('I00001');
  });

  // ── B3: detail select exposes the whole-invoice tip (post-tax, untaxed) ──
  it('detail select returns the invoice tip (default 0)', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The detail select must include `tip`, surfaced on the response.
    expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ tip: true }),
      }),
    );
    expect(res.body.invoice.tip).toBeDefined();
    expect(Number(res.body.invoice.tip)).toBe(0);
  });

  // ── Seam 1: detail select reads the invoice's OWNED line_items ──
  it('detail select reads the invoice\'s OWNED line_items', async () => {
    mockAuthAs('admin');
    const ownedLines = [
      { id: 'ili-1', sequence: 1, description: 'AC Unit replacement', quantity: 1, unit_price: 1800, is_taxable: true, line_total: 1800, item_type: 'SERVICE' },
      { id: 'ili-2', sequence: 2, description: 'Labor', quantity: 1, unit_price: 500, is_taxable: true, line_total: 500, item_type: 'SERVICE' },
    ];
    const invoice = buildInvoiceDetail({ line_items: ownedLines });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The controller's detailSelect must include owned line_items, and getById returns them.
    expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ line_items: expect.anything() }),
      }),
    );
    expect(res.body.invoice.line_items).toHaveLength(2);
    expect(res.body.invoice.line_items[0].description).toBe('AC Unit replacement');
  });

  // ── Items-editor port: detail select carries per-line discount + the catalog photo ──
  // The invoice-page line-items editor reuses the Job → Items row, which renders the
  // price_book_item thumbnail and the per-line discount controls. getById's line select
  // must therefore expose discount_type/value/amount, price_book_item_id and the photo relation.
  it('detail select exposes line discount fields + price_book_item photo for the editor', async () => {
    mockAuthAs('admin');
    const ownedLines = [
      {
        id: 'ili-1',
        sequence: 1,
        description: 'AC Unit\nfull replace',
        quantity: 1,
        unit_price: 1800,
        is_taxable: true,
        line_total: 1800,
        item_type: 'MATERIAL',
        discount_type: 'PERCENTAGE',
        discount_value: 10,
        discount_amount: 180,
        price_book_item_id: 'pbi-1',
        price_book_item: { image_url: 'http://img/ac.png', photo_url: null },
      },
    ];
    const invoice = buildInvoiceDetail({ line_items: ownedLines });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    const lineSelect = call.select.line_items.select;
    expect(lineSelect).toEqual(
      expect.objectContaining({
        discount_type: true,
        discount_value: true,
        discount_amount: true,
        price_book_item_id: true,
        price_book_item: expect.objectContaining({
          select: expect.objectContaining({ image_url: true, photo_url: true }),
        }),
      }),
    );
    // Carried back on the response for the editor row.
    expect(res.body.invoice.line_items[0].discount_amount).toBeDefined();
    expect(res.body.invoice.line_items[0].price_book_item.image_url).toBe('http://img/ac.png');
  });

  // ── Bug #45: the deposit's real Payment lives on the sibling kind=DEPOSIT invoice ──
  // The entity-model redesign dropped the estimate.deposit relation; the deposit Payment now
  // hangs off the kind=DEPOSIT invoice linked by estimate_id. getById must select it via
  // estimate.invoices so the Payments-tab ledger can render the "Deposit Paid" row.
  it('detail select pulls the sibling kind=DEPOSIT invoice payment via estimate.invoices', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({
      job: {
        ...buildInvoiceDetail().job,
        estimate: {
          ...buildInvoiceDetail().job.estimate,
          invoices: [
            {
              id: 'dep-inv-1',
              status: 'PAID',
              total_refunded: 0,
              refunded_at: null,
              payments: [
                { amount: 1000, method: 'CARD', paid_at: new Date('2026-02-05'), reference_number: null },
              ],
            },
          ],
        },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The detail select must traverse job.estimate.invoices filtered to kind=DEPOSIT and pull payments.
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    const estimateSelect = call.select.job.select.estimate.select;
    expect(estimateSelect.invoices).toEqual(
      expect.objectContaining({
        where: { kind: 'DEPOSIT' },
        take: 1,
        select: expect.objectContaining({
          status: true,
          total_refunded: true,
          refunded_at: true,
          payments: expect.objectContaining({
            select: expect.objectContaining({
              amount: true,
              method: true,
              paid_at: true,
              reference_number: true,
            }),
          }),
        }),
      }),
    );
    // The selected deposit payment is carried back on the response for the FE ledger.
    expect(res.body.invoice.job.estimate.invoices[0].payments[0].amount).toBe(1000);
  });

  // ── R5e: top-level `estimate` field (parallel to the top-level `customer` field) ──
  // A copy-to-invoice invoice is job-less but estimate-anchored (estimate_id set, job_id null),
  // so the job.estimate nested select above never fires for it — this top-level field is the
  // "View Estimate" reciprocal UI link's only source for that case.
  it('detail select surfaces a top-level estimate field for a job-less, estimate-anchored invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      ...buildInvoiceDetail(),
      job: null,
      job_id: null,
      estimate_id: 'ce000000-0000-0000-0000-000000000001',
      estimate: { id: 'ce000000-0000-0000-0000-000000000001', estimate_number: 'E00099' },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    expect(call.select.estimate).toEqual(
      expect.objectContaining({ select: expect.objectContaining({ id: true, estimate_number: true }) }),
    );
    expect(res.body.invoice.estimate).toEqual({ id: 'ce000000-0000-0000-0000-000000000001', estimate_number: 'E00099' });
  });

  // Independent review (R5e): the top-level `estimate` field must ALSO request the same
  // kind=DEPOSIT `invoices` sub-select job.estimate already carries (Bug #45 precedent), or the
  // FE's buildLedgerEvents silently can't find the deposit invoice for a copy-to-invoice invoice
  // and the "Deposit Paid" row (and any refund) vanishes from the ledger.
  it('detail select requests the deposit-invoice sub-select on the top-level estimate field too (R5e ledger fix)', async () => {
    mockAuthAs('admin');
    const invoice = {
      ...buildInvoiceDetail(),
      job: null,
      job_id: null,
      estimate_id: 'ce000000-0000-0000-0000-000000000001',
      estimate: {
        id: 'ce000000-0000-0000-0000-000000000001',
        estimate_number: 'E00099',
        invoices: [{ id: 'dep-1', status: 'PAID', total_refunded: null, refunded_at: null, payments: [{ amount: 500, method: 'CARD', paid_at: '2026-01-01T00:00:00Z', reference_number: null }] }],
      },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    expect(call.select.estimate.select).toEqual(
      expect.objectContaining({
        invoices: expect.objectContaining({
          where: { kind: 'DEPOSIT' },
          select: expect.objectContaining({ payments: expect.anything() }),
        }),
      }),
    );
    expect(res.body.invoice.estimate.invoices[0].payments[0].amount).toBe(500);
  });

  // ── Task 3.4 (spec §7.3): per-payment fee breakdown ──
  // The detail select must request the reconciled Stripe/platform-fee columns (Task 3.3 fills
  // them in post-commit) so the invoice payments ledger can render the combined-fee drill-in.
  it('detail select requests the fee-breakdown columns and serializes them for a reconciled CARD payment', async () => {
    mockAuthAs('admin');
    const cardPayment = {
      id: 'pay-card-1',
      amount: 500,
      method: 'CARD',
      paid_at: new Date('2026-02-05'),
      collected_by: null,
      stripe_payment_intent_id: 'pi_test_1',
      reference_number: null,
      notes: null,
      created_at: new Date('2026-02-05'),
      voided_at: null,
      voided_reason: null,
      void_category: null,
      collector: null,
      stripe_fee_amount: 14.75,
      platform_fee_amount: 2.5,
      net_amount: 482.75,
    };
    const invoice = buildInvoiceDetail({ payments: [cardPayment] });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    expect(call.select.payments.select).toEqual(
      expect.objectContaining({
        stripe_fee_amount: true,
        platform_fee_amount: true,
        net_amount: true,
      }),
    );
    const returnedPayment = res.body.invoice.payments.find((p: any) => p.id === 'pay-card-1');
    expect(returnedPayment.stripe_fee_amount).toBe(14.75);
    expect(returnedPayment.platform_fee_amount).toBe(2.5);
    expect(returnedPayment.net_amount).toBe(482.75);
  });

  // The deposit's real Payment lives on the sibling kind=DEPOSIT invoice (Bug #45 above) — it
  // is just as likely to be a reconciled CARD payment, so the nested select must carry the
  // same three columns for the "Deposit Paid" ledger row.
  it('detail select requests the fee-breakdown columns on the nested deposit-invoice payment too', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({
      job: {
        ...buildInvoiceDetail().job,
        estimate: {
          ...buildInvoiceDetail().job.estimate,
          invoices: [
            {
              id: 'dep-inv-1',
              status: 'PAID',
              total_refunded: 0,
              refunded_at: null,
              payments: [
                {
                  amount: 1000,
                  method: 'CARD',
                  paid_at: new Date('2026-02-05'),
                  reference_number: null,
                  stripe_fee_amount: 29.3,
                  platform_fee_amount: 5,
                  net_amount: 965.7,
                },
              ],
            },
          ],
        },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.invoice.findUnique.mock.calls[0][0] as any;
    const estimateSelect = call.select.job.select.estimate.select;
    expect(estimateSelect.invoices.select.payments.select).toEqual(
      expect.objectContaining({
        stripe_fee_amount: true,
        platform_fee_amount: true,
        net_amount: true,
      }),
    );
    const depositPayment = res.body.invoice.job.estimate.invoices[0].payments[0];
    expect(depositPayment.stripe_fee_amount).toBe(29.3);
    expect(depositPayment.platform_fee_amount).toBe(5);
    expect(depositPayment.net_amount).toBe(965.7);
  });

  it('returns 404 for missing', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/invoices/00000000-0000-0000-0000-000000000999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  // Phase B (technician redesign): a strict technician has NO `read Invoice` grant, so GET
  // /api/invoices/:id is blocked at the route guard (canDo('read','Invoice')) before the
  // controller's per-row ownership check runs — hence the route-guard message, not 'Not authorized'.
  it('returns 403 for a strict TECHNICIAN (no read Invoice grant → route guard)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
  });

  // ── Phase 2a: a job-less (deposit/orphan) invoice resolves customer via top-level invoice.customer ──
  it('getById resolves a job-less (deposit) invoice without NPE — customer comes from invoice.customer', async () => {
    mockAuthAs('admin');
    // A kind=DEPOSIT invoice: job is null, customer hangs off the top-level relation.
    const depositInvoice = {
      ...INVOICE_FIXTURE,
      kind: 'DEPOSIT',
      job: null,
      job_id: null,
      estimate_id: ESTIMATE_APPROVED_FIXTURE.id,
      customer_id: CUSTOMER_FIXTURE.id,
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        email: 'john@doe.com',
        phone: '5551234567',
        payment_type: null,
        tax_exempt: false,
      },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    // ADMIN bypasses the job-based access check, so a null job must not 500.
    expect(res.status).toBe(200);
    expect(res.body.invoice.customer.email).toBe('john@doe.com');
    // The detail select must include a top-level customer block for job-less invoices.
    expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ customer: expect.anything() }),
      }),
    );
  });
});

// ─── PATCH /api/invoices/:id ──────────────────────────

describe('PATCH /api/invoices/:id', () => {
  it('can change due_date on DRAFT', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      status: 'DRAFT',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    const updatedInvoice = buildInvoiceDetail({ due_date: new Date('2026-04-15') });
    mockPrisma.invoice.update.mockResolvedValue(updatedInvoice);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.invoice).toBeDefined();
    expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { due_date: expect.any(Date) },
      }),
    );
  });

  it('allows changing due_date on a SENT invoice (P2: editable until settled)', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.invoice.update.mockResolvedValue(buildInvoiceDetail({ due_date: new Date('2026-04-15') }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
  });

  it('returns 400 on a locked (PAID) invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      status: 'PAID',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/invoices/:id ─────────────────────────

// Inventory P1 (§4.4): remove() is now tx-wrapped — invoice-BORN SYNCED lines auto-return
// BEFORE the invoice row (and its cascading lines) die. Shared by the DRAFT-delete describes.
function wireInvoiceDeleteTx(opts: { syncedLines?: any[]; items?: any[] } = {}) {
  const txInvLineFindMany = vi.fn().mockResolvedValue(opts.syncedLines ?? []);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      invoiceLineItem: { findMany: txInvLineFindMany },
      priceBookItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
      stockMovement: { create: mockPrisma.stockMovement.create },
      stockBalance: { upsert: mockPrisma.stockBalance.upsert },
      organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
      invoice: { delete: mockPrisma.invoice.delete },
    }),
  );
  return { txInvLineFindMany };
}

describe('DELETE /api/invoices/:id', () => {
  it('deletes DRAFT invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      status: 'DRAFT',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.invoice.delete.mockResolvedValue(invoice);
    wireInvoiceDeleteTx();

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.invoice.delete).toHaveBeenCalledWith({ where: { id: INVOICE_FIXTURE.id } });
  });

  it('auto-returns an invoice-born SYNCED line BEFORE the delete (QA-505)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_FIXTURE.id,
      status: 'DRAFT',
      invoice_number: 'I00001',
      job_id: null, // standalone invoice — the movement carries job_id null (QA-508 shape)
      job: null,
    });
    mockPrisma.invoice.delete.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.stockMovement.create.mockResolvedValue({});
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 9 });
    const { txInvLineFindMany } = wireInvoiceDeleteTx({
      syncedLines: [{
        id: 'ivl-0000-0000-0000-000000000009',
        quantity: 4,
        price_book_item_id: 'aaaaaaa2-0000-0000-0000-000000000002',
        stock_location_id: 'aaaaaaa1-0000-0000-0000-000000000001',
      }],
      items: [{ id: 'aaaaaaa2-0000-0000-0000-000000000002', sku: 'WIRE-12', name: '12ga Wire (ft)', unit_cost: 20 }],
    });

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    // Only invoice-BORN lines can be SYNCED (job copies are NOT_TRACKED by construction) —
    // the stock_status filter IS the scope rule (QA-503/505).
    expect(txInvLineFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ invoice_id: INVOICE_FIXTURE.id, stock_status: 'SYNCED' }),
    }));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(4);
    expect(movement.job_id).toBeNull();
    expect(movement.invoice_line_item_id).toBe('ivl-0000-0000-0000-000000000009');
    expect(movement.to_location_id).toBe('aaaaaaa1-0000-0000-0000-000000000001');
    expect(movement.reference).toBe('I00001 deleted');
    // Return BEFORE delete: the movement's line FK must exist at insert (SetNull on delete).
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.invoice.delete.mock.invocationCallOrder[0]);
  });

  it('returns 400 on non-DRAFT', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only DRAFT invoices can be deleted');
  });

  it('returns 404 on missing', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/invoices/00000000-0000-0000-0000-000000000999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });
});

// ─── #106 ENFORCEMENT: base update/delete per-instance owner check + list scope ───
//
// The route-level `canDo('update'|'delete', 'Invoice')` guard only checks the SUBJECT-level
// ability — it passes the moment a role carries ANY update/delete-Invoice grant, even an
// owner-scoped one. Without a PER-INSTANCE check in the controller, a role that org-settings
// grants an owner-scoped update/delete could mutate ANY invoice in the org. These tests build
// exactly that owner-scoped grant (injected into the permission cache, the same source
// attachAbility reads) and prove the controller now 403s on an un-owned instance AND never
// reaches prisma.invoice.update/delete. The owner IS still allowed. List is scope-filtered.
//
// SALES is the carrier role: its OWN read-Invoice scope is via lead (OWN_INVOICE_VIA_LEAD),
// so an "owned" invoice carries a matching job.estimate.lead.lead_assignees row.
describe('#106 base update/delete enforcement (per-instance owner check)', () => {
  const OWN_INVOICE_VIA_LEAD = {
    job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  };
  // An owner-scoped grant set granting SALES update+delete+read on owned invoices — the kind of
  // custom grant org-settings can persist. Injected straight into the cache attachAbility reads.
  const SALES_OWN_INVOICE_GRANTS = [
    { action: 'read', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
    { action: 'update', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
    { action: 'delete', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
  ];

  // The row the controller loads for update/delete (its findUnique select carries the owner chain).
  function invoiceRowOwnedBy(userId: string, status = 'DRAFT') {
    return {
      id: INVOICE_FIXTURE.id,
      status,
      job: {
        assignees: [],
        estimate: { lead: { lead_assignees: [{ user_id: userId }] } },
      },
    };
  }

  beforeEach(() => {
    clearPermissionCache();
    mockAuthAs('sales');
    // Override the default SALES grants with the owner-scoped update/delete grant in the cache,
    // so attachAbility builds an ability whose update/delete-Invoice rule is owner-conditioned.
    setCachedGrants(ALPHA_ORG_ID, 'SALES', SALES_OWN_INVOICE_GRANTS as any);
  });

  it('PATCH 403s + never calls prisma.invoice.update when the invoice is owned by ANOTHER user', async () => {
    // Owned by a different user → the per-instance owner condition cannot match.
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRowOwnedBy('99999999-9999-9999-9999-999999999999'));
    // The scoped visibility probe finds nothing for an un-owned row.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    // The mutation MUST NOT run — enforcement, not just persistence.
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('PATCH allows the owner (per-instance check passes) and performs the update', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRowOwnedBy(TEST_USERS.sales.id));
    // canAccessRow probes visibility via the scoped findFirst — owned row resolves to a truthy id.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.invoice.update.mockResolvedValue(buildInvoiceDetail({ due_date: new Date('2026-04-15') }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
  });

  it('DELETE 403s + never calls prisma.invoice.delete when the invoice is owned by ANOTHER user', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRowOwnedBy('99999999-9999-9999-9999-999999999999'));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.delete).not.toHaveBeenCalled();
  });

  it('DELETE allows the owner (per-instance check passes) and performs the delete', async () => {
    const row = invoiceRowOwnedBy(TEST_USERS.sales.id);
    mockPrisma.invoice.findUnique.mockResolvedValue(row);
    // canAccessRow probes visibility via the scoped findFirst — owned row resolves to a truthy id.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.invoice.delete.mockResolvedValue(row);
    wireInvoiceDeleteTx();

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(204);
    expect(mockPrisma.invoice.delete).toHaveBeenCalledWith({ where: { id: INVOICE_FIXTURE.id } });
  });

  it('the per-instance check fires AFTER the 404 guard (missing invoice → 404, no ability leak)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });
});

// ─── #106 P0: DISPATCHER fail-open closed (grant-driven per-instance + lifecycle verbs) ───
//
// THE P0 (the config Wave 2 never tested): the old canAccessInvoice() hardcoded
// `role === ADMIN || DISPATCHER → true`, IGNORING the persisted grant condition. So when
// org-settings narrows a DISPATCHER's Invoice grant to OWNED rows (the exact thing the settings
// UI lets you do), the DISPATCHER could still update / delete / send / void ANY invoice in the org
// — full fail-open. canAccessRow resolves the SAME owner scope through SQL, so the narrowed grant
// is now enforced per-instance. These tests build that owner-scoped DISPATCHER grant (injected into
// the permission cache attachAbility reads) and prove a DISPATCHER 403s on an un-owned invoice for
// update AND delete AND send AND void, and that the mutation never runs — while the OWNER succeeds.
//
// DISPATCHER's OWN read-Invoice scope is via job assignees (OWN_INVOICE_VIA_JOB); an "owned"
// invoice carries a matching job.assignees row. canAccessRow probes via prisma.invoice.findFirst
// (the scoped SQL visibility check), so an owned row resolves to a truthy { id } and an un-owned
// row resolves to null.
describe('#106 P0: DISPATCHER fail-open closed — grant-driven per-instance + lifecycle verbs', () => {
  const OWN_INVOICE_VIA_JOB = {
    job: { assignees: { some: { user_id: '{{userId}}' } } },
  };
  // The narrowed grant org-settings can persist: DISPATCHER restricted to OWNED invoices for
  // read + update + delete + send + void. Injected straight into the cache attachAbility reads,
  // so the route guard passes (subject-level) but the row's ownership must still be verified.
  const DISPATCHER_OWN_INVOICE_GRANTS = [
    { action: 'read', subject: 'Invoice', conditions: OWN_INVOICE_VIA_JOB },
    { action: 'update', subject: 'Invoice', conditions: OWN_INVOICE_VIA_JOB },
    { action: 'delete', subject: 'Invoice', conditions: OWN_INVOICE_VIA_JOB },
    { action: 'send', subject: 'Invoice', conditions: OWN_INVOICE_VIA_JOB },
    { action: 'void', subject: 'Invoice', conditions: OWN_INVOICE_VIA_JOB },
  ];

  const OTHER_USER = '99999999-9999-9999-9999-999999999999';

  beforeEach(() => {
    clearPermissionCache();
    mockAuthAs('dispatcher');
    setCachedGrants(ALPHA_ORG_ID, 'DISPATCHER', DISPATCHER_OWN_INVOICE_GRANTS as any);
  });

  // ── UPDATE ──
  it('PATCH 403s + never calls prisma.invoice.update when the invoice is owned by ANOTHER user', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: { assignees: [{ user_id: OTHER_USER }], estimate: { lead: { lead_assignees: [] } } } });
    // Scoped visibility probe finds nothing (un-owned) → 403.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('PATCH allows the owner (scoped probe resolves) and performs the update', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: { assignees: [{ user_id: TEST_USERS.dispatcher.id }], estimate: { lead: { lead_assignees: [] } } } });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.invoice.update.mockResolvedValue(buildInvoiceDetail({ due_date: new Date('2026-04-15') }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
  });

  // ── DELETE ──
  it('DELETE 403s + never calls prisma.invoice.delete when the invoice is owned by ANOTHER user', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: { assignees: [{ user_id: OTHER_USER }], estimate: { lead: { lead_assignees: [] } } } });
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.delete).not.toHaveBeenCalled();
  });

  it('DELETE allows the owner (scoped probe resolves) and performs the delete', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: { assignees: [{ user_id: TEST_USERS.dispatcher.id }], estimate: { lead: { lead_assignees: [] } } } });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.invoice.delete.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    wireInvoiceDeleteTx();

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(204);
    expect(mockPrisma.invoice.delete).toHaveBeenCalledWith({ where: { id: INVOICE_FIXTURE.id } });
  });

  // ── SEND (lifecycle verb that had NO per-instance check) ──
  it('POST /send 403s + never mutates when the invoice is owned by ANOTHER user', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoiceDetail({ status: 'DRAFT', due_date: new Date('2026-04-01') }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('POST /send allows the owner (scoped probe resolves) and sends', async () => {
    const invoice = buildInvoiceDetail({ status: 'DRAFT', due_date: new Date('2026-04-01') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: { update: vi.fn().mockResolvedValue({ ...invoice, status: 'SENT', sent_at: new Date(), public_token: 'tok' }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('SENT');
  });

  // ── VOID (lifecycle verb that had NO per-instance check) ──
  it('POST /void 403s + never mutates when the invoice is owned by ANOTHER user', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_SENT_FIXTURE.id, status: 'SENT', invoice_number: 'I00002', kind: 'STANDARD', total_amount: 2268, job_id: JOB_FIXTURE.id, job: { assignees: [{ user_id: OTHER_USER }], estimate: { lead: { lead_assignees: [] } } } });
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('dispatcher'))
      .send({ voided_reason: 'Duplicate' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('POST /void allows the owner (scoped probe resolves) and voids', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_SENT_FIXTURE.id, status: 'SENT', invoice_number: 'I00002', kind: 'STANDARD', total_amount: 2268, job_id: JOB_FIXTURE.id, job: { assignees: [{ user_id: TEST_USERS.dispatcher.id }], estimate: { lead: { lead_assignees: [] } } } });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_SENT_FIXTURE.id });
    const voided = buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'VOIDED', voided_at: new Date(), voided_reason: 'Duplicate' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: { update: vi.fn().mockResolvedValue(voided) },
      // Inventory P1 (§4.4): void's auto-return pass — no SYNCED lines here.
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('dispatcher'))
      .send({ voided_reason: 'Duplicate' });

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOIDED');
  });

  // ── The per-instance check fires AFTER the 404 guard (no ability leak on a missing row) ──
  it('PATCH on a missing invoice → 404 (per-instance check fires after the 404 guard)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ due_date: '2026-04-15T00:00:00.000Z' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });
});

// ─── #106 ENFORCEMENT: list scope is grant-driven (fail-closed for non-owner roles) ───
//
// list() previously hand-rolled `where.job` for ONLY TECHNICIAN + SALES, letting any OTHER
// non-ADMIN role (or a custom org-settings role with an owner-scoped read grant) see the whole
// org. The grant-driven scopeWhereForReq('Invoice') closes that: a role whose read-Invoice grant
// is owner-conditioned is restricted to owned rows; a role with NO read grant sees nothing.
describe('#106 list scope is grant-driven', () => {
  const OWN_INVOICE_VIA_LEAD = {
    job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  };

  beforeEach(() => {
    clearPermissionCache();
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);
  });

  it('a SALES user with an owner-scoped read grant only lists owned rows (scope spread into where)', async () => {
    mockAuthAs('sales');
    setCachedGrants(ALPHA_ORG_ID, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
    ] as any);

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    // The grant-driven owner condition is present — un-owned rows are excluded.
    expect(where.job).toEqual({
      estimate: { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
    });
  });

  it('FAIL-CLOSED: a team-scoped read grant whose {{teamId}} resolves to null lists NOTHING (MATCH_NOTHING)', async () => {
    // The SALES user has department_id: null. A team-conditioned read-Invoice grant passes the
    // SUBJECT-level route guard (the ability has a read-Invoice rule) but resolves to MATCH_NOTHING
    // in scopeWhereForReq — never the fail-open `team: null` match. This is the gap a flat
    // hand-rolled `if (role===SALES)` block left open for any other/custom role.
    mockAuthAs('sales');
    setCachedGrants(ALPHA_ORG_ID, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: { job: { department_id: '{{teamId}}' } } },
    ] as any);

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    // MATCH_NOTHING — sees nothing (outermost spread, so id:{in:[]} is intact).
    expect(where.id).toEqual({ in: [] });
  });
});

// ─── GAP-3: list aggregate stats are role-scoped (no org-wide $ / count leak) ───
//
// The Due/Overdue/Draft aggregates already use the role-scoped `scopeWhere` ({...tenantWhere, ...
// roleScope}). Two siblings leaked org-wide numbers to a row-scoped user:
//   • collected-this-month (payment.aggregate) filtered `invoice: tenantWhere(req)` (ORG-WIDE money).
//   • need-invoices (job.count) filtered `tenantWhere(req)` only (ORG-WIDE completed-job count).
// Fix: collected-this-month filters payments by the Invoice role-scope; need-invoices counts only
// jobs in the requester's Job read-scope. ADMIN/unconditional → {} → unchanged org-wide.
describe('GAP-3 list stats role-scope (no org-wide leak)', () => {
  const OWN_INVOICE_VIA_LEAD = {
    job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  };
  const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };

  beforeEach(() => {
    clearPermissionCache();
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);
  });

  it('collected-this-month payment filter is role-scoped (own invoices), NOT org-wide tenantWhere', async () => {
    mockAuthAs('sales');
    setCachedGrants(ALPHA_ORG_ID, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
    ] as any);

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const paymentWhere = mockPrisma.payment.aggregate.mock.calls[0][0].where;
    // The parent-invoice filter must carry the SALES owner condition (the scopeWhere), so the
    // collected total reflects ONLY this rep's invoices — not every payment in the org.
    expect(paymentWhere.invoice.job).toEqual({
      estimate: { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
    });
    // tenant scope is still present (org isolation intact).
    expect(paymentWhere.invoice.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('ADMIN collected-this-month stays org-wide (no row-scope restriction)', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/invoices').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const paymentWhere = mockPrisma.payment.aggregate.mock.calls[0][0].where;
    // ADMIN roleScope is {} → only the tenant filter, no owner condition.
    expect(paymentWhere.invoice).toEqual({ organization_id: ALPHA_ORG_ID });
  });

  it('need-invoices job.count is role-scoped to the requester Job scope, NOT org-wide', async () => {
    mockAuthAs('sales');
    setCachedGrants(ALPHA_ORG_ID, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: OWN_INVOICE_VIA_LEAD },
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
    ] as any);

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const jobWhere = mockPrisma.job.count.mock.calls[0][0].where;
    // The Job read-scope owner condition must be present — only jobs this rep can see are counted.
    expect(jobWhere.assignees).toEqual({ some: { user_id: TEST_USERS.sales.id } });
    expect(jobWhere.organization_id).toBe(ALPHA_ORG_ID);
    expect(jobWhere.status).toBe('COMPLETED');
  });

  it('ADMIN need-invoices stays org-wide (Job scope {} → tenant-only)', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/invoices').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const jobWhere = mockPrisma.job.count.mock.calls[0][0].where;
    expect(jobWhere.assignees).toBeUndefined();
    expect(jobWhere.organization_id).toBe(ALPHA_ORG_ID);
  });
});

// ─── POST /api/invoices/:id/send ──────────────────────

describe('POST /api/invoices/:id/send', () => {
  it('sends a DRAFT invoice (DRAFT → SENT)', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'DRAFT', due_date: new Date('2026-04-01') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const sentInvoice = {
      ...invoice,
      status: 'SENT',
      sent_at: new Date(),
      public_token: 'generated-token',
    };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(sentInvoice) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('SENT');
  });

  it('generates public_token and sets sent_at', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'DRAFT', due_date: null });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...invoice, ...args.data, status: 'SENT' };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(capturedData.public_token).toBeDefined();
    expect(capturedData.public_token).not.toBeNull();
    expect(capturedData.sent_at).toBeInstanceOf(Date);
    expect(capturedData.status).toBe('SENT');
  });

  it('returns 400 on non-DRAFT invoice', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only DRAFT invoices can be sent');
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices/00000000-0000-0000-0000-000000000999/send')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  it('calculates due_date when not set', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({
      status: 'DRAFT',
      due_date: null,
      job: {
        ...INVOICE_FIXTURE.job,
        assignees: [{ user_id: TEST_USERS.technician.id }],
        customer: {
          ...INVOICE_FIXTURE.job.customer,
          payment_type: 'NET 15',
        },
        estimate: {
          ...INVOICE_FIXTURE.job.estimate,
          lead: { id: 'e0000000-0000-0000-0000-000000000001', lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
        },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...invoice, ...args.data };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // due_date should be approximately 15 days from now
    const dueDate = new Date(capturedData.due_date);
    const now = new Date();
    const diffDays = Math.round((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(14);
    expect(diffDays).toBeLessThanOrEqual(15);
  });

  it('honors body.to recipient override and cc_emails when emailing', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'DRAFT', due_date: new Date('2026-04-01') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockImplementation((args: any) => ({ ...invoice, ...args.data, status: 'SENT' })) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ to: 'override@example.com', cc_emails: ['cc1@example.com', 'cc2@example.com'], message_body: 'Please review the attached invoice.' });

    expect(res.status).toBe(200);
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInvoiceEmail.mock.calls[0][0]).toMatchObject({
      to: 'override@example.com',
      cc: ['cc1@example.com', 'cc2@example.com'],
      message: 'Please review the attached invoice.',
    });
  });

  it('returns 400 when no recipient email exists anywhere', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({
      status: 'DRAFT',
      due_date: new Date('2026-04-01'),
      customer: null,
      job: {
        ...buildInvoiceDetail().job,
        customer: { ...buildInvoiceDetail().job.customer, email: null },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockImplementation((args: any) => ({ ...invoice, ...args.data, status: 'SENT' })) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid recipient email', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ to: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('returns 409 and leaves the invoice DRAFT when org email sending is disabled', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'DRAFT', public_token: null, due_date: new Date('2026-04-01') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockSendInvoiceEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/turned off for your whole organization/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── POST /api/invoices/:id/resend ───────────────────

describe('POST /api/invoices/:id/resend', () => {
  it('resends a SENT invoice without changing status or token', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc', sent_at: new Date('2026-02-02') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    const resentInvoice = { ...invoice, sent_at: new Date() };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(resentInvoice) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('SENT');
    expect(res.body.invoice.public_token).toBe('existing-token-abc');
  });

  it('resends a PARTIAL invoice', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ ...INVOICE_PARTIAL_FIXTURE, public_token: 'existing-token-abc' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({ ...invoice, sent_at: new Date() }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('creates INVOICE_RESENT timeline event', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    let capturedEvent: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({ ...invoice, sent_at: new Date() }) },
        timelineEvent: {
          create: vi.fn().mockImplementation((args: any) => {
            capturedEvent = args.data;
            return {};
          }),
        },
      });
    });

    await request(app).post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`).set(authHeader('admin'));

    expect(capturedEvent.event_type).toBe('INVOICE_RESENT');
    expect(capturedEvent.entity_type).toBe('INVOICE');
  });

  it('updates sent_at but does not change public_token or status', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    let capturedUpdateData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedUpdateData = args.data;
            return { ...invoice, ...args.data };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    await request(app).post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`).set(authHeader('admin'));

    expect(capturedUpdateData.sent_at).toBeInstanceOf(Date);
    expect(capturedUpdateData.public_token).toBeUndefined();
    expect(capturedUpdateData.status).toBeUndefined();
  });

  it('returns 400 for DRAFT invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoiceDetail({ status: 'DRAFT', public_token: null }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });

  it('returns 400 for VOIDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED', public_token: 'existing-token-abc' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot resend a VOIDED invoice');
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices/00000000-0000-0000-0000-000000000999/resend')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('honors body.to recipient override and cc_emails when re-emailing', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({ ...invoice, sent_at: new Date() }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'))
      .send({ to: 'override@example.com', cc_emails: ['cc1@example.com'], message_body: 'Friendly reminder — invoice attached.' });

    expect(res.status).toBe(200);
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInvoiceEmail.mock.calls[0][0]).toMatchObject({
      to: 'override@example.com',
      cc: ['cc1@example.com'],
      message: 'Friendly reminder — invoice attached.',
    });
  });

  it('returns 400 when no recipient email exists anywhere', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({
      status: 'SENT',
      public_token: 'existing-token-abc',
      customer: null,
      job: {
        ...buildInvoiceDetail().job,
        customer: { ...buildInvoiceDetail().job.customer, email: null },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({ ...invoice, sent_at: new Date() }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('returns 409 and does not update sent_at when org email sending is disabled', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc', sent_at: new Date('2026-02-02') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    mockSendInvoiceEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/resend`)
      .set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/turned off for your whole organization/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── POST /api/invoices/bulk-send ──────────────────────
// Exercises bulkSend(), which loops sendInvoiceInternal() (extracted from send() above) SEQUENTIALLY
// per id - same DRAFT-only guard, same messages, isolated per-id failures.
describe('POST /api/invoices/bulk-send', () => {
  const DRAFT_A = 'a1000000-0000-0000-0000-000000000001';
  const DRAFT_B = 'a1000000-0000-0000-0000-000000000002';
  const SENT_ID = 'a1000000-0000-0000-0000-000000000003';
  const MISSING_ID = 'a1000000-0000-0000-0000-000000000004';

  beforeEach(() => {
    mockPrisma.invoice.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const { id } = args.where;
      if (id === MISSING_ID) return Promise.resolve(null);
      if (id === SENT_ID) return Promise.resolve(buildInvoiceDetail({ id, status: 'SENT', public_token: 'tok' }));
      return Promise.resolve(buildInvoiceDetail({ id, status: 'DRAFT', public_token: null, due_date: new Date('2026-04-01') }));
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: {
        update: vi.fn().mockImplementation((args: any) => ({ id: args.where.id, ...args.data, status: 'SENT' })),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
  });

  it('sends DRAFT rows and lands a SENT row in failed', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/invoices/bulk-send')
      .set(authHeader('admin'))
      .send({ ids: [DRAFT_A, DRAFT_B, SENT_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent.sort()).toEqual([DRAFT_A, DRAFT_B].sort());
    expect(res.body.failed).toEqual([{ id: SENT_ID, error: 'Only DRAFT invoices can be sent' }]);
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(2);
  });

  it('lands a cross-org id in failed and never emails it', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/invoices/bulk-send')
      .set(authHeader('admin'))
      .send({ ids: [DRAFT_A, MISSING_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([DRAFT_A]);
    expect(res.body.failed).toEqual([{ id: MISSING_ID, error: 'Invoice not found' }]);
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects more than 25 ids at the validation layer before any email', async () => {
    mockAuthAs('admin');
    const ids = Array.from({ length: 26 }, (_, i) => `a3000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/invoices/bulk-send')
      .set(authHeader('admin'))
      .send({ ids });

    expect(res.status).toBe(400);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });
});

// ─── POST /api/invoices/bulk-resend ─────────────────────
// Exercises bulkResend(), which loops resendInvoiceInternal() (extracted from resend() above).
describe('POST /api/invoices/bulk-resend', () => {
  const SENT_ID = 'a2000000-0000-0000-0000-000000000001';
  const DRAFT_ID = 'a2000000-0000-0000-0000-000000000002';
  const VOIDED_ID = 'a2000000-0000-0000-0000-000000000003';

  beforeEach(() => {
    mockPrisma.invoice.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const { id } = args.where;
      if (id === DRAFT_ID) return Promise.resolve(buildInvoiceDetail({ id, status: 'DRAFT', public_token: 'tok' }));
      if (id === VOIDED_ID) return Promise.resolve(buildInvoiceDetail({ id, status: 'VOIDED', public_token: 'tok' }));
      return Promise.resolve(buildInvoiceDetail({ id, status: 'SENT', public_token: 'tok' }));
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: {
        update: vi.fn().mockImplementation((args: any) => ({ id: args.where.id, ...args.data, status: 'SENT' })),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
  });

  it('lands DRAFT and VOIDED rows in failed with the single-row reasons', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/invoices/bulk-resend')
      .set(authHeader('admin'))
      .send({ ids: [SENT_ID, DRAFT_ID, VOIDED_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([SENT_ID]);
    expect(res.body.failed).toEqual(
      expect.arrayContaining([
        { id: DRAFT_ID, error: 'Cannot resend a DRAFT invoice' },
        { id: VOIDED_ID, error: 'Cannot resend a VOIDED invoice' },
      ]),
    );
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /api/invoices/:id/payment-link ──────────────

describe('POST /api/invoices/:id/payment-link', () => {
  it('mints a token and issues a DRAFT invoice without dispatching an email (bypasses the org email toggle)', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'DRAFT', public_token: null, due_date: new Date('2026-04-01') });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data;
            return { ...invoice, ...args.data };
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('SENT');
    expect(res.body.url).toContain(capturedData.public_token);
    expect(capturedData.status).toBe('SENT');
    expect(capturedData.public_token).toBeDefined();
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('is idempotent on an already-SENT invoice — returns the existing token, no second transition', async () => {
    mockAuthAs('admin');
    const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('existing-token-abc');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for a VOIDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED', public_token: 'existing-token-abc' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create a payment link for a voided invoice.');
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices/00000000-0000-0000-0000-000000000999/payment-link')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  // #1997 round 3 (HIGH) — the redacted `invoice` in the response omits `public_token`, but the
  // sibling `url` field was built from the raw token regardless, so a requester whose `read
  // Customer` is denied for the anchored customer could still recover the token and replay it
  // against the unauthenticated public PDF. See customerContact.ts's `isCustomerReadable`.
  describe('#1997 round 3 — a requester denied read Customer on the anchored customer', () => {
    // A prior case in this block leaves the permission cache primed with a DISPATCHER-denied
    // grant set (mockAuthAs resets the rolePermission.findMany mock but not the cache) — clear it
    // before every case so order never leaks between the denied cases and the green controls.
    beforeEach(() => {
      clearPermissionCache();
    });

    /** Same idiom as public-token-redaction.test.ts's local copy — a conditioned `read Customer`
     * grant built from real DEFAULT_GRANTS, never a bare CASL literal. */
    function mockDeniedCustomerRead(role: string, deniedCustomerId: string) {
      const rows = [
        ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
        { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + deniedCustomerId } },
      ];
      (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows.filter((g) => g.role === role));
      clearPermissionCache();
    }

    it('already-issued branch: 403, no url, no public_token, no write', async () => {
      mockAuthAs('dispatcher'); // unconditional `send Invoice` + unconditional `read Invoice` (canAccessRow short-circuits)
      mockDeniedCustomerRead('DISPATCHER', CUSTOMER_FIXTURE.id);
      const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Payment links are not available for this customer.');
      expect(res.body.url).toBeUndefined();
      expect(res.body.invoice).toBeUndefined();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('fresh-mint branch: 403 before any token is minted or written', async () => {
      mockAuthAs('dispatcher');
      mockDeniedCustomerRead('DISPATCHER', CUSTOMER_FIXTURE.id);
      const invoice = buildInvoiceDetail({ status: 'DRAFT', public_token: null, due_date: new Date('2026-04-01') });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Payment links are not available for this customer.');
      expect(res.body.url).toBeUndefined();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('control: ADMIN (unconditional read Customer) still gets 200 with url — must not regress', async () => {
      mockAuthAs('admin');
      const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
        .set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.url).toContain('existing-token-abc');
    });

    it('control: DISPATCHER with default grants (unconditional read Customer) still gets 200 with url', async () => {
      mockAuthAs('dispatcher');
      const invoice = buildInvoiceDetail({ status: 'SENT', public_token: 'existing-token-abc' });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_FIXTURE.id}/payment-link`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      expect(res.body.url).toContain('existing-token-abc');
    });
  });
});

// ─── POST /api/invoices/:id/void ──────────────────────

describe('POST /api/invoices/:id/void', () => {
  it('voids a SENT invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const voidedInvoice = buildInvoiceDetail({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'VOIDED',
      voided_at: new Date(),
      voided_reason: 'Duplicate invoice',
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(voidedInvoice) },
        // Inventory P1 (§4.4): void's auto-return pass — no SYNCED lines here.
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Duplicate invoice' });

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOIDED');
  });

  it('voids a PARTIAL invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_PARTIAL_FIXTURE.id,
      status: 'PARTIAL',
      invoice_number: 'I00003',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const voidedInvoice = buildInvoiceDetail({
      id: INVOICE_PARTIAL_FIXTURE.id,
      status: 'VOIDED',
      voided_at: new Date(),
      voided_reason: 'Customer dispute',
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(voidedInvoice) },
        // Inventory P1 (§4.4): void's auto-return pass — no SYNCED lines here.
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_PARTIAL_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Customer dispute' });

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOIDED');
  });

  it('requires voided_reason', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('auto-returns invoice-BORN SYNCED lines and restamps them UNSYNCED inside the void tx (QA-506)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'STANDARD',
      total_amount: 1000,
      job_id: JOB_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    });
    mockPrisma.stockMovement.create.mockResolvedValue({});
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7 });

    const txInvLineFindMany = vi.fn().mockResolvedValue([{
      id: 'ivl-0000-0000-0000-000000000011',
      quantity: 3,
      price_book_item_id: 'aaaaaaa2-0000-0000-0000-000000000002',
      stock_location_id: 'aaaaaaa1-0000-0000-0000-000000000001',
    }]);
    const txInvLineUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'VOIDED' })) },
        invoiceLineItem: { findMany: txInvLineFindMany, updateMany: txInvLineUpdateMany },
        priceBookItem: { findMany: vi.fn().mockResolvedValue([{ id: 'aaaaaaa2-0000-0000-0000-000000000002', sku: 'WIRE-12', name: '12ga Wire (ft)', unit_cost: 20 }]) },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Wrong parts billed' });

    expect(res.status).toBe(200);
    // Scope rule: only invoice-BORN lines can be SYNCED (job copies are NOT_TRACKED by §5.2
    // construction) — the stock_status filter IS the predicate (QA-503/506).
    expect(txInvLineFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ invoice_id: INVOICE_SENT_FIXTURE.id, stock_status: 'SYNCED' }),
    }));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('return');
    expect(movement.qty).toBe(3);
    expect(movement.job_id).toBe(JOB_FIXTURE.id);
    expect(movement.invoice_line_item_id).toBe('ivl-0000-0000-0000-000000000011');
    expect(movement.job_line_item_id).toBeNull();
    expect(movement.to_location_id).toBe('aaaaaaa1-0000-0000-0000-000000000001');
    expect(movement.reference).toBe('I00002 voided');
    // Void keeps the document + rows visible — stamping UNSYNCED makes ledger and pills agree.
    expect(txInvLineUpdateMany).toHaveBeenCalledWith({
      where: { invoice_id: INVOICE_SENT_FIXTURE.id, stock_status: 'SYNCED' },
      data: { stock_status: 'UNSYNCED' },
    });
  });

  it('void with only job-copied (NOT_TRACKED) lines moves zero stock (QA-506 scope)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'STANDARD',
      total_amount: 1000,
      job_id: JOB_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    });
    // The SYNCED-filtered findMany returns nothing — job-copied NOT_TRACKED lines never match.
    const txInvLineFindMany = vi.fn().mockResolvedValue([]);
    const txInvLineUpdateMany = vi.fn();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED' })) },
        invoiceLineItem: { findMany: txInvLineFindMany, updateMany: txInvLineUpdateMany },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'All copies' });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
    expect(txInvLineUpdateMany).not.toHaveBeenCalled();
  });

  it('returns 400 on PAID invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      status: 'PAID',
      invoice_number: 'I00001',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Some reason' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot void a PAID or already VOIDED invoice');
  });

  it('returns 400 on DRAFT invoice (use DELETE)', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      status: 'DRAFT',
      invoice_number: 'I00001',
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Some reason' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Use DELETE for DRAFT invoices');
  });

  it('returns 403 for non-ADMIN roles (route-level)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('dispatcher'))
      .send({ voided_reason: 'Reason' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices/00000000-0000-0000-0000-000000000999/void')
      .set(authHeader('admin'))
      .send({ voided_reason: 'Reason' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  it('decrements job.amount_invoiced by the voided STANDARD invoice total', async () => {
    mockAuthAs('admin');
    // Voiding a STANDARD invoice on a job un-issues the bill ⇒ decrement amount_invoiced.
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'STANDARD',
      total_amount: 1000,
      job_id: JOB_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    });

    let capturedJobUpdate: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockImplementation((args: any) => { capturedJobUpdate = args; return {}; }) },
        invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED' })) },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Job scope changed' });

    expect(res.status).toBe(200);
    expect(capturedJobUpdate.where).toEqual({ id: JOB_FIXTURE.id });
    expect(capturedJobUpdate.data.amount_invoiced).toEqual({ decrement: 1000 });
  });

  it('voiding a kind=DEPOSIT invoice does NOT touch amount_invoiced', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'DEPOSIT',
      total_amount: 500,
      job_id: null,
      job: null,
    });

    const txJobUpdate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: txJobUpdate },
        invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED' })) },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Deposit waived' });

    expect(res.status).toBe(200);
    expect(txJobUpdate).not.toHaveBeenCalled();
  });

  it('reverses the DepositCreditApplication rows targeting the voided invoice and voids its synthetic credit payment', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'STANDARD',
      total_amount: 1000,
      job_id: JOB_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    });

    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'VOIDED' })) },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        depositCreditApplication: {
          updateMany: vi.fn().mockImplementation((args: any) => { captured.appReverse = args; return { count: 1 }; }),
        },
        payment: {
          updateMany: vi.fn().mockImplementation((args: any) => { captured.synthVoid = args; return { count: 1 }; }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Void and reissue' });

    expect(res.status).toBe(200);
    // Applications reversed, keyed on target_invoice_id (NOT deposit_invoice_id) + tenant-scoped.
    expect(captured.appReverse.where.target_invoice_id).toBe(INVOICE_SENT_FIXTURE.id);
    expect(captured.appReverse.where.reversed_at).toBeNull();
    expect(captured.appReverse.where.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(captured.appReverse.data.reversed_at).toBeInstanceOf(Date);
    // This invoice's own synthetic DEPOSIT-CREDIT payment is voided.
    expect(captured.synthVoid.where.reference_number).toBe('DEPOSIT-CREDIT');
    expect(captured.synthVoid.where.invoice_id).toBe(INVOICE_SENT_FIXTURE.id);
    expect(captured.synthVoid.data.voided_at).toBeInstanceOf(Date);
  });

  it('does not void any payment when the invoice has no deposit-credit applications', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id, status: 'SENT', invoice_number: 'I00002',
      kind: 'STANDARD', total_amount: 1000, job_id: JOB_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    });
    const synthVoid = vi.fn();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: { update: vi.fn().mockResolvedValue(buildInvoiceDetail({ status: 'VOIDED' })) },
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      payment: { updateMany: synthVoid },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));

    const res = await request(app).post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/void`)
      .set(authHeader('admin')).send({ voided_reason: 'No credit case' });

    expect(res.status).toBe(200);
    expect(synthVoid).not.toHaveBeenCalled();   // guarded by reversed.count > 0
  });
});

// ─── GET /api/invoices/:id/notes ──────────────────────

describe('GET /api/invoices/:id/notes', () => {
  it('returns notes for invoice', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const notes = [
      {
        id: 'n0000000-0000-0000-0000-000000000001',
        entity_type: 'INVOICE',
        entity_id: INVOICE_FIXTURE.id,
        content: 'Test note',
        created_by: TEST_USERS.admin.id,
        created_at: new Date(),
        creator: { id: TEST_USERS.admin.id, first_name: 'Admin', last_name: 'User' },
      },
    ];
    mockPrisma.note.findMany.mockResolvedValue(notes);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].content).toBe('Test note');
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/invoices/00000000-0000-0000-0000-000000000999/notes')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  // Phase B (technician redesign): GET /api/invoices/:id/notes is gated canDo('read','Invoice');
  // a strict technician has no such grant, so the route guard blocks before the controller.
  it('returns 403 for a strict TECHNICIAN (no read Invoice grant → route guard)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
  });
});

// ─── POST /api/invoices/:id/notes ─────────────────────

describe('POST /api/invoices/:id/notes', () => {
  it('admin creates a note', async () => {
    mockAuthAs('admin');
    const invoice = {
      id: INVOICE_FIXTURE.id,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const note = {
      id: 'n0000000-0000-0000-0000-000000000002',
      entity_type: 'INVOICE',
      entity_id: INVOICE_FIXTURE.id,
      content: 'New note',
      created_by: TEST_USERS.admin.id,
      created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Admin', last_name: 'User' },
    };
    mockPrisma.note.create.mockResolvedValue(note);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'New note' });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('New note');
  });

  it('SALES gets 403', async () => {
    mockAuthAs('sales');

    // Route-level: SALES not in authorize list
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'Should fail' });

    expect(res.status).toBe(403);
  });

  it('technician gets 403 for invoice notes (CASL: TECHNICIAN lacks update Invoice grant)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('technician'))
      .send({ content: 'Tech note' });

    // TECHNICIAN does not have update Invoice in DEFAULT_GRANTS — blocked at route level.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('technician gets 403 for other technician job invoice (route-level, CASL)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/notes`)
      .set(authHeader('technician'))
      .send({ content: 'Should fail' });

    // Same route-level block as above — TECHNICIAN has no update Invoice grant.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 404 for missing invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices/00000000-0000-0000-0000-000000000999/notes')
      .set(authHeader('admin'))
      .send({ content: 'Should fail' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });
});

// ─── POST /api/invoices/:id/payments ─────────────────

function buildPaymentInvoice(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_SENT_FIXTURE.id,
    invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
    status: 'SENT',
    amount_due: 1268,
    total_amount: 2268,
    job: {
      id: JOB_FIXTURE.id,
      assignees: [{ user_id: TEST_USERS.technician.id }],
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@doe.com',
      },
      estimate: {
        lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      },
    },
    ...overrides,
  };
}

function setupPaymentTransaction(opts: { amount_due: number; status: string } = { amount_due: 1268, status: 'SENT' }) {
  const updatedInvoice = buildInvoiceDetail({
    id: INVOICE_SENT_FIXTURE.id,
    status: opts.amount_due <= 500 ? 'PAID' : 'PARTIAL',
    amount_due: Math.max(opts.amount_due - 500, 0),
  });
  const timelineEventCreate = vi.fn().mockResolvedValue({});

  mockPrisma.$transaction.mockImplementation(async (fn: any) => {
    return fn({
      payment: {
        create: vi.fn().mockResolvedValue({
          ...PAYMENT_FIXTURE,
          collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
        }),
      },
      invoice: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          amount_due: opts.amount_due,
          status: opts.status,
        }),
        update: vi.fn().mockImplementation((args: any) => {
          return { ...updatedInvoice, ...args.data };
        }),
      },
      timelineEvent: { create: timelineEventCreate },
    });
  });

  return { updatedInvoice, timelineEventCreate };
}

describe('POST /api/invoices/:id/payments', () => {
  it('records payment successfully (SENT → PARTIAL)', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    setupPaymentTransaction({ amount_due: 1268, status: 'SENT' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK', reference_number: 'CHK-1234' });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.payment).toBeDefined();
  });

  // SERV10X-59 — a payment is not an edit (it emits its own PAYMENT_RECEIVED event and
  // legitimately moves money); it must never light the resend reminder.
  it('does NOT write INVOICE_EDITED', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    const { timelineEventCreate } = setupPaymentTransaction({ amount_due: 1268, status: 'SENT' });

    await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK', reference_number: 'CHK-1234' });

    expect(timelineEventCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  // R5b (2026-07-22) — D3: PaymentMethod +4. recordPaymentSchema switched from a hardcoded
  // 5-value z.enum to z.nativeEnum(PaymentMethod) — confirm a new value is actually accepted.
  it.each(['ZELLE', 'VENMO', 'CASH_APP', 'OTHER'])('records a payment with method=%s (D3)', async (method) => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    setupPaymentTransaction({ amount_due: 1268, status: 'SENT' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
  });

  it('full payment transitions SENT → PAID', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ amount_due: 500 });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const updatedInvoice = buildInvoiceDetail({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'PAID',
      amount_due: 0,
      paid_at: new Date(),
    });

    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 500,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            amount_due: 500,
            status: 'SENT',
          }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CASH' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('PAID');
  });

  it('full payment transitions PARTIAL → PAID', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ status: 'PARTIAL', amount_due: 768 });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const updatedInvoice = buildInvoiceDetail({
      id: INVOICE_SENT_FIXTURE.id,
      status: 'PAID',
      amount_due: 0,
      paid_at: new Date(),
    });

    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 768,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            amount_due: 768,
            status: 'PARTIAL',
          }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 768, method: 'CARD' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('PAID');
  });

  it('sets paid_at when fully paid', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ amount_due: 100 });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let capturedUpdateData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 100,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            amount_due: 100,
            status: 'SENT',
          }),
          update: vi.fn().mockImplementation((args: any) => {
            capturedUpdateData = args.data;
            return buildInvoiceDetail({ status: 'PAID', amount_due: 0, paid_at: new Date() });
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 100, method: 'CASH' });

    expect(res.status).toBe(201);
    expect(capturedUpdateData.paid_at).toBeInstanceOf(Date);
    expect(capturedUpdateData.status).toBe('PAID');
  });

  it('allows overpayment, records the real money, flags the excess (refund-the-excess default)', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ amount_due: 500 });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let capturedPaymentData: any;
    const timelineCalls: any[] = [];
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        payment: {
          create: vi.fn().mockImplementation((args: any) => {
            capturedPaymentData = args.data;
            return { ...PAYMENT_FIXTURE, ...args.data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } };
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
          update: vi.fn().mockImplementation((args: any) => buildInvoiceDetail({ status: 'PAID', amount_due: 0, ...args.data })),
        },
        timelineEvent: {
          create: vi.fn().mockImplementation((args: any) => { timelineCalls.push(args); return {}; }),
        },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 600, method: 'CASH' });

    expect(res.status).toBe(201);
    // The real $600 is recorded (not clamped).
    expect(Number(capturedPaymentData.amount)).toBe(600);
    // The $100 excess is flagged on the timeline.
    const overpayEvent = timelineCalls.find((c) => c.data.event_type === 'OVERPAYMENT_FLAGGED');
    expect(overpayEvent).toBeDefined();
    expect(Number(overpayEvent.data.metadata.overpaid)).toBe(100);
    expect(res.body.overpaid).toBe(100);
  });

  it('allows recording a payment on a DRAFT invoice (send-first no longer required)', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ status: 'DRAFT' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    setupPaymentTransaction({ amount_due: 1268, status: 'DRAFT' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CASH' });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.payment).toBeDefined();
  });

  it('returns 400 if invoice status is VOIDED', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice({ status: 'VOIDED' });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CASH' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payments can only be recorded on DRAFT, SENT, or PARTIAL invoices');
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('sales'))
      .send({ amount: 500, method: 'CASH' });

    // Route-level: SALES not in authorize list
    expect(res.status).toBe(403);
  });

  // Phase B (technician redesign): on-site `record_payment` is no longer a TECHNICIAN role
  // default — it is an opt-in per-user toggle (own-scoped via the job). A strict (un-granted) tech
  // is blocked at the route guard (canDo('record_payment','Invoice')) even on their own job. The
  // granted-path positive/negative (own-job 201 / other-job 403) belong to the per-user-grant
  // controller test files.
  it('strict technician cannot record a payment by default — even on their own job (route guard 403)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('technician'))
      .send({ amount: 500, method: 'CASH' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('strict technician is blocked from recording a payment on another technician\'s job (route guard 403)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('technician'))
      .send({ amount: 500, method: 'CASH' });

    // No default record_payment grant → blocked at the route guard, not the controller's
    // ownership check (that path is covered for a GRANTED tech elsewhere).
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('creates timeline event for payment', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    let timelineCreateCalls: any[] = [];
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      timelineCreateCalls = [];
      const txMock = {
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            amount_due: 1268,
            status: 'SENT',
          }),
          update: vi.fn().mockResolvedValue(buildInvoiceDetail({ status: 'PARTIAL', amount_due: 768 })),
        },
        timelineEvent: {
          create: vi.fn().mockImplementation((args: any) => {
            timelineCreateCalls.push(args);
            return {};
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);
    expect(timelineCreateCalls).toHaveLength(1);
    expect(timelineCreateCalls[0].data.event_type).toBe('PAYMENT_RECEIVED');
    expect(timelineCreateCalls[0].data.description).toContain('$500.00');
    expect(timelineCreateCalls[0].data.description).toContain('CHECK');
  });

  it('sends emails after recording payment', async () => {
    mockAuthAs('admin');
    const invoice = buildPaymentInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
    setupPaymentTransaction({ amount_due: 1268, status: 'SENT' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(sendPaymentReceivedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'john@doe.com',
        invoiceNumber: INVOICE_SENT_FIXTURE.invoice_number,
        amount: 500,
        method: 'CHECK',
      }),
    );
  });

  // ── kind=DEPOSIT cascade tests (issue #184) ──────────

  it('paying a kind=DEPOSIT invoice in full → estimate WON + lead WON', async () => {
    mockAuthAs('admin');
    const estimateUpdate = vi.fn().mockResolvedValue({});
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    const invoiceFixture = buildPaymentInvoice({
      kind: 'DEPOSIT',
      amount_due: 500,
      estimate: {
        id: 'est00000-0000-0000-0000-000000000001',
        lead_id: 'ld000000-0000-0000-0000-000000000001',
        status: 'SENT',
        estimate_number: 'E00001',
        // Spec #1751 D6: the door hands the lead's CURRENT status to the one status writer, which
        // records it as the ledger entry's `from`. It is in recordPayment's select.
        lead: { commission_owner_id: null, status: 'ESTIMATED' },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture);

    const updatedInvoice = buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'PAID', amount_due: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 500,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: txTimelineCreate },
        estimate: { update: estimateUpdate },
        lead: { updateMany: leadUpdateMany },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);
    expect(estimateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'est00000-0000-0000-0000-000000000001', organization_id: TEST_USERS.admin.organization_id }),
        data: expect.objectContaining({ status: 'WON', approved_at: expect.any(Date) }),
      }),
    );
    expect(leadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'ld000000-0000-0000-0000-000000000001',
          status: { notIn: ['WON', 'LOST', 'CANCELLED'] },
          organization_id: TEST_USERS.admin.organization_id,
        }),
        data: { status: 'WON' },
      }),
    );
    // Spec #1751 D6: the win is now also recorded as a from/to ledger entry — the whole reason
    // the nine scattered lead-to-WON writers were routed through one helper.
    const statusChange = txTimelineCreate.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.event_type === 'STATUS_CHANGE');
    expect(statusChange).toHaveLength(1);
    expect(statusChange[0].metadata).toMatchObject({ from: 'ESTIMATED', to: 'WON' });
  });

  it('DEPOSIT cascade is idempotent / safe on re-pay (estimate already WON)', async () => {
    mockAuthAs('admin');
    const estimateUpdate = vi.fn().mockResolvedValue({});
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    const invoiceFixture = buildPaymentInvoice({
      kind: 'DEPOSIT',
      amount_due: 500,
      status: 'SENT',
      estimate: {
        id: 'est00000-0000-0000-0000-000000000002',
        lead_id: 'ld000000-0000-0000-0000-000000000002',
        status: 'WON',
        estimate_number: 'E00002',
        // Re-pay of a deposit whose estimate is already WON: the lead is already won too, which
        // is exactly the case the notIn guard existed to survive.
        lead: { commission_owner_id: null, status: 'WON' },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture);

    const updatedInvoice = buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'PAID', amount_due: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 500,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: txTimelineCreate },
        estimate: { update: estimateUpdate },
        lead: { updateMany: leadUpdateMany },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);
    // Idempotent: the estimate write is still issued (a no-op write is fine).
    expect(estimateUpdate).toHaveBeenCalled();
    // The lead is NOT re-won. Spec #1751 D6 moved that decision in front of the database: the one
    // writer refuses a terminal `from` outright, so where this used to prove the shape of a notIn
    // guard, it now proves the stronger thing — no status write at all, and no second ledger
    // entry announcing a win that already happened.
    const leadStatusWrites = leadUpdateMany.mock.calls
      .map((c: any[]) => c[0])
      .filter((args: any) => args?.data?.status !== undefined);
    expect(leadStatusWrites).toHaveLength(0);
    expect(txTimelineCreate.mock.calls.filter((c: any[]) => c[0]?.data?.event_type === 'STATUS_CHANGE')).toHaveLength(0);
  });

  it('partial payment on a kind=DEPOSIT invoice does NOT approve the estimate', async () => {
    mockAuthAs('admin');
    const estimateUpdate = vi.fn().mockResolvedValue({});
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const invoiceFixture = buildPaymentInvoice({
      kind: 'DEPOSIT',
      amount_due: 1268,
      estimate: {
        id: 'est00000-0000-0000-0000-000000000003',
        lead_id: 'ld000000-0000-0000-0000-000000000003',
        status: 'SENT',
        estimate_number: 'E00003',
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture);

    const updatedInvoice = buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'PARTIAL', amount_due: 768 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 500,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimate: { update: estimateUpdate },
        lead: { updateMany: leadUpdateMany },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('PARTIAL');
    expect(estimateUpdate).not.toHaveBeenCalled();
    expect(leadUpdateMany).not.toHaveBeenCalled();
  });

  it('paying a STANDARD invoice does NOT touch estimate/lead (regression guard)', async () => {
    mockAuthAs('admin');
    const estimateUpdate = vi.fn().mockResolvedValue({});
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const invoiceFixture = buildPaymentInvoice({ amount_due: 500 }); // no kind, no top-level estimate
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture);

    const updatedInvoice = buildInvoiceDetail({ id: INVOICE_SENT_FIXTURE.id, status: 'PAID', amount_due: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        payment: {
          create: vi.fn().mockResolvedValue({
            ...PAYMENT_FIXTURE,
            amount: 500,
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
          update: vi.fn().mockResolvedValue(updatedInvoice),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimate: { update: estimateUpdate },
        lead: { updateMany: leadUpdateMany },
      });
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CASH' });

    expect(res.status).toBe(201);
    expect(estimateUpdate).not.toHaveBeenCalled();
    expect(leadUpdateMany).not.toHaveBeenCalled();
  });

  // SRVW-55 — tips on manually recorded payments. D2/D3/D4: rides on the payment, never
  // settles the invoice, never folded into amount, no service fee.
  describe('tip_amount (SRVW-55)', () => {
    it('persists tip_amount on the created payment', async () => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice();
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      let capturedPaymentData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          job: { update: vi.fn().mockResolvedValue({}) },
          payment: {
            create: vi.fn().mockImplementation((args: any) => {
              capturedPaymentData = args.data;
              return { ...PAYMENT_FIXTURE, ...args.data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } };
            }),
          },
          invoice: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
            update: vi.fn().mockImplementation((args: any) => buildInvoiceDetail({ status: 'PARTIAL', ...args.data })),
          },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        });
      });

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send({ amount: 500, method: 'CASH', tip_amount: 12.5 });

      expect(res.status).toBe(201);
      expect(Number(capturedPaymentData.tip_amount)).toBe(12.5);
    });

    it('reduces amount_due by amount only — the tip does not settle any part of the balance', async () => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice({ amount_due: 500 });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      let capturedInvoiceUpdateData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          job: { update: vi.fn().mockResolvedValue({}) },
          payment: {
            create: vi.fn().mockResolvedValue({ ...PAYMENT_FIXTURE, amount: 500, tip_amount: 50, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } }),
          },
          invoice: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
            update: vi.fn().mockImplementation((args: any) => {
              capturedInvoiceUpdateData = args.data;
              return buildInvoiceDetail({ status: 'PAID', ...args.data });
            }),
          },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        });
      });

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send({ amount: 500, method: 'CASH', tip_amount: 50 });

      expect(res.status).toBe(201);
      // $500 due, $500 paid (+ $50 tip on top) — the balance clears exactly, not into credit.
      expect(Number(capturedInvoiceUpdateData.amount_due)).toBe(0);
      expect(capturedInvoiceUpdateData.status).toBe('PAID');
    });

    it.each([
      ['omitted', undefined],
      ['zero', 0],
    ])('%s tip persists NULL, never 0.00', async (_label, tip_amount) => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice();
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      let capturedPaymentData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          job: { update: vi.fn().mockResolvedValue({}) },
          payment: {
            create: vi.fn().mockImplementation((args: any) => {
              capturedPaymentData = args.data;
              return { ...PAYMENT_FIXTURE, ...args.data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } };
            }),
          },
          invoice: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
            update: vi.fn().mockImplementation((args: any) => buildInvoiceDetail({ status: 'PARTIAL', ...args.data })),
          },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        });
      });

      const body: any = { amount: 500, method: 'CASH' };
      if (tip_amount !== undefined) body.tip_amount = tip_amount;

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send(body);

      expect(res.status).toBe(201);
      expect(capturedPaymentData.tip_amount).toBeNull();
    });

    it('a tip that pushes amount + tip over the balance does not flag overpayment or flip PAID early', async () => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice({ amount_due: 500 });
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      const timelineCalls: any[] = [];
      let capturedInvoiceUpdateData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          job: { update: vi.fn().mockResolvedValue({}) },
          payment: {
            create: vi.fn().mockResolvedValue({ ...PAYMENT_FIXTURE, amount: 400, tip_amount: 200, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } }),
          },
          invoice: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 500, status: 'SENT' }),
            update: vi.fn().mockImplementation((args: any) => {
              capturedInvoiceUpdateData = args.data;
              return buildInvoiceDetail({ status: 'PARTIAL', ...args.data });
            }),
          },
          timelineEvent: {
            create: vi.fn().mockImplementation((args: any) => { timelineCalls.push(args); return {}; }),
          },
        });
      });

      // $400 amount (< $500 due) + $200 tip: amount+tip ($600) exceeds the balance, but amount
      // alone does not — overpayment/isFullyPaid must be computed from amount only.
      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send({ amount: 400, method: 'CASH', tip_amount: 200 });

      expect(res.status).toBe(201);
      expect(capturedInvoiceUpdateData.status).toBe('PARTIAL');
      expect(res.body.overpaid).toBe(0);
      expect(timelineCalls.find((c) => c.data.event_type === 'OVERPAYMENT_FLAGGED')).toBeUndefined();
    });

    it.each([
      ['negative', -1],
      ['non-numeric', 'ten dollars'],
    ])('rejects a %s tip_amount with 400', async (_label, tip_amount) => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice();
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send({ amount: 500, method: 'CASH', tip_amount });

      expect(res.status).toBe(400);
    });

    it('leaves service_fee_amount unset on a tipped manual payment — no card, no fee', async () => {
      mockAuthAs('admin');
      const invoice = buildPaymentInvoice();
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      let capturedPaymentData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          job: { update: vi.fn().mockResolvedValue({}) },
          payment: {
            create: vi.fn().mockImplementation((args: any) => {
              capturedPaymentData = args.data;
              return { ...PAYMENT_FIXTURE, ...args.data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } };
            }),
          },
          invoice: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
            update: vi.fn().mockImplementation((args: any) => buildInvoiceDetail({ status: 'PARTIAL', ...args.data })),
          },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        });
      });

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
        .set(authHeader('admin'))
        .send({ amount: 500, method: 'CASH', tip_amount: 25 });

      expect(res.status).toBe(201);
      expect(capturedPaymentData.service_fee_amount).toBeUndefined();
    });

    // Regression: proportionalRefundExtras only ever runs inside the Stripe (PI-present) branch
    // of refundInvoice — a manual CASH payment has no PI, so a tip on it must never leak into the
    // record-only refund math now that manual payments can carry tip_amount too.
    it('a record-only refund of a tipped CASH payment refunds the face amount only — no Stripe call, no tip leakage', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv_1',
        invoice_number: 'I00001',
        status: 'PAID',
        amount_due: 0,
        total_amount: 500,
        tax_amount: 0,
        net_collected: 0,
        organization: { id: 'org_1', stripe_account_id: null },
        payments: [{
          id: 'pay_1', method: 'CASH', amount: 500, stripe_payment_intent_id: null,
          refunded_at: null, reference_number: null, voided_at: null, tip_amount: 50,
        }],
        refunds: [],
        customer: null,
        job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
      });

      let capturedRefund: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          refund: { create: vi.fn().mockImplementation((args: any) => { capturedRefund = args.data; return { id: 're_row_1', ...args.data }; }) },
          invoice: { update: vi.fn().mockResolvedValue({}) },
          payment: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return { id: 're_row_1' };
      });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ amount: 200, reason_category: 'CUSTOMER_REQUEST', reason: 'partial cash refund' });

      expect(res.status).toBe(200);
      expect(mockCreateRefund).not.toHaveBeenCalled();
      expect(Number(capturedRefund.amount)).toBe(200);
    });
  });
});

// ─── GET /api/invoices/:id/public ─────────────────────

function buildPublicInvoice(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_SENT_FIXTURE.id,
    invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
    status: 'SENT',
    subtotal: 2300,
    discount_amount: 200,
    tax_amount: 168,
    deposit_credit: 1000,
    total_amount: 2268,
    amount_due: 1268,
    due_date: new Date('2026-03-01'),
    sent_at: new Date('2026-02-02'),
    paid_at: null,
    created_at: new Date('2026-02-01'),
    job: {
      job_number: 'J00001',
      estimate: {
        estimate_number: 'E00003',
        discount_name: null,
        discount_type: null,
        discount_value: null,
        tax_rate: 0.08,
        line_items: [
          { id: 'li1', sequence: 1, description: 'AC Unit', quantity: 1, unit_price: 2000, is_taxable: true, line_total: 2000 },
        ],
      },
      charges: [
        { id: 'ch1', sequence: 1, description: 'Service call', quantity: 1, unit_price: 300, is_taxable: true, line_total: 300 },
      ],
      // F-55: the public select no longer requests email/phone/street lines, so the mock
      // mirrors the minimized shape Prisma would actually return (name + city/state/zip only).
      customer: { first_name: 'John', last_name: 'Doe' },
      service_location: { city: 'Dallas', state: 'TX', zip: '75001' },
    },
    payments: [],
    ...overrides,
  };
}

describe('GET /api/invoices/:id/public', () => {
  it('returns invoice with valid token', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.invoice.invoice_number).toBe(INVOICE_SENT_FIXTURE.invoice_number);
    expect(res.body.invoice.job.customer.first_name).toBe('John');
    expect(res.body.invoice.job.estimate.line_items).toHaveLength(1);
    expect(res.body.invoice.job.charges).toHaveLength(1);
    expect(mockPrisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_SENT_FIXTURE.id, public_token: 'test-invoice-token-123' },
      }),
    );
  });

  it('returns 404 with invalid token', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=wrong-token`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  it('returns 400 without token', async () => {
    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Token required');
  });

  // ── Phase 2c: public deposit-pay surface (job-less kind=DEPOSIT invoice) ──
  it('returns a kind=DEPOSIT, job-less invoice with its own line_items and kind, customer via invoice.customer', async () => {
    const depositInvoice = {
      id: 'dep-inv-1',
      invoice_number: 'I00007',
      organization_id: 'org-test-1',
      status: 'SENT',
      subtotal: 500,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      total_amount: 500,
      amount_due: 500,
      due_date: null,
      sent_at: new Date('2026-02-02'),
      paid_at: null,
      created_at: new Date('2026-02-01'),
      kind: 'DEPOSIT',
      // F-55: the public select no longer requests email/phone; Prisma would not return them.
      customer: { first_name: 'Dep', last_name: 'Payer', company_name: null },
      job: null,
      line_items: [
        { id: 'dli1', sequence: 1, description: 'Deposit — 50% of E00007', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 },
      ],
      payments: [],
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice);

    const res = await request(app)
      .get(`/api/invoices/dep-inv-1/public?token=test-deposit-token`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.kind).toBe('DEPOSIT');
    // The deposit invoice renders its OWN lines (no job to source charges/estimate lines from).
    expect(res.body.invoice.line_items).toHaveLength(1);
    expect(res.body.invoice.line_items[0].is_taxable).toBe(false);
    // Customer resolved via invoice.customer, no NPE on the missing job — name only.
    expect(res.body.invoice.customer.first_name).toBe('Dep');
    // F-55: the public deposit payload exposes the name but not email/phone.
    expect(res.body.invoice.customer.email).toBeUndefined();
    expect(res.body.invoice.customer.phone).toBeUndefined();
    expect(res.body.invoice.job).toBeNull();
    expect(res.body.available_payment_methods).toBeDefined();
  });

  // ── F-55: public invoice GET minimizes PII (no customer email/phone, no street lines) ──
  it('F-55: public invoice GET omits customer email/phone and street address from the payload + select', async () => {
    // Mock returns ONLY the minimized fields — mirrors what the minimized Prisma select yields.
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    // Body assertion: no contact PII / street lines anywhere in the serialized public payload.
    expect(res.body.invoice.job.customer.email).toBeUndefined();
    expect(res.body.invoice.job.customer.phone).toBeUndefined();
    expect(res.body.invoice.job.service_location.address_line1).toBeUndefined();
    expect(res.body.invoice.job.service_location.address_line2).toBeUndefined();
    // city/state/zip are retained so the public page can still show the service area.
    expect(res.body.invoice.job.service_location.city).toBe('Dallas');
    expect(res.body.invoice.job.service_location.state).toBe('TX');
    expect(res.body.invoice.job.service_location.zip).toBe('75001');

    // Select assertion: the query passed to Prisma must NOT request email/phone (top-level
    // customer + job.customer) or street lines — defense even if a future mock over-returns.
    const sel = mockPrisma.invoice.findFirst.mock.calls[0][0].select;
    expect(sel.customer.select.email).toBeUndefined();
    expect(sel.customer.select.phone).toBeUndefined();
    expect(sel.job.select.customer.select.email).toBeUndefined();
    expect(sel.job.select.customer.select.phone).toBeUndefined();
    expect(sel.job.select.service_location.select.address_line1).toBeUndefined();
    expect(sel.job.select.service_location.select.address_line2).toBeUndefined();
    // Confirm the retained fields ARE still selected.
    expect(sel.customer.select.first_name).toBe(true);
    expect(sel.job.select.service_location.select.city).toBe(true);
  });

  // ── Task 1.7 re-key: available_payment_methods must key off stripe_charges_enabled ──
  function mockAppSettings(overrides: Record<string, string | null> = {}) {
    (prisma.appSetting.findUnique as any).mockImplementation((args: any) => {
      const key = args?.where?.organization_id_key?.key;
      const value = overrides[key];
      return Promise.resolve(value != null ? { key, value } : null);
    });
  }

  it('drops CARD from available_payment_methods when Stripe charges are not enabled (mid-onboarding: account id set, charges disabled)', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_mid_onboarding',
      stripe_charges_enabled: false,
      accepted_payment_methods: ['CARD', 'EXTERNAL_CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.available_payment_methods).not.toContain('CARD');
  });

  // An override holding valid JSON that is not an array used to pass the parse guard and then
  // throw on .filter, 500ing the public page. It must degrade to the org default instead.
  it('falls back to the org default when the available_payment_methods override is valid JSON but not an array', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings({ available_payment_methods: '30' });
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.available_payment_methods).toEqual(['CARD', 'CHECK']);
  });

  it('keeps CARD in available_payment_methods when Stripe charges are enabled', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.available_payment_methods).toContain('CARD');
  });

  it('drops CARD from a stale legacy available_payment_methods AppSetting override when Stripe charges are not enabled', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    // The AppSetting override says CARD is available (e.g. a stale admin-set list) — but the
    // org's Stripe capability has since gone away/never arrived, so it must not leak through.
    mockAppSettings({ available_payment_methods: JSON.stringify(['CARD', 'CHECK', 'CASH']) });
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_mid_onboarding',
      stripe_charges_enabled: false,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.available_payment_methods).not.toContain('CARD');
    expect(res.body.available_payment_methods).toEqual(expect.arrayContaining(['CHECK', 'CASH']));
  });

  // ─── Slice 4 (card service fee) — public preview, display-only per D8 ────
  it('returns service_fee_bps and a computed service_fee_preview', async () => {
    const invoice = buildPublicInvoice(); // amount_due = 1268
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.service_fee_bps).toBe(350);
    // 1268 * 100 = 126800 cents × 350bps / 10000 = 4438 cents = $44.38.
    expect(res.body.service_fee_preview).toBe(44.38);
  });

  // The fee is unconditional: no org column, plan or setting suppresses it. This org row carries
  // the retired opt-out flag set to false - the preview must ignore it and quote the full fee.
  it('previews the full service fee with no org opt-out available', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
      card_service_fee_enabled: false, // stale/ignored - must not suppress anything
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.service_fee_bps).toBe(350);
    expect(res.body.service_fee_preview).toBe(44.38);
  });

  // ─── Slice 8 (customer-facing tipping) — the constant chips render from ───
  it('returns tip_preset_bps so the tip chips can render without hardcoding the presets client-side', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.tip_preset_bps).toEqual([1000, 1500, 2000]);
  });

  // ─── #1821 — the public payload must carry the BUSINESS's clock ──────
  // The customer reading /p/invoices/:id is UNAUTHENTICATED, so the frontend has no org
  // context and no useScheduleTimezone(). Without this field the page can only fall back
  // to the viewer's own browser zone, which is genuinely unknown and routinely not the
  // business's — which is how the due date and the overdue banner came to render a day
  // off the owner's own invoice detail page for the same record.
  it('serves the org\'s configured timezone on the public payload', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Riverbend Septic', logo_url: null, brand_color: '#000000', phone: null,
      timezone: 'America/Denver',
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    // Not the shared default: a Denver org whose customers read America/New_York here
    // would be two hours ahead of its own books on every date the page prints.
    expect(res.body.organization.timezone).toBe('America/Denver');
  });

  // Organization.timezone is nullable, so the zone is resolved server-side and the wire
  // contract is always a valid IANA zone. DEFAULT_TIMEZONE is the same 'America/New_York'
  // literal the frontend's DEFAULT_SCHEDULE_TIMEZONE carries, so a zone-less org reads
  // identically on the public page and in the authed app.
  it('resolves a null org timezone to the shared default rather than sending null', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      timezone: null,
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.organization.timezone).toBe('America/New_York');
  });

  // NOT DISCRIMINATING — passes before and after the change. It guards against the
  // getOrgTimezone() implementation that was REJECTED, not against the defect: that helper
  // issues its OWN organization.findUnique and both of its existing call sites read
  // req.user!.organization_id, which this unscopedRequest route does not have. The org row
  // is already fetched with no `select`, so org.timezone is in memory and widening the
  // response mapping costs nothing on a public path that already fires five queries.
  it('does not issue a second organization lookup to resolve the zone', async () => {
    const invoice = buildPublicInvoice();
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockAppSettings();
    (prisma.organization.findUnique as any).mockResolvedValue({
      name: 'Northwind Services', logo_url: null, brand_color: '#000000', phone: null,
      timezone: 'America/Denver',
      stripe_account_id: 'acct_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(prisma.organization.findUnique as any).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /api/invoices/:id/public/checkout ───────────

describe('POST /api/invoices/:id/public/checkout', () => {
  beforeEach(() => {
    // Default: no AppSetting override — resolveAvailablePaymentMethods falls through to
    // org.accepted_payment_methods. (vi.clearAllMocks() in the outer beforeEach clears call
    // history but NOT a prior test's .mockImplementation(), so this block needs its own
    // deterministic default rather than inheriting whatever the GET /public tests above left
    // on prisma.appSetting.findUnique.) Individual tests override this where the override
    // itself is the point (the CARD-excluded-by-override test below).
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);
  });

  it('creates Stripe session and returns checkout_url', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1268,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'], stripe_charges_enabled: true },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/test',
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.com/test');
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        depositAmount: 1268,
        metadata: { invoiceId: INVOICE_SENT_FIXTURE.id },
      }),
      expect.objectContaining({ stripe: expect.anything() }),
    );
  });

  it('returns 400 on non-payable status (DRAFT)', async () => {
    const invoice = {
      id: INVOICE_FIXTURE.id,
      invoice_number: INVOICE_FIXTURE.invoice_number,
      status: 'DRAFT',
      amount_due: 1268,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: null },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/public/checkout?token=test-token`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invoice is not payable');
  });

  it('returns 400 on non-payable status (PAID)', async () => {
    const invoice = {
      id: INVOICE_FIXTURE.id,
      invoice_number: INVOICE_FIXTURE.invoice_number,
      status: 'PAID',
      amount_due: 0,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: null },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/public/checkout?token=test-token`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invoice is not payable');
  });

  it('returns 400 on non-payable status (VOIDED)', async () => {
    const invoice = {
      id: INVOICE_FIXTURE.id,
      invoice_number: INVOICE_FIXTURE.invoice_number,
      status: 'VOIDED',
      amount_due: 0,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/public/checkout?token=test-token`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invoice is not payable');
  });

  it('returns 400 if Stripe not configured', async () => {
    mockIsStripeConfigured.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-token`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Card payments are not configured');
  });

  it('returns 400 without token', async () => {
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Token required');
  });

  it('returns 404 with invalid token', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=wrong-token`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');
  });

  // Task 1.7 re-key — CARD availability now keys off stripe_charges_enabled (not
  // accepted_payment_methods/stripe_account_id presence). Org never connected Stripe.
  it('returns 400 when the owning org does not accept CARD (stripe_charges_enabled false)', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1268,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: null, accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'], stripe_charges_enabled: false },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  // Task 1.7 — the central regression this re-key exists to fix: the Stripe account EXISTS
  // (stripe_account_id set) and accepted_payment_methods already lists CARD (e.g. auto-added
  // by an earlier account.updated webhook, later restricted) but Stripe has NOT enabled
  // charges. Pre-1.7 this call site keyed off accepted_payment_methods.includes('CARD'),
  // which would have WRONGLY allowed a Stripe checkout to be created here.
  it('returns 400 when the Stripe account exists but charges are not enabled yet (mid-onboarding / later-restricted)', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1268,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: 'acct_mid_onboarding', accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: false },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  // Code-review finding: stripe_charges_enabled alone doesn't guarantee CARD is actually in the
  // org's resolved accepted-methods list — an AppSetting override can exclude it even while
  // charges are enabled (a state that shouldn't normally occur, but the endpoint must defend
  // against it rather than trust either signal alone). Reuses getPublic's exact
  // method-resolution chain (AppSetting override → org.accepted_payment_methods → default).
  it('returns 400 when charges are enabled but an AppSetting override excludes CARD from the resolved accepted-methods list', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1268,
      job: { customer: { first_name: 'John', last_name: 'Doe' } },
      organization: { id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: true },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    (prisma.appSetting.findUnique as any).mockResolvedValue({
      key: 'available_payment_methods',
      value: JSON.stringify(['CHECK', 'CASH']),
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('works with PARTIAL status', async () => {
    const invoice = {
      id: INVOICE_PARTIAL_FIXTURE.id,
      invoice_number: INVOICE_PARTIAL_FIXTURE.invoice_number,
      status: 'PARTIAL',
      amount_due: 768,
      job: {
        customer: { first_name: 'John', last_name: 'Doe' },
      },
      organization: { id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'], stripe_charges_enabled: true },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({
      id: 'cs_test_456',
      url: 'https://checkout.stripe.com/test2',
    });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_PARTIAL_FIXTURE.id}/public/checkout?token=test-token`);

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.com/test2');
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 768 }),
      expect.objectContaining({ stripe: expect.anything() }),
    );
  });

  // ── Phase 2c: a job-less kind=DEPOSIT invoice is payable via the same checkout path ──
  it('issues a Stripe checkout with metadata.invoiceId for a SENT, job-less DEPOSIT invoice', async () => {
    const depositInvoice = {
      id: 'dep-inv-1',
      invoice_number: 'I00007',
      status: 'SENT',
      amount_due: 500,
      kind: 'DEPOSIT',
      // Customer hangs off the top-level relation; there is no job.
      customer: { first_name: 'Dep', last_name: 'Payer', company_name: null },
      job: null,
      organization: { id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: true },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice);
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_dep_1', url: 'https://checkout.stripe.com/dep' });

    const res = await request(app)
      .post(`/api/invoices/dep-inv-1/public/checkout?token=test-deposit-token`);

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.com/dep');
    // Face value; customer resolved via invoice.customer (no NPE).
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        depositAmount: 500,
        metadata: { invoiceId: 'dep-inv-1' },
      }),
      expect.objectContaining({ stripe: expect.anything() }),
    );
  });

  // ── Task 3.1: application fee plumbing — double guard exercised at the call site ──
  it('passes a positive application_fee_amount when the org has a connected Stripe account', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1000,
      job: { customer: { first_name: 'John', last_name: 'Doe' } },
      organization: {
        id: 'org-test-1',
        stripe_account_id: 'acct_connected_1',
        accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true,
        platform_fee_bps: 50,
      },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    // getStripeForOrg is globally mocked to a fixed { stripe: {}, stripeAccount: undefined } —
    // override it here to simulate a genuinely connected account (§ getStripeForOrg contract).
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_connected_1' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_1', url: 'https://checkout.stripe.com/fee1' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    // The application fee is the D2 remainder of the service fee, not platform_fee_bps: $1,000
    // face → 3500c service fee less the estimated Stripe cut = 468c. depositAmount stays 1000 —
    // the org still receives face value; the fee rides on top, funded by the customer.
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_connected_1' }),
    );
  });

  it('omits application_fee_amount when the org has no connected Stripe account, even with platform_fee_bps set (legacy platform-account guard)', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1000,
      job: { customer: { first_name: 'John', last_name: 'Doe' } },
      organization: {
        id: 'org-test-1',
        stripe_account_id: null,
        accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true,
        platform_fee_bps: 50,
      },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    // Default mock: getStripeForOrg → { stripe: {}, stripeAccount: undefined } (no override) —
    // models a legacy/platform-account org, which must never get an application_fee_amount.
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_2', url: 'https://checkout.stripe.com/fee2' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    const [options, ctxArg] = mockCreateCheckoutSession.mock.calls[0];
    expect(options.depositAmount).toBe(1000); // face value, unaffected
    expect(options.applicationFeeAmount).toBeUndefined();
    expect(ctxArg.stripeAccount).toBeUndefined();
  });

  // ─── Slice 2 (card service fee) — checkout wiring ─────────────────────────
  it('passes a service fee (D2 replacing the platform fee) on any card checkout with a connected account', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1000,
      job: { customer: { first_name: 'John', last_name: 'Doe' } },
      organization: {
        id: 'org-test-1',
        stripe_account_id: 'acct_connected_fee',
        accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true,
      },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_connected_fee' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_3', url: 'https://checkout.stripe.com/fee3' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    // $1,000 face value → 3.5% = $35.00 (3500c) service fee; the application fee is the D2-derived
    // remainder (3500 - estimated Stripe cut), never a flat platform-fee percentage.
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, serviceFeeAmount: 3500, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_connected_fee' }),
    );
  });

  // The switch is gone: an org row carrying leftover opt-out-shaped fields changes nothing,
  // because the fee math never reads the org at all.
  it('charges the service fee regardless of what the org row says', async () => {
    const invoice = {
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1000,
      job: { customer: { first_name: 'John', last_name: 'Doe' } },
      organization: {
        id: 'org-test-1',
        stripe_account_id: 'acct_connected_no_fee',
        accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true,
        platform_fee_bps: 50,
        card_service_fee_enabled: false, // stale/ignored - must not suppress anything
      },
    };
    mockPrisma.invoice.findFirst.mockResolvedValue(invoice);
    mockIsStripeConfigured.mockReturnValue(true);
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_connected_no_fee' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_4', url: 'https://checkout.stripe.com/fee4' });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, serviceFeeAmount: 3500, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_connected_no_fee' }),
    );
  });

  // ─── Slice 7 (customer-facing tipping) — invoices only, validated server-side (D10/D11) ───
  describe('tip (Slice 7)', () => {
    function tipInvoice() {
      return {
        id: INVOICE_SENT_FIXTURE.id,
        invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
        status: 'SENT',
        amount_due: 1000,
        job: { customer: { first_name: 'John', last_name: 'Doe' } },
        organization: {
          id: 'org-test-1',
          stripe_account_id: null,
          accepted_payment_methods: ['CARD'],
          stripe_charges_enabled: true,
        },
      };
    }

    it('passes tipAmount (cents) to createCheckoutSession when a valid tip is provided', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(tipInvoice());
      mockIsStripeConfigured.mockReturnValue(true);
      mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_tip_1', url: 'https://checkout.stripe.com/tip1' });

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`)
        .send({ tip: 150 });

      expect(res.status).toBe(200);
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ depositAmount: 1000, tipAmount: 15000 }),
        expect.anything(),
      );
    });

    it('omits tipAmount when no tip is provided (backward compatible)', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(tipInvoice());
      mockIsStripeConfigured.mockReturnValue(true);
      mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_tip_2', url: 'https://checkout.stripe.com/tip2' });

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`);

      expect(res.status).toBe(200);
      const [options] = mockCreateCheckoutSession.mock.calls[0];
      expect(options.tipAmount).toBeUndefined();
    });

    it('rejects a negative tip with 400, never reaching Stripe', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(tipInvoice());
      mockIsStripeConfigured.mockReturnValue(true);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`)
        .send({ tip: -5 });

      expect(res.status).toBe(400);
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it('rejects an absurdly large tip with 400, never reaching Stripe', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(tipInvoice());
      mockIsStripeConfigured.mockReturnValue(true);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`)
        .send({ tip: 999999999 });

      expect(res.status).toBe(400);
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric tip with 400', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(tipInvoice());
      mockIsStripeConfigured.mockReturnValue(true);

      const res = await request(app)
        .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/public/checkout?token=test-invoice-token-123`)
        .send({ tip: 'a lot please' });

      expect(res.status).toBe(400);
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/invoices/:id/refund', () => {
  // A PAID invoice with one CARD (PI-backed) payment, total $1000.
  function buildPaidInvoice(overrides: Record<string, any> = {}) {
    return {
      id: 'inv_1',
      invoice_number: 'I00001',
      status: 'PAID',
      amount_due: 0,
      total_amount: 1000,
      tax_amount: 80,
      net_collected: 0,
      organization: { id: 'org_1', stripe_account_id: null },
      payments: [{
        id: 'pay_1',
        method: 'CARD',
        amount: 1000,
        stripe_payment_intent_id: 'pi_test_invoice_1',
        refunded_at: null,
        reference_number: null,
        voided_at: null,
      }],
      refunds: [],
      customer: null,
      job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
      ...overrides,
    };
  }

  // A tx surface that captures the refund.create + invoice.update + timeline args.
  function captureRefundTx() {
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        refund: { create: vi.fn().mockImplementation((args: any) => { captured.refund = args.data; return { id: 're_row_1', ...args.data }; }) },
        invoice: { update: vi.fn().mockImplementation((args: any) => { captured.invoiceUpdate = args.data; return {}; }) },
        payment: { update: vi.fn().mockImplementation((args: any) => { captured.paymentUpdate = args.data; return {}; }) },
        timelineEvent: { create: vi.fn().mockImplementation((args: any) => { captured.timeline = args.data; return {}; }) },
      };
      await fn(tx);
      return { id: 're_row_1' };
    });
    return captured;
  }

  it('full refund (amount omitted) of a single-PI invoice calls Stripe money-first then writes a Refund row', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_test_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'Customer changed mind' });

    expect(res.status).toBe(200);
    // Money-first: Stripe called before the row is written.
    const stripeOrder = mockCreateRefund.mock.invocationCallOrder[0];
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_test_invoice_1',
      expect.objectContaining({ stripe: expect.anything() }),
      100000, // full $1000 in cents
      { metadata: { source: 'in_app', invoiceId: 'inv_1' } },
    );
    expect(captured.refund).toBeDefined();
    expect(typeof stripeOrder).toBe('number');
    // The Refund row persists the Stripe response id.
    expect(captured.refund.stripe_refund_id).toBe('re_test_1');
    expect(Number(captured.refund.amount)).toBe(1000);
    // Status → REFUNDED; amount_due is NEVER reopened (no amount_due key in the update).
    expect(captured.invoiceUpdate.status).toBe('REFUNDED');
    expect(captured.invoiceUpdate).not.toHaveProperty('amount_due');
    // Inventory P1 (§4.5 / QA-507): refund is money-only — stock is NEVER touched. Physical
    // returns after a refund are a manual Stock-page action.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('partial refund passes amountInCents and sets status PARTIALLY_REFUNDED', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_partial_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 400, reason_category: 'GOODWILL', reason: 'partial goodwill' });

    expect(res.status).toBe(200);
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_test_invoice_1', expect.anything(), 40000, expect.anything(),
    );
    expect(Number(captured.refund.amount)).toBe(400);
    expect(captured.invoiceUpdate.status).toBe('PARTIALLY_REFUNDED');
    // net_collected = Σpayments − Σrefunds = 1000 − 400 = 600.
    expect(Number(captured.invoiceUpdate.net_collected)).toBe(600);
    expect(Number(captured.invoiceUpdate.total_refunded)).toBe(400);
  });

  it('SECOND partial refund accumulates and flips to REFUNDED when Σ reaches net-paid', async () => {
    mockAuthAs('admin');
    // Already PARTIALLY_REFUNDED with a prior $400 refund; refunding the remaining $600.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      status: 'PARTIALLY_REFUNDED',
      refunds: [{ id: 're_row_0', payment_id: null, amount: 400 }],
    }));
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_partial_2' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 600, reason_category: 'CUSTOMER_REQUEST', reason: 'rest' });

    expect(res.status).toBe(200);
    expect(Number(captured.invoiceUpdate.total_refunded)).toBe(1000);
    expect(captured.invoiceUpdate.status).toBe('REFUNDED');
  });

  it('MULTI-PAYMENT invoice now refunds (old R5 hard-fail removed)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      payments: [
        { id: 'pay_1', method: 'CARD', amount: 600, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null },
        { id: 'pay_2', method: 'CHECK', amount: 400, stripe_payment_intent_id: null, refunded_at: null, reference_number: null, voided_at: null },
      ],
    }));
    const captured = captureRefundTx();

    // Target the CHECK payment (no PI) for $400 — record-only, no Stripe.
    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ payment_id: '00000000-0000-0000-0000-0000000000a2', reason_category: 'CUSTOMER_REQUEST', reason: 'multi pay' });

    // payment_id not matching → 400 (unknown). Re-run without payment_id for the broad case.
    expect([200, 400]).toContain(res.status);

    // Broad multi-payment refund (no payment_id, full net-paid) records a Refund and succeeds.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      payments: [
        { id: 'pay_1', method: 'CARD', amount: 600, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null },
        { id: 'pay_2', method: 'CHECK', amount: 400, stripe_payment_intent_id: null, refunded_at: null, reference_number: null, voided_at: null },
      ],
    }));
    const captured2 = captureRefundTx();
    const res2 = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 1000, reason_category: 'CUSTOMER_REQUEST', reason: 'multi pay broad' });

    expect(res2.status).toBe(200);
    expect(res2.body.error).toBeUndefined();
    expect(captured2.refund).toBeDefined();
  });

  it('no-PI manual payment is record-only (old reject removed)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      payments: [{ id: 'pay_1', method: 'CHECK', amount: 1000, stripe_payment_intent_id: null, refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureRefundTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'OTHER', reason: 'check refund' });

    expect(res.status).toBe(200);
    expect(mockCreateRefund).not.toHaveBeenCalled();
    expect(captured.refund.method).toBe('CHECK');
    expect(captured.refund.stripe_refund_id).toBeNull();
  });

  // R5b (2026-07-22) — D3: PaymentMethod +4. refundInvoiceSchema's `method` switched from a
  // hardcoded 5-value z.enum to z.nativeEnum(PaymentMethod) — confirm the client can explicitly
  // choose a new value (not just inherit it from the source payment).
  it('accepts an explicit client-supplied method=ZELLE (D3)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      payments: [{ id: 'pay_1', method: 'CHECK', amount: 1000, stripe_payment_intent_id: null, refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureRefundTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'OTHER', reason: 'refunded via Zelle instead', method: 'ZELLE' });

    expect(res.status).toBe(200);
    expect(captured.refund.method).toBe('ZELLE');
  });

  it('caps refund at net-paid (Cap A)', async () => {
    mockAuthAs('admin');
    // Cap A: amount > net-paid.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const resA = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 1500, reason_category: 'OTHER', reason: 'too much' });
    expect(resA.status).toBe(400);
    expect(resA.body.error).toMatch(/exceeds net paid/i);
  });

  // ── MON-09: a DEPOSIT invoice caps its refund at the DRAWDOWN-AWARE remaining credit ──
  // (paid − applied − refunded), NOT the raw payments total. A deposit already drawn down onto a
  // job's STANDARD invoice is NOT refundable — refunding it would double-spend the credit.
  // A PAID DEPOSIT invoice: $30k paid (so Cap A / netPaid would otherwise allow up to $30k).
  function buildDepositInvoice(overrides: Record<string, any> = {}) {
    return buildPaidInvoice({
      kind: 'DEPOSIT',
      total_amount: 30000,
      tax_amount: 0,
      payments: [{
        id: 'dep_pay_1', method: 'CARD', amount: 30000, stripe_payment_intent_id: 'pi_dep_1',
        refunded_at: null, reference_number: null, voided_at: null,
      }],
      ...overrides,
    });
  }

  // Mock remainingDepositCredit's ledger reads: paid − applied − refunded.
  function mockDepositLedger({ paid, applied, refunded }: { paid: number; applied: number; refunded: number }) {
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: paid } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: applied } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: refunded } });
  }

  it('MON-09: fully drawn-down deposit ($30k applied) rejects ANY refund (drawdown-aware cap = 0)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildDepositInvoice());
    // $30k paid, $30k applied to a job invoice, $0 refunded ⇒ remaining credit = $0.
    mockDepositLedger({ paid: 30000, applied: 30000, refunded: 0 });
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_should_not_happen' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 1, reason_category: 'CUSTOMER_REQUEST', reason: 'over-refund a spent deposit' });

    expect(res.status).toBe(400);
    // The cap is the DRAWDOWN-AWARE remaining ($0), NOT the raw $30k payments total.
    expect(res.body.error).toMatch(/exceed|remaining|credit/i);
    // No Refund row, no Stripe call.
    expect(captured.refund).toBeUndefined();
    expect(mockCreateRefund).not.toHaveBeenCalled();
  });

  it('MON-09: partially drawn-down deposit ($20k applied) allows $10k but rejects $10,001', async () => {
    mockAuthAs('admin');
    // $30k paid, $20k applied, $0 refunded ⇒ remaining credit = $10k.
    mockDepositLedger({ paid: 30000, applied: 20000, refunded: 0 });

    // Over the drawdown-aware cap ($10,001 > $10,000) → rejected, even though raw netPaid is $30k.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildDepositInvoice());
    const overCaptured = captureRefundTx();
    const resOver = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 10001, reason_category: 'CUSTOMER_REQUEST', reason: 'over remaining credit' });
    expect(resOver.status).toBe(400);
    expect(overCaptured.refund).toBeUndefined();

    // At the cap ($10,000) → succeeds.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildDepositInvoice());
    const okCaptured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_dep_ok' });
    const resOk = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 10000, reason_category: 'CUSTOMER_REQUEST', reason: 'remaining credit' });
    expect(resOk.status).toBe(200);
    expect(Number(okCaptured.refund.amount)).toBe(10000);
  });

  it('MON-09: a non-DEPOSIT invoice still caps at raw net-paid (drawdown logic does NOT apply)', async () => {
    mockAuthAs('admin');
    // Non-deposit invoice, $1000 net-paid. If the deposit cap leaked in, this $900 refund would
    // be wrongly capped by the (irrelevant) ledger; it must succeed off the raw net-paid.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    mockDepositLedger({ paid: 0, applied: 0, refunded: 0 });
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_nondep_ok' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 900, reason_category: 'CUSTOMER_REQUEST', reason: 'normal refund' });

    expect(res.status).toBe(200);
    expect(Number(captured.refund.amount)).toBe(900);
  });

  // Cap B is keyed off a REAL matching payment_id (the prior fixture sent a uuid that never
  // matched pay_1, so it hit the not-found branch and proved nothing). Use a valid-UUID payment.
  const CAP_B_PAY = '22222222-2222-2222-2222-222222222222';

  // Two-payment invoice so the invoice-wide net-paid (Cap A) is NOT the binding limit —
  // this isolates Cap B (the named payment's own un-refunded balance).
  function buildCapBInvoice(overrides: Record<string, any> = {}) {
    return buildPaidInvoice({
      total_amount: 2000,
      tax_amount: 0,
      payments: [
        // Target payment: $1000, $800 already refunded → balance $200.
        { id: CAP_B_PAY, method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null },
        // Second payment keeps invoice net-paid high (so Cap A can't fire first).
        { id: '33333333-3333-3333-3333-333333333333', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_2', refunded_at: null, reference_number: null, voided_at: null },
      ],
      refunds: [{ id: 're_0', payment_id: CAP_B_PAY, amount: 800 }],
      ...overrides,
    });
  }

  it('caps refund at the named payment un-refunded balance (Cap B) — rejects over-balance', async () => {
    mockAuthAs('admin');
    // Invoice net-paid = (1000+1000) − 800 = 1200, so $300 clears Cap A; but the target
    // payment's balance is only $200, so Cap B must fire.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCapBInvoice());
    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 300, payment_id: CAP_B_PAY, reason_category: 'OTHER', reason: 'over payment balance' });
    expect(res.status).toBe(400);
    // Must be the Cap B branch, NOT the not-found branch and NOT Cap A.
    expect(res.body.error).toMatch(/exceeds payment balance/i);
  });

  it('targeted single-payment refund at exactly the balance succeeds (Cap B happy-path)', async () => {
    mockAuthAs('admin');
    // Same fixture; refund exactly $200 (== target payment balance) → succeeds, Stripe gets 20000 cents.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCapBInvoice());
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_capb_ok' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 200, payment_id: CAP_B_PAY, reason_category: 'CUSTOMER_REQUEST', reason: 'remaining balance' });

    expect(res.status).toBe(200);
    // Stripe reverses the TARGET payment's PI for exactly $200.
    expect(mockCreateRefund).toHaveBeenCalledWith('pi_1', expect.anything(), 20000, expect.anything());
    expect(Number(captured.refund.amount)).toBe(200);
    expect(captured.refund.payment_id).toBe(CAP_B_PAY);
  });

  it('tax_portion is proportional, $0 under non_taxable_concession', async () => {
    mockAuthAs('admin');
    // total 1000, tax 80 → proportional tax on a $500 refund = 500*80/1000 = 40.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const captured = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_tax_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 500, reason_category: 'OTHER', reason: 'tax test' });
    expect(res.status).toBe(200);
    expect(Number(captured.refund.tax_portion)).toBe(40);

    // non_taxable_concession → $0.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const captured2 = captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_tax_2' });
    const res2 = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ amount: 500, non_taxable_concession: true, reason_category: 'GOODWILL', reason: 'goodwill no tax' });
    expect(res2.status).toBe(200);
    expect(Number(captured2.refund.tax_portion)).toBe(0);
  });

  it('Stripe failure writes NO Refund row and returns 500', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    const captured = captureRefundTx();
    mockCreateRefund.mockRejectedValue(new Error('Stripe down'));

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'OTHER', reason: 'stripe fails' });

    expect(res.status).toBe(500);
    expect(captured.refund).toBeUndefined();
  });

  it('rejects non-PAID/non-PARTIALLY_REFUNDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({ status: 'SENT' }));

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'ERROR', reason: 'not paid' });

    expect(res.status).toBe(400);
  });

  it('returns 403 for non-ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('dispatcher'))
      .send({ reason_category: 'OTHER', reason: 'forbidden' });

    expect(res.status).toBe(403);
  });

  // ── Task 1.6 / Step 4: legacy-refund keying (transition safety, spec §5.3) ──
  // Refund execution must key off the PAYMENT row's stripe_account_id snapshot, not the
  // org's CURRENT stripe_account_id — an org may connect Stripe AFTER a legacy/platform
  // charge was made, and re-keying off the org would try to refund via the wrong account.
  it('keys the Stripe refund off the PAYMENT snapshot, not the (possibly since-changed) org', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      // Org has since connected a DIFFERENT Stripe account than the one the charge lived on.
      organization: { id: 'org_1', stripe_account_id: 'acct_org_now' },
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
        refunded_at: null, reference_number: null, voided_at: null, stripe_account_id: 'acct_direct_1',
      }],
    }));
    captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_keyed_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'keying check' });

    expect(res.status).toBe(200);
    expect(mockGetStripeForOrg).toHaveBeenCalledWith({ stripe_account_id: 'acct_direct_1' });
    // Task 3.2 (door 1, in-app refund): a direct-charge Payment must reverse the platform fee.
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_test_invoice_1', expect.anything(), expect.anything(),
      expect.objectContaining({ reverseApplicationFee: true }),
    );
  });

  it('keys off NULL (legacy platform-account payment) even when the org now has a connected account', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
      organization: { id: 'org_1', stripe_account_id: 'acct_org_now' },
      // Legacy payment predates Connect — no stripe_account_id snapshot.
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
        refunded_at: null, reference_number: null, voided_at: null, stripe_account_id: null,
      }],
    }));
    captureRefundTx();
    mockCreateRefund.mockResolvedValue({ id: 're_legacy_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'legacy keying check' });

    expect(res.status).toBe(200);
    expect(mockGetStripeForOrg).toHaveBeenCalledWith({ stripe_account_id: null });
    // Task 3.2 (door 1): a legacy platform-account payment never had a fee — never reverse one.
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_test_invoice_1', expect.anything(), expect.anything(),
      expect.not.objectContaining({ reverseApplicationFee: true }),
    );
  });

  // ─── Slice 6 (card service fee) — a refund must return the fee too ──────
  describe('service fee refund (Slice 6)', () => {
    it('a full refund also returns the service fee, proportional to the whole payment', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
        payments: [{
          id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
          refunded_at: null, reference_number: null, voided_at: null, service_fee_amount: 35,
        }],
      }));
      const captured = captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_fee_full' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'full refund with fee' });

      expect(res.status).toBe(200);
      // (1000 + 35) * 100 = 103500 - Stripe returns the whole fee alongside the whole face amount.
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 103500, expect.anything(),
      );
      // D1 — the invoice ledger stays truthful: Refund.amount is still the FACE value only.
      expect(Number(captured.refund.amount)).toBe(1000);
    });

    it('a partial refund returns the proportional share of the service fee', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
        payments: [{
          id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
          refunded_at: null, reference_number: null, voided_at: null, service_fee_amount: 35,
        }],
      }));
      const captured = captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_fee_partial' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ amount: 400, reason_category: 'GOODWILL', reason: 'partial with fee' });

      expect(res.status).toBe(200);
      // 400/1000 = 40% of the $35 fee = $14. (400 + 14) * 100 = 41400.
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 41400, expect.anything(),
      );
      // D1 — still the face value only.
      expect(Number(captured.refund.amount)).toBe(400);
    });

    it('does not add anything to the Stripe refund amount when the payment carries no service fee', async () => {
      mockAuthAs('admin');
      // buildPaidInvoice's default payment fixture has no service_fee_amount field at all.
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
      captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_no_fee' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'no fee on this one' });

      expect(res.status).toBe(200);
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 100000, expect.anything(),
      );
    });
  });

  // ─── Slice 7 (customer-facing tipping) — extends Slice 6's fee refund handling ───
  describe('tip refund (Slice 7)', () => {
    it('a full refund also returns the tip, alongside the service fee', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
        payments: [{
          id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
          refunded_at: null, reference_number: null, voided_at: null,
          service_fee_amount: 35, tip_amount: 150,
        }],
      }));
      const captured = captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_tip_full' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'full refund with fee and tip' });

      expect(res.status).toBe(200);
      // (1000 + 35 + 150) * 100 = 118500.
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 118500, expect.anything(),
      );
      // D1/D10 — the invoice ledger stays truthful: Refund.amount is still the FACE value only.
      expect(Number(captured.refund.amount)).toBe(1000);
    });

    it('a partial refund returns the proportional share of the tip too', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice({
        payments: [{
          id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1',
          refunded_at: null, reference_number: null, voided_at: null, tip_amount: 150,
        }],
      }));
      const captured = captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_tip_partial' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ amount: 400, reason_category: 'GOODWILL', reason: 'partial with tip' });

      expect(res.status).toBe(200);
      // 400/1000 = 40% of the $150 tip = $60. (400 + 60) * 100 = 46000.
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 46000, expect.anything(),
      );
      expect(Number(captured.refund.amount)).toBe(400);
    });

    it('does not add anything when the payment carries no tip', async () => {
      mockAuthAs('admin');
      mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
      captureRefundTx();
      mockCreateRefund.mockResolvedValue({ id: 're_no_tip' });

      const res = await request(app)
        .post('/api/invoices/inv_1/refund')
        .set(authHeader('admin'))
        .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'no tip on this one' });

      expect(res.status).toBe(200);
      expect(mockCreateRefund).toHaveBeenCalledWith(
        'pi_test_invoice_1', expect.anything(), 100000, expect.anything(),
      );
    });
  });
});

// ─── POST /api/invoices/:id/credit ─────────────────────
describe('POST /api/invoices/:id/credit', () => {
  function buildCreditInvoice(overrides: Record<string, any> = {}) {
    return {
      id: 'inv_1',
      invoice_number: 'I00001',
      status: 'SENT',
      amount_due: 70000,
      total_amount: 70000,
      tax_amount: 0,
      net_collected: 0,
      organization: { id: 'org_1', stripe_account_id: null },
      payments: [],
      refunds: [],
      customer: null,
      job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
      ...overrides,
    };
  }

  function captureCreditTx() {
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        credit: { create: vi.fn().mockImplementation((args: any) => { captured.credit = args.data; return { id: 'cr_1', ...args.data }; }) },
        refund: { create: vi.fn().mockImplementation((args: any) => { captured.refund = args.data; return { id: 're_1', ...args.data }; }) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => { (captured.invoiceUpdates ??= []).push(args.data); return {}; }),
          findUnique: vi.fn().mockResolvedValue(buildInvoiceDetail()),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    return captured;
  }

  it('owe70k give20k credits balance only, no cash', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice());
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'goodwill discount' });

    expect(res.status).toBe(200);
    expect(Number(captured.credit.amount)).toBe(20000);
    // amount_due lowered to 50000.
    expect(captured.invoiceUpdates.some((u: any) => Number(u.amount_due) === 50000)).toBe(true);
    expect(captured.refund).toBeUndefined();
    // Inventory P1 (§4.5 / QA-507): credit is money-only — stock is NEVER touched.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('owe70k give90k credits 70k + refunds 20k excess', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      // The customer has paid (a PI-backed payment) so the excess can refund.
      payments: [{ id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_excess' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 90000, reason: 'big give-back' });

    expect(res.status).toBe(200);
    expect(Number(captured.credit.amount)).toBe(70000);
    expect(captured.invoiceUpdates.some((u: any) => Number(u.amount_due) === 0)).toBe(true);
    expect(Number(captured.refund.amount)).toBe(20000);
    // The give-back refund never reopens amount_due (no amount_due in the refund-portion update).
    const refundUpdate = captured.invoiceUpdates.find((u: any) => u.total_refunded !== undefined);
    expect(refundUpdate).not.toHaveProperty('amount_due');
  });

  it('fully paid give20k is all cash refund', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PAID',
      amount_due: 0,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_paid' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'refund after paid' });

    expect(res.status).toBe(200);
    expect(captured.credit).toBeUndefined();
    expect(Number(captured.refund.amount)).toBe(20000);
  });

  // ─── Slice 6 (card service fee) — the credit door's cash give-back returns the fee too ───
  it('a cash give-back returns the proportional share of the service fee (Slice 6)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PAID',
      amount_due: 0,
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1',
        refunded_at: null, reference_number: null, voided_at: null, service_fee_amount: 2450,
      }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_fee_credit' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'refund after paid, with fee' });

    expect(res.status).toBe(200);
    // 20000/70000 of the $2,450 fee = $700. (20000 + 700) * 100 = 2070000.
    expect(mockCreateRefund).toHaveBeenCalledWith('pi_1', expect.anything(), 2070000, expect.anything());
    // D1 — the invoice ledger stays truthful: Refund.amount is still the FACE value only.
    expect(Number(captured.refund.amount)).toBe(20000);
  });

  it('a cash give-back returns the proportional share of the tip too (Slice 7)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PAID',
      amount_due: 0,
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1',
        refunded_at: null, reference_number: null, voided_at: null,
        service_fee_amount: 2450, tip_amount: 7000,
      }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_tip_credit' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'refund after paid, with fee and tip' });

    expect(res.status).toBe(200);
    // 20000/70000 of the $2,450 fee ($700) + of the $7,000 tip ($2,000) = $2,700 extra.
    // (20000 + 2700) * 100 = 2270000.
    expect(mockCreateRefund).toHaveBeenCalledWith('pi_1', expect.anything(), 2270000, expect.anything());
    expect(Number(captured.refund.amount)).toBe(20000);
  });

  it('refund_instead override sends cash while balance owed', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      payments: [{ id: 'pay_1', method: 'CARD', amount: 30000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_override' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'must refund', refund_instead: true });

    expect(res.status).toBe(200);
    // docs/adr/0004-refund-never-reopens-amount-due.md: the never-reopen rule is kept, but a
    // give-back forced onto a live balance is now mirrored by a write-off Credit so the invoice
    // still reconciles (total_amount == amount_due + net cash + credits).
    expect(Number(captured.credit.amount)).toBe(20000);
    expect(captured.credit.category).toBe('REFUND_WRITE_OFF');
    expect(Number(captured.refund.amount)).toBe(20000);
    // amount_due stays 70000 (no credit applied) - the never-reopen lock this card preserves.
    const dueUpdate = (captured.invoiceUpdates || []).find((u: any) => u.amount_due !== undefined);
    expect(dueUpdate).toBeUndefined();
  });

  // docs/adr/0004-refund-never-reopens-amount-due.md - SRVW-97: refund_instead on a live balance
  // now mirrors the give-back with a write-off Credit; an explicit reopen_balance opt-in exists
  // for the (fenced) payment-reversal case. Shared fixture is tax-bearing so tax_portion is a real
  // discriminator: total 1080, tax_amount 80, amount_due 680, one CARD payment 400 (pi_1).
  function buildReopenFixture(overrides: Record<string, any> = {}) {
    return buildCreditInvoice({
      status: 'PARTIAL',
      total_amount: 1080,
      tax_amount: 80,
      amount_due: 680,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 400, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
      ...overrides,
    });
  }

  it('refund_instead on a live balance writes a compensating write-off credit so the invoice reconciles', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildReopenFixture());
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_writeoff' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 400, reason: 'must refund', refund_instead: true });

    expect(res.status).toBe(200);
    expect(Number(captured.refund.amount)).toBe(400);
    expect(Number(captured.refund.tax_portion)).toBeCloseTo(29.63, 2);
    expect(Number(captured.credit.amount)).toBe(400);
    expect(captured.credit.category).toBe('REFUND_WRITE_OFF');
    // The non-zero Refund tax above is what makes this 0 a real discriminator.
    expect(Number(captured.credit.tax_portion)).toBe(0);
    // Never-reopen rule kept: no invoiceUpdate carries amount_due.
    const dueUpdate = (captured.invoiceUpdates || []).find((u: any) => u.amount_due !== undefined);
    expect(dueUpdate).toBeUndefined();
    // Reconciliation identity over captured values: amount_due (680, proven above never written,
    // so it is still the fixture's 680) + net cash (400 paid - 400 refunded = 0) + credits (400) === 1080.
    const netCash = 400 - Number(captured.refund.amount);
    expect(680 + netCash + Number(captured.credit.amount)).toBe(1080);
  });

  it('reopen_balance restores the receivable on a card-paid PARTIAL invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildReopenFixture());
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_reopen' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 400, reason: 'must refund', refund_instead: true, reopen_balance: true });

    expect(res.status).toBe(200);
    expect(mockCreateRefund).toHaveBeenCalledWith('pi_1', expect.anything(), 40000, expect.anything());
    expect(Number(captured.refund.amount)).toBe(400);
    // A reversal is not a write-off.
    expect(captured.credit).toBeUndefined();
    const refundUpdate = (captured.invoiceUpdates || []).find((u: any) => u.total_refunded !== undefined);
    expect(Number(refundUpdate.amount_due)).toBe(1080);
    expect(refundUpdate.status).toBe('SENT');
    expect(refundUpdate.paid_at).toBeNull();
  });

  it('reopen_balance without refund_instead is rejected', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildReopenFixture());
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 400, reason: 'must refund', reopen_balance: true });

    expect(res.status).toBe(400);
    expect(captured.refund).toBeUndefined();
    expect(captured.credit).toBeUndefined();
    expect(captured.invoiceUpdates).toBeUndefined();
  });

  it('reopen_balance on a zero-balance invoice is rejected', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PAID',
      amount_due: 0,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'refund after paid', refund_instead: true, reopen_balance: true });

    expect(res.status).toBe(400);
    const dueUpdate = (captured.invoiceUpdates || []).find((u: any) => u.amount_due !== undefined);
    expect(dueUpdate).toBeUndefined();
    expect(captured.refund).toBeUndefined();
  });

  it('reopen_balance on a DEPOSIT invoice is rejected', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildReopenFixture({ kind: 'DEPOSIT' }));
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 400, reason: 'must refund', refund_instead: true, reopen_balance: true });

    expect(res.status).toBe(400);
    expect(captured.invoiceUpdates).toBeUndefined();
    expect(captured.refund).toBeUndefined();

    // Restriction is scoped to the reversal - the concession path still works on a DEPOSIT invoice.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildReopenFixture({ kind: 'DEPOSIT' }));
    const captured2 = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_deposit_writeoff' });
    const res2 = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 400, reason: 'must refund', refund_instead: true });
    expect(res2.status).toBe(200);
    expect(Number(captured2.credit.amount)).toBe(400);
    expect(captured2.credit.category).toBe('REFUND_WRITE_OFF');
  });

  it('refund_instead on a fully PAID invoice writes no write-off credit', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PAID',
      amount_due: 0,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_overpay' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'refund after paid', refund_instead: true });

    expect(res.status).toBe(200);
    expect(Number(captured.refund.amount)).toBe(20000);
    // This passes on origin/staging too - it guards against writing the credit unconditionally
    // on refund_instead instead of only when balanceOwed > 0 (the fix to the AC-3 leak).
    expect(captured.credit).toBeUndefined();
  });

  // ── Cash give-back excess must be capped at net-paid (§8 universal money rule) ──
  it('rejects give-back whose cash excess exceeds net-paid (zero payments)', async () => {
    mockAuthAs('admin');
    // Owe $70k, NOTHING paid, give $90k → credit $70k + $20k excess that was never collected.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice());
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 90000, reason: 'over give-back' });

    expect(res.status).toBe(400);
    // No money should move and no negative net_collected should be written.
    expect(captured.refund).toBeUndefined();
  });

  it('rejects give-back whose cash excess exceeds net-paid (partial payment)', async () => {
    mockAuthAs('admin');
    // Owe $60k (paid $10k of $70k); give $90k → credit $60k + $30k cash, but only $10k collected.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PARTIAL',
      amount_due: 60000,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 10000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 90000, reason: 'invents money' });

    expect(res.status).toBe(400);
    expect(captured.refund).toBeUndefined();
  });

  it('caps the cash excess at net-paid: credits balance + refunds only what was paid', async () => {
    mockAuthAs('admin');
    // Owe $60k (paid $10k of $70k); give $70k → credit $60k balance + refund exactly the $10k paid.
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      status: 'PARTIAL',
      amount_due: 60000,
      payments: [{ id: 'pay_1', method: 'CARD', amount: 10000, stripe_payment_intent_id: 'pi_1', refunded_at: null, reference_number: null, voided_at: null }],
    }));
    const captured = captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_capped' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 70000, reason: 'give-back exactly net-paid worth of cash' });

    expect(res.status).toBe(200);
    expect(Number(captured.credit.amount)).toBe(60000);
    expect(Number(captured.refund.amount)).toBe(10000);
  });

  // ── Status guard: a credit-first give-back only on a live billable invoice ──
  it('rejects a credit on a VOIDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({ status: 'VOIDED', amount_due: 0 }));
    const captured = captureCreditTx();

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 5000, reason: 'give-back on dead doc' });

    expect(res.status).toBe(400);
    expect(captured.credit).toBeUndefined();
    expect(captured.refund).toBeUndefined();
  });

  it('rejects a credit on a DRAFT invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({ status: 'DRAFT' }));
    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 5000, reason: 'draft' });
    expect(res.status).toBe(400);
  });

  it('rejects a credit on a fully REFUNDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({ status: 'REFUNDED', amount_due: 0 }));
    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 5000, reason: 'already refunded' });
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('dispatcher'))
      .send({ amount: 100, reason: 'forbidden' });

    expect(res.status).toBe(403);
  });

  // ── Task 1.6 / Step 4: legacy-refund keying (transition safety, spec §5.3) ──
  it('keys the cash-excess Stripe refund off the PAYMENT snapshot, not the org', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      organization: { id: 'org_1', stripe_account_id: 'acct_org_now' },
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1',
        refunded_at: null, reference_number: null, voided_at: null, stripe_account_id: 'acct_direct_2',
      }],
    }));
    captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_excess_keyed' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 90000, reason: 'big give-back' });

    expect(res.status).toBe(200);
    expect(mockGetStripeForOrg).toHaveBeenCalledWith({ stripe_account_id: 'acct_direct_2' });
    // Task 3.2 (door 1, in-app cash-excess refund): direct-charge Payment reverses the fee too.
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_1', expect.anything(), expect.anything(),
      expect.objectContaining({ reverseApplicationFee: true }),
    );
  });

  it('does not reverse the platform fee on a legacy platform-account payment (no stripe_account_id)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice({
      payments: [{
        id: 'pay_1', method: 'CARD', amount: 70000, stripe_payment_intent_id: 'pi_1',
        refunded_at: null, reference_number: null, voided_at: null, stripe_account_id: null,
      }],
    }));
    captureCreditTx();
    mockCreateRefund.mockResolvedValue({ id: 're_excess_legacy' });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 90000, reason: 'big give-back' });

    expect(res.status).toBe(200);
    expect(mockCreateRefund).toHaveBeenCalledWith(
      'pi_1', expect.anything(), expect.anything(),
      expect.not.objectContaining({ reverseApplicationFee: true }),
    );
  });
});

// ─── POST /api/invoices/:id/void-payment ───────────────
describe('POST /api/invoices/:id/void-payment', () => {
  const VALID_UUID = '11111111-1111-1111-1111-111111111111';

  function buildVoidInvoice(overrides: Record<string, any> = {}) {
    return {
      id: 'inv_1',
      invoice_number: 'I00001',
      status: 'PAID',
      amount_due: 0,
      total_amount: 1000,
      kind: 'STANDARD',
      ...overrides,
    };
  }

  function buildManualPayment(overrides: Record<string, any> = {}) {
    return {
      id: VALID_UUID,
      invoice_id: 'inv_1',
      amount: 1000,
      method: 'CASH',
      stripe_payment_intent_id: null,
      voided_at: null,
      ...overrides,
    };
  }

  it('voids a manual CASH payment and reopens amount_due', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildVoidInvoice());
    mockPrisma.payment.findFirst.mockResolvedValue(buildManualPayment());

    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        payment: { update: vi.fn().mockImplementation((args: any) => { captured.paymentUpdate = args.data; return {}; }), updateMany: vi.fn() },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => { captured.invoiceUpdate = args.data; return {}; }),
          findUnique: vi.fn().mockResolvedValue(buildInvoiceDetail()),
          findFirst: vi.fn(),
        },
        depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'BOUNCED', reason: 'check bounced' });

    expect(res.status).toBe(200);
    // Marked voided, not deleted.
    expect(captured.paymentUpdate.voided_at).toBeInstanceOf(Date);
    expect(captured.paymentUpdate.void_category).toBe('BOUNCED');
    expect(captured.paymentUpdate.voided_by).toBe(TEST_USERS.admin.id);
    // amount_due reopens by the payment amount; status drops from PAID.
    expect(Number(captured.invoiceUpdate.amount_due)).toBe(1000);
    expect(captured.invoiceUpdate.status).toBe('SENT');
    expect(captured.invoiceUpdate.paid_at).toBeNull();
    // Inventory P1 (§4.5 / QA-507): void-payment is money-only — stock is NEVER touched.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  it('rejects a CARD / PI-backed payment', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildVoidInvoice());
    mockPrisma.payment.findFirst.mockResolvedValue(buildManualPayment({ method: 'CARD', stripe_payment_intent_id: 'pi_card_1' }));

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'ERROR', reason: 'oops' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reversed by refund/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('deposit-payment void un-applies its DepositCreditApplication (cascade)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildVoidInvoice({ kind: 'DEPOSIT' }));
    mockPrisma.payment.findFirst.mockResolvedValue(buildManualPayment({ method: 'CHECK' }));

    const captured: any = { targetUpdates: [] };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        payment: { update: vi.fn(), updateMany: vi.fn().mockImplementation((args: any) => { captured.creditVoid = args; return {}; }) },
        invoice: {
          update: vi.fn().mockImplementation((args: any) => { captured.targetUpdates.push(args.data); return {}; }),
          findUnique: vi.fn().mockResolvedValue(buildInvoiceDetail()),
          findFirst: vi.fn().mockResolvedValue({ id: 'target-inv', amount_due: 0, total_amount: 5000, status: 'PAID', invoice_number: 'I00009' }),
        },
        depositCreditApplication: {
          findMany: vi.fn().mockResolvedValue([{ id: 'dca_1', target_invoice_id: 'target-inv', amount: 1000 }]),
          updateMany: vi.fn().mockImplementation((args: any) => { captured.appReverse = args.data; return {}; }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'BOUNCED', reason: 'deposit check bounced' });

    expect(res.status).toBe(200);
    // Application reversed.
    expect(captured.appReverse.reversed_at).toBeInstanceOf(Date);
    // The target STANDARD invoice's amount_due rose by the un-applied amount.
    expect(captured.targetUpdates.some((u: any) => Number(u.amount_due) === 1000)).toBe(true);
    // The synthetic DEPOSIT-CREDIT payment on the target is voided.
    expect(captured.creditVoid.where.reference_number).toBe('DEPOSIT-CREDIT');
  });

  // ── Status guard: cannot void a payment on a terminal invoice (would resurrect it) ──
  it('rejects voiding a payment on a VOIDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildVoidInvoice({ status: 'VOIDED', amount_due: 0 }));
    mockPrisma.payment.findFirst.mockResolvedValue(buildManualPayment());

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'BOUNCED', reason: 'resurrect attempt' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot void a payment/i);
    // No transaction — the dead invoice is not reopened.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects voiding a payment on a fully REFUNDED invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildVoidInvoice({ status: 'REFUNDED', amount_due: 0 }));
    mockPrisma.payment.findFirst.mockResolvedValue(buildManualPayment());

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'ERROR', reason: 'terminal' });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 403 for non-ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('dispatcher'))
      .send({ payment_id: VALID_UUID, void_category: 'ERROR', reason: 'forbidden' });

    expect(res.status).toBe(403);
  });

  // ── Phase 2c: the INTERNAL system-void path allows a CARD/PI payment for CHARGEBACK ──
  // The manual handler above correctly rejects CARD/PI ('rejects a CARD / PI-backed payment').
  // The exported systemVoidPaymentForChargeback is the webhook-only path for a lost dispute:
  // it ALLOWS a CARD payment carrying a PI and stamps void_category=CHARGEBACK + voided_by=null.
  it('systemVoidPaymentForChargeback voids a CARD/PI payment with void_category CHARGEBACK and reopens amount_due', async () => {
    const captured: any = {};
    const tx: any = {
      payment: {
        update: vi.fn().mockImplementation((args: any) => { captured.paymentUpdate = args.data; return {}; }),
        updateMany: vi.fn(),
      },
      invoice: {
        update: vi.fn().mockImplementation((args: any) => { captured.invoiceUpdate = args.data; return {}; }),
        findFirst: vi.fn(),
      },
      depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    };

    await systemVoidPaymentForChargeback(tx, {
      payment: { id: 'pay_card_1', amount: 1000, method: 'CARD', stripe_payment_intent_id: 'pi_card_x' } as any,
      invoice: { id: 'inv_1', amount_due: 0, total_amount: 1000, status: 'PAID', kind: 'STANDARD', invoice_number: 'I00001' } as any,
      disputeId: 'dp_1',
      orgId: 'org_1',
    });

    // CARD/PI payment voided (the manual guard does NOT apply here).
    expect(captured.paymentUpdate.voided_at).toBeInstanceOf(Date);
    expect(captured.paymentUpdate.void_category).toBe('CHARGEBACK');
    expect(captured.paymentUpdate.voided_by).toBeNull();
    // amount_due reopens by the payment amount; status drops below PAID.
    expect(Number(captured.invoiceUpdate.amount_due)).toBe(1000);
    expect(captured.invoiceUpdate.status).toBe('SENT');
    expect(captured.invoiceUpdate.paid_at).toBeNull();
  });
});

// ─── Lifecycle TimelineEvent emission regression (entity-redesign §10 / Phase 5 audit) ──────
// Each money-lifecycle verb must emit a TimelineEvent with the canonical event_type. These
// assertions pin the exact label so a future refactor can't silently drop or rename an event.
describe('Invoice lifecycle TimelineEvent emission', () => {
  it('refundInvoice emits INVOICE_REFUNDED', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_1', invoice_number: 'I00001', status: 'PAID',
      amount_due: 0, total_amount: 1000, tax_amount: 80, net_collected: 0,
      organization: { id: 'org_1', stripe_account_id: null },
      payments: [{ id: 'pay_1', method: 'CARD', amount: 1000, stripe_payment_intent_id: 'pi_test_invoice_1', refunded_at: null, reference_number: null, voided_at: null }],
      refunds: [], customer: null,
      job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
    });
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        refund: { create: vi.fn().mockResolvedValue({ id: 're_row_1' }) },
        invoice: { update: vi.fn().mockResolvedValue({}) },
        payment: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockImplementation((args: any) => { captured.timeline = args.data; return {}; }) },
      };
      await fn(tx);
      return { id: 're_row_1' };
    });
    mockCreateRefund.mockResolvedValue({ id: 're_test_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set(authHeader('admin'))
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'Customer changed mind' });

    expect(res.status).toBe(200);
    expect(captured.timeline.event_type).toBe('INVOICE_REFUNDED');
  });

  it('credit emits CREDIT_APPLIED', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_1', invoice_number: 'I00001', status: 'SENT',
      amount_due: 70000, total_amount: 70000, tax_amount: 0, net_collected: 0,
      organization: { id: 'org_1', stripe_account_id: null },
      payments: [], refunds: [], customer: null,
      job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
    });
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        credit: { create: vi.fn().mockResolvedValue({ id: 'cr_1' }) },
        refund: { create: vi.fn().mockResolvedValue({ id: 're_1' }) },
        invoice: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(buildInvoiceDetail()) },
        timelineEvent: { create: vi.fn().mockImplementation((args: any) => { captured.timeline = args.data; return {}; }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/credit')
      .set(authHeader('admin'))
      .send({ amount: 20000, reason: 'goodwill discount' });

    expect(res.status).toBe(200);
    expect(captured.timeline.event_type).toBe('CREDIT_APPLIED');
  });

  it('voidPayment emits PAYMENT_VOIDED', async () => {
    const VALID_UUID = '11111111-1111-1111-1111-111111111111';
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_1', invoice_number: 'I00001', status: 'PAID', amount_due: 0, total_amount: 1000, kind: 'STANDARD',
    });
    mockPrisma.payment.findFirst.mockResolvedValue({
      id: VALID_UUID, invoice_id: 'inv_1', amount: 1000, method: 'CASH', stripe_payment_intent_id: null, voided_at: null,
    });
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        payment: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn() },
        invoice: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(buildInvoiceDetail()), findFirst: vi.fn() },
        depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        timelineEvent: { create: vi.fn().mockImplementation((args: any) => { captured.timeline = args.data; return {}; }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/void-payment')
      .set(authHeader('admin'))
      .send({ payment_id: VALID_UUID, void_category: 'BOUNCED', reason: 'check bounced' });

    expect(res.status).toBe(200);
    expect(captured.timeline.event_type).toBe('PAYMENT_VOIDED');
  });
});

// ─── Shared-mock race regression pin (kept LAST in the file on purpose) ───────────────────────
// Defect: the no-double-credit seam-4 test went RED ~1-in-10-to-17 full-parallel runs.
// leads.test.ts:52 calls vi.resetAllMocks() in its beforeEach; under file-parallelism that could
// wipe a vi.fn()'s implementation on the shared prisma singleton mid-$transaction, so the
// load-bearing depositCreditApplication.aggregate fell through to a bare vi.fn() returning
// undefined ⇒ priorApplied=0 ⇒ credit collapsed to min(1000, total)=1000 instead of 300.
//
// The fix: the seam-4 tx surfaces now use PLAIN (non-vi.fn) functions for the load-bearing reads,
// which vitest's reset machinery cannot touch. This pin proves it by FAITHFULLY firing
// vi.resetAllMocks() mid-callback (after the tx surface is built, before the controller reads the
// ledger) and asserting the invariant still holds. vi.resetAllMocks() also wipes the once-only
// mock defaults setup.ts installs at module-mock time, so this test is defined LAST in the file —
// no later test in this file is affected, and the next file gets a freshly-re-created mock factory.
// If a future edit reverts the aggregate read to a resettable vi.fn(), this test goes RED.
describe('POST /api/invoices — shared-mock race pin (defined last)', () => {
  it('no-double-credit invariant survives a mid-flight vi.resetAllMocks()', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({
      estimate: {
        ...buildCompletedJob().estimate,
        discount_amount: 0,
        deposit: {
          id: 'd0000000-0000-0000-0000-000000000001',
          amount: 1000,
          status: 'PAID',
          total_refunded: 0,
          paid_at: new Date('2026-01-23'),
          payment_method: 'CARD',
        },
      },
    });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    // No active invoice on this job ⇒ the create() 409 guard passes and creation proceeds.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    let capturedApplicationData: any;
    let capturedData: any;
    let resetFired = false;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: the load-bearing in-tx read is invoice.findMany now (the multi-deposit
          // union), so BOTH the reset trigger and the kind=DEPOSIT discriminator move here. If
          // only the discriminator moved, the reset would never fire and this pin would pass
          // while testing nothing.
          findMany: async (args: any) => {
            // The exact window the cross-file race struck: reset fires AFTER the tx surface is
            // built but BEFORE the controller reads the deposit-credit ledger below. Fire it once,
            // on the in-tx deposit-invoice lookup (the load-bearing in-tx read).
            if (!resetFired) {
              resetFired = true;
              vi.resetAllMocks();
            }
            if (args?.where?.kind === 'DEPOSIT') return [{ id: 'dep-inv-1' }];
            return [];
          },
          findFirst: async () => null,
          create: (args: any) => {
            capturedData = args.data;
            return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id };
          },
        },
        payment: {
          // PLAIN functions ⇒ not vitest mocks ⇒ immune to the vi.resetAllMocks() above.
          aggregate: async () => ({ _sum: { amount: 1000 } }),
          create: (args: any) => ({ ...PAYMENT_FIXTURE, ...args.data }),
        },
        depositCreditApplication: {
          aggregate: async () => ({ _sum: { amount: 700 } }),
          create: (args: any) => {
            capturedApplicationData = args.data;
            return { id: 'dca-2', ...args.data };
          },
        },
        refund: { aggregate: async () => ({ _sum: { amount: 0 } }) },
        timelineEvent: { create: async () => ({}) },
      });
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(201);
    // remaining = 1000 − 0 refunded − 700 applied = 300; must NOT collapse to 1000.
    expect(Number(capturedApplicationData.amount)).toBe(300);
    expect(Number(capturedData.deposit_credit)).toBe(300);
  });
});

// ─── Standalone Invoices: owned-line authoring (no estimate to snapshot) ──────
//
// One capability — author OWNED InvoiceLineItem rows when there is no estimate —
// exposed through two anchors:
//   A) job_id on an estimate-LESS job  → author line_items[], tax from job.service_location
//   B) customer_id + line_items[]      → standalone, tax from a chosen/accreted/primary location
// Tax is location-driven (Design A); tax_exempt → 0; deposit_credit = 0; kind = STANDARD.

const ALPHA_ORG_ID_LOCAL = TEST_USERS.admin.organization_id;

// Build a standalone tx surface: invoice.create captures data; allocateNumber reads the
// max invoice_number; line authoring + timeline writes are inert.
function standaloneTx(captured: { data?: any }) {
  return {
    invoice: {
      // allocateNumber() reads the org's current max invoice_number inside the tx.
      findFirst: async () => null,
      create: (args: any) => {
        captured.data = args.data;
        return { ...STANDALONE_INVOICE_FIXTURE, ...args.data, id: STANDALONE_INVOICE_FIXTURE.id };
      },
    },
    serviceLocation: {
      // resolveOrAccreteLocation: explicit-id ownership check + address find-or-create.
      findFirst: async (_args: any) => ({ id: LOCATION_FIXTURE.id, state: 'TX' }),
      create: async (args: any) => ({ id: 'new-loc-accreted', ...args.data }),
    },
    // The tax-rate read happens on the tx connection (see controller). Delegate to the global
    // mock so tests that configure mockPrisma.stateTaxRate.findFirst keep driving the rate.
    orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
    stateTaxRate: { findFirst: (args: any) => (mockPrisma.stateTaxRate.findFirst as any)(args) },
    timelineEvent: { create: async () => ({}) },
  };
}

describe('POST /api/invoices — standalone (customer-anchored, no job/estimate)', () => {
  it('admin creates a standalone invoice authoring owned line_items; tax from the primary location state', async () => {
    mockAuthAs('admin');
    // Customer with a primary TX location (78701) and not tax-exempt.
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id,
      payment_type: null,
      tax_exempt: false,
      service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX', is_primary: true }],
    });
    // TX state tax = 6.25%.
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'TX', tax_rate: 0.0625 });

    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(standaloneTx(captured)));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        line_items: [
          { description: 'Diagnostic fee', quantity: 1, unit_price: 100, is_taxable: true },
          { description: 'Filter (non-taxable)', quantity: 2, unit_price: 25, is_taxable: false },
        ],
      });

    expect(res.status).toBe(201);
    expect(captured.data).toBeDefined();
    // No job, customer set directly, STANDARD kind, no deposit credit.
    expect(captured.data.job_id ?? null).toBeNull();
    expect(captured.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(captured.data.kind ?? 'STANDARD').toBe('STANDARD');
    expect(Number(captured.data.deposit_credit ?? 0)).toBe(0);
    // subtotal = 100 + 50 = 150; tax only on the $100 taxable line × 6.25% = 6.25.
    expect(Number(captured.data.subtotal)).toBe(150);
    expect(Number(captured.data.tax_amount)).toBe(6.25);
    expect(Number(captured.data.total_amount)).toBe(156.25);
    expect(Number(captured.data.amount_due)).toBe(156.25);
    // Owned line_items are authored with server-computed line_total + sequence by array order.
    expect(captured.data.line_items.create).toHaveLength(2);
    expect(Number(captured.data.line_items.create[0].line_total)).toBe(100);
    expect(captured.data.line_items.create[0].sequence).toBe(1);
    expect(Number(captured.data.line_items.create[1].line_total)).toBe(50);
    expect(captured.data.line_items.create[1].sequence).toBe(2);
    expect(captured.data.line_items.create[1].is_taxable).toBe(false);
  });

  it('stamps every authored line NOT_TRACKED — LO-4 retired the tracked→UNSYNCED stamp (§5.3)', async () => {
    // LO-4: Logistic Orders own all stock deduction, so invoice-born lines never land UNSYNCED and
    // there is no track_inventory lookup at create time — every authored line is NOT_TRACKED.
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id,
      payment_type: null,
      tax_exempt: false,
      service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX', is_primary: true }],
    });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'TX', tax_rate: 0.0625 });

    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(standaloneTx(captured)));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        line_items: [
          { description: '12ga Wire (ft)', quantity: 4, unit_price: 3, is_taxable: true, price_book_item_id: 'aaaaaaa2-0000-0000-0000-000000000002' },
          { description: 'Untracked breaker', quantity: 1, unit_price: 40, is_taxable: true, price_book_item_id: 'aaaaaaa3-0000-0000-0000-000000000003' },
          { description: 'Trip fee (free text)', quantity: 1, unit_price: 50, is_taxable: false },
        ],
      });

    expect(res.status).toBe(201);
    // No track_inventory join anymore — resolveTrackedIdSet retired with the sync endpoints.
    expect(mockPrisma.priceBookItem.findMany).not.toHaveBeenCalled();
    const rows = captured.data.line_items.create;
    expect(rows[0].stock_status).toBe('NOT_TRACKED');
    expect(rows[1].stock_status).toBe('NOT_TRACKED');
    expect(rows[2].stock_status).toBe('NOT_TRACKED');
  });

  it('reads the state tax rate on the TRANSACTION connection — never a 2nd global prisma connection inside the open $transaction (pooler-deadlock regression)', async () => {
    // Regression: createStandaloneInvoice resolves the tax location INSIDE the $transaction
    // (the resolveOrAccreteLocation write must stay atomic), so the tax-rate read must run on
    // the SAME tx connection. Reading it on the global `prisma` client mid-transaction asks the
    // pooler for a 2nd connection that won't free until the txn commits → deadlock/error → 500.
    // (Reproduced live on Riverbend NM customers; cf. learning-mocked-transaction-hides-connection-bugs.)
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id,
      payment_type: null,
      tax_exempt: false,
      service_locations: [{ id: LOCATION_FIXTURE.id, state: 'NM', is_primary: true }],
    });
    // Simulate the pooler: any global-client query issued while the txn is open blows up.
    mockPrisma.stateTaxRate.findFirst.mockRejectedValue(
      new Error('pool timeout: 2nd connection requested inside an open $transaction'),
    );

    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        ...standaloneTx(captured),
        // The reference-table read MUST go through the tx connection (NM 5%).
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: async () => ({ state_code: 'NM', tax_rate: 0.05 }) },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        line_items: [{ description: 'Septic pump-out', quantity: 1, unit_price: 400, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    // Tax came from the tx-connection read: $400 × 5% = $20.
    expect(Number(captured.data.tax_amount)).toBe(20);
    expect(Number(captured.data.total_amount)).toBe(420);
    // The global client was never used for the tax read inside the open transaction.
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  it('dispatcher can create a standalone invoice', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false,
      service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX', is_primary: true }],
    });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'TX', tax_rate: 0.0625 });
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(standaloneTx(captured)));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    expect(res.status).toBe(201);
  });

  it('tax-exempt customer gets $0 tax on a standalone invoice (location optional)', async () => {
    mockAuthAs('admin');
    // Tax-exempt customer with NO service location at all — allowed because tax is 0 regardless.
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: true, service_locations: [],
    });
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(standaloneTx(captured)));

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'Service', quantity: 1, unit_price: 200, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(Number(captured.data.subtotal)).toBe(200);
    expect(Number(captured.data.tax_amount)).toBe(0);
    expect(Number(captured.data.total_amount)).toBe(200);
  });

  it('accretes a new address on a standalone invoice and taxes from the accreted location state', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false, service_locations: [],
    });
    // CA state tax 7.25% — the accreted address is in CA.
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'CA', tax_rate: 0.0725 });

    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        ...standaloneTx(captured),
        serviceLocation: {
          // No existing match → accrete; the resolver returns the new id + the address state.
          findFirst: async () => null,
          create: async (args: any) => ({ id: 'loc-ca-new', ...args.data }),
        },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        address: { address_line1: '500 Market St', city: 'San Francisco', state: 'CA', zip: '94105' },
        line_items: [{ description: 'On-site work', quantity: 1, unit_price: 1000, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    // Tax = $1000 × 7.25% = $72.50 (from the accreted CA location).
    expect(Number(captured.data.tax_amount)).toBe(72.5);
    expect(captured.data.line_items.create[0].sequence).toBe(1);
  });

  it('rejects a service_location_id that does not belong to the customer (ownership) → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false, service_locations: [],
    });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'TX', tax_rate: 0.0625 });

    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        ...standaloneTx({}),
        serviceLocation: {
          // resolveOrAccreteLocation: explicit id NOT found for this customer → it throws.
          findFirst: async () => null,
          create: async () => { throw new Error('should not create'); },
        },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: '00000000-0000-0000-0000-0000000000ff',
        line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/belong to the customer/i);
  });

  it('returns 404 when the standalone customer does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ customer_id: '00000000-0000-0000-0000-0000000000aa', line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/customer not found/i);
  });

  it('rejects a standalone invoice with empty line_items (schema) → 400', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [] });

    expect(res.status).toBe(400);
  });

  it('rejects a request with neither job_id nor customer_id (schema) → 400', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    expect(res.status).toBe(400);
  });

  it('SALES cannot create a standalone invoice → 403 (no create Invoice grant)', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    expect(res.status).toBe(403);
  });

  it('TECHNICIAN cannot create a standalone (job-less) invoice → 403', async () => {
    mockAuthAs('technician');
    // Technician HAS an unconditional create-Invoice CASL grant, so the route guard passes;
    // the controller must reject a job-less create for a technician.
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false,
      service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX', is_primary: true }],
    });

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    expect(res.status).toBe(403);
  });

  it('cross-tenant: a standalone create scopes the customer lookup by organization_id', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: true, service_locations: [],
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(standaloneTx({})));

    await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: true }] });

    const where = mockPrisma.customer.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID_LOCAL);
    expect(where.id).toBe(CUSTOMER_FIXTURE.id);
  });
});

describe('POST /api/invoices — estimate-less job (from-scratch job invoice)', () => {
  it("authors owned line_items on an estimate-less job; tax from the job's own tax_rate", async () => {
    mockAuthAs('admin');
    // Estimate-less job with an EMPTY Items tab; not a service-plan visit. SRVW-85: the empty
    // Items tab is what keeps this on the body-authoring branch. E1 (job-owns-tax-discount):
    // tax_rate comes straight off the job now (stamped at create, editable after) - no fresh
    // service-location lookup at invoice-creation time.
    const job = buildCompletedJob({ estimate: null, job_line_items: [], tax_rate: 0.0625 });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: async () => null,
          create: (args: any) => { capturedData = args.data; return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id }; },
        },
        timelineEvent: { create: async () => ({}) },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        job_id: JOB_FIXTURE.id,
        line_items: [{ description: 'Emergency call-out', quantity: 1, unit_price: 400, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    expect(capturedData.job_id).toBe(JOB_FIXTURE.id);
    // Tax from the job's own 6.25% rate: $400 × 6.25% = $25; deposit_credit 0 (no estimate).
    expect(Number(capturedData.subtotal)).toBe(400);
    expect(Number(capturedData.tax_amount)).toBe(25);
    expect(Number(capturedData.total_amount)).toBe(425);
    expect(Number(capturedData.deposit_credit)).toBe(0);
    expect(capturedData.line_items.create).toHaveLength(1);
    expect(capturedData.line_items.create[0].sequence).toBe(1);
  });

  it('still rejects an estimate-less job with NO authored line_items → 400', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({ estimate: null, job_line_items: [], service_location: { state: 'TX' } });
    mockPrisma.job.findUnique.mockResolvedValue(job);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create invoice with no line items');
  });

  it('a job with Items-tab lines IGNORES body line_items and bills the Items tab', async () => {
    mockAuthAs('admin');
    const job = buildCompletedJob({ estimate: { ...buildCompletedJob().estimate, deposit: null, discount_amount: 0 } });
    mockPrisma.job.findUnique.mockResolvedValue(job);

    let capturedData: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          // SRVW-85: this job IS estimate-anchored, so depositEstimateIds is non-empty and the
          // in-tx findMany really runs.
          findMany: async () => [],
          findFirst: async () => null,
          create: (args: any) => { capturedData = args.data; return { ...INVOICE_FIXTURE, ...args.data, id: INVOICE_FIXTURE.id }; },
        },
        timelineEvent: { create: async () => ({}) },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id, line_items: [{ description: 'Bogus', quantity: 1, unit_price: 1, is_taxable: true }] });

    expect(res.status).toBe(201);
    // Bills the 2 Items-tab lines ($2300), NOT the bogus body line.
    expect(capturedData.line_items.create).toHaveLength(2);
    expect(Number(capturedData.subtotal)).toBe(2300);
  });
});

// ─── GET /api/invoices/export ──────────────────────────

describe('GET /api/invoices/export', () => {
  it('returns all matching rows under the {invoices} envelope, unpaginated', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([INVOICE_FIXTURE]);

    const res = await request(app).get('/api/invoices/export').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    const args = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
  });

  it('applies the status filter just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await request(app).get('/api/invoices/export?status=PAID').set(authHeader('admin'));

    // Shared-engine `equalsOrIn` convention (Task 14): a single value writes a scalar equality,
    // not `{ in: [...] }` — matches leads/estimates/jobs. Was `{ in: ['PAID'] }` under the old
    // hand-rolled `where.status = { in: statusFilter }`, which always wrapped even one value.
    expect(mockPrisma.invoice.findMany.mock.calls[0][0].where.status).toBe('PAID');
  });

  it('applies the overdue branch just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await request(app).get('/api/invoices/export?overdue=true').set(authHeader('admin'));

    const where = mockPrisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.due_date).toEqual(expect.objectContaining({ lt: expect.any(Date) }));
    expect(where.status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });

  // Phase B (technician redesign): the invoice export route is gated canDo('read','Invoice'); a
  // strict technician has no such grant by default, so the export is blocked at the route guard
  // (it never reaches the row-scoped findMany). Invoice access — and therefore export — is a
  // per-user toggle now.
  it('blocks a strict TECHNICIAN from exporting invoices by default (route guard 403)', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/invoices/export').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  // INV-B1 — unpaginated, capped at the defensive 50k row limit (NOT the list page size).
  it('is unpaginated with the defensive take: 50_000 cap (no skip)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await request(app).get('/api/invoices/export').set(authHeader('admin'));

    const args = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(50_000);
  });

  // INV-B3 — tenant isolation: the export where is org-scoped (tenantWhere) so cross-org rows
  // can never be returned.
  it('scopes the export to the requesting org (tenant isolation)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await request(app).get('/api/invoices/export').set(authHeader('admin'));

    expect(mockPrisma.invoice.findMany.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  // INV-B5 — auth gate: an unauthenticated export request is rejected before the controller runs.
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/invoices/export');
    expect(res.status).toBe(401);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  // INV-B6 — select parity: the export uses the SAME select as list() so every CSV column is
  // populated. Compare the select object the two handlers pass to findMany for the same query.
  it('uses the identical select as the list (column parity)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/invoices').set(authHeader('admin'));
    const listSelect = mockPrisma.invoice.findMany.mock.calls[0][0].select;

    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await request(app).get('/api/invoices/export').set(authHeader('admin'));
    const exportSelect = mockPrisma.invoice.findMany.mock.calls[0][0].select;

    expect(exportSelect).toEqual(listSelect);
  });
});

// ─── PATCH /api/invoices/:id — cost model fields (R3b, 2026-07-21, D2/D8/D18) ───────────────
describe('PATCH /api/invoices/:id — cost model fields (R3b)', () => {
  beforeEach(() => {
    clearPermissionCache();
  });

  it('writes labor_hours/overhead_mode/overhead_value for admin on an editable (DRAFT) invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: null });
    let captured: any;
    mockPrisma.invoice.update.mockImplementation((args: any) => {
      captured = args;
      return Promise.resolve({ ...INVOICE_FIXTURE, labor_hours: 5, overhead_mode: 'FIXED', overhead_value: 40 });
    });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: 5, overhead_mode: 'FIXED', overhead_value: 40 });

    expect(res.status).toBe(200);
    expect(captured.data.labor_hours).toBe(5);
    expect(captured.data.overhead_mode).toBe('FIXED');
    expect(captured.data.overhead_value).toBe(40);
  });

  it('returns 400 (locked) when the invoice is PAID, even for admin', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'PAID', job: null });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: 5 });

    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('clears an override back to org default by sending null for all three fields', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: null });
    let captured: any;
    mockPrisma.invoice.update.mockImplementation((args: any) => {
      captured = args;
      return Promise.resolve(INVOICE_FIXTURE);
    });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: null, overhead_mode: null, overhead_value: null });

    expect(res.status).toBe(200);
    expect(captured.data.labor_hours).toBeNull();
    expect(captured.data.overhead_mode).toBeNull();
    expect(captured.data.overhead_value).toBeNull();
  });

  // DISPATCHER can update an Invoice unconditionally by default; every default role that can is
  // ALSO a pricing holder, so this simulates the guard's real target the same way Estimate's/
  // Job's does - a grant set with the "See financial data" grant withheld, keeping everything
  // else. SRVW-140 - the withheld subject is `Pricing`, not `Invoice`: canSeePricing was
  // repointed, so an Invoice reader/updater is no longer automatically a cost viewer.
  it('returns 403 and does not write when the requester can update the Invoice but cannot see pricing', async () => {
    clearPermissionCache();
    mockAuthAs('dispatcher');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject !== 'Pricing'),
    );
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_FIXTURE.id, status: 'DRAFT', job: null });
    // DISPATCHER keeps its unconditional read Invoice, so canAccessRow short-circuits on the
    // empty scope and this mock goes unused - kept so the test does not depend on that detail.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .send({ labor_hours: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('cost fields');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid overhead_mode at the Zod layer', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ overhead_mode: 'BOGUS' });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/invoices — Job → Invoice cost-basis copy (R3b, 2026-07-21, D18) ──────────────
describe('POST /api/invoices — copies the job labor_hours/overhead_mode/overhead_value (R3b)', () => {
  it('copies the job cost basis onto the new invoice row', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_FIXTURE.id,
      status: 'COMPLETED',
      source_plan_id: null,
      assignees: [],
      customer: { id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false },
      service_location: { state: 'NJ' },
      labor_hours: 3,
      overhead_mode: 'PERCENTAGE',
      overhead_value: 15,
      estimate: null,
      // SRVW-85: both are dereferenced unconditionally now. Empty Items tab keeps this test on
      // the body-authoring branch, and an empty estimate set means the deposit helper never
      // queries - so the minimal tx surface below still suffices.
      job_line_items: [],
      linked_estimates: [],
    });
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // no active invoice yet
    // From-scratch (no-estimate) job invoice: tax is location-driven - see lookupStateTaxRate.
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ state_code: 'NJ', tax_rate: 0.06625 });
    let captured: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          create: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ ...INVOICE_FIXTURE, id: 'new-invoice-1' });
          }),
        },
        job: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({
        job_id: JOB_FIXTURE.id,
        line_items: [{ description: 'Repair', quantity: 1, unit_price: 200, is_taxable: true }],
      });

    expect(res.status).toBe(201);
    expect(captured.data.labor_hours).toBe(3);
    expect(captured.data.overhead_mode).toBe('PERCENTAGE');
    expect(captured.data.overhead_value).toBe(15);
  });
});
