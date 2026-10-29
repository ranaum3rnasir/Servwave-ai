import { describe, it, expect } from 'vitest';
import { recomputeInvoiceTotals, countsTowardTotals } from '../invoice-totals';

// recomputeInvoiceTotals is a PURE helper (no Prisma / IO). It mirrors the money
// semantics of estimate.controller.ts `calculateTotals` (NET subtotal = Σ line_total − per-line
// discount), with one addition: a whole-invoice `tip` added POST-tax (untaxed) to total_amount.

describe('recomputeInvoiceTotals', () => {
  it('sums plain taxable lines into a NET subtotal and taxes the full subtotal', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 1800, is_taxable: true },
        { quantity: 1, unit_price: 500, is_taxable: true },
      ],
      taxRate: 0.08,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(2300);
    // 2300 * 0.08 = 184
    expect(r.tax_amount).toBe(184);
    expect(r.total_amount).toBe(2484);
    expect(r.tip).toBe(0);
    expect(r.computedLines).toEqual([
      { line_total: 1800, discount_amount: 0 },
      { line_total: 500, discount_amount: 0 },
    ]);
  });

  it('computes per-line total as round(qty * unit_price)', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 3, unit_price: 33.333, is_taxable: false }],
      taxRate: 0.08,
      taxExempt: false,
    });
    // 3 * 33.333 = 99.999 → round → 100
    expect(r.computedLines[0].line_total).toBe(100);
    expect(r.subtotal).toBe(100);
    expect(r.tax_amount).toBe(0); // non-taxable
    expect(r.total_amount).toBe(100);
  });

  it('applies a PERCENTAGE per-line discount and excludes it from subtotal + tax', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        // 1000 line, 10% off → discount 100, effective 900
        { quantity: 1, unit_price: 1000, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 10 },
      ],
      taxRate: 0.1,
      taxExempt: false,
    });
    expect(r.computedLines[0].line_total).toBe(1000);
    expect(r.computedLines[0].discount_amount).toBe(100);
    expect(r.subtotal).toBe(900);
    // tax on effective 900 * 0.1 = 90
    expect(r.tax_amount).toBe(90);
    expect(r.total_amount).toBe(990);
  });

  it('applies a FIXED_AMOUNT per-line discount, clamped to the line total', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        // 50 line, $200 fixed discount → clamps to 50, effective 0
        { quantity: 1, unit_price: 50, is_taxable: true, discount_type: 'FIXED_AMOUNT', discount_value: 200 },
        { quantity: 1, unit_price: 100, is_taxable: true, discount_type: 'FIXED_AMOUNT', discount_value: 30 },
      ],
      taxRate: 0.1,
      taxExempt: false,
    });
    expect(r.computedLines[0].discount_amount).toBe(50);
    expect(r.computedLines[1].discount_amount).toBe(30);
    // effectives: 0 + 70 = 70
    expect(r.subtotal).toBe(70);
    expect(r.tax_amount).toBe(7);
    expect(r.total_amount).toBe(77);
  });

  it('taxes ONLY taxable lines in a mixed taxable / non-taxable set', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 1000, is_taxable: true },
        { quantity: 1, unit_price: 500, is_taxable: false }, // labor, untaxed
      ],
      taxRate: 0.08,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(1500);
    // tax only on the $1000 taxable line → 80
    expect(r.tax_amount).toBe(80);
    expect(r.total_amount).toBe(1580);
  });

  it('returns $0 tax for a tax-exempt customer regardless of taxable lines', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 1000, is_taxable: true },
        { quantity: 1, unit_price: 500, is_taxable: true },
      ],
      taxRate: 0.08,
      taxExempt: true,
    });
    expect(r.subtotal).toBe(1500);
    expect(r.tax_amount).toBe(0);
    expect(r.total_amount).toBe(1500);
  });

  it('prorates an invoice-level discount across the taxable portion before taxing', () => {
    // Mirrors estimate.controller proration: discount reduces the taxable share proportionally.
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 800, is_taxable: true },
        { quantity: 1, unit_price: 200, is_taxable: false },
      ],
      taxRate: 0.1,
      taxExempt: false,
      invoiceDiscountAmount: 100, // $100 off the whole invoice
    });
    // subtotal (NET) = 1000; taxableAfterDiscounts (per-line) = 800
    expect(r.subtotal).toBe(1000);
    // discountedSubtotal = 900; taxableRatio = 800/1000 = 0.8; taxableSubtotal = 900*0.8 = 720
    // tax = 720 * 0.1 = 72
    expect(r.tax_amount).toBe(72);
    // total = subtotal − invoiceDiscount + tax + tip = 1000 − 100 + 72 + 0 = 972
    expect(r.total_amount).toBe(972);
  });

  it('adds the tip POST-tax (untaxed) to total_amount', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      taxRate: 0.1,
      taxExempt: false,
      tip: 50,
    });
    expect(r.subtotal).toBe(1000);
    // tax computed on 1000 (NOT on 1000 + tip) → 100
    expect(r.tax_amount).toBe(100);
    expect(r.tip).toBe(50);
    // total = 1000 − 0 + 100 + 50 = 1150
    expect(r.total_amount).toBe(1150);
  });

  it('combines per-line discount + invoice discount + tip + mixed taxability', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        // 2 * 600 = 1200, 25% line discount → discount 300, effective 900 (taxable)
        { quantity: 2, unit_price: 600, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 25 },
        // 400 labor, non-taxable, no discount
        { quantity: 1, unit_price: 400, is_taxable: false },
      ],
      taxRate: 0.05,
      taxExempt: false,
      invoiceDiscountAmount: 130,
      tip: 20,
    });
    // NET subtotal = 900 + 400 = 1300; taxableAfterDiscounts = 900
    expect(r.subtotal).toBe(1300);
    // discountedSubtotal = 1170; ratio = 900/1300; taxableSubtotal = round(1170 * 900/1300) = 810
    // tax = 810 * 0.05 = 40.5
    expect(r.tax_amount).toBe(40.5);
    // total = 1300 − 130 + 40.5 + 20 = 1230.5
    expect(r.total_amount).toBe(1230.5);
    expect(r.tip).toBe(20);
    expect(r.computedLines[0].discount_amount).toBe(300);
  });

  it('handles an empty / zero-subtotal invoice with no NaN', () => {
    const r = recomputeInvoiceTotals({ lines: [], taxRate: 0.08, taxExempt: false });
    expect(r.subtotal).toBe(0);
    expect(r.tax_amount).toBe(0);
    expect(r.total_amount).toBe(0);
    expect(r.tip).toBe(0);
    expect(r.computedLines).toEqual([]);
    // proration must not divide by zero when subtotal is 0
    const r2 = recomputeInvoiceTotals({ lines: [], taxRate: 0.08, taxExempt: false, invoiceDiscountAmount: 50, tip: 10 });
    expect(Number.isNaN(r2.tax_amount)).toBe(false);
    expect(r2.tax_amount).toBe(0);
  });

  it('ignores per-line discount when discount_value is 0 or null', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 100, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 0 },
        { quantity: 1, unit_price: 100, is_taxable: true, discount_type: 'FIXED_AMOUNT', discount_value: null },
      ],
      taxRate: 0,
      taxExempt: false,
    });
    expect(r.computedLines[0].discount_amount).toBe(0);
    expect(r.computedLines[1].discount_amount).toBe(0);
    expect(r.subtotal).toBe(200);
  });

  it('exposes the resolved whole-document discount as discount_amount', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      taxRate: 0,
      taxExempt: false,
      invoiceDiscountAmount: 100,
    });
    expect(r.discount_amount).toBe(100);
  });
});

