// useInventoryItems must return the org's WHOLE catalog, not the first page.
//
// parsePagination (backend/src/lib/pagination.ts) caps `limit` at 100 for every
// paginated endpoint, so a single request can never return more than 100 items.
// The hook previously issued exactly one `?limit=100` request and handed the
// first page straight to its 17 consumers - every item picker in Inventory and
// Jobs (Transfer, Restock, Scan, Create PO from Job, Asset, Stage dialogs) plus
// the Stock grid, Price Book and Vendors pages. An org past 100 catalog items
// silently lost the tail: items 101+ were unsearchable and unpickable anywhere.
//
// The fix pages through the {data, meta} envelope until `meta.totalPages` is
// exhausted, so the hook keeps its `Item[]` contract and no consumer changes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { useInventoryItems } from '@/lib/api/inventory';
import api from '@/lib/axios';

// One catalog page: `n` synthetic items numbered from `from`.
const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `item-${from + i}`, name: `Item ${from + i}` }));

// One client per renderHook call - a client rebuilt on each render would
// refetch and make the request counts below meaningless.
const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children as ReactNode);
};

const get = vi.spyOn(api, 'get');

describe('useInventoryItems - full catalog paging', () => {
  // One hoisted spy reset per test. vi.restoreAllMocks() does not detach a spy
  // from this axios instance, so a fresh vi.spyOn per test would keep counting
  // the previous test's calls.
  beforeEach(() => get.mockReset());

  it('pages past the 100-item server cap and returns every item', async () => {
    // 598 items - the Northwind Services Zoho import - across 6 pages of 100.
    const total = 598;
    get.mockImplementation((url: string) => {
      const p = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      const from = (p - 1) * 100 + 1;
      const count = Math.min(100, total - (from - 1));
      return Promise.resolve({
        data: { data: page(from, count), meta: { page: p, limit: 100, total, totalPages: 6 } },
      }) as ReturnType<typeof api.get>;
    });

    const { result } = renderHook(() => useInventoryItems(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(598);
    expect(result.current.data?.[0]).toMatchObject({ id: 'item-1' });
    expect(result.current.data?.[597]).toMatchObject({ id: 'item-598' });
    expect(get).toHaveBeenCalledTimes(6);
  });

  it('issues a single request when the catalog fits on one page', async () => {
    get.mockResolvedValue({
      data: { data: page(1, 12), meta: { page: 1, limit: 100, total: 12, totalPages: 1 } },
    } as Awaited<ReturnType<typeof api.get>>);

    const { result } = renderHook(() => useInventoryItems(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(12);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('threads include_archived through every page request', async () => {
    get.mockImplementation((url: string) => {
      const p = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      return Promise.resolve({
        data: { data: page((p - 1) * 100 + 1, 100), meta: { page: p, limit: 100, total: 200, totalPages: 2 } },
      }) as ReturnType<typeof api.get>;
    });

    const { result } = renderHook(() => useInventoryItems(true), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(get).toHaveBeenCalledTimes(2);
    for (const [url] of get.mock.calls) expect(url).toContain('include_archived=true');
  });

  it('stops at the meta page count even if a page comes back full', async () => {
    // Guards the loop: a server that always returns 100 rows must not spin.
    get.mockResolvedValue({
      data: { data: page(1, 100), meta: { page: 1, limit: 100, total: 100, totalPages: 1 } },
    } as Awaited<ReturnType<typeof api.get>>);

    const { result } = renderHook(() => useInventoryItems(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.data).toHaveLength(100);
  });
});
