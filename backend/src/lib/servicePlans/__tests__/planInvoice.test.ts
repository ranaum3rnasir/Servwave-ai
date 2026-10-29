import { describe, it, expect } from 'vitest';
import { buildPlanInvoiceData } from '../planInvoice';

const base = {
  invoiceNumber: 'I00001',
  organizationId: 'org-1',
  customerId: 'cust-1',
  servicePlanId: 'plan-1',
  publicToken: 'tok-1',
  lineItems: [
    { name: 'Annual monitoring', quantity: 1, unit_price: 1000 },
    { name: 'Filter service', quantity: 2, unit_price: 100 },
  ],
};

describe('buildPlanInvoiceData', () => {
  it('sets subtotal = Σ line items, applies tax via the rate, and total = subtotal + tax', () => {
    const data = buildPlanInvoiceData({ ...base, taxRate: 0.0875, taxExempt: false });
    expect(Number(data.subtotal)).toBe(1200);
    expect(Number(data.tax_rate)).toBe(0.0875);
    expect(Number(data.tax_amount)).toBe(105); // 1200 * 0.0875
    expect(Number(data.total_amount)).toBe(1305);
    expect(Number(data.amount_due)).toBe(1305);
  });

  it('zeroes tax for a tax-exempt customer', () => {
    const data = buildPlanInvoiceData({ ...base, taxRate: 0.0875, taxExempt: true });
    expect(Number(data.subtotal)).toBe(1200);
    expect(Number(data.tax_rate)).toBe(0);
    expect(Number(data.tax_amount)).toBe(0);
    expect(Number(data.total_amount)).toBe(1200);
  });

  it('rounds tax to cents', () => {
    const data = buildPlanInvoiceData({
      ...base,
      lineItems: [{ name: 'Odd', quantity: 1, unit_price: 99.99 }],
      taxRate: 0.0875,
      taxExempt: false,
    });
    expect(Number(data.subtotal)).toBe(99.99);
    expect(Number(data.tax_amount)).toBe(8.75); // 8.749125 → 8.75
  });

  it('copies plan line items into invoice line items (all taxable in v1)', () => {
    const data = buildPlanInvoiceData({ ...base, taxRate: 0, taxExempt: false });
    expect(data.line_items.create).toEqual([
      { sequence: 1, description: 'Annual monitoring', quantity: 1, unit_price: 1000, is_taxable: true, line_total: 1000 },
      { sequence: 2, description: 'Filter service', quantity: 2, unit_price: 100, is_taxable: true, line_total: 200 },
    ]);
  });

  it('builds a job-less, SENT, kind=PLAN invoice linked to the plan', () => {
    const data = buildPlanInvoiceData({ ...base, taxRate: 0, taxExempt: false });
    expect(data.invoice_number).toBe('I00001');
    expect(data.organization_id).toBe('org-1');
    expect(data.customer_id).toBe('cust-1');
    expect(data.service_plan_id).toBe('plan-1');
    expect(data.public_token).toBe('tok-1');
    expect(data.job_id).toBeNull();
    expect(data.kind).toBe('PLAN');
    expect(data.status).toBe('SENT');
    expect(Number(data.discount_amount)).toBe(0);
    expect(Number(data.deposit_credit)).toBe(0);
  });
});
