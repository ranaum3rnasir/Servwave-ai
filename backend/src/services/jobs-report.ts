// Jobs Report (catalog "jobs", Operations) — pure aggregation, no Prisma/Express
// so it unit-tests with fixtures and shares the row shape with the frontend.
//
// Produces the same `JobRow[]` shape the frontend report renders (see
// frontend/src/pages/reports/JobsReport.tsx — the `Job` interface). The
// controller fetches tenant-scoped Job rows (+ assignees, customer, service
// location, linked invoices), normalizes each into a `JobInput`, and this
// service maps + aggregates the per-job money/labels. All filtering, date
// presets, search, paging, and CSV export stay client-side (unchanged), so the
// service only has to emit one fully-computed row per job.

import { amountPaidOf } from '../lib/invoice-editable';

/** Prisma JobStatus → the human label the frontend status pills/filters use.
 *  The mock used Workiz-flavored strings; we map the real enum onto the closest
 *  ones the component already styles (see STATUS_STYLE / STATUSES). */
export type JobStatusLabel =
  | 'Submitted'
  | 'In progress'
  | 'In progress - Scheduled'
  | 'On the way'
  | 'On site'
  | 'Pending'
  | 'Done'
  | 'done pending'
  | 'Canceled';

export const STATUS_LABEL: Record<string, JobStatusLabel> = {
  UNSCHEDULED: 'Submitted',
  SCHEDULED: 'In progress - Scheduled',
  // S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus - being on the way and being on site
  // are properties of a TRIP now, reported per visit rather than per job.
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Done',
  CANCELLED: 'Canceled',
};

export function jobStatusLabel(status: string): JobStatusLabel {
  return STATUS_LABEL[status] ?? 'Pending';
}

/** One non-voided invoice linked to the job, normalized from Prisma. */
export interface JobInvoiceInput {
  totalAmount: number;
  amountDue: number;
  subtotal: number;
  taxAmount: number;
  /** SRVW-84 - sum of the invoice's credit notes; required so a caller cannot omit it silently. */
  creditsTotal: number;
}

/** A person on the job (assignee) or its creator/dispatcher, normalized. */
export interface JobPerson {
  firstName: string | null;
  lastName: string | null;
}

/** One job + its relations, normalized from the Prisma row by the controller. */
export interface JobInput {
  jobNumber: string;
  scopeNotes: string | null;
  status: string; // raw JobStatus enum value
  // customer
  customerCompanyName: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  // service location
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  // people
  assignees: JobPerson[];
  dispatcher: JobPerson | null;
  // source attribution (Customer.source); jobs have no native source/origin/tags
  source: string | null;
  // dates
  createdAt: Date;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  // money
  invoices: JobInvoiceInput[];
}

/** The row the frontend `Job` interface consumes (1:1 with JobsReport.tsx). */
export interface JobRow {
  jobNumber: number;
  jobName: string;
  client: string;
  email: string;
  phone: string;
  tags: string[];
  type: string;
  status: JobStatusLabel;
  tech: string[];
  createdBy: string;
  address: string;
  source: string;
  origin: string;
  createdAt: string; // ISO — frontend hook revives to Date
  scheduledAt: string; // ISO
  endAt: string; // ISO
  billed: number;
  paid: number;
  subtotal: number;
  tax: number;
  itemCost: number;
  laborCost: number;
  cardExpenses: number;
  techExpenses: number;
  tip: number;
  profit: number;
}

function personName(p: JobPerson): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
}

function displayName(c: {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  if (c.companyName) return c.companyName;
  const personal = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return personal || 'Unknown';
}

function joinAddress(j: JobInput): string {
  const street = [j.addressLine1, j.addressLine2].filter(Boolean).join(' ').trim();
  const cityState = [j.city, j.state].filter(Boolean).join(', ').trim();
  const tail = [cityState, j.zip].filter(Boolean).join(' ').trim();
  return [street, tail].filter(Boolean).join(', ').trim();
}

/** Parse a numeric job number out of `J00042` (or a bare number). NaN → 0. */
export function jobNumberToInt(jobNumber: string): number {
  const digits = jobNumber.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

/**
 * Map normalized Job rows into the frontend's fully-computed `JobRow[]`.
 *
 * Money is summed across the job's non-voided invoices:
 *  • billed   = Σ total_amount
 *  • paid     = Sum max(total_amount - amount_due - credits, 0)   (cash collected so far; a
 *    credit note is a write-off, not cash)
 *  • subtotal = Σ subtotal
 *  • tax      = Σ tax_amount
 * Cost/expense/tip fields have no first-class DB source today, so they are 0
 * (real org = no fabricated numbers); `profit` falls back to subtotal − tax.
 *
 * Rows are sorted by job number descending (newest first), matching the mock.
 */
export function buildJobsReport(jobs: JobInput[]): JobRow[] {
  const rows = jobs.map((j): JobRow => {
    let billed = 0;
    let paid = 0;
    let subtotal = 0;
    let tax = 0;
    for (const inv of j.invoices) {
      billed += inv.totalAmount;
      paid += amountPaidOf(inv.totalAmount, 0, inv.amountDue, inv.creditsTotal);
      subtotal += inv.subtotal;
      tax += inv.taxAmount;
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    billed = round2(billed);
    paid = round2(Math.max(0, paid));
    subtotal = round2(subtotal);
    tax = round2(tax);

    const client = displayName({
      companyName: j.customerCompanyName,
      firstName: j.customerFirstName,
      lastName: j.customerLastName,
    });

    return {
      jobNumber: jobNumberToInt(j.jobNumber),
      jobName: j.scopeNotes ?? '',
      client,
      email: j.customerEmail ?? '',
      phone: j.customerPhone ?? '',
      tags: [],
      type: '',
      status: jobStatusLabel(j.status),
      tech: j.assignees.map(personName).filter(Boolean),
      createdBy: j.dispatcher ? personName(j.dispatcher) : '',
      address: joinAddress(j),
      source: j.source ?? '',
      origin: '',
      createdAt: j.createdAt.toISOString(),
      scheduledAt: (j.scheduledStart ?? j.createdAt).toISOString(),
      endAt: (j.scheduledEnd ?? j.scheduledStart ?? j.createdAt).toISOString(),
      billed,
      paid,
      subtotal,
      tax,
      itemCost: 0,
      laborCost: 0,
      cardExpenses: 0,
      techExpenses: 0,
      tip: 0,
      profit: round2(Math.max(0, subtotal - tax)),
    };
  });

  rows.sort((a, b) => b.jobNumber - a.jobNumber);
  return rows;
}
