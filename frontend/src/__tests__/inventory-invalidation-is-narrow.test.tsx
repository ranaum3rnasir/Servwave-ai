// A write must refresh only the queries it can actually have changed.
//
// The defect this pins: every mutation in lib/api/inventory.ts ended in
//
//   onSuccess: invalidating(qc, ['inventory'])
//
// and there are 22 query hooks under that prefix. One catalog delete therefore
// refetched every inventory query mounted on the page - purchase orders, stock
// movements, assets, job stages and the rest. The general API limiter allows
// 100 requests per 60 seconds per user across all of /api, so a person clicking
// at normal speed can exhaust it; and when the refused request is the one that
// would have refreshed the list, the row the server already deleted stays on
// screen indefinitely. The fan-out is what makes the stale row permanent.
//
// The seam is the module's exported hooks against a real QueryClient with the
// HTTP client mocked. What is asserted is observable cache state: which seeded
// queries `invalidateQueries` actually marked stale. Nothing here inspects how
// a hook is written.
//
// Two mutations deliberately keep the wide key, and that is locked in below so
// a later tidy-up cannot quietly narrow them: a CSV import creates items,
// categories, brands, units and vendors in one call, and a PO receive moves
// stock, writes movements, changes low-stock, advances the PO and its activity
// and re-costs the job. Narrowing either would be a new bug.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as inv from '@/lib/api/inventory';

const { post, patch, put, del, get } = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/lib/axios', () => ({
  default: { post, patch, put, delete: del, get },
}));

/**
 * Every query key under the ['inventory'] prefix, one representative instance
 * each. Restated here on purpose: the test is the independent statement of what
 * exists to be invalidated.
 */
const ALL_KEYS: Record<string, readonly unknown[]> = {
  items: ['inventory', 'items', { includeArchived: false }],
  vendors: ['inventory', 'vendors'],
  brands: ['inventory', 'brands'],
  finishes: ['inventory', 'finishes'],
  uomOptions: ['inventory', 'uom-options'],
  categories: ['inventory', 'categories'],
  itemGroups: ['inventory', 'item-groups'],
  locations: ['inventory', 'locations'],
  branches: ['inventory', 'branches'],
  movements: ['inventory', 'movements', {}],
  lowStock: ['inventory', 'low-stock', {}],
  purchaseOrders: ['inventory', 'purchase-orders'],
  poActivity: ['inventory', 'po-activity', 'po_1'],
  jobStages: ['inventory', 'job-stages'],
  stockApprovals: ['inventory', 'stock-approvals'],
  jobs: ['inventory', 'jobs'],
  techs: ['inventory', 'techs'],
  myVan: ['inventory', 'my-van'],
  assets: ['inventory', 'assets', {}, 1],
  assetEvents: ['inventory', 'assets', 'ast_1', 'events'],
  jobMaterialCost: ['inventory', 'job-material-cost', 'job_1'],
};
const ALL_NAMES = Object.keys(ALL_KEYS);

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Seed every query so each one is present in the cache and can be marked stale. */
function seedEveryQuery() {
  for (const key of Object.values(ALL_KEYS)) queryClient.setQueryData(key, []);
}

/** The names of the seeded queries `invalidateQueries` actually marked stale. */
function staleNames(): string[] {
  const cache = queryClient.getQueryCache();
  return ALL_NAMES.filter((name) => cache.find({ queryKey: ALL_KEYS[name] })?.state.isInvalidated);
}

/** Run a mutation to completion and report which seeded queries it left stale. */
async function stalenessAfter<T>(
  useHook: () => { mutateAsync: (args: never) => Promise<unknown> },
  args: T,
): Promise<string[]> {
  seedEveryQuery();
  const { result } = renderHook(() => useHook(), { wrapper });
  await result.current.mutateAsync(args as never);
  // `invalidating` deliberately does not await the refresh (#1615), so the
  // marking can land a tick after the write settles.
  await waitFor(() => expect(staleNames().length).toBeGreaterThan(0));
  return staleNames();
}

/**
 * Every mutation in the module, with the narrow key set its write can affect
 * and the reasoning for it. `wide: true` marks a deliberate exception.
 */
