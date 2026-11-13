import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect } from 'react';
import api from '@/lib/axios';
import { subscribeLiveMessages, useLiveLine, useLiveLineSays, LIVE_REOPENED } from '@/lib/live/liveLine';

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
/**
 * While the live line is open and its server says it sends the bell's messages (#3473), the line tells the bell the moment
 * a notification is written, so the 30-second check is only a safety net. The moment the line drops it is 30 s again.
 */
export const NOTIFICATIONS_SAFETY_POLL_MS = 5 * 60_000;
/** The live message that says the bell changed, and the longest a screen waits before it reads again (so a company's screens do not all ask at once). */
export const BELL_CHANGED = 'bell.changed';
export const BELL_REREAD_SPREAD_MS = 2_000;

/** The bell's check interval: the safety net while the line carries the bell's messages, else every 30 s. */
function useBellPollMs(): number {
  return useLiveLineSays('bell') ? NOTIFICATIONS_SAFETY_POLL_MS : NOTIFICATIONS_POLL_MS;
}

export function useNotifications({ needsAction }: { needsAction?: boolean } = {}) {
  const pollMs = useBellPollMs();
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
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

export function useUnreadCount() {
  const pollMs = useBellPollMs();
  return useQuery<UnreadCountResponse>({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY,
    queryFn: () => api.get('/api/notifications/unread-count').then((r) => r.data),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

/**
 * Keeps the live line open while the bell is mounted and, when the line says the bell changed (or it opens again after a
 * drop, when a message may have been missed), reads the bell again after a random 0-2 s: the count, the list when the bell
 * is open, and the list the urgent pop-up toasts (useInterruptToasts) watch, which is the same list. One read per wait,
 * however many messages arrive together. The message carries no content; what is shown comes from the API.
 */
export function useBellLiveUpdates(): void {
  const qc = useQueryClient();
  useLiveLine();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeLiveMessages((m) => {
      if (m.type !== BELL_CHANGED && m.type !== LIVE_REOPENED) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      }, Math.random() * BELL_REREAD_SPREAD_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
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
