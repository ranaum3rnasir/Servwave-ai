/**
 * SERV10X-38 Task 4 — legacy ensure-invoice route removal.
 *
 * Job items now live on JobLineItem (Tasks 2-3); the old lazy
 * POST /api/jobs/:id/ensure-invoice (auto-created a DRAFT invoice on first item-add)
 * is obsolete and must be gone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { DEPOSIT_CREDIT_REFERENCE } from '../controllers/invoice.controller';

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  // SRVW-85: the itemized path's already-billed-line guard reads this pre-tx.
  invoiceLineItem: { findMany: ReturnType<typeof vi.fn> };
  payment: { create: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
  depositCreditApplication: { create: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
  refund: { aggregate: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('legacy ensure-invoice route', () => {
  it('is removed (404)', async () => {
    mockAuthAs('admin');

    // Prove this is a genuine "route is gone" 404 and not the controller's own
    // "Job not found" 404 short-circuit: hand it a valid job + an existing invoice
    // so the (still-present, pre-removal) controller would otherwise answer 200.
    mockPrisma.job.findUnique.mockResolvedValue({
      id: JOB_ID,
      status: 'UNSCHEDULED',
      source_plan_id: null,
      customer: { id: 'c0000000-0000-0000-0000-000000000001', payment_type: null, tax_exempt: false },
      service_location: { state: 'TX' },
      assignees: [],
      estimate: null,
    });
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'inv-0000-existing' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/ensure-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(404);
  });
});

/**
 * SERV10X-38 Task 5 — POST /api/jobs/:id/invoices: the explicit "Create Invoice" endpoint.
 * Bills the job's JobLineItem total as a flat DRAW (amount/percent → one summary line) or
 * ITEMIZED (lineIds → copies job lines with a job_line_item_id back-pointer). Multiple
 * invoices per job are allowed; an over-bill guard caps Σ(non-voided invoice totals) at the
 * job's line-item total. A PAID estimate deposit is drawn down as credit by reusing
 * invoice.controller's remainingDepositCredit/applyDepositCredit verbatim.
 *
 * $transaction is mocked (`fn => fn(mockPrisma)`) — the tx path is only unit-covered here,
 * not integration-covered against a real Postgres transaction (learning-mocked-transaction-
 * hides-connection-bugs).
 */
const LINE_A = 'aa000000-0000-0000-0000-000000000001';
const LINE_B = 'aa000000-0000-0000-0000-000000000002';
const LINE_C = 'aa000000-0000-0000-0000-000000000003';

// Mirrors job-lines.test.ts's jobRow() convention, trimmed to what createInvoiceFromJob's
// own select (jobInvoiceGuardSelect) loads: billing inputs + the estimate id for the
// deposit-credit lookup. canAccessRow does its own scoped query, so ownership-join fields
// (assignees/lead_assignees) aren't needed on this row.
function jobRow({
  status = 'UNSCHEDULED' as string,
  sourcePlanId = null as string | null,
  taxExempt = false,
  jobLineItems = [] as any[],
  invoices = [] as any[],
  estimateId = null as string | null,
  // SERV10X-61 Task 10: estimates attached via EstimateJobLink (job.linked_estimates). Deposit-
  // credit union ONLY now (job-owns-tax-discount, E4 retires their tax/discount role) -
  // depositEstimateIds just needs the ids.
  linkedEstimateIds = [] as string[],
  // E1 (job-owns-tax-discount): the JOB's own tax_rate - no longer resolved through an attached
  // estimate. Defaults to 0 → tax-neutral, keeping every pre-E1 fixture's totals unchanged.
  taxRate = 0 as number,
  // E2: the JOB's own discount rate - still resolved as a RATE against THIS invoice's own
  // (possibly itemized-subset) subtotal, same as before, just sourced from the job instead of
  // an estimate. Defaults to null → discount-neutral, keeping every pre-E2 fixture unchanged.
  discountType = null as 'PERCENTAGE' | 'FIXED_AMOUNT' | null,
  discountValue = null as number | null,
  scopes = [] as any[],
} = {}) {
  return {
    id: JOB_ID,
    status,
    source_plan_id: sourcePlanId,
    customer: { id: 'c0000000-0000-0000-0000-000000000001', tax_exempt: taxExempt },
    job_line_items: jobLineItems,
    invoices,
    tax_rate: taxRate,
    discount_type: discountType,
    discount_value: discountValue,
    estimate: estimateId ? { id: estimateId } : null,
    linked_estimates: linkedEstimateIds.map((eid) => ({ id: eid })),
    scopes,
  };
}

