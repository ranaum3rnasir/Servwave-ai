/**
 * #2088 - `areSelectionsLocked` (OQ3/AC12) and what the editor does with it. This is THE selection
 * lock; deliberately NOT `isEstimateLocked` (the edit lock: deposit paid OR org `lock_on_send`),
 * see `selectionLock.ts`'s own doc for why reusing that predicate would be wrong: it would call
 * the answer settled on every `lock_on_send` org the moment an estimate was sent.
 *
 * Four parts, in file order:
 *  1. The predicate's own cases, plus the structural R4b assertion that its input type carries no
 *     `organization`/`lock_on_send` member.
 *  2. `LineItemRow`'s optional TAG, rendered from the predicate and nothing else (mirrors
 *     `LineItemRow.test.tsx`'s DndContext/SortableContext + renderWithProviders harness): the
 *     answered vs unanswered branch, for both `is_selected` values, and the read-only twin.
 *  3. The receipt card's "N of M optional add-ons included" count (AC7/R8).
 *  4. #2205's signing cases, and the byte-identity guard tying this predicate to its backend twin.
 *
 * Parts 1 and 2 have each been rewritten since #2088, by a different change, which is worth
 * knowing before trusting either:
 *  - 2026-09-18 revision, decision 3, rewrote the WORDING. "Declined" left the editor (it is
 *    already the estimate STATUS for a rejected quote), an unanswered optional row now reads only
 *    "Optional", and the live attribution caption was deleted outright, taking the AC6 cases that
 *    used to sit here with it. The full new rule lives in estimate-optional-row-one-tag.test.tsx.
 *  - #2205 (decision 6, signing locks) then rewrote the PREDICATE itself, so part 1's cases are
 *    not the ones AC12 originally named. Part 2 is unaffected by that: it passes `selectionsLocked`
 *    to the row as an explicit prop, so it pins what the editor does with the answer and never
 *    how the predicate arrives at one.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import { areSelectionsLocked } from '@/lib/estimates/selectionLock';
import type { InvoiceLineItem } from '@/lib/api/jobs';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    updateEstimate: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
  };
});

/**
 * The "is true when a DEPOSIT invoice is PAID" case this block used to carry was deleted by the
 * 2026-09-18 revision, which makes signature the only thing that locks. Its successor is
 * "leaves an unsigned estimate open even when its deposit has already been paid", at the foot of
 * this file, which asserts the opposite.
 */
