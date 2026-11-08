/**
 * #2028 slice 3 — the public estimate page renders only the sections that have content, as two
 * distinct sections. Ran's rule: "if there are no line items and only scope of work, we don't
 * need to show the line items; if we see both, they should be in two separate sections."
 *
 * These assert the SECTIONS, not the pixels: a heading exists or it does not, and each row sits
 * under the heading that owns it. The parity snapshots next door hold the rest of the layout.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import { printedRowAmounts, printedTotal, sectionHeadings, sectionRowLists, sumAmounts } from './estimate-document-dom';

const LINE = {
  id: 'li-1',
  description: 'Keypad',
  quantity: 1,
  unit_price: 200,
  is_taxable: true,
  line_total: 200,
  item_type: 'MATERIAL',
  discount_amount: 0,
};

const SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
};

/** Stored PRE-discount, as calculateTotals persists it: the net 90 is what the subtotal holds. */
const DISCOUNTED_LINE = {
  id: 'li-2',
  description: 'Install labour',
  quantity: 1,
  unit_price: 100,
  is_taxable: true,
  line_total: 100,
  item_type: 'SERVICE',
  discount_type: 'PERCENTAGE',
  discount_value: 10,
  discount_amount: 10,
};

/** A described-but-not-separately-priced block. Prints a BLANK amount and adds nothing. */
const UNPRICED_SCOPE = {
  id: 'scope-2',
  title: 'Haul away and dispose of the old units',
  body: null,
  flat_price: null,
};

const BASE = { estimateNumber: 'E00042', customerName: 'Jane Doe', taxRate: 0, taxAmount: 0 };

describe('the public estimate page sections', () => {
  // Ran, 2026-09-13, after reviewing the rendered PDFs: a lone section is drawn with NO heading
  // over it. A heading tells the reader which of two sections they are looking at; over the whole
  // page it says nothing. Symmetric — neither heading survives on its own. Asserting `toEqual([])`
  // on the headings rather than "no heading NAMED x" is deliberate: an `h3` left in place with
  // nothing in it still puts an empty heading and its margin on the customer's page, and a
  // by-name query cannot see it.
  it('renders the scope content under no heading at all when the estimate is scope of work only', () => {
    render(<EstimateDocumentView {...BASE} lineItems={[]} scopes={[SCOPE]} subtotal={2000} totalAmount={2000} />);

    expect(sectionHeadings()).toEqual([]);
    expect(screen.getByText('Install 3 commercial storefront doors')).toBeTruthy();
    expect(screen.queryByText('Keypad')).toBeNull();
  });

  it('renders the line items under no heading at all when the estimate is line items only', () => {
    render(<EstimateDocumentView {...BASE} lineItems={[LINE]} scopes={[]} subtotal={200} totalAmount={200} />);

    expect(sectionHeadings()).toEqual([]);
    expect(screen.getByText('Keypad')).toBeTruthy();
  });

  it('renders two sections, scope of work first, when the estimate has both', () => {
    const { container } = render(
      <EstimateDocumentView {...BASE} lineItems={[LINE]} scopes={[SCOPE]} subtotal={2200} totalAmount={2200} />,
    );

    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings).toEqual(['Scope of Work', 'Line Items']);
    // Each row sits under the heading that owns it, in its own card — two sections, not one list.
    const cards = Array.from(container.querySelectorAll('h3')).map((h) => h.parentElement!.textContent!);
    expect(cards[0]).toContain('Install 3 commercial storefront doors');
    expect(cards[0]).not.toContain('Keypad');
    expect(cards[1]).toContain('Keypad');
    expect(cards[1]).not.toContain('Install 3 commercial storefront doors');
  });

  it('prints the scope narrative inside the scope section rather than under a second identical heading', () => {
    const { container } = render(
      <EstimateDocumentView
        {...BASE}
        scopeNotes="Work is performed during business hours."
        lineItems={[LINE]}
        scopes={[SCOPE]}
        subtotal={2200}
        totalAmount={2200}
      />,
    );

    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings.filter((h) => h === 'Scope of Work')).toHaveLength(1);
    expect(container.querySelector('h3')!.parentElement!.textContent).toContain('Work is performed during business hours.');
  });

  it('prints the totals in all three states, reconciling with whatever sections are above them', () => {
    // Each state's subtotal is the literal sum of the amounts printed above it, so the customer
    // can add up the page. Asserting only that the WORDS "Subtotal" and "Total" appear would pass
    // against a renderer that printed the right sections with the wrong figures — the arithmetic
    // is the whole claim. The expected sums are DERIVED from the rendered rows, never restated.
    const states: Array<[string, Record<string, unknown>, Array<number | null>]> = [
      // The unpriced block rides along in every state that has a scope section: its amount cell
      // is blank, which must not become a zero and must not be missed out of the row list.
      ['scope only', { lineItems: [], scopes: [SCOPE, UNPRICED_SCOPE], subtotal: 2000, totalAmount: 2000 }, [2000, null]],
      ['line items only', { lineItems: [LINE, DISCOUNTED_LINE], scopes: [], subtotal: 290, totalAmount: 290 }, [200, 90]],
      [
        'both',
        { lineItems: [LINE, DISCOUNTED_LINE], scopes: [SCOPE, UNPRICED_SCOPE], subtotal: 2290, totalAmount: 2290 },
        [2000, null, 200, 90],
      ],
    ];

    for (const [state, props, expectedRows] of states) {
      const { unmount } = render(<EstimateDocumentView {...BASE} {...props} />);

      const rows = printedRowAmounts();
      // Every row the state should have drawn, in document order, with the discounted line
      // contributing its NET and the unpriced block contributing no figure at all.
      expect(rows, state).toEqual(expectedRows);
      expect(printedTotal('Subtotal'), state).toBe(sumAmounts(rows));
      // Total is still drawn in every state, including the ones where the line-item card that
      // used to host it was never rendered at all.
      expect(printedTotal('Total'), state).toBe(sumAmounts(rows) + Number(props.taxAmount ?? 0));

      unmount();
    }
  });

  it('prints a blank amount, never a zero, for a scope block that is not separately priced', () => {
    render(
      <EstimateDocumentView {...BASE} lineItems={[]} scopes={[SCOPE, UNPRICED_SCOPE]} subtotal={2000} totalAmount={2000} />,
    );

    // A $0.00 would tell the customer the haul-away is free; a blank says it is not separately
    // priced. The subtotal is the same either way, which is exactly why the figure needs pinning.
    // Scoped to the section's row list — this document is scope-only, so it carries no heading to
    // find the card by — because the totals card legitimately prints $0.00 for a zero tax.
    const scopeRows = sectionRowLists()[0];
    expect(scopeRows.textContent).toContain('Haul away and dispose of the old units');
    expect(scopeRows.textContent).not.toContain('$0.00');
    expect(printedRowAmounts()).toEqual([2000, null]);
  });
});
