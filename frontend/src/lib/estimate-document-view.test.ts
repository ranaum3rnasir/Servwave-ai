/**
 * #2028 slice 2 — the frontend half of the document view-model.
 *
 * These cases deliberately MIRROR backend/src/lib/__tests__/estimate-document-view.test.ts, case
 * for case and name for name: the two modules are a documented manual mirror, and matching test
 * names are what makes a divergence visible in a diff rather than in a customer's inbox.
 */
import { describe, it, expect } from 'vitest';
import { OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER, OPTIONAL_TOTALS_NOTE, buildEstimateDocumentModel, documentSections, hasOptionalExtras, isOptionalExtra, optionalMarkerFor } from './estimate-document-view';

const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
};

function input(over: Record<string, unknown> = {}) {
  return {
    scopeNotes: null,
    lineItems: [
      { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
    ],
    scopes: [PRICED_SCOPE],
    subtotal: 2200,
    taxAmount: 0,
    totalAmount: 2200,
    discountName: null,
    discountAmount: 0,
    ...over,
  };
}

describe('the estimate document view-model', () => {
  it('prints every amount its subtotal contains — line items and priced scopes alike', () => {
    const view = buildEstimateDocumentModel(input());

    expect(view.rows.reduce((sum, r) => sum + (r.netAmount ?? 0), 0)).toBe(2200);
  });

  it('reports which sections have content, so no surface draws an empty header', () => {
    expect(buildEstimateDocumentModel(input())).toMatchObject({ hasLineItems: true, hasScopes: true });
    expect(buildEstimateDocumentModel(input({ lineItems: [] }))).toMatchObject({ hasLineItems: false, hasScopes: true });
    expect(buildEstimateDocumentModel(input({ scopes: [] }))).toMatchObject({ hasLineItems: true, hasScopes: false });
  });

  it('reads a scopes column that has never been written as an empty list, not null', () => {
    const view = buildEstimateDocumentModel(input({ scopes: undefined }));

    expect(view.rows.every((r) => r.kind === 'line_item')).toBe(true);
  });

  it('gives an unpriced scope block no amount at all — not a zero', () => {
    const view = buildEstimateDocumentModel(
      input({ scopes: [{ ...PRICED_SCOPE, flat_price: null }], subtotal: 200, totalAmount: 200 }),
    );

    expect(view.rows.find((r) => r.kind === 'scope')!.netAmount).toBeNull();
    expect(view.rows.reduce((sum, r) => sum + (r.netAmount ?? 0), 0)).toBe(200);
  });

  it('splits a line-item description into its bold first line and the rest', () => {
    const view = buildEstimateDocumentModel(
      input({ lineItems: [{ ...input().lineItems[0]!, description: 'Keypad\nSatin nickel\nKeyed alike' }] }),
    );

    expect(view.rows[0]).toMatchObject({ title: 'Keypad', detail: 'Satin nickel\nKeyed alike' });
  });

  it('carries no detail line when the description is a single line', () => {
    expect(buildEstimateDocumentModel(input()).rows[0]!.detail).toBeNull();
  });

  it('shows a discounted line as its gross struck through beside the net it contributes', () => {
    const view = buildEstimateDocumentModel(
      input({ lineItems: [{ ...input().lineItems[0]!, discount_amount: 50 }], subtotal: 2150, totalAmount: 2150 }),
    );

    expect(view.rows[0]).toMatchObject({ discounted: true, grossAmount: 200, netAmount: 150 });
  });

  it('strikes nothing through on an undiscounted line', () => {
    expect(buildEstimateDocumentModel(input()).rows[0]).toMatchObject({
      discounted: false,
      grossAmount: null,
      netAmount: 200,
    });
  });

  it('summarises the totals as subtotal, tax and total when there is no discount', () => {
    expect(buildEstimateDocumentModel(input()).totals.map((t) => t.kind)).toEqual(['subtotal', 'tax', 'total']);
  });

  it('puts a document-level discount between the subtotal and the tax, as a subtraction', () => {
    const view = buildEstimateDocumentModel(
      input({ discountName: 'Repeat customer', discountAmount: 150, totalAmount: 2050 }),
    );

    expect(view.totals.map((t) => t.kind)).toEqual(['subtotal', 'discount', 'tax', 'total']);
    expect(view.totals[1]).toMatchObject({ label: 'Repeat customer', amount: 150, negative: true });
  });

  it('names an unnamed document-level discount "Discount"', () => {
    const view = buildEstimateDocumentModel(input({ discountName: null, discountAmount: 150 }));

    expect(view.totals.find((t) => t.kind === 'discount')?.label).toBe('Discount');
  });

  it('summarises line-level discounts as their own row', () => {
    const view = buildEstimateDocumentModel(
      input({
        lineItems: [
          { ...input().lineItems[0]!, discount_amount: 50 },
          { id: 'li-2', description: 'Strike', item_type: 'MATERIAL', quantity: 1, unit_price: 100, line_total: 100, discount_amount: 25 },
        ],
      }),
    );

    expect(view.totals.find((t) => t.kind === 'line_discounts')).toMatchObject({ amount: 75, negative: true });
  });

  it('reports blank scope notes as absent, so no surface draws an empty header', () => {
    expect(buildEstimateDocumentModel(input({ scopeNotes: '   ' })).scopeNotes).toBeNull();
  });
});

/**
 * #2028 slice 3 — MIRRORS backend/src/lib/__tests__/estimate-document-view.test.ts case for case
 * and name for name. Which sections the document renders is one decision, so a divergence between
 * the two halves would put a different document in front of the customer depending on whether
 * they opened the PDF or the page.
 */
describe('which sections the document renders', () => {
  it('renders no line-item section when the estimate is scope of work only', () => {
    const view = buildEstimateDocumentModel(input({ lineItems: [], subtotal: 2000, totalAmount: 2000 }));

    expect(documentSections(view).map((s) => s.kind)).toEqual(['scope']);
  });

  it('renders no scope section when the estimate is line items only', () => {
    const view = buildEstimateDocumentModel(input({ scopes: [], subtotal: 200, totalAmount: 200 }));

    expect(documentSections(view).map((s) => s.kind)).toEqual(['line_items']);
  });

  /**
   * Ran's call after reviewing the rendered PDFs (2026-09-13): a heading earns its place only
   * when it tells the reader WHICH of two sections they are looking at. `title` is null when
   * there is no heading to print — symmetric, so a scope-only document loses "Scope of Work"
   * exactly as a line-items-only one loses "Line Items".
   */
  it('prints no heading over a lone section, and both headings when there are two', () => {
    const lineItemsOnly = documentSections(
      buildEstimateDocumentModel(input({ scopes: [], subtotal: 200, totalAmount: 200 })),
    );
    expect(lineItemsOnly.map((s) => s.kind)).toEqual(['line_items']);
    expect(lineItemsOnly.map((s) => s.title)).toEqual([null]);

    const scopeOnly = documentSections(
      buildEstimateDocumentModel(input({ lineItems: [], subtotal: 2000, totalAmount: 2000 })),
    );
    expect(scopeOnly.map((s) => s.title)).toEqual([null]);

    const both = documentSections(buildEstimateDocumentModel(input()));
    expect(both.map((s) => s.title)).toEqual(['Scope of Work', 'Line Items']);
  });

  it('renders two distinct sections, scope of work first, when the estimate has both', () => {
    const sections = documentSections(buildEstimateDocumentModel(input()));

    expect(sections.map((s) => s.kind)).toEqual(['scope', 'line_items']);
    expect(sections.map((s) => s.title)).toEqual(['Scope of Work', 'Line Items']);
    expect(sections[0]!.rows.map((r) => r.kind)).toEqual(['scope']);
    expect(sections[1]!.rows.map((r) => r.kind)).toEqual(['line_item']);
  });

  it('keeps the scope narrative in the scope section, so the document never prints two Scope of Work headings', () => {
    const sections = documentSections(
      buildEstimateDocumentModel(input({ scopeNotes: 'Work is performed during business hours.' })),
    );
    expect(sections.filter((s) => s.title === 'Scope of Work')).toHaveLength(1);
    expect(sections[0]!.notes).toBe('Work is performed during business hours.');

    const notesOnly = documentSections(
      buildEstimateDocumentModel(input({ scopes: [], scopeNotes: 'Business hours only.', subtotal: 200, totalAmount: 200 })),
    );
    expect(notesOnly.map((s) => s.kind)).toEqual(['scope', 'line_items']);
    expect(notesOnly[0]!.rows).toEqual([]);
  });

  it('reconciles the totals with what is printed above them in all three states', () => {
    const states: Array<Record<string, unknown>> = [
      { lineItems: [], subtotal: 2000, totalAmount: 2000 },
      { scopes: [], subtotal: 200, totalAmount: 200 },
      {},
    ];

    for (const over of states) {
      const view = buildEstimateDocumentModel(input(over));
      const printed = documentSections(view)
        .flatMap((s) => s.rows)
        .reduce((sum, r) => sum + (r.netAmount ?? 0), 0);

      expect(printed).toBe(view.totals.find((t) => t.kind === 'subtotal')!.amount);
    }
  });
});

/**
 * #2028 × #2053 — mirrors backend/src/lib/__tests__/estimate-document-view.test.ts's describe of
 * the same name, case for case. The server's `recomputeInvoiceTotals` leaves an optional item the
 * customer has not selected out of the persisted `subtotal`; this model reads that subtotal, so
 * without the same predicate the page and the PDF would disagree about the same estimate.
 *
 * Ran's call (2026-09-13) on HOW: the add-on is listed WITH its amount and marked optional, not
 * blanked. A blank amount reads as "included at no charge", the opposite of the truth. So the row
 * keeps its figure and `countsTowardTotals` — not the figure's absence — is what says the money
 * is outside the totals. Reconciliation means: the rows that COUNT sum to Subtotal.
 */
describe('the document reconciles with itself when an item is optional and unselected', () => {
  const OPTIONAL_UNSELECTED_LINE = {
    id: 'li-opt',
    description: 'Smart lock upgrade',
    item_type: 'MATERIAL',
    quantity: 1,
    unit_price: 500,
    line_total: 500,
    discount_amount: 0,
    is_optional: true,
    is_selected: false,
  };
  const OPTIONAL_UNSELECTED_SCOPE = {
    id: 'scope-opt',
    title: 'Repaint the frames',
    body: null,
    flat_price: 800,
    is_optional: true,
    is_selected: false,
  };

  function withOptionalAddOns(over: Record<string, unknown> = {}) {
    return input({
      subtotal: 2200,
      totalAmount: 2200,
      scopes: [PRICED_SCOPE, OPTIONAL_UNSELECTED_SCOPE],
      lineItems: [
        { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
        OPTIONAL_UNSELECTED_LINE,
      ],
      ...over,
    });
  }

  it('keeps an optional-unselected row priced, and out of the sum that makes Subtotal', () => {
    const model = buildEstimateDocumentModel(withOptionalAddOns() as never);

    // Both add-ons are LISTED, and each carries what it would cost — the offer, in full.
    expect(model.rows).toHaveLength(4);
    const optionalRows = model.rows.filter((r) => r.optional);
    expect(optionalRows.map((r) => r.title)).toEqual(['Smart lock upgrade', 'Repaint the frames']);
    expect(optionalRows.map((r) => r.netAmount)).toEqual([500, 800]);
    for (const row of optionalRows) expect(row.countsTowardTotals).toBe(false);

    // And the document still adds up: the rows that count are exactly the Subtotal, so the $1,300
    // of add-ons sits outside the arithmetic however it is printed.
    const counted = model.rows.filter((r) => r.countsTowardTotals).reduce((sum, r) => sum + (r.netAmount ?? 0), 0);
    expect(counted).toBe(model.totals.find((t) => t.kind === 'subtotal')!.amount);
    expect(counted).toBe(2200);
  });

  /**
   * The one thing a renderer has to ask to mark a row. Every surface reads this rather than the
   * flags, so all three mark the same rows and none re-implements `countsTowardTotals`.
   */
  it('names exactly the rows whose printed amount is outside the totals', () => {
    const model = buildEstimateDocumentModel(withOptionalAddOns() as never);

    expect(model.rows.filter(isOptionalExtra).map((r) => r.title)).toEqual(['Smart lock upgrade', 'Repaint the frames']);
    expect(hasOptionalExtras(model)).toBe(true);
    expect(hasOptionalExtras(buildEstimateDocumentModel(input()))).toBe(false);
  });

  /**
   * An optional row the customer HAS selected is being charged for, so its money is inside the
   * Subtotal and it is no longer an "extra". #2090: it does keep the Optional TAG (see
   * `optionalMarkerFor` in the mixed-state block below) - what it loses is the "(not included)"
   * half, which is what `isOptionalExtra` answers.
   */
  it('marks nothing on an optional row the customer did select', () => {
    const model = buildEstimateDocumentModel(
      withOptionalAddOns({
        subtotal: 2700,
        totalAmount: 2700,
        lineItems: [
          { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          { ...OPTIONAL_UNSELECTED_LINE, is_selected: true },
        ],
        scopes: [PRICED_SCOPE],
      }) as never,
    );

    const addOn = model.rows.find((r) => r.title === 'Smart lock upgrade')!;
    expect(addOn).toMatchObject({ optional: true, countsTowardTotals: true, netAmount: 500 });
    expect(isOptionalExtra(addOn)).toBe(false);
    expect(hasOptionalExtras(model)).toBe(false);
  });

  /**
   * A discounted add-on prices exactly like a discounted line the customer is buying: the gross
   * struck through beside the net. That net is what they would pay if they took it, which is the
   * only figure worth showing them.
   */
  it('prices a discounted add-on in full, gross and net alike', () => {
    const model = buildEstimateDocumentModel(
      withOptionalAddOns({
        lineItems: [
          { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          { ...OPTIONAL_UNSELECTED_LINE, quantity: 1, unit_price: 600, line_total: 600, discount_amount: 100, discount_type: 'PERCENTAGE', discount_value: 16.67 },
        ],
      }) as never,
    );

    expect(model.rows.find((r) => r.title === 'Smart lock upgrade')).toMatchObject({
      discounted: true,
      grossAmount: 600,
      netAmount: 500,
      countsTowardTotals: false,
    });
  });

  it('keeps an optional-unselected line out of the Line Discounts row too', () => {
    const model = buildEstimateDocumentModel(
      withOptionalAddOns({
        lineItems: [
          { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 250, line_total: 250, discount_amount: 50, discount_type: 'FIXED_AMOUNT', discount_value: 50 },
          { ...OPTIONAL_UNSELECTED_LINE, quantity: 1, unit_price: 600, line_total: 600, discount_amount: 100, discount_type: 'FIXED_AMOUNT', discount_value: 100 },
        ],
      }) as never,
    );

    expect(model.totals.find((t) => t.kind === 'line_discounts')?.amount).toBe(50);
  });

  it('treats a legacy row with neither flag set as counting, exactly as the totals do', () => {
    const model = buildEstimateDocumentModel(input() as never);
    for (const row of model.rows) {
      expect(row.optional).toBe(false);
      expect(row.countsTowardTotals).toBe(true);
      expect(row.netAmount).not.toBeNull();
    }
  });

  /**
   * #2090 - the MIXED state: one add-on taken, one not.
   *
   * Every optional fixture in this file and in both surface suites was `is_selected: false`, so the
   * state a rep produces by pre-selecting an option - and, since slice 3, the state a customer
   * produces by ticking one - was not weakly covered, it was entirely uncovered. That is the hole
   * that let "Optional items are not included in the Total" sit under a subtotal containing add-ons.
   */
  describe('#2090 the document reconciles when ONE add-on is taken and another is not', () => {
    const TAKEN_LINE = { ...OPTIONAL_UNSELECTED_LINE, is_selected: true };

    /** Subtotal = $200 keypad + $2,000 priced scope + the $500 add-on the customer took. */
    function mixed() {
      return withOptionalAddOns({
        subtotal: 2700,
        totalAmount: 2700,
        lineItems: [
          { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          TAKEN_LINE,
        ],
        // The optional SCOPE stays untaken, so the document holds one of each.
        scopes: [PRICED_SCOPE, OPTIONAL_UNSELECTED_SCOPE],
      });
    }

    it('counts the add-on that was taken and leaves out the one that was not', () => {
      const model = buildEstimateDocumentModel(mixed() as never );

      const taken = model.rows.find((r) => r.title === 'Smart lock upgrade')!;
      const untaken = model.rows.find((r) => r.title === 'Repaint the frames')!;
      expect(taken).toMatchObject({ optional: true, countsTowardTotals: true, netAmount: 500 });
      expect(untaken).toMatchObject({ optional: true, countsTowardTotals: false, netAmount: 800 });

      // The document still adds up: the counted rows ARE the Subtotal, add-on included.
      const counted = model.rows.filter((r) => r.countsTowardTotals).reduce((sum, r) => sum + (r.netAmount ?? 0), 0);
      expect(counted).toBe(model.totals.find((t) => t.kind === 'subtotal')!.amount);
      expect(counted).toBe(2700);
    });

    it('still has an untaken add-on to explain, so the note still belongs on the document', () => {
      expect(hasOptionalExtras(buildEstimateDocumentModel(mixed() as never ))).toBe(true);
    });

    it('tags both add-ons, and only the untaken one as not included', () => {
      const model = buildEstimateDocumentModel(mixed() as never );

      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Smart lock upgrade')!)).toBe(OPTIONAL_INCLUDED_MARKER);
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Repaint the frames')!)).toBe(OPTIONAL_ROW_MARKER);
      // A row that was never optional carries nothing at all, whatever the rest of the document does.
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Keypad')!)).toBeNull();
    });

    it('has nothing left to explain once EVERY add-on is taken, so the note drops away', () => {
      const model = buildEstimateDocumentModel(
        withOptionalAddOns({
          subtotal: 3500,
          totalAmount: 3500,
          lineItems: [
            { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
            TAKEN_LINE,
          ],
          scopes: [PRICED_SCOPE, { ...OPTIONAL_UNSELECTED_SCOPE, is_selected: true }],
        }) as never ,
      );

      expect(hasOptionalExtras(model)).toBe(false);
      // Both are still TAGGED - the customer keeps seeing which of these were their own choice.
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Smart lock upgrade')!)).toBe(OPTIONAL_INCLUDED_MARKER);
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Repaint the frames')!)).toBe(OPTIONAL_INCLUDED_MARKER);
    });
  });
});

/**
 * #2090 - the sentence itself, pinned. The mixed-state cases above prove the document behaves; this
 * proves the words stay true while it does.
 */
describe('#2090 the totals note is true in every state it can render in', () => {
  it('names the MARKER a reader can see on a row, never "optional" as a category', () => {
    expect(OPTIONAL_TOTALS_NOTE).toBe('Items marked not included are outside the Total.');
    // The old sentence claimed optional items as a CLASS were out of the Total, which a single
    // taken add-on falsifies. A category claim cannot be true in the mixed state, so there must
    // not be one.
    expect(OPTIONAL_TOTALS_NOTE).not.toMatch(/optional/i);
  });

  it('names no figure, because the arithmetic moves under it every time a box is ticked', () => {
    expect(OPTIONAL_TOTALS_NOTE).not.toMatch(/\d/);
  });

  it('and the tag on an add-on the customer took says it is in the price', () => {
    // Ran, 2026-09-18: "Let's just say included, not optional." The word the editor's own tag
    // uses for the same state, so the salesperson and the customer read one vocabulary.
    expect(OPTIONAL_INCLUDED_MARKER).toBe('Included');
    expect(OPTIONAL_ROW_MARKER).toBe('Optional (not included)');
  });
});
