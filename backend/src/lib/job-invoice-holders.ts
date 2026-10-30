import type { Prisma } from '@prisma/client';

/**
 * The jobs an invoice belongs to for the job's money: the same three ways `jobInvoiceFilter` reaches an invoice from its job,
 * read from the invoice's side. A job holds the invoice when the invoice is on it, was made from its estimate, or was made from
 * an estimate attached to it. Used by the Done job's price lock (S06.19), which must reach exactly the invoices the job's
 * balance is worked out over, so the two are kept side by side.
 */
export function jobsHoldingInvoice(invoiceId: string): Prisma.JobWhereInput {
  return {
    OR: [
      { invoices: { some: { id: invoiceId } } },
      { estimate: { invoices: { some: { id: invoiceId } } } },
      { linked_estimates: { some: { invoices: { some: { id: invoiceId } } } } },
    ],
  };
}
