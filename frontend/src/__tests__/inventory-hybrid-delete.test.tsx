// Task 3 - Stock > Items: real hybrid delete + "Show archived" toggle + Restore.
//
// Contract under test:
//   • DELETE /api/price-book/items/:id ({mode:'deleted'|'archived', message,
//     referenceCount?} from Task 1) drives a mode-specific toast, closes the
//     dialog, and clears the selection.
//   • useInventoryItems(showArchived) threads the toggle through - off by
//     default (only active rows), on shows archived rows too (Task 2's
//     include_archived=true).
//   • Archived rows get a "Restore item" kebab action instead of "Delete
//     item"; it PATCHes is_active:true and toasts on success.
//
// Seam hooks are mocked (jsdom seed-loop landmine - see purchase-orders-deeplink.test.tsx,
// the sanctioned pattern); useInventoryItems is mocked as a fn so it can react to the
// showArchived arg the same way the real query does. useDeleteItem/useRestoreItem stay
// REAL so the mutation + toast + cache-invalidation wiring is exercised for real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
  ACTIVE_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
  ARCHIVED_ID: 'bbbbbbb1-0000-4000-8000-000000000002',
}));

function makeItem(overrides: Record<string, unknown>) {
  return {
    id: overrides.id,
    sku: overrides.sku,
    name: overrides.name,
    category: 'Filters',
    trade: 'hvac',
    kind: 'material',
    uom: 'EA',
    unitCost: 8,
    sellPrice: 25,
    serialized: false,
    hazmat: false,
    trackInventory: false,
    status: 'active',
    vendor: 'Acme Supply',
    stock: [{ locationId: h.LOC_MAIN, onHand: 0 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const ACTIVE_ITEM = makeItem({ id: h.ACTIVE_ID, sku: 'ACT-1', name: 'Active Widget', isActive: true });
const ARCHIVED_ITEM = makeItem({ id: h.ARCHIVED_ID, sku: 'ARC-1', name: 'Archived Widget', isActive: false });
// Stable array references (jsdom seed-loop landmine - a fresh array per call
// re-triggers InventoryPage's `setAllItems` seed effect on every render, which
// hangs the test). Hoisted once so both branches return the SAME reference
// across re-renders.
const ACTIVE_ONLY = [ACTIVE_ITEM];
const ACTIVE_AND_ARCHIVED = [ACTIVE_ITEM, ARCHIVED_ITEM];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  return {
    ...actual,
    // Mirrors the real server contract: archived rows only surface once the
    // caller passes includeArchived=true (Task 2's include_archived flag).
    useInventoryItems: (includeArchived = false) => ({
      data: includeArchived ? ACTIVE_AND_ARCHIVED : ACTIVE_ONLY,
      isLoading: false,
      isError: false,
    }),
    useLocations: stable(locations),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
  };
});

const mockApi = vi.mocked(api);

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 InventoryPage - hybrid delete (Task 3)', () => {
  it('hides archived rows by default and reveals them via "Show archived"', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('ACT-1');
    expect(screen.queryByText('ARC-1')).toBeNull();

    await userEvent.click(screen.getByLabelText('Show archived items'));

    await screen.findByText('ARC-1');
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('deletes an unreferenced item and toasts "deleted" (mode:"deleted")', async () => {
    mockApi.delete.mockResolvedValue({ data: { mode: 'deleted', message: 'Item deleted' } });
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('ACT-1');
    await userEvent.click(screen.getAllByLabelText('More actions')[0]!);
    await userEvent.click(await screen.findByText('Delete item'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Item' }));

    await waitFor(() => {
      expect(mockApi.delete).toHaveBeenCalledWith(`/api/price-book/items/${h.ACTIVE_ID}`);
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('✓ ACT-1 deleted'));
    // Dialog closes on success.
    expect(screen.queryByRole('button', { name: 'Delete Item' })).toBeNull();
  });

  it('archives a referenced item and toasts the reference count (mode:"archived")', async () => {
    mockApi.delete.mockResolvedValue({
      data: { mode: 'archived', message: 'Item archived', referenceCount: 3 },
    });
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('ACT-1');
    await userEvent.click(screen.getAllByLabelText('More actions')[0]!);
    await userEvent.click(await screen.findByText('Delete item'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Item' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('✓ ACT-1 archived · on 3 records, kept for history'),
    );
  });

  it('toasts a failure message and leaves the item in place if the delete request rejects', async () => {
    mockApi.delete.mockRejectedValue(new Error('network down'));
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('ACT-1');
    await userEvent.click(screen.getAllByLabelText('More actions')[0]!);
    await userEvent.click(await screen.findByText('Delete item'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Item' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('✗ Could not delete ACT-1 - try again'));
  });

  it('offers "Restore item" (not "Delete item") for an archived row and restores it', async () => {
    mockApi.patch.mockResolvedValue({ data: { data: { ...ARCHIVED_ITEM, isActive: true } } });
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await screen.findByText('ACT-1');
    await userEvent.click(screen.getByLabelText('Show archived items'));
    await screen.findByText('ARC-1');

    // Row 1 = ACT-1 (active) → Delete; row 2 = ARC-1 (archived) → Restore.
    await userEvent.click(screen.getAllByLabelText('More actions')[1]!);
    expect(screen.queryByText('Delete item')).toBeNull();
    await userEvent.click(await screen.findByText('Restore item'));

    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledWith(`/api/price-book/items/${h.ARCHIVED_ID}`, {
        is_active: true,
      });
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('✓ ARC-1 restored'));
  });
});
