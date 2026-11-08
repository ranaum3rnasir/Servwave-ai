/**
 * #2090 slice 3 - the OPTIMISTIC totals preview for the public estimate page.
 *
 * A hand-kept mirror of `backend/src/lib/invoice-totals.ts`'s `recomputeInvoiceTotals`, in the
 * same sense (and for the same reason) as `components/jobs/items/money.ts`'s `countsTowardTotals`:
 * that file cannot be imported into the frontend bundle. **If the backend math changes, change
 * this one too.**
 *
 * It is a PREVIEW and nothing else. The server recomputes and persists the real figures on every
 * selection write and returns them, and the page replaces this with that answer the moment it
 * lands. Its whole job is that the subtotal, tax and total move the instant the customer ticks a
 * box, rather than a round trip later - Ran, 2026-09-15: the tick moves the row into the main list
 * and the figures follow it.
 *
 * `countsTowardTotals` is imported, never re-expressed: there is one selection predicate on this
 * side of the wire and this is not a second one.
 */
import { countsTowardTotals, netOf, toNum } from '@/components/jobs/items/money';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PreviewLine {
  line_total: string | number | null | undefined;
  discount_amount?: string | number | null;
  is_taxable?: boolean | null;
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

export interface PreviewScope {
  flat_price?: number | string | null;
  is_taxable?: boolean | null;
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

export interface PreviewTotals {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/**
 * Subtotal is NET of each line's own discount; an optional row the customer has not taken is out
 * of the accumulation entirely (but keeps its own printed figure, which is the point of showing
 * it). The document-level discount is resolved as a RATE against THIS subtotal when the estimate
 * carries a type and value, exactly as the server does, and is prorated across the taxable portion
 * before tax.
 */
export function previewEstimateTotals(
  lines: PreviewLine[],
  scopes: PreviewScope[],
  estimate: {
    tax_rate?: number | string | null;
    discount_type?: string | null;
    discount_value?: number | string | null;
    discount_amount?: number | string | null;
  },
): PreviewTotals {
  let subtotal = 0;
  let taxable = 0;

  for (const line of lines) {
    if (!countsTowardTotals(line)) continue;
    const effective = netOf({ line_total: line.line_total, discount_amount: line.discount_amount ?? 0 });
    subtotal += effective;
    if (line.is_taxable) taxable += effective;
  }

  for (const scope of scopes) {
    if (scope.flat_price == null) continue;
    if (!countsTowardTotals(scope)) continue;
    const amount = round2(toNum(scope.flat_price));
    subtotal += amount;
    if (scope.is_taxable) taxable += amount;
  }

  subtotal = round2(subtotal);

  const discountValue = toNum(estimate.discount_value);
  const discountAmount = estimate.discount_type && discountValue > 0
    ? (estimate.discount_type === 'PERCENTAGE'
      ? round2(subtotal * (discountValue / 100))
      : Math.min(round2(discountValue), subtotal))
    : round2(toNum(estimate.discount_amount));

  const discountedSubtotal = round2(subtotal - discountAmount);

  let taxableSubtotal = taxable;
  if (discountAmount > 0 && subtotal > 0) {
    taxableSubtotal = round2(discountedSubtotal * (taxable / subtotal));
  }

  const taxAmount = round2(taxableSubtotal * toNum(estimate.tax_rate));

  return {
    subtotal,
    discountAmount,
    taxAmount,
    totalAmount: round2(discountedSubtotal + taxAmount),
  };
}
