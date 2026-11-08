/**
 * repro-2045.test.tsx — failing reproduction for #2045.
 *
 * "Upload a line-item image from the estimate: fill the catalog item's missing image, per-line
 * photos for ad-hoc lines" (Sales-Role QA row 002, Ran's decision 2026-09-10).
 *
 * Renders the SAME row component the estimate workspace uses (`LineItemRow` via
 * `EstimateLineItemsEditor.tsx`'s own `estimateLinesToInvoiceShape` normalizer — mirrors the real
 * integration point rather than hand-rolling a cast) for the three line shapes the acceptance
 * list names:
 *
 *  1. A linked line whose price-book item has NO image → today's `ProductThumb` placeholder
 *     (`frontend/src/components/jobs/items/ProductThumb.tsx:46-63`) is a plain inert `<div>` —
 *     no `+`/upload control exists anywhere. FAILS today.
 *  2. CONTROL — a linked line whose item already HAS an image → no `+` control should render.
 *     Vacuously true today (there is no `+` control in either case), but this pins the "already
 *     has an image → no second upload affordance" half of the acceptance list so a fix that adds
 *     the control everywhere, unconditionally, is caught.
 *  3. An ad-hoc line carrying an `EstimateLineItemPhoto` (`line.photos[]`) → the row should show
 *     that photo as its thumbnail. `LineItemRow.tsx:105` only ever reads
 *     `price_book_item?.image_url ?? price_book_item?.photo_url`, never `.photos` — confirmed by
 *     the file's own header comment (lines 24-27: "there is no per-line upload affordance
 *     anywhere on any surface"). FAILS today.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { estimateLinesToInvoiceShape } from '@/components/estimates/EstimateLineItemsEditor';
import type { EstimateLineItem } from '@/lib/api/estimates';

const ITEM_NO_IMAGE_ID = '7f000000-0000-0000-0000-000000002045';
const ITEM_WITH_IMAGE_ID = '7f000000-0000-0000-0000-000000002046';

const LINE_LINKED_NO_IMAGE: EstimateLineItem = {
  id: 'aa000000-0000-0000-0000-000000002045',
  estimate_id: 'f0000000-0000-0000-0000-000000002045',
  sequence: 1,
  description: 'qa-2045 AC unit',
  quantity: 1,
  unit_price: 1000,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 1000,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL',
  price_book_item_id: ITEM_NO_IMAGE_ID,
  price_book_item: { image_url: null },
};

const LINE_LINKED_WITH_IMAGE: EstimateLineItem = {
  ...LINE_LINKED_NO_IMAGE,
  id: 'aa000000-0000-0000-0000-000000002047',
  description: 'qa-2045 furnace',
  price_book_item_id: ITEM_WITH_IMAGE_ID,
  price_book_item: { image_url: 'https://cdn.example.com/qa-2045-item.png' },
};

const ADHOC_PHOTO_URL = 'https://cdn.example.com/qa-2045-adhoc-photo.png';

const LINE_ADHOC_WITH_PHOTO: EstimateLineItem = {
  id: 'aa000000-0000-0000-0000-000000002046',
  estimate_id: 'f0000000-0000-0000-0000-000000002045',
  sequence: 2,
  description: 'qa-2045 custom labor',
  quantity: 1,
  unit_price: 200,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 200,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
  photos: [
    {
      id: 'ee000000-0000-0000-0000-000000002045',
      url: ADHOC_PHOTO_URL,
      mime_type: 'image/jpeg',
      uploaded_at: '2026-09-10T00:00:00Z',
      uploaded_by: 'Test Sales',
    },
  ],
};

const ADD_IMAGE_CONTROL_NAME = /add image|upload image/i;

function renderRow(line: EstimateLineItem) {
  const [invoiceLine] = estimateLinesToInvoiceShape([line]);
  renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[invoiceLine.id]}>
            <LineItemRow
              line={invoiceLine}
              canEdit
              canManage
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

describe('#2045 — estimate line row image upload affordance', () => {
  it('a linked line whose item has no image renders an accessible "+" / upload control (absent today)', () => {
    renderRow(LINE_LINKED_NO_IMAGE);

    // FAILS TODAY: ProductThumb's empty-thumb placeholder is an inert <div> with no button and
    // no <input type="file"> anywhere in the row (ProductThumb.tsx:46-63).
    const addButton = screen.getByRole('button', { name: ADD_IMAGE_CONTROL_NAME });
    expect(addButton).toBeInTheDocument();
  });

  it('CONTROL (green today, vacuously): a linked line whose item already has an image renders NO "+" control', () => {
    renderRow(LINE_LINKED_WITH_IMAGE);

    expect(screen.queryByRole('button', { name: ADD_IMAGE_CONTROL_NAME })).not.toBeInTheDocument();
  });

  it('an ad-hoc line carrying an EstimateLineItemPhoto renders that photo as its thumbnail (absent today)', () => {
    renderRow(LINE_ADHOC_WITH_PHOTO);

    // FAILS TODAY: LineItemRow.tsx's `photo` variable is derived ONLY from
    // `price_book_item?.image_url ?? price_book_item?.photo_url` — it never reads `line.photos`,
    // so an ad-hoc line with a real EstimateLineItemPhoto still renders ProductThumb's empty
    // placeholder (no <img> for the line's name at all) instead of the photo.
    const thumb = screen.getByAltText('qa-2045 custom labor') as HTMLImageElement;
    expect(thumb.src).toBe(ADHOC_PHOTO_URL);
  });
});
