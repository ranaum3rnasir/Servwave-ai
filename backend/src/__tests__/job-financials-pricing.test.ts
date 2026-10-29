import { describe, it, expect } from 'vitest';
import { stripFinancialsForRequester } from '../controllers/job.controller';

// Minimal request doubles — canSeePricing reads req.ability.can('read','Invoice') only.
const pricedReq = { ability: { can: () => true } } as never;
const blindReq = { ability: { can: () => false } } as never;

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
};

describe('stripFinancialsForRequester', () => {
  it('is a no-op for a requester who can read Invoice', () => {
    expect(stripFinancialsForRequester(payload, pricedReq)).toEqual(payload);
  });

  it('removes every money field for a price-blind requester', () => {
    const out = stripFinancialsForRequester(payload, blindReq) as Record<string, any>;
    expect(out.final_invoice).not.toHaveProperty('total_amount');
    expect(out.final_invoice).not.toHaveProperty('amount_due');
    const inv = out.invoices[0];
    for (const k of ['total_amount', 'amount_due', 'tip', 'tax_rate', 'tax_amount', 'discount_amount', 'subtotal']) {
      expect(inv).not.toHaveProperty(k);
    }
    const line = inv.line_items[0];
    for (const k of ['unit_price', 'line_total', 'discount_type', 'discount_value', 'discount_amount']) {
      expect(line).not.toHaveProperty(k);
    }
    expect(out.payments).toEqual([]);
  });

  it('preserves the lifecycle-bar fields Spec B2 depends on', () => {
    const out = stripFinancialsForRequester(payload, blindReq) as Record<string, any>;
    expect(out.final_invoice.sent_at).toEqual(new Date('2026-01-02'));
    expect(out.final_invoice.paid_at).toBeNull();
    expect(out.final_invoice.status).toBe('SENT');
    expect(out.invoices[0].sent_at).toEqual(new Date('2026-01-02'));
    // Materials identity survives — a technician still sees WHAT is on the job.
    expect(out.invoices[0].line_items[0].description).toBe('Compressor');
    expect(out.invoices[0].line_items[0].quantity).toBe(1);
  });

  it('tolerates a job with no final invoice', () => {
    const empty = { final_invoice: null, invoices: [], payments: [] };
    expect(stripFinancialsForRequester(empty, blindReq)).toEqual(empty);
  });
});
