import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';

// Per-file supabase mock: the global setup mock lacks onAuthStateChange.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import AuthCallbackPage from '@/pages/AuthCallbackPage';
import { useAuthStore } from '@/stores/auth.store';
import { supabase } from '@/lib/supabase';

const finalizeOAuthLogin = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ finalizeOAuthLogin }),
  );
});

describe('AuthCallbackPage', () => {
  it('calls finalizeOAuthLogin when a session is present', async () => {
    finalizeOAuthLogin.mockResolvedValue({ id: 'u1', role: 'ADMIN' });

    renderWithProviders(<AuthCallbackPage />, { initialEntries: ['/auth/callback'] });

    await waitFor(() => expect(finalizeOAuthLogin).toHaveBeenCalledTimes(1));
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it('signs out when finalize is rejected', async () => {
    finalizeOAuthLogin.mockRejectedValue(new Error('Not authorized'));

    renderWithProviders(<AuthCallbackPage />, { initialEntries: ['/auth/callback'] });

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(1));
  });
});