describe('POST /api/jobs/:id/invoices — flat draw + over-bill guard (Step A)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }] }),
    );
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-1', ...data }));
    // In-tx TOCTOU re-check (Fix 3) reads this fresh — default mirrors jobRow()'s default
    // empty `invoices`; tests that override jobRow's invoices and reach the transaction
    // override this too, to keep the pre-tx snapshot and in-tx re-read consistent.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    // SRVW-85: nothing already billed unless a test says otherwise.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.job.update.mockResolvedValue({});
  });

  it('creates a flat DRAW invoice with a single summary line', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 120, description: 'Progress payment' });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.total_amount)).toBe(120);
    expect(arg.job_id).toBe(JOB_ID);
    expect(arg.kind).toBe('STANDARD');
    expect(arg.line_items.create).toHaveLength(1);
    expect(arg.line_items.create[0].description).toBe('Progress payment');
    // Inventory P1 (§5.2): the DRAW summary row carries NO stock keys — the DB default
    // (NOT_TRACKED, null location) applies to a ref-less summary line.
    expect(arg.line_items.create[0]).not.toHaveProperty('stock_status');
    expect(arg.line_items.create[0]).not.toHaveProperty('stock_location_id');
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: { amount_invoiced: { increment: 120 } },
    });
  });

  it('defaults the summary line description to "Progress payment" when omitted', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 50 });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(arg.line_items.create[0].description).toBe('Progress payment');
  });

  it('computes a percent draw off the job line-item total', async () => {
    // job total = 200 (2 x $100); 50% ⇒ $100.
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ percent: 50 });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.total_amount)).toBe(100);
  });

  it('allows an over-bill (draw + prior invoices > job total) — Spec B1 removes the guard', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
      invoices: [{ total_amount: 150, voided_at: null }], // remaining 50, draw is 120 — over-bill
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 120 });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoice.create).toHaveBeenCalled();
  });

  it('a VOIDED prior invoice does not count against the over-bill guard', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
      invoices: [{ total_amount: 150, voided_at: new Date('2026-01-01') }], // voided ⇒ ignored
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 120 });

    expect(res.status).toBe(201);
  });

  it("folds a scope's flat_price into the job total — an amount over the lines-only total but within lines+scope is accepted", async () => {
    // lines total 200 + scope flat_price 100 = 300 remaining (no prior invoices). A $250 draw
    // would have 400'd against a lines-only total of 200, but fits once the scope is folded in.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
      scopes: [{ id: 'scope-1', title: 'Permit', body: '', flat_price: 100, is_taxable: false, internal_cost: null }],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 250 });

    expect(res.status).toBe(201);
  });

  it('allows a draw exceeding job_line_items total + scope flat_price total combined — Spec B1', async () => {
    // lines total 200 + scope flat_price 100 = 300 remaining; a $350 draw exceeds it, but the
    // over-bill guard is gone (Spec B1) so it still creates.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
      scopes: [{ id: 'scope-1', title: 'Permit', body: '', flat_price: 100, is_taxable: false, internal_cost: null }],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 350 });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoice.create).toHaveBeenCalled();
  });

  it('a concurrent invoice landing mid-transaction no longer blocks the new one — Spec B1 removed the TOCTOU re-check entirely', async () => {
    // beforeEach's jobRow has job total 200 and NO prior invoices, so the pre-tx snapshot sees
    // remaining=200 and a $150 draw passes it. Simulate a concurrent request whose invoice landed
    // in between (a fresh in-tx read would show $180 already invoiced): the over-bill guard —
    // pre-tx AND the in-tx TOCTOU re-check — is gone (Task 2), so this no longer blocks anything.
    mockPrisma.invoice.findMany.mockResolvedValue([{ total_amount: 180 }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 150 });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoice.create).toHaveBeenCalled();
  });

  it('rejects a body with more than one of amount/percent/lineIds', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 50, percent: 10 });

    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('rejects a body with none of amount/percent/lineIds', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ description: 'no amount given' });

    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('allows invoicing a cancelled job (cancellation is not terminal, Spec B1)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      status: 'CANCELLED',
      jobLineItems: [{ quantity: 1, unit_price: 10, is_taxable: false, line_total: 10 }],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 10 });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoice.create).toHaveBeenCalled();
  });

  it('blocks a service-plan visit job', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001' }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan/i);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 10 });

    expect(res.status).toBe(404);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/invoices — access control (canAccessRow)', () => {
  it('TECHNICIAN (granted create Invoice) still gets 403 on a FOREIGN job, never creates an invoice', async () => {
    mockAuthAs('technician');
    // Route gate is canDo('create','Invoice') (subject-level, unconditional here — mirrors
    // DISPATCHER's default grant shape in defaultGrants.ts) — so the technician clears it.
    // The per-instance owner check is canAccessRow(req,'Job',...), which does its own scoped
    // job.findFirst lookup keyed on a `read Job` grant; mock that to null (not visible under
    // the technician's own-job scope) to simulate a foreign job, per job-lines.test.ts's
    // "TECHNICIAN (granted update Job) still gets 403 on a FOREIGN job" pattern.
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
      { action: 'create', subject: 'Invoice' },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }] }),
    );
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('technician'))
      .send({ amount: 50 });

    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/invoices — itemized + N-invoices + deposit reuse (Step B)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-1', ...data }));
    mockPrisma.job.update.mockResolvedValue({});
    // No PAID deposit invoice by default.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    // In-tx TOCTOU re-check (Fix 3) reads this fresh — default mirrors jobRow()'s default
    // empty `invoices`; tests below that override jobRow's invoices and reach the
    // transaction override this too, to keep the pre-tx snapshot and in-tx re-read consistent.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    // SRVW-85: nothing already billed unless a test says otherwise.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it('creates an itemized invoice whose lines carry a job_line_item_id back-pointer', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [
        { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: true, line_total: 500, item_type: 'MATERIAL', price_book_item_id: null },
        { id: LINE_B, description: 'Labor', quantity: 2, unit_price: 100, is_taxable: false, line_total: 200, item_type: 'SERVICE', price_book_item_id: null },
      ],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(arg.line_items.create).toHaveLength(1);
    expect(arg.line_items.create[0].job_line_item_id).toBe(LINE_A);
    expect(arg.line_items.create[0].description).toBe('AC unit');
    expect(Number(arg.total_amount)).toBe(500);
    // Inventory P1 (§5.2 / QA-501): job-copied lines are stamped NOT_TRACKED unconditionally —
    // the JOB consumed (or will sync) this stock; copies never double-deduct (D2). This
    // construction is what makes §4.4's stock_status:'SYNCED' filter equal "invoice-born only".
    expect(arg.line_items.create[0].stock_status).toBe('NOT_TRACKED');
    expect(arg.line_items.create[0].stock_location_id).toBeNull();
  });

  it('404s when a lineId does not belong to the job', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: true, line_total: 500, item_type: 'MATERIAL', price_book_item_id: null }],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: ['bb000000-0000-0000-0000-000000000099'] });

    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('allows an itemized over-bill (picked lines + prior invoices > job total) — Spec B1', async () => {
    // Job total 200 (80 + 40 + 80 across all lines); prior non-voided invoice 150 ⇒ remaining
    // 50. Picking LINE_A + LINE_B (line_total 80 + 40 = 120) exceeds the 50 remaining, but the
    // over-bill guard is gone (Spec B1) so it still creates.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [
        { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 80, is_taxable: false, line_total: 80, item_type: 'MATERIAL', price_book_item_id: null },
        { id: LINE_B, description: 'Labor', quantity: 1, unit_price: 40, is_taxable: false, line_total: 40, item_type: 'SERVICE', price_book_item_id: null },
        { id: LINE_C, description: 'Permit', quantity: 1, unit_price: 80, is_taxable: false, line_total: 80, item_type: 'SERVICE', price_book_item_id: null },
      ],
      invoices: [{ total_amount: 150, voided_at: null }], // remaining 50
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A, LINE_B] });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoice.create).toHaveBeenCalled();
  });

  it('allows a second invoice on the same job (no idempotency block)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
      invoices: [{ total_amount: 50, voided_at: null }], // remaining 150
    }));
    // Mirrors the jobRow() invoices above — the in-tx re-check (Fix 3) reads this fresh.
    mockPrisma.invoice.findMany.mockResolvedValue([{ total_amount: 50 }]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 40 });

    expect(res.status).toBe(201);
  });

  it('draws down a PAID estimate deposit as credit on the first job invoice', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      estimateId: 'est-0000-0000-0000-000000000001',
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'dep-inv-1' }]); // a PAID DEPOSIT invoice exists
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 200 } }); // $200 paid on the deposit

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 150 });

    expect(res.status).toBe(201);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(150); // capped at the invoice total
    expect(Number(invArg.amount_due)).toBe(0);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deposit_invoice_id: 'dep-inv-1', target_invoice_id: 'inv-1', amount: 150 }),
    }));
    expect(mockPrisma.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ invoice_id: 'inv-1', amount: 150, reference_number: DEPOSIT_CREDIT_REFERENCE }),
    }));
  });

  it('inherent single-credit guard: a second invoice draws 0 once the deposit is already spent', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      estimateId: 'est-0000-0000-0000-000000000001',
      jobLineItems: [{ quantity: 4, unit_price: 100, is_taxable: false, line_total: 400 }],
      invoices: [{ total_amount: 150, voided_at: null }], // 1st job invoice already billed $150
    }));
    // Task 10: invoice.findMany is now the PAID-deposit source (was invoice.findFirst pre-Task-10).
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'dep-inv-1' }]);
    // $200 was paid on the deposit and already fully applied to the 1st invoice ⇒ 0 remaining.
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 200 } });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 100 });

    expect(res.status).toBe(201);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(0);
    expect(Number(invArg.amount_due)).toBe(100);
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    expect(mockPrisma.depositCreditApplication.create).not.toHaveBeenCalled();
  });
});

