/**
 * #2028 slice 3 — both PDF templates render only the sections that have content, as two distinct
 * sections. Ran's rule: "if there are no line items and only scope of work, we don't need to show
 * the line items; if we see both, they should be in two separate sections."
 *
 * The section decisions come from the shared view-model, so these assert that each template
 * OBEYS them: the heading is drawn, the other section's structure is not, and the totals still
 * reconcile with what is printed above them. A docDefinition is walked for its text rather than
 * compared whole — the parity snapshots next door hold the layout.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';

const ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test Org',
  legal_name: null,
  address_line1: '1 Example Street',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US',
  email: 'info@example.test',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: 'Note A',
  estimate_payment_terms: '70% on acceptance',
};

const SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
};

/** A described-but-not-separately-priced block. Prints a BLANK Amount and adds nothing. */
const UNPRICED_SCOPE = {
  id: 'scope-2',
  title: 'Haul away and dispose of the old units',
  body: null,
  flat_price: null,
  is_taxable: true,
};

/** Every `text` string in the document, in document order. */
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.text === 'string') out.push(o.text);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'text') continue;
      texts(v, out);
    }
    return out;
  }
  return out;
}

/**
 * Every value assigned to a `text` property, whatever its TYPE.
 *
 * `texts()` above collects only strings, so it is blind to exactly the failure a suppressed
 * heading invites: a renderer that keeps drawing the node and hands pdfmake `{ text: null }`, or
 * one that interpolates the missing title and prints the word "null" to the customer. Both are
 * invisible to a `not.toContain('Line Items')` assertion, and both are visible here.
 */
function rawTexts(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) rawTexts(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('text' in o) out.push(o.text);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'text') continue;
      rawTexts(v, out);
    }
    return out;
  }
  return out;
}

/** Every text node the document draws is a real string, with no "null" left in the copy. */
function expectNoNullText(docDef: unknown): void {
  const raw = rawTexts((docDef as { content: unknown }).content);
  expect(raw.filter((t) => typeof t !== 'string')).toEqual([]);
  expect(raw.filter((t) => typeof t === 'string' && (t as string).toLowerCase().includes('null'))).toEqual([]);
}

/**
 * `$1,188.10` -> 1188.1, `−$50.00` -> -50. Null for a cell that prints no figure at all — an
 * unpriced scope block's blank Amount, or a column header. Never a zero: a zero would quietly
 * satisfy a sum that should have been short.
 */
function parseAmount(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // U+2212 MINUS SIGN is what the totals rows print for a subtraction, not a hyphen.
  const n = Number(trimmed.replace(/−/g, '-').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every SECTION table in the document, found by its width signature.
 *
 * Matching on widths is what keeps the header/address tables and the totals table out of the sum:
 * a document holds several tables and only the section ones carry priced rows. Alpha Classic's
 * are `['*', 70]` (scope) and `['*', 40, 70, 70]` (line items); the CRM default draws both in
 * `[64, '*', 80]`, or `['*', 80]` where the section has no image for the icon column. Its totals
 * live in a `columns` stack and Alpha Classic's in a `[75, 75]` table, so neither can be swept in
 * by accident.
 */
function sectionTables(node: unknown, signatures: string[], out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) sectionTables(child, signatures, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.table?.widths && signatures.includes(JSON.stringify(o.table.widths))) out.push(o.table);
    for (const value of Object.values(o)) sectionTables(value, signatures, out);
    return out;
  }
  return out;
}

/**
 * The Amount printed on every section row, in document order. The LAST cell of each body row is
 * the Amount column in both templates; `headerRows` rows are skipped so a grey "Amount" header is
 * never mistaken for a blank.
 *
 * A discounted line stacks its struck-through gross above its net — the net is the last text in
 * the cell, and the one the Sub total contains.
 */
function printedRowAmounts(docDef: unknown, signatures: string[]): Array<number | null> {
  const amounts: Array<number | null> = [];
  for (const table of sectionTables((docDef as { content: unknown }).content, signatures)) {
    for (const row of (table.body as any[]).slice(table.headerRows ?? 0)) {
      const printed = texts(row[row.length - 1]);
      amounts.push(printed.length === 0 ? null : parseAmount(printed[printed.length - 1]));
    }
  }
  return amounts;
}