// discountType/discountValue (job-items-estimate-parity, D2): a whole-document discount carried
// as a RATE rather than an already-resolved dollar amount - PERCENTAGE recomputes against THIS
// call's own subtotal, exactly like tax_rate does. Mirrors estimate.controller.ts's
// calculateTotals estimate-level discount block; the two must never diverge.
describe('recomputeInvoiceTotals - discountType/discountValue (rate mode)', () => {
  it('a PERCENTAGE discount recomputes against this subtotal, not a carried-over dollar figure', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 500, is_taxable: true }], // this call's own subtotal is 500
      taxRate: 0.1,
      taxExempt: false,
      discountType: 'PERCENTAGE',
      discountValue: 10, // 10% of 500 = 50, NOT 10% of some other document's subtotal
    });
    expect(r.discount_amount).toBe(50);
    expect(r.subtotal).toBe(500);
    // discounted 450 * 10% tax = 45
    expect(r.tax_amount).toBe(45);
    expect(r.total_amount).toBe(495);
  });

  it('a FIXED_AMOUNT discount carries the dollar figure as-is, clamped to this subtotal', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 30, is_taxable: false }],
      taxRate: 0,
      taxExempt: false,
      discountType: 'FIXED_AMOUNT',
      discountValue: 200, // exceeds the 30 subtotal
    });
    expect(r.discount_amount).toBe(30);
    expect(r.total_amount).toBe(0);
  });

  it('discountType/discountValue take priority over a simultaneously-passed invoiceDiscountAmount', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 500, is_taxable: false }],
      taxRate: 0,
      taxExempt: false,
      invoiceDiscountAmount: 999,
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    expect(r.discount_amount).toBe(50);
  });

  it('a null/zero discountValue falls back to invoiceDiscountAmount (default 0)', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 500, is_taxable: false }],
      taxRate: 0,
      taxExempt: false,
      discountType: 'PERCENTAGE',
      discountValue: null,
    });
    expect(r.discount_amount).toBe(0);
    expect(r.total_amount).toBe(500);
  });
});

