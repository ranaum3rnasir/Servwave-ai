/**
 * #2028 × #2053 — what the two PDF templates PRINT for an optional item the customer has not
 * selected.
 *
 * Ran's call (2026-09-13): LIST it, SHOW its amount, MARK it optional, and keep it out of the
 * totals. A blank amount cell — what this branch printed before — is ambiguous: it reads as
 * "included at no charge", the opposite of what it means. The customer is entitled to know what
 * they were offered and what it would cost, which is the standard convention on a quote; what
 * they must not be able to mistake is whether it is in the price, and that is the marker's job.
 *
 * Asserted on the document DEFINITION rather than the rendered PDF: the builders are pure and
 * synchronous, and a cell is far easier to name structurally than to find in a buffer.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../templates/alpha-classic';
import { buildCrmDefaultPdf } from '../templates/crm-default';
import { OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER, OPTIONAL_TOTALS_NOTE } from '../../estimate-document-view';

const ORG = {
  name: 'Test Org',
  address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
  email: null, phone: null, website: null, logo_url: null, brand_color: '#0C2D3A',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
};

const COUNTED_LINE = { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 };
const OPTIONAL_LINE = { id: 'li-opt', description: 'Smart lock upgrade', item_type: 'MATERIAL', quantity: 1, unit_price: 500, line_total: 500, discount_amount: 0, is_optional: true, is_selected: false };
const COUNTED_SCOPE = { id: 'scope-1', title: 'Install 3 storefront doors', body: null, flat_price: 1000, is_taxable: true };
const OPTIONAL_SCOPE = { id: 'scope-opt', title: 'Repaint the frames', body: null, flat_price: 800, is_taxable: true, is_optional: true, is_selected: false };

/**
 * A $200 keypad and a $1,000 scope block, both counted: Subtotal $1,200, tax $120, Total $1,320.
 * The tax is deliberately NON-zero — with a zero tax the Tax row itself prints "$0.00" and an
 * assertion about a line's amount could be answered by a totals row instead.
 *
 * Every figure is distinct, so an occurrence count is unambiguous about which cell it came from:
 * 200 / 1,000 / 1,200 / 120 / 1,320 counted, 500 / 800 optional.
 */
function estimate(over: Record<string, unknown> = {}) {
  return {
    estimate_number: 'E00042',
    created_at: new Date('2026-09-01T00:00:00Z'),
    status: 'SENT',
    subtotal: 1200,
    discount_type: null, discount_value: null, discount_name: null, discount_amount: 0,
    tax_rate: 0.1, tax_amount: 120, total_amount: 1320,
    signature_data: null, signature_at: null,
    snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
    scope_notes: null,
    scopes: [COUNTED_SCOPE],
    scope_photos: [],
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: null, phone: null },
    service_location: null,
    lead: null,
    line_items: [COUNTED_LINE],
    ...over,
  };
}

/** The same document, plus an optional line item and an optional scope block, neither selected. */
function withOptional(): Record<string, unknown> {
  return estimate({ line_items: [COUNTED_LINE, OPTIONAL_LINE], scopes: [COUNTED_SCOPE, OPTIONAL_SCOPE] });
}

/**
 * #2090 - the MIXED document: the $500 line add-on TAKEN, the $800 scope add-on not. Subtotal
 * $1,700, tax $170, Total $1,870, all three moved by the $500 that is now in the price.
 */
function withOneTaken(): Record<string, unknown> {
  return estimate({
    subtotal: 1700, tax_amount: 170, total_amount: 1870,
    line_items: [COUNTED_LINE, { ...OPTIONAL_LINE, is_selected: true }],
    scopes: [COUNTED_SCOPE, OPTIONAL_SCOPE],
  });
}

