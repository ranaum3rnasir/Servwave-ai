/**
 * The estimate editor states an optional row's state ONCE, and says nothing about who last
 * changed it.
 *
 * Two rules, for both row kinds (a line item and a scope-of-work block) and both modes
 * (editable and read-only):
 *
 *  1. There is no live attribution caption anywhere. The editor never tells the salesperson
 *     "Added by customer 3 minutes ago".
 *  2. One tag carries the whole state, beside the row's name:
 *       - optional, customer has not answered  -> "Optional"
 *       - optional, customer took it           -> "Included"
 *       - optional, customer left it           -> "Not included"
 *     A row that is not optional carries no tag at all.
 *
 * "Not included" is deliberate, and deliberately not "Declined": "Declined" is already this
 * product's label for the estimate status meaning the customer rejected the whole quote, and
 * both words can land on one screen.
 *
 * The per-row checkbox is NOT part of either rule. It stays, on an optional line item and on an
 * optional saved scope block, so the salesperson can pre-tick an item on the customer's behalf
 * before sending. The last describe below guards that it survives.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { EstimateLineItemsEditor, EstimateScopeOfWorkCard } from '@/components/estimates/EstimateLineItemsEditor';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { LineItemsTable } from '@/components/jobs/items/LineItemsTable';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import type { EstimateLineItem } from '@/lib/api/estimates';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    updateEstimate: vi.fn().mockResolvedValue({}),
    addEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
  };
});

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

/**
 * Every word the editor can use to state an optional row's state, including the two it must no
 * longer use. Counting the whole vocabulary - rather than asking whether one word appears once -
 * is what makes "stated once per row" able to fail: before this change a row said "Optional"
 * beside its name AND "Included" under its amount, two DIFFERENT words, so counting either one
 * alone found exactly one and passed.
 */
const STATE_WORDS = ['Optional', 'Included', 'Not included', 'Declined'];

/** The state words actually painted on screen, read off the leaf elements so no ancestor counts twice. */
function stateWordsIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map((el) => (el.textContent ?? '').trim())
    .filter((text) => STATE_WORDS.includes(text));
}

/**
 * The state TAGS, in DOM order. A scope block's Optional switch keeps its own label for ever,
 * because that label names what the control does, so on that surface the absence assertions have
 * to aim at the tag rather than at the whole block.
 */
function stateTagsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="optional-state-tag"]'));
}

function stateTagTextIn(container: HTMLElement): string[] {
  return stateTagsIn(container).map((el) => (el.textContent ?? '').trim());
}

/**
 * The Optional switch's visible label and its accessible name. WCAG 2.5.3 (Label in Name) wants
 * the accessible name to contain the visible label, so that someone driving the page by voice can
 * say what they can see and reach the control they meant.
 */
