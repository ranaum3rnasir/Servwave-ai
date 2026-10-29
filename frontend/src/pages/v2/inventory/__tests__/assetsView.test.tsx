/**
 * The v2 Assets tab, on the rebuilt `pages/v2/inventory/components/assetsView.tsx`
 * and its detail pane `components/assetHistoryPanel.tsx`.
 *
 * This began as the port of `src/__tests__/inventory-assets-view.test.tsx`. That
 * file has since been retired - this one is a strict superset of it, and the
 * page it mounted is unrouted - so this is now the only copy of the contract.
 *
 * Mounted through the v2 `InventoryPage`, exactly as the legacy suite mounted
 * the legacy page: the route -> view mapping is half of what that suite pinned,
 * and asserting it from the page is the only way to keep it. `viewFromPath`
 * tolerates the `/` prefix, so `/inventory/assets` selects the same view.
 *
 * The inventory seam is mocked DIRECTLY with stable, already-resolved data -
 * never axios - per the jsdom seed-loop learning the legacy suite records.
 *
 * DOCUMENTED divergence (gaps doc, "Behaviour not reproduced, slice 2"): the
 * retired row's dim moved from the `<tr>` to the Name cell, because the kit
 * DataTable has no per-row className hook. The RETIRED chip is the primary
 * signal either way and the legacy suite asserted the chip, not the opacity, so
 * nothing here changes - the dim is asserted in its new place below so the
 * divergence is pinned rather than merely described.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, inventoryWriteAbility } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';

const h = vi.hoisted(() => {
  const ACTIVE_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a001',
    name: 'DeWalt Hammer Drill',
    serial: 'SN-100',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: { id: 'b0000000-0000-0000-0000-00000000b001', name: 'Hammer Drill 20V' },
    assigned_user: { id: 'u0000000-0000-0000-0000-00000000u001', first_name: 'John', last_name: 'Tech' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
  const RETIRED_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a002',
    name: 'Old Jigsaw',
    serial: 'SN-200',
    status: 'RETIRED' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
  };
  // #2043 visual round - an asset with an EMPTY event timeline, so the
  // history panel's empty state (assetHistoryPanel.tsx) can be exercised.
  const NO_HISTORY_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a003',
    name: 'Fresh Widget',
    serial: 'SN-300',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  // Stable response objects - the mock returns the SAME reference per filter
  // shape so no render loop can start from fresh identities.
  const ACTIVE_RESP = {
    data: { data: [ACTIVE_ASSET], meta: { total: 1 } },
    isLoading: false,
    isError: false,
  };
  const ALL_RESP = {
    data: { data: [ACTIVE_ASSET, RETIRED_ASSET, NO_HISTORY_ASSET], meta: { total: 3 } },
    isLoading: false,
    isError: false,
  };
  const EVENTS = [
    // Server order (at desc): newest first.
    {
      id: 'e0000000-0000-0000-0000-00000000e002',
      type: 'NOTE' as const,
      note: 'Chuck is wobbly',
      at: '2026-07-11T10:00:00.000Z',
      user: null,
      by_user: null, // hard-deleted actor -> "Unknown user"
    },
    {
      id: 'e0000000-0000-0000-0000-00000000e001',
      type: 'ASSIGNED' as const,
      note: null,
      at: '2026-07-10T09:00:00.000Z',
      user: { id: 'u0000000-0000-0000-0000-00000000u001', first_name: 'John', last_name: 'Tech' },
      by_user: { id: 'u0000000-0000-0000-0000-00000000u009', first_name: 'Ana', last_name: 'Admin' },
    },
  ];
  const USERS = [
    {
      id: 'u0000000-0000-0000-0000-00000000u001',
      email: 'john@x.com', first_name: 'John', last_name: 'Tech', role: 'TECHNICIAN',
      is_active: true, has_login: true, phone: null, phone_ext: null,
      department_id: null, department: null,
      enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    },
  ];
  // Stable across renders, unlike the shared `mutation` factory below, so the
  // delete spec can assert on the SAME mutateAsync the component called.
  const DELETE_ASSET = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  return {
    ACTIVE_ASSET,
    RETIRED_ASSET,
    NO_HISTORY_ASSET,
    EVENTS,
    USERS,
    DELETE_ASSET,
    useAssetsMock: vi.fn((filters?: { status?: string }) =>
      filters?.status === 'ACTIVE' ? ACTIVE_RESP : ALL_RESP,
    ),
    // Keyed on asset id so NO_HISTORY_ASSET can answer an empty timeline
    // without disturbing every other spec's two-event fixture.
    useAssetEventsMock: vi.fn((id: string) => ({
      data: id === NO_HISTORY_ASSET.id ? [] : EVENTS,
      isLoading: false,
      isError: false,
    })),
  };
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
    useAssets: h.useAssetsMock,
    useAssetEvents: h.useAssetEventsMock,
    useCreateAsset: mutation,
    useUpdateAsset: mutation,
    useDeleteAsset: () => h.DELETE_ASSET,
    useAssetAction: mutation,
    useUploadAssetPhoto: mutation,
  };
});

// The v2 page carries a Logistic Orders tab the legacy page's assets spec
// never had to serve; stubbed so the tab count is deterministic and no query
// escapes to axios.
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
  return {
    ...actual,
    useUsers: () => ({ data: h.USERS, isLoading: false, isError: false }),
  };
});

function renderAssetsView() {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory/assets'],
    // #2043 - the row kebab, the history panel and its actions all gate on
    // update/delete Inventory now; this suite exercises the writer's path.
    ability: inventoryWriteAbility(),
  });
}

describe('v2 InventoryPage - Assets tab', () => {
  beforeEach(() => {
    h.useAssetsMock.mockClear();
    h.useAssetEventsMock.mockClear();
    h.DELETE_ASSET.mutateAsync.mockClear();
  });

  it('deep-links /v2/inventory/assets onto the Assets view and renders the table row', async () => {
    renderAssetsView();

    // Assets view is active (its search box), items view is not.
    expect(await screen.findByPlaceholderText('Search assets…')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search inventory…')).not.toBeInTheDocument();

    // Row cells: name / catalog subtext / serial / status / assignee / updated.
    // Scoped to the table - "John Tech" also exists as an assignee-filter option.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('DeWalt Hammer Drill')).toBeInTheDocument();
    expect(table.getByText('Hammer Drill 20V')).toBeInTheDocument();
    expect(table.getByText('SN-100')).toBeInTheDocument();
    expect(table.getByText('Active')).toBeInTheDocument();
    expect(table.getByText('John Tech')).toBeInTheDocument();
    expect(
      table.getByTitle(new Date(h.ACTIVE_ASSET.updated_at).toLocaleString()),
    ).toBeInTheDocument();
  });

  it('retired filter: defaults to status ACTIVE, toggling re-queries without status and shows the RETIRED pill', async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');

    // Default: every query so far carried status ACTIVE - retired row hidden.
    expect(h.useAssetsMock.mock.calls.length).toBeGreaterThan(0);
    expect(
      h.useAssetsMock.mock.calls.every((c) => c[0]?.status === 'ACTIVE'),
    ).toBe(true);
    expect(screen.queryByText('Old Jigsaw')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show retired'));

    // Re-query dropped the status key (all rows) and the retired row renders.
    await screen.findByText('Old Jigsaw');
    expect(
      h.useAssetsMock.mock.calls.some((c) => c[0] && !('status' in c[0])),
    ).toBe(true);
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('the retired dim moved to the Name cell (documented divergence) and the active row carries none', async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');
    fireEvent.click(screen.getByLabelText('Show retired'));

    const retiredName = await screen.findByText('Old Jigsaw');
    // The dim wraps the Name cell's content, not the row.
    expect(retiredName.closest('.opacity-60')).not.toBeNull();
    expect(retiredName.closest('tr')).not.toHaveClass('opacity-60');
    expect(screen.getByText('DeWalt Hammer Drill').closest('.opacity-60')).toBeNull();
  });

  it('row click opens the history panel with the timeline in order; null by_user renders "Unknown user"', async () => {
    renderAssetsView();
    fireEvent.click(await screen.findByText('DeWalt Hammer Drill'));

    await screen.findByText('History');
    await waitFor(() => {
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      // Server order preserved: newest (NOTE) first.
      expect(rows[0]).toHaveTextContent('Note');
      expect(rows[0]).toHaveTextContent('Chuck is wobbly');
      expect(rows[0]).toHaveTextContent('Unknown user');
      expect(rows[1]).toHaveTextContent('Assigned');
      expect(rows[1]).toHaveTextContent('John Tech');
      expect(rows[1]).toHaveTextContent('Ana Admin');
    });
  });

  it('the panel keeps its Close and Retire controls and the state-dependent action set', async () => {
    renderAssetsView();
    fireEvent.click(await screen.findByText('DeWalt Hammer Drill'));

    await screen.findByText('History');
    expect(screen.getByRole('button', { name: 'Close asset panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire asset' })).toBeInTheDocument();
    // Held by a tech -> Transfer + Return, never Assign.
    expect(screen.getByRole('button', { name: /Transfer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Return/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Assign$/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close asset panel' }));
    await waitFor(() => expect(screen.queryByText('History')).toBeNull());
  });

  it("a retired asset's panel suppresses every action but note and edit", async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');
    fireEvent.click(screen.getByLabelText('Show retired'));
    fireEvent.click(await screen.findByText('Old Jigsaw'));

    await screen.findByText('History');
    expect(screen.queryByRole('button', { name: 'Retire asset' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Transfer/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Return/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Assign$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Add note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
  });

  it('the row kebab keeps its label and its state-dependent item set', async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');

    // Radix opens the menu on pointerdown, which fireEvent.click does not send.
    await userEvent.click(
      screen.getByRole('button', { name: 'More actions for DeWalt Hammer Drill' }),
    );

    const menu = within(await screen.findByRole('menu'));
    // Assigned -> Transfer/Return, no Assign.
    expect(menu.getByRole('menuitem', { name: /Transfer/ })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /Return/ })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /^Assign$/ })).toBeNull();
    expect(menu.getByRole('menuitem', { name: /Add note/ })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /Retire/ })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  /**
   * Delete used to be a `window.confirm`. It is the app's own ConfirmDialog now
   * (`no-browser-dialogs.guard.test.ts` bans the browser one), and the failure
   * mode that swap invites is a handler that awaits a promise no rendered dialog
   * can ever settle. So both branches are driven here: confirming has to reach
   * `mutateAsync`, and declining has to reach nothing at all. A view that forgot
   * to render `{confirmDialog}` fails the first of these on the missing dialog
   * and the second by hanging silently, which is exactly the point.
   */
  async function openDeleteConfirm() {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');
    await userEvent.click(
      screen.getByRole('button', { name: 'More actions for DeWalt Hammer Drill' }),
    );
    const menu = within(await screen.findByRole('menu'));
    await userEvent.click(menu.getByRole('menuitem', { name: /Delete/ }));
    return within(await screen.findByRole('dialog'));
  }

  it('row delete confirms in the app dialog, keeping the prompt copy, and then deletes', async () => {
    const dialog = await openDeleteConfirm();

    expect(dialog.getByText('Delete "DeWalt Hammer Drill"?')).toBeInTheDocument();
    expect(
      dialog.getByText("Its history is deleted with it. This can't be undone."),
    ).toBeInTheDocument();

    await userEvent.click(dialog.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(h.DELETE_ASSET.mutateAsync).toHaveBeenCalledWith({ id: h.ACTIVE_ASSET.id }),
    );
  });

  it('cancelling the delete dialog resolves the handler without deleting', async () => {
    const dialog = await openDeleteConfirm();

    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.DELETE_ASSET.mutateAsync).not.toHaveBeenCalled();
  });

  // #2043 visual round - the empty-history copy must not point a requester
  // without `update Inventory` at an action (assign) they cannot take.
  // NO_HISTORY_ASSET only ships in ALL_RESP, so both specs toggle "Show
  // retired" to bring it into view (same route "retired filter" test uses).
  it('an empty timeline keeps the "starts with the first assign" hint for a requester who can update', async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');
    fireEvent.click(screen.getByLabelText('Show retired'));
    fireEvent.click(await screen.findByText('Fresh Widget'));

    await screen.findByText('History');
    expect(
      screen.getByText('No history yet - it starts with the first assign.'),
    ).toBeInTheDocument();
  });

  it('an empty timeline drops the hint to a bare "No history yet." for a read-only requester', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory/assets'],
      ability: buildAbility([{ action: 'read', subject: 'Inventory' }]),
    });
    await screen.findByText('DeWalt Hammer Drill');
    fireEvent.click(screen.getByLabelText('Show retired'));
    fireEvent.click(await screen.findByText('Fresh Widget'));

    await screen.findByText('History');
    expect(screen.getByText('No history yet.')).toBeInTheDocument();
    expect(screen.queryByText(/it starts with the first assign/)).not.toBeInTheDocument();
  });

  // #2043 R14 / R2 - the whole action CardContent (Transfer, Return, Assign,
  // Add note, Edit, Retire) gates on `update Inventory` as one boolean; this
  // pair pins both directions so a regression that drops that gate is caught.
  it('assetHistoryPanel: hides Transfer / Return / Add note / Edit / Retire for a read-only ability, keeps the timeline', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory/assets'],
      ability: buildAbility([{ action: 'read', subject: 'Inventory' }]),
    });
    fireEvent.click(await screen.findByText('DeWalt Hammer Drill'));

    await screen.findByText('History');
    expect(screen.queryByRole('button', { name: /Transfer/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Return/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Assign$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add note/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire asset' })).toBeNull();
    // Read side survives: the timeline still renders.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // Dismiss is a read, not a write - Close still works.
    expect(screen.getByRole('button', { name: 'Close asset panel' })).toBeInTheDocument();
  });

  it('assetHistoryPanel: keeps Transfer / Return / Add note / Edit / Retire for a write ability (must stay green)', async () => {
    renderAssetsView();
    fireEvent.click(await screen.findByText('DeWalt Hammer Drill'));

    await screen.findByText('History');
    expect(screen.getByRole('button', { name: /Transfer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Return/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire asset' })).toBeInTheDocument();
  });
});
