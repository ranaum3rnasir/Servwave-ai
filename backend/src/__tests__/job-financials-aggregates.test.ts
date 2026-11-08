import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

/** Local helper (brief Step 5): wires the two Prisma calls getFinancials makes. */
function mockFinancialsFor(
  jobId: string,
  invoices: unknown[],
  jobRow: { estimate_id?: string | null; linked_estimates?: { id: string }[] } = {},
) {
  mockPrisma.job.findUnique.mockResolvedValue({ estimate_id: null, linked_estimates: [], ...jobRow });
  mockPrisma.invoice.findMany.mockResolvedValue(invoices);
  // TECHNICIAN's `read Job` grant is conditional (OWN_JOB) — canAccessRow queries
  // job.findFirst to confirm ownership. Admin's grant is unconditional and skips this.
  mockPrisma.job.findFirst.mockResolvedValue({ id: jobId });
}

describe('GET /api/jobs/:id/financials — multi-draw aggregates', () => {
  const invoices = [
    { id: 'i1', invoice_number: 'I00001', kind: 'STANDARD', status: 'SENT', voided_at: null,
      total_amount: 3000, amount_due: 0, sent_at: new Date('2026-03-10'), paid_at: new Date('2026-03-12'),
      payments: [{ amount: 3000 }] },
    { id: 'i2', invoice_number: 'I00002', kind: 'STANDARD', status: 'DRAFT', voided_at: null,
      total_amount: 4000, amount_due: 4000, sent_at: null, paid_at: null, payments: [] },
    { id: 'i3', invoice_number: 'I00003', kind: 'STANDARD', status: 'VOIDED', voided_at: new Date('2026-03-15'),
      total_amount: 9999, amount_due: 0, sent_at: new Date('2026-03-14'), paid_at: null, payments: [] },
  ];

  it('emits first_sent_at, total_invoiced and total_paid across non-voided invoices', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', invoices);

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The VOIDED invoice contributes to none of the three.
    expect(res.body.first_sent_at).toBe(new Date('2026-03-10').toISOString());
    expect(res.body.total_invoiced).toBe(7000);
    expect(res.body.total_paid).toBe(3000);
  });

  it('strips the two totals for a price-blind requester but keeps first_sent_at', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockFinancialsFor('job-1', invoices);

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('technician'));

    expect(res.body.total_invoiced).toBeUndefined();
    expect(res.body.total_paid).toBeUndefined();
    expect(res.body.first_sent_at).toBe(new Date('2026-03-10').toISOString());
  });
});

describe('GET /api/jobs/:id/financials — deposit-credit double-count (final-review fix)', () => {
  // Worked example from the whole-branch review: job total $1000, customer paid a $600 deposit
  // on the estimate, fully credited to the one STANDARD invoice. The customer has NOT paid the
  // remaining $400. `invoices` (queried via `OR: [{job_id}, {estimate_id}]`) includes BOTH the
  // job's STANDARD draw AND the estimate's kind=DEPOSIT invoice — each carries its OWN live
  // Payment row for the same $600 (the deposit invoice's original payment, and the mirrored
  // DEPOSIT-CREDIT payment on the STANDARD invoice). Summing raw payments across both invoices
  // double-counts that $600.
  const depositAndStandardInvoices = [
    {
      id: 'dep-1', invoice_number: 'I00001', kind: 'DEPOSIT', status: 'PAID', voided_at: null,
      // Sent BEFORE the standard invoice — must NOT surface as first_sent_at.
      total_amount: 600, amount_due: 0, sent_at: new Date('2026-02-01'), paid_at: new Date('2026-02-02'),
      payments: [{ amount: 600 }],
    },
    {
      id: 'std-1', invoice_number: 'I00002', kind: 'STANDARD', status: 'SENT', voided_at: null,
      // total 1000, $600 credited from the deposit ⇒ amount_due 400 (unpaid remainder).
      total_amount: 1000, amount_due: 400, sent_at: new Date('2026-03-10'), paid_at: null,
      payments: [{ amount: 600, reference_number: 'DEPOSIT-CREDIT' }],
    },
  ];

  it('does not double-count the deposit credit into total_paid', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', depositAndStandardInvoices);

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.total_invoiced).toBe(1000);
    // NOT 1200 — the deposit invoice's own $600 payment and the STANDARD invoice's mirrored
    // $600 DEPOSIT-CREDIT payment are the SAME money, backed by two live Payment rows.
    expect(res.body.total_paid).toBe(600);
    // first_sent_at must come from the STANDARD invoice, not the (earlier-sent) deposit invoice.
    expect(res.body.first_sent_at).toBe(new Date('2026-03-10').toISOString());
  });

  it('does not let a frontend consumer read the job as fully paid off', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', depositAndStandardInvoices);

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    // Mirrors computeLifecycle's paidOff check (frontend/src/lib/jobs/lifecycle.ts).
    const paidOff = res.body.total_invoiced > 0 && res.body.total_paid >= res.body.total_invoiced;
    expect(paidOff).toBe(false);
  });
});

