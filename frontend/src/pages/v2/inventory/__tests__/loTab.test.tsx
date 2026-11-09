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

import { buildAbility } from '@/lib/ability';
import { seedMySwitches } from '@/__tests__/helpers';
import { renderInventory } from '@/__tests__/harness/inventoryPage';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  return (await import('@/__tests__/harness/inventoryApiStub')).inventoryApi(
    await importOriginal<typeof import('@/lib/api/inventory')>(),
    {
      reads: {
        useLowStock: [],
        useAssets: { data: [], meta: { total: 0 } },
        usePurchaseOrders: [],
        useInventoryJobs: [],
        useTechs: [],
      },
      mutations: ['useUpsertItem', 'useUpsertLocation', 'useUpsertBranch', 'useRestock', 'useTransferStock', 'useImportItemsCSV', 'useCreatePO', 'useReceivePO', 'useCreateStage', 'useReceiveStageLine', 'useNotifyTechReady', 'useUpsertVendor', 'useDeleteVendor'],
    },
  );
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
    // The tab needs View logistic orders.
    seedMySwitches({ view_logistic_orders: true });
    renderInventory({
      entry: '/inventory',
      ability: buildAbility([{ action: 'read', subject: 'LogisticOrder' }]),
    });

    const tab = screen.getByRole('tab', { name: /Logistic Orders/i });
    // Total-count pill ...
    expect(within(tab).getByText('7')).toBeInTheDocument();
    // ... and the pending-approval highlight badge.
    expect(within(tab).getByText('3 pending')).toBeInTheDocument();
  });

  it('dispatches /v2/inventory/logistic-orders to the REBUILT LOList surface', () => {
    renderInventory({
      entry: '/inventory/logistic-orders',
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
