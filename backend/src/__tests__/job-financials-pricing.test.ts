import { describe, it, expect } from 'vitest';
import { limitFinancialsToInvoices } from '../controllers/job.controller';

const payload = {
  final_invoice: {
    id: 'inv-1', invoice_number: 'I00001', status: 'SENT',
    total_amount: 900, amount_due: 400,
    sent_at: new Date('2026-01-02'), paid_at: null,
  },
  invoices: [{
    id: 'inv-1', invoice_number: 'I00001', kind: 'STANDARD', status: 'SENT',
    total_amount: 900, amount_due: 400, sent_at: new Date('2026-01-02'), paid_at: null,
    tip: 0, tax_rate: 8.25, tax_amount: 68, discount_amount: 0, subtotal: 832,
    line_items: [{
      id: 'l-1', sequence: 1, description: 'Compressor', quantity: 1,
      unit_price: 832, is_taxable: true, line_total: 832,
      discount_type: null, discount_value: null, discount_amount: 0,
      item_type: 'MATERIAL', price_book_item_id: null, price_book_item: null,
    }],
  }],
  payments: [{
    id: 'p-1', invoice_id: 'inv-1', invoice_number: 'I00001', invoice_kind: 'STANDARD',
    amount: 500, method: 'CARD', paid_at: new Date('2026-01-03'),
    voided_at: null, reference_number: 'ch_1',
  }],
  total_invoiced: 1400,
  total_paid: 500,
};

/** A second invoice on the same job, with its own payment, that the person looking may not open. */
const other = {
  invoice: { ...payload.invoices[0]!, id: 'inv-2', invoice_number: 'I00002', total_amount: 500, amount_due: 500 },
  payment: { ...payload.payments[0]!, id: 'p-2', invoice_id: 'inv-2', invoice_number: 'I00002', amount: 0 },
};
const both = { ...payload, invoices: [...payload.invoices, other.invoice], payments: [...payload.payments, other.payment] };


describe('limitFinancialsToInvoices', () => {
  it('keeps every invoice and payment for a person who can open them all', () => {
    expect(limitFinancialsToInvoices(both, new Set(['inv-1', 'inv-2']))).toEqual(both);
  });

  it('lists only the invoices the person can open, and only the payments on them', () => {
    const out = limitFinancialsToInvoices(both, new Set(['inv-1'])) as Record<string, any>;
    expect(out.invoices.map((i: { id: string }) => i.id)).toEqual(['inv-1']);
    expect(out.payments.map((p: { id: string }) => p.id)).toEqual(['p-1']);
  });

  it('leaves the job\'s own figures and the lifecycle-bar fields alone, whichever invoices the person can open', () => {
    const out = limitFinancialsToInvoices(both, new Set()) as Record<string, any>;
    expect(out.invoices).toEqual([]);
    expect(out.payments).toEqual([]);
    expect(out.final_invoice).toEqual(both.final_invoice);
    expect(out.total_invoiced).toBe(1400);
    expect(out.total_paid).toBe(500);
  });

  it('keeps the prices of an invoice the person can open', () => {
    const out = limitFinancialsToInvoices(both, new Set(['inv-1'])) as Record<string, any>;
    expect(out.invoices[0].total_amount).toBe(900);
    expect(out.invoices[0].line_items[0].unit_price).toBe(832);
  });

  it('tolerates a job with no invoices', () => {
    const empty = { final_invoice: null, invoices: [], payments: [] };
    expect(limitFinancialsToInvoices(empty, new Set())).toEqual(empty);
  });
});
