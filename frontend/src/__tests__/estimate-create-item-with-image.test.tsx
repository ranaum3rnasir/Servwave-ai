/**
 * Creating a catalog item from inside an estimate, WITH a picture.
 *
 * The "Save to price book" toggle on the add-line dialog's create form makes a reusable catalog
 * item out of what the operator just typed — name, type, selling price, taxable, and optionally
 * cost. There was no way to give it a picture, so the operator had to abandon the estimate, find
 * the item they had just made in the price book, and do the work a second time.
 *
 * Nothing new is built for this. The fill if empty endpoint already exists for exactly this case:
 * it lets someone who may edit an estimate, but does not hold the catalog write, give an
 * IMAGE-LESS item a picture from one of that estimate's lines. A just-created item is image-less
 * by definition. So the flow is create the item, add the line that links it, then post the picture
 * to that endpoint, naming the estimate.
 *
 * What this file pins, and why each one matters:
 *   • the create payload still carries no picture — the picture is a second request, to the
 *     endpoint that stores bytes, not a field on a JSON row;
 *   • the picture is posted to the FILL route with the estimate id supplied, never left to the
 *     broader fallback that route allows when no estimate is named, and never to the
 *     catalog-permission REPLACE sibling (which an operator in this flow may not hold);
 *   • the order is create -> add line -> upload, because the fill route requires the estimate to
 *     already carry a line pointed at the item;
 *   • a failed upload keeps the item AND the line, and says what happened — the item exists at
 *     that point, and silently discarding it (or silently swallowing the failure) is worse than
 *     either;
 *   • the picture is persisted on the catalog item and the estimate is refetched, so the seeded
 *     line renders it from the stored column and still renders it after a reload. No session-only
 *     overlay: that is the defect being removed elsewhere in this cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import { addEstimateLine, fillPriceBookItemImage } from '@/lib/api/estimates';
import { createPriceBookItem } from '@/lib/api/invoices';
import { toast } from '@/components/ui/use-toast';

vi.mock('@/lib/api/estimates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/estimates')>();
  return {
    ...actual,
    addEstimateLine: vi.fn(),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
    fillPriceBookItemImage: vi.fn(),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
    createPriceBookItem: vi.fn(),
  };
});

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const ESTIMATE_ID = 'e0000000-0000-0000-0000-0000000000s6';
const NEW_ITEM_ID = 'b0000000-0000-0000-0000-0000000000s6';
const NEW_LINE_ID = 'a0000000-0000-0000-0000-0000000000s6';
const STORED_URL =
  'https://test.supabase.co/storage/v1/object/public/org-assets/org/price-book-items/itm/1-deadbolt.png';

/** An operator who may edit this estimate. The catalog grant is the `canSaveToPriceBook` prop. */
const estimateEditor = () => buildAbility([{ action: 'update', subject: 'Estimate' }]);

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'deadbolt.png', {
    type: 'image/png',
  });

function renderEditor() {
  return renderWithProviders(
    <EstimateLineItemsEditor
      estimate={{ id: ESTIMATE_ID, line_items: [], total_amount: 0 }}
      canManage
      canSeePricing={false}
      canSaveToPriceBook
    />,
    { ability: estimateEditor() },
  );
}

