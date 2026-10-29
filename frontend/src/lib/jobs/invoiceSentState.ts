import type { JobFinancials } from '@/lib/api/jobs';

export type InvoiceSentState = 1 | 2 | 3 | 4;

export interface InvoiceSentSelection {
  state: InvoiceSentState;
  /** The invoice the state refers to — the sent one (1) or the draft (2). Null for 3 and 4. */
  invoice: { id: string; invoice_number: string } | null;
}

/**
 * Which Invoice Sent state applies to this job.
 *
 * State 2 is what stops the naive design deadlocking: `final_invoice` is picked regardless of
 * status, so a DRAFT gives `sent_at: null` and the node reads unreached. A dialog that tried to
 * CREATE from there would stack a second invoice on the job rather than sending the one already
 * sitting there.
 *
 * `first_sent_at` (Task 5) is what makes State 1 correct on a multi-draw job: the newest invoice
 * may be an unsent draft while an earlier draw is already in the customer's hands.
 */
export function selectInvoiceSentState(
  financials: JobFinancials | undefined,
  billableLineCount: number,
): InvoiceSentSelection {
  const inv = financials?.final_invoice ?? null;

  if (financials?.first_sent_at || inv?.sent_at) {
    return { state: 1, invoice: inv ? { id: inv.id, invoice_number: inv.invoice_number } : null };
  }
  if (inv && inv.status === 'DRAFT') {
    return { state: 2, invoice: { id: inv.id, invoice_number: inv.invoice_number } };
  }
  return { state: billableLineCount > 0 ? 3 : 4, invoice: null };
}
