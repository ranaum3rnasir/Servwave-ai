/**
 * P17 - the client refetches the person's switches when the version stamp the server sends moves, and not on a timer.
 * The real axios instance and the real query client run; only the transport is stubbed.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/axios';
import { queryClient } from '@/lib/queryClient';
import { resetAccountScopedStores } from '@/lib/storeReset';
import { heldSwitchesStamp, noteSwitchesStamp } from '@/lib/switchesStamp';
import { useMySwitches } from '@/lib/api/shared/mySwitches';
import { useAuthStore } from '@/stores/auth.store';

// The suite-wide setup replaces the axios instance with spies; this file needs the real one, interceptors and all.
vi.unmock('@/lib/axios');

let stamp = 'stamp-1';
let valuesNow: Record<string, boolean> = { view_jobs: false };
let adminNow = false;
const calls: string[] = [];

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  calls.push(String(config.url));
  const body = config.url === '/api/permission-switches/me' ? { admin_box: adminNow, values: valuesNow, rules: [] } : {};
  return { data: body, status: 200, statusText: 'OK', headers: { 'x-access-stamp': stamp }, config };
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const switchReads = () => calls.filter((c) => c === '/api/permission-switches/me').length;

describe('the version stamp of the person\'s switches', () => {
  beforeEach(() => {
    stamp = 'stamp-1';
    valuesNow = { view_jobs: false };
    adminNow = false;
    calls.length = 0;
    api.defaults.adapter = adapter;
    resetAccountScopedStores();
    queryClient.clear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches the switches when a response carries a different stamp, and the screen follows', async () => {
    const { result } = renderHook(() => useMySwitches(), { wrapper });
    await waitFor(() => expect(result.current?.values.view_jobs).toBe(false));
    expect(switchReads()).toBe(1);
    expect(heldSwitchesStamp()).toBe('stamp-1');

    // An Admin turns View jobs on; the person's next response, for anything at all, carries the new stamp.
    stamp = 'stamp-2';
    valuesNow = { view_jobs: true };
    await act(async () => {
      await api.get('/api/anything-else');
    });

    await waitFor(() => expect(result.current?.values.view_jobs).toBe(true));
    expect(switchReads()).toBe(2);
    expect(heldSwitchesStamp()).toBe('stamp-2');
  });

  it('does not refetch while the stamp is unchanged, however long the screen stays open (no timer)', async () => {
    const { result } = renderHook(() => useMySwitches(), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(switchReads()).toBe(1);

    // Ten minutes later: a window refocus, another response with the same stamp, and a second screen that mounts
    // and reads the same answer. A timer-based copy would be stale by now and refetch on every one of those.
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
      window.dispatchEvent(new Event('visibilitychange'));
      await api.get('/api/anything-else');
    });
    const second = renderHook(() => useMySwitches(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    expect(second.result.current).toBeDefined();
    expect(switchReads()).toBe(1);
  });

  // Pre-PR review CR-3 (P17): the Admin flag moves the stamp too. The Admin-only screens read the signed-in person's stored
  // `is_admin` (useIsAdmin, RequireAdmin, the Settings rows), so the fresh answer carries it there with the switches.
  it('carries a change of the Admin flag to the signed-in person, so Admin-only screens follow without a reload', async () => {
    const store = useAuthStore as unknown as { getState?: () => unknown };
    const applyUserPatch = vi.fn();
    let isAdmin = true;
    store.getState = () => ({ user: { id: '00000000-0000-0000-0000-000000000001', is_admin: isAdmin }, applyUserPatch, applyAbilityRules: vi.fn() });
    try {
      // Signed in as an Admin; the Owner takes the flag away.
      adminNow = false;
      const { result } = renderHook(() => useMySwitches(), { wrapper });
      await waitFor(() => expect(result.current?.admin_box).toBe(false));
      expect(applyUserPatch).toHaveBeenCalledWith({ is_admin: false });

      // Given back: the next stamp change carries it the other way.
      isAdmin = false;
      applyUserPatch.mockClear();
      stamp = 'stamp-2';
      adminNow = true;
      await act(async () => {
        await api.get('/api/anything-else');
      });
      await waitFor(() => expect(result.current?.admin_box).toBe(true));
      expect(applyUserPatch).toHaveBeenCalledWith({ is_admin: true });
    } finally {
      delete store.getState;
    }
  });

  it('holds the first stamp it sees without refetching, ignores a missing one, and forgets it on sign-out', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    noteSwitchesStamp(undefined);
    noteSwitchesStamp('');
    expect(heldSwitchesStamp()).toBeNull();
    noteSwitchesStamp('a');
    noteSwitchesStamp('a');
    expect(spy).not.toHaveBeenCalled();
    noteSwitchesStamp('b');
    expect(spy).toHaveBeenCalledTimes(1);

    resetAccountScopedStores();
    expect(heldSwitchesStamp()).toBeNull();
    noteSwitchesStamp('c');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
