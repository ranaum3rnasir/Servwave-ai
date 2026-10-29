/**
 * #2089 criterion 4 (PDF half) — once selections LOCK, an optional add-on the customer did not
 * take must read "Declined", not the generic "Optional (not included)" it prints while the
 * choice is still open. The public page already gets this right (#2090); the two PDF templates
 * did not, because `optionalMarkerFor` never learned the estimate could be locked at all.
 *
 * The lock predicate is `areSelectionsLocked` (`../../estimates/selectionLock`) — read from the
 * same two arms the public page and the staff write paths already gate on: a PAID deposit
 * invoice, or (with no deposit) an estimate that has gone WON. Not reinvented here.
 *
 * Asserted at the document-definition level, matching `optional-unselected-row.test.ts`'s own
 * convention — the builders are pure and synchronous, and a cell is far easier to name
 * structurally than to find in a rendered buffer.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../templates/alpha-classic';
import { buildCrmDefaultPdf } from '../templates/crm-default';
import {
  OPTIONAL_DECLINED_MARKER,
  OPTIONAL_INCLUDED_MARKER,
  OPTIONAL_ROW_MARKER,
  optionalMarkerFor,
} from '../../estimate-document-view';

const ORG = {
  name: 'Test Org',
  address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
  email: null, phone: null, website: null, logo_url: null, brand_color: '#0C2D3A',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
};

const COUNTED_LINE = { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 };
const OPTIONAL_LINE = { id: 'li-opt', description: 'Smart lock upgrade', item_type: 'MATERIAL', quantity: 1, unit_price: 500, line_total: 500, discount_amount: 0, is_optional: true, is_selected: false };
const OPTIONAL_SCOPE = { id: 'scope-opt', title: 'Repaint the frames', body: null, flat_price: 800, is_taxable: true, is_optional: true, is_selected: false };

function estimate(over: Record<string, unknown> = {}) {
  return {
    estimate_number: 'E00042',
    created_at: new Date('2026-09-01T00:00:00Z'),
    status: 'SENT',
    subtotal: 200,
    discount_type: null, discount_value: null, discount_name: null, discount_amount: 0,
    tax_rate: 0, tax_amount: 0, total_amount: 200,
    signature_data: null, signature_at: null,
    snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
    scope_notes: null,
    scopes: [],
    scope_photos: [],
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: null, phone: null },
    service_location: null,
    lead: null,
    line_items: [COUNTED_LINE, OPTIONAL_LINE],
    invoices: [],
    ...over,
  };
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

function printedRow(doc: unknown, title: string): unknown[] {
  const row = allTableRows(doc).find((cells) => allText(cells).includes(title));
  if (!row) throw new Error(`no printed row for ${title}`);
  return row;
}

describe.each([
  ['alpha-classic', buildAlphaClassicPdf],
  ['crm-default', buildCrmDefaultPdf],
])('%s — an optional add-on once selections are locked', (_name, build) => {
  it('still reads "Optional (not included)" while nothing has locked it', () => {
    const doc = build(estimate() as never, ORG as never);

    expect(allText(printedRow(doc, 'Smart lock upgrade'))).toContain(OPTIONAL_ROW_MARKER);
    expect(allText(printedRow(doc, 'Smart lock upgrade'))).not.toContain(OPTIONAL_DECLINED_MARKER);
  });

  it('reads "Declined" once the estimate is WON with no deposit invoice', () => {
    const doc = build(estimate({ status: 'WON' }) as never, ORG as never);

    expect(allText(printedRow(doc, 'Smart lock upgrade'))).toContain(OPTIONAL_DECLINED_MARKER);
    expect(allText(printedRow(doc, 'Smart lock upgrade'))).not.toContain(OPTIONAL_ROW_MARKER);
  });

  it('does not lock on a deposit invoice that is not yet PAID', () => {
    const doc = build(
      estimate({ status: 'SENT', invoices: [{ kind: 'DEPOSIT', status: 'SENT' }] }) as never,
      ORG as never,
    );

    expect(allText(printedRow(doc, 'Smart lock upgrade'))).toContain(OPTIONAL_ROW_MARKER);
    expect(allText(printedRow(doc, 'Smart lock upgrade'))).not.toContain(OPTIONAL_DECLINED_MARKER);
  });

  it('marks a LOCKED but TAKEN add-on "Optional", never "Declined"', () => {
    const doc = build(
      estimate({ status: 'WON', line_items: [COUNTED_LINE, { ...OPTIONAL_LINE, is_selected: true }] }) as never,
      ORG as never,
    );

    const taken = allText(printedRow(doc, 'Smart lock upgrade'));
    expect(taken).toContain(OPTIONAL_INCLUDED_MARKER);
    expect(taken).not.toContain(OPTIONAL_DECLINED_MARKER);
  });

  it('locks a declined optional SCOPE block the same way it locks a declined line', () => {
    const doc = build(
      estimate({ status: 'WON', scopes: [OPTIONAL_SCOPE] }) as never,
      ORG as never,
    );

    expect(allText(printedRow(doc, 'Repaint the frames'))).toContain(OPTIONAL_DECLINED_MARKER);
  });
});

/**
 * The marker's own contract, read straight off `optionalMarkerFor` with `locked` handed to it as a
 * value. Nothing here calls `areSelectionsLocked`, and that is the point.
 *
 * This block exists because one case above was retargeted rather than deleted quietly, in the
 * manner #2205 set for itself. That case was an unsigned estimate carrying a PAID deposit, and it
 * asserted "Declined". It is the one input on which the two branches disagree:
 *
 *   main     `if (deposit) return deposit.status === 'PAID'`  -> locked
 *   staging  `return estimate.status === 'WON'`               -> open
 *
 * PR #2205 (Ran's decision 6, 2026-09-18: signing locks, full stop) deleted the deposit arm on
 * staging and has not promoted to main. A PDF assertion built on that input therefore cannot be
 * green on both branches at once, and would have to be flipped on the way to main and flipped back
 * on the next promotion - a test whose expected value tracks the calendar, which is worse than no
 * test. The predicate's arms are already owned, on both branches, by
 * `frontend/src/__tests__/estimate-selection-lock.test.tsx` and the server lock suite; duplicating
 * them here bought nothing and cost the build.
 *
 * What #2089 actually promised is below: locked and untaken prints "Declined", open and untaken
 * prints "Optional (not included)", taken prints neither. Those hold whatever the predicate does,
 * and the end-to-end path through both templates is still covered above by the WON cases.
 */
describe('#2089 - the marker reads `locked` and nothing else', () => {
  const untaken = { optional: true, countsTowardTotals: false };

  it('prints "Declined" for an untaken add-on once the row is locked', () => {
    expect(optionalMarkerFor({ ...untaken, locked: true })).toBe(OPTIONAL_DECLINED_MARKER);
  });

  it('prints "Optional (not included)" for the same row while it is open', () => {
    expect(optionalMarkerFor({ ...untaken, locked: false })).toBe(OPTIONAL_ROW_MARKER);
  });

  it('treats a row built before `locked` existed as open, so old documents are unchanged', () => {
    expect(optionalMarkerFor(untaken)).toBe(OPTIONAL_ROW_MARKER);
  });

  it('never prints "Declined" for an add-on the customer took, locked or not', () => {
    const taken = { optional: true, countsTowardTotals: true };
    expect(optionalMarkerFor({ ...taken, locked: true })).toBe(OPTIONAL_INCLUDED_MARKER);
    expect(optionalMarkerFor({ ...taken, locked: false })).toBe(OPTIONAL_INCLUDED_MARKER);
  });
});
