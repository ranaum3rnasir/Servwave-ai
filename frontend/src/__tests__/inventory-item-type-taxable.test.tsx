// SRVW-90 - price-book item `type` + `taxable` on the two inventory surfaces.
//
// Contract under test:
//   - The Price Book Items table renders the billing Type (a read-only
//     projection of Kind) and the Taxable state.
//   - The Add/Edit Item dialog exposes Taxable, defaults it to true on create,
//     prefills it from the server row on edit, and round-trips false.
//   - Both mount points ship it: PriceBookPage (Price Book > Items) and
//     InventoryPage (Stock > Items). `type` is deliberately NOT sent - the
//     server derives it from `kind`.
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine -
// see purchase-orders-deeplink.test.tsx, the sanctioned pattern). The mock
// carries the UNION of the hooks both pages read.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import PriceBookPage from '@/pages/inventory/PriceBookPage';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

const h = vi.hoisted(() => ({
  MATERIAL_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
  SERVICE_ID: 'bbbbbbb1-0000-4000-8000-000000000002',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb1-0000-4000-8000-000000000009',
    ...p,
  })),
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  const base = {
    category: 'Hardware',
    trade: 'locksmith',
    uom: 'EA',
    unitCost: 20,
    sellPrice: 45,
    serialized: false,
    hazmat: false,
    trackInventory: false,
    status: 'active',
    vendor: 'Acme Supply',
    stock: [],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const items = [
    {
      ...base,
      id: h.MATERIAL_ID,
      sku: 'LOCK-100',
      name: 'Deadbolt',
      kind: 'material',
      type: 'MATERIAL',
      taxable: false,
    },
    {
      ...base,
      id: h.SERVICE_ID,
      sku: 'SRV-100',
      name: 'Call-out',
      kind: 'service',
      type: 'SERVICE',
      taxable: true,
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useBranches: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    // Paginated seam - InventoryPage reads `data.meta.total` for the Assets tile.
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    useLowStock: stable(EMPTY),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertLocation: mutation,
    useDeleteItem: mutation,
    useRestoreItem: mutation,
    useImportItemsCSV: mutation,
    useTransferStock: mutation,
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
  };
});

// Shortened in the 2026-08-12 dialog restructure: the parenthetical moved to
// the row's tooltip, so the flag labels are short and line up with each other.
const TAXABLE_LABEL = 'Taxable';
const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PriceBookPage Items table - Type + Taxable columns (SRVW-90)', () => {
  it('renders the billing type and the taxable state for each row', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
      ability: inventoryAbility(),
    });

    // Scoped per row - "Taxable" is also the column header.
    const materialRow = within((await screen.findByText('LOCK-100')).closest('tr')!);
    expect(materialRow.getByText('Material')).toBeInTheDocument();
    expect(materialRow.getByText('Not taxable')).toBeInTheDocument();

    const serviceRow = within(screen.getByText('SRV-100').closest('tr')!);
    expect(serviceRow.getByText('Service')).toBeInTheDocument();
    expect(serviceRow.getByText('Taxable')).toBeInTheDocument();
  });
});

describe('Add/Edit Item dialog ships taxable from both mount points (SRVW-90)', () => {
  it('PriceBookPage create with Kind=material ships kind material and taxable true', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
      ability: inventoryAbility(),
    });

    await userEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(screen.getByLabelText(/^SKU/), 'DEAD-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'material', taxable: true }),
    );
  });

  it('edit prefills Taxable from the server row and round-trips false', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
      ability: inventoryAbility(),
    });

    await userEvent.click(await screen.findByText('Deadbolt'));

    const taxable = await screen.findByLabelText(TAXABLE_LABEL);
    expect(taxable).toHaveAttribute('aria-checked', 'false');

    await userEvent.type(screen.getByPlaceholderText(NAME_PLACEHOLDER), ' Mk2');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: h.MATERIAL_ID, kind: 'material', taxable: false }),
    );
  });

  it('InventoryPage (Stock) create ships the same kind and taxable', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'Stock Deadbolt');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(screen.getByLabelText(/^SKU/), 'DEAD-2');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'material', taxable: true }),
    );
  });
});
