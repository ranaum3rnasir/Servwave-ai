import { describe, it, expect, vi, beforeEach } from 'vitest';

// This suite exercises the REAL auth store (the global setup mock replaces it
// with a selector stub, so we un-mock it here and import the actual module).
vi.unmock('@/stores/auth.store');

import { supabase } from '@/lib/supabase';

const mockOAuth = vi.mocked(supabase.auth.signInWithOAuth);

// Re-import the real store fresh each test so module-level cache state can't leak.
async function loadStore() {
  vi.resetModules();
  const mod = await import('@/stores/auth.store');
  return mod.useAuthStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOAuth.mockResolvedValue({ data: { provider: 'google', url: 'https://accounts.google.com' }, error: null } as never);
});

describe('auth.store — loginWithGoogle account pinning', () => {
  it('pins the OAuth request to the invited email (login_hint + select_account) when given a hint', async () => {
    const useAuthStore = await loadStore();
    await useAuthStore.getState().loginWithGoogle('invitee@example.com');
    expect(mockOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: expect.stringContaining('/auth/callback'),
        queryParams: { login_hint: 'invitee@example.com', prompt: 'select_account' },
      },
    });
  });

  it('sends no account-pinning params for the plain /login flow (no hint)', async () => {
    const useAuthStore = await loadStore();
    await useAuthStore.getState().loginWithGoogle();
    const arg = mockOAuth.mock.calls[0][0] as { provider: string; options?: { queryParams?: unknown } };
    expect(arg.provider).toBe('google');
    expect(arg.options?.queryParams).toBeUndefined();
  });
});