/** And the same document with BOTH taken: Subtotal $2,500, tax $250, Total $2,750. */
function withBothTaken(): Record<string, unknown> {
  return estimate({
    subtotal: 2500, tax_amount: 250, total_amount: 2750,
    line_items: [COUNTED_LINE, { ...OPTIONAL_LINE, is_selected: true }],
    scopes: [COUNTED_SCOPE, { ...OPTIONAL_SCOPE, is_selected: true }],
  });
}

/** Every string anywhere in a pdfmake node, in document order. */
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

/** Every `table.body` row in the document, in document order. */
function allTableRows(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) { for (const n of node) allTableRows(n, out); return out; }
  if (node && typeof node === 'object') {
    const table = (node as { table?: { body?: unknown[][] } }).table;
    if (table?.body) for (const row of table.body) out.push(row);
    for (const v of Object.values(node as Record<string, unknown>)) allTableRows(v, out);
  }
  return out;
}

/**
 * The cells of the printed row whose description carries `title` — so an assertion can name the
 * AMOUNT cell rather than searching the whole document for a figure, which would be answered just
 * as happily by the unit-price cell beside it.
 */
function printedRow(doc: unknown, title: string): unknown[] {
  const row = allTableRows(doc).find((cells) => allText(cells).includes(title));
  if (!row) throw new Error(`no printed row for ${title}`);
  return row;
}

/** The text of a row's LAST cell — the Amount column on every table either template draws. */
function amountCell(doc: unknown, title: string): string[] {
  const cells = printedRow(doc, title);
  return allText(cells[cells.length - 1]);
}

/**
 * The totals block: the SMALLEST node carrying both the subtotal row and the Total row. Found by
 * content rather than by position, so it cannot quietly start matching something else — the
 * header's own "Total" line carries no subtotal label, and a section table carries neither.
 *
 * Compared as JSON, never with `toEqual`: pdfmake's `layout` callbacks are fresh closures on
 * every build and are never reference-equal.
 */
function totalsBlock(doc: unknown, subtotalLabel: string): unknown {
  const candidates: Array<{ node: unknown; size: number }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const text = allText(node);
    if (text.includes(subtotalLabel) && text.includes('Total')) candidates.push({ node, size: text.length });
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(doc);
  if (candidates.length === 0) throw new Error('no totals block');
  return candidates.sort((a, b) => a.size - b.size)[0]!.node;
}

