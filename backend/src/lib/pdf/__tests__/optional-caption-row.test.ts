/**
 * #2089 criterion 3 — "N of M optional add-ons included" on the two PDF templates (staff PDF and
 * customer PDF share these same builders; the public page is deliberately NOT wired to this, see
 * `handoffs/implement.md`'s judgement note — it already carries a separate, itemised "Optional
 * add-ons" section (#2090) that names each add-on and its taken/declined state, so a second,
 * duplicate roll-up sentence there would restate what the reader is looking straight at).
 *
 * M counts every optional ROW — a line item or a scope block alike (#2053 R8: a table-row count
 * alone would undercount a document that mixes both), matching the definition the internal staff
 * receipt card already uses (`EstimateReceiptCard.tsx`). No currency figure. Absent entirely when
 * M is 0, so a document that offers nothing optional is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../templates/alpha-classic';
import { buildCrmDefaultPdf } from '../templates/crm-default';

const ORG = {
  name: 'Test Org',
  address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
  email: null, phone: null, website: null, logo_url: null, brand_color: '#0C2D3A',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
};

const COUNTED_LINE = { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 };
const OPTIONAL_LINE_A = { id: 'li-opt-a', description: 'Smart lock upgrade', item_type: 'MATERIAL', quantity: 1, unit_price: 500, line_total: 500, discount_amount: 0, is_optional: true, is_selected: false };
const OPTIONAL_LINE_B = { id: 'li-opt-b', description: 'Extra keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 100, line_total: 100, discount_amount: 0, is_optional: true, is_selected: true };
const OPTIONAL_SCOPE = { id: 'scope-opt', title: 'Repaint the frames', body: null, flat_price: 800, is_taxable: true, is_optional: true, is_selected: false };

function estimate(over: Record<string, unknown> = {}) {
  return {
    estimate_number: 'E00042',
    created_at: new Date('2026-09-01T00:00:00Z'),
    status: 'SENT',
    subtotal: 300,
    discount_type: null, discount_value: null, discount_name: null, discount_amount: 0,
    tax_rate: 0, tax_amount: 0, total_amount: 300,
    signature_data: null, signature_at: null,
    snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
    scope_notes: null,
    scopes: [],
    scope_photos: [],
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: null, phone: null },
    service_location: null,
    lead: null,
    line_items: [COUNTED_LINE],
    invoices: [],
    ...over,
  };
}

function allText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'text' && typeof v === 'string') out.push(v);
      else allText(v, out);
    }
  }
  return out;
}

describe.each([
  ['alpha-classic', buildAlphaClassicPdf],
  ['crm-default', buildCrmDefaultPdf],
])('%s — the optional add-on count caption', (_name, build) => {
  it('says nothing when the document offers no optional rows (M=0)', () => {
    const doc = build(estimate() as never, ORG as never);

    expect(allText(doc).some((t) => t.includes('optional add-ons included'))).toBe(false);
  });

  it('counts one taken, one untaken line, and one untaken scope block: "1 of 3"', () => {
    const doc = build(
      estimate({
        line_items: [COUNTED_LINE, OPTIONAL_LINE_A, OPTIONAL_LINE_B],
        scopes: [OPTIONAL_SCOPE],
      }) as never,
      ORG as never,
    );

    expect(allText(doc)).toContain('1 of 3 optional add-ons included');
  });

  it('reports every optional row included once every one is taken: "2 of 2"', () => {
    const doc = build(
      estimate({ line_items: [COUNTED_LINE, { ...OPTIONAL_LINE_A, is_selected: true }, OPTIONAL_LINE_B] }) as never,
      ORG as never,
    );

    expect(allText(doc)).toContain('2 of 2 optional add-ons included');
  });

  it('carries no currency figure anywhere in the caption', () => {
    const doc = build(estimate({ line_items: [COUNTED_LINE, OPTIONAL_LINE_A] }) as never, ORG as never);
    const caption = allText(doc).find((t) => t.includes('optional add-ons included'));

    expect(caption).toBeDefined();
    expect(caption).not.toMatch(/\$/);
  });
});
