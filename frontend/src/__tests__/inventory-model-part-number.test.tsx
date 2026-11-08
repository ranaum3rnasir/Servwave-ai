// Model Number + Part Number + Finish, on the ROUTED v2 pages.
//
// Contract under test:
//   - The Add/Edit Item dialog exposes both identifiers, and a create ships them
//     as `modelNumber` / `mpn` on the upsert payload.
//   - Edit prefills both from the server row and round-trips an edit.
//   - Both routed mount points read them back: pages/v2/inventory/InventoryPage
//     (Stock > Items, grid + side panel + search) and pages/v2/inventory/
//     PriceBookPage (Price Book > Items).
//
// `mpn` is the pre-existing column - CSV import, the Items search and the
// barcode scanner already matched on it, but no form field ever wrote one.
// `modelNumber` is the new column. Hence both are asserted, not just the new one.
//
// The two item endpoints disagree on the ABSENT/null shape: `/api/inventory/items`
// drops the keys entirely (`inv-catalog.controller.ts` maps `row.mpn ?? undefined`)
// while `/api/price-book/items` returns explicit `null`, and an operator who
// cleared a field can leave an empty string behind. All three shapes are fixtured
// below, because a null-only check half-works on the endpoint that feeds Stock.
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine -
// see purchase-orders-deeplink.test.tsx, the sanctioned pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';

// Both routed pages report through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: vi.fn(),
}));

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb2-0000-4000-8000-000000000001',
  MODEL_ONLY_ID: 'bbbbbbb2-0000-4000-8000-000000000002',
  PART_ONLY_ID: 'bbbbbbb2-0000-4000-8000-000000000003',
  BARE_ID: 'bbbbbbb2-0000-4000-8000-000000000004',
  NULLED_ID: 'bbbbbbb2-0000-4000-8000-000000000005',
  BLANK_ID: 'bbbbbbb2-0000-4000-8000-000000000006',
  FINISH_ID: 'bbbbbbb2-0000-4000-8000-00000000000f',
  LOC_WH: 'aaaaaaa2-0000-4000-8000-000000000001',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb2-0000-4000-8000-000000000009',
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
    kind: 'material',
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
      id: h.ITEM_ID,
      sku: 'LOCK-100',
      mpn: '114',
      modelNumber: 'MT5+',
      finishId: h.FINISH_ID,
      name: 'Deadbolt',
    },
    // Display-side fixtures: one identifier each, and three carrying none - in
    // the three shapes the two endpoints and a cleared form actually produce.
    { ...base, id: h.MODEL_ONLY_ID, sku: 'LOCK-200', modelNumber: 'MT5-C', name: 'Model Only Lock' },
    { ...base, id: h.PART_ONLY_ID, sku: 'LOCK-300', mpn: '220', name: 'Part Only Lock' },
    // Keys ABSENT - the `/api/inventory/items` shape that feeds the Stock page.
    { ...base, id: h.BARE_ID, sku: 'LOCK-400', name: 'Bare Lock' },
    // Explicit nulls - the `/api/price-book/items` shape.
    {
      ...base,
      id: h.NULLED_ID,
      sku: 'LOCK-500',
      mpn: null,
      modelNumber: null,
      finishId: null,
      name: 'Nulled Lock',
    },
    // Empty strings - what a cleared field can leave behind.
    {
      ...base,
      id: h.BLANK_ID,
      sku: 'LOCK-600',
      mpn: '',
      modelNumber: '',
      finishId: '',
      name: 'Blank Lock',
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
    // Finish is a foreign key, so unlike mpn/modelNumber the display surfaces
    // have to resolve an id to a name - hence a populated list here, not EMPTY.
    useFinishes: stable([
      { id: h.FINISH_ID, name: 'Satin Chrome', code: '626', isActive: true },
    ]),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable([{ id: h.LOC_WH, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    useBranches: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable({ data: EMPTY, meta: { total: 0 } }),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    useLowStock: stable({ data: EMPTY, meta: { total: 0 } }),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertLocation: mutation,
    useUpsertVendor: mutation,
    useUpsertBranch: mutation,
    useUpsertFinish: mutation,
    useDeleteItem: mutation,
    useRestoreItem: mutation,
    useImportItemsCSV: mutation,
    useTransferStock: mutation,
    useSetThresholds: mutation,
    useSetQuantity: mutation,
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useDeleteFinish: mutation,
  };
});

// AddItemDialog reads the org default inventory location.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: h.LOC_WH },
      isLoading: false,
      isError: false,
    }),
  };
});

const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
    // #2009 - `manage Inventory` does not imply `update PriceBook`; this
    // helper's PriceBookPage edit case needs the PriceBook rules explicitly.
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
  ]);

const renderStock = () =>
  renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

