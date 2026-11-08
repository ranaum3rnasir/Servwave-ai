/**
 * Invoice edit-lock policy (P2). An invoice's line items, billing, and due date stay editable
 * until it is *settled* — i.e. fully PAID (or otherwise closed). A SENT or PARTIAL invoice is
 * still editable: a partial payment does NOT lock it; only full payment does. This replaced the
 * earlier DRAFT-only rule so migrated/open invoices (e.g. Riverbend Septic's unpaid balances) and
 * normal partial-pay workflows can be corrected after sending.
 */

/** Statuses where the invoice is closed and may no longer be edited. */
export const LOCKED_INVOICE_STATUSES = [
  'PAID',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
] as const;

type LockedStatus = (typeof LOCKED_INVOICE_STATUSES)[number];

/** True when the invoice may be edited — DRAFT, SENT, and PARTIAL are editable. */
export function isInvoiceEditable(status: string): boolean {
  return !LOCKED_INVOICE_STATUSES.includes(status as LockedStatus);
}

/** True when the invoice has been sent and could still hold a stale customer-facing copy. */
export function isSentInvoice(status: string, sentAt: Date | null): boolean {
  return sentAt !== null && (status === 'SENT' || status === 'PARTIAL');
}

/**
 * True when the latest material edit landed after the latest send — the customer's copy is
 * stale. Strict `>` so an edit-then-immediate-resend at the same instant clears the reminder
 * rather than leaving it flickering on.
 */
export function needsResend(latestEditedAt: Date | null, latestSentAt: Date | null): boolean {
  if (latestEditedAt === null || latestSentAt === null) return false;
  return latestEditedAt.getTime() > latestSentAt.getTime();
}

/**
 * Real CASH already collected on an invoice, derived purely from its own money fields:
 * `total_amount - deposit_credit - creditsTotal - amount_due`, clamped at >= 0. Computed from the
 * invoice row (not by summing Payment rows), so it survives a line edit on a SENT/PARTIAL invoice.
 * A DRAFT (amount_due == total - deposit) yields 0, preserving the prior recompute behaviour.
 *
 * `creditsTotal` is subtracted because credit() (invoice.controller.ts) lowers `amount_due` and
 * writes a Credit row WITHOUT ever writing a Payment row - so a written-off balance is
 * indistinguishable from a collected one to the other three terms. Netting it out is what stops a
 * write-off reading as a phantom payment (SRVW-84).
 *
 * Summing Payment rows instead was considered and NOT adopted: the deposit credit is mirrored as a
 * synthetic DEPOSIT-CREDIT Payment row that is already inside `deposit_credit` (double count),
 * payments can be voided, and migrated/legacy invoices carry real balances with no Payment row at
 * all.
 *
 * KNOWN LOSS, deliberate and locked by test (backend/src/__tests__/invoice-lines.test.ts, the
 * two-edit characterization): this reconstructs cash from (total, deposit, amount_due, credits)
 * only. `amount_due` is clamped at 0, so once an edit drives it to that clamp - reachable only when
 * credits > 0, since otherwise the invoice settles and locks - the cash figure is permanently
 * understated by the clamped amount, and a later total-raising edit over-bills the customer by that
 * difference. Closing it needs a persisted collected-cash column; it is out of scope here.
 */
export function amountPaidOf(
  totalAmount: number,
  depositCredit: number,
  amountDue: number,
  creditsTotal: number,
): number {
  return Math.max(Math.round((totalAmount - depositCredit - creditsTotal - amountDue) * 100) / 100, 0);
}

/**
 * Sum of the credit notes issued against an invoice, to the cent. Tolerates a null/undefined
 * relation so a caller that did not load `credits` reads 0 rather than NaN. Every Credit row
 * counts - the model has no voided_at/reversed_at column today.
 */
export function creditsTotalOf(credits: Array<{ amount: unknown }> | null | undefined): number {
  if (!credits) return 0;
  const sum = credits.reduce((s, c) => s + Number(c.amount ?? 0), 0);
  return Math.round(sum * 100) / 100;
}
