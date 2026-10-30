import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleSwitches } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Phase B (§E), reworked by Roles & Permissions S01.15 - what the job detail withholds.
//
// COSTS (the labor_hours / overhead cost model) follow See financial data. PRICES follow the record:
// the job's own prices are never withheld from a person who can open the job, and the money of the
// OTHER records embedded in the payload (the attached estimate's total and line prices, each invoice's
// total_amount / amount_due) follows the ability to read that record - a strict technician reads their
// OWN job and used to get the estimate total + per-line unit_price/line_total (+ derived
// remaining_unbilled) through it independent of any estimate read. Descriptions and quantities are kept
// either way so the tech can still do the work. Mirrors the lead-controller `stripEstimateMonetaryFields`.
//
// The Technician preset: View estimates on, View invoices off, See financial data off.
//
// INVOICES (S04.26): the payload lists only the invoices the person can open, with their prices - the invoice query
// that decides it is mocked here (the real scope is proven against a database in permission-job-money-db.test.ts).

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ID = JOB_FIXTURE.id;

// Detail-shaped job (jobDetailSelect) owned by the technician, with estimate pricing + lines.
function jobDetailOwnedByTech() {
  return {
    ...JOB_FIXTURE,
    amount_invoiced: 400,
    // R3b (2026-07-21) — cost model (D2/D8), same staff-only strip as the estimate/invoice fields above.
    labor_hours: 6,
    overhead_mode: 'FIXED',
    overhead_value: 75,
    assignees: [{ user: { id: TEST_USERS.technician.id, first_name: 'Test', last_name: 'Tech' } }],
    estimate: {
      id: 'est-x',
      estimate_number: 'E00003',
      total_amount: 1062.5,
      status: 'WON',
      lead_id: 'lead-x',
      lead: null,
      line_items: [
        { id: 'li1', sequence: 1, description: 'AC Unit', quantity: 2, unit_price: 800, is_taxable: true, line_total: 1600, item_type: 'PART' },
        { id: 'li2', sequence: 2, description: 'Labor', quantity: 3, unit_price: 50, is_taxable: true, line_total: 150, item_type: 'LABOR' },
      ],
    },
    invoices: [{ id: 'inv-x', invoice_number: 'I00007', status: 'SENT', total_amount: 900, amount_due: 400, payments: [{ amount: 150 }, { amount: 25.5 }] }],
    source_plan_id: null,
    source_plan: null,
  };
}

// getById's first findUnique is now the existence/tenant probe ({ id: true }); any truthy row
// clears the 404. (GAP-1: per-instance ownership moved to canAccessRow's scoped findFirst.)
const ACCESS_CHECK_OWNED_BY_TECH = { id: JOB_ID };

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // getById: first findUnique = existence probe, second = full detail.
  mockPrisma.job.findUnique
    .mockResolvedValueOnce(ACCESS_CHECK_OWNED_BY_TECH)
    .mockResolvedValueOnce(jobDetailOwnedByTech());
  // GAP-1 — getById now gates via canAccessRow. For a conditional read (the technician's OWN_JOB)
  // it issues a scoped findFirst; the job is the tech's own, so it matches. ADMIN/DISPATCHER have
  // an unconditional read → canAccessRow short-circuits without querying (this mock is unused).
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  // The person opens none of the job's invoices unless a case says so.
  mockPrisma.invoice.findMany.mockResolvedValue([]);
});

