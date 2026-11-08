import { describe, it, expect } from 'vitest';
import {
  buildInvoicesReport,
  displayStatusFor,
  discountPctFor,
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

  it('derives the salesperson from the linked estimate→lead→commission_owner', () => {
    const rows = buildInvoicesReport([input({ salesperson: 'James Carter' })], NOW);
    expect(rows[0]!.salesperson).toBe('James Carter');
  });

  it('falls back to Unassigned when there is no linked seller', () => {
    const rows = buildInvoicesReport([input({ salesperson: null })], NOW);
    expect(rows[0]!.salesperson).toBe('Unassigned');
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