/** The dialog renders through a portal, so its file input is on document.body. */
function pickPicture(file: File) {
  const input = screen.getByLabelText('Item picture') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

/** Header "Add item" -> type a name nothing matches -> "Add new item: <name>" -> the create form. */
async function openCreateForm(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /add item/i }));
  fireEvent.change(await screen.findByLabelText('Search the price book'), { target: { value: name } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Add new item: ${name}`) }));
  return screen.getByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  (addEstimateLine as ReturnType<typeof vi.fn>).mockResolvedValue({
    estimate: {
      id: ESTIMATE_ID,
      line_items: [
        {
          id: NEW_LINE_ID,
          sequence: 1,
          description: 'Deadbolt',
          quantity: 1,
          unit_price: 120,
          is_taxable: true,
          line_total: 120,
          item_type: 'MATERIAL',
          price_book_item_id: NEW_ITEM_ID,
          price_book_item: { image_url: null },
        },
      ],
    },
  });
  (createPriceBookItem as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: NEW_ITEM_ID,
    name: 'Deadbolt',
    type: 'MATERIAL',
    unit_price: 120,
    taxable: true,
  });
  (fillPriceBookItemImage as ReturnType<typeof vi.fn>).mockResolvedValue({
    item: { id: NEW_ITEM_ID, image_url: STORED_URL },
  });
});

describe('Creating a catalog item from inside an estimate accepts a picture', () => {
  it('creates the item, adds the line, then posts the picture to the fill route naming the estimate', async () => {
    const { queryClient } = renderEditor();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const dialog = await openCreateForm('Deadbolt');
    fireEvent.change(within(dialog).getByLabelText('Price ($)'), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByLabelText('Save to price book'));
    pickPicture(png());
    await screen.findByText(/deadbolt\.png/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add item$/ }));

    await waitFor(() => expect(fillPriceBookItemImage).toHaveBeenCalled());

    // The create payload is unchanged: no picture rides on it.
    const created = (createPriceBookItem as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(created).toMatchObject({ name: 'Deadbolt', type: 'MATERIAL', unit_price: 120, taxable: true });
    expect(Object.keys(created as object).some((k) => /image|photo|picture/i.test(k))).toBe(false);

    // The line links the item the create just returned...
    expect(addEstimateLine).toHaveBeenCalledWith(
      ESTIMATE_ID,
      expect.objectContaining({ price_book_item_id: NEW_ITEM_ID }),
    );
    // ...and only THEN does the picture go up, because the fill route requires the estimate to
    // already carry a line pointed at the item.
    expect((addEstimateLine as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (fillPriceBookItemImage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );

    // The estimate id is SUPPLIED, not left to the route's no-estimate fallback.
    const [itemId, file, estimateId] = (fillPriceBookItemImage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(itemId).toBe(NEW_ITEM_ID);
    expect(file).toBeInstanceOf(File);
    expect(estimateId).toBe(ESTIMATE_ID);

    // The picture is persisted on the catalog item, and the estimate is refetched so the seeded
    // line reads it from the stored column — which is what makes it survive a reload.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['estimate', ESTIMATE_ID] })),
    );
  });

  it('keeps the item and the line when the picture fails, and says what happened', async () => {
    (fillPriceBookItemImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to upload file'),
    );
    renderEditor();

    const dialog = await openCreateForm('Deadbolt');
    fireEvent.change(within(dialog).getByLabelText('Price ($)'), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByLabelText('Save to price book'));
    pickPicture(png());
    await screen.findByText(/deadbolt\.png/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add item$/ }));

    await waitFor(() => expect(toast).toHaveBeenCalled());

    // Nothing is unwound: the catalog item and the line both stand.
    expect(createPriceBookItem).toHaveBeenCalledTimes(1);
    expect(addEstimateLine).toHaveBeenCalledTimes(1);

    // And the operator is told, in copy that names what survived and where to finish the job.
    const shown = (toast as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      title: string;
      description?: string;
      variant?: string;
    };
    expect(shown.variant).toBe('destructive');
    expect(`${shown.title} ${shown.description ?? ''}`).toMatch(/added to the estimate/i);
    expect(`${shown.title} ${shown.description ?? ''}`).toMatch(/from the line/i);
  });

  it('still creates an item with no picture at all, and uploads nothing', async () => {
    renderEditor();

    const dialog = await openCreateForm('Deadbolt');
    fireEvent.change(within(dialog).getByLabelText('Price ($)'), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByLabelText('Save to price book'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add item$/ }));

    await waitFor(() => expect(addEstimateLine).toHaveBeenCalled());
    expect(createPriceBookItem).toHaveBeenCalledTimes(1);
    expect(fillPriceBookItemImage).not.toHaveBeenCalled();
    // The line renders with no picture, so the shared neutral placeholder is what shows.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
