/**
 * Pure invoice-totals math — no Prisma, no IO. The single source of truth for the
 * money figures persisted on an Invoice + its InvoiceLineItem rows.
 *
 * Mirrors estimate.controller.ts `calculateTotals` semantics (NET subtotal = Σ of each line's
 * line_total minus its per-line discount), with one addition: a whole-invoice `tip` added
 * POST-tax (untaxed). `amount_due` is intentionally NOT computed here — the caller subtracts
 * deposit_credit and existing payments, which require DB reads.
 *
 * All money is rounded to cents via round(n * 100) / 100, matching the existing controllers.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LineForTotals {
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  // #2053 R0 — widened from 'PERCENTAGE' | 'FIXED_AMOUNT' | null: estimate.controller.ts's
  // LineItemInput.discount_type is `string | null`, and calculateTotals delegates here without
  // narrowing it. The `=== 'PERCENTAGE'` test below is unaffected, and every existing caller
  // already passes a narrower value, so widening is safe.
  discount_type?: string | null;
  discount_value?: number | null;
  // #2053 — an optional line the customer/rep hasn't selected is excluded from the totals
  // accumulation (but its own line_total/discount_amount is still computed) — see
  // countsTowardTotals below. Absent/undefined on a non-estimate line (Job/Invoice never set
  // these) is treated as "counts", matching today's unconditional-sum behaviour.
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

/** A flat-priced scope-of-work block: no quantity, no per-line discount. */
export interface ScopeForTotals {
  flat_price: number | null;
  is_taxable: boolean;
  // #2053 — see LineForTotals's identical fields above.
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

/**
 * #2053 — the ONE selection predicate, shared by both loops in recomputeInvoiceTotals (and
 * mirrored, not re-implemented, by the frontend's money.ts of the same name). Counted unless the
 * item is explicitly optional AND explicitly not selected — both flags absent (every non-estimate
 * line, and every pre-migration row before its first write) reads as "counts", which is exactly
 * today's unconditional-sum behaviour and is what AC8's byte-identical regression relies on.
 */
export function countsTowardTotals(x: { is_optional?: boolean | null; is_selected?: boolean | null }): boolean {
  return !(x.is_optional === true && x.is_selected === false);
}

export interface RecomputeInput {
  lines: LineForTotals[];
  /** Flat-priced scope-of-work blocks, folded into subtotal alongside lines. */
  scopes?: ScopeForTotals[];
  /** Decimal tax rate, e.g. 0.08 for 8%. */
  taxRate: number;
  /** When true, tax_amount is forced to 0 (tax-exempt customer). */
  taxExempt: boolean;
  /** Whole-invoice discount amount, applied after per-line discounts (prorated across taxable). */
  invoiceDiscountAmount?: number;
  /**
   * Whole-document discount as a RATE rather than an already-resolved dollar amount - PERCENTAGE
   * recomputes against THIS call's own subtotal, exactly like tax_rate does (job-items-estimate-
   * parity D2). Takes priority over invoiceDiscountAmount when discountValue is present and > 0.
   */
  discountType?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discountValue?: number | null;
  /** Whole-invoice tip, added POST-tax (never taxed). */
  tip?: number;
}

export interface RecomputeResult {
  /** Per-line derived figures, in the same order as the input lines. */
  computedLines: { line_total: number; discount_amount: number }[];
  /** NET subtotal = Σ (line_total − per-line discount). */
  subtotal: number;
  /** The resolved whole-document discount actually applied (dollar amount, clamped to subtotal). */
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  tip: number;
}

export function recomputeInvoiceTotals(input: RecomputeInput): RecomputeResult {
  const {
    lines,
    scopes,
    taxRate,
    taxExempt,
    invoiceDiscountAmount = 0,
    discountType,
    discountValue,
    tip = 0,
  } = input;

  let subtotal = 0;
  let taxableAfterDiscounts = 0;
  const computedLines: { line_total: number; discount_amount: number }[] = [];

  for (const item of lines) {
    const lineTotal = round2(item.quantity * item.unit_price);

    // Per-line discount
    let lineDiscountAmount = 0;
    if (item.discount_type && item.discount_value != null && item.discount_value > 0) {
      if (item.discount_type === 'PERCENTAGE') {
        lineDiscountAmount = round2(lineTotal * (item.discount_value / 100));
      } else {
        lineDiscountAmount = Math.min(round2(item.discount_value), lineTotal);
      }
    }

    const effective = round2(lineTotal - lineDiscountAmount);
    // #2053 — push for EVERY line, in input order, regardless of selection: `computedLines` is
    // consumed BY INDEX by every caller (a `continue` here would shift every later line's
    // persisted line_total). Only the accumulation into subtotal/taxableAfterDiscounts is
    // selection-gated.
    computedLines.push({ line_total: lineTotal, discount_amount: lineDiscountAmount });
    if (countsTowardTotals(item)) {
      subtotal += effective;
      if (item.is_taxable) {
        taxableAfterDiscounts += effective;
      }
    }
  }

  // Scopes of work: flat-priced, no quantity, no per-line discount. Fold straight into
  // subtotal (and the taxable base, when taxable), same as a line's effective total — unless
  // it's an optional scope the customer/rep hasn't selected.
  for (const scope of scopes ?? []) {
    if (scope.flat_price == null) continue;
    if (!countsTowardTotals(scope)) continue;
    const scopeAmount = round2(scope.flat_price);
    subtotal += scopeAmount;
    if (scope.is_taxable) {
      taxableAfterDiscounts += scopeAmount;
    }
  }

  subtotal = round2(subtotal);

  // Invoice-level discount reduces the whole NET subtotal - as a RATE resolved against THIS
  // subtotal when discountType/discountValue are given (D2), else the already-resolved dollar
  // amount a caller (e.g. a persisted Invoice.discount_amount) passed directly.
  let invoiceDiscount: number;
  if (discountType && discountValue != null && discountValue > 0) {
    invoiceDiscount = discountType === 'PERCENTAGE'
      ? round2(subtotal * (discountValue / 100))
      : Math.min(round2(discountValue), subtotal);
  } else {
    invoiceDiscount = round2(invoiceDiscountAmount);
  }
  const discountedSubtotal = round2(subtotal - invoiceDiscount);

  // Prorate the invoice-level discount across the taxable portion before taxing.
  let taxableSubtotal = taxableAfterDiscounts;
  if (invoiceDiscount > 0 && subtotal > 0) {
    const taxableRatio = taxableAfterDiscounts / subtotal;
    taxableSubtotal = round2(discountedSubtotal * taxableRatio);
  }

  const taxAmount = taxExempt ? 0 : round2(taxableSubtotal * taxRate);

  // Tip is POST-tax (never taxed): subtotal − invoiceDiscount + tax + tip.
  const tipAmount = round2(tip);
  const totalAmount = round2(discountedSubtotal + taxAmount + tipAmount);

  return {
    computedLines,
    subtotal,
    discount_amount: invoiceDiscount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    tip: tipAmount,
  };
}
