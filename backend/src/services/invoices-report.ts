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
  /** Seller's full name from estimate→lead→commission_owner, or null. */
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
    salesperson: r.salesperson || 'Unassigned',
    technician: r.technician || '—',
    jobType: r.jobType || '—',
  }));
}