describe('GET /api/jobs/:id/financials - credit notes are not cash', () => {
  // SRVW-84: total_paid back-derives cash as total_amount - amount_due, the same derivation
  // amountPaidOf uses. credit() lowers amount_due with no Payment row, so a write-off reads as
  // collected money on the job command centre.
  const creditedInvoices = [
    {
      id: 'std-1', invoice_number: 'I00001', kind: 'STANDARD', status: 'SENT', voided_at: null,
      // total 1000: $400 really collected, $600 written off by a credit note -> amount_due 0.
      total_amount: 1000, amount_due: 0, sent_at: new Date('2026-03-10'), paid_at: null,
      payments: [{ amount: 400 }], credits: [{ amount: 600 }],
    },
  ];

  it('excludes credit-noted amounts from total_paid', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', creditedInvoices);

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.total_invoiced).toBe(1000);
    // NOT 1000 - only $400 was ever collected; the other $600 was written off.
    expect(res.body.total_paid).toBe(400);
  });

  it('keeps the credits out of the payload (aggregate input only, not a new money field)', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', creditedInvoices);
    const admin = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));
    // The relation is selected purely to net the aggregate; the response shape must not change.
    expect(admin.body.invoices[0].credits).toBeUndefined();

    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockFinancialsFor('job-1', creditedInvoices);
    const tech = await request(app).get('/api/jobs/job-1/financials').set(authHeader('technician'));
    // stripFinancialsForRequester removes every money field from invoices[] by NAME, so a credit
    // amount spread into the row would sail straight past it and leak to a price-blind requester.
    expect(tech.body.invoices[0].credits).toBeUndefined();
    expect(tech.body.invoices[0].total_amount).toBeUndefined();
  });
});