/**
 * The figure printed immediately after a totals label. Both templates put the label and its
 * amount side by side in one array — a `[75, 75]` table row in Alpha Classic, a two-column
 * `columns` in the CRM default — so one walk reads both.
 *
 * NOTE for anyone extending these: never `toEqual` a whole docDefinition. Its `layout` callbacks
 * are fresh closures on every build, so structural equality fails spuriously; compare via JSON,
 * or read the figures out like this.
 */
function printedFigure(docDef: unknown, label: string | RegExp): number | null {
  let found: number | null | undefined;
  const matches = (t: unknown) =>
    typeof t === 'string' && (typeof label === 'string' ? t === label : label.test(t));

  const visit = (node: unknown): void => {
    if (found !== undefined) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length - 1; i += 1) {
        const cell = node[i] as Record<string, unknown> | null;
        const next = node[i + 1] as Record<string, unknown> | null;
        if (cell && typeof cell === 'object' && matches(cell.text) && next && typeof next === 'object') {
          found = parseAmount(next.text);
          return;
        }
      }
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) visit(value);
    }
  };

  visit((docDef as { content: unknown }).content);
  return found ?? null;
}

/** Cents-rounded sum, skipping the rows that print no amount. Floats are not money. */
function sumAmounts(amounts: Array<number | null>): number {
  return Math.round(amounts.reduce<number>((total, a) => total + (a ?? 0), 0) * 100) / 100;
}

interface TemplateVoice {
  scope: string;
  lines: string;
  subtotal: string;
  /** The width signatures of this template's SECTION tables — see `sectionTables`. */
  sectionWidths: string[];
}

const TEMPLATES: Array<[string, (e: never, o: never) => unknown, TemplateVoice]> = [
  // Each template's OWN heading voice: Alpha Classic labels its blocks "Thing:", the CRM default
  // uses an unpunctuated bold 11pt heading.
  [
    'alpha-classic',
    buildAlphaClassicPdf as never,
    {
      scope: 'Scope of Work:',
      lines: 'Line Items:',
      subtotal: 'Sub total',
      sectionWidths: [JSON.stringify(['*', 70]), JSON.stringify(['*', 40, 70, 70])],
    },
  ],
  [
    'crm-default',
    buildCrmDefaultPdf as never,
    {
      scope: 'Scope of Work',
      lines: 'Line Items',
      subtotal: 'Subtotal',
      // Two signatures since 2026-09-13: the CRM default keeps its 64pt icon column only for a
      // section that has a price-book image to draw in it, and narrows to two columns otherwise.
      sectionWidths: [JSON.stringify([64, '*', 80]), JSON.stringify(['*', 80])],
    },
  ],
];