const mutations: {
  name: string;
  hook: () => { mutateAsync: (args: never) => Promise<unknown> };
  args: unknown;
  affects: string[];
  wide?: true;
}[] = [
  // Item writes. The item list obviously; item groups list their member items,
  // and both the low-stock rows and the movement log are joined server-side
  // against the live item name/sku, so a rename must refresh them too.
  { name: 'useUpsertItem', hook: inv.useUpsertItem, args: { name: 'X' }, affects: ['items', 'itemGroups', 'lowStock', 'movements'] },
  { name: 'useDeleteItem', hook: inv.useDeleteItem, args: { id: 'i1' }, affects: ['items', 'itemGroups', 'lowStock', 'movements'] },
  { name: 'useRestoreItem', hook: inv.useRestoreItem, args: { id: 'i1' }, affects: ['items', 'itemGroups', 'lowStock', 'movements'] },

  // Catalog writes: their own list, plus the item list that displays the label.
  { name: 'useUpsertCategory', hook: inv.useUpsertCategory, args: { name: 'C' }, affects: ['categories', 'items'] },
  { name: 'useUpsertBrand', hook: inv.useUpsertBrand, args: { name: 'B' }, affects: ['brands', 'items'] },
  { name: 'useUpsertFinish', hook: inv.useUpsertFinish, args: { name: 'F' }, affects: ['finishes', 'items'] },
  { name: 'useUpsertUomOption', hook: inv.useUpsertUomOption, args: { name: 'U' }, affects: ['uomOptions', 'items'] },
  // An item group is a bundle OF items; no item displays its group.
  { name: 'useUpsertItemGroup', hook: inv.useUpsertItemGroup, args: { name: 'G' }, affects: ['itemGroups'] },

  { name: 'useDeleteBrand', hook: inv.useDeleteBrand, args: { id: 'b1' }, affects: ['brands', 'items'] },
  { name: 'useDeleteFinish', hook: inv.useDeleteFinish, args: { id: 'f1' }, affects: ['finishes', 'items'] },
  { name: 'useDeleteUomOption', hook: inv.useDeleteUomOption, args: { id: 'u1' }, affects: ['uomOptions', 'items'] },
  { name: 'useDeleteCategory', hook: inv.useDeleteCategory, args: { id: 'c1' }, affects: ['categories', 'items'] },
  { name: 'useDeleteItemGroup', hook: inv.useDeleteItemGroup, args: { id: 'g1' }, affects: ['itemGroups'] },

  // A location holds stock, appears on every item's stock rows and on the
  // low-stock rows, and one of them is the requester's own van.
  { name: 'useUpsertLocation', hook: inv.useUpsertLocation, args: { name: 'L', type: 'WAREHOUSE' }, affects: ['locations', 'items', 'lowStock', 'myVan'] },
  { name: 'useDeleteLocation', hook: inv.useDeleteLocation, args: { id: 'l1' }, affects: ['locations', 'items', 'lowStock', 'myVan'] },
  // A branch owns locations and nothing else.
  { name: 'useUpsertBranch', hook: inv.useUpsertBranch, args: { name: 'Br' }, affects: ['branches', 'locations'] },
  { name: 'useDeleteBranch', hook: inv.useDeleteBranch, args: { id: 'br1' }, affects: ['branches', 'locations'] },
  // A vendor's name is displayed on items and on purchase orders.
  { name: 'useUpsertVendor', hook: inv.useUpsertVendor, args: { name: 'V' }, affects: ['vendors', 'items', 'purchaseOrders'] },
  { name: 'useDeleteVendor', hook: inv.useDeleteVendor, args: { id: 'v1' }, affects: ['vendors', 'items', 'purchaseOrders'] },

  // Stock writes: on-hand lives on the item rows, each one records a movement,
  // each one can cross a reserve level, and a van is a location.
  { name: 'useSetQuantity', hook: inv.useSetQuantity, args: { itemId: 'i1', locationId: 'l1', countedQty: 2, reason: 'count' }, affects: ['items', 'movements', 'lowStock', 'myVan'] },
  { name: 'useRestock', hook: inv.useRestock, args: { itemId: 'i1', locationId: 'l1', qty: 1 }, affects: ['items', 'movements', 'lowStock', 'myVan'] },
  { name: 'useBulkRestock', hook: inv.useBulkRestock, args: { lines: [] }, affects: ['items', 'movements', 'lowStock', 'myVan'] },
  { name: 'useTransferStock', hook: inv.useTransferStock, args: {}, affects: ['items', 'movements', 'lowStock', 'myVan'] },
  // Thresholds change what counts as low without moving any stock, so no
  // movement is written.
  { name: 'useSetThresholds', hook: inv.useSetThresholds, args: { itemId: 'i1', locationId: 'l1', min: 1, max: 2 }, affects: ['items', 'lowStock'] },

  // Purchase orders. Creating and editing change the PO and its activity
  // timeline; neither moves stock - only a receive does. (There is no send:
  // ServWave does not send POs.)
  { name: 'useCreatePO', hook: inv.useCreatePO, args: {}, affects: ['purchaseOrders', 'poActivity'] },
  { name: 'useUpdatePO', hook: inv.useUpdatePO, args: { id: 'po_1' }, affects: ['purchaseOrders', 'poActivity'] },
  // PR 2 lifecycle verbs: mark-ordered and delete change the PO and its timeline only.
  { name: 'useMarkOrdered', hook: inv.useMarkOrdered, args: { id: 'po_1' }, affects: ['purchaseOrders', 'poActivity'] },
  { name: 'useDeletePO', hook: inv.useDeletePO, args: 'po_1', affects: ['purchaseOrders', 'poActivity'] },

  // Job staging writes touch job_stages only - the controller writes no stock
  // level and no movement.
  { name: 'useCreateStage', hook: inv.useCreateStage, args: {}, affects: ['jobStages'] },
  { name: 'useReceiveStageLine', hook: inv.useReceiveStageLine, args: {}, affects: ['jobStages'] },
  { name: 'useNotifyTechReady', hook: inv.useNotifyTechReady, args: {}, affects: ['jobStages'] },
  { name: 'useEmailStagePickup', hook: inv.useEmailStagePickup, args: { stageId: 's1', to: [], subject: 's' }, affects: ['jobStages'] },

  // Feature-parked endpoints; whatever they would touch, it is their own list.
  { name: 'useCreateApproval', hook: inv.useCreateApproval, args: {}, affects: ['stockApprovals'] },
  { name: 'useDecideApproval', hook: inv.useDecideApproval, args: {}, affects: ['stockApprovals'] },

  // Deliberately wide, both of them.
  { name: 'useImportItemsCSV', hook: inv.useImportItemsCSV, args: { items: [] }, affects: ALL_NAMES, wide: true },
  { name: 'useReceivePO', hook: inv.useReceivePO, args: { poId: 'po_1', destinationLocationId: 'l1', lines: [] }, affects: ALL_NAMES, wide: true },
];

