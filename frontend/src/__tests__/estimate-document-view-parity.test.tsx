/**
 * #2028 slice 2 — the view-model extraction is a NO-OP on the web page too.
 *
 * `EstimateDocumentView` now renders `buildEstimateDocumentModel`'s rows and totals instead of
 * deciding for itself. These snapshots were verified against the component as it stood BEFORE the
 * extraction, across the shapes whose handling differs, and are the standing guard that a later
 * change to the shared model does not silently change what a customer sees.
 *
 * #2028 slice 3 RE-BASELINED every snapshot here, deliberately. The page now prints only the
 * sections that have content, as two distinct cards: a "Scope of Work" card (the narrative plus
 * the scope blocks) and a "Line Items" card, each drawn only when it has something, with the
 * totals moved into a card of their own so a scope-only estimate still prints them. Anything
 * beyond that — the row contents, the figures, the totals rows — is still expected to be
 * untouched, and a diff here that touches them is a regression, not a re-baseline.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';

const LINE = {
  id: 'li-1',
  description: 'Keypad\nSatin nickel',
  quantity: 1,
  unit_price: 200,
  is_taxable: true,
  line_total: 200,
  item_type: 'MATERIAL',
  discount_amount: 0,
};

const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
};

const BASE = {
  estimateNumber: 'E00042',
  customerName: 'Jane Doe',
  lineItems: [LINE],
  subtotal: 200,
  taxRate: 0,
  taxAmount: 0,
  totalAmount: 200,
};

const SHAPES: Array<[string, Record<string, unknown>]> = [
  ['line items only', {}],
  ['a priced scope block', { scopes: [PRICED_SCOPE], subtotal: 2200, totalAmount: 2200 }],
  ['an unpriced scope block', { scopes: [{ ...PRICED_SCOPE, flat_price: null }] }],
  ['a service line item', { lineItems: [{ ...LINE, item_type: 'SERVICE' }] }],
  ['a line item with a price-book image', { lineItems: [{ ...LINE, price_book_item: { image_url: 'https://example.test/x.jpg' } }] }],
  ['a single-line description', { lineItems: [{ ...LINE, description: 'Keypad' }] }],
  ['a line-level discount', { lineItems: [{ ...LINE, discount_amount: 50, discount_type: 'FIXED_AMOUNT', discount_value: 50 }], subtotal: 150, totalAmount: 150 }],
  ['a document-level discount', { discountName: 'Repeat customer', discountAmount: 50, totalAmount: 150 }],
  ['an unnamed document-level discount', { discountAmount: 50, totalAmount: 150 }],
  ['tax', { taxRate: 0.0875, taxAmount: 17.5, totalAmount: 217.5 }],
  ['scope notes', { scopeNotes: 'Work is performed during business hours.' }],
  ['no line items at all', { lineItems: [] }],
];

describe('the estimate document web page renders identically after the view-model extraction', () => {
  it.each(SHAPES)('for %s', (shape, over) => {
    const { container } = render(<EstimateDocumentView {...BASE} {...over} />);

    expect(container.innerHTML).toMatchSnapshot(shape);
  });
});
