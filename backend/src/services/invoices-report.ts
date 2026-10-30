// Invoices report — pure aggregation, no Prisma/Express so it unit-tests with
// fixtures and shares the row shape with the frontend.
//
// Produces the same `InvoiceRow[]` shape the frontend report renders (see
// frontend/src/pages/reports/InvoicesReport.tsx). The controller normalizes the
// Prisma rows into `InvoiceReportInput`; this module maps each to a render row,
// deriving the display status, discount %, salesperson, and technician. All
// filtering/aggregation/paging stays in the frontend (single source of truth),
// so this service is a pure row transform.

/** The five display statuses the report renders (Workiz-style). */
export type DisplayStatus = 'Paid' | 'Due' | 'Overdue' | 'Unsent' | 'Partial';

/** Normalized DB row the controller passes in (one per outstanding/sent invoice). */
export interface InvoiceReportInput {
  invoiceNumber: string;
  /** Raw Prisma InvoiceStatus enum value. */
  status: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountDue: number;
  discountAmount: number;
  sentAt: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  customerName: string;
  customerEmail: string;
  jobNumber: string;
  /** Seller's full name (see `invoiceSellerFor`), or null when nobody is credited. */
  salesperson: string | null;
  /** First job assignee's full name, or null. */
  technician: string | null;
  /** Lead/estimate job_type, or null. */
  jobType: string | null;
}

/** One render row — mirrors the frontend's InvoiceRow shape exactly. */
export interface InvoiceReportRow {
  number: string;
  client: string;
  email: string;
  created: number; // epoch ms
  subtotal: number;
  tax: number;
  discountPct: number;
  amount: number;
  due: number;
  status: DisplayStatus;
  job: string;
  salesperson: string;
  technician: string;
  jobType: string;
}

/**
 * Map a Prisma InvoiceStatus + balance + due date to the report's display
 * status. PAID→Paid, PARTIAL→Partial, DRAFT→Unsent (not yet sent). A SENT-class
 * invoice is Overdue once it's past its due date, else Due. VOIDED/REFUNDED rows
 * are filtered out upstream, so they fall through to Due defensively.
 */
export function displayStatusFor(
  status: string,
  amountDue: number,
  now: Date,
  dueDate: Date | null,
): DisplayStatus {
  if (status === 'PAID') return 'Paid';
  if (status === 'DRAFT') return 'Unsent';
  if (status === 'PARTIAL' && amountDue > 0) return 'Partial';
  // SENT / DISPUTED / PARTIALLY_REFUNDED with a balance: overdue vs simply due.
  if (dueDate && dueDate.getTime() < now.getTime()) return 'Overdue';
  return 'Due';
}

/** Discount as a whole-ish percentage of subtotal (0 when subtotal is 0). */
export function discountPctFor(discountAmount: number, subtotal: number): number {
  if (subtotal <= 0) return 0;
  return (discountAmount / subtotal) * 100;
}

/** The name parts of a person credited with a sale. */
export interface SellerName {
  first_name: string | null;
  last_name: string | null;
}

/** What an invoice carries that says whose sale it is. */
export interface InvoiceSellerSource {
  job: { salesperson: SellerName | null } | null;
  service_plan: { sold_by_user: SellerName | null } | null;
  estimate: { lead: { commission_owner: SellerName | null } | null } | null;
}

/**
 * Whose sale an invoice is (Roles & Permissions, PRD 3).
 *
 * - An invoice on a job reads the job's stored Sold By, and only that: a job with no Sold By shows
 *   nobody, the Owner of its estimate's lead is never a fallback. That also fills a job invoice
 *   raised on the job with no estimate of its own, and an extra-work invoice on a plan visit job.
 * - A service plan's own invoice (activation and each renewal; it belongs to no job) reads the
 *   plan's "Sold by": this is where the plan's sale is credited, once.
 * - Any other job-less invoice keeps its estimate's lead Owner.
 */
export function invoiceSellerFor(src: InvoiceSellerSource): SellerName | null {
  if (src.job) return src.job.salesperson;
  if (src.service_plan) return src.service_plan.sold_by_user;
  return src.estimate?.lead?.commission_owner ?? null;
}

/** Transform normalized DB rows into the frontend render rows. */
export function buildInvoicesReport(rows: InvoiceReportInput[], now: Date): InvoiceReportRow[] {
  return rows.map((r) => ({
    number: r.invoiceNumber,
    client: r.customerName || 'Unknown',
    email: r.customerEmail || '',
    created: r.createdAt.getTime(),
    subtotal: r.subtotal,
    tax: r.taxAmount,
    discountPct: discountPctFor(r.discountAmount, r.subtotal),
    amount: r.totalAmount,
    due: r.amountDue,
    status: displayStatusFor(r.status, r.amountDue, now, r.dueDate),
    job: r.jobNumber,
    salesperson: r.salesperson || '—',
    technician: r.technician || '—',
    jobType: r.jobType || '—',
  }));
}
