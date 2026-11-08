import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
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

import { AuthAlert, AuthCard, AuthDivider } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';

/**
 * /v2/login - the CRM-kit rebuild of `pages/LoginPage.tsx`.
 *
 * SELECTOR SURFACE IS LOAD-BEARING. `e2e/global-setup.ts` logs in through this
 * page for EVERY authed spec in the suite, using `#email`, `#password`, the
 * accessible name `Sign In` on the heading, and the accessible name `Sign In`
 * with `exact: true` on the submit button. All four are preserved verbatim;
 * the Google button keeps its longer label so the exact match cannot hit it.
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
  const [isSubmitting, setIsSubmitting] = useState(false);

  // When the backend issues an email-OTP challenge, hold its id and swap the
  // password form for a code-entry step. No session exists until verifyMfa().
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

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
    <div className="flex h-screen">
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
      <div className="bg-kit-background flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2">
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

            {error && <AuthAlert>{error}</AuthAlert>}

            {mfaChallengeId ? (
              <>
                <p className="text-muted-foreground mb-4 text-sm">
                  We emailed you a 6-digit verification code. Enter it below to finish signing in.
                </p>
                <form onSubmit={onVerify} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mfa-code">Verification code</Label>
                    <Input
                      id="mfa-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      autoFocus
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
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
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
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      aria-invalid={!!errors.password}
                      {...register('password')}
                      placeholder="Enter your password"
                    />
                    {errors.password && (
                      <p className="text-destructive text-xs">{errors.password.message}</p>
                    )}
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
  );
}
