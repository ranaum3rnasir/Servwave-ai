import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check } from 'lucide-react';
import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { GoogleIcon } from '@/components/brand/GoogleIcon';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { FormField } from '@/components/patterns/FormField';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

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

      {/* ── Left brand panel (hidden below lg) ── */}
      <div className="hidden lg:flex lg:w-1/2 flex-col items-center justify-center
                      bg-gradient-to-br from-primary to-primary-dark p-12 relative overflow-hidden">
        {/* Subtle radial highlight - decorative glow over the ocean fill above, so it
            reads from --text-on-fill (the on-a-solid-fill foreground) rather than
            --surface-light, which is the light app canvas and would erase the glow. */}
        <div className="absolute inset-0 opacity-10"
             style={{ background: 'radial-gradient(circle at 25% 75%, rgb(var(--text-on-fill)) 0%, transparent 55%)' }} />

        <div className="relative z-10 max-w-xs text-center text-on-fill">
          {/* Logo lockup — matches the sidebar (bare white mark + all-white wordmark), just larger */}
          <div className="flex items-center justify-center gap-3 mb-8">
            <ServWaveMark className="h-10 w-auto text-on-fill" />
            <span className="text-3xl font-bold tracking-tight text-on-fill">
              Serv<span className="text-on-fill">Wave</span>
            </span>
          </div>

          {/* Tagline */}
          <p className="text-lg font-medium text-on-fill/90 mb-10 leading-snug">
            Field Service Management<br />for Contractors
          </p>

          {/* Value props */}
          <div className="space-y-3 text-left">
            {[
              'Full pipeline: leads → estimates → jobs → invoices',
              'Real-time dispatch board & scheduling calendar',
              'Built for 5–30 technician contractor shops',
            ].map((point) => (
              <div key={point} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center
                                rounded-full bg-on-fill/20">
                  <Check className="h-3 w-3 text-on-fill" />
                </div>
                <span className="text-sm text-on-fill/80 leading-relaxed">{point}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex w-full lg:w-1/2 flex-col items-center justify-center
                      bg-surface-light px-6 py-12">

        {/* Mobile-only logo (shown when left panel is hidden) — same lockup as the sidebar, in ocean for the light background */}
        <div className="mb-8 text-center lg:hidden">
          <div className="flex items-center justify-center gap-2">
            <ServWaveMark className="h-9 w-auto text-primary" />
            <span className="text-3xl font-bold tracking-tight text-primary">
              Serv<span className="text-primary">Wave</span>
            </span>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Field Service Management for Contractors
          </p>
        </div>

        <div className="w-full max-w-sm">
          {/* Elevated form card */}
          <div className="rounded-xl bg-surface-light px-8 py-8 shadow-xl ring-1 ring-border">
            <Heading level={2} scale="2xl" className="mb-6">
              {mfaChallengeId ? 'Verify it’s you' : 'Sign In'}
            </Heading>

            {error && (
              <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            {mfaChallengeId ? (
              <>
                <p className="mb-4 text-sm text-text-secondary">
                  We emailed you a 6-digit verification code. Enter it below to finish signing in.
                </p>
                <form onSubmit={onVerify} className="space-y-4">
                  <FormField label="Verification code" htmlFor="mfa-code">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      autoFocus
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      className="w-full rounded-lg border border-border px-3 py-2.5 text-center text-lg
                                 tracking-[0.5em] focus:border-primary focus:outline-none
                                 focus:ring-2 focus:ring-primary/20"
                      placeholder="••••••"
                    />
                  </FormField>

                  {/* solid/brand matches the bg-primary fill, text-on-fill label and disabled:opacity-50
                      exactly. One disclosed, not-restored delta: hover:bg-primary/90 becomes solid/brand's
                      own hover:bg-primary-dark (a different token, close but not identical). */}
                  <Button type="submit" disabled={isSubmitting || code.length < 6} className="w-full">
                    {isSubmitting ? 'Verifying…' : 'Verify'}
                  </Button>
                </form>

                {resendMsg && <p className="mt-3 text-xs text-success">{resendMsg}</p>}

                {/* link/brand matches text-primary hover:underline. mt-4 restores the raw's spacing.
                    One disclosed, not-restored delta: Button's base font-semibold replaces the raw's
                    font-medium - no weight override exists on Button's prop surface and the layering
                    guard forbids a call-site className for it. */}
                <Button
                  type="button"
                  variant="link"
                  size={null}
                  className="mt-4"
                  onClick={() => void onResend()}
                >
                  Resend code
                </Button>
              </>
            ) : (
            <>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <FormField label="Email" htmlFor="email" error={errors.email?.message}>
                <input
                  type="email"
                  autoComplete="email"
                  {...register('email')}
                  className="w-full rounded-lg border border-border px-3 py-2.5 text-sm
                             focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="you@company.com"
                />
              </FormField>

              <FormField label="Password" htmlFor="password" error={errors.password?.message}>
                <input
                  type="password"
                  autoComplete="current-password"
                  {...register('password')}
                  className="w-full rounded-lg border border-border px-3 py-2.5 text-sm
                             focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="Enter your password"
                />
              </FormField>

              {/* solid/brand matches the bg-primary fill, text-on-fill label and disabled:opacity-50
                  exactly. One disclosed, not-restored delta: hover:bg-primary/90 becomes solid/brand's
                  own hover:bg-primary-dark (a different token, close but not identical). */}
              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-text-secondary">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* outline/neutral matches the border-border, bg-surface-light and hover:bg-background-light
                exactly (hover:text-text-primary is a no-op here since text-text-primary is already the
                idle colour). gap-3 restores the raw's exact spacing over Button's base gap-2. Two
                disclosed, not-restored deltas: Button's base font-semibold replaces the raw's font-medium
                (no weight override exists on Button's prop surface and the layering guard forbids a
                call-site className for it), and Button's own [&_svg]:size-4 shrinks GoogleIcon's h-5 w-5
                (20px) to 16px. */}
            <Button
              type="button"
              variant="outline"
              className="w-full gap-3"
              onClick={() => loginWithGoogle()}
            >
              <GoogleIcon className="h-5 w-5" />
              Sign in with Google
            </Button>
            </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
