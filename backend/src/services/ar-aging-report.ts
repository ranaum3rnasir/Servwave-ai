// AR Aging & Collections (catalog F4) — pure aggregation, no Prisma/Express so
// it unit-tests with fixtures and shares the row shape with the frontend.
//
// Produces the same `Account[]` shape the frontend report renders (see
// frontend/src/pages/reports/arAging.data.ts): one account per customer with
// their outstanding invoices, each carrying days-late + balance. The frontend
// owns bucketing/filtering/DSO from days-late, so the service only computes
// days-late + grouping.

import { addOrgDays, daysBetweenOrgDays, orgDayOf } from '../lib/orgDayRange';

/** Net terms used to derive a due date when an invoice has none. Mirrors the
 *  frontend NET_TERMS_DAYS so demo + live age invoices identically. */
export const NET_TERMS_DAYS = 30;

export type ArSegment = 'Residential' | 'Commercial';

/** One outstanding invoice, normalized from the Prisma row by the controller. */
export interface ArInvoiceRow {
  invoiceNumber: string;
  amountDue: number;
  dueDate: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  customerId: string;
  customerName: string;
  segment: ArSegment;
  location?: string | null;
}

export interface ArInvoice {
  number: string;
  location?: string;
  daysLate: number;
  balance: number;
}

export interface ArAccount {
  id: string;
  customer: string;
  type: ArSegment;
  invoices: ArInvoice[];
}

/** Days past due as of `now`. Uses the invoice's due_date, else sent_at + net
 *  terms, else created_at + net terms. Negative (not yet due) → frontend buckets
 *  it as "current"; 0 is "due today", which is not yet late.
 *
 *  Both ends are reduced to the ORG's calendar day before subtracting, so aging is
 *  whole-day stable AND counts the same days the org's own calendar does. It used to
 *  strip to UTC midnight, which is a different day from the org's for any due instant
 *  falling in the org's evening — the invoice detail page printed the org-local date
 *  beside a UTC-derived count and the two named different days. Net terms are added in
 *  calendar days for the same reason: +30×24h lands an hour out across a DST change.
 *
 *  `timeZone` is required rather than defaulted: a silent fallback is how the browser's
 *  zone leaks back in (see #1634). */
export function daysLateFor(row: ArInvoiceRow, now: Date, timeZone: string): number {
  const anchor = row.dueDate ?? row.sentAt ?? row.createdAt;
  const anchorDay = orgDayOf(anchor, timeZone);
  const dueDay = row.dueDate ? anchorDay : addOrgDays(anchorDay, NET_TERMS_DAYS);
  return daysBetweenOrgDays(dueDay, orgDayOf(now, timeZone));
}

/**
 * Group outstanding invoices into per-customer accounts with days-late computed.
 * Rows are expected pre-filtered to outstanding (amount_due > 0, not voided) by
 * the caller; a defensive `amountDue > 0` guard is applied anyway. Accounts and
 * their invoices are sorted by balance descending for a stable worklist order.
 */
export function buildArAging(rows: ArInvoiceRow[], now: Date, timeZone: string): ArAccount[] {
  const byCustomer = new Map<string, ArAccount>();

  for (const row of rows) {
    if (row.amountDue <= 0) continue;
    let acct = byCustomer.get(row.customerId);
    if (!acct) {
      acct = { id: row.customerId, customer: row.customerName, type: row.segment, invoices: [] };
      byCustomer.set(row.customerId, acct);
    }
    acct.invoices.push({
      number: row.invoiceNumber,
      ...(row.location ? { location: row.location } : {}),
      daysLate: daysLateFor(row, now, timeZone),
      balance: row.amountDue,
    });
  }

  const accounts = [...byCustomer.values()];
  for (const a of accounts) {
    a.invoices.sort((x, y) => y.balance - x.balance);
  }
  accounts.sort(
    (a, b) =>
      b.invoices.reduce((s, i) => s + i.balance, 0) - a.invoices.reduce((s, i) => s + i.balance, 0),
  );
  return accounts;
}

/** Rolling window for the DSO denominator. 90 days is the common contractor default. */
export const DSO_WINDOW_DAYS = 90;

/**
 * Days Sales Outstanding: (AR balance / credit sales in the window) * window days.
 * Returns null when the window has no sales — DSO is genuinely undefined then, and
 * the caller must render that as "—" rather than invent a number.
 */
export function computeDso(
  arBalance: number,
  salesInWindow: number,
  windowDays: number = DSO_WINDOW_DAYS,
): number | null {
  if (salesInWindow <= 0) return null;
  return Math.round((arBalance / salesInWindow) * windowDays);
}
