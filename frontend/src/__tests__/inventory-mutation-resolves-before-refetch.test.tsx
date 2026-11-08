// An inventory write must resolve when the WRITE resolves, not when the whole
// ['inventory'] cache has finished refetching.
//
// The defect this pins: every mutation in lib/api/inventory.ts wrote
//
//   onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] })
//
// and an arrow with no braces RETURNS that promise. TanStack Query awaits
// whatever onSuccess returns before settling `mutateAsync`, and
// invalidateQueries only settles once every matching active query has finished
// refetching. So one stalled inventory query - a request that is retry-paused,
// or simply slow - left `mutateAsync` pending forever.
//
// That is not an abstract concern. AddBrandDialog (and the vendor, category and
// finish dialogs beside it) sets `saving = true` on click, disables its save
// button on it, and clears it in a `finally` after awaiting the mutation. With
// the mutation never settling, the brand was created server-side (201) while
// the dialog stayed open with its save button permanently disabled - the button
// read as "blocked" with nothing on screen explaining why.
//
// The stall is modelled here with a query that never resolves, which is the
// honest shape of a retry-paused fetch: no rejection to catch, no timeout, just
// a promise that never settles. A test that let the refetch fail instead would
// pass either way, because invalidateQueries swallows a refetch error and
// resolves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpsertBrand } from '@/lib/api/inventory';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(async () => ({ data: { brand: { id: 'brd_srv_1', name: 'Mul-T-Lock' } } })),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Seed a live ['inventory'] query whose fetch never settles, then park it in a
 * success state so the invalidation has something ACTIVE to refetch. `retry:
 * false` keeps the never-settling promise from being mistaken for a retry loop.
 */
function seedStalledInventoryQuery() {
  queryClient.setQueryData(['inventory', 'items'], []);
  // An observer keeps the query ACTIVE - invalidateQueries only awaits those.
  const observer = new QueryObserver(queryClient, {
    queryKey: ['inventory', 'items'],
    queryFn: () => new Promise(() => {}),
    retry: false,
  });
  return observer.subscribe(() => {});
}

describe('inventory mutations settle independently of the cache refetch', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  it('resolves useUpsertBrand even while an inventory query is stalled', async () => {
    seedStalledInventoryQuery();

    const { result } = renderHook(() => useUpsertBrand(), { wrapper });

    const saved = await Promise.race([
      result.current.mutateAsync({ name: 'Mul-T-Lock' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('mutateAsync never settled')), 1000),
      ),
    ]);

    expect(saved).toMatchObject({ id: 'brd_srv_1' });
  });

  // The key is the brand write's own narrow set now, not the whole ['inventory']
  // prefix (#1639): a blanket invalidation refetched all 22 inventory queries and
  // could exhaust the 100-per-60s API limiter. The property under test is
  // unchanged - the refresh still fires, and still is not awaited. The stalled
  // query above is ['inventory', 'items'], which a brand write does still
  // refresh, so this file's stall guard keeps its teeth.
  it('still invalidates the brand write\'s own keys', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpsertBrand(), { wrapper });
    await result.current.mutateAsync({ name: 'Medeco' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inventory', 'brands'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inventory', 'items'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['inventory'] });
  });
});
