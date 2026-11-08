/**
 * #2012 follow-on (visual finding F1) — the row became a tab stop (canEdit) but shipped with only
 * the browser's default focus outline. This asserts the design-system focus-visible ring class is
 * present on the focusable row and absent on a read-only (non-tab-stop) row. Mirrors the DndContext/
 * SortableContext nesting `repro-2012.test.tsx`'s renderRow helper uses (LineItemsTable.tsx's real
 * structure) without touching that frozen file.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import type { InvoiceLineItem } from '@/lib/api/jobs';

const LINE: InvoiceLineItem = {
  id: 'line-2012-focus',
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

function renderRow(canEdit: boolean) {
  renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[LINE.id]}>
            <LineItemRow
              line={LINE}
              canEdit={canEdit}
              canManage={canEdit}
              canSeePricing
              onUpdate={vi.fn()}
              onDelete={vi.fn()}
              onEdit={vi.fn()}
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
}

describe('#2012 (visual F1) — focus-visible ring on the focusable row only', () => {
  it('a focusable row (canEdit) carries the design-system focus-visible ring classes', () => {
    renderRow(true);
    const row = screen.getByTestId('line-item-row');

    expect(row).toHaveAttribute('tabIndex', '0');
    expect(row.className).toContain('focus-visible:ring-2');
    expect(row.className).toContain('focus-visible:ring-primary');
  });

  it('a read-only row (canEdit=false) is not a tab stop and carries no focus-visible ring class', () => {
    renderRow(false);
    const row = screen.getByTestId('line-item-row');

    expect(row).not.toHaveAttribute('tabIndex');
    expect(row.className).not.toContain('focus-visible:ring');
  });
});

// ─── #2045 — the "+" upload affordance ─────────────────────────────────────────────────────────
const ADD_IMAGE_NAME = 'Add image';

const BASE_LINE_FIELDS = {
  sequence: 1,
  quantity: 1,
  unit_price: 100,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 100,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL' as const,
};

function renderLine(line: InvoiceLineItem, opts: { canEdit?: boolean; onEdit?: () => void } = {}) {
  const canEdit = opts.canEdit ?? true;
  const onEdit = opts.onEdit ?? vi.fn();
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
              onEdit={onEdit}
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
  return { onEdit };
}

describe('#2045 — the "+" upload affordance across line shapes', () => {
  it('renders for a linked, editable estimate line whose item has no image', () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-linked-no-image',
      description: 'Linked, no image',
      price_book_item_id: 'item-2045-1',
      price_book_item: { image_url: null, photo_url: null },
      estimate_id: 'est-2045',
    });
    expect(screen.getByRole('button', { name: ADD_IMAGE_NAME })).toBeInTheDocument();
  });

  it('does NOT render for a linked line whose item already has an image', () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-linked-with-image',
      description: 'Linked, has image',
      price_book_item_id: 'item-2045-2',
      price_book_item: { image_url: 'https://cdn.example.com/qa-2045-item.png', photo_url: null },
      estimate_id: 'est-2045',
    });
    expect(screen.queryByRole('button', { name: ADD_IMAGE_NAME })).not.toBeInTheDocument();
  });

  // #2029 retired the per-line-item upload path (Ran, directly: a line item's image is an
  // attribute of the stock/price-book item, and that is all). The "+" fills the CATALOG item's
  // image, so a line with no catalog item has no destination for it and is offered nothing.
  it('does NOT render for an ad-hoc estimate line — no catalog item to fill (#2029)', () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-adhoc-no-photo',
      description: 'Ad hoc, no photo',
      price_book_item_id: null,
      estimate_id: 'est-2045',
    });
    expect(screen.queryByRole('button', { name: ADD_IMAGE_NAME })).not.toBeInTheDocument();
  });

  it('does NOT render for an ad-hoc line that already carries a photo — no second upload affordance', () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-adhoc-with-photo',
      description: 'Ad hoc, has photo',
      price_book_item_id: null,
      estimate_id: 'est-2045',
      photos: [{ id: 'photo-2045-1', url: 'https://cdn.example.com/qa-2045-adhoc.png', mime_type: 'image/png' }],
    });
    expect(screen.queryByRole('button', { name: ADD_IMAGE_NAME })).not.toBeInTheDocument();
  });

  it('never renders on a Job/Invoice-shaped line (no estimate_id), even when image-less and editable', () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-job-shaped',
      description: 'Job line, no estimate_id',
      price_book_item_id: 'item-2045-3',
      price_book_item: { image_url: null, photo_url: null },
      // No estimate_id — Job/Invoice lines never carry one.
    });
    expect(screen.queryByRole('button', { name: ADD_IMAGE_NAME })).not.toBeInTheDocument();
  });

  it('never renders on a read-only row (canEdit=false), even for an image-less linked estimate line', () => {
    renderLine(
      {
        ...BASE_LINE_FIELDS,
        id: 'row-2045-readonly',
        description: 'Read-only, no image',
        price_book_item_id: 'item-2045-4',
        price_book_item: { image_url: null, photo_url: null },
        estimate_id: 'est-2045',
      },
      { canEdit: false },
    );
    expect(screen.queryByRole('button', { name: ADD_IMAGE_NAME })).not.toBeInTheDocument();
  });

  it('clicking "+" does not open the row edit dialog (R10a)', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-click',
      description: 'Click test',
      price_book_item_id: 'item-2045-5',
      price_book_item: { image_url: null, photo_url: null },
      estimate_id: 'est-2045',
    });

    await user.click(screen.getByRole('button', { name: ADD_IMAGE_NAME }));

    expect(onEdit).not.toHaveBeenCalled();
  });

  it("line.photos[0].url drives the row's thumbnail for an ad-hoc line that already has a photo", () => {
    renderLine({
      ...BASE_LINE_FIELDS,
      id: 'row-2045-photo-thumb',
      description: 'Ad hoc photo thumb',
      price_book_item_id: null,
      estimate_id: 'est-2045',
      photos: [{ id: 'photo-2045-2', url: 'https://cdn.example.com/qa-2045-thumb.png', mime_type: 'image/png' }],
    });

    const img = screen.getByAltText('Ad hoc photo thumb') as HTMLImageElement;
    expect(img.src).toBe('https://cdn.example.com/qa-2045-thumb.png');
  });
});
