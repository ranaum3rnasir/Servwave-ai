import { Prisma, PriceBookItemType } from '@prisma/client';

/**
 * SRVW-85: the JobLineItem -> InvoiceLineItem copy, in exactly ONE place.
 *
 * Both invoice doors (POST /api/invoices {job_id} and POST /api/jobs/:id/invoices) copy a job's
 * Items-tab lines onto the new invoice's owned lines the same way - renumbered sequence, the
 * job_line_item_id back-pointer, the unconditional NOT_TRACKED/no-location inventory stamp (the
 * copy never double-deducts stock - the job already consumed or will sync it), and the cost basis
 * (price_book_item_id/unit_cost/markup_percent) carried over when present. Centralised so the next
 * field added to JobLineItem is remembered once, not in two controllers.
 */
export interface JobLineItemForInvoice {
  id: string;
  description: string;
  quantity: Prisma.Decimal | number;
  unit_price: Prisma.Decimal | number;
  is_taxable: boolean;
  line_total: Prisma.Decimal | number;
  item_type: PriceBookItemType;
  price_book_item_id: string | null;
  unit_cost: Prisma.Decimal | number | null;
  markup_percent: Prisma.Decimal | number | null;
}

export function jobLineToInvoiceLineCreate(
  l: JobLineItemForInvoice,
  idx: number,
): Prisma.InvoiceLineItemUncheckedCreateWithoutInvoiceInput {
  return {
    sequence: idx + 1,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    is_taxable: l.is_taxable,
    line_total: l.line_total,
    item_type: l.item_type,
    job_line_item_id: l.id,
    stock_status: 'NOT_TRACKED' as const,
    stock_location_id: null,
    ...(l.price_book_item_id ? { price_book_item_id: l.price_book_item_id } : {}),
    ...(l.unit_cost != null ? { unit_cost: l.unit_cost } : {}),
    ...(l.markup_percent != null ? { markup_percent: l.markup_percent } : {}),
  };
}
