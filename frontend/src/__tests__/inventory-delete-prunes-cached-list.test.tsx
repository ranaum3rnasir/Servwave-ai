// A catalog delete must remove the row from its own cached list the moment the
// server confirms it, without waiting on any refetch.
//
// The defect this pins: every catalog delete in lib/api/inventory.ts went
// through one shared factory whose only cache effect was
//
//   onSuccess: invalidating(qc, ['inventory'])
//
// so the deleted row left the screen only once GET /api/inventory/<catalog>
// came back with a new array. Observed in production 2026-08-19 (Alpha Doors &
// Security): the audit log records pricebook.brand_deleted at 18:27:16Z and no
// such row survives in the table, yet the Manage Brands list still showed it.
// The user clicked Delete again and got "Brand not found" in red for an action
// that had already succeeded. When the refetch is the request the rate limiter
// refuses, the query keeps its previous data, the array identity never changes,
// and the stale row stays on screen indefinitely.
//
// So the removal is modelled here against a refetch that never settles - the
// honest shape of a request that is retry-paused, slow, or refused. If the
// pruning depended on the refresh at all, these assertions would not hold.
//
// The refusal cases are the other half: a 400 with a reason, a 404 and a 429
// must each leave the cached list exactly as it was. There is deliberately no
// optimistic pre-removal here, because an optimistic removal is what makes a
// failed delete look like a successful one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useDeleteBrand,
  useDeleteFinish,
  useDeleteUomOption,
  useDeleteItemGroup,
  useDeleteCategory,
  useDeleteLocation,
  useDeleteBranch,
  useDeleteVendor,
} from '@/lib/api/inventory';

const { del } = vi.hoisted(() => ({ del: vi.fn() }));

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: del,
  },
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Seed a cached list and keep it ACTIVE with an observer whose fetch never
 * settles, so nothing that follows the delete can supply the removal for it.
 * `retry: false` stops the never-settling promise reading as a retry loop.
 */
function seedStalledList(queryKey: readonly unknown[], rows: { id: string; name: string }[]) {
  queryClient.setQueryData(queryKey, rows);
  const observer = new QueryObserver(queryClient, {
    queryKey: [...queryKey],
    queryFn: () => new Promise(() => {}),
    retry: false,
  });
  return observer.subscribe(() => {});
}

/** Every catalog served by the one shared delete factory, with the list it caches. */
const catalogs = [
  { name: 'brands', hook: useDeleteBrand, queryKey: ['inventory', 'brands'] },
  { name: 'finishes', hook: useDeleteFinish, queryKey: ['inventory', 'finishes'] },
  { name: 'uom options', hook: useDeleteUomOption, queryKey: ['inventory', 'uom-options'] },
  { name: 'item groups', hook: useDeleteItemGroup, queryKey: ['inventory', 'item-groups'] },
  { name: 'categories', hook: useDeleteCategory, queryKey: ['inventory', 'categories'] },
  { name: 'locations', hook: useDeleteLocation, queryKey: ['inventory', 'locations'] },
  { name: 'branches', hook: useDeleteBranch, queryKey: ['inventory', 'branches'] },
  { name: 'vendors', hook: useDeleteVendor, queryKey: ['inventory', 'vendors'] },
] as const;

function refusal(status: number, message: string) {
  const err = new Error(message) as Error & { response: { status: number; data: unknown } };
  err.response = { status, data: { error: message } };
  return err;
}

describe('a catalog delete prunes its own cached list', () => {
  beforeEach(() => {
    del.mockReset();
    del.mockResolvedValue({ data: { success: true } });
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  it.each(catalogs)(
    'removes the deleted entry from the cached $name list with no refetch resolving',
    async ({ hook, queryKey }) => {
      seedStalledList(queryKey, [
        { id: 'keep_1', name: 'Kept' },
        { id: 'gone_1', name: 'Doomed' },
        { id: 'keep_2', name: 'Also kept' },
      ]);

      const { result } = renderHook(() => hook(), { wrapper });
      await result.current.mutateAsync({ id: 'gone_1' });

      expect(queryClient.getQueryData(queryKey)).toEqual([
        { id: 'keep_1', name: 'Kept' },
        { id: 'keep_2', name: 'Also kept' },
      ]);
    },
  );

  // The reconcile is narrowed to the delete's own key set (#1639) - the brand
  // list and the item list that prints the brand name - rather than the whole
  // ['inventory'] prefix, which refetched all 22 inventory queries per click.
  // What this case pins is unchanged: the background reconcile still fires.
  it('still invalidates its own keys after the write, as a background reconcile', async () => {
    seedStalledList(['inventory', 'brands'], [{ id: 'gone_1', name: 'Doomed' }]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteBrand(), { wrapper });
    await result.current.mutateAsync({ id: 'gone_1' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inventory', 'brands'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inventory', 'items'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['inventory'] });
  });

  it.each([
    { label: 'a 400 with a reason', status: 400, message: 'Brand is used by 3 items' },
    { label: 'a 404', status: 404, message: 'Brand not found' },
    { label: 'a 429', status: 429, message: "You're doing that too quickly." },
  ])('leaves the cached list untouched when the delete is refused with $label', async ({ status, message }) => {
    const rows = [
      { id: 'keep_1', name: 'Kept' },
      { id: 'gone_1', name: 'Doomed' },
    ];
    seedStalledList(['inventory', 'brands'], rows);
    del.mockRejectedValue(refusal(status, message));

    const { result } = renderHook(() => useDeleteBrand(), { wrapper });

    await expect(result.current.mutateAsync({ id: 'gone_1' })).rejects.toMatchObject({
      response: { status, data: { error: message } },
    });

    expect(queryClient.getQueryData(['inventory', 'brands'])).toEqual(rows);
  });

  it('does not throw when the list was never in the cache', async () => {
    const { result } = renderHook(() => useDeleteBrand(), { wrapper });

    await expect(result.current.mutateAsync({ id: 'gone_1' })).resolves.toBeDefined();
    expect(queryClient.getQueryData(['inventory', 'brands'])).toBeUndefined();
  });
});
