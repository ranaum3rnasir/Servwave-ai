import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import {
  INVALID_RESET_LINK_CODE,
  TOO_MANY_ATTEMPTS_MESSAGE,
  WEAK_PASSWORD_CODE,
  isRateLimited,
  replacementTokenFrom,
  setPasswordFromLink,
} from '@/lib/api/passwordReset';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { PasswordInput } from '@/ui-kit/components/ui/passwordInput';

import { AuthAlert, AuthCard } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';

const INVALID_LINK_MESSAGE = 'This reset link is invalid or has expired.';
/** Opened without a token, e.g. a reload after the page stripped it: nothing was rejected. */
const NO_TOKEN_MESSAGE = 'Open the reset link from your email again, or send a new link.';
const BREACHED_FALLBACK =
  "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one.";
const MIN_LENGTH = 8;

/**
 * /reset-password?token=... - choose a new password from the emailed link (password reset spec
 * §5.1 step 4, §5.2).
 *
 * The token is a credential for an hour, so the page:
 *  - reads it once and strips the whole query string from the address bar before the first paint
 *    (`history.replaceState`), so it does not sit in browser history;
 *  - sends it in the POST body only;
 *  - sets `<meta name="referrer" content="no-referrer">` while open (vercel.json sends the same
 *    policy as a header for the first load), and error reporting scrubs it from URLs (scrubUrl.ts).
 *
 * A reset never signs anyone in: success goes to /login?reset=1, so 2FA still applies. No query
 * parameter is ever used as a place to go.
 *
 * Checking the token spends it, so a password refused as breached would burn the link. The server
 * then answers with a replacement token (slice 05): the page swaps it in, in component state only
 * (never the address bar, storage or the DOM), shows the breached message and lets the user try
 * another password. Without a replacement it shows the message and "Send a new link".
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // Read once: the address bar is cleared right after. Replaced in memory after a breached password.
  const [token, setToken] = useState(() => searchParams.get('token') ?? '');
  // 'missing': no token in the address; 'rejected': the server refused it; 'spent': a breached
  // password used the link up and no replacement came back (`spentMessage` says why).
  const [linkProblem, setLinkProblem] = useState<null | 'missing' | 'rejected' | 'spent'>(() => (token ? null : 'missing'));
  const [spentMessage, setSpentMessage] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Before the first paint: the address bar itself.
  useLayoutEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
    }
  }, []);
  // Then the router's copy of the location, so nothing re-renders the token back into the URL.
  const hasQuery = location.search !== '';
  useEffect(() => {
    if (hasQuery) navigate({ pathname: location.pathname, hash: location.hash }, { replace: true });
  }, [hasQuery, location.pathname, location.hash, navigate]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_LENGTH) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { otherSessionsSignedOut } = await setPasswordFromLink(token, newPassword);
      // Fixed destinations only. `others=1` adds the "couldn't sign out your other devices" line.
      navigate(otherSessionsSignedOut ? '/login?reset=1' : '/login?reset=1&others=1', { replace: true });
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { code?: string } } })?.response?.data;
      const replacement = replacementTokenFrom(err);
      if (data?.code === INVALID_RESET_LINK_CODE) {
        setLinkProblem('rejected');
      } else if (replacement) {
        // The old token is spent; the replacement is good for one more try on this page.
        setToken(replacement);
        setNewPassword('');
        setConfirm('');
        setError(extractApiError(err, BREACHED_FALLBACK));
      } else if (data?.code === WEAK_PASSWORD_CODE) {
        setSpentMessage(extractApiError(err, BREACHED_FALLBACK));
        setLinkProblem('spent');
      } else if (isRateLimited(err)) {
        setError(TOO_MANY_ATTEMPTS_MESSAGE);
      } else {
        setError(extractApiError(err, "We couldn't update your password. Try again or contact ServWave support."));
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="pad-safe bg-kit-background h-dvh overflow-y-auto overscroll-contain">
      <div className="flex min-h-full items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm">
          <AuthCard>
            <BrandLockup className="mb-6" />

            {linkProblem ? (
              <div className="text-center">
                <p
                  role={linkProblem === 'missing' ? undefined : 'alert'}
                  className={linkProblem === 'missing' ? 'text-muted-foreground mb-4 text-sm' : 'text-destructive mb-4 text-sm'}
                >
                  {linkProblem === 'missing' ? NO_TOKEN_MESSAGE : linkProblem === 'spent' ? spentMessage : INVALID_LINK_MESSAGE}
                </p>
                <Button type="button" onClick={() => navigate('/forgot-password', { replace: true })}>
                  Send a new link
                </Button>
              </div>
            ) : (
              <>
                <p role="heading" aria-level={2} className="mb-4 text-lg font-semibold">
                  Choose a new password
                </p>

                {error && <AuthAlert>{error}</AuthAlert>}

                <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-password">New password</Label>
                    <PasswordInput
                      id="new-password"
                      autoComplete="new-password"
                      aria-describedby="new-password-hint"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <p id="new-password-hint" className="text-muted-foreground text-xs">
                      At least 8 characters. Don&apos;t reuse a password from another site.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="confirm-password">Confirm new password</Label>
                    <PasswordInput
                      id="confirm-password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </div>
                  <Button type="submit" disabled={submitting} className="w-full">
                    {submitting ? 'Updating…' : 'Update password'}
                  </Button>
                </form>
              </>
            )}
          </AuthCard>
        </div>
      </div>
    </div>
  );
}
