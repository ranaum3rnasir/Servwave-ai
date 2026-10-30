/**
 * Roles & Permissions S07.1 - the Assets tab follows See all assets and the stock write switches.
 *
 * Mounted through the v2 `InventoryPage` like `assetsView.test.tsx`, with the inventory seam mocked directly. The
 * abilities are built from the switches the server compiles them from (read, create, update, delete Inventory and
 * see_all_assets), never from a role name: the page reads only the ability.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

const h = vi.hoisted(() => {
  const OWN_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a001',
    name: 'Hammer Drill',
    serial: 'SN-100',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: { id: 'u0000000-0000-0000-0000-00000000u001', first_name: 'John', last_name: 'Tech' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
  const state = { rows: [OWN_ASSET] as (typeof OWN_ASSET)[] };
  return { OWN_ASSET, state };
});

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
    usePurchaseOrders: stable(EMPTY),
    useUpsertItem: mutation,
    useAssets: () => ({ data: { data: h.state.rows, meta: { total: h.state.rows.length } }, isLoading: false, isError: false }),
    useAssetEvents: () => ({ data: [], isLoading: false, isError: false }),
    useCreateAsset: mutation,
    useUpdateAsset: mutation,
    useDeleteAsset: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useAssetAction: mutation,
    useUploadAssetPhoto: mutation,
  };
});

vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual,
    useLogisticOrders: (filters?: { limit?: number }) => ({
      data: { data: [], page: 1, limit: filters?.limit ?? 50, total: 0 },
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>();
  return { ...actual, useUsers: () => ({ data: [], isLoading: false, isError: false }) };
});

const held = (...rules: AbilityRule[]) => buildAbility([{ action: 'read', subject: 'Inventory' }, ...rules]);

function renderAssets(rules: AbilityRule[]) {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory/assets'],
    ability: held(...rules),
  });
}

describe('Assets tab - See all assets', () => {
  beforeEach(() => {
    h.state.rows = [h.OWN_ASSET];
  });

  it('shows the holder filter and the Assignee column with See all assets on', async () => {
    renderAssets([{ action: 'see_all_assets', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    expect(screen.getByLabelText('Filter by assignee')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Assignee')).toBeInTheDocument();
  });

  it('hides the holder filter and the Assignee column with See all assets off (every row is the viewer\'s)', async () => {
    renderAssets([]);
    await screen.findByText('Hammer Drill');
    expect(screen.queryByLabelText('Filter by assignee')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).queryByText('Assignee')).not.toBeInTheDocument();
    // The rest of the row is untouched.
    expect(within(screen.getByRole('table')).getByText('SN-100')).toBeInTheDocument();
  });

  it('says "No assets assigned to you" when the scoped list is empty, and the other copy with See all assets on', async () => {
    h.state.rows = [];
    const off = renderAssets([]);
    expect(await screen.findByText('No assets assigned to you')).toBeInTheDocument();
    off.unmount();

    renderAssets([{ action: 'see_all_assets', subject: 'Inventory' }]);
    expect(await screen.findByText(/No assets yet/)).toBeInTheDocument();
    expect(screen.queryByText('No assets assigned to you')).not.toBeInTheDocument();
  });
});

describe('Assets tab - the write controls follow Create, Edit and Delete stock', () => {
  const see = { action: 'see_all_assets', subject: 'Inventory' } as const;

  beforeEach(() => {
    h.state.rows = [h.OWN_ASSET];
  });

  it('offers Add asset with Create stock only, and nothing on the row', async () => {
    renderAssets([see, { action: 'create', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    expect(screen.getByRole('button', { name: /New Asset/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions for Hammer Drill/ })).not.toBeInTheDocument();
  });

  it('offers no Add asset without Create stock', async () => {
    renderAssets([see, { action: 'update', subject: 'Inventory' }, { action: 'delete', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    expect(screen.queryByRole('button', { name: /New Asset/ })).not.toBeInTheDocument();
  });

  it('offers edit, assign or transfer, return, retire, note with Edit stock only, and no delete', async () => {
    renderAssets([see, { action: 'update', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Hammer Drill' }));
    const menu = within(await screen.findByRole('menu'));
    for (const name of [/Transfer/, /Return/, /Add note/, /Edit/, /Retire/]) {
      expect(menu.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(menu.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('offers only delete with Delete stock only', async () => {
    renderAssets([see, { action: 'delete', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Hammer Drill' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
    for (const name of [/Transfer/, /Return/, /Add note/, /Edit/, /Retire/, /^Assign$/]) {
      expect(menu.queryByRole('menuitem', { name })).not.toBeInTheDocument();
    }
  });

  it('offers the photo and edit controls on the detail panel with Edit stock only', async () => {
    renderAssets([see, { action: 'update', subject: 'Inventory' }]);
    await userEvent.click(await screen.findByText('Hammer Drill'));
    await screen.findByText('History');
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add note/ })).toBeInTheDocument();
  });

  it('hides the photo chooser in the Add asset dialog with Create stock only (the photo upload needs Edit stock)', async () => {
    renderAssets([see, { action: 'create', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    await userEvent.click(screen.getByRole('button', { name: /New Asset/ }));
    await screen.findByLabelText('Asset notes');
    expect(screen.queryByLabelText('Asset photo')).not.toBeInTheDocument();
  });

  it('offers the photo chooser in the Add asset dialog with Create and Edit stock', async () => {
    renderAssets([see, { action: 'create', subject: 'Inventory' }, { action: 'update', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    await userEvent.click(screen.getByRole('button', { name: /New Asset/ }));
    await screen.findByLabelText('Asset notes');
    expect(screen.getByLabelText('Asset photo')).toBeInTheDocument();
  });

  it('offers the photo chooser in the Edit asset dialog with Edit stock only', async () => {
    renderAssets([see, { action: 'update', subject: 'Inventory' }]);
    await screen.findByText('Hammer Drill');
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Hammer Drill' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Edit/ }));
    await screen.findByLabelText('Asset notes');
    expect(screen.getByLabelText('Asset photo')).toBeInTheDocument();
  });
});