/**
 * SRVW-85 - already-billed-line guard, ITEMIZED PATH ONLY.
 *
 * The two doors now bill the same source (JobLineItem), so the same line could be itemized onto
 * two live invoices. This guard refuses that. It is deliberately NOT the one-active-invoice guard
 * Spec B1 removed (afdc77e0d): it keys on job_line_item_id, which a flat/percent DRAW line never
 * carries, so progress-draw invoicing is untouched, and over-billing stays legal.
 */
describe('POST /api/jobs/:id/invoices - already-billed line guard (SRVW-85)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-2', ...data }));
    mockPrisma.job.update.mockResolvedValue({});
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it('409s when a picked lineId is already on a non-VOIDED invoice for this job', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [
        { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500, item_type: 'MATERIAL', price_book_item_id: null },
      ],
    }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { job_line_item_id: LINE_A, invoice: { invoice_number: 'I00001' } },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('I00001');
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('a flat DRAW is never blocked by the already-billed guard (Spec B1 progress draws survive)', async () => {
    // Honest note: GREEN before the fix (no guard exists yet). It is the anti-regression lock
    // proving the new guard did not re-add what afdc77e0d deleted.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [
        { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500, item_type: 'MATERIAL', price_book_item_id: null },
      ],
    }));
    // Even with LINE_A already billed, a draw must go through - and must not even ask.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([
      { job_line_item_id: LINE_A, invoice: { invoice_number: 'I00001' } },
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 40 });

    expect(res.status).toBe(201);
    expect(mockPrisma.invoiceLineItem.findMany).not.toHaveBeenCalled();
  });

  it('the guard excludes VOIDED invoices, so re-itemizing after a void is allowed', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [
        { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500, item_type: 'MATERIAL', price_book_item_id: null },
      ],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const where = mockPrisma.invoiceLineItem.findMany.mock.calls[0][0].where;
    expect(where.job_line_item_id).toEqual({ in: [LINE_A] });
    // InvoiceLineItem has no organization_id column, so the tenancy anchor is the nested
    // `invoice` relation - that is where the org lives.
    expect(where.invoice).toEqual({
      job_id: JOB_ID,
      status: { not: 'VOIDED' },
      organization_id: ALPHA_ORG_ID,
    });
  });
});

