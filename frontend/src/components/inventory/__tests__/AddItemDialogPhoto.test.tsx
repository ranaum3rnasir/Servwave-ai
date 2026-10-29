/**
 * The catalog item dialog is the one surface that can SET or REPLACE any item's picture, and it
 * used to post the picked file inline, as a data URI, into the legacy column. Nothing that renders
 * an item to a customer reads that column — not the public estimate page, not the document
 * renderer — so the picture an operator chose here was invisible where it mattered.
 *
 * The dialog now hands the save path a FILE, which the write seam uploads to storage. What is
 * pinned here is the dialog's side of that contract:
 *   • a picked raster picture travels as a file, and never inline;
 *   • an untouched picture is not re-sent at all, so an ordinary field edit cannot move a stored
 *     picture back into the inline column;
 *   • clearing still clears;
 *   • a vector still rides inline, unrasterized (no upload path in this product stores one);
 *   • a failed pick says so, in copy an operator can act on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AddItemDialog, type NewItem } from '../AddItemDialog';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useLocations: stable([{ id: 'loc_1', name: 'Main Warehouse', type: 'warehouse', branchId: 'br_1' }]),
    useBranches: stable([{ id: 'br_1', name: 'HQ' }]),
    useFinishes: stable([]),
    useUpsertFinish: mutation,
    useUpsertBrand: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useDeleteFinish: mutation,
    useDeleteBrand: mutation,
    useDeleteCategory: mutation,
  };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { default_inventory_location_id: 'loc_1' }, isLoading: false }),
}));

const STORED_URL =
  'https://test.supabase.co/storage/v1/object/public/org-assets/org/price-book-items/itm_1/1-old.jpg';

const editItem = {
  id: 'itm_1',
  sku: 'LOCK-1',
  name: 'Lock',
  category: 'Locks',
  trade: 'locksmith',
  kind: 'material',
  uom: 'EA',
  sellPrice: 10,
  serialized: false,
  hazmat: false,
  status: 'active' as const,
  vendor: '',
  stock: [],
  updatedAt: '2026-01-01',
  photoUrl: STORED_URL,
};

function renderDialog(onSave: (item: NewItem, editId?: string) => unknown, overrides: Record<string, unknown> = {}) {
  return renderWithProviders(
    <AddItemDialog
      open
      onClose={vi.fn()}
      onSave={onSave}
      vendors={[]}
      onAddVendor={vi.fn()}
      categories={[]}
      onAddCategory={vi.fn()}
      brands={[]}
      {...overrides}
    />,
  );
}

// The dialog renders through a portal, so the file input is on document.body, not in the
// container the render helper returns.
function fileInput(): HTMLInputElement {
  const el = document.querySelector('input[type="file"]');
  if (!el) throw new Error('no file input');
  return el as HTMLInputElement;
}

function pick(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'lock.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddItemDialog — the picked picture goes to storage', () => {
  it('sends the picked raster picture as a file, with nothing inline', async () => {
    const onSave = vi.fn();
    renderDialog(onSave, { editItem });

    pick(fileInput(), jpeg());
    // The item already HAS a picture, so the preview is on screen from the first paint; wait on
    // the picked file's own name instead.
    await screen.findByText(/lock\.jpg/);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as NewItem;
    expect(payload.photoFile).toBeInstanceOf(File);
    expect(payload.photoUrl).toBeUndefined();
  });

  it('does not re-send a picture the operator never touched, so an ordinary field edit cannot move it back inline', async () => {
    const onSave = vi.fn();
    renderDialog(onSave, { editItem });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as NewItem;
    expect(payload.photoUrl).toBeUndefined();
    expect(payload.photoFile).toBeUndefined();
  });

  it('still clears a picture: an explicit null reaches the save path', async () => {
    const onSave = vi.fn();
    renderDialog(onSave, { editItem });

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as NewItem;
    expect(payload.photoUrl).toBeNull();
    expect(payload.photoFile).toBeUndefined();
  });

  it('keeps a vector inline and unrasterized — no upload path in this product stores one', async () => {
    const onSave = vi.fn();
    renderDialog(onSave, { editItem });

    pick(
      fileInput(),
      new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }),
    );
    await screen.findByText(/logo\.svg/);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as NewItem;
    expect(payload.photoFile).toBeUndefined();
    expect(String(payload.photoUrl).startsWith('data:image/svg+xml')).toBe(true);
  });

  it('still shows a picture that predates this change, and leaves it where it is', async () => {
    // The inline column is what every item picture used to live in, and catalog resolution still
    // reads it first. Opening the dialog on such an item must neither hide the picture nor
    // rewrite it.
    const onSave = vi.fn();
    const legacy = { ...editItem, photoUrl: 'data:image/png;base64,iVBORw0K' };
    renderDialog(onSave, { editItem: legacy });

    expect(screen.getByAltText('Item preview')).toHaveAttribute('src', legacy.photoUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as NewItem;
    expect(payload.photoUrl).toBeUndefined();
    expect(payload.photoFile).toBeUndefined();
  });

  it('says so when the pick cannot be prepared, instead of leaving the operator to assume it worked', async () => {
    const onSave = vi.fn();
    renderDialog(onSave, { editItem });

    pick(fileInput(), new File([new Uint8Array(1024)], 'IMG.heic', { type: 'image/heic' }));

    expect(await screen.findByText(/JPG or PNG/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
