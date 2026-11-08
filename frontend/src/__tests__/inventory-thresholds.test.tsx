// SRVW-91 - reserve levels (per-(item, location) min/max) on the Stock page.
//
// Contract under test:
//   • The item detail panel offers "Reserve levels"; submitting PUTs the SNAKE_CASE body
//     { item_id, location_id, min, max } - not the camelCase shape useInventoryMutation
//     would have sent (the trap useSetQuantity already fell into).
//   • Add Item with Min/Max issues a FOLLOW-UP threshold write carrying the SERVER item id
//     and a real location id - never the fabricated "loc_wh_main".
//   • A rejected threshold write never claims the reserve levels were saved.
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine - see
// purchase-orders-deeplink.test.tsx, the sanctioned pattern). useSetThresholds stays REAL
// so the PUT path is exercised over the setup-mocked axios.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

import { toast } from '@/ui-kit/components/ui/sonner';

// The routed page reports through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not. Spying on the call is
// how the toast copy stays asserted without standing a toaster up per test.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: vi.fn(),
}));

const mockToast = vi.mocked(toast);

const h = vi.hoisted(() => ({
  LOC_MAIN: 'aaaaaaa1-0000-4000-8000-000000000001',
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
  NEW_ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000009',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  const item = {
    id: h.ITEM_ID,
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
    stock: [{ locationId: h.LOC_MAIN, onHand: 9 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  return {
    ...actual,
    useInventoryItems: stable([item]),
    useLocations: stable(locations),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
  };
});

// Both SetThresholdsDialog and AddItemDialog read the org default location.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: h.LOC_MAIN },
      isLoading: false,
      isError: false,
    }),
  };
});

const mockApi = vi.mocked(api);

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

async function openThresholdsFromDetailPanel() {
  const utils = renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

  // Clicking the row opens the detail panel, whose By Location header owns the entry point.
  await userEvent.click(await screen.findByText('FLT-20'));
  await userEvent.click(await screen.findByRole('button', { name: 'Reserve levels' }));

  const dialog = within(await screen.findByRole('dialog'));
  return { ...utils, dialog };
}

async function openAddItemDialog() {
  const utils = renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

  await screen.findByText('FLT-20');
  await userEvent.click(screen.getByRole('button', { name: /add item/i }));

  const dialog = within(await screen.findByRole('dialog'));
  return { ...utils, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.put.mockResolvedValue({
    data: { success: true, item_id: h.ITEM_ID, location_id: h.LOC_MAIN, min: 10, max: 20, on_hand: 9 },
  });
  mockApi.post.mockResolvedValue({ data: { data: { id: h.NEW_ITEM_ID } } });
});

// InventoryPage is a very large tree and each of these cases drives it through a row
// selection plus a dialog, so the 15s file default is not enough headroom here.
const SLOW = 45_000;

describe('InventoryPage - reserve levels (SRVW-91)', () => {
  it('the detail panel Reserve levels dialog PUTs the exact snake_case body', async () => {
    const { dialog } = await openThresholdsFromDetailPanel();

    await userEvent.type(dialog.getByLabelText('Min reserve'), '10');
    await userEvent.type(dialog.getByLabelText('Max reorder cap'), '20');
    await userEvent.click(dialog.getByRole('button', { name: /save levels/i }));

    await waitFor(() => {
      expect(mockApi.put).toHaveBeenCalledWith('/api/inventory/stock/thresholds', {
        item_id: h.ITEM_ID,
        location_id: h.LOC_MAIN,
        min: 10,
        max: 20,
      });
    });
    expect(mockApi.put).toHaveBeenCalledTimes(1);
  }, SLOW);

  it('Add Item with Min/Max issues a follow-up threshold PUT carrying the server item id and a real location id', async () => {
    const { dialog } = await openAddItemDialog();

    await userEvent.type(dialog.getByLabelText(/Item Name/), 'Blower Motor');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'BLOWER-1');
    await userEvent.type(dialog.getByLabelText(/Min/), '10');
    await userEvent.type(dialog.getByLabelText(/Max/), '20');
    await userEvent.click(dialog.getByRole('button', { name: /save item/i }));

    await waitFor(() => {
      expect(mockApi.put).toHaveBeenCalledWith('/api/inventory/stock/thresholds', {
        item_id: h.NEW_ITEM_ID,
        location_id: h.LOC_MAIN,
        min: 10,
        max: 20,
      });
    });
    // The fabricated mock id must never leave the client.
    expect(JSON.stringify(mockApi.put.mock.calls)).not.toContain('loc_wh_main');
  }, SLOW);

  it('a rejected threshold write never claims the reserve levels were saved', async () => {
    mockApi.put.mockRejectedValue({ response: { status: 400, data: { error: 'Invalid body' } } });
    const { dialog } = await openThresholdsFromDetailPanel();

    await userEvent.type(dialog.getByLabelText('Min reserve'), '10');
    await userEvent.click(dialog.getByRole('button', { name: /save levels/i }));

    // The dialog stays open with the entered value intact and surfaces the server error.
    expect(await screen.findByText('Invalid body')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(dialog.getByLabelText('Min reserve')).toHaveValue(10);
    // Asserted on the toast CALL, not on rendered text: the routed page reports through
    // sonner and no toaster is mounted here, so a queryByText would pass vacuously.
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/reserve levels at Main Warehouse set to/i),
    );
  }, SLOW);
});
