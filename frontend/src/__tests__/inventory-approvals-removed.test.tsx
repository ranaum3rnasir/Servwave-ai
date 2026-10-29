// P0 §C / QA-901 — stock-approvals feature-parking, frontend side.
//
// Contract under test:
//   • InventoryPage renders WITHOUT an Approvals tab (only Items + Staging)
//     and without the "Needs Approval" stat tile.
//   • The legacy /inventory/approvals deep link redirects to /inventory
//     (route shape mirrors App.tsx: <Navigate to="/inventory" replace />) —
//     no dead deep-links, no approvals surface.
//
// Seam hooks are mocked with stable, already-resolved data — mocking axios
// would leave the queries pending and the page's `?? []` defaults re-fire its
// seed effects in a loop that hangs jsdom (see purchase-orders-deeplink).
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
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
    usePurchaseOrders: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useTechs: stable(EMPTY),
    useStockApprovals: stable(EMPTY),
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
    useCreateApproval: mutation,
    useDecideApproval: mutation,
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

// Mirrors the routed inventory route block (`pages/v2/routes/inventory.routes.tsx`)
// after the P0 parking: the approvals path is a redirect, not an InventoryPage
// mount. `v2Path` is a no-op shim, so the redirect target is `/inventory` there
// too.
function InventoryRoutes() {
  return (
    <Routes>
      <Route path="/inventory" element={<InventoryPage />} />
      <Route path="/inventory/staging" element={<InventoryPage />} />
      <Route
        path="/inventory/approvals"
        element={<Navigate to="/inventory" replace />}
      />
    </Routes>
  );
}

describe('v2 InventoryPage - approvals surface removed (QA-901)', () => {
  it('renders Items + Staging tabs and NO Approvals tab or stat tile', () => {
    renderWithProviders(<InventoryRoutes />, { initialEntries: ['/inventory'] });

    expect(screen.getByRole('tab', { name: /Items/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Staging/ })).toBeInTheDocument();
    expect(screen.queryByText('Approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Approval')).not.toBeInTheDocument();
  });

  it('/inventory/approvals deep link redirects to the Items view', () => {
    renderWithProviders(<InventoryRoutes />, {
      initialEntries: ['/inventory/approvals'],
      ability: inventoryWriteAbility(),
    });

    // The Items view renders (redirect landed on /inventory) …
    expect(
      screen.getByRole('heading', { name: 'Inventory' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Item/ })).toBeInTheDocument();
    // … and no approvals surface exists anywhere.
    expect(screen.queryByText('Approvals')).not.toBeInTheDocument();
  });
});
