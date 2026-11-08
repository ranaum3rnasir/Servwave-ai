import { describe, it, expect, vi, beforeEach } from 'vitest';

// This suite exercises the REAL auth store (the global setup mock replaces it
// with a selector stub, so we un-mock it here and import the actual module).
vi.unmock('@/stores/auth.store');

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';

const mockApi = vi.mocked(api);
const mockSetSession = vi.mocked(supabase.auth.setSession);

// Re-import the real store fresh each test so module-level cache state can't leak.
async function loadStore() {
  vi.resetModules();
  const mod = await import('@/stores/auth.store');
  return mod.useAuthStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('auth.store — email-OTP MFA', () => {
  it('login() with mfaRequired does NOT persist a session and leaves the user unauthenticated', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: { mfaRequired: true, challengeId: 'chal_123' },
    });

    const useAuthStore = await loadStore();
    const result = await useAuthStore.getState().login('a@b.com', 'pw');

    expect(result).toEqual({ mfaRequired: true, challengeId: 'chal_123' });
    // No setSession while the challenge is pending.
    expect(mockSetSession).not.toHaveBeenCalled();
    // /api/auth/me must NOT be fetched yet (only /api/auth/login was hit).
    expect(mockApi.get).not.toHaveBeenCalled();
    // The gate stays closed.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('servwave_user')).toBeNull();
  });

  it('login() without MFA sets the session and authenticates as before', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', email: 'a@b.com', role: 'ADMIN', organization_id: 'o1' },
        session: { access_token: 'at', refresh_token: 'rt' },
      },
    });
    mockApi.get.mockResolvedValueOnce({ data: { abilityRules: [] } });

    const useAuthStore = await loadStore();
    const result = await useAuthStore.getState().login('a@b.com', 'pw');

    expect(result).toEqual({ mfaRequired: false });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('verifyMfa() posts /mfa/verify, sets the session, and authenticates', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', email: 'a@b.com', role: 'ADMIN', organization_id: 'o1' },
        session: { access_token: 'at2', refresh_token: 'rt2' },
      },
    });
    mockApi.get.mockResolvedValueOnce({ data: { abilityRules: [] } });

    const useAuthStore = await loadStore();
    await useAuthStore.getState().verifyMfa('chal_123', '654321');

    expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/verify', {
      challengeId: 'chal_123',
      code: '654321',
    });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at2', refresh_token: 'rt2' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe('u1');
  });

  it('verifyMfa() surfaces a 401 as a thrown error and stays unauthenticated', async () => {
    mockApi.post.mockRejectedValueOnce({ response: { status: 401, data: { error: 'Invalid code' } } });

    const useAuthStore = await loadStore();
    await expect(useAuthStore.getState().verifyMfa('chal_123', '000000')).rejects.toThrow();

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