/**
 * SERV10X-61 Task 10 - multi-estimate deposit drawdown.
 *
 * A job can have MULTIPLE attached estimates (job.linked_estimates / EstimateJobLink), each with
 * its own PAID deposit, UNION its 1:1 provenance estimate (job.estimate / JobPrimaryEstimate).
 * createInvoiceFromJob draws credit from ALL of them (deduped by estimate id), clamped so the
 * cumulative credit never exceeds the invoice total. The single/legacy path stays byte-identical.
 *
 * remainingDepositCredit/applyDepositCredit run for real against the mocked tx: the three
 * aggregates (payment/depositCreditApplication/refund) resolve to each deposit's paid/applied/
 * refunded sums, so `remaining` = the fixture amounts. `paidDeposits` comes from invoice.findMany.
 */
const DEP_A = 'depa0000-0000-0000-0000-000000000001';
const DEP_B = 'depb0000-0000-0000-0000-000000000002';

describe('POST /api/jobs/:id/invoices - multi-estimate deposit drawdown (Task 10)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-1', ...data }));
    mockPrisma.job.update.mockResolvedValue({});
    mockPrisma.invoice.findMany.mockResolvedValue([]); // no paid deposits by default
    // SRVW-85: nothing already billed unless a test says otherwise.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    // No prior applications/refunds on any deposit unless a test overrides - remaining = paid.
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it('single attached (linked) estimate: draws its deposit, capped at the invoice total', async () => {
    // linked_estimates=[est-a], no provenance estimate. Deposit paid $200; invoice total $150.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      linkedEstimateIds: ['est-a'],
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 200 } });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 150 });

    expect(res.status).toBe(201);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(150); // min(200 remaining, 150 total)
    expect(Number(invArg.amount_due)).toBe(0);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deposit_invoice_id: DEP_A, target_invoice_id: 'inv-1', amount: 150 }),
    }));
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ invoice_id: 'inv-1', amount: 150, reference_number: DEPOSIT_CREDIT_REFERENCE }),
    }));
  });

  it('dedupes when the same estimate is both linked AND provenance → one deposit, one drawdown', async () => {
    // linked_estimates=[est-x] and estimate=est-x (same id): the byte-identical single-estimate
    // SERV10X case. Must resolve to ONE estimate id and draw ONE deposit.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      estimateId: 'est-x',
      linkedEstimateIds: ['est-x'],
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 200 });

    expect(res.status).toBe(201);
    // The estimate-id set passed to findMany is deduped to a single 'est-x'. Assert the FULL
    // where: the prisma mock answers regardless of it, so kind/status/org would otherwise be
    // free to drift (a missing status:'PAID' would draw credit off an UNPAID deposit).
    expect(mockPrisma.invoice.findMany.mock.calls[0][0].where).toEqual({
      estimate_id: { in: ['est-x'] },
      kind: 'DEPOSIT',
      status: 'PAID',
      organization_id: ALPHA_ORG_ID,
    });
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(100);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it('two attached estimates, both drawn: deposit_credit = sum, one application + one payment each', async () => {
    // linked_estimates=[est-a, est-b], each deposit remaining $100; invoice total $500.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      linkedEstimateIds: ['est-a', 'est-b'],
      jobLineItems: [{ quantity: 5, unit_price: 100, is_taxable: false, line_total: 500 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }, { id: DEP_B }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } }); // both deposits: $100 paid

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 500 });

    expect(res.status).toBe(201);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(200);
    expect(Number(invArg.amount_due)).toBe(300);
    // TWO ledger applications ($100 each) + TWO deposit-credit payments ($100 each), one per deposit.
    const appAmounts = mockPrisma.depositCreditApplication.create.mock.calls.map((c: any) => Number(c[0].data.amount));
    expect(appAmounts).toEqual([100, 100]);
    const appDepIds = mockPrisma.depositCreditApplication.create.mock.calls.map((c: any) => c[0].data.deposit_invoice_id);
    expect(appDepIds).toEqual([DEP_A, DEP_B]);
    const payAmounts = mockPrisma.payment.create.mock.calls.map((c: any) => Number(c[0].data.amount));
    expect(payAmounts).toEqual([100, 100]);
  });

  it('cumulative clamp: two deposits ($300 + $300), total $500 → credit 500 (not 600), second draw = 200', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      linkedEstimateIds: ['est-a', 'est-b'],
      jobLineItems: [{ quantity: 5, unit_price: 100, is_taxable: false, line_total: 500 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }, { id: DEP_B }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 300 } }); // both deposits: $300 paid

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 500 });

    expect(res.status).toBe(201);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(500); // clamped to total, NOT 600
    expect(Number(invArg.amount_due)).toBe(0);
    // First deposit draws its full $300; the SECOND is clamped to the $200 room left, not $300.
    const appAmounts = mockPrisma.depositCreditApplication.create.mock.calls.map((c: any) => Number(c[0].data.amount));
    expect(appAmounts).toEqual([300, 200]);
    const payAmounts = mockPrisma.payment.create.mock.calls.map((c: any) => Number(c[0].data.amount));
    expect(payAmounts).toEqual([300, 200]);
  });

  it('legacy provenance-only job (no linked estimates) still draws its deposit - byte-identical', async () => {
    // linked_estimates=[] (pre-R6 job), only job.estimate set. Must still draw the provenance deposit.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      estimateId: 'est-prov',
      jobLineItems: [{ quantity: 2, unit_price: 100, is_taxable: false, line_total: 200 }],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 120 } });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 200 });

    expect(res.status).toBe(201);
    // The provenance estimate id is the sole member of the findMany set.
    expect(mockPrisma.invoice.findMany.mock.calls[0][0].where.estimate_id.in).toEqual(['est-prov']);
    const invArg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(invArg.deposit_credit)).toBe(120); // min(120 remaining, 200 total)
    expect(Number(invArg.amount_due)).toBe(80);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * SERV10X-61 Task 10b - the from-job invoice's tax is DERIVED FROM THE JOB'S ESTIMATE(S).
 *
 * The salesperson set the rate when preparing the estimate; the invoice inherits it (still
 * editable afterward). The epic forbids differing rates across a job's estimates (job-anchor lock
 * + same-lead/customer validation), so any estimate on the job yields the same rate - the
 * controller takes the first available (linked_estimates[0] ?? estimate). A standalone job (no
 * estimate) stays untaxed (taxRate 0). Mirrors invoice.controller.create()'s recomputeInvoiceTotals
 * tax math: itemized picked lines carry the estimate's tax per-line; the flat DRAW line is
 * is_taxable:false so it shows the rate but taxes $0.
 */