function optionalSwitchNaming(container: HTMLElement) {
  const control = container.querySelector('[role="switch"][aria-label*="Optional"]');
  if (!control) throw new Error('no Optional switch rendered');
  const id = control.getAttribute('id') ?? '';
  const label = id ? container.querySelector(`label[for="${id}"]`) : null;
  return {
    accessibleName: control.getAttribute('aria-label') ?? '',
    visibleLabel: (label?.textContent ?? '').trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Line items
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONAL_LINE: InvoiceLineItem = {
  id: 'line-one-tag',
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

function renderLine(
  over: Partial<InvoiceLineItem> & { answered?: boolean; canEdit?: boolean; onUpdate?: () => void } = {},
) {
  const { answered = false, canEdit = true, onUpdate = vi.fn(), ...lineOver } = over;
  const line: InvoiceLineItem = { ...OPTIONAL_LINE, ...lineOver };
  return renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[line.id]}>
            <LineItemRow
              line={line}
              canEdit={canEdit}
              canManage={canEdit}
              canSeePricing
              onUpdate={onUpdate}
              onDelete={vi.fn()}
              onEdit={vi.fn()}
              showOptionalToggle
              selectionsLocked={answered}
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
}

describe('an optional line item states its state once, beside the item name', () => {
  it.each([
    ['editable', true],
    ['read-only', false],
  ])('%s: before the customer answers it reads only "Optional"', (_mode, canEdit) => {
    const { container } = renderLine({ answered: false, is_selected: true, canEdit });

    expect(stateWordsIn(container)).toEqual(['Optional']);
    expect(screen.queryByText('Included')).not.toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
  });

  it.each([
    ['editable', true],
    ['read-only', false],
  ])('%s: once the customer takes it, it reads "Included" and no longer "Optional"', (_mode, canEdit) => {
    const { container } = renderLine({ answered: true, is_selected: true, canEdit });

    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(stateWordsIn(container)).toEqual(['Included']);
  });

  it.each([
    ['editable', true],
    ['read-only', false],
  ])('%s: once the customer leaves it, it reads "Not included" and no longer "Optional"', (_mode, canEdit) => {
    const { container } = renderLine({ answered: true, is_selected: false, canEdit });

    expect(screen.getByText('Not included')).toBeInTheDocument();
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
    expect(stateWordsIn(container)).toEqual(['Not included']);
  });

  it.each([
    ['editable', true],
    ['read-only', false],
  ])('%s: a line that is not optional carries no tag at all', (_mode, canEdit) => {
    const { container } = renderLine({ is_optional: false, is_selected: true, canEdit });

    expect(stateWordsIn(container)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope-of-work blocks
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONAL_SCOPE: Scope = {
  id: 'scope-one-tag',
  title: 'Demo and haul-away',
  body: 'Remove the old unit and dispose of it responsibly.',
  flat_price: 250,
  is_taxable: true,
  internal_cost: 100,
  is_optional: true,
  is_selected: true,
};

function renderScope(
  over: Partial<Scope> & { answered?: boolean; canEdit?: boolean; onUpdate?: () => void } = {},
) {
  const { answered = false, canEdit = true, onUpdate = vi.fn(), ...scopeOver } = over;
  const scope: Scope = { ...OPTIONAL_SCOPE, ...scopeOver };
  return render(
    <ScopeOfWorkCard
      scopes={[scope]}
      canEdit={canEdit}
      canSeePricing
      onAdd={vi.fn()}
      onUpdate={onUpdate}
      onDelete={vi.fn()}
      onReorder={vi.fn()}
      showOptionalToggle
      selectionsLocked={answered}
    />,
  );
}

/**
 * A saved scope block, unlike a line item row, carries a control that already names the property:
 * the Optional switch. That switch's label says what the switch DOES, permanently, and the
 * customer's answer is a separate tag that appears only once there is an answer to report. The
 * two never say the same thing, so the block still states each fact exactly once.
 */
describe('a saved scope block: the switch names the property, a separate tag names the answer', () => {
  it('before the customer answers, the block shows the Optional switch and no tag at all', () => {
    const { container } = renderScope({ answered: false, is_selected: true });

    expect(screen.getByRole('switch', { name: /optional for scope 1/i })).toBeChecked();
    expect(stateTagTextIn(container)).toEqual([]);
    // The switch's own label is the ONLY state word on the block, and it is a label, not a tag.
    expect(stateWordsIn(container)).toEqual(['Optional']);
  });

  it('once the customer takes it, a separate tag reads "Included" while the switch keeps saying "Optional"', () => {
    const { container } = renderScope({ answered: true, is_selected: true });

    expect(stateTagTextIn(container)).toEqual(['Included']);
    expect(stateTagsIn(container)[0]?.tagName).not.toBe('LABEL');
    expect(optionalSwitchNaming(container).visibleLabel).toBe('Optional');
    expect(screen.getByRole('switch', { name: /optional for scope 1/i })).toBeChecked();
  });

  it('once the customer leaves it, the tag reads "Not included", never "Declined"', () => {
    const { container } = renderScope({ answered: true, is_selected: false });

    expect(stateTagTextIn(container)).toEqual(['Not included']);
    expect(stateTagsIn(container)[0]?.tagName).not.toBe('LABEL');
    expect(optionalSwitchNaming(container).visibleLabel).toBe('Optional');
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
  });

  // Forward guard only: a testid selector finds nothing on any code that predates the testid, so
  // this passes vacuously against every earlier version. It can only fail from here on.
  it('the tag never reads "Optional" - that word belongs to the switch, in every state', () => {
    for (const answered of [false, true]) {
      for (const is_selected of [false, true]) {
        const { container, unmount } = renderScope({ answered, is_selected });
        expect(stateTagTextIn(container)).not.toContain('Optional');
        unmount();
      }
    }
  });

  // Forward guard only, for the same reason as the case above: an empty testid list proves
  // nothing about code that never carried the testid.
  it('a block that is not optional carries no tag, whatever the customer has done', () => {
    for (const answered of [false, true]) {
      const { container, unmount } = renderScope({ is_optional: false, is_selected: true, answered });
      expect(stateTagTextIn(container)).toEqual([]);
      unmount();
    }
  });
});

/**
 * The regression this round exists to prevent: the switch was briefly relabelled with the
 * customer's answer, so it read "Included" while its accessible name still read "Optional for
 * scope 1" and its actual job was still to turn optionality off. A mislabelled control is worse
 * than a duplicated word.
 */
describe('the Optional switch stays honestly labelled', () => {
  it.each([
    ['not optional', { is_optional: false, is_selected: true, answered: false }],
    ['optional, unanswered', { is_optional: true, is_selected: true, answered: false }],
    ['optional, unanswered, untaken', { is_optional: true, is_selected: false, answered: false }],
    ['optional, customer took it', { is_optional: true, is_selected: true, answered: true }],
    ['optional, customer left it', { is_optional: true, is_selected: false, answered: true }],
  ])('%s: the visible label reads "Optional" and the accessible name contains it', (_state, over) => {
    const { container } = renderScope(over as Partial<Scope> & { answered?: boolean });

    const { visibleLabel, accessibleName } = optionalSwitchNaming(container);
    expect(visibleLabel).toBe('Optional');
    expect(accessibleName).toBe('Optional for scope 1');
  });
});

/**
 * A READ-ONLY block has no switch, so nothing else on it can name the property. Its single tag
 * therefore carries the whole state, exactly as a line item row's does.
 */
describe('a read-only scope block carries the whole state in one tag, as a line item row does', () => {
  it('before the customer answers it reads only "Optional"', () => {
    const { container } = renderScope({ answered: false, is_selected: true, canEdit: false });

    expect(stateTagTextIn(container)).toEqual(['Optional']);
    expect(stateWordsIn(container)).toEqual(['Optional']);
  });

  it('once the customer takes it, it reads "Included" and no longer "Optional"', () => {
    const { container } = renderScope({ answered: true, is_selected: true, canEdit: false });

    expect(stateTagTextIn(container)).toEqual(['Included']);
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(stateWordsIn(container)).toEqual(['Included']);
  });

  it('once the customer leaves it, it reads "Not included" and no longer "Optional"', () => {
    const { container } = renderScope({ answered: true, is_selected: false, canEdit: false });

    expect(stateTagTextIn(container)).toEqual(['Not included']);
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();
    expect(stateWordsIn(container)).toEqual(['Not included']);
  });

  it('a block that is not optional carries no tag at all', () => {
    const { container } = renderScope({ is_optional: false, is_selected: true, canEdit: false });

    expect(stateTagTextIn(container)).toEqual([]);
    expect(stateWordsIn(container)).toEqual([]);
  });
});

/**
 * The inline ADD form is a different thing again: its checkbox is the rep's pre-send default, not
 * a report of anything the customer did. This slice did not touch it, and this case says so.
 */
describe('the inline add form keeps its own pre-send wording, on its own prop', () => {
  it('reads "Included" beside the pre-tick, and "Not included" once the rep unticks it', async () => {
    render(
      <ScopeOfWorkCard
        scopes={[]}
        canEdit
        canSeePricing
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        showOptionalToggle
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));

    await userEvent.click(form.getByRole('switch', { name: /optional for new scope/i }));
    expect(form.getByText('Not included')).toBeInTheDocument();

    await userEvent.click(form.getByRole('checkbox', { name: /include new scope/i }));
    expect(form.getByText('Included')).toBeInTheDocument();

    // It is a caption on the rep's own control, never one of the customer-answer tags.
    expect(stateTagTextIn(screen.getByTestId('scope-add-form'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The attribution caption is gone
// ─────────────────────────────────────────────────────────────────────────────

/** Every file under frontend/src, minus this suite's own home. */
function sourceFilesOutsideTests(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFilesOutsideTests(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * A real estimate fed in at the TOP of the chain - the two components the workspace actually
 * mounts - rather than at the row. Nothing downstream may turn a selection into an attribution
 * caption, however deep the chain gets.
 *
 * The 2026-09-18 optional-add-ons revision dropped the per-tick record entirely, so these
 * fixtures no longer carry a `selection_attribution` array: there is no such payload key any
 * more, and a fixture that invented one would be testing a shape the API cannot send.
 */
const ATTRIBUTED_LINE = {
  id: 'line-attributed',
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
} as unknown as EstimateLineItem;


const ESTIMATE_WITH_LINE_ATTRIBUTION = {
  id: 'est-attributed',
  line_items: [ATTRIBUTED_LINE],
  total_amount: 100,
};

const ESTIMATE_WITH_SCOPE_ATTRIBUTION = {
  id: 'est-attributed',
  scopes: [{ ...OPTIONAL_SCOPE, id: 'scope-attributed', is_selected: true }],
};

describe('the editor never names who last changed a selection', () => {
  it('a line whose selection the customer changed shows no "Added by ..." sentence', async () => {
    const { container } = renderWithProviders(
      <EstimateLineItemsEditor
        estimate={ESTIMATE_WITH_LINE_ATTRIBUTION}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability: buildAbility([{ action: 'update', subject: 'Estimate' }]) },
    );

    expect(await screen.findByText('Extended warranty')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Added by/);
    expect(container.textContent).not.toMatch(/ago/);
  });

  it('a scope block whose selection the salesperson changed shows no "Added by ..." sentence', async () => {
    const { container } = renderWithProviders(
      <EstimateScopeOfWorkCard estimate={ESTIMATE_WITH_SCOPE_ATTRIBUTION} canManage canSeePricing />,
      { ability: buildAbility([{ action: 'update', subject: 'Estimate' }]) },
    );

    expect(await screen.findByDisplayValue('Demo and haul-away')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Added by/);
    expect(container.textContent).not.toMatch(/ago/);
  });

  it('neither attribution sentence is written anywhere in the app source', () => {
    const offenders = sourceFilesOutsideTests(join(__dirname, '..')).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('Added by customer') || source.includes('Added by you for the customer');
    });

    expect(offenders).toEqual([]);
  });

  it('the attribution payload shape is not declared anywhere in the app source either', () => {
    const offenders = sourceFilesOutsideTests(join(__dirname, '..')).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('selection_attribution') || source.includes('SelectionAttribution');
    });

    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-row checkbox is untouched by any of the above
// ─────────────────────────────────────────────────────────────────────────────

describe('the salesperson can still tick an optional row on the customer behalf', () => {
  it('an optional line item keeps a working checkbox', async () => {
    const onUpdate = vi.fn();
    renderLine({ is_selected: false, onUpdate });

    const box = screen.getByRole('checkbox', { name: 'Include Extended warranty' });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    expect(onUpdate).toHaveBeenCalledWith({ is_selected: true });
  });

  it('an optional saved scope block keeps a working checkbox', async () => {
    const onUpdate = vi.fn();
    renderScope({ is_selected: false, onUpdate });

    const box = screen.getByRole('checkbox', { name: /include scope 1/i });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    expect(onUpdate).toHaveBeenCalledWith(0, { is_selected: true });
  });

  it('a read-only optional line item still shows the checkbox, disabled rather than absent', () => {
    renderLine({ is_selected: true, canEdit: false });

    expect(screen.getByRole('checkbox', { name: 'Include Extended warranty' })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Job and Invoice are untouched
// ─────────────────────────────────────────────────────────────────────────────

function jobShapeProps(lines: InvoiceLineItem[]) {
  return {
    lines,
    canAdd: true,
    canManageRows: true,
    canEditRows: true,
    canEditBilling: false,
    canSeePricing: true,
    busy: false,
    hasInvoice: false,
    subtotal: null,
    tax_amount: null,
    tax_rate: null,
    discount_amount: null,
    tip: null,
    total_amount: null,
    addOpen: false,
    onAddOpenChange: vi.fn(),
    canSaveToPriceBook: false,
    editingLine: null,
    onEditingLineChange: vi.fn(),
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onTipChange: vi.fn(),
    onDiscountChange: vi.fn(),
    onTaxRateChange: vi.fn(),
  };
}

describe('Job and Invoice, which never opt into optional rows, say nothing about state', () => {
  it('a Job/Invoice line grid paints no state word and no checkbox, even for a line flagged optional', () => {
    const { container } = renderWithProviders(
      <LineItemsTable
        {...jobShapeProps([{ ...OPTIONAL_LINE, id: 'l1', is_optional: true, is_selected: false }])}
      />,
    );

    expect(stateWordsIn(container)).toEqual([]);
    expect(screen.queryByRole('checkbox', { name: /include /i })).not.toBeInTheDocument();
  });

  it('a Job/Invoice scope card paints no state word and no Optional switch, even for a block flagged optional', () => {
    const { container } = render(
      <ScopeOfWorkCard
        scopes={[OPTIONAL_SCOPE]}
        canEdit
        canSeePricing
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(stateWordsIn(container)).toEqual([]);
    expect(within(container).queryByRole('switch', { name: /optional for/i })).not.toBeInTheDocument();
  });
});
