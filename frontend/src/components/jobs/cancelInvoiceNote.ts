// #891: how a job-cancel dialog describes one invoice in its list. Shared by CancelJobDialog (the
// 409 conflict list) and BulkCancelJobsDialog (the kept-invoices preview).
import { formatCurrency } from '@/lib/utils';

/** One invoice named by the cancel route's 409 JOB_CANCEL_HAS_PAYMENTS body (#891). */
export interface PaidInvoiceConflictRow {
  id: string;
  invoice_number: string;
  status: string;
  has_payments: boolean;
  // Withheld by the API for a caller who can't see pricing, so all are optional. amount_paid is
  // settled money only; amount_processing (sent only when non-zero) is money still on its way.
  amount_paid?: number;
  amount_processing?: number;
  amount_due?: number;
}

/** The row note for an invoice in a cancel conflict list; shared with BulkCancelJobsDialog. */
export function invoiceRowNote(inv: PaidInvoiceConflictRow): string {
  if (inv.has_payments) {
    // An invoice with payments (a fully paid one included) is always kept, whatever the choice.
    if (inv.amount_paid === undefined) return 'Has payments · kept';
    // A processing payment may still fail, so it is never counted as paid.
    const parts = [
      ...(inv.amount_paid > 0 || !inv.amount_processing ? [`${formatCurrency(inv.amount_paid)} paid`] : []),
      ...(inv.amount_processing ? [`${formatCurrency(inv.amount_processing)} processing`] : []),
      'kept',
    ];
    return parts.join(' · ');
  }
  return inv.amount_due !== undefined ? `${formatCurrency(inv.amount_due)} due` : 'No payments';
}