describe.each([
  ['alpha-classic', buildAlphaClassicPdf, 'Sub total'],
  ['crm-default', buildCrmDefaultPdf, 'Subtotal'],
])('%s — an optional add-on the customer has not selected', (_name, build, subtotalLabel) => {
  const doc = build(withOptional() as never, ORG as never);
  const without = build(estimate() as never, ORG as never);

  it('still lists the add-on — the customer was offered it', () => {
    expect(allText(doc)).toContain('Smart lock upgrade');
  });

  it('prints what the add-on would cost, in its own Amount cell', () => {
    expect(amountCell(doc, 'Smart lock upgrade')).toContain('$500.00');
  });

  it('prints what the optional scope block would cost, in its own Amount cell', () => {
    expect(amountCell(doc, 'Repaint the frames')).toContain('$800.00');
  });

  it('marks both optional rows, so their figures cannot be read as part of the price', () => {
    expect(allText(printedRow(doc, 'Smart lock upgrade'))).toContain(OPTIONAL_ROW_MARKER);
    expect(allText(printedRow(doc, 'Repaint the frames'))).toContain(OPTIONAL_ROW_MARKER);
  });

  it('marks nothing on a row the customer IS being charged for', () => {
    expect(allText(printedRow(doc, 'Keypad'))).not.toContain(OPTIONAL_ROW_MARKER);
    expect(allText(printedRow(doc, 'Install 3 storefront doors'))).not.toContain(OPTIONAL_ROW_MARKER);
  });

  it('says once, beneath the totals, that the optional figures are not in the Total', () => {
    expect(allText(doc).filter((t) => t === OPTIONAL_TOTALS_NOTE)).toHaveLength(1);
  });

  it('says nothing of the sort on a document that offers nothing optional', () => {
    expect(allText(without)).not.toContain(OPTIONAL_TOTALS_NOTE);
  });

  /**
   * THE property this whole piece of work turns on: offering the customer two optional add-ons
   * worth $1,300 moves nothing in the block that tells them what to pay. Byte-for-byte, against
   * the very same estimate without them.
   */
  it('moves not one figure in the totals block by adding the two optional rows', () => {
    expect(JSON.stringify(totalsBlock(doc, subtotalLabel)))
      .toEqual(JSON.stringify(totalsBlock(without, subtotalLabel)));
  });

  it('keeps the optional figures out of the totals block entirely', () => {
    const totals = allText(totalsBlock(doc, subtotalLabel));

    expect(totals.filter((t) => t.includes('$500.00'))).toHaveLength(0);
    expect(totals.filter((t) => t.includes('$800.00'))).toHaveLength(0);
    expect(totals).toContain('$1,200.00');
    expect(totals).toContain('$1,320.00');
  });

  /**
   * #2090 - the MIXED state, which no fixture in this file reached before: one add-on taken and
   * one not. It is the state the note was FALSE in, and the state a rep produces simply by
   * pre-selecting an option, long before slice 3 let a customer produce it themselves.
   */
  describe('with one add-on taken and one not', () => {
    const mixed = build(withOneTaken() as never, ORG as never);

    it('puts the taken add-on inside the totals and leaves the untaken one out', () => {
      const totals = allText(totalsBlock(mixed, subtotalLabel));

      // $1,200 + the $500 add-on the customer took. The $800 they did not is nowhere in here.
      expect(totals).toContain('$1,700.00');
      expect(totals).toContain('$1,870.00');
      expect(totals.filter((t) => t.includes('$800.00'))).toHaveLength(0);
    });

    it('still prints the note, and the note is TRUE: one row is still marked not included', () => {
      expect(allText(mixed).filter((t) => t === OPTIONAL_TOTALS_NOTE)).toHaveLength(1);
      expect(allText(printedRow(mixed, 'Repaint the frames'))).toContain(OPTIONAL_ROW_MARKER);
    });

    it('tags the taken add-on Optional, without the "not included" half', () => {
      const taken = allText(printedRow(mixed, 'Smart lock upgrade'));

      expect(taken).toContain(OPTIONAL_INCLUDED_MARKER);
      expect(taken).not.toContain(OPTIONAL_ROW_MARKER);
    });

    it('still tags nothing on a row that was never optional', () => {
      expect(allText(printedRow(mixed, 'Keypad'))).not.toContain(OPTIONAL_INCLUDED_MARKER);
      expect(allText(printedRow(mixed, 'Keypad'))).not.toContain(OPTIONAL_ROW_MARKER);
    });
  });

  /** And with every add-on taken there is nothing left to explain, so the note drops away. */
  describe('with every add-on taken', () => {
    const all = build(withBothTaken() as never, ORG as never);

    it('drops the note entirely rather than printing a sentence about nothing', () => {
      expect(allText(all)).not.toContain(OPTIONAL_TOTALS_NOTE);
      expect(allText(all)).not.toContain(OPTIONAL_ROW_MARKER);
    });

    it('keeps both add-ons tagged Optional, so the customer sees which were their choice', () => {
      expect(allText(printedRow(all, 'Smart lock upgrade'))).toContain(OPTIONAL_INCLUDED_MARKER);
      expect(allText(printedRow(all, 'Repaint the frames'))).toContain(OPTIONAL_INCLUDED_MARKER);
    });

    it('carries both add-ons inside the totals', () => {
      const totals = allText(totalsBlock(all, subtotalLabel));

      expect(totals).toContain('$2,500.00');
      expect(totals).toContain('$2,750.00');
    });
  });
});
