import { describe, it, expect } from 'vitest';
import {
  buildInvoicesReport,
  displayStatusFor,
  discountPctFor,
  invoiceSellerFor,
  type InvoiceReportInput,
} from '../services/invoices-report';

const NOW = new Date('2026-06-19T12:00:00.000Z');

function input(over: Partial<InvoiceReportInput>): InvoiceReportInput {
  return {
    invoiceNumber: 'I00001',
    status: 'SENT',
    subtotal: 1000,
    taxAmount: 88.7,
    totalAmount: 1088.7,
    amountDue: 1088.7,
    discountAmount: 0,
    sentAt: new Date('2026-06-01T00:00:00.000Z'),
    dueDate: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    customerName: 'Acme Co',
    customerEmail: 'ap@acme.com',
    jobNumber: 'J00001',
    salesperson: 'Maria Lopez',
    technician: 'Marcus Bell',
    jobType: 'HVAC',
    ...over,
  };
}

describe('displayStatusFor', () => {
  it('maps PAID → Paid', () => {
    expect(displayStatusFor('PAID', 0, NOW, null)).toBe('Paid');
  });

  it('maps PARTIAL → Partial', () => {
    expect(displayStatusFor('PARTIAL', 50, NOW, null)).toBe('Partial');
  });

  it('maps DRAFT (unsent) → Unsent', () => {
    expect(displayStatusFor('DRAFT', 100, NOW, null)).toBe('Unsent');
  });

  it('maps a SENT invoice past its due date → Overdue', () => {
    expect(displayStatusFor('SENT', 100, NOW, new Date('2026-06-01T00:00:00.000Z'))).toBe('Overdue');
  });

  it('maps a SENT invoice not yet due → Due', () => {
    expect(displayStatusFor('SENT', 100, NOW, new Date('2026-07-01T00:00:00.000Z'))).toBe('Due');
  });

  it('maps a SENT invoice with no due date → Due (not overdue)', () => {
    expect(displayStatusFor('SENT', 100, NOW, null)).toBe('Due');
  });
});

describe('discountPctFor', () => {
  it('computes discount as a percentage of subtotal', () => {
    expect(discountPctFor(100, 1000)).toBe(10);
  });

  it('returns 0 when there is no discount', () => {
    expect(discountPctFor(0, 1000)).toBe(0);
  });

  it('returns 0 (no divide-by-zero) when subtotal is 0', () => {
    expect(discountPctFor(50, 0)).toBe(0);
  });
});

describe('buildInvoicesReport', () => {
  it('maps DB rows to the report row shape', () => {
    const rows = buildInvoicesReport([input({})], NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.number).toBe('I00001');
    expect(r.client).toBe('Acme Co');
    expect(r.email).toBe('ap@acme.com');
    expect(r.subtotal).toBe(1000);
    expect(r.tax).toBe(88.7);
    expect(r.amount).toBe(1088.7);
    expect(r.due).toBe(1088.7);
    expect(r.job).toBe('J00001');
    expect(r.jobType).toBe('HVAC');
    expect(typeof r.created).toBe('number');
    expect(r.created).toBe(input({}).createdAt.getTime());
  });

  it('shows the seller the controller resolved', () => {
    const rows = buildInvoicesReport([input({ salesperson: 'James Carter' })], NOW);
    expect(rows[0]!.salesperson).toBe('James Carter');
  });

  it('shows — (never Unassigned) when there is no seller', () => {
    const rows = buildInvoicesReport([input({ salesperson: null })], NOW);
    expect(rows[0]!.salesperson).toBe('—');
  });

  it('falls back to — when there is no technician on the job', () => {
    const rows = buildInvoicesReport([input({ technician: null })], NOW);
    expect(rows[0]!.technician).toBe('—');
  });

  it('derives discount % from discount_amount / subtotal', () => {
    const rows = buildInvoicesReport([input({ discountAmount: 100, subtotal: 1000 })], NOW);
    expect(rows[0]!.discountPct).toBe(10);
  });

  it('derives the display status (overdue SENT past due date)', () => {
    const rows = buildInvoicesReport(
      [input({ status: 'SENT', amountDue: 500, dueDate: new Date('2026-06-01T00:00:00.000Z') })],
      NOW,
    );
    expect(rows[0]!.status).toBe('Overdue');
  });

  it('uses — for job type when absent and Unknown for client when absent', () => {
    const rows = buildInvoicesReport([input({ jobType: null, customerName: '' })], NOW);
    expect(rows[0]!.jobType).toBe('—');
    expect(rows[0]!.client).toBe('Unknown');
  });
});

describe('invoiceSellerFor (whose sale an invoice is)', () => {
  const person = (first: string) => ({ first_name: first, last_name: 'Seller' });
  const jobSeller = person('Job');
  const planSeller = person('Plan');
  const leadOwner = person('Lead');
  const estimateOf = (owner: ReturnType<typeof person> | null) => ({ lead: { commission_owner: owner } });

  it('reads the job\'s stored Sold By for an invoice on a job, with no estimate of its own', () => {
    expect(invoiceSellerFor({ job: { salesperson: jobSeller }, service_plan: null, estimate: null })).toBe(jobSeller);
  });

  it('reads the job\'s Sold By over the estimate\'s lead Owner when the two differ', () => {
    expect(invoiceSellerFor({ job: { salesperson: jobSeller }, service_plan: null, estimate: estimateOf(leadOwner) })).toBe(jobSeller);
  });

  it('shows nobody for an invoice on a job with no Sold By, even when its estimate\'s lead has an Owner', () => {
    expect(invoiceSellerFor({ job: { salesperson: null }, service_plan: null, estimate: estimateOf(leadOwner) })).toBeNull();
  });

  it('reads the plan\'s Sold by for a plan invoice, which belongs to no job', () => {
    expect(invoiceSellerFor({ job: null, service_plan: { sold_by_user: planSeller }, estimate: null })).toBe(planSeller);
  });

  it('keeps the estimate\'s lead Owner for another job-less invoice', () => {
    expect(invoiceSellerFor({ job: null, service_plan: null, estimate: estimateOf(leadOwner) })).toBe(leadOwner);
  });

  it('shows nobody for a job-less invoice with no estimate or plan', () => {
    expect(invoiceSellerFor({ job: null, service_plan: null, estimate: null })).toBeNull();
  });
});