describe('GET /api/jobs/:id/financials - linked-estimate deposits (SRVW-96)', () => {
  it('asks Prisma for linked_estimates (the select is actually widened)', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', []);

    await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(mockPrisma.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ linked_estimates: expect.anything() }) }),
    );
  });

  it("ORs a linked estimate's invoices into the job's invoice set, whatever their kind", async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', [], { estimate_id: null, linked_estimates: [{ id: 'est-a' }] });

    await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    const capturedArgs = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(capturedArgs.where.OR).toHaveLength(2);
    // No `kind` filter: the EstimateJobLink path must admit the same invoice set the legacy
    // provenance path (`{ estimate_id: job.estimate_id }`) already admits, or a job linked only
    // via Estimate.job_id can never show its final invoice.
    expect(capturedArgs.where.OR).toContainEqual({ estimate_id: { in: ['est-a'] } });
  });

  it('does not repeat the provenance estimate id in the linked clause', async () => {
    mockAuthAs('admin');
    mockFinancialsFor('job-1', [], { estimate_id: 'est-p', linked_estimates: [{ id: 'est-p' }, { id: 'est-a' }] });

    await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    const capturedArgs = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(capturedArgs.where.OR).toEqual([
      { job_id: 'job-1' },
      { estimate_id: 'est-p' },
      { estimate_id: { in: ['est-a'] } },
    ]);
  });

  it("a linked estimate's PAID deposit does not double-count into total_invoiced or total_paid", async () => {
    mockAuthAs('admin');
    const invoices = [
      {
        id: 'std-1', invoice_number: 'I00001', kind: 'STANDARD', status: 'SENT', voided_at: null,
        total_amount: 1000, amount_due: 400, sent_at: new Date('2026-03-10'), paid_at: null,
        payments: [{ amount: 600, reference_number: 'DEPOSIT-CREDIT' }],
      },
      {
        id: 'dep-1', invoice_number: 'J00001-1-D', kind: 'DEPOSIT', status: 'PAID', voided_at: null,
        total_amount: 600, amount_due: 0, sent_at: new Date('2026-02-01'), paid_at: new Date('2026-02-02'),
        payments: [{ amount: 600 }],
      },
    ];
    mockFinancialsFor('job-1', invoices, { estimate_id: null, linked_estimates: [{ id: 'est-a' }] });

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.total_invoiced).toBe(1000);
    expect(res.body.total_paid).toBe(600);
  });

  // The case the `kind: 'DEPOSIT'` filter used to make unreachable. A job linked ONLY via
  // Estimate.job_id (jobs.estimate_id null - what the R6 estimate-anchored conversion writes)
  // whose estimate carries a STANDARD invoice: before the filter came off, that invoice was
  // never queried, so final_invoice stayed null and the job page rendered "No invoice yet".
  it("surfaces a linked estimate's STANDARD invoice as final_invoice and in the aggregates", async () => {
    mockAuthAs('admin');
    const invoices = [
      {
        id: 'dep-1', invoice_number: 'I00001', kind: 'DEPOSIT', status: 'PAID', voided_at: null,
        total_amount: 3467.67, amount_due: 0, sent_at: new Date('2026-08-01'), paid_at: new Date('2026-08-04'),
        payments: [{ amount: 3467.67 }],
      },
      {
        id: 'std-1', invoice_number: 'I00002', kind: 'STANDARD', status: 'SENT', voided_at: null,
        total_amount: 4953.81, amount_due: 1486.14, sent_at: new Date('2026-08-05'), paid_at: null,
        payments: [{ amount: 3467.67, reference_number: 'DEPOSIT-CREDIT' }],
      },
    ];
    mockFinancialsFor('job-1', invoices, { estimate_id: null, linked_estimates: [{ id: 'est-a' }] });

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.final_invoice?.invoice_number).toBe('I00002');
    expect(res.body.total_invoiced).toBe(4953.81);
    // The deposit's own payment and its DEPOSIT-CREDIT mirror are the same money: 3467.67, not 6935.34.
    expect(res.body.total_paid).toBe(3467.67);
    expect(res.body.first_sent_at).toBe(new Date('2026-08-05').toISOString());
  });

  it("prefers the newest non-voided STANDARD invoice from a linked estimate", async () => {
    mockAuthAs('admin');
    const invoices = [
      {
        id: 'std-1', invoice_number: 'I00001', kind: 'STANDARD', status: 'VOIDED', voided_at: new Date('2026-08-02'),
        total_amount: 9999, amount_due: 0, sent_at: new Date('2026-08-01'), paid_at: null, payments: [],
      },
      {
        id: 'std-2', invoice_number: 'I00002', kind: 'STANDARD', status: 'SENT', voided_at: null,
        total_amount: 4953.81, amount_due: 4953.81, sent_at: new Date('2026-08-05'), paid_at: null, payments: [],
      },
    ];
    mockFinancialsFor('job-1', invoices, { estimate_id: null, linked_estimates: [{ id: 'est-a' }] });

    const res = await request(app).get('/api/jobs/job-1/financials').set(authHeader('admin'));

    expect(res.body.final_invoice?.invoice_number).toBe('I00002');
    // The voided draw contributes to neither aggregate.
    expect(res.body.total_invoiced).toBe(4953.81);
    expect(res.body.total_paid).toBe(0);
  });
});
