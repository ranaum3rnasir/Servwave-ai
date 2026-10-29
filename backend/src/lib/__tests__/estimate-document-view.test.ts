/**
 * #2028 slice 2 — the estimate document view-model.
 *
 * Which sections exist, how a priced versus unpriced scope block is presented, how discounts are
 * summarised and what the totals rows are: four decisions that were made separately inside two
 * pdfmake templates and one React page, and disagreed. They are computed once here, into plain
 * data with no rendering technology in it, so they can be tested directly — no PDF, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER, OPTIONAL_TOTALS_NOTE, buildEstimateDocumentView, documentSections, hasOptionalExtras, isOptionalExtra, optionalMarkerFor } from '../estimate-document-view';
import { estimateDocumentSelect } from '../estimate-document';

const ORG = {
  estimate_terms: 'Live terms.',
  estimate_notes: 'Live notes.',
  estimate_payment_terms: 'Live payment terms.',
};

const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
};

function estimate(over: Record<string, unknown> = {}) {
  return {
    estimate_number: 'E00042',
    created_at: new Date('2026-09-01T00:00:00Z'),
    status: 'SENT',
    subtotal: 2200,
    discount_amount: 0,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 2200,
    signature_data: null,
    signature_at: null,
    snapshot_terms: null,
    snapshot_notes: null,
    snapshot_payment_terms: null,
    scope_notes: null,
    scopes: [PRICED_SCOPE],
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@x.com', phone: '5551234567' },
    service_location: null,
    lead: null,
    line_items: [
      { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
    ],
    ...over,
  };
}

describe('the estimate document view-model', () => {
  it('prints every amount its subtotal contains — line items and priced scopes alike', () => {
    const view = buildEstimateDocumentView(estimate() as never, ORG as never);

    const printed = view.rows.reduce((sum, row) => sum + (row.netAmount ?? 0), 0);
    expect(printed).toBe(2200);
  });

  it('reports which sections have content, so no surface draws an empty header', () => {
    const both = buildEstimateDocumentView(estimate() as never, ORG as never);
    expect(both.hasLineItems).toBe(true);
    expect(both.hasScopes).toBe(true);

    const scopeOnly = buildEstimateDocumentView(estimate({ line_items: [] }) as never, ORG as never);
    expect(scopeOnly.hasLineItems).toBe(false);
    expect(scopeOnly.hasScopes).toBe(true);

    const linesOnly = buildEstimateDocumentView(estimate({ scopes: null }) as never, ORG as never);
    expect(linesOnly.hasLineItems).toBe(true);
    expect(linesOnly.hasScopes).toBe(false);
  });

  it('reads a scopes column that has never been written as an empty list, not null', () => {
    const view = buildEstimateDocumentView(estimate({ scopes: null }) as never, ORG as never);

    expect(view.rows.every((r) => r.kind === 'line_item')).toBe(true);
  });

  it('gives an unpriced scope block no amount at all — not a zero', () => {
    const view = buildEstimateDocumentView(
      estimate({ scopes: [{ ...PRICED_SCOPE, flat_price: null }], subtotal: 200, total_amount: 200 }) as never,
      ORG as never,
    );

    const scope = view.rows.find((r) => r.kind === 'scope')!;
    // A zero would tell the customer the work is free; an absent amount says the price is not
    // broken out. It contributes nothing either way.
    expect(scope.netAmount).toBeNull();
    expect(view.rows.reduce((sum, r) => sum + (r.netAmount ?? 0), 0)).toBe(200);
  });

  it('splits a line-item description into its bold first line and the rest', () => {
    const view = buildEstimateDocumentView(
      estimate({ line_items: [{ ...estimate().line_items[0], description: 'Keypad\nSatin nickel\nKeyed alike' }] }) as never,
      ORG as never,
    );

    expect(view.rows[0]).toMatchObject({ title: 'Keypad', detail: 'Satin nickel\nKeyed alike' });
  });

  it('carries no detail line when the description is a single line', () => {
    expect(buildEstimateDocumentView(estimate() as never, ORG as never).rows[0].detail).toBeNull();
  });

  it('shows a discounted line as its gross struck through beside the net it contributes', () => {
    const view = buildEstimateDocumentView(
      estimate({
        line_items: [{ ...estimate().line_items[0], discount_amount: 50 }],
        subtotal: 2150,
        total_amount: 2150,
      }) as never,
      ORG as never,
    );

    expect(view.rows[0]).toMatchObject({ discounted: true, grossAmount: 200, netAmount: 150 });
  });

  it('strikes nothing through on an undiscounted line', () => {
    expect(buildEstimateDocumentView(estimate() as never, ORG as never).rows[0]).toMatchObject({
      discounted: false,
      grossAmount: null,
      netAmount: 200,
    });
  });

  it('summarises the totals as subtotal, tax and total when there is no discount', () => {
    const view = buildEstimateDocumentView(estimate() as never, ORG as never);

    expect(view.totals.map((t) => t.kind)).toEqual(['subtotal', 'tax', 'total']);
  });

  it('puts a document-level discount between the subtotal and the tax, as a subtraction', () => {
    const view = buildEstimateDocumentView(
      estimate({ discount_name: 'Repeat customer', discount_amount: 150, total_amount: 2050 }) as never,
      ORG as never,
    );

    expect(view.totals.map((t) => t.kind)).toEqual(['subtotal', 'discount', 'tax', 'total']);
    expect(view.totals[1]).toMatchObject({ label: 'Repeat customer', amount: 150, negative: true });
  });

  it('names an unnamed document-level discount "Discount"', () => {
    const view = buildEstimateDocumentView(
      estimate({ discount_name: null, discount_amount: 150, total_amount: 2050 }) as never,
      ORG as never,
    );

    expect(view.totals.find((t) => t.kind === 'discount')?.label).toBe('Discount');
  });

  it('summarises line-level discounts as their own row', () => {
    const view = buildEstimateDocumentView(
      estimate({
        line_items: [
          { ...estimate().line_items[0], discount_amount: 50 },
          { description: 'Strike', item_type: 'MATERIAL', quantity: 1, unit_price: 100, line_total: 100, discount_amount: 25 },
        ],
      }) as never,
      ORG as never,
    );

    expect(view.totals.find((t) => t.kind === 'line_discounts')).toMatchObject({ amount: 75, negative: true });
  });
});

describe('the copy the document prints', () => {
  it("uses the org's live terms on a draft, which has no snapshot yet", () => {
    const view = buildEstimateDocumentView(
      estimate({ status: 'DRAFT', snapshot_terms: 'Stale snapshot.' }) as never,
      ORG as never,
    );

    expect(view.terms).toBe('Live terms.');
  });

  it('uses the send-time snapshot once the estimate has left draft', () => {
    const view = buildEstimateDocumentView(
      estimate({ status: 'SENT', snapshot_terms: 'Terms as sent.' }) as never,
      ORG as never,
    );

    expect(view.terms).toBe('Terms as sent.');
  });

  it("falls back to the org's live copy for a sent row that predates snapshotting", () => {
    expect(buildEstimateDocumentView(estimate({ status: 'SENT' }) as never, ORG as never).terms)
      .toBe('Live terms.');
  });

  it('reports blank scope notes as absent, so no surface draws an empty header', () => {
    expect(buildEstimateDocumentView(estimate({ scope_notes: '   ' }) as never, ORG as never).scopeNotes)
      .toBeNull();
  });
});

/**
 * #2028 slice 3 — the document renders only the sections that have content, as two distinct
 * sections. Ran's rule: "if there are no line items and only scope of work, we don't need to show
 * the line items; if we see both, they should be in two separate sections."
 *
 * The decision is made ONCE here, so the two PDF templates and the public page inherit the same
 * three states instead of each gating for itself. It is a pure function of a built model rather
 * than a field on it, so a FROZEN model (#2030) — persisted before this slice existed and never
 * migrated — sections exactly like a freshly-built one.
 */
