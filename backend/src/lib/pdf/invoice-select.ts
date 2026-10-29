import type { InvoiceForPdf } from './templates/alpha-classic';

// Mirrors DEPOSIT_CREDIT_REFERENCE in controllers/invoice.controller.ts — duplicated rather than
// imported because invoice.controller.ts already imports invoicePdfSelect/toInvoiceForPdf from
// this module, and importing it back would make the two files circular.
const DEPOSIT_CREDIT_REFERENCE = 'DEPOSIT-CREDIT';

/**
 * Shared by invoice.controller.ts (getPdf/getPublicPdf) and lib/email.ts
 * (renderInvoicePdfBuffer) — the one Prisma select + row-to-InvoiceForPdf mapping every
 * invoice PDF entry point uses, so the three call sites can't drift out of sync with each
 * other (or with InvoiceForPdf's own shape) the way three independent copies would.
 */
export const invoicePdfSelect = {
  id: true,
  invoice_number: true,
  status: true,
  created_at: true,
  due_date: true,
  organization_id: true,
  public_token: true,
  subtotal: true,
  discount_amount: true,
  tax_rate: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  // §2.5b — priced scope-of-work blocks fold into subtotal/total_amount; the template needs
  // them to reconcile the printed line items against the printed Sub total.
  scopes: true,
  customer: {
    select: {
      // #1997 round 2 — `presentInvoiceDetail` (getPdf only) judges the row it is handed and
      // fails closed without `id` (customerContact.ts's `redactRow`), which would blank contact
      // for EVERY staff invoice PDF, ADMIN included. Never rendered.
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
      service_locations: {
        where: { is_primary: true },
        take: 1,
        select: {
          is_primary: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
        },
      },
    },
  },
  // job-anchored invoice only — job-less (deposit/standalone) invoices render "Same as billing".
  job: {
    select: {
      service_location: {
        select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
      },
    },
  },
  line_items: {
    select: {
      description: true,
      item_type: true,
      quantity: true,
      unit_price: true,
      line_total: true,
      discount_amount: true,
      price_book_item: { select: { image_url: true } },
    },
    orderBy: { sequence: 'asc' as const },
  },
  payments: {
    select: { amount: true, voided_at: true, reference_number: true },
  },
} as const;

// Prisma's money columns come back as Decimal, not number — every field InvoiceForPdf types
// as `number` is `unknown` here (same boundary-crossing `as any` every other PDF call site in
// this codebase already does; see generateEstimatePdf's callers), narrowed once inside
// toInvoiceForPdf rather than at each of the three call sites that used to cast independently.
type InvoicePdfRow = {
  invoice_number: string;
  status: string;
  created_at: Date;
  due_date: Date | null;
  subtotal: unknown;
  discount_amount: unknown;
  tax_rate: unknown;
  tax_amount: unknown;
  deposit_credit: unknown;
  total_amount: unknown;
  amount_due: unknown;
  scopes: unknown;
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    service_locations: InvoiceForPdf['customer']['service_locations'];
  };
  job: { service_location: InvoiceForPdf['service_location'] } | null;
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    discount_amount: unknown;
    price_book_item?: { image_url: string | null } | null;
  }>;
  payments: Array<{ amount: unknown; voided_at: Date | null; reference_number: string | null }>;
};

/**
 * Maps an `invoicePdfSelect`-shaped row to InvoiceForPdf. Invoice has no discount_name column
 * (unlike Estimate) — the template falls back to a generic "Discount" label. Prisma's
 * `job.service_location` is nested (job-anchored invoice only); InvoiceForPdf reads it as a
 * top-level field (job-less invoices render "Same as billing"), so this reshapes it rather than
 * spreading the raw row.
 */
export function toInvoiceForPdf(row: InvoicePdfRow): InvoiceForPdf {
  return {
    ...row,
    discount_name: null,
    service_location: row.job?.service_location ?? null,
    // Drop the synthetic deposit-credit draw-down row — it's already printed as its own
    // "Deposit credit" line (invoice.deposit_credit), so leaving it in here would make
    // activePaymentsTotal's "Payments" line double-subtract the same amount.
    payments: row.payments.filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE),
  } as unknown as InvoiceForPdf;
}