describe('inventory mutations invalidate only what they can have changed', () => {
  beforeEach(() => {
    for (const fn of [post, patch, put, del, get]) {
      fn.mockReset();
      fn.mockResolvedValue({ data: { data: {}, brand: {}, finish: {}, uomOption: {}, vendor: {}, location: {}, branch: {}, purchaseOrder: {}, success: true } });
    }
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
  });

  it.each(mutations)('$name invalidates exactly its own key set', async ({ hook, args, affects }) => {
    const stale = await stalenessAfter(hook, args);
    expect(stale.sort()).toEqual([...affects].sort());
  });

  // Story 17, stated in the user's own terms rather than as a key list.
  it('a catalog delete does not disturb purchase orders, movements, assets or job stages', async () => {
    const stale = await stalenessAfter(inv.useDeleteBrand, { id: 'b1' });

    expect(stale).not.toContain('purchaseOrders');
    expect(stale).not.toContain('poActivity');
    expect(stale).not.toContain('movements');
    expect(stale).not.toContain('assets');
    expect(stale).not.toContain('assetEvents');
    expect(stale).not.toContain('jobStages');
  });

  // Story 18: narrowing must not leave stale labels behind.
  it('a brand rename still refreshes the item lists that display the brand name', async () => {
    const stale = await stalenessAfter(inv.useUpsertBrand, { id: '11111111-1111-1111-1111-111111111111', name: 'Renamed' });

    expect(stale).toContain('items');
    expect(stale).toContain('brands');
  });

  // Story 22: the regression guard. Every mutation but the two deliberate
  // exceptions must leave at least one inventory query alone.
  it.each(mutations.filter((m) => !m.wide))(
    '$name does not invalidate the whole inventory prefix',
    async ({ hook, args }) => {
      const stale = await stalenessAfter(hook, args);
      expect(stale.length).toBeLessThan(ALL_NAMES.length);
    },
  );

  it.each(mutations.filter((m) => m.wide))(
    '$name is a deliberate exception and still invalidates the whole inventory prefix',
    async ({ hook, args }) => {
      const stale = await stalenessAfter(hook, args);
      expect(stale.sort()).toEqual([...ALL_NAMES].sort());
    },
  );
});