describe('which sections the document renders', () => {
  it('renders no line-item section when the estimate is scope of work only', () => {
    const view = buildEstimateDocumentView(
      estimate({ line_items: [], subtotal: 2000, total_amount: 2000 }) as never,
      ORG as never,
    );

    expect(documentSections(view).map((s) => s.kind)).toEqual(['scope']);
  });
  it('renders no scope section when the estimate is line items only', () => {
    const view = buildEstimateDocumentView(
      estimate({ scopes: null, subtotal: 200, total_amount: 200 }) as never,
      ORG as never,
    );

    expect(documentSections(view).map((s) => s.kind)).toEqual(['line_items']);
  });

  /**
   * Ran's call after reviewing the rendered PDFs (2026-09-13): a heading earns its place only
   * when it tells the reader WHICH of two sections they are looking at. Over a lone section it
   * restates the document, so a single-section document prints its content bare. Symmetric on
   * purpose — a scope-only document loses "Scope of Work" exactly as a line-items-only one loses
   * "Line Items". `title` is null when there is no heading to print.
   */
  it('prints no heading over a lone section, and both headings when there are two', () => {
    const lineItemsOnly = documentSections(
      buildEstimateDocumentView(estimate({ scopes: null, subtotal: 200, total_amount: 200 }) as never, ORG as never),
    );
    expect(lineItemsOnly.map((s) => s.kind)).toEqual(['line_items']);
    expect(lineItemsOnly.map((s) => s.title)).toEqual([null]);

    const scopeOnly = documentSections(
      buildEstimateDocumentView(estimate({ line_items: [], subtotal: 2000, total_amount: 2000 }) as never, ORG as never),
    );
    expect(scopeOnly.map((s) => s.title)).toEqual([null]);

    const both = documentSections(buildEstimateDocumentView(estimate() as never, ORG as never));
    expect(both.map((s) => s.title)).toEqual(['Scope of Work', 'Line Items']);
  });

  it('renders two distinct sections, scope of work first, when the estimate has both', () => {
    const view = buildEstimateDocumentView(estimate() as never, ORG as never);

    const sections = documentSections(view);
    expect(sections.map((s) => s.kind)).toEqual(['scope', 'line_items']);
    expect(sections.map((s) => s.title)).toEqual(['Scope of Work', 'Line Items']);
    // Each section holds ONLY its own rows — that is what makes them two sections rather than
    // one list with a heading dropped into the middle of it.
    expect(sections[0].rows.map((r) => r.kind)).toEqual(['scope']);
    expect(sections[1].rows.map((r) => r.kind)).toEqual(['line_item']);
  });

  it('keeps the scope narrative in the scope section, so the document never prints two Scope of Work headings', () => {
    const view = buildEstimateDocumentView(
      estimate({ scope_notes: 'Work is performed during business hours.' }) as never,
      ORG as never,
    );

    const sections = documentSections(view);
    expect(sections.filter((s) => s.title === 'Scope of Work')).toHaveLength(1);
    expect(sections[0].notes).toBe('Work is performed during business hours.');
    // The narrative is scope of work too: it alone earns the section, with no blocks under it.
    const notesOnly = documentSections(
      buildEstimateDocumentView(
        estimate({ scopes: null, scope_notes: 'Business hours only.', subtotal: 200, total_amount: 200 }) as never,
        ORG as never,
      ),
    );
    expect(notesOnly.map((s) => s.kind)).toEqual(['scope', 'line_items']);
    expect(notesOnly[0].rows).toEqual([]);
  });

  it('reconciles the totals with what is printed above them in all three states', () => {
    const states: Array<[string, Record<string, unknown>]> = [
      ['scope only', { line_items: [], subtotal: 2000, total_amount: 2000 }],
      ['line items only', { scopes: null, subtotal: 200, total_amount: 200 }],
      ['both', {}],
    ];

    for (const [, over] of states) {
      const view = buildEstimateDocumentView(estimate(over) as never, ORG as never);
      const printed = documentSections(view)
        .flatMap((s) => s.rows)
        .reduce((sum, r) => sum + (r.netAmount ?? 0), 0);

      expect(printed).toBe(view.totals.find((t) => t.kind === 'subtotal')!.amount);
    }
  });
});

