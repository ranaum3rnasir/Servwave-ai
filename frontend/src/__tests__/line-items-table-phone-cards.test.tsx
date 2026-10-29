/**
 * Mobile slice 59 (PRD story 127, rubric CMP-01 / TOUCH-10) - the shared line-items editor on a
 * phone.
 *
 * Below md the 1,040 px table renders each line as an editable card, and Move up / Move down sit
 * beside the drag handle. From md up the table is exactly what it was. The layout is JS-chosen
 * (useIsBelow), so ONE variant mounts: these queries match exactly one node each, which a CSS
 * `md:hidden` dual render could not give.
 *
 * jsdom answers every media query `false` (the desktop table); the phone describe block answers
 * the md max-width query `true`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  LineItemsTable,
  resolveFlatDragReorder,
  resolveDragReorder,
  resolveMoveReorder,
} from '@/components/jobs/items/LineItemsTable';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { renderWithProviders as render } from './helpers';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

function line(over: Partial<InvoiceLineItem> & { id: string }): InvoiceLineItem {
  return {
    sequence: 1,
    description: 'Base line',
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

const THREE = [
  line({ id: 'a', description: 'Service call', unit_price: 180, line_total: 180 }),
  line({ id: 'b', description: 'Replacement part', quantity: 2, unit_price: 65, line_total: 130, unit_cost: 40 }),
  line({ id: 'c', description: 'Disposal fee', unit_price: 25, line_total: 25 }),
];

function baseProps(lines: InvoiceLineItem[]) {
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

const originalMatchMedia = window.matchMedia;

function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('resolveMoveReorder - Move up / Move down persist what a drag would', () => {
  it('flat: moving a line down by one is the very list a drag onto its neighbour returns', () => {
    for (const [id, neighbour, dir] of [
      ['a', 'b', 'down'],
      ['b', 'c', 'down'],
      ['b', 'a', 'up'],
      ['c', 'b', 'up'],
    ] as const) {
      const drag = resolveFlatDragReorder(THREE, { active: { id }, over: { id: neighbour } });
      expect(resolveMoveReorder(THREE, id, dir, false), `${id} ${dir}`).toEqual(drag);
    }
    expect(resolveMoveReorder(THREE, 'a', 'down', false)).toEqual(['b', 'a', 'c']);
  });

  it('flat: the first line cannot go up and the last line cannot go down (null, nothing to persist)', () => {
    expect(resolveMoveReorder(THREE, 'a', 'up', false)).toBeNull();
    expect(resolveMoveReorder(THREE, 'c', 'down', false)).toBeNull();
    expect(resolveMoveReorder(THREE, 'missing', 'down', false)).toBeNull();
  });

  it('grouped: a move stays inside its Material/Service group and returns the full list, like a drag', () => {
    const grouped = [
      line({ id: 's1', item_type: 'SERVICE' }),
      line({ id: 'm1', item_type: 'MATERIAL' }),
      line({ id: 's2', item_type: 'SERVICE' }),
    ];
    const drag = resolveDragReorder(grouped, { active: { id: 's1' }, over: { id: 's2' } });
    expect(resolveMoveReorder(grouped, 's1', 'down', true)).toEqual(drag);
    expect(resolveMoveReorder(grouped, 's1', 'down', true)).toEqual(['s2', 'm1', 's1']);
    // m1 is alone in its group: nowhere to go either way.
    expect(resolveMoveReorder(grouped, 'm1', 'up', true)).toBeNull();
    expect(resolveMoveReorder(grouped, 'm1', 'down', true)).toBeNull();
  });
});

describe('LineItemsTable - phone cards (below md)', () => {
  beforeEach(() => answerMedia((q) => q === MEDIA.belowMd));
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders one editable card per line and no table', () => {
    render(<LineItemsTable {...baseProps(THREE)} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = screen.getAllByTestId('line-item-card');
    expect(cards).toHaveLength(3);
    // Each field is named once, in its own card.
    expect(within(cards[1]!).getByRole('textbox', { name: 'Quantity for Replacement part' })).toHaveValue('2');
    expect(within(cards[1]!).getByRole('textbox', { name: 'Cost for Replacement part' })).toHaveValue('40');
    expect(within(cards[1]!).getByRole('textbox', { name: 'Selling price for Replacement part' })).toHaveValue('65');
    expect(within(cards[1]!).getByRole('switch', { name: 'Taxable for Replacement part' })).toBeChecked();
    expect(within(cards[1]!).getByText('$130.00')).toBeInTheDocument();
  });

  it('editing a field in a card saves it through the same callback the table row uses', async () => {
    const props = baseProps(THREE);
    render(<LineItemsTable {...props} />);

    const qty = screen.getByRole('textbox', { name: 'Quantity for Service call' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    await userEvent.tab();
    expect(props.onUpdate).toHaveBeenCalledWith('a', { quantity: 3 });

    await userEvent.click(screen.getByRole('switch', { name: 'Taxable for Service call' }));
    expect(props.onUpdate).toHaveBeenCalledWith('a', { is_taxable: false });
  });

  it('the card opens the shared edit dialog and removes through the confirm, like the row', async () => {
    const props = baseProps(THREE);
    render(<LineItemsTable {...props} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit Disposal fee' }));
    expect(props.onEditingLineChange).toHaveBeenCalledWith(THREE[2]);

    await userEvent.click(screen.getByRole('button', { name: 'Remove Disposal fee' }));
    await userEvent.click(await screen.findByRole('button', { name: /^(remove|delete|confirm)/i }));
    expect(props.onDelete).toHaveBeenCalledWith('c');
  });

  it('Move up / Move down sit with the drag handle and persist the order a drag would', async () => {
    const props = baseProps(THREE);
    render(<LineItemsTable {...props} />);

    const first = screen.getAllByTestId('line-item-card')[0]!;
    expect(within(first).getByRole('button', { name: 'Drag to reorder Service call' })).toBeInTheDocument();
    await userEvent.click(within(first).getByRole('button', { name: 'Move Service call down' }));
    expect(props.onReorder).toHaveBeenLastCalledWith(
      resolveFlatDragReorder(THREE, { active: { id: 'a' }, over: { id: 'b' } }),
    );
    expect(props.onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c']);

    const last = screen.getAllByTestId('line-item-card')[2]!;
    await userEvent.click(within(last).getByRole('button', { name: 'Move Disposal fee up' }));
    expect(props.onReorder).toHaveBeenLastCalledWith(['a', 'c', 'b']);
  });

  it('the first card cannot move up, the last cannot move down, and a busy editor moves nothing', () => {
    const { unmount } = render(<LineItemsTable {...baseProps(THREE)} />);
    expect(screen.getByRole('button', { name: 'Move Service call up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Service call down' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Disposal fee down' })).toBeDisabled();
    unmount();

    render(<LineItemsTable {...baseProps(THREE)} busy />);
    expect(screen.getByRole('button', { name: 'Move Replacement part up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Replacement part down' })).toBeDisabled();
  });

  it('a viewer who cannot manage rows gets no handle, no Move buttons and no Remove', () => {
    render(<LineItemsTable {...baseProps(THREE)} canManageRows={false} />);
    expect(screen.queryByRole('button', { name: /Drag to reorder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('line-item-card')).toHaveLength(3);
  });

  it('a read-only viewer sees the figures as text, with no inputs', () => {
    render(<LineItemsTable {...baseProps(THREE)} canManageRows={false} canEditRows={false} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    const cards = screen.getAllByTestId('line-item-card');
    expect(within(cards[0]!).getByText('Service call')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('$180.00', { selector: '[data-testid="line-card-total"]' })).toBeInTheDocument();
  });

  it('the cost field is absent without the pricing grant, as the Cost column is', () => {
    render(<LineItemsTable {...baseProps(THREE)} canSeePricing={false} />);
    expect(screen.queryByRole('textbox', { name: /^Cost for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Selling price for Service call' })).toBeInTheDocument();
  });

  it('an estimate card keeps its Optional tag and Include checkbox', async () => {
    const props = baseProps([line({ id: 'o', description: 'Add-on', is_optional: true, is_selected: false })]);
    render(<LineItemsTable {...props} showOptionalToggle />);
    expect(screen.getByText('Optional')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Add-on' }));
    expect(props.onUpdate).toHaveBeenCalledWith('o', { is_selected: true });
  });

  it('shows the empty state, not an empty list, when there are no lines', () => {
    render(<LineItemsTable {...baseProps([])} />);
    expect(screen.getByText('No line items yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('line-item-card')).not.toBeInTheDocument();
  });
});

describe('LineItemsTable - desktop (md and up) is unchanged', () => {
  it('renders the table with its drag handles and no cards and no Move buttons', () => {
    render(<LineItemsTable {...baseProps(THREE)} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByTestId('line-item-row')).toHaveLength(3);
    expect(screen.queryByTestId('line-item-card')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag to reorder Service call' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).not.toBeInTheDocument();
  });
});
