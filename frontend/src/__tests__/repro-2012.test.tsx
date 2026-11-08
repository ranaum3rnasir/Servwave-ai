/**
 * Repro for #2012 — three independent line-item defects on the shared
 * LineItemRow/AddLineDialog components (Job/Invoice/Estimate all render these):
 *
 * (a) A line row's ONLY way to open edit is the pencil icon — the `<tr>` itself carries no
 *     onClick/onKeyDown (LineItemRow.tsx:164-170), so clicking anywhere on a row (the natural
 *     "click a table row to edit it" affordance) or pressing Enter while it's focused does
 *     nothing.
 *
 * (b) Adding a line FROM the price book drops the catalog item's cost: the `selected` branch's
 *     payload (AddLineDialog.tsx:569-577) ships description/item_type/quantity/unit_price/
 *     is_taxable/price_book_item_id only — `selected.unit_cost` is never read. And the EDIT
 *     form's Markup % field (AddLineDialog.tsx:722-732) reads `editingLine.markup_percent`
 *     verbatim: when that column is null (as it now always is for a price-book-added line) it
 *     renders blank with a "0" placeholder instead of the markup DERIVED from the line's own
 *     cost/price, which is what LineTotalBar's live margin readout already computes and shows
 *     as a real, non-zero percentage right next to it.
 *
 * (c) The edit form (AddLineDialog.tsx:691-766) has no Type select at all — only the create
 *     form does (AddLineDialog.tsx:971-983) — so a line's Material/Service type can never be
 *     corrected after it's added.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import * as invoicesApi from '@/lib/api/invoices';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

// ─────────────────────────────────────────────────────────────────────────
// (a) — row click / Enter must open edit; delete + read-only rows stay inert
// ─────────────────────────────────────────────────────────────────────────

const BASE_LINE: InvoiceLineItem = {
  id: 'line-2012',
  sequence: 1,
  description: 'Compressor swap',
  quantity: 2,
  unit_price: 150,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 300,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function renderRow(overrides: {
  line?: Partial<InvoiceLineItem>;
  canEdit?: boolean;
  canManage?: boolean;
  onEdit?: () => void;
} = {}) {
  const line: InvoiceLineItem = { ...BASE_LINE, ...overrides.line };
  const onEdit = overrides.onEdit ?? vi.fn();
  renderWithProviders(
    // Mirrors LineItemsTable.tsx's real nesting: DndContext wraps the <table>, SortableContext
    // wraps the <tbody> rows — putting DndContext INSIDE <tbody> (as an earlier draft of this
    // harness did) triggers a spurious jsdom "<div> cannot be a child of <tbody>" warning from
    // dnd-kit's own hidden a11y announcer div, unrelated to the bug under test.
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[line.id]}>
            <LineItemRow
              line={line}
              canEdit={overrides.canEdit ?? true}
              canManage={overrides.canManage ?? true}
              canSeePricing
              onUpdate={vi.fn()}
              onDelete={vi.fn()}
              onEdit={onEdit}
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
  return { onEdit, line };
}

describe('#2012(a) — a line row must be clickable to edit it, not only via the pencil icon', () => {
  it('clicking the description cell of a non-read-only row calls onEdit with that line', async () => {
    const { onEdit, line } = renderRow();

    await userEvent.click(screen.getByText('Compressor swap'));

    expect(
      onEdit,
      'clicking the row body did nothing — only the pencil Edit button opens the dialog today',
    ).toHaveBeenCalledTimes(1);
    void line;
  });

  it('pressing Enter while the row is focused also calls onEdit', () => {
    const { onEdit } = renderRow();
    const row = screen.getByTestId('line-item-row');

    fireEvent.keyDown(row, { key: 'Enter' });

    expect(
      onEdit,
      'Enter on the focused row did nothing — the <tr> has no onKeyDown handler',
    ).toHaveBeenCalledTimes(1);
  });

  it('clicking the delete (trash) control does NOT also open edit', async () => {
    const { onEdit } = renderRow();

    await userEvent.click(screen.getByRole('button', { name: /remove compressor swap/i }));

    expect(onEdit, 'clicking delete must not also fire the row-click edit handler').not.toHaveBeenCalled();
  });

  it('a read-only row (canEdit=false) stays inert on click', async () => {
    const { onEdit } = renderRow({ canEdit: false, canManage: false });

    await userEvent.click(screen.getByText('Compressor swap'));

    expect(onEdit, 'a read-only row must not open the edit dialog').not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) — price-book adds must carry cost; the edit form must show derived markup
// ─────────────────────────────────────────────────────────────────────────

const PB_ITEM: invoicesApi.PriceBookItem = {
  id: 'pb-2012',
  name: 'qa-2012 Catalog Item',
  description: null,
  image_url: null,
  type: 'SERVICE',
  unit_cost: 40,
  unit_price: 178,
  taxable: true,
  category: null,
};

describe('#2012(b) — price-book adds must carry cost, and the edit form must show DERIVED markup, not a placeholder 0', () => {
  it('selecting a price-book item (unit_cost 40 / unit_price 178) produces a create payload carrying unit_cost: 40', async () => {
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PB_ITEM]);
    const onAdd = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<AddLineDialog open onOpenChange={() => {}} onAdd={onAdd} canSeePricing />);

    await userEvent.type(screen.getByLabelText('Search the price book'), 'qa-2012');
    await waitFor(() => expect(screen.getByText('qa-2012 Catalog Item')).toBeInTheDocument());
    await userEvent.click(screen.getByText('qa-2012 Catalog Item'));

    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    const payload = onAdd.mock.calls[0][0];
    expect(
      payload.unit_cost,
      `create payload for a price-book add must carry the catalog item's unit_cost (40); got ${JSON.stringify(payload)}`,
    ).toBe(40);
  });

  it('edit form: unit_cost 40 / unit_price 178 / markup_percent null shows a DERIVED Markup % of 345, not blank with placeholder 0', () => {
    const editingLine: InvoiceLineItem = {
      ...BASE_LINE,
      id: 'line-derived-markup',
      unit_cost: 40,
      unit_price: 178,
      markup_percent: null,
    };

    renderWithProviders(
      <AddLineDialog open onOpenChange={() => {}} onAdd={vi.fn()} editingLine={editingLine} canSeePricing />,
    );

    const markupInput = screen.getByLabelText('Markup %') as HTMLInputElement;
    // (178 - 40) / 40 * 100 = 345 — the same derivation LineTotalBar already uses to show a real
    // margin % right next to this field, instead of the contradictory "0" the field shows today.
    expect(
      markupInput.value,
      `Markup % must show the derived value 345 when markup_percent is null but cost/price are known; got "${markupInput.value}"`,
    ).toBe('345');
  });

  it('edit form: a line with a stored markup of 30 shows 30 (not re-derived) and saving untouched sends no markup change', async () => {
    const editingLine: InvoiceLineItem = {
      ...BASE_LINE,
      id: 'line-stored-markup',
      unit_cost: 40,
      unit_price: 178,
      markup_percent: 30,
    };
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <AddLineDialog
        open
        onOpenChange={() => {}}
        onAdd={vi.fn()}
        editingLine={editingLine}
        onUpdate={onUpdate}
        canSeePricing
      />,
    );

    const markupInput = screen.getByLabelText('Markup %') as HTMLInputElement;
    expect(markupInput.value, `a stored markup of 30 must render as-is, not re-derived; got "${markupInput.value}"`).toBe(
      '30',
    );

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const patch = onUpdate.mock.calls[0][1];
    expect(patch.markup_percent, 'saving an untouched markup field must not send a markup_percent change').toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) — the edit form has no Type select
// ─────────────────────────────────────────────────────────────────────────

describe('#2012(c) — the edit form must offer a Type select, matching the create form', () => {
  it('renders a Type select in edit mode and saving a change from SERVICE to MATERIAL submits item_type: "MATERIAL"', async () => {
    const editingLine: InvoiceLineItem = {
      ...BASE_LINE,
      id: 'line-type-edit',
      item_type: 'SERVICE',
    };
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <AddLineDialog
        open
        onOpenChange={() => {}}
        onAdd={vi.fn()}
        editingLine={editingLine}
        onUpdate={onUpdate}
        canSeePricing
      />,
    );

    const dialog = within(screen.getByRole('dialog', { name: /edit line item/i }));
    const typeSelect = dialog.queryByLabelText(/^type$/i) ?? dialog.queryByLabelText(/item type/i);
    expect(typeSelect, 'the edit form has no Type select — only the create form does').not.toBeNull();

    await userEvent.click(typeSelect as HTMLElement);
    await userEvent.click(await screen.findByRole('option', { name: /^material$/i }));

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const patch = onUpdate.mock.calls[0][1];
    expect(patch.item_type, 'saving a Type change on the edit form must submit item_type: "MATERIAL"').toBe('MATERIAL');
  });
});
