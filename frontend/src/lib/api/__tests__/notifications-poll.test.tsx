/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 75 follow-up: the notification bell POLLS. It no longer holds a live socket to the
// auth provider (a failed socket makes every browser print the provider's address in the console,
// and app code cannot suppress that line), so freshness comes from a 30 s refetch interval that
// pauses while the tab is hidden, plus a refetch when the window comes back into focus.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { NOTIFICATIONS_POLL_MS, useNotifications, useUnreadCount } from '@/lib/api/notifications';

const mockApi = vi.mocked(api);
const UNREAD_URL = '/api/notifications/unread-count';
const LIST_URL = '/api/notifications';

function wrapper() {
  // The app's own defaults (queryClient.ts): five-minute staleTime, no refetch on focus. The poll
  // and the focus refetch must therefore come from the notification queries themselves.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const calls = (url: string) => mockApi.get.mock.calls.filter(([u]) => u === url).length;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  focusManager.setFocused(true);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === UNREAD_URL) return { data: { unseen: 0, needs_action: 0 } };
    if (url === LIST_URL) return { data: { items: [], nextCursor: null } };
    return { data: {} };
  });
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('the notification poll', () => {
  it('is every 30 seconds', () => {
    expect(NOTIFICATIONS_POLL_MS).toBe(30_000);
  });

  it('asks for the unread count again every 30 seconds while the tab is showing', async () => {
    renderHook(() => useUnreadCount(), { wrapper: wrapper() });
    await advance(0);
    expect(calls(UNREAD_URL)).toBe(1);

    await advance(29_000);
    expect(calls(UNREAD_URL), 'not before 30 s').toBe(1);
    await advance(1_500);
    expect(calls(UNREAD_URL), 'at 30 s').toBe(2);
    await advance(30_000);
    expect(calls(UNREAD_URL), 'and again 30 s later').toBe(3);
  });

  it('asks for the list again every 30 seconds while the tab is showing', async () => {
    renderHook(() => useNotifications(), { wrapper: wrapper() });
    await advance(0);
    expect(calls(LIST_URL)).toBe(1);
    await advance(30_500);
    expect(calls(LIST_URL)).toBe(2);
  });

  it('stops while the tab is hidden, and catches up when it comes back', async () => {
    renderHook(() => useUnreadCount(), { wrapper: wrapper() });
    await advance(0);
    expect(calls(UNREAD_URL)).toBe(1);

    act(() => focusManager.setFocused(false));
    await advance(120_000);
    expect(calls(UNREAD_URL), 'no request while hidden').toBe(1);

    act(() => focusManager.setFocused(true));
    await advance(0);
    expect(calls(UNREAD_URL), 'a refetch the moment it is visible again').toBe(2);
  });
});