describe('GET /api/jobs/:id — the embedded money follows the record, the cost model follows See financial data', () => {
  it('technician on the preset: estimate prices stay (View estimates is on), an invoice they cannot open is not listed, and the cost model goes', async () => {
    mockAuthAs('technician');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    // The estimate is readable: its total and line prices come with the job.
    expect(job.estimate.total_amount).toBe(1062.5);
    expect(job.remaining_unbilled).toBeCloseTo(662.5, 1);
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeDefined();
      expect(li.line_total).toBeDefined();
    }
    // The job's own price stays.
    expect(job.amount_invoiced).toBe(400);
    // The invoice is not one they can open (View invoices is off, they did not make it): it is not listed, though the
    // job still knows it has one.
    expect(job.invoices).toEqual([]);
    expect(job.invoice_count).toBe(1);
    // R3b — cost model fields stripped: See financial data is off.
    expect(job.labor_hours).toBeUndefined();
    expect(job.overhead_mode).toBeUndefined();
    expect(job.overhead_value).toBeUndefined();
  });

  it('a technician who cannot read estimates gets descriptions/quantities but not the estimate money', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ view_estimates: false });

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    // Estimate total + derived remaining stripped.
    expect(job.estimate.total_amount).toBeUndefined();
    expect(job.remaining_unbilled == null).toBe(true);
    // Per-line money stripped, but the work detail kept.
    for (const li of job.estimate.line_items) {
      expect(li.unit_price).toBeUndefined();
      expect(li.line_total).toBeUndefined();
      expect(li.description).toBeDefined();
      expect(li.quantity).toBeDefined();
    }
  });

  // The other side of the same switch: with it on, a technician pricing a job sees the cost model.
  it('technician with See financial data on gets the cost model too', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ see_financial_data: true });

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.estimate.total_amount).toBeDefined();
    // R3b cost model - the margin inputs, not just the sell price.
    expect(job.labor_hours).toBeDefined();
    expect(job.overhead_mode).toBeDefined();
    expect(job.overhead_value).toBeDefined();
  });
});

describe('GET /api/jobs/:id — money and cost for the office roles', () => {
  it('DISPATCHER (reads estimates and invoices, See financial data off) sees every price but not the cost model', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job.estimate.total_amount).toBe(1062.5);
    expect(job.remaining_unbilled).toBeCloseTo(662.5, 1);
    expect(job.estimate.line_items[0].unit_price).toBe(800);
    expect(job.estimate.line_items[0].line_total).toBe(1600);
    expect(job.invoices[0].total_amount).toBe(900);
    expect(job.invoices[0].amount_due).toBe(400);
    // R3b — cost model fields are a cost: the Dispatcher preset has See financial data off.
    expect(job.labor_hours).toBeUndefined();
    expect(job.overhead_mode).toBeUndefined();
    expect(job.overhead_value).toBeUndefined();
  });

  it('ADMIN sees estimate pricing and the cost model on the job detail', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.job.estimate.total_amount).toBe(1062.5);
    expect(res.body.job.estimate.line_items[0].unit_price).toBe(800);
    expect(res.body.job.labor_hours).toBe(6);
    expect(res.body.job.overhead_mode).toBe('FIXED');
    expect(res.body.job.overhead_value).toBe(75);
  });

  // SRVW-140 - DELIBERATE REWRITE. A per-user `create Invoice` allow override (impliesRead → a paired
  // conditional read Invoice) once handed the technician full dollar visibility on their own job,
  // costs included. That is exactly the leak the card names - an admin granting on-site invoicing or
  // payment collection silently unlocked cost/margin data while the Roles UI switch that claims to
  // control it still read OFF. The See financial data switch is the only door to COSTS; the invoice
  // grant opens the invoice's own prices (it is the invoice record), and nothing more.
  it('technician given View invoices gets the invoice prices but still NO cost on their own job', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ view_invoices: true });
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-x' }]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.job.invoices[0].total_amount).toBe(900);
    expect(res.body.job.labor_hours).toBeUndefined();
    expect(res.body.job.overhead_value).toBeUndefined();
    // Work detail still survives.
    expect(res.body.job.estimate.line_items[0].description).toBe('AC Unit');
  });
});

// Payments go-live slice 28 conductor ruling D1: the Overview invoice lines badge the bank money
// still clearing, so each invoice carries processing_amount (and never the payment rows).
describe('GET /api/jobs/:id - processing_amount per invoice (D1)', () => {
  it('an invoice reader gets the processing amount summed from its PROCESSING payments, without the rows', async () => {
    mockAuthAs('admin');
    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.job.invoices[0].processing_amount).toBe(175.5);
    expect(res.body.job.invoices[0].payments).toBeUndefined();
  });

  it('a requester who cannot open the invoice gets no processing amount, because the invoice is not listed', async () => {
    mockAuthAs('technician');
    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect(res.body.job.invoices).toEqual([]);
  });

  it('a requester who made the invoice sees its processing amount, still without the rows', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-x' }]);
    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect(res.body.job.invoices[0].processing_amount).toBe(175.5);
    expect(res.body.job.invoices[0].payments).toBeUndefined();
  });
});
