/**
 * Pure job-billing math — no Prisma, no IO. Computes a job's total/invoiced/remaining
 * for amount-based draw invoices. Reuses `recomputeInvoiceTotals` for the job's line
 * total; does not re-implement money math.
 */
import { recomputeInvoiceTotals } from './invoice-totals';

type JobLineLike = { quantity: number; unit_price: number; is_taxable: boolean };

export interface ComputeJobBillingInput {
  lines: JobLineLike[];
  scopes?: { flat_price: number | null; is_taxable: boolean }[];
  taxRate: number;
  taxExempt: boolean;
  /** Whole-job discount as a RATE - PERCENTAGE recomputes against THIS call's own subtotal.
   *  Superseded by `discountAmount` (job-owns-tax-discount, E2) for a job's own persisted
   *  discount; still used where a caller resolves a rate against a subtotal it controls (e.g.
   *  an invoice's own discount inputs before they are stored). */
  discountType?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discountValue?: number | null;
  /** Already-resolved dollar discount (job-owns-tax-discount, E2) - takes priority over
   *  discountType/discountValue and is passed straight through as the applied amount, never
   *  re-derived from a rate against the current line set. This is how a job's OWN persisted
   *  discount_amount is applied: resolved once when the user sets it, frozen afterward. */
  discountAmount?: number;
  invoices: { total_amount: number; voided_at: Date | null }[];
}

export interface ComputeJobBillingResult {
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  invoiced: number;
  remaining: number;
  /** Spec B1 (B-5): the over-bill guards were removed — this is the visibility replacement.
   *  Non-zero whenever invoiced exceeds the job's total; `remaining` alone can't show this
   *  since it clamps at zero and would render an over-billed job identically to a fully-billed one. */
  over_billed: number;
}

export function computeJobBilling(input: ComputeJobBillingInput): ComputeJobBillingResult {
  const totals = recomputeInvoiceTotals({
    lines: input.lines,
    scopes: input.scopes,
    taxRate: input.taxRate,
    taxExempt: input.taxExempt,
    discountType: input.discountType,
    discountValue: input.discountValue,
    invoiceDiscountAmount: input.discountAmount,
    tip: 0,
  });

  const invoiced = input.invoices
    .filter((i) => i.voided_at == null)
    .reduce((sum, i) => sum + Number(i.total_amount), 0);

  const total = Number(totals.total_amount);
  const remaining = Math.max(Math.round((total - invoiced) * 100) / 100, 0);
  const over_billed = Math.max(Math.round((invoiced - total) * 100) / 100, 0);

  return {
    subtotal: totals.subtotal,
    discount_amount: totals.discount_amount,
    tax_rate: input.taxRate,
    tax_amount: totals.tax_amount,
    total,
    invoiced: Math.round(invoiced * 100) / 100,
    remaining,
    over_billed,
  };
}
