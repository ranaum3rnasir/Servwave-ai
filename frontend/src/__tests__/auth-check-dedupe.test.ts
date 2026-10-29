import { describe, it, expect, vi, beforeEach } from 'vitest';

// The REAL auth store (the global setup replaces it with a selector stub).
vi.unmock('@/stores/auth.store');

import api from '@/lib/axios';
import { getAccessToken, supabase } from '@/lib/supabase';

const mockApi = vi.mocked(api);
const mockToken = vi.mocked(getAccessToken);

async function loadStore() {
  vi.resetModules();
  const store = await import('@/stores/auth.store');
  return store.useAuthStore;
}

const me = (id: string) => ({ data: { user: { id, email: `${id}@example.com`, role: 'TECHNICIAN' }, abilityRules: [] } });

/** A /api/auth/me call the test settles by hand, so two checks can overlap. */
function deferredMe() {
  let resolve!: (v: ReturnType<typeof me>) => void;
  const promise = new Promise<ReturnType<typeof me>>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockToken.mockReturnValue('token-a');
  vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null } as never);
});

/**
 * Mobile slice 61 (PERF-03). On a cold start with a stored session the auth client announces it
 * twice (INITIAL_SESSION, then SIGNED_IN) and the listener runs checkAuth() for each, so the first
 * screen paid for two identical /api/auth/me round trips back to back. On a phone line, and on an
 * API that answers one request at a time, the second one delays everything queued behind it.
 */
describe('auth.store - checkAuth() does not ask the server the same question twice at once', () => {
  it('two overlapping checks for the same session make ONE request and both settle on its answer', async () => {
    const useAuthStore = await loadStore();
    const first = deferredMe();
    mockApi.get.mockReturnValueOnce(first.promise);

    const a = useAuthStore.getState().checkAuth();
    const b = useAuthStore.getState().checkAuth();
    first.resolve(me('user-1'));
    await Promise.all([a, b]);

    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(mockApi.get).toHaveBeenCalledWith('/api/auth/me');
    expect(useAuthStore.getState().user?.id).toBe('user-1');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('a check made AFTER the first one settled asks again (a revalidation is still a revalidation)', async () => {
    const useAuthStore = await loadStore();
    mockApi.get.mockResolvedValue(me('user-1'));

    await useAuthStore.getState().checkAuth();
    await useAuthStore.getState().checkAuth();

    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('a check under a DIFFERENT session never borrows the other one\'s answer', async () => {
    const useAuthStore = await loadStore();
    const first = deferredMe();
    const second = deferredMe();
    mockApi.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    mockToken.mockReturnValue('token-a');
    const a = useAuthStore.getState().checkAuth();
    mockToken.mockReturnValue('token-b'); // another account signed in while the first check was out
    const b = useAuthStore.getState().checkAuth();
    first.resolve(me('user-a'));
    second.resolve(me('user-b'));
    await Promise.all([a, b]);

    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('a failed check clears the slot, so the next check is a fresh request', async () => {
    const useAuthStore = await loadStore();
    mockApi.get.mockRejectedValueOnce(new Error('401')).mockResolvedValueOnce(me('user-1'));

    await useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    await useAuthStore.getState().checkAuth();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
