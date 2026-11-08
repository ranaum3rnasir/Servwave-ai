/**
 * #2028 × #2053 — what the customer-facing WEB page shows for an optional add-on they have not
 * selected. MIRRORS backend/src/lib/pdf/__tests__/optional-unselected-row.test.ts: the page and
 * the two PDF templates are one document, and a customer who opens the link must read exactly
 * what a customer who opens the attachment reads.
 *
 * Ran's call (2026-09-13): LIST it, SHOW its amount, MARK it optional, keep it out of the totals.
 * A blank amount cell reads as "included at no charge", the opposite of what it means.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import { OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER, OPTIONAL_TOTALS_NOTE } from '@/lib/estimate-document-view';

const COUNTED_LINE = { id: 'li-1', description: 'Keypad', quantity: 1, unit_price: 200, is_taxable: true, line_total: 200, item_type: 'MATERIAL', discount_amount: 0 };
const OPTIONAL_LINE = { ...COUNTED_LINE, id: 'li-opt', description: 'Smart lock upgrade', unit_price: 500, line_total: 500, is_optional: true, is_selected: false };
const COUNTED_SCOPE = { id: 'scope-1', title: 'Install 3 storefront doors', body: null, flat_price: 1000 };
const OPTIONAL_SCOPE = { id: 'scope-opt', title: 'Repaint the frames', body: null, flat_price: 800, is_optional: true, is_selected: false };

/** Subtotal $1,200 (the $200 keypad + the $1,000 scope), tax $120, Total $1,320. */
const BASE = {
  estimateNumber: 'E00042',
  customerName: 'Jane Doe',
  lineItems: [COUNTED_LINE],
  scopes: [COUNTED_SCOPE],
  subtotal: 1200,
  taxRate: 0.1,
  taxAmount: 120,
  totalAmount: 1320,
};

/** The same document, plus an optional line item and an optional scope block, neither selected. */
const WITH_OPTIONAL = { ...BASE, lineItems: [COUNTED_LINE, OPTIONAL_LINE], scopes: [COUNTED_SCOPE, OPTIONAL_SCOPE] };

/**
 * #2090 - the MIXED document: the $500 line add-on TAKEN, the $800 scope add-on not. Subtotal
 * $1,700, tax $170, Total $1,870, all three moved by the $500 that is now in the price.
 */
const ONE_TAKEN = {
  ...WITH_OPTIONAL,
  lineItems: [COUNTED_LINE, { ...OPTIONAL_LINE, is_selected: true }],
  subtotal: 1700,
  taxAmount: 170,
  totalAmount: 1870,
};

/** And the same document with BOTH taken: Subtotal $2,500, tax $250, Total $2,750. */
const BOTH_TAKEN = {
  ...ONE_TAKEN,
  scopes: [COUNTED_SCOPE, { ...OPTIONAL_SCOPE, is_selected: true }],
  subtotal: 2500,
  taxAmount: 250,
  totalAmount: 2750,
};

/**
 * The row card listing `title`. The title `<p>` sits in the card's content column, so the column's
 * parent is the card itself — image column, content column, amount column.
 */
function rowCard(title: string): HTMLElement {
  return screen.getByText(title).closest('div')!.parentElement as HTMLElement;
}

/**
 * The text of a row's AMOUNT column — its last child. Named structurally rather than searched for
 * by figure, because the unit price beside it prints the very same string on an add-on of
 * quantity 1 and would answer a document-wide query just as happily.
 */
function amountColumn(title: string): string {
  return rowCard(title).lastElementChild!.textContent ?? '';
}

/**
 * Every totals ROW as the customer reads it — label and figure, in order. The note this feature
 * adds is a `<p>` in the same column, so the rows are taken as the column's `<div>` children:
 * a sentence about the arithmetic is not a line of it, and this comparison is about the lines.
 */
function totalsRows(): string[] {
  const column = screen.getByText('Subtotal').parentElement!.parentElement!;
  return Array.from(column.children)
    .filter((el) => el.tagName === 'DIV')
    .map((el) => el.textContent ?? '');
}

