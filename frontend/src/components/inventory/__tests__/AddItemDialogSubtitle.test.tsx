/**
 * SRVW-228 - the add/edit item modal's edit-only subtitle.
 *
 * "Changes are versioned. Stock movements are immutable and are not
 * affected." was a reassurance nobody asked for, phrased in system terms, and
 * shown ONLY in edit mode - so the header grew by a line depending on how the
 * dialog was opened. This guards its removal in both modes and confirms the
 * header renders no subtitle line either way.
 *
 * Seam hooks mocked with the sanctioned stable-data pattern (see
 * inventory-finish-and-add-new-dropdowns.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AddItemDialog } from '../AddItemDialog';

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
};

function renderDialog(overrides: Record<string, unknown> = {}) {
  renderWithProviders(
    <AddItemDialog
      open
      onClose={vi.fn()}
      onSave={vi.fn()}
      vendors={[]}
      onAddVendor={vi.fn()}
      categories={[]}
      onAddCategory={vi.fn()}
      brands={[]}
      {...overrides}
    />,
  );
}

describe('AddItemDialog header - no versioning subtitle (SRVW-228)', () => {
  it('renders no subtitle text in create mode', () => {
    renderDialog();

    expect(screen.getByText('Add Item to Stock')).toBeInTheDocument();
    expect(screen.queryByText(/versioned/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stock movements are immutable/i)).not.toBeInTheDocument();
  });

  it('renders no subtitle text in edit mode either, so the header is the same shape in both modes', () => {
    renderDialog({ editItem });

    expect(screen.getByText('Edit Item · LOCK-1')).toBeInTheDocument();
    expect(screen.queryByText(/versioned/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stock movements are immutable/i)).not.toBeInTheDocument();
  });
});
