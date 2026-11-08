// GAP G4 - the ROUTED Stock page (pages/v2/inventory/InventoryPage.tsx) must
// persist the three manufacturer identifiers the Add/Edit Item dialog collects.
//
// Contract under test: `mpn` (the UI calls it "Part Number"), `modelNumber` and
// `finishId` reach the item upsert payload on BOTH create and edit, and the
// page's own optimistic mirror of the row carries them too.
//
// Why both halves matter: on create the three columns land NULL, and on edit
// the PATCH handler is `!== undefined` guarded, so an absent key means "leave
// unchanged" - the write silently no-ops behind a success toast. The mirror is
// what the edit dialog re-prefills from, so a mirror that drops them shows the
// operator the OLD value the moment they reopen the row.
//
// Read-side seam hooks are mocked with stable resolved data (the jsdom seed-loop
// landmine - see purchase-orders-deeplink.test.tsx, the sanctioned pattern).
// `useUpsertItem` is a spy so the payload itself can be asserted.
//
// Deliberately a NEW file: inventory-model-part-number.test.tsx still points at
// the unrouted v1 pages on purpose and is repointed separately.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

// The routed page reports through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: vi.fn(),
}));

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb3-0000-4000-8000-000000000001',
  FINISH_ID: 'bbbbbbb3-0000-4000-8000-00000000000f',
  LOC_WH: 'aaaaaaa3-0000-4000-8000-000000000001',
  CREATED_ID: 'bbbbbbb3-0000-4000-8000-000000000009',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb3-0000-4000-8000-000000000009',
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
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'LOCK-100',
      mpn: '114',
      modelNumber: 'MT5+',
      finishId: h.FINISH_ID,
      name: 'Deadbolt',
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
      stock: [{ locationId: h.LOC_WH, onHand: 4 }],
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
    useFinishes: stable([{ id: h.FINISH_ID, name: 'Satin Chrome', code: '626', isActive: true }]),
    useLocations: stable([{ id: h.LOC_WH, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    useBrands: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useBranches: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable({ data: EMPTY, meta: { total: 0 } }),
    useLowStock: stable({ data: EMPTY, meta: { total: 0 } }),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertLocation: mutation,
    useUpsertVendor: mutation,
    useUpsertCategory: mutation,
    useUpsertBranch: mutation,
    useUpsertBrand: mutation,
    useUpsertFinish: mutation,
    useDeleteItem: mutation,
    useDeleteCategory: mutation,
    useDeleteBrand: mutation,
    useDeleteFinish: mutation,
    useRestoreItem: mutation,
    useImportItemsCSV: mutation,
    useTransferStock: mutation,
    useSetThresholds: mutation,
    useSetQuantity: mutation,
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

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

function render() {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });
}

/** The detail panel's Edit button - the operator's route into the edit dialog. */
async function openEditFromPanel() {
  const panel = await screen.findByRole('complementary');
  await userEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
  return within(await screen.findByRole('dialog'));
}

/** Row click -> detail panel -> Edit. The row name is looked up inside the
 *  table, because an already-open detail panel renders the same name too. */
async function openEditDialog(itemName: string) {
  const table = await screen.findByRole('table');
  await userEvent.click(within(table).getByText(itemName));
  return openEditFromPanel();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Routed Stock page persists the manufacturer identifiers (GAP G4)', () => {
  it('a create ships mpn, modelNumber and finishId on the upsert payload', async () => {
    render();

    await userEvent.click(await screen.findByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    await userEvent.type(dialog.getByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'DEAD-3');
    await userEvent.type(dialog.getByLabelText('Model Number'), 'MT5+');
    await userEvent.type(dialog.getByLabelText('Part Number'), '114');
    await userEvent.click(dialog.getByRole('combobox', { name: 'Finish' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Satin Chrome' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => {
      expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ mpn: '114', modelNumber: 'MT5+', finishId: h.FINISH_ID }),
      );
    });
  });

  it('an edit ships all three rather than omitting the keys the PATCH treats as "unchanged"', async () => {
    render();

    const dialog = await openEditDialog('Deadbolt');
    const model = dialog.getByLabelText('Model Number');
    expect(model).toHaveValue('MT5+');
    expect(dialog.getByLabelText('Part Number')).toHaveValue('114');

    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.click(dialog.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: h.ITEM_ID,
          mpn: '114',
          modelNumber: 'MT5-C',
          finishId: h.FINISH_ID,
        }),
      );
    });
  });

  it('the edited row mirror keeps the new identifiers, so reopening does not show the old ones', async () => {
    render();

    const dialog = await openEditDialog('Deadbolt');
    const model = dialog.getByLabelText('Model Number');
    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.clear(dialog.getByLabelText('Part Number'));
    await userEvent.type(dialog.getByLabelText('Part Number'), '220');
    await userEvent.click(dialog.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The row stays selected, so the panel is the honest way back in.
    const reopened = await openEditFromPanel();
    expect(reopened.getByLabelText('Model Number')).toHaveValue('MT5-C');
    expect(reopened.getByLabelText('Part Number')).toHaveValue('220');
  });

  it('the created row mirror carries the identifiers straight back into the edit dialog', async () => {
    render();

    await userEvent.click(await screen.findByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    await userEvent.type(dialog.getByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'DEAD-3');
    await userEvent.type(dialog.getByLabelText('Model Number'), 'MT5+');
    await userEvent.type(dialog.getByLabelText('Part Number'), '114');
    await userEvent.click(dialog.getByRole('combobox', { name: 'Finish' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Satin Chrome' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const reopened = await openEditDialog('New Deadbolt');
    expect(reopened.getByLabelText('Model Number')).toHaveValue('MT5+');
    expect(reopened.getByLabelText('Part Number')).toHaveValue('114');
    expect(reopened.getByRole('combobox', { name: 'Finish' })).toHaveTextContent('Satin Chrome');
  });
});