/**
 * #2028 × #2053 — the document's rows must reconcile with the document's own totals.
 *
 * `calculateTotals` delegates to `recomputeInvoiceTotals`, which EXCLUDES an optional line or
 * scope the customer has not selected (`countsTowardTotals`) from the persisted `subtotal`. The
 * view-model reads that persisted subtotal but builds its rows from every line item and every
 * scope, so the two have to be reconciled here or the printed list and the printed Subtotal
 * disagree, which is the exact defect #2028 exists to remove.
 *
 * Ran's call (2026-09-13) on HOW: the add-on is listed WITH its amount and marked optional, not
 * blanked. A blank amount reads as "included at no charge", the opposite of the truth, and the
 * customer is entitled to know what they were offered and what it would cost. So the row keeps
 * its figure and `countsTowardTotals` — not the figure's absence — is what says the money is
 * outside the totals. Reconciliation therefore means: the rows that COUNT sum to Subtotal.
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
    is_taxable: true,
    is_optional: true,
    is_selected: false,
  };

  /** subtotal = the $200 keypad + the $2000 priced scope. Neither optional add-on counts. */
  function withOptionalAddOns(over: Record<string, unknown> = {}) {
    return estimate({
      subtotal: 2200,
      total_amount: 2200,
      scopes: [PRICED_SCOPE, OPTIONAL_UNSELECTED_SCOPE],
      line_items: [
        { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
        OPTIONAL_UNSELECTED_LINE,
      ],
      ...over,
    });
  }

  it('keeps an optional-unselected row priced, and out of the sum that makes Subtotal', () => {
    const view = buildEstimateDocumentView(withOptionalAddOns() as never, ORG as never);

    // Both add-ons are LISTED, and each carries what it would cost — the offer, in full.
    expect(view.rows).toHaveLength(4);
    const optionalRows = view.rows.filter((r) => r.optional);
    expect(optionalRows.map((r) => r.title)).toEqual(['Smart lock upgrade', 'Repaint the frames']);
    expect(optionalRows.map((r) => r.netAmount)).toEqual([500, 800]);
    for (const row of optionalRows) expect(row.countsTowardTotals).toBe(false);

    // And the document still adds up: the rows that count are exactly the Subtotal, so the $1,300
    // of add-ons sits outside the arithmetic however it is printed.
    const counted = view.rows.filter((r) => r.countsTowardTotals).reduce((sum, r) => sum + (r.netAmount ?? 0), 0);
    expect(counted).toBe(view.totals.find((t) => t.kind === 'subtotal')!.amount);
    expect(counted).toBe(2200);
  });

  /**
   * The one thing a renderer has to ask to mark a row. Every surface reads this rather than the
   * flags, so all three mark the same rows and none re-implements `countsTowardTotals`.
   */
  it('names exactly the rows whose printed amount is outside the totals', () => {
    const view = buildEstimateDocumentView(withOptionalAddOns() as never, ORG as never);

    expect(view.rows.filter(isOptionalExtra).map((r) => r.title)).toEqual(['Smart lock upgrade', 'Repaint the frames']);
    expect(hasOptionalExtras(view)).toBe(true);
    expect(hasOptionalExtras(buildEstimateDocumentView(estimate() as never, ORG as never))).toBe(false);
  });

  /**
   * An optional row the customer HAS selected is being charged for, so its money is inside the
   * Subtotal and it is no longer an "extra". #2090: it does keep the Optional TAG (see
   * `optionalMarkerFor` in the mixed-state block below) - what it loses is the "(not included)"
   * half, which is what `isOptionalExtra` answers.
   */
  it('marks nothing on an optional row the customer did select', () => {
    const view = buildEstimateDocumentView(
      withOptionalAddOns({
        subtotal: 2700,
        total_amount: 2700,
        line_items: [
          { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          { ...OPTIONAL_UNSELECTED_LINE, is_selected: true },
        ],
        scopes: [PRICED_SCOPE],
      }) as never,
      ORG as never,
    );

    const addOn = view.rows.find((r) => r.title === 'Smart lock upgrade')!;
    expect(addOn).toMatchObject({ optional: true, countsTowardTotals: true, netAmount: 500 });
    expect(isOptionalExtra(addOn)).toBe(false);
    expect(hasOptionalExtras(view)).toBe(false);
  });

  /**
   * A discounted add-on prices exactly like a discounted line the customer is buying: the gross
   * struck through beside the net. That net is what they would pay if they took it, which is the
   * only figure worth showing them.
   */
  it('prices a discounted add-on in full, gross and net alike', () => {
    const view = buildEstimateDocumentView(
      withOptionalAddOns({
        line_items: [
          { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          { ...OPTIONAL_UNSELECTED_LINE, line_total: 600, discount_amount: 100, discount_type: 'PERCENTAGE', discount_value: 16.67 },
        ],
      }) as never,
      ORG as never,
    );

    expect(view.rows.find((r) => r.title === 'Smart lock upgrade')).toMatchObject({
      discounted: true,
      grossAmount: 600,
      netAmount: 500,
      countsTowardTotals: false,
    });
  });

  it('keeps an optional-unselected line out of the Line Discounts row too', () => {
    const view = buildEstimateDocumentView(
      withOptionalAddOns({
        line_items: [
          { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 250, line_total: 250, discount_amount: 50, discount_type: 'FIXED_AMOUNT', discount_value: 50 },
          { ...OPTIONAL_UNSELECTED_LINE, line_total: 600, discount_amount: 100, discount_type: 'FIXED_AMOUNT', discount_value: 100 },
        ],
      }) as never,
      ORG as never,
    );

    const lineDiscounts = view.totals.find((t) => t.kind === 'line_discounts');
    // Only the counted line's $50 — the unselected line's $100 was never in the subtotal, so
    // subtracting it beneath the subtotal would claim a saving the customer is not getting.
    expect(lineDiscounts?.amount).toBe(50);
  });

  it('treats a legacy row with neither flag set as counting, exactly as the totals do', () => {
    const view = buildEstimateDocumentView(estimate() as never, ORG as never);
    for (const row of view.rows) {
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
        total_amount: 2700,
        line_items: [
          { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
          TAKEN_LINE,
        ],
        // The optional SCOPE stays untaken, so the document holds one of each.
        scopes: [PRICED_SCOPE, OPTIONAL_UNSELECTED_SCOPE],
      });
    }

    it('counts the add-on that was taken and leaves out the one that was not', () => {
      const model = buildEstimateDocumentView(mixed() as never , ORG as never);

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
      expect(hasOptionalExtras(buildEstimateDocumentView(mixed() as never , ORG as never))).toBe(true);
    });

    it('tags both add-ons, and only the untaken one as not included', () => {
      const model = buildEstimateDocumentView(mixed() as never , ORG as never);

      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Smart lock upgrade')!)).toBe(OPTIONAL_INCLUDED_MARKER);
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Repaint the frames')!)).toBe(OPTIONAL_ROW_MARKER);
      // A row that was never optional carries nothing at all, whatever the rest of the document does.
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Keypad')!)).toBeNull();
    });

    it('has nothing left to explain once EVERY add-on is taken, so the note drops away', () => {
      const model = buildEstimateDocumentView(
        withOptionalAddOns({
          subtotal: 3500,
          total_amount: 3500,
          line_items: [
            { description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
            TAKEN_LINE,
          ],
          scopes: [PRICED_SCOPE, { ...OPTIONAL_UNSELECTED_SCOPE, is_selected: true }],
        }) as never , ORG as never,
      );

      expect(hasOptionalExtras(model)).toBe(false);
      // Both are still TAGGED - the customer keeps seeing which of these were their own choice.
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Smart lock upgrade')!)).toBe(OPTIONAL_INCLUDED_MARKER);
      expect(optionalMarkerFor(model.rows.find((r) => r.title === 'Repaint the frames')!)).toBe(OPTIONAL_INCLUDED_MARKER);
    });
  });
});

/**
 * #2028 × #2053 — the view-model can only honour a flag the PROJECTION actually selects. Every
 * customer-facing document surface (both PDF templates, the emailed attachment, the public page)
 * is built from `estimateDocumentSelect`, so a missing key here makes every one of them
 * structurally blind: `is_optional` reads as undefined, `countsTowardTotals` answers "counts",
 * and an unselected add-on prints an amount the persisted Subtotal does not contain.
 *
 * Asserted against the select OBJECT, not a response body — `setup.ts` mocks Prisma wholesale, so
 * a missing key is invisible to any test that reads a hand-written `mockResolvedValue`.
 */
describe('the document projection selects what the totals key on', () => {
  it('selects is_optional/is_selected on every line item', () => {
    expect(estimateDocumentSelect.line_items.select.is_optional).toBe(true);
    expect(estimateDocumentSelect.line_items.select.is_selected).toBe(true);
  });

  it('still excludes the staff-only cost columns', () => {
    const select = estimateDocumentSelect.line_items.select as Record<string, unknown>;
    expect('unit_cost' in select).toBe(false);
    expect('markup_percent' in select).toBe(false);
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
