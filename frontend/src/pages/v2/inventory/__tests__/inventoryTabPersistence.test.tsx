/**
 * SRVW-257 - switching Inventory sections must not behave like leaving for a
 * different module.
 *
 * The reported cause looked like it was `inventory.routes.tsx`'s six separate
 * `<Route>` entries for one page component (InventoryPage) - each one a
 * distinct match, so surely React remounts the component when the match
 * changes. That theory does not survive testing: a probe with just those six
 * routes under a plain `<Routes>` keeps state across a switch, because React
 * reconciles on element TYPE, not on which Route object matched, and
 * `InventoryPage` is the same function reference at every one of the six
 * paths.
 *
 * The actual cause is `V2AppLayout.tsx`'s `<Suspense key={moduleKeyOf(pathname)}>`.
 * `moduleKeyOf` used to slice a pathname to its first three `/`-separated
 * pieces - a leftover from the retired `/v2` URL prefix, when that slice
 * landed on the segment AFTER the module name. With the prefix gone, that
 * slice lands ON the module's own second segment, so `/inventory` and
 * `/inventory/assets` produced different keys and the Suspense boundary - and
 * everything below it, including InventoryPage - remounted on every tab
 * switch, dropping filters, search text and scroll position with it. Fixed in
 * `moduleKeyOf` with an explicit allowlist for Inventory's six tab segments,
 * left everything else (LeadFormPage's `/new` vs `/:id/edit`, and similar)
 * on the old per-segment behaviour those pages rely on to reset per entity.
 *
 * This suite exercises the real shell (`V2AppLayout`) with the same six-route
 * shape production uses, and switches tabs through the actual `TabStrip`
 * click path (`navigate(VIEW_PATHS[...])`) rather than reaching in and
 * calling a setter - the same thing a user does clicking "Assets" then
 * "Items".
 */
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '@/pages/v2/V2AppLayout';
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

vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual,
    useLogisticOrders: () => ({
      data: { data: [], page: 1, limit: 1, total: 0 },
      isLoading: false,
      isError: false,
    }),
  };
});

// Shell-collateral mocks: this suite mounts the real V2AppLayout, so the
// providers it reaches for have to exist as something.
vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const USER_ID = '00000000-0000-0000-0000-000000000001';

function mockAuthUser(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
}

// The same six-route shape as inventory.routes.tsx - one page component,
// six paths, mirrored here (not imported) because the production file also
// wraps the routes in ProtectedRoute/RequireFeature guards this suite does
// not need to exercise.
function renderShell(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/inventory/staging" element={<InventoryPage />} />
              <Route path="/inventory/assets" element={<InventoryPage />} />
              <Route path="/inventory/low-stock" element={<InventoryPage />} />
              <Route path="/inventory/activity" element={<InventoryPage />} />
              <Route path="/inventory/logistic-orders" element={<InventoryPage />} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SRVW-257 - switching Inventory tabs keeps the shell mounted', () => {
  it('typed search text on Items survives a round trip through Assets via the TabStrip', async () => {
    mockAuthUser({
      id: USER_ID,
      email: 'admin@test.com',
      first_name: 'Test',
      last_name: 'Admin',
      role: 'ADMIN',
      org_features: ['inventory'],
    });
    const user = userEvent.setup();
    renderShell('/inventory');

    const search = screen.getByPlaceholderText('Search inventory…');
    await user.type(search, 'widget');
    expect((search as HTMLInputElement).value).toBe('widget');

    await user.click(screen.getByRole('tab', { name: /Assets/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Assets' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^Items/ }));

    expect((screen.getByPlaceholderText('Search inventory…') as HTMLInputElement).value).toBe('widget');
  });

  it('deep-linking straight to a section still lands on that section (Suspense key change does not break routing)', () => {
    mockAuthUser({
      id: USER_ID,
      email: 'admin@test.com',
      first_name: 'Test',
      last_name: 'Admin',
      role: 'ADMIN',
      org_features: ['inventory'],
    });

    renderShell('/inventory/low-stock');

    expect(screen.getByRole('tab', { name: /Low Stock/i })).toHaveAttribute('aria-selected', 'true');
  });
});