const renderPriceBook = () =>
  renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability: inventoryAbility(),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Add Item dialog - Model Number + Part Number', () => {
  it('InventoryPage create ships both identifiers on the upsert payload', async () => {
    renderStock();

    await userEvent.click(await screen.findByRole('button', { name: /Add Item/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'DEAD-3');
    await userEvent.type(dialog.getByLabelText('Model Number'), 'MT5+');
    await userEvent.type(dialog.getByLabelText('Part Number'), '114');
    await userEvent.click(dialog.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => {
      expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ modelNumber: 'MT5+', mpn: '114' }),
      );
    });
  });

  it('omits both when left blank rather than sending empty strings', async () => {
    renderStock();

    await userEvent.click(await screen.findByRole('button', { name: /Add Item/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByPlaceholderText(NAME_PLACEHOLDER), 'Bare Item');
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'BARE-1');
    await userEvent.click(dialog.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => {
      expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ modelNumber: undefined, mpn: undefined }),
      );
    });
  });

  it('PriceBookPage edit prefills both from the server row and round-trips an edit', async () => {
    renderPriceBook();

    await userEvent.click(await screen.findByText('Deadbolt'));

    const model = await screen.findByLabelText('Model Number');
    const part = screen.getByLabelText('Part Number');
    expect(model).toHaveValue('MT5+');
    expect(part).toHaveValue('114');

    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: h.ITEM_ID, modelNumber: 'MT5-C', mpn: '114' }),
      );
    });
  });
});

// Both identifiers were writable and searchable after the first slice, but
// invisible everywhere except the edit dialog - you could save a model number
// and never read it back. These pin the three surfaces that show them.
describe('Model Number + Part Number are readable outside the dialog', () => {
  const stockRow = (name: string) => {
    const table = screen.getByRole('table');
    return within(table).getByText(name).closest('tr') as HTMLElement;
  };

  it('Stock > Items shows both under the item name', async () => {
    renderStock();

    await screen.findByText('Deadbolt');
    expect(within(stockRow('Deadbolt')).getByText('Model MT5+ · Part 114 · Finish Satin Chrome')).toBeInTheDocument();
  });

  it('Stock > Items shows a lone identifier without a dangling separator', async () => {
    renderStock();
    await screen.findByText('Deadbolt');

    expect(within(stockRow('Model Only Lock')).getByText('Model MT5-C')).toBeInTheDocument();
    expect(within(stockRow('Part Only Lock')).getByText('Part 220')).toBeInTheDocument();
  });

  // The three "no identifiers" shapes: keys ABSENT (what `/api/inventory/items`
  // returns, and so what this page is actually fed), explicit null (the price
  // book endpoint) and empty string (a cleared field). A null-only check passes
  // the middle row and prints "Model " with nothing after it on the others.
  it.each([
    ['absent keys', 'Bare Lock'],
    ['explicit nulls', 'Nulled Lock'],
    ['empty strings', 'Blank Lock'],
  ])('renders no identifier line at all when the item carries none (%s)', async (_shape, name) => {
    renderStock();
    await screen.findByText('Deadbolt');

    expect(within(stockRow(name)).queryByText(/^(Model|Part|Finish)\b/)).toBeNull();
  });

  // Finish rides the same line, but unlike the two identifiers it is a foreign
  // key - the surfaces resolve finishId against the finishes list, so an item
  // pointing at a finish the list does not contain must render nothing rather
  // than a raw uuid.
  it('shows the finish NAME, never the id', async () => {
    renderStock();
    await screen.findByText('Deadbolt');

    const row = stockRow('Deadbolt');
    expect(within(row).getByText(/Finish Satin Chrome/)).toBeInTheDocument();
    expect(within(row).queryByText(new RegExp(h.FINISH_ID))).toBeNull();
  });

  it('omits the finish on items that have none, with no dangling separator', async () => {
    renderStock();
    await screen.findByText('Deadbolt');

    expect(within(stockRow('Model Only Lock')).queryByText(/Finish/)).toBeNull();
  });

  it('the Items search matches on the finish name', async () => {
    renderStock();
    await screen.findByText('Deadbolt');

    await userEvent.type(screen.getByPlaceholderText('Search inventory…'), 'satin');

    // DataTable debounces its search box, so the narrowing lands a tick after
    // the typing rather than synchronously with it.
    await waitFor(() => {
      expect(screen.queryByText('Model Only Lock')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Deadbolt')).toBeInTheDocument();
  });

  it('the Items search still matches on the part number', async () => {
    renderStock();
    await screen.findByText('Deadbolt');

    await userEvent.type(screen.getByPlaceholderText('Search inventory…'), '220');

    await waitFor(() => {
      expect(screen.queryByText('Deadbolt')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Part Only Lock')).toBeInTheDocument();
  });

  it('the Stock item side panel shows both alongside the SKU', async () => {
    renderStock();

    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByText('Deadbolt'));

    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByText('Model MT5+ · Part 114 · Finish Satin Chrome')).toBeInTheDocument();
  });

  it('Price Book > Items shows both under the item name', async () => {
    renderPriceBook();

    const name = await screen.findByText('Deadbolt');
    const cell = name.parentElement as HTMLElement;
    expect(within(cell).getByText('Model MT5+ · Part 114 · Finish Satin Chrome')).toBeInTheDocument();
  });
});
