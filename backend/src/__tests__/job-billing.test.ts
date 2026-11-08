import { describe, it, expect } from 'vitest';
import { computeJobBilling } from '../lib/jobBilling';

const base = {
  lines: [{ quantity: 2, unit_price: 100, is_taxable: false }], // subtotal 200
  taxRate: 0,
  taxExempt: false,
  discountType: null as 'PERCENTAGE' | 'FIXED_AMOUNT' | null,
  discountValue: null as number | null,
};

describe('computeJobBilling', () => {
  it('total = job line total; invoiced = Σ non-voided invoice totals; remaining = total − invoiced', () => {
    const r = computeJobBilling({
      ...base,
      invoices: [
        { total_amount: 50, voided_at: null },
        { total_amount: 30, voided_at: null },
        { total_amount: 999, voided_at: new Date() }, // voided → ignored
      ],
    });
    expect(r.total).toBe(200);
    expect(r.invoiced).toBe(80);
    expect(r.remaining).toBe(120);
  });

  it('remaining never goes negative — over_billed surfaces the surplus instead (B-5)', () => {
    const r = computeJobBilling({ ...base, invoices: [{ total_amount: 500, voided_at: null }] });
    expect(r.remaining).toBe(0);
    expect(r.over_billed).toBe(300);
  });

  it('over_billed is zero when invoiced does not exceed total', () => {
    const r = computeJobBilling({ ...base, invoices: [{ total_amount: 50, voided_at: null }] });
    expect(r.over_billed).toBe(0);
  });

  it("total includes a scope's flat_price alongside line totals", () => {
    const r = computeJobBilling({
      ...base,
      scopes: [{ flat_price: 50, is_taxable: false }],
      invoices: [],
    });
    // base lines subtotal (200) + scope flat_price (50) = 250
    expect(r.total).toBe(250);
  });

  it('taxes the total when taxRate is non-zero (D1 - job tax follows the linked estimate)', () => {
    const r = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      taxRate: 0.0625,
      invoices: [],
    });
    expect(r.subtotal).toBe(1000);
    expect(r.tax_rate).toBe(0.0625);
    expect(r.tax_amount).toBe(62.5);
    expect(r.total).toBe(1062.5);
  });

  it('applies a PERCENTAGE discount against the job\'s own subtotal (D2)', () => {
    const r = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      taxRate: 0.1,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      invoices: [],
    });
    expect(r.discount_amount).toBe(100);
    // discounted 900 * 10% tax = 90
    expect(r.tax_amount).toBe(90);
    expect(r.total).toBe(990);
  });

  it('applies a FIXED_AMOUNT discount clamped to the subtotal', () => {
    const r = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 50, is_taxable: false }],
      discountType: 'FIXED_AMOUNT',
      discountValue: 500,
      invoices: [],
    });
    expect(r.discount_amount).toBe(50);
    expect(r.total).toBe(0);
  });

  it('discountAmount (E2, job-owns-tax-discount) is passed straight through, never re-derived from a rate', () => {
    const r = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      taxRate: 0.1,
      discountAmount: 100,
      invoices: [],
    });
    // Same result the old PERCENTAGE-10-against-1000 test produces, but via a frozen dollar
    // amount rather than a rate resolved against this call's subtotal.
    expect(r.discount_amount).toBe(100);
    expect(r.tax_amount).toBe(90);
    expect(r.total).toBe(990);
  });

  it('discountAmount does NOT grow or shrink when the line set changes (the drift E2 exists to prevent)', () => {
    const withFewerItems = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 200, is_taxable: false }],
      discountAmount: 100,
      invoices: [],
    });
    const withMoreItems = computeJobBilling({
      ...base,
      lines: [{ quantity: 1, unit_price: 800, is_taxable: false }],
      discountAmount: 100,
      invoices: [],
    });
    // A PERCENTAGE discount of the same rate would have produced two different dollar figures
    // here (10% of 200 vs 10% of 800) - the frozen amount stays $100 either way.
    expect(withFewerItems.discount_amount).toBe(100);
    expect(withMoreItems.discount_amount).toBe(100);
  });
});
