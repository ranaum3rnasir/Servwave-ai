import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

// ─── Fixtures ─────────────────────────────────────────

const JOB_ID = 'a1000000-0000-0000-0000-000000000001';

const JOB_ROW = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'COMPLETED',
  customer_id: 'c1000000-0000-0000-0000-000000000001',
  customer: {
    id: 'c1000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
  },
  service_location: {
    address_line1: '123 Main St',
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    zip: '78701',
  },
};

// Worked example from spec §6: $100k job / MA 6.25% / 30% deposit.
//   Deposit invoice: non-taxable $30,000, paid in full.
//   Standard invoice: $100,000 + $6,250 tax = $106,250 total,
//     − $30,000 deposit-credit drawdown, − a $20,000 partial payment,
//     − a $1,000 credit, + a $500 refund.
//   billed   = 30000 + 106250 = 136250
//   paid     = 30000 (deposit pmt) + 30000 (deposit-credit) + 20000 (partial) = 80000
//   credited = 1000
//   refunded = 500
//   balance  = 136250 − 80000 − 1000 + 500 = 55750
const DEPOSIT_INVOICE = {
  id: 'd1000000-0000-0000-0000-000000000001',
  invoice_number: 'I00001',
  kind: 'DEPOSIT',
  status: 'PAID',
  total_amount: 30000,
  tax_amount: 0,
  created_at: new Date('2026-03-01T10:00:00Z'),
  payments: [
    {
      id: 'p1000000-0000-0000-0000-000000000001',
      amount: 30000,
      method: 'CARD',
      paid_at: new Date('2026-03-01T11:00:00Z'),
      reference_number: null,
      stripe_payment_intent_id: 'pi_dep',
      created_at: new Date('2026-03-01T11:00:00Z'),
    },
  ],
  refunds: [],
  credits: [],
};

const STANDARD_INVOICE = {
  id: 'd1000000-0000-0000-0000-000000000002',
  invoice_number: 'I00002',
  kind: 'STANDARD',
  status: 'PARTIALLY_REFUNDED',
  total_amount: 106250,
  tax_amount: 6250,
  created_at: new Date('2026-03-10T10:00:00Z'),
  payments: [
    {
      id: 'p1000000-0000-0000-0000-000000000002',
      amount: 30000,
      method: 'CASH',
      paid_at: new Date('2026-03-10T10:30:00Z'),
      reference_number: 'DEPOSIT-CREDIT',
      stripe_payment_intent_id: null,
      created_at: new Date('2026-03-10T10:30:00Z'),
    },
    {
      id: 'p1000000-0000-0000-0000-000000000003',
      amount: 20000,
      method: 'CHECK',
      paid_at: new Date('2026-03-12T10:00:00Z'),
      reference_number: 'CHK-99',
      stripe_payment_intent_id: null,
      created_at: new Date('2026-03-12T10:00:00Z'),
    },
  ],
  refunds: [
    {
      id: 'r1000000-0000-0000-0000-000000000001',
      amount: 500,
      tax_portion: 0,
      method: 'CHECK',
      reason_category: 'GOODWILL',
      created_at: new Date('2026-03-15T10:00:00Z'),
    },
  ],
  credits: [
    {
      id: 'cr100000-0000-0000-0000-000000000001',
      amount: 1000,
      tax_portion: 62.5,
      reason: 'discount',
      category: 'GOODWILL',
      created_at: new Date('2026-03-13T10:00:00Z'),
    },
  ],
};

