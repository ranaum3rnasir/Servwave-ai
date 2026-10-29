import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { TOO_MANY_ATTEMPTS_MESSAGE, isRateLimited, requestResetLink } from '@/lib/api/passwordReset';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

import { AuthAlert, AuthCard } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';

/** How long before "Send again" is offered. */
const RESEND_AFTER_MS = 60_000;

const emailField = z.string().trim().email();

/**
 * /forgot-password - ask for a password reset link (password reset spec §5.1 step 2).
 *
 * The confirmation is the same for every address: the server answers the same whether or not an
 * account exists, and this page says nothing it was not told. The `?email=` the sign-in page
 * carries over only fills the field. No query parameter on this page navigates anywhere: "Back to
 * sign in" is a fixed route.
 */
export default function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The address the last link was requested for; set once the server has answered. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const waitingToResend = sentTo !== null && now < resendAt;
  useEffect(() => {
    if (!waitingToResend) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [waitingToResend]);

  const send = async (address: string) => {
    setError(null);
    setSubmitting(true);
    try {
      await requestResetLink(address);
      setSentTo(address);
      const at = Date.now();
      setNow(at);
      setResendAt(at + RESEND_AFTER_MS);
    } catch (err: unknown) {
      setError(isRateLimited(err) ? TOO_MANY_ATTEMPTS_MESSAGE : extractApiError(err, "We couldn't send the link. Try again in a moment."));
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = emailField.safeParse(email);
    if (!parsed.success) {
      setFieldError('Enter a valid email');
      return;
    }
    setFieldError(null);
    void send(parsed.data);
  };

  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  return (
    <div className="pad-safe bg-kit-background h-dvh overflow-y-auto overscroll-contain">
      <div className="flex min-h-full items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm">
          <AuthCard>
            <BrandLockup className="mb-6" />
            <p role="heading" aria-level={2} className="mb-4 text-lg font-semibold">
              Reset your password
            </p>

            {error && <AuthAlert>{error}</AuthAlert>}

            {sentTo === null ? (
              <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
                <p className="text-muted-foreground text-sm">
                  Enter the email you sign in with and we&apos;ll send you a link to choose a new password.
                </p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    kind="email"
                    id="email"
                    value={email}
                    aria-invalid={!!fieldError}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                  {fieldError && <p className="text-destructive text-xs">{fieldError}</p>}
                </div>
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Sending…' : 'Send reset link'}
                </Button>
              </form>
            ) : (
              <div className="flex flex-col gap-4">
                <p role="status" className="text-sm">
                  If an account exists for <strong>{sentTo}</strong>, we&apos;ve sent a link to reset your password. It
                  expires in 1 hour. Check your spam folder if it doesn&apos;t arrive.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={submitting || waitingToResend}
                  aria-describedby={waitingToResend ? 'resend-wait' : undefined}
                  onClick={() => void send(sentTo)}
                >
                  Send again
                </Button>
                {waitingToResend && (
                  <p id="resend-wait" className="text-muted-foreground -mt-2 text-center text-xs">
                    You can send another link in {secondsLeft} s.
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 text-center">
              <Button asChild variant="link" size="sm">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          </AuthCard>
        </div>
      </div>
    </div>
  );
}