// Scopes of work (flat-priced, non-line-item blocks) fold into the same subtotal / taxable
// base as lines, without their own quantity or per-line discount.
describe('recomputeInvoiceTotals — scopes of work', () => {
  const base = {
    lines: [] as { quantity: number; unit_price: number; is_taxable: boolean }[],
    taxRate: 0.1,
    taxExempt: false,
  };

  it("folds a taxable scope's flat_price into both subtotal and the taxable base, same as a line would", () => {
    const r = recomputeInvoiceTotals({
      ...base,
      scopes: [{ flat_price: 500, is_taxable: true }],
    });
    // behaves exactly like a lone $500 taxable line: subtotal 500, taxed at 10% → 50
    expect(r.subtotal).toBe(500);
    expect(r.tax_amount).toBe(50);
    expect(r.total_amount).toBe(550);
  });

  it("folds a non-taxable scope's flat_price into subtotal but NOT the taxable base", () => {
    const r = recomputeInvoiceTotals({
      ...base,
      scopes: [{ flat_price: 500, is_taxable: false }],
    });
    expect(r.subtotal).toBe(500);
    expect(r.tax_amount).toBe(0);
    expect(r.total_amount).toBe(500);
  });

  it('skips a scope whose flat_price is null (an unpriced, purely descriptive scope block)', () => {
    const r = recomputeInvoiceTotals({
      ...base,
      lines: [{ quantity: 1, unit_price: 100, is_taxable: true }],
      scopes: [{ flat_price: null, is_taxable: true }],
    });
    expect(r.subtotal).toBe(100);
    expect(r.tax_amount).toBe(10);
    expect(r.total_amount).toBe(110);
  });

  it('a $0 flat_price (explicit zero, not null) contributes $0, not skipped', () => {
    const r = recomputeInvoiceTotals({
      ...base,
      lines: [{ quantity: 1, unit_price: 100, is_taxable: true }],
      scopes: [{ flat_price: 0, is_taxable: true }],
    });
    expect(r.subtotal).toBe(100);
    expect(r.tax_amount).toBe(10);
    expect(r.total_amount).toBe(110);
  });

  it('prorates an invoice-level discount across lines AND scopes by their combined taxable share', () => {
    // one $1000 taxable line + one $1000 NON-taxable scope; $200 invoice discount, 10% tax.
    const r = recomputeInvoiceTotals({
      ...base,
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      scopes: [{ flat_price: 1000, is_taxable: false }],
      invoiceDiscountAmount: 200,
    });
    expect(r.subtotal).toBe(2000);
    expect(r.tax_amount).toBe(90);
    expect(r.total_amount).toBe(1890);
  });

  it('defaults scopes to empty/undefined -- an existing lines-only call behaves identically to before', () => {
    // Same fixture + assertions as the very first test in this file, called with no `scopes` key at all.
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 1800, is_taxable: true },
        { quantity: 1, unit_price: 500, is_taxable: true },
      ],
      taxRate: 0.08,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(2300);
    expect(r.tax_amount).toBe(184);
    expect(r.total_amount).toBe(2484);
  });
});