describe.each(TEMPLATES)('%s section gating', (_name, build, heading) => {
  const built = (over: Record<string, unknown>) =>
    build({ ...PREVIEW_ESTIMATE_FIXTURE, ...over } as never, ORG as never);
  const doc = (over: Record<string, unknown>) => texts((built(over) as { content: unknown }).content);

  // Ran, 2026-09-13, after reviewing the rendered PDFs: a lone section is printed with NO heading
  // over it. The heading exists to tell the reader which of two sections they are looking at, and
  // over the whole document it says nothing. Symmetric — neither heading survives on its own.
  it('draws the scope content bare, under no heading at all, when the estimate is scope of work only', () => {
    const over = { line_items: [], scopes: [SCOPE], subtotal: 2000, tax_amount: 0, total_amount: 2000 };
    const docDef = built(over);
    const printed = texts((docDef as { content: unknown }).content);

    expect(printed).not.toContain(heading.scope);
    expect(printed).not.toContain(heading.lines);
    expect(printed).toContain('Install 3 commercial storefront doors');
    // The heading is not drawn at all — not drawn empty, and not drawn with the missing title
    // interpolated into it.
    expectNoNullText(docDef);
  });

  it('draws the line items bare, under no heading at all, when the estimate is line items only', () => {
    const docDef = built({ scopes: null });
    const printed = texts((docDef as { content: unknown }).content);

    expect(printed).not.toContain(heading.lines);
    expect(printed).not.toContain(heading.scope);
    expect(printed).toContain('Item 1');
    expectNoNullText(docDef);
  });

  it('draws two sections, scope of work first, when the estimate has both', () => {
    const printed = doc({ scopes: [SCOPE], subtotal: 3188.10, total_amount: 3266.81 });

    expect(printed).toContain(heading.scope);
    expect(printed).toContain(heading.lines);
    expect(printed.indexOf(heading.scope)).toBeLessThan(printed.indexOf(heading.lines));
    // The scope block is printed inside the scope section, above the line-item heading — two
    // sections, not one list with a label dropped on the front of it.
    expect(printed.indexOf('Install 3 commercial storefront doors')).toBeLessThan(printed.indexOf(heading.lines));
    expect(printed.indexOf('Item 1')).toBeGreaterThan(printed.indexOf(heading.lines));
  });

  it('prints the scope narrative inside the scope section, never under a second identical heading', () => {
    const printed = doc({
      scope_notes: 'Work is performed during business hours.',
      scopes: [SCOPE],
      subtotal: 3188.10,
      total_amount: 3266.81,
    });

    expect(printed.filter((t) => t === heading.scope)).toHaveLength(1);
    expect(printed.indexOf('Work is performed during business hours.')).toBeGreaterThan(printed.indexOf(heading.scope));
    expect(printed.indexOf('Work is performed during business hours.')).toBeLessThan(printed.indexOf(heading.lines));
  });

  it('prints the totals in all three states', () => {
    // The Sub total is the literal sum of the Amount column printed above it, in every state.
    // Asserting only that the WORDS "Sub total" and "Total" appear proves a label was drawn, not
    // that the document adds up: a template that printed the right sections with the wrong
    // figures would pass. The expected sums are DERIVED from the docDefinition, never restated —
    // the discounted line's NET, the unpriced block's blank, and nothing from the header strip.
    const states: Array<[string, Record<string, unknown>, Array<number | null>]> = [
      // A priced block and an unpriced one: the blank Amount must not become a zero, and must not
      // be dropped from the row list either.
      [
        'scope only',
        { line_items: [], scopes: [SCOPE, UNPRICED_SCOPE], subtotal: 2000, tax_amount: 0, total_amount: 2000 },
        [2000, null],
      ],
      // The fixture's four lines: 499 + 450 + 89.10 (net of a 10% discount on 99) + 150.
      ['line items only', { scopes: null }, [499, 450, 89.1, 150]],
      [
        'both',
        { scopes: [SCOPE, UNPRICED_SCOPE], subtotal: 3188.10, total_amount: 3266.81 },
        [2000, null, 499, 450, 89.1, 150],
      ],
    ];

    for (const [state, over, expectedRows] of states) {
      const docDef = built(over);
      const printed = texts((docDef as { content: unknown }).content);
      expect(printed, state).toContain(heading.subtotal);

      const rows = printedRowAmounts(docDef, heading.sectionWidths);
      expect(rows, state).toEqual(expectedRows);

      const subtotal = printedFigure(docDef, heading.subtotal);
      const tax = printedFigure(docDef, /^Tax/);
      const total = printedFigure(docDef, 'Total');
      expect(subtotal, state).toBe(sumAmounts(rows));
      // Total is still drawn in every state, including the ones where the line-item table it used
      // to sit under was never built at all.
      expect(total, state).toBeCloseTo(sumAmounts(rows) + (tax ?? 0), 2);
    }
  });
});

describe('alpha-classic column strip', () => {
  it('draws no Description / QTY / Price / Amount strip when there are no line items', () => {
    const printed = texts(
      buildAlphaClassicPdf(
        { ...PREVIEW_ESTIMATE_FIXTURE, line_items: [], scopes: [SCOPE], subtotal: 2000, tax_amount: 0, total_amount: 2000 } as never,
        ORG as never,
      ).content,
    );

    // The strip used to be the table's first row unconditionally, so a scope-only estimate
    // printed four column headers over nothing at all.
    expect(printed).not.toContain('QTY');
    expect(printed).not.toContain('Price');
  });

  it('gives the scope section its own two-column strip, without the columns a scope has no value for', () => {
    const printed = texts(
      buildAlphaClassicPdf(
        { ...PREVIEW_ESTIMATE_FIXTURE, scopes: [SCOPE], subtotal: 3188.10, total_amount: 3266.81 } as never,
        ORG as never,
      ).content,
    );

    // Description / Amount head both tables; QTY and Price appear once, over the line items.
    expect(printed.filter((t) => t === 'Description')).toHaveLength(2);
    expect(printed.filter((t) => t === 'QTY')).toHaveLength(1);
    expect(printed.filter((t) => t === 'Amount')).toHaveLength(2);
  });
});