describe('#2088 AC12: areSelectionsLocked, WON and nothing else', () => {
  it('is true for a WON estimate with no deposit', () => {
    expect(areSelectionsLocked({ status: 'WON', invoices: [] })).toBe(true);
  });

  it('is false when a DEPOSIT invoice exists but is not PAID, even on a SENT estimate', () => {
    expect(
      areSelectionsLocked({ status: 'SENT', invoices: [{ kind: 'DEPOSIT', status: 'SENT' }] }),
    ).toBe(false);
  });

  it('is false for a SENT estimate with no deposit at all — the isEstimateLocked divergence', () => {
    expect(areSelectionsLocked({ status: 'SENT', invoices: [] })).toBe(false);
  });

  // R4b — AC12's fourth case restated structurally: `grep -n "lock_on_send"
  // frontend/src/lib/estimates/selectionLock.ts` -> zero matches. The predicate's input type has
  // no `organization`/`lock_on_send` member at all, so the edit lock cannot leak into it.
  it('R4b: the predicate\'s own source contains no "lock_on_send" reference, anywhere', () => {
    const source = readFileSync(
      join(__dirname, '../lib/estimates/selectionLock.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/lock_on_send/);
  });
});

const OPTIONAL_LINE: InvoiceLineItem = {
  id: 'line-lock-2088',
  sequence: 1,
  description: 'Extended warranty',
  quantity: 1,
  unit_price: 100,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 100,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
  is_optional: true,
  is_selected: true,
};

function renderRow(over: Partial<InvoiceLineItem> & {
  selectionsLocked?: boolean;
  canEdit?: boolean;
} = {}) {
  const { selectionsLocked, canEdit = true, ...lineOver } = over;
  const line: InvoiceLineItem = { ...OPTIONAL_LINE, ...lineOver };
  renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[line.id]}>
            <LineItemRow
              line={line}
              canEdit={canEdit}
              canManage={canEdit}
              canSeePricing
              onUpdate={vi.fn()}
              onDelete={vi.fn()}
              onEdit={vi.fn()}
              showOptionalToggle
              selectionsLocked={selectionsLocked}
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
}

describe('#2088 AC12 (UI half): the optional tag renders from areSelectionsLocked and nothing else', () => {
  it('a locked, not-included row reads "Not included", and never the estimate status word "Declined"', () => {
    renderRow({ is_selected: false, selectionsLocked: true });
    expect(screen.getByText('Not included')).toBeInTheDocument();
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
  });

  it('a locked, INCLUDED row reads Included, never Declined', () => {
    renderRow({ is_selected: true, selectionsLocked: true });
    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
  });

  it('an UNLOCKED row reads only "Optional", whichever way is_selected happens to sit', () => {
    renderRow({ is_selected: false, selectionsLocked: false });
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
  });
});

// The read-only twin (task item 2 / R11/H11): every frozen frontend case renders with
// canEdit:true, so deleting only the EDITABLE Switch would still pass every frozen assertion
// while a `canEdit:false` row went on rendering the old "Selected"/"Not selected" static span.
// LineItemRow.tsx no longer has a separate static branch at all — the same disabled Checkbox +
// tag render for both canEdit values - so these assert that unification directly. Read at the
// ANSWERED state (2026-09-18 revision), which is where the two modes could still disagree.
describe('#2088: the read-only twin — a canEdit:false optional row never falls back to "Selected"/"Not selected"', () => {
  it('a read-only, included row shows the SAME "Included" tag a canEdit:true row shows, never "Selected"', () => {
    renderRow({ is_selected: true, canEdit: false, selectionsLocked: true });
    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.queryByText('Selected')).not.toBeInTheDocument();
    expect(screen.queryByText('Not selected')).not.toBeInTheDocument();
  });

  it('a read-only, not-included row shows "Not included", never "Not selected", and its checkbox is disabled (not absent)', () => {
    renderRow({ is_selected: false, canEdit: false, selectionsLocked: true });
    expect(screen.getByText('Not included')).toBeInTheDocument();
    expect(screen.queryByText('Not selected')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Include Extended warranty' })).toBeDisabled();
  });
});

// #2088 AC7 / R8 — round 2 (Lead finding, post-Round-1 validation): the "N of M optional add-ons
// included" count MUST count optional SCOPE BLOCKS alongside optional LINES. A mutation that drops
// scopes from either side of the fraction (M or N) passed every previously-shipped test, including
// the frozen repro-2088.test.tsx (which only ever fixtures optional LINES, never a scope) — so
// nothing in the shipped suite could catch it. This fixture mixes both on purpose: 2 optional
// lines (both included) + 1 optional scope block (not included) = "2 of 3", a number that is wrong
// under EITHER a lines-only M or a lines-only N.
function receiptEstimate(overrides: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-2088-mixed',
    subtotal: 1000,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 1000,
    deposit_type: null,
    deposit_value: null,
    send_config: null,
    line_items: [],
    scopes: [],
    ...overrides,
  };
}

describe('#2088 AC7/R8: the receipt card counts optional SCOPE BLOCKS, not only lines', () => {
  it('reads "2 of 3 optional add-ons included" for 2 included optional lines + 1 not-included optional scope', async () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={receiptEstimate({
          line_items: [
            {
              id: 'l1', estimate_id: 'est-2088-mixed', sequence: 1, description: 'Base unit', quantity: 1,
              unit_price: 500, unit_cost: null, markup_percent: null, is_taxable: true, line_total: 500,
              discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
              price_book_item_id: null, is_optional: false, is_selected: true,
            },
            {
              id: 'l2', estimate_id: 'est-2088-mixed', sequence: 2, description: 'Extended warranty', quantity: 1,
              unit_price: 100, unit_cost: null, markup_percent: null, is_taxable: true, line_total: 100,
              discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
              price_book_item_id: null, is_optional: true, is_selected: true,
            },
            {
              id: 'l3', estimate_id: 'est-2088-mixed', sequence: 3, description: 'Premium filter', quantity: 1,
              unit_price: 50, unit_cost: null, markup_percent: null, is_taxable: true, line_total: 50,
              discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
              price_book_item_id: null, is_optional: true, is_selected: true,
            },
          ],
          scopes: [
            { id: 'sc-1', title: 'Optional install add-on', body: '', flat_price: 200, is_taxable: true, is_optional: true, is_selected: false },
          ],
        })}
        canEditNow
      />,
    );

    expect(await screen.findByText('2 of 3 optional add-ons included')).toBeInTheDocument();
    expect(screen.queryByText(/\$.*optional add-ons/i)).not.toBeInTheDocument();
  });

  // AC7's other half, reconfirmed here alongside the mixed-fixture positive so both halves of
  // the rule live in the same place: M=0 (no optional lines AND no optional scopes) hides the
  // line entirely — never renders "0 of 0" or any other degenerate string.
  it('is absent (M = 0) when neither the lines nor the scopes carry any optional flag', async () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={receiptEstimate({
          line_items: [
            {
              id: 'l1', estimate_id: 'est-2088-mixed', sequence: 1, description: 'Base unit', quantity: 1,
              unit_price: 500, unit_cost: null, markup_percent: null, is_taxable: true, line_total: 500,
              discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
              price_book_item_id: null, is_optional: false, is_selected: true,
            },
          ],
          scopes: [
            { id: 'sc-1', title: 'Required scope', body: '', flat_price: 150, is_taxable: true, is_optional: false, is_selected: true },
          ],
        })}
        canEditNow
      />,
    );

    await screen.findByText('Subtotal');
    expect(screen.queryByText(/optional add-ons included/i)).not.toBeInTheDocument();
  });
});