describe('the estimate page — an optional add-on the customer has not selected', () => {
  it('still lists the add-on, and prints what it would cost in its own amount column', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    expect(screen.getByText('Smart lock upgrade')).toBeInTheDocument();
    expect(amountColumn('Smart lock upgrade')).toBe('$500.00');
  });

  it('prints what the optional scope block would cost, in its own amount column', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    expect(amountColumn('Repaint the frames')).toBe('$800.00');
  });

  it('marks both optional rows, so their figures cannot be read as part of the price', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    expect(within(rowCard('Smart lock upgrade')).getByText(OPTIONAL_ROW_MARKER)).toBeInTheDocument();
    expect(within(rowCard('Repaint the frames')).getByText(OPTIONAL_ROW_MARKER)).toBeInTheDocument();
  });

  it('marks nothing on a row that was never optional', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    for (const title of ['Keypad', 'Install 3 storefront doors']) {
      expect(within(rowCard(title)).queryByText(OPTIONAL_ROW_MARKER)).toBeNull();
      expect(within(rowCard(title)).queryByText(OPTIONAL_INCLUDED_MARKER)).toBeNull();
    }
  });

  it('says once, beneath the totals, that what is marked not included is outside the Total', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    expect(screen.getAllByText(OPTIONAL_TOTALS_NOTE)).toHaveLength(1);
  });

  it('says nothing of the sort on a document that offers nothing optional', () => {
    render(<EstimateDocumentView {...BASE} />);

    expect(screen.queryByText(OPTIONAL_TOTALS_NOTE)).toBeNull();
  });

  /**
   * THE property this whole piece of work turns on: offering the customer two optional add-ons
   * worth $1,300 moves nothing in the block that tells them what to pay — against the very same
   * estimate without them.
   */
  it('moves not one figure in the totals by adding the two optional rows', () => {
    const { unmount } = render(<EstimateDocumentView {...BASE} />);
    const before = totalsRows();
    unmount();

    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    expect(totalsRows()).toEqual(before);
    expect(before).toEqual(['Subtotal$1,200.00', 'Tax (10%)$120.00', 'Total$1,320.00']);
  });

  it('keeps the optional figures out of the totals entirely', () => {
    render(<EstimateDocumentView {...WITH_OPTIONAL} />);

    const totals = totalsRows().join(' ');
    expect(totals).not.toContain('$500.00');
    expect(totals).not.toContain('$800.00');
  });
});

/**
 * #2090 - the MIXED state, which no fixture on any of the three surfaces reached before: one
 * add-on taken and one not. It is the state the note was FALSE in, and a rep produced it simply by
 * pre-selecting an option, long before slice 3 let the customer produce it themselves.
 */
describe('the estimate page - one add-on taken, one not', () => {
  it('puts the taken add-on inside the totals and leaves the untaken one out', () => {
    render(<EstimateDocumentView {...ONE_TAKEN} />);

    // $1,200 + the $500 the customer took. The $800 they did not is nowhere in the totals.
    expect(totalsRows()).toEqual(['Subtotal$1,700.00', 'Tax (10%)$170.00', 'Total$1,870.00']);
    expect(totalsRows().join(' ')).not.toContain('$800.00');
  });

  it('still says it, and the sentence is TRUE: one row is still marked not included', () => {
    render(<EstimateDocumentView {...ONE_TAKEN} />);

    expect(screen.getAllByText(OPTIONAL_TOTALS_NOTE)).toHaveLength(1);
    expect(within(rowCard('Repaint the frames')).getByText(OPTIONAL_ROW_MARKER)).toBeInTheDocument();
  });

  it('tags the taken add-on Optional, without the "not included" half', () => {
    render(<EstimateDocumentView {...ONE_TAKEN} />);

    const taken = within(rowCard('Smart lock upgrade'));
    expect(taken.getByText(OPTIONAL_INCLUDED_MARKER)).toBeInTheDocument();
    expect(taken.queryByText(OPTIONAL_ROW_MARKER)).toBeNull();
    // ...and it still prints its own figure, which is now part of what is being charged.
    expect(amountColumn('Smart lock upgrade')).toBe('$500.00');
  });
});

describe('the estimate page - every add-on taken', () => {
  it('drops the note rather than printing a sentence about nothing', () => {
    render(<EstimateDocumentView {...BOTH_TAKEN} />);

    expect(screen.queryByText(OPTIONAL_TOTALS_NOTE)).toBeNull();
    expect(screen.queryByText(OPTIONAL_ROW_MARKER)).toBeNull();
  });

  it('keeps both add-ons tagged Optional, so the customer sees which were their choice', () => {
    render(<EstimateDocumentView {...BOTH_TAKEN} />);

    expect(within(rowCard('Smart lock upgrade')).getByText(OPTIONAL_INCLUDED_MARKER)).toBeInTheDocument();
    expect(within(rowCard('Repaint the frames')).getByText(OPTIONAL_INCLUDED_MARKER)).toBeInTheDocument();
  });

  it('carries both add-ons inside the totals', () => {
    render(<EstimateDocumentView {...BOTH_TAKEN} />);

    expect(totalsRows()).toEqual(['Subtotal$2,500.00', 'Tax (10%)$250.00', 'Total$2,750.00']);
  });
});
