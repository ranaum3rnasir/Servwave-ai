/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 75 follow-up: the notification bell POLLS. It no longer holds a live socket to the
// auth provider (a failed socket makes every browser print the provider's address in the console,
// and app code cannot suppress that line), so freshness comes from a 30 s refetch interval that
// pauses while the tab is hidden, plus a refetch when the window comes back into focus.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { NOTIFICATIONS_POLL_MS, NOTIFICATIONS_SAFETY_POLL_MS, useBellLiveUpdates, useNotifications, useUnreadCount } from '@/lib/api/notifications';
import { useInterruptToasts } from '@/lib/notifications/useInterruptToasts';
import { closeLiveLine } from '@/lib/live/liveLine';
import { fakeLiveLine } from '@/__tests__/harness/fakeLiveLine';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastSpy }), toast: toastSpy }));

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

// #3473: the live line tells the bell when a notification is written, so while it is open the bell's own check is a
// 5-minute safety net, and when it drops the check is every 30 s again at once.
describe('the bell on the live line (#3473)', () => {
  let live: ReturnType<typeof fakeLiveLine>;
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'n-1', verb: 'dispatch.job_assigned', category: 'DISPATCH', priority: 'INTERRUPT', needs_action: false,
    title: 'A job was assigned to you', body: null, object_type: 'JOB', object_id: 'j-1', object_label: 'J-1', action_type: null,
    data: {}, created_at: '2026-11-12T10:00:00.000Z', seen_at: null, read_at: null, acted_at: null, ...over,
  });
  let listItems: unknown[];

  /** What the bell mounts: the line, the count, the list, and the urgent pop-up toasts. */
  function useBell() {
    useBellLiveUpdates();
    useUnreadCount();
    useNotifications();
    useInterruptToasts();
  }
  function mountBell() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } } });
    return renderHook(() => useBell(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
      ),
    });
  }

  beforeEach(() => {
    listItems = [];
    live = fakeLiveLine();
    // Every random wait at its middle: a re-read 1 s after a message, a reconnect 6.5 s after a drop.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === UNREAD_URL) return { data: { unseen: 0, needs_action: 0 } };
      if (url === LIST_URL) return { data: { items: listItems, nextCursor: null } };
      return { data: {} };
    });
  });

  afterEach(() => {
    act(() => closeLiveLine());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a 5-minute safety net while the line is open: no bell request for 4 minutes, then one check', async () => {
    expect(NOTIFICATIONS_SAFETY_POLL_MS).toBe(5 * 60_000);
    mountBell();
    await advance(0);
    expect(calls(UNREAD_URL)).toBe(1);
    expect(calls(LIST_URL)).toBe(1);
    expect(live.fetchMock).toHaveBeenCalledTimes(1);

    await advance(4 * 60_000);
    expect(calls(UNREAD_URL), 'no count request for 4 minutes').toBe(1);
    expect(calls(LIST_URL), 'no list request for 4 minutes').toBe(1);
    await advance(61_000);
    expect(calls(UNREAD_URL), 'the safety check at 5 minutes').toBe(2);
    expect(calls(LIST_URL)).toBe(2);
    expect(live.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is back to every 30 s the moment the line drops, and stays there while it cannot reconnect', async () => {
    mountBell();
    await advance(0);
    await advance(2 * 60_000);
    expect(calls(UNREAD_URL)).toBe(1);

    live.answerWith('fail');
    live.last.end();
    await advance(29_000);
    expect(calls(UNREAD_URL), 'not before 30 s').toBe(1);
    await advance(1_500);
    expect(calls(UNREAD_URL), 'at 30 s').toBe(2);
    await advance(30_000);
    expect(calls(UNREAD_URL)).toBe(3);
  });

  it('keeps the 30-second check when the server does not say it sends the bell\'s messages (an older server)', async () => {
    live.helloWith({ spider_tick: true });
    mountBell();
    await advance(0);
    await advance(30_500);
    expect(calls(UNREAD_URL)).toBe(2);
    expect(calls(LIST_URL)).toBe(2);
    live.helloWith(null);
    live.last.end();
    await advance(8_100);
    await advance(30_500);
    expect(calls(UNREAD_URL)).toBeGreaterThanOrEqual(4);
  });

  it('reads the count and the list again 0-2 s after a message, once however many arrive together; a message carries no content to use', async () => {
    mountBell();
    await advance(0);
    live.send('bell.changed', {});
    live.send('bell.changed', {});
    await advance(900);
    expect(calls(UNREAD_URL), 'not before the random wait').toBe(1);
    await advance(200);
    expect(calls(UNREAD_URL)).toBe(2);
    expect(calls(LIST_URL)).toBe(2);
    await advance(60_000);
    expect(calls(UNREAD_URL), 'once, not once per message').toBe(2);
    // The wait is random between 0 and 2 s.
    vi.mocked(Math.random).mockReturnValue(0);
    live.send('bell.changed', {});
    await advance(1);
    expect(calls(UNREAD_URL)).toBe(3);
  });

  it('reads again when the line comes back after a drop (a message may have been missed)', async () => {
    mountBell();
    await advance(0);
    live.last.end();
    await advance(6_400);
    expect(live.fetchMock).toHaveBeenCalledTimes(1);
    await advance(200);
    expect(live.fetchMock).toHaveBeenCalledTimes(2);
    await advance(1_200);
    expect(calls(UNREAD_URL)).toBe(2);
    expect(calls(LIST_URL)).toBe(2);
  });

  it("changes nothing in the bell for Spider's per-lead alert messages", async () => {
    mountBell();
    await advance(0);
    live.send('spider.alert.added', { alerts: [{ id: 'a1', lead_id: 'l1' }], frame_ids: [] });
    live.send('spider.alert.ended', { ids: ['a1'] });
    live.send('spider.settings.changed', {});
    live.send('spider.summary.ready', {});
    await advance(10_000);
    expect(calls(UNREAD_URL)).toBe(1);
    expect(calls(LIST_URL)).toBe(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('an urgent notification shows its pop-up within 3 s of the message, and a feed one does not', async () => {
    mountBell();
    await advance(0);
    expect(toastSpy).not.toHaveBeenCalled();

    listItems = [item({ id: 'n-feed', priority: 'FEED', title: 'Just so you know', created_at: '2026-11-12T10:00:01.000Z' }), item()];
    live.send('bell.changed', {});
    await advance(3_000);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0]![0]).toMatchObject({ title: 'A job was assigned to you' });
  });
});
