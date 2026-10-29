// Inventory task 8 (Slice 3) - Stock > Items "Transfer" wired to the real
// POST /api/inventory/transfer, with a shortage-error UI state so a blocked
// over-draw transfer surfaces a clear inline error instead of silently
// succeeding (mirrors the backend 409 SHORTAGE test in
// inv-catalog-writes.test.ts, "block mode refuses an over-draw transfer with
// 409 SHORTAGE and NO movement (QA-204)").
//
// Contract under test:
//   • Submit POSTs /api/inventory/transfer with the camelCase body
//     { itemId, fromId, toId, qty, reason }.
//   • Success closes the dialog, shows the page toast, and invalidates
//     ['inventory'] (useTransferStock's built-in refresh).
//   • A 409 { error: 'SHORTAGE', available } renders an inline error in the
//     dialog and keeps it open (no misleading success toast, no silent
//     success).
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
  LOC_FROM: 'loc_wh_main',
  LOC_TO: 'loc_van_mike',
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000002',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const locations = [
    { id: h.LOC_FROM, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: h.LOC_TO, name: "Mike's Van", type: 'truck', branch: 'HQ' },
  ];
  const item = {
    id: h.ITEM_ID,
    sku: 'FLT-30',
    name: 'Air Filter 30x30',
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
      { locationId: h.LOC_FROM, onHand: 10 },
      { locationId: h.LOC_TO, onHand: 0 },
    ],
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
    usePurchaseOrders: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
  };
});

const mockApi = vi.mocked(api);

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
  ]);

async function openTransferDialog() {
  const utils = renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

  await screen.findByText('FLT-30');
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }));

  const dialog = within(await screen.findByRole('dialog'));
  return { ...utils, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('v2 InventoryPage - Transfer between locations (Slice 3)', () => {
  it('submits the camelCase transfer body, closes, toasts, and invalidates the inventory cache', async () => {
    const { dialog, queryClient } = await openTransferDialog();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await userEvent.type(dialog.getByLabelText(/Quantity/), '3');
    await userEvent.click(dialog.getByRole('button', { name: /submit transfer/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/transfer', {
        itemId: h.ITEM_ID,
        fromId: h.LOC_FROM,
        toId: h.LOC_TO,
        qty: 3,
        reason: 'Restock van for morning routes',
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Transfer Stock Between Locations')).toBeNull();
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringMatching(/Transferred 3 × FLT-30 from Main Warehouse/),
    );
    // A stock write now refreshes its own key set rather than the whole
    // ['inventory'] prefix (#1639): the blanket key refetched all 22 inventory
    // queries per write and could exhaust the 100-per-60s API limiter.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'items'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'movements'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'low-stock'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['inventory'] });
  });

  it('renders an inline error and keeps the dialog open on a 409 SHORTAGE (QA-204), with no misleading success toast', async () => {
    mockApi.post.mockRejectedValue({
      response: { status: 409, data: { error: 'SHORTAGE', message: 'Not enough stock', available: 2 } },
    });

    const { dialog } = await openTransferDialog();

    await userEvent.type(dialog.getByLabelText(/Quantity/), '3');
    await userEvent.click(dialog.getByRole('button', { name: /submit transfer/i }));

    expect(
      await dialog.findByText('Not enough stock at the source - 2 available.'),
    ).toBeInTheDocument();

    // Dialog stays open - no incorrect success toast fires.
    expect(screen.getByText('Transfer Stock Between Locations')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/✓ Transferred/));
  });

  it('gives useful feedback (not a silent failure) on a non-SHORTAGE error', async () => {
    mockApi.post.mockRejectedValue(new Error('network down'));

    const { dialog } = await openTransferDialog();

    await userEvent.type(dialog.getByLabelText(/Quantity/), '3');
    await userEvent.click(dialog.getByRole('button', { name: /submit transfer/i }));

    expect(await dialog.findByText('Transfer failed - try again.')).toBeInTheDocument();
    expect(screen.getByText('Transfer Stock Between Locations')).toBeInTheDocument();
  });

  it('SRVW-227: has no developer-speak subtitle naming database tables or enum values', async () => {
    const { dialog } = await openTransferDialog();

    // The title alone still explains what a transfer does.
    expect(dialog.getByText('Transfer Stock Between Locations')).toBeInTheDocument();
    expect(screen.queryByText(/stock_movement/i)).toBeNull();
    expect(screen.queryByText(/transfer_out/i)).toBeNull();
    expect(screen.queryByText(/transfer_in/i)).toBeNull();
    expect(screen.queryByText(/posts paired/i)).toBeNull();
  });
});
