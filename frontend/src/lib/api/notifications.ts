import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import api from '@/lib/axios';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  verb: string;
  category: string;
  priority: 'INTERRUPT' | 'FEED';
  needs_action: boolean;
  title: string;
  body: string | null;
  object_type: string;
  object_id: string;
  object_label: string | null;
  action_type: string | null;
  data: Record<string, unknown>;
  created_at: string;
  seen_at: string | null;
  read_at: string | null;
  acted_at: string | null;
}

export interface NotificationListResponse {
  items: NotificationView[];
  nextCursor: string | null;
}

export interface UnreadCountResponse {
  unseen: number;
  needs_action: number;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_KEY = ['notifications'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_KEY = ['notifications', 'unread-count'] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * How often the bell asks for fresh notifications. The bell POLLS: it does not hold a live socket
 * to the auth provider, because a failed socket makes every browser print the provider's address in
 * the console and page code cannot suppress that line (mobile slice 75 follow-up). The interval
 * pauses while the tab is hidden (`refetchIntervalInBackground: false`), and the bell also refetches
 * when the window regains focus (useNotificationRefresh).
 */
export const NOTIFICATIONS_POLL_MS = 30_000;

export function useNotifications({ needsAction }: { needsAction?: boolean } = {}) {
  return useInfiniteQuery<NotificationListResponse, Error, InfiniteData<NotificationListResponse>, readonly ['notifications', { needsAction: boolean }], string | undefined>({
    queryKey: [...NOTIFICATIONS_KEY, { needsAction: needsAction ?? false }] as const,
    queryFn: ({ pageParam }) =>
      api
        .get('/api/notifications', {
          params: {
            ...(needsAction !== undefined ? { needs_action: needsAction } : undefined),
            ...(pageParam !== undefined ? { cursor: pageParam } : undefined),
          },
        })
        .then((r) => r.data),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: NOTIFICATIONS_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useUnreadCount() {
  return useQuery<UnreadCountResponse>({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY,
    queryFn: () => api.get('/api/notifications/unread-count').then((r) => r.data),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: NOTIFICATIONS_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

// ---------------------------------------------------------------------------
// Mutations — all invalidate the ['notifications'] prefix on success
// ---------------------------------------------------------------------------

export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      api.patch('/api/notifications/seen', ids ? { ids } : {}).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/read`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useReadAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/notifications/read-all').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkActed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/act`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/dismiss`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
