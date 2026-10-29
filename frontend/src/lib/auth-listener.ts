import { supabase } from './supabase';
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

async function leaveRecoverySession(): Promise<void> {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null });
  setCachedUser(null);
  let signedOut: boolean;
  try {
    // 'local' revokes just this session; the user's other devices are not this link's business.
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    signedOut = !error;
  } catch {
    signedOut = false;
  }
  // Offline or refused: the client keeps the stored session in that case, and the page load below
  // would restore it. Drop it here so the forgot page always opens signed out.
  if (!signedOut) dropStoredAuthSession();
  window.location.replace('/forgot-password');
}

/**
 * The browser client's persisted session (default key `sb-<project>-auth-token`). Also used by
 * Login & Security when a password change ended this device's session (SecurityPage).
 */
export function dropStoredAuthSession(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (/^sb-.+-auth-token(-code-verifier)?$/.test(key)) localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable: nothing persisted to drop.
  }
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

      case 'PASSWORD_RECOVERY':
        // Password reset spec §5.3. ServWave's own reset link never opens a browser session; only a
        // recovery link sent by the auth provider itself does, and following it would sign the user
        // in silently, never ask for a new password and skip the email-code 2FA gate. Sign that
        // session out and send them to the forgot page, which emails ServWave's link. A full page
        // load, so no in-flight session check from this one can sign the app back in.
        void leaveRecoverySession();
        break;

      case 'TOKEN_REFRESHED':
        // Nothing to do: lib/supabase.ts caches the new access token on every auth change, and the
        // app holds no live socket that would need it applied.
        break;
    }
  });
}