describe('GET /api/statements/job/:jobId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.invoice.findMany.mockResolvedValue([DEPOSIT_INVOICE, STANDARD_INVOICE]);
  });

  it('returns 200 with every invoice, payment, credit, refund and a correct running balance', async () => {
    const res = await request(app)
      .get(`/api/statements/job/${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('job');
    expect(res.body.job.job_number).toBe('J00001');

    // Every event surfaces: 2 invoices + (1 dep pmt) + (1 dep-credit + 1 partial pmt + 1 credit + 1 refund)
    const types = res.body.lines.map((l: { type: string }) => l.type);
    expect(types.filter((t: string) => t === 'invoice')).toHaveLength(2);
    expect(types).toContain('deposit_credit');
    expect(types).toContain('payment');
    expect(types).toContain('credit');
    expect(types).toContain('refund');

    // Totals hand-computed against the spec worked example.
    // paid = ONLY real cash (deposit pmt $30k + partial $20k = $50k); the $30k deposit-credit
    // drawdown is the SAME dollars as the deposit payment, so it is surfaced separately under
    // deposit_credit, NOT double-counted into paid.
    expect(res.body.totals.billed).toBe(136250);
    expect(res.body.totals.paid).toBe(50000);
    expect(res.body.totals.deposit_credit).toBe(30000);
    expect(res.body.totals.credited).toBe(1000);
    expect(res.body.totals.refunded).toBe(500);
    // balance UNCHANGED: 136250 − 50000 − 30000 − 1000 + 500 = 55750.
    expect(res.body.totals.balance).toBe(55750);

    // The cross-check invariant: final running balance === totals.balance.
    const last = res.body.lines[res.body.lines.length - 1];
    expect(last.running_balance).toBe(res.body.totals.balance);
  });

  it('worked-example deposit→final nets to $76,250 with no extra settlements', async () => {
    // Pure spec §6 example: deposit invoice paid $30k, final invoice $106,250 with
    // ONLY the $30k deposit-credit drawdown — no partial pmt / credit / refund.
    const depOnly = { ...DEPOSIT_INVOICE };
    const finalOnly = {
      ...STANDARD_INVOICE,
      status: 'SENT',
      payments: [STANDARD_INVOICE.payments[0]], // just the DEPOSIT-CREDIT row
      refunds: [],
      credits: [],
    };
    mockPrisma.invoice.findMany.mockResolvedValue([depOnly, finalOnly]);

    const res = await request(app)
      .get(`/api/statements/job/${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // billed = 30000 + 106250 = 136250; real paid = 30000 (deposit pmt only); the $30k
    // deposit-credit drawdown is surfaced separately, not folded into paid.
    // balance = 136250 − 30000 − 30000 = 76250 (UNCHANGED).
    expect(res.body.totals.paid).toBe(30000);
    expect(res.body.totals.deposit_credit).toBe(30000);
    expect(res.body.totals.balance).toBe(76250);
    const last = res.body.lines[res.body.lines.length - 1];
    expect(last.running_balance).toBe(76250);
  });

  it('excludes a VOIDED invoice from billed but keeps the rest', async () => {
    const voided = {
      ...STANDARD_INVOICE,
      id: 'd1000000-0000-0000-0000-000000000099',
      invoice_number: 'I00099',
      status: 'VOIDED',
      payments: [],
      refunds: [],
      credits: [],
    };
    mockPrisma.invoice.findMany.mockResolvedValue([DEPOSIT_INVOICE, voided]);

    const res = await request(app)
      .get(`/api/statements/job/${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Only the deposit invoice's $30k bills; the voided invoice contributes no billed line.
    expect(res.body.totals.billed).toBe(30000);
    const invoiceLines = res.body.lines.filter((l: { type: string }) => l.type === 'invoice');
    expect(invoiceLines).toHaveLength(1);
    expect(invoiceLines[0].invoice_number).toBe('I00001');
  });

  it('surfaces the deposit-credit drawdown once as a deposit_credit line, not double-counted', async () => {
    const res = await request(app)
      .get(`/api/statements/job/${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const depCreditLines = res.body.lines.filter((l: { type: string }) => l.type === 'deposit_credit');
    // Exactly ONE deposit_credit line for the $30k drawdown (surfaced once, not double-counted).
    expect(depCreditLines).toHaveLength(1);
    expect(depCreditLines[0].amount).toBe(30000);
    // The DEPOSIT-CREDIT reference_number payment is classified as deposit_credit, never as a
    // normal payment — so it is not double-counted as both a payment and a credit drawdown.
    const depositCreditAmongPayments = res.body.lines.filter(
      (l: { type: string; invoice_number: string; amount: number }) =>
        l.type === 'payment' && l.invoice_number === 'I00002' && l.amount === 30000,
    );
    expect(depositCreditAmongPayments).toHaveLength(0);
  });

  it('returns 404 for unknown job id', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/statements/job/00000000-0000-0000-0000-000000000000')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });

  it('re-applies tenantWhere on both the job query and the invoice query', async () => {
    await request(app).get(`/api/statements/job/${JOB_ID}`).set(authHeader('admin'));

    const jobWhere = mockPrisma.job.findUnique.mock.calls[0]![0].where;
    expect(jobWhere.organization_id).toBe(ALPHA_ORG_ID);

    const invWhere = mockPrisma.invoice.findMany.mock.calls[0]![0].where;
    expect(invWhere.organization_id).toBe(ALPHA_ORG_ID);
    expect(invWhere.job_id).toBe(JOB_ID);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/statements/job/${JOB_ID}`);
    expect(res.status).toBe(401);
  });
});
