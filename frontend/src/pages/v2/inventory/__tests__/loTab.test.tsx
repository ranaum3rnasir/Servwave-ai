/**
 * The v2 Logistic Orders TAB, on `pages/v2/inventory/InventoryPage.tsx`.
 *
 * This began as the port of `src/__tests__/inventory-lo-tab.test.tsx`. That
 * file has since been retired - this one is a strict superset of it, and the
 * page it mounted is unrouted - so this is now the only copy of the contract.
 *
 * The component-level port lives in `loList.test.tsx`; this file is the other
 * half of what the legacy suite pinned and cannot be reached from the
 * component: the tab's own total-count pill and its amber pending-approval
 * badge, both fed by dedicated `limit: 1` queries, and the fact that
 * `/inventory/logistic-orders` dispatches the body to the LOList surface -
 * which, in v2, has to be the REBUILT one.
 *
 * Inventory seam hooks are stub-mocked (same idiom as the legacy suite) so the
 * page mounts without axios; `useLogisticOrders` hands back deterministic
 * totals.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useInventoryItems: stable(EMPTY),
    useLocations: stable(EMPTY),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    useLowStock: stable(EMPTY),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    usePurchaseOrders: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useTechs: stable(EMPTY),
    useUpsertItem: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useRestock: mutation,
    useTransferStock: mutation,
    useImportItemsCSV: mutation,
    useCreatePO: mutation,
    useReceivePO: mutation,
    useCreateStage: mutation,
    useReceiveStageLine: mutation,
    useNotifyTechReady: mutation,
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

// Pending badge = 3, total LO count = 7.
vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual,
    useLogisticOrders: (filters?: { status?: string; limit?: number }) => ({
      data: {
        data: [],
        page: 1,
        limit: filters?.limit ?? 50,
        total: filters?.status === 'PENDING_APPROVAL' ? 3 : 7,
      },
      isLoading: false,
      isError: false,
    }),
  };
});

describe('v2 InventoryPage - Logistic Orders tab', () => {
  it('renders the tab with a total-count pill and an amber pending-approval badge', () => {
    renderWithProviders(<InventoryPage />, { initialEntries: ['/inventory'] });

    const tab = screen.getByRole('tab', { name: /Logistic Orders/i });
    // Total-count pill ...
    expect(within(tab).getByText('7')).toBeInTheDocument();
    // ... and the pending-approval highlight badge.
    expect(within(tab).getByText('3 pending')).toBeInTheDocument();
  });

  it('dispatches /v2/inventory/logistic-orders to the REBUILT LOList surface', () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory/logistic-orders'],
    });

    // LOList's empty state (its own copy) proves the body dispatched to it ...
    expect(screen.getByText(/No logistic orders yet/)).toBeInTheDocument();
    // ... and the kit PageHeader's h1 proves it is the v2 copy, not the legacy
    // component (whose heading is an h2 and whose chips carry no aria-pressed).
    expect(
      screen.getByRole('heading', { level: 1, name: 'Logistic Orders' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Logistic order status' }),
    ).toBeInTheDocument();
  });
});