const TAXED_LINE = { id: LINE_A, description: 'AC unit', quantity: 1, unit_price: 1000, is_taxable: true, line_total: 1000, item_type: 'MATERIAL', price_book_item_id: null };

describe('POST /api/jobs/:id/invoices - job-owned tax (E1, job-owns-tax-discount)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-1', ...data }));
    mockPrisma.job.update.mockResolvedValue({});
    mockPrisma.invoice.findMany.mockResolvedValue([]); // no paid deposits by default
    // SRVW-85: nothing already billed unless a test says otherwise.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it("itemized invoice carries the job's own tax rate", async () => {
    // Job @ 6.25%; itemized pick of a taxable $1000 job line ⇒ tax $62.50, total $1062.50.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      taxRate: 0.0625,
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.tax_rate)).toBe(0.0625);
    expect(Number(arg.subtotal)).toBe(1000);
    expect(Number(arg.tax_amount)).toBe(62.5);
    expect(Number(arg.total_amount)).toBe(1062.5);
    expect(Number(arg.amount_due)).toBe(1062.5); // no deposit → full tax-inclusive total due
    // amount_invoiced tracks the TAX-INCLUSIVE total (mirrors invoice.controller; void/delete
    // decrement by total_amount), so the cached billed total nets out on reversal.
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: { amount_invoiced: { increment: 1062.5 } },
    });
  });

  it('deposit credit clamps to the TAX-INCLUSIVE total, not the pre-tax subtotal', async () => {
    // Same taxed job ($1062.50 total). A PAID deposit with $2000 remaining fully covers it: the
    // credit is capped at the tax-inclusive $1062.50 (NOT the $1000 pre-tax subtotal) → amount_due 0.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      linkedEstimateIds: ['est-a'],
      taxRate: 0.0625,
      jobLineItems: [TAXED_LINE],
    }));
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: DEP_A }]); // a PAID DEPOSIT invoice exists
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 2000 } }); // $2000 remaining

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.total_amount)).toBe(1062.5);
    expect(Number(arg.deposit_credit)).toBe(1062.5); // full tax-inclusive total, not 1000
    expect(Number(arg.amount_due)).toBe(0);
    expect(mockPrisma.depositCreditApplication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deposit_invoice_id: DEP_A, target_invoice_id: 'inv-1', amount: 1062.5 }),
    }));
  });

  it('a tax_exempt customer is charged $0 tax even when the job has a rate', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      taxRate: 0.0625,
      taxExempt: true,
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.tax_rate)).toBe(0.0625); // rate is still recorded on the invoice
    expect(Number(arg.tax_amount)).toBe(0);     // …but the exempt customer is taxed $0
    expect(Number(arg.subtotal)).toBe(1000);
    expect(Number(arg.total_amount)).toBe(1000);
  });

  it('a job at its schema-default tax_rate stays untaxed (tax_rate 0, tax_amount 0)', async () => {
    // jobRow()'s default taxRate is 0. A taxable line is still $0-taxed because the rate is 0.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.tax_rate)).toBe(0);
    expect(Number(arg.tax_amount)).toBe(0);
    expect(Number(arg.subtotal)).toBe(1000);
    expect(Number(arg.total_amount)).toBe(1000);
  });

  it('a flat DRAW off a taxed job shows the rate but taxes $0 (draw line is non-taxable)', async () => {
    // The percent/flat draw line is is_taxable:false, so even under a 6.25% job rate the draw
    // itself carries $0 tax - the rate rides along on the invoice (editable), tax is added only
    // to itemized taxable lines. total_amount == the draw amount.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      taxRate: 0.0625,
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 400 });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.tax_rate)).toBe(0.0625); // rate inherited + shown
    expect(Number(arg.tax_amount)).toBe(0);     // …but the non-taxable draw line taxes $0
    expect(Number(arg.subtotal)).toBe(400);
    expect(Number(arg.total_amount)).toBe(400);
  });

  // job-owns-tax-discount (E1) retires the old provenance-vs-attachment precedence: the job
  // carries exactly ONE tax_rate now, stamped once at create (or multi-estimate conversion,
  // where every candidate estimate is validated to already share it - job.controller.ts
  // create()). There is no more per-estimate fallback chain for invoice creation to get wrong,
  // so the two tests that used to cover that ordering are gone with it.
});

