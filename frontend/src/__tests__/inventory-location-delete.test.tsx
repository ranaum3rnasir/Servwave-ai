// Inventory > Locations: deleting a warehouse or a van from the Stock page.
//
// Contract under test:
//   • An admin gets a reveal-on-hover Delete button per location row in the
//     LocationSelector popover; it opens DeleteLocationDialog.
//   • Confirming calls DELETE /api/inventory/locations/:id and toasts.
//   • Deleting the location the page is currently scoped to snaps the scope
//     back to "All Locations" rather than stranding the filter on a row that
//     no longer exists.
//   • The server's 409 reason (stock still on hand, or "this is the default
//     inventory location") reaches the toast verbatim rather than being
//     flattened into a generic failure - the backend guard is the real gate,
//     the client preflight is advisory.
//   • A location holding stock is blocked client-side before the round trip.
//
// Seam hooks are mocked (jsdom seed-loop landmine - see inventory-hybrid-delete.test.tsx,
// the sanctioned pattern); useDeleteLocation stays REAL so the mutation +
// toast + cache-invalidation wiring is exercised for real.
//
// Settings > Locations is NOT this surface: it deletes `/api/locations` business
// locations, a different model from the `/api/inventory/locations` warehouses and
// vans this file covers.
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

// Fixtures live inside vi.hoisted so the vi.mock factory (hoisted to the top of
// the file) can close over them. They also give the STABLE array references the
// jsdom seed-loop needs - a fresh array per call re-triggers InventoryPage's
// seed effect on every render and hangs the test.
const h = vi.hoisted(() => {
  const LOC_EMPTY = 'aaaaaaa1-0000-4000-8000-000000000001';
  const LOC_STOCKED = 'aaaaaaa1-0000-4000-8000-000000000002';
  return {
    LOC_EMPTY,
    LOC_STOCKED,
    LOCATIONS: [
      { id: LOC_EMPTY, name: 'Spare Van', type: 'truck', branch: 'HQ' },
      { id: LOC_STOCKED, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    ],
    ITEMS: [
      {
        id: 'bbbbbbb1-0000-4000-8000-000000000001',
        sku: 'FLT-1',
        name: 'Filter',
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
        isActive: true,
        vendor: 'Acme Supply',
        // Stocked at the warehouse only - the spare van is empty.
        stock: [
          { locationId: LOC_STOCKED, onHand: 12 },
          { locationId: LOC_EMPTY, onHand: 0 },
        ],
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useInventoryItems: stable(h.ITEMS),
    useLocations: stable(h.LOCATIONS),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
  };
});

const mockApi = vi.mocked(api);

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
  ]);

async function renderPage() {
  renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });
  await screen.findByText('FLT-1');
}

/**
 * The LocationSelector trigger, scoped to the "Showing" row - the location name
 * also appears on the stock-health cards and inside the popover itself.
 */
function scopeTrigger(name: RegExp) {
  const row = screen.getByText('Showing').closest('div')!;
  return within(row).getByRole('button', { name });
}

async function openLocationPopover(triggerName: RegExp = /All Locations/) {
  await userEvent.click(scopeTrigger(triggerName));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 InventoryPage - inventory location delete', () => {
  it('deletes an empty location and toasts', async () => {
    mockApi.delete.mockResolvedValue({ data: { message: 'Location deleted' } });

    await renderPage();
    await openLocationPopover();
    await userEvent.click((await screen.findAllByLabelText('Delete location'))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /Delete location/i }));

    await waitFor(() => {
      expect(mockApi.delete).toHaveBeenCalledWith(
        `/api/inventory/locations/${h.LOC_EMPTY}`,
      );
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('✓ "Spare Van" deleted'));
  });

  it('resets the active scope to all locations when the scoped location is deleted', async () => {
    mockApi.delete.mockResolvedValue({ data: { message: 'Location deleted' } });

    await renderPage();
    // Scope the page to the van first - the trigger then names it.
    await openLocationPopover();
    const popover = await screen.findByRole('dialog');
    await userEvent.click(within(popover).getByText('Spare Van'));
    await waitFor(() => expect(scopeTrigger(/Spare Van/)).toBeInTheDocument());

    await openLocationPopover(/Spare Van/);
    await userEvent.click((await screen.findAllByLabelText('Delete location'))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /Delete location/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('✓ "Spare Van" deleted'));
    // Scope snapped back rather than staying on a location that is now gone.
    await waitFor(() => expect(scopeTrigger(/All Locations/)).toBeInTheDocument());
  });

  it('surfaces the server 409 reason instead of a generic failure', async () => {
    mockApi.delete.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error:
            'Cannot delete: this is the default inventory location for the organization. Choose a different default first.',
        },
      },
    });

    await renderPage();
    await openLocationPopover();
    await userEvent.click((await screen.findAllByLabelText('Delete location'))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /Delete location/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringContaining('default inventory location for the organization'),
      ),
    );
    // The dialog stays open carrying the same reason, so the operator keeps the context.
    expect(
      await screen.findByText(/default inventory location for the organization/i),
    ).toBeInTheDocument();
  });

  it('blocks a location that still holds stock before any request', async () => {
    await renderPage();
    await openLocationPopover();
    // Second row is the stocked warehouse.
    await userEvent.click((await screen.findAllByLabelText('Delete location'))[1]!);

    expect(await screen.findByText(/still holds stock/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete location/i })).toBeDisabled();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });
});