// #2053 slice 1 — countsTowardTotals is the ONE selection predicate, shared by both loops below
// AND mirrored (not re-implemented) by the frontend's money.ts of the same name.
describe('countsTowardTotals', () => {
  it('the full truth table: counted unless is_optional === true AND is_selected === false', () => {
    expect(countsTowardTotals({ is_optional: false, is_selected: true })).toBe(true);
    expect(countsTowardTotals({ is_optional: false, is_selected: false })).toBe(true);
    expect(countsTowardTotals({ is_optional: true, is_selected: true })).toBe(true);
    expect(countsTowardTotals({ is_optional: true, is_selected: false })).toBe(false);
  });

  it('both keys absent counts — a Job/Invoice line, or any pre-migration row, sums unconditionally', () => {
    expect(countsTowardTotals({})).toBe(true);
    expect(countsTowardTotals({ is_optional: null, is_selected: null })).toBe(true);
    expect(countsTowardTotals({ is_optional: undefined, is_selected: undefined })).toBe(true);
  });
});

// #2053 slice 1 — selection-aware totals: an unselected optional line/scope is excluded from the
// ACCUMULATION only; its own line_total/discount_amount is still computed and pushed, in input
// order (the money-code-load-bearing rule reviewer amendment R0 names — `computedLines` is
// consumed BY INDEX by every caller).
describe('recomputeInvoiceTotals — selection-aware totals (#2053)', () => {
  it('excludes an optional-unselected line from subtotal/tax but still computes its own line_total', () => {
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 100, is_taxable: true, is_optional: false, is_selected: true },
        { quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: true },
        { quantity: 1, unit_price: 75, is_taxable: true, is_optional: true, is_selected: false },
      ],
      taxRate: 0.1,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(200);
    expect(r.tax_amount).toBe(20);
    expect(r.total_amount).toBe(220);
    // Accumulate-nothing-but-still-compute: the excluded line's OWN line_total is present, in
    // input order (index 2), not skipped/shifted.
    expect(r.computedLines).toEqual([
      { line_total: 100, discount_amount: 0 },
      { line_total: 100, discount_amount: 0 },
      { line_total: 75, discount_amount: 0 },
    ]);
  });

  it('excludes an optional-unselected taxable scope from both subtotal and the taxable base', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 100, is_taxable: true }],
      scopes: [{ flat_price: 200, is_taxable: true, is_optional: true, is_selected: false }],
      taxRate: 0.1,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(100);
    expect(r.tax_amount).toBe(10);
    expect(r.total_amount).toBe(110);
  });

  it('counts an optional-SELECTED line/scope exactly like a plain one', () => {
    const r = recomputeInvoiceTotals({
      lines: [{ quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: true }],
      scopes: [{ flat_price: 50, is_taxable: true, is_optional: true, is_selected: true }],
      taxRate: 0.1,
      taxExempt: false,
    });
    expect(r.subtotal).toBe(150);
    expect(r.tax_amount).toBe(15);
    expect(r.total_amount).toBe(165);
  });

  it('a discount + mixed-taxability fixture with a deselected line matches a hand-computed answer (delegation equivalence, R0)', () => {
    // A ($100, taxable, always included), B ($100, taxable, optional+selected), C ($75, taxable,
    // optional+UNselected, 20% line discount that must still be computed though excluded).
    const r = recomputeInvoiceTotals({
      lines: [
        { quantity: 1, unit_price: 100, is_taxable: true, is_optional: false, is_selected: true },
        { quantity: 1, unit_price: 100, is_taxable: true, is_optional: true, is_selected: true },
        {
          quantity: 1, unit_price: 75, is_taxable: true, is_optional: true, is_selected: false,
          discount_type: 'PERCENTAGE', discount_value: 20,
        },
      ],
      taxRate: 0.1,
      taxExempt: false,
    });
    // C's own discount_amount (15) is still computed even though C never enters subtotal.
    expect(r.computedLines[2]).toEqual({ line_total: 75, discount_amount: 15 });
    expect(r.subtotal).toBe(200);
    expect(r.tax_amount).toBe(20);
    expect(r.total_amount).toBe(220);
  });
});
