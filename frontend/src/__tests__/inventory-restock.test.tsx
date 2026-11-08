// SRVW-92 - Receive stock is a real write, not a client-side no-op.
//
// Contract under test:
//   • Submitting the Restock dialog issues exactly one POST to /api/inventory/restock
//     (or, for source=truck_return, one POST to /api/inventory/transfer) and awaits it
//     before closing - no local on-hand mirror, no toast unless the request resolved 2xx.
//   • The destination location never defaults to the old hardcoded "loc_wh_main" mock seed.
//   • A stale typed reference cannot survive a switch to a source that hides the field.
//   • A cost-stripped item (no `read Invoice`) never sends a literal 0 unitCost.
//   • The org-wide bulk-restock surface is gone; the per-location pill opens the real
//     GeneratePODialog instead of the fake BulkRestockDialog.
//
// Seam hooks are stub-mocked (same idiom as inventory-set-quantity.test.tsx). useRestock and
// useTransferStock stay REAL so the POST path is exercised over the setup-mocked axios.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { buildAbility } from '@/lib/ability';

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
  VAN: 'aaaaaaa1-0000-4000-8000-000000000002',
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
  STRIPPED_ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000002',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: h.VAN, name: 'Van 1', type: 'truck', primaryTech: 'Sam' },
  ];
  const costed = {
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
    stock: [
      { locationId: h.LOC_MAIN, onHand: 1, min: 5 },
      { locationId: h.VAN, onHand: 4 },
    ],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  // Shape stripMappedItemCost produces for a user without `read Invoice`: no unitCost
  // key at all (not unitCost: undefined - a real delete), and no `min` so it never
  // affects the low-stock counts used by tests 1-8.
  const stripped = {
    id: h.STRIPPED_ITEM_ID,
    sku: 'FLT-30',
    name: 'Air Filter 30x30',
    category: 'Filters',
    trade: 'hvac',
    kind: 'material',
    uom: 'EA',
    sellPrice: 30,
    serialized: false,
    hazmat: false,
    trackInventory: true,
    status: 'active',
    vendor: 'Acme Supply',
    stock: [{ locationId: h.LOC_MAIN, onHand: 10 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  return {
    ...actual,
    useInventoryItems: stable([costed, stripped]),
    useLocations: stable(locations),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    // RestockDialog calls this for the PO datalist - unstubbed would hit the bare
    // vi.fn() axios get from __tests__/setup.ts and throw inside the query.
    usePurchaseOrders: stable(EMPTY),
  };
});

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

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
    { action: 'create', subject: 'PurchaseOrder' },
  ]);

