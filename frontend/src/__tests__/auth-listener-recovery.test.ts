/**
 * The PASSWORD_RECOVERY guard (password reset spec §2.1 item 3, §5.3; conductor brief §3.4).
 *
 * ServWave's own reset link never creates a browser session. A recovery link sent by the auth
 * provider itself (e.g. from its dashboard) would: the browser client would sign the user in
 * silently, never ask for a new password and skip the email-code 2FA gate. The listener must sign
 * that session out and send the user to the forgot page instead.
 *
 * Seam: the auth event the browser client emits, and what the app does about it (sign-out call,
 * where the browser goes, the signed-in state).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real store: the global setup mock is a selector stub with no state to sign out of.
vi.unmock('@/stores/auth.store');

import { supabase } from '@/lib/supabase';

type Handler = (event: string, session: unknown) => void | Promise<void>;
let handler: Handler | undefined;
const replace = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  handler = undefined;
  (supabase.auth as unknown as { onAuthStateChange: unknown }).onAuthStateChange = vi.fn((cb: Handler) => {
    handler = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null } as never);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, pathname: '/', replace },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

async function start() {
  const [{ initAuthListener }, { useAuthStore }] = await Promise.all([import('@/lib/auth-listener'), import('@/stores/auth.store')]);
  useAuthStore.setState({ user: { id: 'u-1', email: 'dana@example.test' } as never, isAuthenticated: true, isLoading: false });
  initAuthListener();
  expect(handler).toBeDefined();
  return useAuthStore;
}

describe('auth listener: PASSWORD_RECOVERY', () => {
  it('signs the recovery session out and sends the browser to the forgot page', async () => {
    await start();

    await handler!('PASSWORD_RECOVERY', { access_token: 'x' });

    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/forgot-password'));
    const signOutOrder = vi.mocked(supabase.auth.signOut).mock.invocationCallOrder[0];
    expect(signOutOrder).toBeLessThan(replace.mock.invocationCallOrder[0]);
  });

  it('leaves the app signed out', async () => {
    const useAuthStore = await start();

    await handler!('PASSWORD_RECOVERY', { access_token: 'x' });

    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('when the sign-out call fails, still drops the stored session before leaving', async () => {
    localStorage.setItem('sb-projref-auth-token', JSON.stringify({ access_token: 'x' }));
    localStorage.setItem('unrelated-key', 'kept');
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: { message: 'Failed to fetch' } } as never);
    await start();

    await handler!('PASSWORD_RECOVERY', { access_token: 'x' });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/forgot-password'));
    expect(localStorage.getItem('sb-projref-auth-token')).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('kept');
    localStorage.clear();
  });

  it('still leaves when the sign-out call throws', async () => {
    vi.mocked(supabase.auth.signOut).mockRejectedValue(new Error('offline'));
    await start();

    await handler!('PASSWORD_RECOVERY', { access_token: 'x' });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/forgot-password'));
  });
});
