import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check } from 'lucide-react';

import { GoogleIcon } from '@/components/brand/GoogleIcon';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { PasswordInput } from '@/ui-kit/components/ui/passwordInput';

import { AuthAlert, AuthCard, AuthDivider } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';

/**
 * /v2/login - the CRM-kit rebuild of `pages/LoginPage.tsx`.
 *
 * SELECTOR SURFACE IS LOAD-BEARING. `e2e/global-setup.ts` logs in through this
 * page for EVERY authed spec in the suite, using `#email`, `#password`, the
 * accessible name `Sign In` on the heading, and the accessible name `Sign In`
 * with `exact: true` on the submit button. All four are preserved verbatim;
 * the Google button keeps its longer label so the exact match cannot hit it.
 *
 * "Forgot password?" (password reset spec §5.1) sits under the password field and carries the
 * typed email to /forgot-password as `?email=`. `?reset=1` (where a completed reset lands) shows
 * a fixed notice; with `&others=1` it shows instead a warning that the password changed but other
 * devices may still be signed in. No query parameter on this page is ever used as a place to go.
 *
 * Business logic is imported, never re-implemented: `login`, `verifyMfa` and
 * `loginWithGoogle` come from the auth store, the zod schema is the same shape,
 * and the resend still POSTs `/api/auth/mfa/resend` through the app's axios
 * instance. Nothing here touches `initAuthListener` or the store's internals.
 */
const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

