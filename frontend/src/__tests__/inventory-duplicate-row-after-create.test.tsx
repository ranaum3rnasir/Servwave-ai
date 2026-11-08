// Stock > Items renders a newly created item TWICE (found during the PR #1382
// live verification: the grid footer read "18 items of 18 total" on an org that
// held 17, and a reload always collapsed it back to one row).
//
// Contract under test: after a successful create, the saved SKU appears in the
// grid exactly once and the "of N total" counter matches the server list -
// with no reload.
//
// Unlike the sibling inventory suites, `useInventoryItems` is deliberately left
// REAL here. The defect lives in the interaction between that query's
// invalidation refetch and the page's local `allItems` mirror, so mocking the
// read hook with a frozen array would mock away the very thing under test. The
// mocked axios GET serves a mutable server list that the mocked POST appends
// to, exactly as the real server would.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

const h = vi.hoisted(() => ({
  EXISTING_ID: 'bbbbbbb3-0000-4000-8000-000000000001',
  CREATED_ID: 'bbbbbbb3-0000-4000-8000-000000000002',
}));

const EXISTING = {
  id: h.EXISTING_ID,
  sku: 'FLT-20',
  name: 'Air Filter 20x20',
  category: 'Filters',
  trade: 'hvac',
  kind: 'material',
  uom: 'EA',
  unitCost: 8,
  sellPrice: 25,
  serialized: false,
  hazmat: false,
  trackInventory: true,
  status: 'active',
  vendor: 'Acme Supply',
  stock: [],
  updatedAt: '2026-07-01T00:00:00.000Z',
};

/** Stands in for the server's catalog table: the POST appends to it and every
 *  subsequent GET (including the invalidation refetch) serves the new row. */
let serverItems: Record<string, unknown>[] = [];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    // useInventoryItems + useUpsertItem stay REAL - they are the seam under test.
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useBranches: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    useLowStock: stable(EMPTY),
    useTechs: stable(EMPTY),
    useStockApprovals: stable(EMPTY),
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
    useSetQuantity: mutation,
    useSetThresholds: mutation,
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1' }, isLoading: false, isError: false }),
  };
});

const mockApi = vi.mocked(api);
const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

beforeEach(() => {
  vi.clearAllMocks();
  serverItems = [EXISTING];
  mockApi.get.mockImplementation((url: string) => {
    if (url.startsWith('/api/inventory/items')) {
      return Promise.resolve({ data: { data: serverItems } });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  mockApi.post.mockImplementation((url: string, body: Record<string, unknown>) => {
    if (url === '/api/price-book/items') {
      const created = { ...EXISTING, id: h.CREATED_ID, sku: String(body.sku), name: String(body.name) };
      serverItems = [...serverItems, created];
      return Promise.resolve({ data: { data: { ...created, is_active: true } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
});

describe('Stock > Items - a created item renders once, not twice', () => {
  it('shows exactly one row for the new SKU when the refetch beats the handler', async () => {
    const { queryClient } = renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    expect(await screen.findByText('Air Filter 20x20')).toBeInTheDocument();

    // HONEST LIMITATION: this test does NOT reproduce the duplicate. It was run
    // against the buggy code (optimistic prepend restored) and still passed.
    //
    // The live defect comes from React 18 batching the seed effect's wholesale
    // `setAllItems(serverList)` together with the handler's
    // `setAllItems(prev => [newItem, ...prev])`: the replace applies first, then
    // the prepend stacks a second copy on a list that already contains the item.
    // Under jsdom + act, React will not flush that effect mid-await, so the two
    // updates never land in one batch however the promises are ordered - awaiting
    // the refetch inside the POST (below) gets closest and still is not enough.
    //
    // The bug was proven on staging instead (2026-08-07: one POST, 18 rows with
    // the probe SKU at rows 1 and 18, 17 rows after a reload) and the fix must be
    // re-verified there. What this test does pin is the ordinary create path:
    // the new SKU renders exactly once and the counter matches the server list.
    mockApi.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url !== '/api/price-book/items') return { data: { data: {} } };
      const created = {
        ...EXISTING,
        id: h.CREATED_ID,
        sku: String(body.sku),
        name: String(body.name),
      };
      serverItems = [...serverItems, created];
      await queryClient.refetchQueries({ queryKey: ['inventory', 'items'] });
      return { data: { data: { ...created, is_active: true } } };
    });

    await userEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'Probe Deadbolt');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(screen.getByLabelText(/^SKU/), 'PROBE-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => {
      expect(screen.getAllByText('Probe Deadbolt')).toHaveLength(1);
    });
    expect(screen.getByText(/of 2 total/)).toBeInTheDocument();
  }, 120000);

  // The original report said the duplicate came back after an EDIT too. It does
  // not - and it is worth pinning why, because the two handlers look alike.
  //
  // The create bug was `setAllItems(prev => [newItem, ...prev])`: batched behind
  // the seed effect's wholesale replace, the prepend stacks a SECOND copy onto a
  // list that already contains the server row. The edit handler is a
  // `prev.map(i => i.id === editId ? {...} : i)` - keyed on id, replacing in
  // place - so the same interleaving updates the matching row and adds nothing.
  // It is structurally incapable of the create defect, whatever the ordering.
  //
  // What the report almost certainly saw: editing ONE of the two twins the
  // create bug had already produced. The other twin kept the old values, so the
  // duplicate "came back" on screen. Removing the prepend removes that too.
  //
  // Every other local-mirror write on both inventory pages is the same in-place
  // shape (visibility toggle, category rename, PriceBookPage's edit branch), and
  // PriceBookPage's create branch never had a prepend to begin with.
  it('an edit updates the row in place - it does not add a second one', async () => {
    const { queryClient } = renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    expect(await screen.findByText('Air Filter 20x20')).toBeInTheDocument();

    // Same refetch-inside-the-write ordering the create case uses above, so the
    // edit runs against the harshest interleaving this harness can produce.
    mockApi.patch.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (!url.startsWith('/api/price-book/items/')) return { data: { data: {} } };
      const renamed = { ...EXISTING, name: String(body.name ?? EXISTING.name) };
      serverItems = [renamed];
      await queryClient.refetchQueries({ queryKey: ['inventory', 'items'] });
      return { data: { data: { ...renamed, is_active: true } } };
    });

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByText('Edit item'));

    const nameInput = await screen.findByDisplayValue('Air Filter 20x20');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Air Filter 20x20 HEPA');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(screen.getAllByText('Air Filter 20x20 HEPA')).toHaveLength(1);
    });
    expect(screen.queryByText('Air Filter 20x20')).not.toBeInTheDocument();
    expect(screen.getByText(/of 1 total/)).toBeInTheDocument();
  }, 120000);
});
