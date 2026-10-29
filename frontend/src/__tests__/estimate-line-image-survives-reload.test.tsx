/**
 * An estimate line's item image has to come from the server, and it has to still be there after
 * a reload.
 *
 * The thumbnail an operator saw after an upload was not the item's stored image at all: it was a
 * client-side override (`clientImageOverrides`) held in component state for the session, layered
 * on by `EstimateLineItemsEditor`'s `toInvoiceLineShape`. It vanished on reload, which is why the
 * defect presented as intermittent rather than total. Underneath it, the real path was broken in
 * two places at once, and the override is what masked them:
 *
 *   1. `estimateDetailSelect` asked for only ONE of the item's two image columns, so an image
 *      stored in the other was never on the wire (pinned server-side by
 *      `backend/src/__tests__/estimate-line-item-image.test.ts`).
 *   2. `toInvoiceLineShape` then read that one column by name and copied it into BOTH columns of
 *      the row's shape, so even once the data arrived the row could only ever see that one.
 *
 * A reload is a fresh mount against the same server payload with no session state carried over,
 * which is exactly what the remount below is. The first assertion fails on the unfixed code
 * because the server payload's image lives in the column the editor did not read; the remount is
 * what proves the answer is server data and not something the component is remembering.
 *
 * The lines here are shaped like a REAL `estimateDetailSelect` row (no `estimate_id` key), the
 * same discipline `estimate-line-items-editor-add-image.test.tsx` established — a hand-built
 * `InvoiceLineItem` would not have caught either half of this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { buildAbility } from '@/lib/ability';
import type { EstimateLineItem } from '@/lib/api/estimates';
import type { InvoiceLineItem } from '@/lib/api/jobs';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    addEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return { ...actual, searchPriceBookItems: vi.fn().mockResolvedValue([]) };
});

const ESTIMATE_ID = 'est-line-image-reload';
const LINE_DESCRIPTION = 'Catalog part';

/** The column the catalog dialog writes a picked picture into. */
const STORED_IMAGE = 'data:image/png;base64,STORED';
/** The other column — URL-validated and short. */
const OTHER_COLUMN_IMAGE = 'https://cdn.example.com/other-column.png';

function apiShapedLine(priceBookItem: Record<string, unknown>): EstimateLineItem {
  return {
    id: 'line-image-reload-1',
    sequence: 1,
    description: LINE_DESCRIPTION,
    quantity: 1,
    unit_price: 500,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 500,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: 'item-image-reload',
    price_book_item: priceBookItem,
  } as unknown as EstimateLineItem;
}

const adminAbility = () => buildAbility([{ action: 'update', subject: 'Estimate' }]);

function renderEditor(line: EstimateLineItem) {
  return renderWithProviders(
    <EstimateLineItemsEditor
      estimate={{ id: ESTIMATE_ID, line_items: [line], total_amount: 500 }}
      canManage
      canSeePricing={false}
      canSaveToPriceBook={false}
    />,
    { ability: adminAbility() },
  );
}

/** The `<img>` the row's thumbnail renders, by the alt text ProductThumb gives it. */
function thumbnailSrc(): string | null {
  return screen.getByAltText(LINE_DESCRIPTION).getAttribute('src');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('an estimate line renders the item image the server stored, across a reload', () => {
  it('renders an image stored in the column the catalog dialog writes', async () => {
    renderEditor(apiShapedLine({ image_url: null, photo_url: STORED_IMAGE }));

    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    expect(thumbnailSrc()).toBe(STORED_IMAGE);
  });

  it('still renders it after a full reload — a fresh mount holding no session state', async () => {
    const first = renderEditor(apiShapedLine({ image_url: null, photo_url: STORED_IMAGE }));
    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    const beforeReload = thumbnailSrc();

    // The reload: everything the component was holding is discarded, and the SAME server payload
    // is rendered again from scratch.
    first.unmount();
    renderEditor(apiShapedLine({ image_url: null, photo_url: STORED_IMAGE }));

    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    expect(thumbnailSrc()).toBe(beforeReload);
    expect(thumbnailSrc()).toBe(STORED_IMAGE);
  });

  it('renders an image stored in the other column just the same', async () => {
    renderEditor(apiShapedLine({ image_url: OTHER_COLUMN_IMAGE, photo_url: null }));

    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    expect(thumbnailSrc()).toBe(OTHER_COLUMN_IMAGE);
  });

  it('when both columns are populated, renders the one the shared resolution picks', async () => {
    renderEditor(apiShapedLine({ image_url: OTHER_COLUMN_IMAGE, photo_url: STORED_IMAGE }));

    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    // Same answer the server-side resolver gives (backend/src/lib/catalog/item-resolution.ts's
    // resolveItemImage) — the two used to disagree, each reading the opposite column first, so an
    // item with both populated rendered a different picture on the row than anywhere else.
    expect(thumbnailSrc()).toBe(STORED_IMAGE);
  });
});

/**
 * The same catalog item, rendered on a job line and on an invoice line — both go through the
 * shared `<LineItemRow>`, which is the third consumer of the one resolution. Neither carries an
 * `estimate_id`, which is exactly how the row tells a job/invoice line from an estimate one.
 */
function renderSharedRow(line: InvoiceLineItem) {
  return renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[line.id]}>
            <LineItemRow
              line={line}
              canEdit
              canManage
              canSeePricing={false}
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

function sharedRowLine(over: Record<string, unknown>): InvoiceLineItem {
  return {
    id: 'shared-row-line-1',
    sequence: 1,
    description: LINE_DESCRIPTION,
    quantity: 1,
    unit_price: 500,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 500,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: 'item-image-reload',
    ...over,
  } as unknown as InvoiceLineItem;
}

describe('one item, one image, on all three line surfaces', () => {
  it('a job line and an invoice line render the SAME image as the estimate line', async () => {
    const priceBookItem = { image_url: null, photo_url: STORED_IMAGE };

    const estimate = renderEditor(apiShapedLine(priceBookItem));
    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    const onTheEstimate = thumbnailSrc();
    estimate.unmount();

    // A job line: same relation, no estimate_id.
    const job = renderSharedRow(sharedRowLine({ job_id: 'job-1', price_book_item: priceBookItem }));
    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    const onTheJob = thumbnailSrc();
    job.unmount();

    // An invoice line: same again.
    renderSharedRow(sharedRowLine({ invoice_id: 'inv-1', price_book_item: priceBookItem }));
    expect(await screen.findByAltText(LINE_DESCRIPTION)).toBeInTheDocument();
    const onTheInvoice = thumbnailSrc();

    expect(onTheEstimate).toBe(STORED_IMAGE);
    expect(onTheJob).toBe(onTheEstimate);
    expect(onTheInvoice).toBe(onTheEstimate);
  });
});