async function openRestockDialog() {
  const utils = renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

  await screen.findByText('FLT-20');
  await userEvent.click(screen.getByRole('button', { name: 'Restock' }));

  const dialog = within(await screen.findByRole('dialog'));
  return { ...utils, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('InventoryPage - Restock (SRVW-92)', () => {
  it('posts exactly one /api/inventory/restock with the entered payload and a real location id', async () => {
    const { dialog } = await openRestockDialog();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '5');

    // The five source chips share one wrapping <label> (Field), which defeats
    // getByRole's accessible-name computation - select by their own text instead.
    await userEvent.click(dialog.getByText('Vendor receipt (PO)'));
    await userEvent.type(dialog.getByLabelText(/PO number/), 'PO-2261');

    await userEvent.click(dialog.getByRole('button', { name: /^Receive \d/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/restock', {
      itemId: h.ITEM_ID,
      locationId: h.LOC_MAIN,
      qty: 5,
      unitCost: 8,
      source: 'vendor_po',
      reference: 'PO-2261',
      notes: undefined,
    });

    // The hardcoded mock seed must never leave the client.
    const bodies = mockApi.post.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(bodies.join('')).not.toContain('loc_wh_main');
  });

  it('a rejected mutation shows the error inline, keeps the dialog open and shows no success toast', async () => {
    mockApi.post.mockRejectedValueOnce({
      response: { status: 404, data: { error: 'Location not found' } },
    });
    const { dialog } = await openRestockDialog();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '5');
    // Counted-in needs no reference number, so this isolates the mutation-failure path.
    await userEvent.click(dialog.getByText('Counted in (cycle count)'));
    await userEvent.click(dialog.getByRole('button', { name: /^Receive \d/ }));

    expect(await dialog.findByText('Location not found')).toBeInTheDocument();
    // Dialog stayed open with the entered qty intact.
    expect(dialog.getByLabelText(/quantity/i)).toHaveValue(5);
    // Asserted on the toast CALL, not on rendered text: the routed page reports through
    // sonner and no toaster is mounted here, so a queryByText would pass vacuously.
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/Received/));
    // No local mirror write - the FLT-20 row's On Hand cell still shows the seeded
    // server total (1 at Main + 4 at Van = 5). A surviving mirror adding the failed
    // qty of 5 would render 10, so this genuinely discriminates.
    const row = screen.getByText('FLT-20').closest('tr')!;
    const onHandCell = row.querySelectorAll('td')[4];
    expect(onHandCell).toHaveTextContent('5');
  });

  it('source=truck_return posts to /api/inventory/transfer, not /restock', async () => {
    const { dialog } = await openRestockDialog();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '2');
    await userEvent.click(dialog.getByText('Truck return to warehouse'));
    await userEvent.click(dialog.getByRole('combobox', { name: 'From which van' }));
    await userEvent.click(await screen.findByRole('option', { name: /Van 1/ }));

    await userEvent.click(dialog.getByRole('button', { name: /^Receive \d/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/transfer', {
        itemId: h.ITEM_ID,
        fromId: h.VAN,
        toId: h.LOC_MAIN,
        qty: 2,
        reason: 'Truck return',
      });
    });
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/inventory/restock', expect.anything());
  });

  it('the submit button is disabled while the request is in flight', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    mockApi.post.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );
    const { dialog } = await openRestockDialog();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '5');
    await userEvent.click(dialog.getByText('Counted in (cycle count)'));
    const cta = dialog.getByRole('button', { name: /^Receive \d/ });
    await userEvent.click(cta);

    await waitFor(() => expect(cta).toBeDisabled());
    await userEvent.click(cta);
    expect(mockApi.post).toHaveBeenCalledTimes(1);

    resolvePost({ data: { success: true } });
  });

  it('a reference typed for a PO source is not sent after switching to a source that hides the field', async () => {
    const { dialog } = await openRestockDialog();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '5');
    await userEvent.click(dialog.getByText('Vendor receipt (PO)'));
    await userEvent.type(dialog.getByLabelText(/PO number/), 'PO-2261');
    await userEvent.click(dialog.getByText('Counted in (cycle count)'));

    await userEvent.click(dialog.getByRole('button', { name: /^Receive \d/ }));

    // toHaveBeenCalledWith uses toEqual semantics, which treats an undefined-valued
    // key as equivalent to absent - the real proof that the value isn't sent (the
    // wire body drops it entirely via JSON.stringify) is this equality, not a
    // toHaveProperty check (which would fail on correct code, since the key is
    // present-with-undefined on the JS object handed to api.post).
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/restock', {
        itemId: h.ITEM_ID,
        locationId: h.LOC_MAIN,
        qty: 5,
        unitCost: 8,
        source: 'counted_in',
        reference: undefined,
        notes: undefined,
      });
    });
  });

  it('a cost-stripped item hides Unit Cost and omits unitCost from the payload', async () => {
    const { dialog } = await openRestockDialog();

    await userEvent.click(dialog.getByLabelText('Item'));
    await userEvent.click(await screen.findByRole('option', { name: /FLT-30/ }));

    expect(dialog.queryByLabelText('Unit Cost ($)')).toBeNull();

    await userEvent.type(dialog.getByLabelText(/quantity/i), '3');
    await userEvent.click(dialog.getByText('Counted in (cycle count)'));
    await userEvent.click(dialog.getByRole('button', { name: /^Receive \d/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledTimes(1);
    });
    const sentBody = mockApi.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty('unitCost');
  });

  it('the fake bulk-PO surface is gone and the location pill opens the real Generate PO dialog', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByText('Low Stock'));

    expect(screen.queryByText('Restock All Low Stock · by Location')).toBeNull();

    const pill = await screen.findByTitle(/Create Purchase Order\(s\) to restock Main Warehouse/);
    await userEvent.click(pill);

    expect(
      await screen.findByText('Generate purchase orders from low stock at Main Warehouse'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Bulk Restock')).toBeNull();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
