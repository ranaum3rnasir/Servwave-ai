// The Inbox was the one channel with no live signal: an inbound reply was
// captured server-side and stayed invisible until the 5-minute staleTime
// expired, with refetchOnWindowFocus off globally. This hook is the client half
// of the fix - it listens for the `emails.changed` broadcast the inbound
// webhook now pushes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useEmailRealtime } from '../useEmailRealtime';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** Handlers registered via channel.on(), keyed by event name. */
const handlers = new Map<string, () => void>();
const removeChannel = vi.fn();
const subscribe = vi.fn();
const setAuth = vi.fn();
let lastTopic: string | null = null;
let lastConfig: unknown = null;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    realtime: { setAuth: (...a: unknown[]) => setAuth(...a) },
    channel: vi.fn(),
    removeChannel: (...a: unknown[]) => removeChannel(...a),
  },
  getAccessToken: () => 'jwt-token',
}));

const makeWrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };

function mockUser(user: Record<string, unknown> | null) {
  vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
    (selector as (s: Record<string, unknown>) => unknown)({ user }));
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  lastTopic = null;
  lastConfig = null;

  const channelApi = {
    on: (_type: string, filter: { event: string }, cb: () => void) => {
      handlers.set(filter.event, cb);
      return channelApi;
    },
    subscribe: (...a: unknown[]) => {
      subscribe(...a);
      return channelApi;
    },
  };
  vi.mocked(supabase.channel).mockImplementation((topic: string, config: unknown) => {
    lastTopic = topic;
    lastConfig = config;
    return channelApi as never;
  });

  mockUser({ id: USER_ID, organization_id: ORG_ID });
});

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries').mockImplementation(() => Promise.resolve());
  const view = renderHook(() => useEmailRealtime(), { wrapper: makeWrapper(qc) });
  return { qc, invalidate, view };
}

describe('useEmailRealtime', () => {
  it('subscribes to the caller-private per-user topic', () => {
    // The Realtime policy is `topic LIKE 'org:%:user:' || auth.uid()`, so any
    // other shape - an org-wide topic especially - is simply refused.
    render();

    expect(lastTopic).toBe(`org:${ORG_ID}:user:${USER_ID}`);
    expect(lastConfig).toEqual({ config: { private: true } });
    expect(subscribe).toHaveBeenCalled();
  });

  it('re-applies the JWT, without which the private channel is unauthorised', () => {
    render();
    expect(setAuth).toHaveBeenCalledWith('jwt-token');
  });

  it('invalidates the email list when emails.changed arrives', () => {
    const { invalidate } = render();

    handlers.get('emails.changed')!();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['communication', 'emails'] });
  });

  it('ignores notifications.changed - that is the bell\'s job, not the list\'s', () => {
    // Two events rather than one so the Inbox does not refetch every message
    // every time an unrelated notification fires.
    const { invalidate } = render();

    expect(handlers.has('notifications.changed')).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('also refetches on window focus, since refetchOnWindowFocus is off globally', () => {
    // Covers a reply that landed while the tab was backgrounded or the socket
    // was dropped - otherwise it stays invisible for the full staleTime.
    const { invalidate } = render();

    window.dispatchEvent(new Event('focus'));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['communication', 'emails'] });
  });

  it('does nothing at all when signed out', () => {
    mockUser(null);

    render();

    expect(supabase.channel).not.toHaveBeenCalled();
    expect(setAuth).not.toHaveBeenCalled();
  });

  it('tears the channel and the focus listener down on unmount', () => {
    // A leaked channel per Inbox mount would pile up sockets over a shift.
    const { view, invalidate } = render();

    view.unmount();
    invalidate.mockClear();
    window.dispatchEvent(new Event('focus'));

    expect(removeChannel).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