/**
 * job-owns-tax-discount (E2) - the from-job invoice's discount is derived from the JOB's own
 * discount_type/discount_value (E1's tax_rate treatment, mirrored), still resolved as a RATE
 * against THIS invoice's own subtotal - not a frozen dollar figure - because this door can bill
 * an ITEMIZED SUBSET of the job's items (lineIds), and a subset's subtotal can be far smaller
 * than the full job's. Freezing the job's whole-job discount_amount here could put a single
 * itemized invoice's total below zero. (Contrast invoice.controller.ts's job-anchored door,
 * which always bills the WHOLE job in one document and DOES use the frozen discount_amount.)
 *
 * Scoped to the ITEMIZED path only (lineIds): a flat/percent DRAW is a user-specified amount,
 * orthogonal to the underlying items' pricing - mirrors how a draw's summary line is already
 * is_taxable:false (shows the rate, taxes $0) rather than actually taxing the draw.
 */
describe('POST /api/jobs/:id/invoices - job-owned discount (E2, job-owns-tax-discount)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({ id: 'inv-1', ...data }));
    mockPrisma.job.update.mockResolvedValue({});
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.depositCreditApplication.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it("an itemized invoice carries the job's own discount, recomputed against its own subtotal", async () => {
    // Job: 6.25% tax, 10% discount. Itemized pick of a taxable $1000 job line ⇒
    // discount $100, discounted $900 taxed at 6.25% = $56.25, total $956.25.
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      taxRate: 0.0625,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.discount_amount)).toBe(100);
    expect(Number(arg.subtotal)).toBe(1000);
    expect(Number(arg.tax_amount)).toBe(56.25);
    expect(Number(arg.total_amount)).toBe(956.25);
  });

  it('a FIXED_AMOUNT discount is clamped to the itemized subtotal', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      discountType: 'FIXED_AMOUNT',
      discountValue: 5000, // exceeds the $1000 line
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ lineIds: [LINE_A] });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.discount_amount)).toBe(1000);
    expect(Number(arg.total_amount)).toBe(0);
  });

  it('a flat DRAW off a discounted job is NOT discounted (the draw amount is user-specified)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({
      discountType: 'PERCENTAGE',
      discountValue: 10,
      jobLineItems: [TAXED_LINE],
    }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 400 });

    expect(res.status).toBe(201);
    const arg = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(Number(arg.discount_amount)).toBe(0);
    expect(Number(arg.total_amount)).toBe(400);
  });
});
