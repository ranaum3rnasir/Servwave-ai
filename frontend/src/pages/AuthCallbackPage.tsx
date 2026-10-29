import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError } from '@/lib/utils';

/**
 * Lands here after Google redirects back. The Supabase client (detectSessionInUrl)
 * exchanges the OAuth code and sets the session; this page then calls the backend
 * gatekeeper (finalizeOAuthLogin). On success it routes into the app; on rejection
 * it signs out and returns to /login with an error message.
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
        navigate(`/login?error=${encodeURIComponent(message)}`, { replace: true });
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
    <div className="flex h-screen items-center justify-center bg-surface-light">
      <div className="text-text-secondary">Signing you in…</div>
    </div>
  );
}
