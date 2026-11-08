import { describe, it, expect, vi, beforeEach } from 'vitest';

// This suite exercises the REAL auth store (the global setup mock replaces it
// with a selector stub, so we un-mock it here and import the actual module).
vi.unmock('@/stores/auth.store');

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';
import type { QueryClient } from '@tanstack/react-query';

const mockApi = vi.mocked(api);

// The store and the QueryClient must come from the SAME module graph - resetModules gives
// the re-imported store a fresh lib/queryClient, so grabbing the client any other way
// would assert against a client the store never touched.
async function loadStoreAndCache() {
  vi.resetModules();
  const [store, cache] = await Promise.all([
    import('@/stores/auth.store'),
    import('@/lib/queryClient'),
  ]);
  return { useAuthStore: store.useAuthStore, queryClient: cache.queryClient };
}

function seedPreviousOrgCache(queryClient: QueryClient) {
  queryClient.setQueryData(['organization'], {
    id: 'org-alpha',
    accepted_payment_methods: [],
    stripe_charges_enabled: false,
  });
  queryClient.setQueryData(['leads'], [{ id: 'lead-belonging-to-org-alpha' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null } as never);
});

/**
 * Regression 2026-08-10: signing out and back in is a client-side navigation, so the module-scoped
 * QueryClient survives it. Every cached record from the previous account stayed readable
 * in the next session: Settings > Payments rendered the OLD org's methods, deposit and
 * lists, and saving that form PATCHed the stale values into the org just signed into.
 */
describe('auth.store - the query cache never spans two identities', () => {
  it('drops the previous account\'s cached queries on logout', async () => {
    const { useAuthStore, queryClient } = await loadStoreAndCache();
    seedPreviousOrgCache(queryClient);
    mockApi.post.mockResolvedValue({ data: {} });

    await useAuthStore.getState().logout();

    expect(queryClient.getQueryData(['organization'])).toBeUndefined();
    expect(queryClient.getQueryData(['leads'])).toBeUndefined();
  });

  it('drops them even when the logout API call fails', async () => {
    const { useAuthStore, queryClient } = await loadStoreAndCache();
    seedPreviousOrgCache(queryClient);
    mockApi.post.mockRejectedValue(new Error('network'));

    await useAuthStore.getState().logout();

    expect(queryClient.getQueryData(['organization'])).toBeUndefined();
  });

  it('drops them when checkAuth resolves to a DIFFERENT user (identity changed without a logout)', async () => {
    const { useAuthStore, queryClient } = await loadStoreAndCache();
    localStorage.setItem('servwave_user', JSON.stringify({ id: 'user-alpha', email: 'a@example.com' }));
    seedPreviousOrgCache(queryClient);
    mockApi.get.mockResolvedValue({ data: { user: { id: 'user-beta', email: 'b@example.com' }, abilityRules: [] } });

    await useAuthStore.getState().checkAuth();

    expect(queryClient.getQueryData(['organization'])).toBeUndefined();
  });

  it('keeps the cache when checkAuth confirms the SAME user (an ordinary revalidation)', async () => {
    const { useAuthStore, queryClient } = await loadStoreAndCache();
    localStorage.setItem('servwave_user', JSON.stringify({ id: 'user-alpha', email: 'a@example.com' }));
    seedPreviousOrgCache(queryClient);
    mockApi.get.mockResolvedValue({ data: { user: { id: 'user-alpha', email: 'a@example.com' }, abilityRules: [] } });

    await useAuthStore.getState().checkAuth();

    expect(queryClient.getQueryData(['organization'])).toBeDefined();
  });
});
