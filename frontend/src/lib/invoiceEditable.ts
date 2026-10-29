/**
 * Invoice edit-lock policy (P2) — frontend mirror of backend `lib/invoice-editable.ts`.
 * An invoice stays editable until it is settled: DRAFT, SENT, and PARTIAL are editable (a partial
 * payment does NOT lock it); PAID / VOIDED / REFUNDED / PARTIALLY_REFUNDED / DISPUTED are read-only.
 */
export const LOCKED_INVOICE_STATUSES = [
  'PAID',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
] as const;

export function isInvoiceEditable(status: string): boolean {
  return !(LOCKED_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * Frontend mirror of backend `isInvoiceRenumberLocked` (lib/record-renumber.ts) - a different,
 * stricter rule than `isInvoiceEditable` above: an invoice that has gone out, or that has real
 * money on it, keeps its number for ever even while it is still editable in every other respect.
 *
 * Payment ROWS, never the residual (total - deposit - amount_due): voiding an invoice zeroes
 * amount_due without a cent changing hands, and a voided payment is money that was un-collected.
 *
 * The backend remains the authority - this only decides whether to offer the affordance, so that
 * the user is not invited into a dialog the server will refuse. A payload without `payments`
 * falls back to "not locked" and lets the server answer, which is what happened before this
 * existed.
 */
export function isInvoiceRenumberLocked(invoice: {
  sent_at?: string | null;
  payments?: Array<{ voided_at?: string | null }> | null;
}): boolean {
  if (invoice.sent_at) return true;
  return (invoice.payments ?? []).some((p) => !p.voided_at);
}
