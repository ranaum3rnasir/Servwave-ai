import { supabase, getAccessToken } from './supabase';
import { useAuthStore } from '@/stores/auth.store';
import { setCachedUser } from '@/stores/auth.store';
import { clearQueryCache } from './queryClient';

// On these routes the AuthCallbackPage owns the OAuth completion (finalize gatekeeper);
// the global listener must not race it by calling checkAuth() in parallel.
//
// Both the legacy path and its /v2 counterpart are listed. The guard used to be a
// `===` against the legacy path alone, which meant the v2 callback page - already
// built and routed at /v2/auth/callback - would have had checkAuth() racing its
// finalizeOAuthLogin(), and /api/auth/me 401s for a Google identity that has not
// been finalized yet. Widening the guard is additive: it can only ever SKIP work
// on one more pathname, never start any.
const OAUTH_CALLBACK_PATHS = ['/auth/callback', '/v2/auth/callback'];

function isOAuthCallbackRoute(): boolean {
  return OAUTH_CALLBACK_PATHS.includes(window.location.pathname);
}

let initialized = false;

export function initAuthListener(): void {
  if (initialized) return;
  initialized = true;

  supabase.auth.onAuthStateChange((event, session) => {
    const { checkAuth } = useAuthStore.getState();

    switch (event) {
      case 'INITIAL_SESSION':
        if (isOAuthCallbackRoute()) break;
        // Session restored from storage — validate with backend
        if (session) {
          checkAuth();
        } else {
          useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
        }
        break;

      case 'SIGNED_IN':
        if (isOAuthCallbackRoute()) break;
        // Re-auth the realtime socket so private channels keep a fresh JWT.
        {
          const token = getAccessToken();
          if (token) supabase.realtime.setAuth(token);
        }
        // Covers cross-tab sign-in (login() action handles the primary tab already)
        checkAuth();
        break;

      case 'SIGNED_OUT':
        // Cross-tab sign-out sync. The cache clear is not just hygiene: this tab keeps its
        // QueryClient across a sign-out/sign-in, so without it the next account inherits
        // this one's cached records.
        clearQueryCache();
        setCachedUser(null);
        useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null });
        break;

      case 'TOKEN_REFRESHED':
        // Re-auth the realtime socket with the refreshed JWT so private
        // channels (e.g. notification subscriptions) keep a valid token.
        {
          const token = getAccessToken();
          if (token) supabase.realtime.setAuth(token);
        }
        break;
    }
  });
}
