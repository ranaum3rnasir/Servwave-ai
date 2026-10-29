/**
 * The rep's optional checkbox is LIVE, and it writes the rep's recommendation.
 *
 * This file is the inversion of the freeze it used to assert, kept at the same anchor so the two
 * models can be read against each other. The freeze was: once the estimate left DRAFT the
 * checkbox showed `rep_selected`, was DISABLED, and said "(as sent)". Ran overruled it on
 * 2026-09-19, decision 12: "They don't need to have a disabled tick box. They can still click on
 * it, but it doesn't do anything."
 *
 * So the rule this file now pins:
 *   - the checkbox is INTERACTIVE at DRAFT, SENT and PENDING, and inert only once the customer
 *     has signed (`areSelectionsLocked`, which is WON and nothing else);
 *   - it renders `rep_selected` - the rep's own recommendation - falling back to `is_selected`
 *     when that is null, at every status;
 *   - it says `Include …` at every status. There is no "(as sent)" wording left, because there is
 *     no frozen state to name;
 *   - `onCheckedChange` fires at every unlocked status. The backend routes that write to
 *     `rep_selected` after send (`routeSelectionWrite`, estimate-lines.controller.ts), which is
 *     why the tick no longer moves the customer's document - and no longer nulls their link.
 *
 * "it doesn't do anything" is literal, and deliberate: a rep who ticks a box on a SENT estimate
 * sees the estimate total stay put, with nothing on screen explaining why. PRD §5 records that
 * consequence and declines to solve it, so there is no tooltip or helper line to assert here.
 *
 * The separate Optional / Included / Not included tag is a DIFFERENT control driven by
 * `selectionsLocked`, and is not touched here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LineItemsTable } from '@/components/jobs/items/LineItemsTable';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import {
  EstimateLineItemsEditor,
  EstimateScopeOfWorkCard,
} from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import type { EstimateLineItem } from '@/lib/api/estimates';
import { renderWithProviders } from './helpers';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
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

function line(over: Partial<InvoiceLineItem> & { id: string }): InvoiceLineItem {
  return {
    sequence: 1,
    description: 'Add-on',
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
    ...over,
  };
}

function tableProps(lines: InvoiceLineItem[]) {
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

function scopeProps() {
  return {
    canEdit: true,
    canSeePricing: true,
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
  };
}

describe('line row: the checkbox shows the rep\'s recommendation and still writes', () => {
  it('a sent row shows what the REP recommends, not the customer\'s answer, and can still be ticked', async () => {
    // The rep recommended it; the customer has since unticked it. The rep sees their own offer,
    // which is what the next send will publish - and they can change it.
    const lines = [line({ id: 'l1', is_optional: true, is_selected: false, rep_selected: true })];
    const props = tableProps(lines);
    renderWithProviders(<LineItemsTable {...props} showOptionalToggle />);

    const box = screen.getByRole('checkbox', { name: 'Include Add-on' });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();

    await userEvent.click(box);
    // Still `is_selected` on the wire: the payload is the rep's intent, and the SERVER decides
    // which column that lands in. The editor does not know, and must not have to know, whether
    // this estimate has been sent.
    expect(props.onUpdate).toHaveBeenCalledWith('l1', { is_selected: false });
  });

  it('a DRAFT row falls back to is_selected, is editable, and writes through onUpdate', async () => {
    const lines = [line({ id: 'l1', is_optional: true, is_selected: false, rep_selected: null })];
    const props = tableProps(lines);
    renderWithProviders(<LineItemsTable {...props} showOptionalToggle />);

    const box = screen.getByRole('checkbox', { name: 'Include Add-on' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();

    await userEvent.click(box);
    expect(props.onUpdate).toHaveBeenCalledWith('l1', { is_selected: true });
  });

  it('a row with no recommendation falls back to is_selected, and is editable too', async () => {
    // The no-backfill fallback: a row that predates the column, or one the whole-document PATCH
    // recreated, has null here. It renders exactly what it rendered before the feature rather
    // than inventing a recommendation for itself - and, since A3, it is not disabled either.
    const lines = [line({ id: 'l1', is_optional: true, is_selected: true, rep_selected: null })];
    const props = tableProps(lines);
    renderWithProviders(<LineItemsTable {...props} showOptionalToggle />);

    const box = screen.getByRole('checkbox', { name: 'Include Add-on' });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();

    await userEvent.click(box);
    expect(props.onUpdate).toHaveBeenCalledWith('l1', { is_selected: false });
  });

  it('no row anywhere claims to have been sent', () => {
    // The `(as sent)` wording existed only to name a disabled control honestly, and it could
    // never be said about a row added after the send (addLine mints one with no recommendation).
    // The freeze is gone, so the wording goes with it - one label, every row, every status.
    const lines = [line({ id: 'l1', description: 'Added after send', is_optional: true, is_selected: true, rep_selected: null })];
    renderWithProviders(<LineItemsTable {...tableProps(lines)} showOptionalToggle />);

    expect(screen.queryByRole('checkbox', { name: 'Added after send (as sent)' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Include Added after send' })).toBeInTheDocument();
  });

  it('a SIGNED estimate\'s row is inert, and the signature lock is the only thing that makes it so', async () => {
    // `selectionsLocked` is `areSelectionsLocked` - WON and nothing else. It used to name the tag
    // and nothing more; since A3 it is also the one input that can disable this checkbox.
    const lines = [line({ id: 'l1', is_optional: true, is_selected: true, rep_selected: false })];
    const props = tableProps(lines);
    renderWithProviders(<LineItemsTable {...props} showOptionalToggle selectionsLocked />);

    const box = screen.getByRole('checkbox', { name: 'Include Add-on' });
    expect(box).toBeDisabled();

    await userEvent.click(box);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('Job/Invoice rows, which pass neither showOptionalToggle nor selectionsLocked, are byte-identical', () => {
    // The guard is unchanged in substance from the freeze it outlived: an estimate-only prop that
    // leaks onto a Job or Invoice table must change nothing at all. Only the name of the leaked
    // prop moved, because the freeze prop no longer exists to leak.
    const lines = [line({ id: 'l1', is_optional: true, is_selected: false, rep_selected: true })];
    // dnd-kit mints a module-global auto-incrementing announcer id per mount; it is the only
    // thing that legitimately differs between two renders of the same tree, so normalise it.
    const stable = (html: string) => html.replace(/(DndDescribedBy|DndLiveRegion)-\d+/g, '$1-N');
    const before = stable(renderWithProviders(<LineItemsTable {...tableProps(lines)} />).container.innerHTML);
    const after = stable(renderWithProviders(<LineItemsTable {...tableProps(lines)} selectionsLocked />).container.innerHTML);

    expect(after).toBe(before);
    expect(before).not.toContain('as sent');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('scope block: the checkbox shows the rep\'s recommendation and still writes', () => {
  function scope(over: Partial<Scope> = {}): Scope {
    return {
      id: 'scope-1',
      title: 'Permit filing',
      body: '',
      flat_price: 200,
      is_taxable: true,
      internal_cost: null,
      is_optional: true,
      is_selected: true,
      ...over,
    };
  }

  it('a sent scope shows what the REP recommends, not the customer\'s answer, and can still be ticked', async () => {
    const props = scopeProps();
    // The rep is NOT recommending it; the customer has since ticked it on.
    render(
      <ScopeOfWorkCard
        scopes={[scope({ is_selected: true, rep_selected: false })]}
        {...props}
        showOptionalToggle
      />,
    );

    const box = screen.getByRole('checkbox', { name: 'Include scope 1' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();

    await userEvent.click(box);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_selected: true });
  });

  it('a DRAFT scope falls back to is_selected, is editable, and writes through onUpdate', async () => {
    const props = scopeProps();
    render(
      <ScopeOfWorkCard scopes={[scope({ is_selected: false })]} {...props} showOptionalToggle />,
    );

    const box = screen.getByRole('checkbox', { name: 'Include scope 1' });
    expect(box).toBeEnabled();
    await userEvent.click(box);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_selected: true });
  });

  it('a scope with no recommendation key falls back to is_selected, and is editable too', async () => {
    const props = scopeProps();
    render(
      <ScopeOfWorkCard scopes={[scope({ is_selected: false })]} {...props} showOptionalToggle />,
    );

    const box = screen.getByRole('checkbox', { name: 'Include scope 1' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();

    await userEvent.click(box);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_selected: true });
  });

  it('no scope block anywhere claims to have been sent', () => {
    render(
      <ScopeOfWorkCard scopes={[scope({ is_selected: true })]} {...scopeProps()} showOptionalToggle />,
    );

    expect(screen.queryByRole('checkbox', { name: 'scope 1 (as sent)' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Include scope 1' })).toBeInTheDocument();
  });

  it('a SIGNED estimate\'s scope block is inert', async () => {
    const props = scopeProps();
    render(
      <ScopeOfWorkCard
        scopes={[scope({ rep_selected: true })]}
        {...props}
        showOptionalToggle
        selectionsLocked
      />,
    );

    const box = screen.getByRole('checkbox', { name: 'Include scope 1' });
    expect(box).toBeDisabled();

    await userEvent.click(box);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('the Optional switch beside it is NOT part of the selection lock', () => {
    // Unchanged in substance from the freeze this file used to assert: the switch is a different
    // control and a different product question (slice A4). It stays enabled exactly as it did.
    render(
      <ScopeOfWorkCard
        scopes={[scope({ rep_selected: true })]}
        {...scopeProps()}
        showOptionalToggle
        selectionsLocked
      />,
    );

    expect(screen.getByRole('switch', { name: 'Optional for scope 1' })).toBeEnabled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The real wiring, not just the leaf components.
//
// Both leaf suites above hand `rep_selected` straight to the component. In the app the editor
// reshapes every line through `toInvoiceLineShape` on the way to the table, so that step could
// silently drop the recommendation and leave every leaf test passing while the feature does
// nothing. These mount the real editors, and they are also where the status matrix lives: WHICH
// STATUSES leave the checkbox live is a question about the editor, the only thing that sees the
// estimate's status at all.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the estimate editor keeps the checkbox live until the customer signs', () => {
  const ESTIMATE_ID = 'est-live-1';

  function editorLine(over: Partial<EstimateLineItem> = {}): EstimateLineItem {
    return {
      id: 'l1',
      estimate_id: ESTIMATE_ID,
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
      ...over,
    };
  }

  const ability = buildAbility([{ action: 'update', subject: 'Estimate' }]);

  function mountEditor(status: string) {
    return renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{
          id: ESTIMATE_ID,
          status,
          total_amount: 100,
          invoices: [],
          // The rep recommended it; the customer has since unticked it.
          line_items: [editorLine({ is_selected: false, rep_selected: true })],
        }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability },
    );
  }

  // The status matrix, through the real editor rather than through a predicate helper. It
  // replaces the `isFrozenAtSend` unit test that stood here: that function is deleted outright by
  // this slice, and the question it answered - which statuses leave the rep's checkbox alone - is
  // better asked of the rendered control, which is what the rep actually meets. A recalled
  // estimate is covered by the DRAFT row: the predicate is the status, never `sent_at`.
  it.each(['DRAFT', 'SENT', 'PENDING'])('is interactive on a %s estimate', async (status) => {
    const { unmount } = mountEditor(status);
    const box = await screen.findByRole('checkbox', { name: 'Include Extended warranty' });
    expect(box).toBeEnabled();
    unmount();
  });

  it('is inert once the estimate is WON', async () => {
    mountEditor('WON');
    const box = await screen.findByRole('checkbox', { name: 'Include Extended warranty' });
    expect(box).toBeDisabled();
  });

  it('a SENT estimate reaches the row with the recommendation intact, and live', async () => {
    mountEditor('SENT');

    const box = await screen.findByRole('checkbox', { name: 'Include Extended warranty' });
    // The rep's own offer, not the customer's `is_selected: false`.
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
  });

  it('a DRAFT estimate with no recommendation yet reaches the row bound to is_selected', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{
          id: ESTIMATE_ID,
          status: 'DRAFT',
          total_amount: 100,
          invoices: [],
          line_items: [editorLine({ is_selected: false, rep_selected: null })],
        }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability },
    );

    const box = await screen.findByRole('checkbox', { name: 'Include Extended warranty' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
  });

  it('a SENT estimate\'s scope block reaches the card with the recommendation intact, and live', async () => {
    renderWithProviders(
      <EstimateScopeOfWorkCard
        estimate={{
          id: ESTIMATE_ID,
          status: 'SENT',
          invoices: [],
          // The rep is NOT recommending it; the customer has since ticked it on.
          scopes: [{
            id: 'scope-1',
            title: 'Permit filing',
            body: '',
            flat_price: 200,
            is_taxable: true,
            internal_cost: null,
            is_optional: true,
            is_selected: true,
            rep_selected: false,
          }],
        }}
        canManage
        canSeePricing
      />,
      { ability },
    );

    const box = await screen.findByRole('checkbox', { name: 'Include scope 1' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
  });
});
