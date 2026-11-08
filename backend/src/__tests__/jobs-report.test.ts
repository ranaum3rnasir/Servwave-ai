import { describe, it, expect } from 'vitest';
import {
  buildJobsReport,
  jobStatusLabel,
  jobNumberToInt,
  type JobInput,
} from '../services/jobs-report';

function job(over: Partial<JobInput>): JobInput {
  return {
    jobNumber: 'J00001',
    scopeNotes: null,
    status: 'COMPLETED',
    customerCompanyName: null,
    customerFirstName: 'Jane',
    customerLastName: 'Doe',
    customerEmail: 'jane@example.com',
    customerPhone: '(201) 555-1212',
    addressLine1: '100 Main St',
    addressLine2: null,
    city: 'Brooklyn',
    state: 'NY',
    zip: '11201',
    assignees: [],
    dispatcher: null,
    source: null,
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    scheduledStart: new Date('2026-06-02T08:00:00.000Z'),
    scheduledEnd: new Date('2026-06-02T12:00:00.000Z'),
    invoices: [],
    ...over,
  };
}

describe('jobStatusLabel', () => {
  it('maps each JobStatus enum value to a frontend label', () => {
    expect(jobStatusLabel('UNSCHEDULED')).toBe('Submitted');
    expect(jobStatusLabel('SCHEDULED')).toBe('In progress - Scheduled');
    // Spec B1 (B-8) gave EN_ROUTE/ON_SITE/IN_PROGRESS distinct labels here. S4 (D17) retired the
    // first two from JobStatus - they describe a TRIP - so the report has one in-flight job label
    // again, and the finer states are reported per visit.
    expect(jobStatusLabel('IN_PROGRESS')).toBe('In progress');
    expect(jobStatusLabel('COMPLETED')).toBe('Done');
    expect(jobStatusLabel('CANCELLED')).toBe('Canceled');
  });

  it('falls back to Pending for an unknown status', () => {
    expect(jobStatusLabel('SOMETHING_NEW')).toBe('Pending');
  });
});

describe('jobNumberToInt', () => {
  it('strips the prefix and parses the digits', () => {
    expect(jobNumberToInt('J00042')).toBe(42);
  });
  it('handles a bare numeric string', () => {
    expect(jobNumberToInt('698484')).toBe(698484);
  });
  it('returns 0 when there are no digits', () => {
    expect(jobNumberToInt('J')).toBe(0);
  });
});

describe('buildJobsReport', () => {
  it('prefers company name, falls back to first+last, else Unknown', () => {
    const [a, b, c] = buildJobsReport([
      job({ jobNumber: 'J3', customerCompanyName: 'Acme LLC' }),
      job({ jobNumber: 'J2', customerCompanyName: null, customerFirstName: 'Ana', customerLastName: 'Flores' }),
      job({ jobNumber: 'J1', customerCompanyName: null, customerFirstName: null, customerLastName: null }),
    ]);
    expect(a!.client).toBe('Acme LLC');
    expect(b!.client).toBe('Ana Flores');
    expect(c!.client).toBe('Unknown');
  });

  it('sums money across the job linked invoices', () => {
    const [row] = buildJobsReport([
      job({
        invoices: [
          { totalAmount: 1000, amountDue: 250, subtotal: 920, taxAmount: 80, creditsTotal: 0 },
          { totalAmount: 500, amountDue: 0, subtotal: 460, taxAmount: 40, creditsTotal: 0 },
        ],
      }),
    ]);
    expect(row!.billed).toBe(1500);
    expect(row!.paid).toBe(1250); // (1000-250) + (500-0)
    expect(row!.subtotal).toBe(1380);
    expect(row!.tax).toBe(120);
    expect(row!.profit).toBe(1260); // subtotal - tax
  });

  it('clamps collected (paid) to >= 0 when amount_due exceeds total (over-credit)', () => {
    const [row] = buildJobsReport([
      job({ invoices: [{ totalAmount: 100, amountDue: 150, subtotal: 100, taxAmount: 0, creditsTotal: 0 }] }),
    ]);
    expect(row!.paid).toBe(0);
  });

  it('excludes credit-noted amounts from paid (a write-off is not cash)', () => {
    const [row] = buildJobsReport([
      job({ invoices: [{ totalAmount: 1000, amountDue: 0, subtotal: 920, taxAmount: 80, creditsTotal: 600 }] }),
    ]);
    expect(row!.paid).toBe(400); // 1000 billed, 600 written off, 400 actually collected
    expect(row!.billed).toBe(1000);
  });

  it('zeros billed/paid for a job with no invoices', () => {
    const [row] = buildJobsReport([job({ invoices: [] })]);
    expect(row!.billed).toBe(0);
    expect(row!.paid).toBe(0);
    expect(row!.subtotal).toBe(0);
    expect(row!.profit).toBe(0);
  });

  it('joins assignee names into tech and uses the dispatcher as createdBy', () => {
    const [row] = buildJobsReport([
      job({
        assignees: [
          { firstName: 'Emanuel', lastName: 'Dahan' },
          { firstName: 'Ohad', lastName: null },
        ],
        dispatcher: { firstName: 'Dispatch', lastName: 'Desk' },
      }),
    ]);
    expect(row!.tech).toEqual(['Emanuel Dahan', 'Ohad']);
    expect(row!.createdBy).toBe('Dispatch Desk');
  });

  it('leaves tech empty and createdBy blank when there are no people', () => {
    const [row] = buildJobsReport([job({ assignees: [], dispatcher: null })]);
    expect(row!.tech).toEqual([]);
    expect(row!.createdBy).toBe('');
  });

  it('builds a single address string from the service location', () => {
    const [row] = buildJobsReport([
      job({ addressLine1: '100 Main St', addressLine2: 'Apt 4', city: 'Queens', state: 'NY', zip: '11375' }),
    ]);
    expect(row!.address).toBe('100 Main St Apt 4, Queens, NY 11375');
  });

  it('emits ISO date strings, falling back when scheduling is absent', () => {
    const created = new Date('2026-06-01T10:00:00.000Z');
    const [row] = buildJobsReport([
      job({ createdAt: created, scheduledStart: null, scheduledEnd: null }),
    ]);
    expect(row!.createdAt).toBe(created.toISOString());
    expect(row!.scheduledAt).toBe(created.toISOString()); // falls back to createdAt
    expect(row!.endAt).toBe(created.toISOString());
  });

  it('sorts rows by job number descending (newest first)', () => {
    const rows = buildJobsReport([
      job({ jobNumber: 'J00010' }),
      job({ jobNumber: 'J00030' }),
      job({ jobNumber: 'J00020' }),
    ]);
    expect(rows.map((r) => r.jobNumber)).toEqual([30, 20, 10]);
  });

  it('uses scope_notes as the job name and carries Customer.source through', () => {
    const [row] = buildJobsReport([job({ scopeNotes: 'Front gate rekey', source: 'Google' })]);
    expect(row!.jobName).toBe('Front gate rekey');
    expect(row!.source).toBe('Google');
  });

  it('zeros the cost/expense/tip fields that have no DB source', () => {
    const [row] = buildJobsReport([
      job({ invoices: [{ totalAmount: 1000, amountDue: 0, subtotal: 920, taxAmount: 80, creditsTotal: 0 }] }),
    ]);
    expect(row!.itemCost).toBe(0);
    expect(row!.laborCost).toBe(0);
    expect(row!.cardExpenses).toBe(0);
    expect(row!.techExpenses).toBe(0);
    expect(row!.tip).toBe(0);
  });
});
