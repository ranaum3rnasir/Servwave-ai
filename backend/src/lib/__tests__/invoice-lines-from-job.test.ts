import { describe, it, expect } from 'vitest';
import { Prisma, PriceBookItemType } from '@prisma/client';
import { jobLineToInvoiceLineCreate } from '../invoice-lines-from-job';

// #1991: jobLineToInvoiceLineCreate is the JobLineItem -> InvoiceLineItem copier, and it carries
// markup_percent across a TABLE boundary verbatim. That is the concrete reason all three
// markup_percent columns had to widen to Decimal(8,2) in ONE migration: widening job_line_items
// alone would just relocate the 22003 overflow into job-to-invoice conversion. These tests pin the
// pass-through so no future clamp (e.g. back to 100) can be reintroduced here.

const baseLine = {
  id: '11111111-1111-1111-1111-111111111111',
  description: 'high-markup material',
  quantity: 1,
  unit_price: 34164.43,
  is_taxable: true,
  line_total: 34164.43,
  item_type: 'MATERIAL' as PriceBookItemType,
  price_book_item_id: null,
  unit_cost: null,
};

describe('jobLineToInvoiceLineCreate — markup_percent pass-through', () => {
  it('carries a plain-number markup_percent of 1000 onto the invoice line unchanged', () => {
    const out = jobLineToInvoiceLineCreate({ ...baseLine, markup_percent: 1000 }, 0);
    expect(out.markup_percent).toBe(1000);
  });

  it('carries a Prisma.Decimal markup_percent of 1000 onto the invoice line unchanged', () => {
    const markup = new Prisma.Decimal(1000);
    const out = jobLineToInvoiceLineCreate({ ...baseLine, markup_percent: markup }, 0);
    expect(out.markup_percent).toBe(markup);
    expect(String(out.markup_percent)).toBe('1000');
  });

  it('carries the 100000 bound itself onto the invoice line unchanged', () => {
    const out = jobLineToInvoiceLineCreate({ ...baseLine, markup_percent: 100000 }, 0);
    expect(out.markup_percent).toBe(100000);
  });

  it('omits markup_percent entirely when the job line has none', () => {
    const out = jobLineToInvoiceLineCreate({ ...baseLine, markup_percent: null }, 0);
    expect('markup_percent' in out).toBe(false);
  });
});
