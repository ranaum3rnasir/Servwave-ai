/**
 * The optional leading control column on the shared estimate document (2026-09-18 revision).
 *
 * The customer's page now carries ONE list with a checkbox on each optional row, instead of a
 * second "add-ons" card below the document. `EstimateDocumentView` grows one render slot,
 * `rowControl`, and its only two other callers - `EstimateVersionPage` and `ViewWorkOrderDialog` -
 * pass nothing.
 *
 * THE GATE IS THE SLOT, NOT THE ROW. A page that passes a `rowControl` reserves the column on
 * EVERY row, optional or not, so a title never shifts sideways depending on whether its own row
 * happens to carry a control. A caller that passes nothing gets no column and no spacer at all,
 * which is what makes the byte-for-byte promise in
 * `estimate-document-view-parity.test.tsx` literally true rather than approximately true.
 */
import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import type { DocumentRow } from '@/lib/estimate-document-view';
import { sectionRowLists } from '@/__tests__/estimate-document-dom';

const COUNTED_LINE = {
  id: 'li-1',
  description: 'Keypad',
  quantity: 1,
  unit_price: 200,
  is_taxable: true,
  line_total: 200,
  item_type: 'MATERIAL',
  discount_amount: 0,
};
const OPTIONAL_LINE = {
  ...COUNTED_LINE,
  id: 'li-opt',
  description: 'Smart lock upgrade',
  unit_price: 500,
  line_total: 500,
  is_optional: true,
  is_selected: false,
};
const COUNTED_SCOPE = { id: 'scope-1', title: 'Install 3 storefront doors', body: null, flat_price: 1000 };

const BASE = {
  estimateNumber: 'E00042',
  customerName: 'Jane Doe',
  lineItems: [COUNTED_LINE, OPTIONAL_LINE],
  scopes: [COUNTED_SCOPE],
  subtotal: 1200,
  taxRate: 0,
  taxAmount: 0,
  totalAmount: 1200,
};

/** Every row card drawn, across every section, in document order. */
function rowCards(root: ParentNode): Element[] {
  return sectionRowLists(root).flatMap((list) => Array.from(list.children));
}

/** The card listing this title. */
function rowCardFor(root: ParentNode, title: string): Element {
  const hit = rowCards(root).find((card) => within(card as HTMLElement).queryByText(title));
  if (!hit) throw new Error(`no row card for ${title}`);
  return hit;
}

describe('a caller that passes no rowControl', () => {
  it('draws no leading column and no spacer on any row', () => {
    const { container } = render(<EstimateDocumentView {...BASE} />);

    const cards = rowCards(container);
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      // Image/type-tag column, content column, amount column. Nothing before the first.
      expect(card.children).toHaveLength(3);
      expect(card.firstElementChild!.textContent).toMatch(/^(Material|Service|Scope)$/);
    }
  });
});

describe('a caller that passes a rowControl', () => {
  /** A checkbox for optional rows, nothing for the rest - what the public page passes. */
  const optionalOnly = (row: DocumentRow) =>
    row.optional ? <input type="checkbox" aria-label={`Include ${row.title}`} readOnly checked={false} /> : null;

  it('draws the control in a leading column, before the image column', () => {
    const { container } = render(<EstimateDocumentView {...BASE} rowControl={optionalOnly} />);

    const card = rowCardFor(container, 'Smart lock upgrade');
    expect(card.children).toHaveLength(4);
    const leading = card.firstElementChild as HTMLElement;
    expect(within(leading).getByRole('checkbox', { name: 'Include Smart lock upgrade' })).toBeInTheDocument();
    // The image/type-tag column is still there, just second now.
    expect(card.children[1].textContent).toMatch(/^(Material|Service|Scope)$/);
  });

  it('reserves the SAME column on rows that have no control, so no title shifts', () => {
    const { container } = render(<EstimateDocumentView {...BASE} rowControl={optionalOnly} />);

    for (const title of ['Keypad', 'Install 3 storefront doors']) {
      const card = rowCardFor(container, title);
      expect(card.children).toHaveLength(4);
      const leading = card.firstElementChild as HTMLElement;
      // A spacer: same width as the control, empty, and hidden from a screen reader so it is
      // not announced as a control the customer does not have. The VALUE is asserted, not just
      // the attribute: `aria-hidden="false"` exposes an empty 16px box on every row of a
      // customer-facing page and would satisfy a bare presence check.
      expect(leading.textContent).toBe('');
      expect(leading).toHaveAttribute('aria-hidden', 'true');
      expect(within(leading).queryByRole('checkbox')).toBeNull();
    }
  });

  it('reserves the column even when the callback returns nothing for every row', () => {
    const { container } = render(<EstimateDocumentView {...BASE} rowControl={() => null} />);

    for (const card of rowCards(container)) {
      expect(card.children).toHaveLength(4);
      expect(card.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
