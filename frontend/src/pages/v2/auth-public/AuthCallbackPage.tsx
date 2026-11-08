import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError } from '@/lib/utils';

import { Spinner } from '@/ui-kit/components/ui/spinner';

import { v2Path } from '../uiV2';

/**
 * /v2/auth/callback - the CRM-kit rebuild of `pages/AuthCallbackPage.tsx`.
 *
 * Lands here after Google redirects back. The Supabase client
 * (detectSessionInUrl) exchanges the OAuth code and sets the session; this page
 * then calls the backend gatekeeper (finalizeOAuthLogin). On success it routes
 * into the app; on rejection it signs out and returns to /login with an error
 * message. Byte-for-byte the same flow as the legacy page - only the spinner
 * is new.
 *
 * NOT REGISTERED FOR THE FLAG REDIRECT, deliberately. See the long note in
 * `pages/v2/routes/auth-public.paths.ts`: `lib/auth-listener.ts` skips its
 * INITIAL_SESSION / SIGNED_IN handling on the exact pathname `/auth/callback`
 * so the global listener cannot race this page's finalize. That constant is in
 * a shared file this branch may not edit, so redirecting the OAuth return to a
 * `/v2`-prefixed pathname would re-open the race it was written to close. The
 * page is built and routed for review and for cutover; the legacy path keeps
 * serving the real redirect until the constant can be widened.
 */
export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const finalizeOAuthLogin = useAuthStore((s) => s.finalizeOAuthLogin);
  const ran = useRef(false);

  useEffect(() => {
    async function finalize() {
      if (ran.current) return;
      ran.current = true;
      try {
        await finalizeOAuthLogin();
        navigate('/', { replace: true });
      } catch (err: unknown) {
        await supabase.auth.signOut();
        const message = extractApiError(err, 'Google sign-in failed');
        // v2Path, not a bare `/login`: navigation BETWEEN v2 pages is prefixed
        // explicitly so it does not depend on the flag (see uiV2.ts). Home
        // stays `/` - the dashboard has no v2 page yet.
        navigate(`${v2Path('/login')}?error=${encodeURIComponent(message)}`, { replace: true });
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        finalize();
        return;
      }
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) {
          sub.subscription.unsubscribe();
          finalize();
        }
      });
    });
  }, [finalizeOAuthLogin, navigate]);

  return (
    <div className="bg-kit-background flex h-screen items-center justify-center">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner label={null} />
        Signing you in…
      </div>
    </div>
  );
}
