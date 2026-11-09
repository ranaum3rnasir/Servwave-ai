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
import { renderWithProviders, inventoryWriteAbility, seedMySwitches } from './helpers';
import { inventoryElement } from '@/__tests__/harness/inventoryPage';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  return (await import('@/__tests__/harness/inventoryApiStub')).inventoryApi(
    await importOriginal<typeof import('@/lib/api/inventory')>(),
    {
      reads: {
        usePurchaseOrders: [],
        useInventoryJobs: [],
        useTechs: [],
        useStockApprovals: [],
      },
      mutations: ['useUpsertLocation', 'useUpsertBranch', 'useRestock', 'useTransferStock', 'useImportItemsCSV', 'useCreatePO', 'useReceivePO', 'useCreateStage', 'useReceiveStageLine', 'useNotifyTechReady', 'useCreateApproval', 'useDecideApproval', 'useUpsertVendor', 'useDeleteVendor'],
    },
  );
});

// Mirrors the routed inventory route block (`pages/v2/routes/inventory.routes.tsx`)
// after the P0 parking: the approvals path is a redirect, not an InventoryPage
// mount. `v2Path` is a no-op shim, so the redirect target is `/inventory` there
// too.
function InventoryRoutes() {
  return (
    <Routes>
      <Route path="/inventory" element={inventoryElement()} />
      <Route path="/inventory/staging" element={inventoryElement()} />
      <Route
        path="/inventory/approvals"
        element={<Navigate to="/inventory" replace />}
      />
    </Routes>
  );
}

describe('v2 InventoryPage - approvals surface removed (QA-901)', () => {
  it('renders Items + Staging tabs and NO Approvals tab or stat tile', () => {
    seedMySwitches({ view_stock: true });
    renderWithProviders(<InventoryRoutes />, { initialEntries: ['/inventory'], ability: inventoryWriteAbility() });

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
