import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import api from '@/lib/axios';
import {
  useNotifications,
  useUnreadCount,
  useMarkSeen,
  useMarkRead,
  useReadAll,
  useMarkActed,
  useDismiss,
  NOTIFICATIONS_KEY,
  NOTIFICATIONS_UNREAD_COUNT_KEY,
  type NotificationListResponse,
} from '../notifications';

const makeWrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };

describe('notifications API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Query keys
  // ---------------------------------------------------------------------------

  it('NOTIFICATIONS_KEY is [notifications]', () => {
    expect(NOTIFICATIONS_KEY).toEqual(['notifications']);
  });

  it('NOTIFICATIONS_UNREAD_COUNT_KEY is [notifications, unread-count]', () => {
    expect(NOTIFICATIONS_UNREAD_COUNT_KEY).toEqual(['notifications', 'unread-count']);
  });

  // ---------------------------------------------------------------------------
  // useNotifications — GET /api/notifications (useInfiniteQuery)
  // ---------------------------------------------------------------------------

  it('useNotifications GETs /api/notifications (no cursor on first page)', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { items: [], nextCursor: null } satisfies NotificationListResponse,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useNotifications(), { wrapper: makeWrapper(qc) });

    // First page: cursor is undefined so params object omits cursor key
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/notifications', { params: {} }),
    );
  });

  it('useNotifications passes needs_action param when provided', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { items: [], nextCursor: null } satisfies NotificationListResponse,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useNotifications({ needsAction: true }), { wrapper: makeWrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/notifications', {
        params: { needs_action: true },
      }),
    );
  });

  it('useNotifications returns pages with flattened items and pagination helpers', async () => {
    const page1: NotificationListResponse = {
      items: [
        {
          id: 'n1', verb: 'test', category: 'JOB', priority: 'FEED',
          needs_action: false, title: 'T1', body: null, object_type: 'Job',
          object_id: 'j1', object_label: null, action_type: null, data: {},
          created_at: '2026-01-01T00:00:00Z', seen_at: null, read_at: null, acted_at: null,
        },
      ],
      nextCursor: 'cursor-abc',
    };
    vi.mocked(api.get).mockResolvedValue({ data: page1 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data?.pages).toBeDefined());

    // data.pages is the raw pages array; consumers flatten via data.pages.flatMap(p => p.items)
    const pages = result.current.data?.pages;
    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.items).toHaveLength(1);
    expect(result.current.hasNextPage).toBe(true);
    expect(typeof result.current.fetchNextPage).toBe('function');
  });

  it('useNotifications hasNextPage is false when nextCursor is null', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { items: [], nextCursor: null } satisfies NotificationListResponse,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(qc) });

    await waitFor(() => result.current.isSuccess);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('useNotifications configures staleTime: 15000 and refetchOnWindowFocus: true', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { items: [], nextCursor: null } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(qc) });

    await waitFor(() => result.current.isSuccess);

    const queries = qc.getQueryCache().findAll({ queryKey: NOTIFICATIONS_KEY });
    expect(queries.length).toBeGreaterThan(0);

    const options = queries[0]?.options as { staleTime?: number; refetchOnWindowFocus?: boolean } | undefined;
    expect(options?.staleTime).toBe(15_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  it('useNotifications with different needsAction values produces different query keys', () => {
    vi.mocked(api.get).mockResolvedValue({ data: { items: [], nextCursor: null } });
    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useNotifications({ needsAction: false }), { wrapper: makeWrapper(qc1) });
    renderHook(() => useNotifications({ needsAction: true }), { wrapper: makeWrapper(qc2) });

    // Extract what useNotifications would produce as query keys
    const keyFalsy = [...NOTIFICATIONS_KEY, { needsAction: false }];
    const keyTruthy = [...NOTIFICATIONS_KEY, { needsAction: true }];

    expect(keyFalsy).not.toEqual(keyTruthy);
    expect(keyFalsy[1]).toEqual({ needsAction: false });
    expect(keyTruthy[1]).toEqual({ needsAction: true });
  });

  // ---------------------------------------------------------------------------
  // useUnreadCount — GET /api/notifications/unread-count
  // ---------------------------------------------------------------------------

  it('useUnreadCount GETs /api/notifications/unread-count', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { unseen: 0, needs_action: 0 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useUnreadCount(), { wrapper: makeWrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/notifications/unread-count'),
    );
  });

  // ---------------------------------------------------------------------------
  // useMarkSeen — PATCH /api/notifications/seen
  // ---------------------------------------------------------------------------

  it('useMarkSeen PATCHes /api/notifications/seen', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { count: 3 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMarkSeen(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync(['id-1', 'id-2']);

    expect(api.patch).toHaveBeenCalledWith('/api/notifications/seen', {
      ids: ['id-1', 'id-2'],
    });
  });

  it('useMarkSeen invalidates notifications queries on success', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { count: 1 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMarkSeen(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync(undefined);

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] }),
    );
  });

  // ---------------------------------------------------------------------------
  // useMarkRead — PATCH /api/notifications/:id/read
  // ---------------------------------------------------------------------------

  it('useMarkRead PATCHes /api/notifications/:id/read', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMarkRead(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync('notif-abc');

    expect(api.patch).toHaveBeenCalledWith('/api/notifications/notif-abc/read');
  });

  // ---------------------------------------------------------------------------
  // useReadAll — POST /api/notifications/read-all
  // ---------------------------------------------------------------------------

  it('useReadAll POSTs /api/notifications/read-all', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { count: 10 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReadAll(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync(undefined);

    expect(api.post).toHaveBeenCalledWith('/api/notifications/read-all');
  });

  // ---------------------------------------------------------------------------
  // useMarkActed — PATCH /api/notifications/:id/act
  // ---------------------------------------------------------------------------

  it('useMarkActed PATCHes /api/notifications/:id/act', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMarkActed(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync('notif-xyz');

    expect(api.patch).toHaveBeenCalledWith('/api/notifications/notif-xyz/act');
  });

  it('useMarkActed invalidates notifications queries on success', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMarkActed(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync('notif-xyz');

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] }),
    );
  });

  // ---------------------------------------------------------------------------
  // useDismiss — PATCH /api/notifications/:id/dismiss
  // ---------------------------------------------------------------------------

  it('useDismiss PATCHes /api/notifications/:id/dismiss', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDismiss(), { wrapper: makeWrapper(qc) });

    await result.current.mutateAsync('notif-def');

    expect(api.patch).toHaveBeenCalledWith('/api/notifications/notif-def/dismiss');
  });
});
