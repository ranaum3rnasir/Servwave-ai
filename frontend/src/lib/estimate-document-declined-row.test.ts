/**
 * #2089 criterion 4 (PDF half), frontend twin — `optionalMarkerFor`/`DocumentRow` must carry the
 * SAME lock-aware "Declined" behaviour the backend half of this mirror gets
 * (`backend/src/lib/pdf/__tests__/optional-declined-row.test.ts`), because
 * `estimate-document-view-twins.test.ts` requires the two files' shared exports to stay
 * byte-identical (minus comments). Nothing on this page currently RENDERS the row marker in a
 * locked state (the public page's own separate "Optional add-ons" section already prints
 * "Declined" independently, per #2090) — this pins the shared predicate itself so the twin
 * cannot drift now that the backend half changes.
 */
import { describe, it, expect } from 'vitest';
import {
  OPTIONAL_DECLINED_MARKER,
  OPTIONAL_INCLUDED_MARKER,
  OPTIONAL_ROW_MARKER,
  buildEstimateDocumentModel,
  optionalMarkerFor,
} from './estimate-document-view';

const OPTIONAL_LINE = { id: 'li-opt', description: 'Smart lock upgrade', item_type: 'MATERIAL', quantity: 1, unit_price: 500, line_total: 500, discount_amount: 0, is_optional: true, is_selected: false };
const COUNTED_LINE = { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 };

function input(over: Record<string, unknown> = {}) {
  return {
    scopeNotes: null,
    lineItems: [COUNTED_LINE, OPTIONAL_LINE],
    scopes: [],
    subtotal: 200,
    taxAmount: 0,
    totalAmount: 200,
    discountName: null,
    discountAmount: 0,
    ...over,
  };
}

describe('the frontend document view-model, once selections are locked', () => {
  it('keeps "Optional (not included)" while unlocked', () => {
    const view = buildEstimateDocumentModel(input());
    const row = view.rows.find((r) => r.title === 'Smart lock upgrade')!;

    expect(optionalMarkerFor(row)).toBe(OPTIONAL_ROW_MARKER);
  });

  it('prints "Declined" for an untaken optional row once `locked` is true', () => {
    const view = buildEstimateDocumentModel(input({ locked: true }));
    const row = view.rows.find((r) => r.title === 'Smart lock upgrade')!;

    expect(optionalMarkerFor(row)).toBe(OPTIONAL_DECLINED_MARKER);
  });

  it('never prints "Declined" for a taken optional row, locked or not', () => {
    const locked = buildEstimateDocumentModel(
      input({ locked: true, lineItems: [COUNTED_LINE, { ...OPTIONAL_LINE, is_selected: true }] }),
    );
    const row = locked.rows.find((r) => r.title === 'Smart lock upgrade')!;

    expect(optionalMarkerFor(row)).toBe(OPTIONAL_INCLUDED_MARKER);
  });

  it('leaves a row that was never optional unmarked, locked or not', () => {
    const locked = buildEstimateDocumentModel(input({ locked: true }));
    const row = locked.rows.find((r) => r.title === 'Keypad')!;

    expect(optionalMarkerFor(row)).toBeNull();
  });
});