const VALUE_PROPS = [
  'Full pipeline: leads -> estimates -> jobs -> invoices',
  'Real-time dispatch board and scheduling calendar',
  'Built for 5-30 technician contractor shops',
];

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const verifyMfa = useAuthStore((s) => s.verifyMfa);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(searchParams.get('error'));
  const passwordWasReset = searchParams.get('reset') === '1';
  // Set by the reset page when the server could not confirm the other sessions were signed out.
  const othersStillSignedIn = passwordWasReset && searchParams.get('others') === '1';
  const [isSubmitting, setIsSubmitting] = useState(false);

  // When the backend issues an email-OTP challenge, hold its id and swap the
  // password form for a code-entry step. No session exists until verifyMfa().
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });
  const typedEmail = (useWatch({ control, name: 'email' }) ?? '').trim();

  const proceedAfterAuth = () => {
    navigate('/', { replace: true });
  };

  const onSubmit = async (data: LoginForm) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await login(data.email, data.password);
      if (result.mfaRequired) {
        setMfaChallengeId(result.challengeId);
        return;
      }
      proceedAfterAuth();
    } catch (err: unknown) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaChallengeId) return;
    setError(null);
    setResendMsg(null);
    setIsSubmitting(true);
    try {
      await verifyMfa(mfaChallengeId, code.trim());
      proceedAfterAuth();
    } catch (err: unknown) {
      setError((err as Error).message || 'Verification failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onResend = async () => {
    if (!mfaChallengeId) return;
    setError(null);
    setResendMsg(null);
    try {
      await api.post('/api/auth/mfa/resend', { challengeId: mfaChallengeId });
      setResendMsg('A new code has been sent.');
    } catch (err: unknown) {
      setError(extractApiError(err, 'Could not resend the code. Try again in a moment.'));
    }
  };

  return (
    <div className="pad-safe flex h-dvh">
      {/* Brand panel - hidden below lg, exactly as the legacy page hides it. */}
      <div className="from-primary to-primary-dark relative hidden overflow-hidden bg-gradient-to-br p-12 lg:flex lg:w-1/2 lg:flex-col lg:items-center lg:justify-center">
        {/* Decorative glow over the ocean fill. Read from --text-on-fill (the
            on-a-solid-fill foreground) rather than a surface token, which is
            the light app canvas and would erase the glow. */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            background: 'radial-gradient(circle at 25% 75%, rgb(var(--text-on-fill)) 0%, transparent 55%)',
          }}
        />

        <div className="text-on-fill relative z-10 max-w-xs text-center">
          <BrandLockup tone="onFill" size="lg" className="mb-8" />

          <p className="text-on-fill/90 mb-10 text-lg font-medium leading-snug">
            Field Service Management
            <br />
            for Contractors
          </p>

          <div className="space-y-3 text-left">
            {VALUE_PROPS.map((point) => (
              <div key={point} className="flex items-start gap-3">
                <div className="bg-on-fill/20 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
                  <Check className="text-on-fill size-3" />
                </div>
                <span className="text-on-fill/80 text-sm leading-relaxed">{point}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Form panel. */}
      {/* The panel is the page's bounded scroller: html/body do not scroll, so on a phone held
          sideways (390 px tall) it is this panel that carries the form to its last control.
          `my-auto` on the content centres it when it fits and starts it at the top when it does
          not, which `justify-center` would clip. */}
      <div className="bg-kit-background flex w-full flex-col items-center overflow-y-auto overscroll-contain px-6 py-12 lg:w-1/2">
        <div className="my-auto flex w-full flex-col items-center">
        {/* Mobile header - shown when the brand panel is hidden. */}
        <div className="mb-8 text-center lg:hidden">
          <BrandLockup />
          <p className="text-muted-foreground mt-2 text-sm">
            Field Service Management for Contractors
          </p>
        </div>

        <div className="w-full max-w-sm">
          <AuthCard>
            {/* `role="heading"` rather than an <h2>: the raw-tag ratchet in
                design-system/__tests__/component-api-guard.test.ts governs
                h1-h6 outside the primitives, and the accessible name - which
                is what global-setup.ts matches on - is identical either way. */}
            <p role="heading" aria-level={2} className="mb-6 text-xl font-semibold">
              {mfaChallengeId ? 'Verify it’s you' : 'Sign In'}
            </p>

            {passwordWasReset && !othersStillSignedIn && !mfaChallengeId && (
              <div
                role="status"
                className="bg-status-green-subtle text-status-green-emphasis mb-4 rounded-lg px-3 py-2 text-sm"
              >
                Your password was updated. Sign in with your new password.
              </div>
            )}
            {othersStillSignedIn && !mfaChallengeId && (
              <div
                role="alert"
                className="bg-status-amber-subtle text-status-amber-emphasis mb-4 rounded-lg px-3 py-2 text-sm"
              >
                Your password was updated, but we couldn&apos;t sign out your other devices. Contact ServWave support if
                you think someone else has access.
              </div>
            )}

            {error && <AuthAlert>{error}</AuthAlert>}

            {mfaChallengeId ? (
              <>
                <p className="text-muted-foreground mb-4 text-sm">
                  We emailed you a 6-digit verification code. Enter it below to finish signing in.
                </p>
                <form noValidate onSubmit={onVerify} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mfa-code">Verification code</Label>
                    <Input
                      kind="one-time-code"
                      id="mfa-code"
                      maxLength={6}
                      autoFocus={canAutoFocus()}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      className="text-center text-lg tracking-[0.5em]"
                      placeholder="••••••"
                    />
                  </div>

                  <Button type="submit" disabled={isSubmitting || code.length < 6} className="w-full">
                    {isSubmitting ? 'Verifying…' : 'Verify'}
                  </Button>
                </form>

                {resendMsg && (
                  <p className="text-status-green-emphasis mt-3 text-xs">{resendMsg}</p>
                )}

                {/* Not rate-limited or disabled client side, exactly as today -
                    the backend's mfaResendLimiter is the only throttle. */}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mt-4 px-0"
                  onClick={() => void onResend()}
                >
                  Resend code
                </Button>
              </>
            ) : (
              <>
                <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      kind="email"
                      id="email"
                      aria-invalid={!!errors.email}
                      {...register('email')}
                      placeholder="you@company.com"
                    />
                    {errors.email && (
                      <p className="text-destructive text-xs">{errors.email.message}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="password">Password</Label>
                    {/* Unmounts on the switch to the email-code step, so a revealed
                        password never carries over into it. */}
                    <PasswordInput
                      id="password"
                      autoComplete="current-password"
                      aria-invalid={!!errors.password}
                      {...register('password')}
                      placeholder="Enter your password"
                    />
                    {errors.password && (
                      <p className="text-destructive text-xs">{errors.password.message}</p>
                    )}
                    <div className="flex justify-end">
                      <Button asChild variant="link" size="sm" className="h-auto px-0">
                        <Link
                          to={{
                            pathname: '/forgot-password',
                            search: typedEmail ? `?email=${encodeURIComponent(typedEmail)}` : '',
                          }}
                        >
                          Forgot password?
                        </Link>
                      </Button>
                    </div>
                  </div>

                  <Button type="submit" disabled={isSubmitting} className="w-full">
                    {isSubmitting ? 'Signing in…' : 'Sign In'}
                  </Button>
                </form>

                <AuthDivider />

                {/* GoogleIcon keeps its literal brand hexes on purpose - see the
                    exemption note in components/brand/GoogleIcon.tsx. */}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full gap-3 [&_svg]:size-5"
                  onClick={() => loginWithGoogle()}
                >
                  <GoogleIcon />
                  Sign in with Google
                </Button>
              </>
            )}
          </AuthCard>
        </div>
        </div>
      </div>
    </div>
  );
}