/**
 * Revision, 2026-09-18 (PRD section 5, slice 5). Ran's decision 6: "A customer cannot tick after
 * signing. Once they sign, it is locked."
 *
 * The superseded rule made a deposit invoice, when one existed, the whole question: locked iff
 * that deposit was PAID. That left a customer free to keep changing what they were buying in the
 * window between putting their signature on the estimate and paying for it. Signature is the
 * moment the document stops being negotiable, so the deposit no longer has any say in it.
 */
describe('signing is what locks an estimate\'s optional selections', () => {
  it('locks a signed estimate whose deposit has not been paid', () => {
    expect(
      areSelectionsLocked({ status: 'WON', invoices: [{ kind: 'DEPOSIT', status: 'SENT' }] }),
    ).toBe(true);
  });

  it('locks a signed estimate whose deposit is only part-paid', () => {
    expect(
      areSelectionsLocked({ status: 'WON', invoices: [{ kind: 'DEPOSIT', status: 'PARTIAL' }] }),
    ).toBe(true);
  });

  it('leaves an unsigned estimate open even when its deposit has already been paid', () => {
    expect(
      areSelectionsLocked({ status: 'SENT', invoices: [{ kind: 'DEPOSIT', status: 'PAID' }] }),
    ).toBe(false);
  });
});

/**
 * The backend enforces the same rule from a hand-kept transcription of the predicate above
 * (`backend/src/lib/estimates/selectionLock.ts`, whose own docblock states the convention). There
 * is no shared workspace to put one copy in - the root package.json declares exactly
 * ["backend", "frontend"] and neither tree imports across that boundary - so a source comparison
 * is the ceiling, the same one `estimate-document-view-twins.test.ts` settled on. Comments are
 * stripped and whitespace collapsed: the two files are allowed to explain themselves differently,
 * they are not allowed to DECIDE differently.
 */
describe('the backend twin decides the lock identically', () => {
  /**
   * Naive slicing does NOT work here, and got this guard shipped toothless once already: the
   * declaration opens an inline parameter object type, so the first `\n}` after it closes THAT
   * (`}): boolean {`) and the comparison never reaches the body. Two twins with opposite bodies
   * compared equal and the suite stayed green.
   *
   * So: match the parameter list's parens first, take the body's opening brace as the first `{`
   * after the closing `)`, and brace-match from there. The braces inside the parameter type are
   * out of reach by construction, and the slice always contains the line that decides.
   */
  function transcribedPredicate(path: string): string {
    const source = readFileSync(path, 'utf8');
    const start = source.indexOf('export function areSelectionsLocked');
    expect(start).toBeGreaterThan(-1);

    const paramsOpen = source.indexOf('(', start);
    expect(paramsOpen).toBeGreaterThan(-1);
    const paramsClose = matchDelimiter(source, paramsOpen, '(', ')');
    const bodyOpen = source.indexOf('{', paramsClose);
    expect(bodyOpen).toBeGreaterThan(paramsClose);
    const bodyClose = matchDelimiter(source, bodyOpen, '{', '}');

    return source
      .slice(start, bodyClose + 1)
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Index of the delimiter closing the one at `open`. Throws rather than returning a wrong span. */
  function matchDelimiter(source: string, open: number, opener: string, closer: string): number {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === opener) depth++;
      else if (source[i] === closer && --depth === 0) return i;
    }
    throw new Error(`unbalanced ${opener}${closer} from offset ${open}`);
  }

  it('transcribes areSelectionsLocked verbatim, so neither copy can be changed alone', () => {
    const frontend = transcribedPredicate(join(__dirname, '../lib/estimates/selectionLock.ts'));
    const backend = transcribedPredicate(
      join(__dirname, '../../..', 'backend/src/lib/estimates/selectionLock.ts'),
    );
    expect(backend).toBe(frontend);
  });
});
