import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { GoogleIcon } from '@/components/brand/GoogleIcon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Heading } from '@/components/ui/heading';
import { FormField } from '@/components/patterns/FormField';
import { useAuthStore } from '@/stores/auth.store';
import { getInviteInfo, acceptInvite, recordInviteConsent } from '@/lib/api/invite';
import { extractApiError } from '@/lib/utils';

type Phase = 'loading' | 'ready' | 'invalid';

export default function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);

  const [phase, setPhase] = useState<Phase>('loading');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    if (!token) {
      setPhase('invalid');
      return;
    }
    getInviteInfo(token)
      .then((info) => {
        if (!active) return;
        setEmail(info.email);
        setFirstName(info.first_name);
        setPhase('ready');
      })
      .catch(() => {
        if (active) setPhase('invalid');
      });
    return () => {
      active = false;
    };
  }, [token]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!agreed) {
      setError('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
    setSubmitting(true);
    try {
      // Dead v1 fork: /accept-invite routes to pages/v2/auth-public/AcceptInvitePage,
      // which is where the phone box lives. `null` is "no number submitted", which
      // the API reads as leave the stored one alone - this page captures nothing.
      await acceptInvite(token, password, agreed, null);
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err: unknown) {
      setError(extractApiError(err, 'Could not complete your invitation.'));
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogle = async () => {
    if (!agreed) return;
    setError(null);
    setSubmitting(true);
    try {
      await recordInviteConsent(token, null); // record consent before handing off to Google (no phone: see above)
      await loginWithGoogle(email);     // pin Google to the invited email; full-page redirect on success
    } catch (err: unknown) {
      setError(extractApiError(err, 'Could not continue with Google. Please try again.'));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-surface-light px-6">
      <div className="w-full max-w-sm">
        <div className="rounded-xl bg-surface-light px-8 py-8 shadow-xl ring-1 ring-border">
          {/* Logo lockup — matches LoginPage mobile header (ocean mark + ocean wordmark) */}
          <div className="mb-6 flex items-center justify-center gap-2">
            <ServWaveMark className="h-9 w-auto text-primary" />
            <span className="text-3xl font-bold tracking-tight text-primary">
              Serv<span className="text-primary">Wave</span>
            </span>
          </div>

          {phase === 'loading' && (
            <p className="text-center text-sm text-text-secondary">Loading your invitation…</p>
          )}

          {phase === 'invalid' && (
            <div className="text-center">
              <p className="mb-4 text-sm text-danger">
                This invitation link is invalid or has expired.
              </p>
              {/* link/brand matches text-primary hover:underline. One disclosed, not-restored
                  delta: Button's base font-semibold replaces the raw's font-medium - no weight
                  override exists on Button's prop surface and the layering guard forbids a
                  call-site className for it. */}
              <Button
                variant="link"
                size={null}
                onClick={() => navigate('/login')}
              >
                Go to sign in
              </Button>
            </div>
          )}

          {phase === 'ready' && (
            <>
              <Heading level={2} scale="xl" className="mb-1">
                Welcome{firstName ? `, ${firstName}` : ''}
              </Heading>
              <p className="mb-5 text-sm text-text-secondary">
                Set a password for <strong>{email}</strong> to finish setting up your account.
              </p>

              {error && (
                <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </div>
              )}

              <form onSubmit={onSubmit} className="space-y-4">
                <FormField label="Password" htmlFor="password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2.5 text-sm
                               focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </FormField>
                <FormField label="Confirm password" htmlFor="confirm">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2.5 text-sm
                               focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </FormField>
                {/* Checkbox row (label wraps its control) - not a FormField-shape site, left raw. */}
                <label className="flex items-start gap-2 text-sm text-text-secondary">
                  <Checkbox
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(v === true)}
                    className="mt-0.5"
                    aria-label="Agree to the Terms of Service and Privacy Policy"
                  />
                  <span>
                    I have read and agree to ServWave's{' '}
                    <a
                      href="https://www.servwave.com/terms/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline"
                    >
                      Terms of Service
                    </a>{' '}
                    and{' '}
                    <a
                      href="https://www.servwave.com/privacy/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline"
                    >
                      Privacy Policy
                    </a>
                    .
                  </span>
                </label>
                {!agreed && (
                  <p className="text-xs text-text-secondary">
                    Accept the Terms to continue with a password or Google.
                  </p>
                )}
                {/* solid/brand matches the bg-primary fill, text-on-fill label and disabled:opacity-50
                    exactly. One disclosed, not-restored delta: hover:bg-primary/90 becomes solid/brand's
                    own hover:bg-primary-dark (a different token, close but not identical). */}
                <Button type="submit" disabled={submitting || !agreed} className="w-full">
                  {submitting ? 'Setting up…' : 'Set password & sign in'}
                </Button>
              </form>

              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-text-secondary">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* outline/neutral matches the border-border, bg-surface-light, hover:bg-background-light and
                  disabled:opacity-50 (raw's extra disabled:cursor-not-allowed is a cosmetic cursor-icon-only
                  delta, disclosed). gap-3 restores the raw's exact spacing over Button's base gap-2. Two
                  disclosed, not-restored deltas: Button's base font-semibold replaces the raw's font-medium
                  (no weight override exists on Button's prop surface and the layering guard forbids a
                  call-site className for it), and Button's own [&_svg]:size-4 shrinks GoogleIcon's h-5 w-5
                  (20px) to 16px. */}
              <Button
                type="button"
                variant="outline"
                disabled={submitting || !agreed}
                className="w-full gap-3"
                onClick={onGoogle}
              >
                <GoogleIcon className="h-5 w-5" />
                Continue with Google
              </Button>
              <p className="mt-4 text-center text-xs text-text-secondary">
                Use Google with <strong>{email}</strong> — no password needed.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
