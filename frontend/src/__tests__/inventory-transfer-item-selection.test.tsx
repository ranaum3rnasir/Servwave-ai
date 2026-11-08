// Transfer dialog showed "0 on-hand" for every location against real org data.
//
// Root cause (verified against origin/staging, not inferred): the dialog reads
// `initialItemId` only in a useState initializer, while InventoryPage mounts
// the dialog unconditionally. The prop therefore never re-syncs, and a latch
// effect parks `itemId` on the first material item in the catalog. Opening
// Transfer from row 711068441 renders "DEC-BLK-01 - Decor black for mortise
// lockset" instead, an item with no stock rows - so every location reads 0,
// both cards read 0, and Quantity offers Max (0). That single defect
// reproduces the whole reported symptom.
//
// A second, latent defect rides along: the dialog self-fetches
// `useInventoryItems()` (includeArchived = false) while the page calls
// `useInventoryItems(showArchived)`. Different query key -> different cache,
// so with "Show archived" on the selected row is absent from the dialog's
// list entirely and cannot be resolved at all.
//
// NOT in scope: the `loc_wh_main` / `loc_van_mike` seeding. SRVW-93 already
// replaced it with `defaultFromId`/`defaultToId` derived from real locations.
// The two POST assertions below pin that fix so it cannot regress silently.
//
// Every location id here is a real uuid, deliberately: the pre-existing
// inventory-transfer-shortage suite uses the mock constants as its fixture
// ids, so it could not have caught a regression back to them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  LOC_HQ: 'cccccdd1-0000-4000-8000-000000000001',
  LOC_VAN: 'cccccdd1-0000-4000-8000-000000000002',
  ITEM_FIRST: 'bbbbbbb1-0000-4000-8000-000000000001',
  ITEM_TARGET: 'bbbbbbb1-0000-4000-8000-000000000002',
  ITEM_ARCHIVED: 'bbbbbbb1-0000-4000-8000-000000000003',
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    // Explicitly null: the location default must fall through to the first real
    // location rather than silently relying on an org default that may be unset.
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: null },
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });

  const locations = [
    { id: h.LOC_HQ, name: 'ALPHA HEADQUARTERS', type: 'warehouse', branch: 'HQ' },
    { id: h.LOC_VAN, name: 'Locksmith Van - Adam', type: 'truck', branch: 'HQ' },
  ];

  const base = {
    category: 'Hardware',
    trade: 'general',
    kind: 'material',
    uom: 'EA',
    unitCost: 5,
    sellPrice: 124.99,
    serialized: false,
    hazmat: false,
    trackInventory: true,
    status: 'active',
    vendor: 'Acme Supply',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  // First material item in the catalog, and carries NO stock rows - this is what
  // the dialog used to latch onto, and why every location read 0 on-hand.
  const firstItem = {
    ...base,
    id: h.ITEM_FIRST,
    sku: 'DEC-BLK-01',
    name: 'Decor black for mortise lockset',
    stock: [] as { locationId: string; onHand: number }[],
  };
  // The item the user actually opens Transfer on: 39 on hand across two locations.
  const targetItem = {
    ...base,
    id: h.ITEM_TARGET,
    sku: '711068441',
    name: 'BEST 4 1/2 inch Mortise hinge FULL SURFACE (Aluminum)',
    stock: [
      { locationId: h.LOC_HQ, onHand: 30 },
      { locationId: h.LOC_VAN, onHand: 9 },
    ],
  };
  const archivedItem = {
    ...base,
    id: h.ITEM_ARCHIVED,
    sku: 'ARC-99',
    name: 'Archived closer arm',
    isActive: false,
    stock: [{ locationId: h.LOC_HQ, onHand: 7 }],
  };

  // Both lists are built ONCE. The page mirrors `itemsQuery.data` into local
  // state through an effect keyed on that array, so returning a fresh literal
  // per call would re-arm the effect every render and spin forever - a
  // synchronous loop that blocks the event loop, so vitest's testTimeout never
  // fires and the run hangs instead of failing.
  const ACTIVE = [firstItem, targetItem];
  const WITH_ARCHIVED = [firstItem, targetItem, archivedItem];

  return {
    ...actual,
    // Arg-aware on purpose: this is what exposes defect C. The page asks for the
    // archived-inclusive list; a dialog that self-fetches with the default gets
    // a different cache and cannot resolve the selected row.
    useInventoryItems: (includeArchived = false) => ({
      data: includeArchived ? WITH_ARCHIVED : ACTIVE,
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

async function renderPage() {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });
}

/** Open Transfer from a row's "..." menu - the path a real user takes, and the
 *  one that carries `selectedId` into the dialog. */
async function openTransferFromRow(sku: string) {
  if (!document.querySelector('table')) await renderPage();
  const row = (await screen.findByText(sku)).closest('tr');
  if (!row) throw new Error(`No row for ${sku}`);
  await userEvent.click(within(row).getByRole('button', { name: /more actions/i }));
  await userEvent.click(await screen.findByText('Transfer stock'));
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Transfer dialog - the row you open is the item you transfer', () => {
  it('shows the item whose row was opened, not the first material item (defect A)', async () => {
    const dialog = await openTransferFromRow('711068441');

    // The picker is a Radix combobox button, so its selection is its label.
    expect(dialog.getByLabelText('Item')).toHaveTextContent('711068441');
    expect(dialog.getByLabelText('Item')).not.toHaveTextContent(/Decor black/i);
  });

  it('reads that item\'s real per-location on-hand into dropdowns, cards and Max (defect A)', async () => {
    const dialog = await openTransferFromRow('711068441');

    // Source holds 30, destination holds 9 - never 0.
    expect(dialog.getByLabelText('From')).toHaveTextContent(/30 on-hand/);
    expect(dialog.getByLabelText('To Location')).toHaveTextContent(/9 on-hand/);
    expect(dialog.getByText('Max (30)')).toBeTruthy();
  });

  it('posts the opened row\'s itemId, with uuid location ids the backend schema accepts', async () => {
    const dialog = await openTransferFromRow('711068441');

    await userEvent.type(dialog.getByLabelText(/Quantity/), '3');
    await userEvent.click(dialog.getByRole('button', { name: /submit transfer/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [url, sent] = mockApi.post.mock.calls[0]!;
    expect(url).toBe('/api/inventory/transfer');
    expect(sent.itemId).toBe(h.ITEM_TARGET);
    // Pins SRVW-93: a regression to "loc_wh_main"/"loc_van_mike" fails here.
    expect(sent.fromId).toMatch(UUID_RE);
    expect(sent.toId).toMatch(UUID_RE);
    expect(sent.fromId).not.toBe(sent.toId);
  });

  it('re-syncs when a different row is opened, rather than latching to the first (defect A)', async () => {
    // Order matters: the first material item must be opened FIRST. Opening it
    // second is precisely what the broken latch already parks on, so the
    // reverse ordering passes even against the defect.
    await openTransferFromRow('DEC-BLK-01');
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    const second = await openTransferFromRow('711068441');
    expect(second.getByLabelText('Item')).toHaveTextContent('711068441');
  });

  it('resolves an item that only exists in the archived-inclusive list (defect C)', async () => {
    await renderPage();
    await userEvent.click(screen.getByLabelText('Show archived items'));

    const dialog = await openTransferFromRow('ARC-99');
    expect(dialog.getByLabelText('Item')).toHaveTextContent('ARC-99');
  });
});
