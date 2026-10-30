/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 07 (PERF-04): SMS threads are polled only while a communication surface needs
// them, and polling pauses while the tab is hidden.
//
// Before this slice the app shell's unread badge (`useUnreadCounts`, mounted on EVERY page by
// V2AppLayout and the legacy Header) read the whole org-wide thread list - every message of
// every thread - and re-downloaded it every 20 s whenever the phone service was on. The badge
// now reads the purpose-built `GET /api/communication/unread-counts` instead, so a page with no
// communication surface never touches the thread list, and the SMS inbox / dialer message panel
// keep the 20 s thread poll they actually render.
//
// Fake timers drive the 20 s interval; `document.visibilityState` is overridden to drive
// React Query's focus manager the same way a real tab switch does (a `visibilitychange` event).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useMessageThreads, useMarkThreadRead, useUnreadCounts } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

// Phone service ON - the only state in which anything polled before this slice.
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { ctm_account_id: 'acct-test', ctm_sms_ready: true } }),
}));
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

const THREADS_URL = '/api/communication/threads';
const COUNTS_URL = '/api/communication/unread-counts';

let visibility: DocumentVisibilityState = 'visible';
let smsUnread = 1;
let orgFeatures = ['phone', 'email'];

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  // A real tab switch fires a bubbling `visibilitychange` on document; React Query listens on window.
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

function callsTo(url: string) {
  return mockApi.get.mock.calls.filter(([u]) => u === url).length;
}

// Mirrors the production client's defaults (lib/queryClient.ts): a 5-minute staleTime and NO
// refetch on window focus - so any refresh-on-return proven below comes from the hooks
// themselves, not from a lenient test client.
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AbilityProvider ability={communicationSectionAbility()}>{children}</AbilityProvider>
    </QueryClientProvider>
  );
}

// Advance the fake clock, then give the fetch that a tick started a few more turns to settle into
// the hook's render: a response crosses several promise hops plus React Query's 0 ms notify
// timer, and a single `advanceTimersByTimeAsync` can return before that timer is even scheduled.
// The settle turns move the clock by 3 ms in total, far from the next 20 s tick.
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
  visibility = 'visible';
  smsUnread = 1;
  orgFeatures = ['phone', 'email'];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === COUNTS_URL) return { data: { sms: smsUnread, whatsapp: 0, email: 2 } };
    if (url === THREADS_URL) return { data: { threads: [{ id: 't1', unread: smsUnread, messages: [] }] } };
    if (url === '/api/communication/whatsapp') return { data: { chats: [] } };
    if (url === '/api/communication/emails') return { data: { emails: [] } };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: {} });
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000001', role: 'ADMIN', org_features: orgFeatures },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Roles & Permissions S10.6 - the badge when the company\'s Email plan feature goes off', () => {
  it('shows no email count from the answer it already holds, while texts keep theirs', async () => {
    const { result, rerender } = renderHook(() => useUnreadCounts(), { wrapper: wrapper() });
    await advance(0);
    expect(result.current).toEqual({ sms: 1, whatsapp: 0, email: 2 });

    // The company loses the feature: the next render of the shell has no email entitlement, and the answer it cached
    // before still says 2. The number must not show while the feature is off.
    orgFeatures = ['phone'];
    rerender();

    expect(result.current).toEqual({ sms: 1, whatsapp: 0, email: 0 });
  });
});

describe('mobile slice 07 - the unread badge on a page without a communication surface', () => {
  it('never requests the thread list, across three 20 s poll windows', async () => {
    renderHook(() => useUnreadCounts(), { wrapper: wrapper() });
    await advance(65_000);

    expect(callsTo(THREADS_URL)).toBe(0);
  });

  it('still updates: it polls the unread-count endpoint every 20 s and shows the new number', async () => {
    const { result } = renderHook(() => useUnreadCounts(), { wrapper: wrapper() });
    await advance(0);
    expect(result.current).toEqual({ sms: 1, whatsapp: 0, email: 2 });

    smsUnread = 3; // a new text lands on the server
    await advance(20_000);

    expect(result.current.sms).toBe(3);
    expect(callsTo(COUNTS_URL)).toBe(2);
  });

  it('stops polling while the tab is hidden and refreshes as soon as it is visible again', async () => {
    const { result } = renderHook(() => useUnreadCounts(), { wrapper: wrapper() });
    await advance(0);
    const before = callsTo(COUNTS_URL);
    expect(before).toBe(1);

    setVisibility('hidden');
    smsUnread = 4;
    await advance(65_000);
    expect(callsTo(COUNTS_URL)).toBe(before);

    setVisibility('visible');
    await advance(0);
    expect(callsTo(COUNTS_URL)).toBe(before + 1);
    expect(result.current.sms).toBe(4);
  });

  it('refreshes the badge the moment a thread is marked read, without waiting for the next poll', async () => {
    const { result } = renderHook(() => ({ counts: useUnreadCounts(), markRead: useMarkThreadRead() }), {
      wrapper: wrapper(),
    });
    await advance(0);
    expect(result.current.counts.sms).toBe(1);

    smsUnread = 0;
    await act(async () => {
      result.current.markRead.mutate('t1');
    });
    await advance(0);

    expect(callsTo(COUNTS_URL)).toBe(2);
    expect(result.current.counts.sms).toBe(0);
  });
});

describe('mobile slice 07 - a communication surface (SMS inbox, dialer message panel)', () => {
  it('keeps polling the thread list every 20 s while visible', async () => {
    renderHook(() => useMessageThreads(), { wrapper: wrapper() });
    await advance(0);
    expect(callsTo(THREADS_URL)).toBe(1);

    await advance(40_000);
    expect(callsTo(THREADS_URL)).toBe(3);
  });

  it('stops polling the thread list while hidden and refreshes it as soon as it is visible again', async () => {
    renderHook(() => useMessageThreads(), { wrapper: wrapper() });
    await advance(0);
    expect(callsTo(THREADS_URL)).toBe(1);

    setVisibility('hidden');
    await advance(65_000);
    expect(callsTo(THREADS_URL)).toBe(1);

    setVisibility('visible');
    await advance(0);
    expect(callsTo(THREADS_URL)).toBe(2);

    await advance(20_000);
    expect(callsTo(THREADS_URL)).toBe(3);
  });
});
