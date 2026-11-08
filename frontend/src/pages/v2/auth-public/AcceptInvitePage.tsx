import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { GoogleIcon } from '@/components/brand/GoogleIcon';
// The kit ships no link primitive, and the raw-`<a>` ratchet is at its floor,
// so the app's ActionLink stands in. Recorded in the module's gap ledger.
import { ActionLink } from '@/components/ui/action-link';
import { useAuthStore } from '@/stores/auth.store';
import { getInviteInfo, acceptInvite, recordInviteConsent } from '@/lib/api/invite';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';
import { isUsableUserPhone, userPhoneForSubmit, USER_PHONE_INVALID_MESSAGE } from '@/lib/user-phone';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

import { AuthAlert, AuthCard, AuthDivider } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';
import { v2Path } from '../uiV2';

type Phase = 'loading' | 'ready' | 'invalid';

/**
 * /v2/accept-invite - the CRM-kit rebuild of `pages/AcceptInvitePage.tsx`.
 *
 * The token flow is imported wholesale from `lib/api/invite.ts`:
 * `getInviteInfo` is a POST so the single-use token stays out of request logs,
 * `acceptInvite` records ToS/Privacy consent alongside the password, and
 * `recordInviteConsent` records it separately on the Google path before the
 * full-page redirect. `loginWithGoogle(email)` still pins the OAuth request to
 * the invited address.
 *
 * KNOWN, DELIBERATELY REPRODUCED: step 4 calls `login()` and discards the
 * returned `LoginResult`. With email-OTP MFA enabled the store resolves
 * `{mfaRequired:true}` with no session set and this page still navigates to
 * `/`, which ProtectedRoute bounces to /login. That is the legacy behaviour
 * and fixing it here would be a behaviour change, not a restyle.
 */
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
  const [phone, setPhone] = useState('');
  // Whether the hire TOUCHED the box, not whether what is in it is usable. The
  // prefill can carry a legacy number that predates normalization, and gating
  // on the stored value would leave that hire unable to accept their own invite
  // over a field they never typed in - the admin-dialog lockout in another
  // chair (see MyProfilePage / UsersTeamsPage, Spec C slice 2).
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation of the invite token in the URL
      setPhase('invalid');
      return;
    }
    getInviteInfo(token)
      .then((info) => {
        if (!active) return;
        setEmail(info.email);
        setFirstName(info.first_name);
        // Formatted, not raw E.164: the box is a US display mask, and showing
        // the stored number is what stops a blank submit being accidental.
        setPhone(formatPhone(info.phone));
        setPhase('ready');
      })
      .catch(() => {
        if (active) setPhase('invalid');
      });
    return () => {
      active = false;
    };
  }, [token]);

  // Same rule the API enforces, scoped to what was actually typed. Blank is not
  // rejected: the field is optional, and a blank box means "leave what is
  // stored alone" rather than "erase it".
  const phoneRejected = phoneTouched && !isUsableUserPhone(phone);

  /**
   * What to SEND for the phone box, on either path.
   *
   * `userPhoneForSubmit` answers null for anything that does not normalize, so
   * an UNTOUCHED legacy prefill sends null and the stored value is left as it
   * was. Nothing unusable can reach here typed, because `phoneRejected` blocks
   * the submit first.
   */
  const phoneToSend = () => userPhoneForSubmit(phone);

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
    if (phoneRejected) {
      setError(USER_PHONE_INVALID_MESSAGE);
      return;
    }
    if (!agreed) {
      setError('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvite(token, password, agreed, phoneToSend());
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
    // The phone box is above the consent row and belongs to whichever button
    // the hire presses. Gate it here too, or the Google path becomes the way to
    // submit a number the password path would have refused.
    if (phoneRejected) {
      setError(USER_PHONE_INVALID_MESSAGE);
      return;
    }
    setSubmitting(true);
    try {
      await recordInviteConsent(token, phoneToSend()); // record consent + phone before handing off to Google
      await loginWithGoogle(email); // pin Google to the invited email; full-page redirect on success
    } catch (err: unknown) {
      setError(extractApiError(err, 'Could not continue with Google. Please try again.'));
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-kit-background flex h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <AuthCard>
          <BrandLockup className="mb-6" />

          {phase === 'loading' && (
            <p className="text-muted-foreground text-center text-sm">Loading your invitation…</p>
          )}

          {phase === 'invalid' && (
            <div className="text-center">
              <p className="text-destructive mb-4 text-sm">
                This invitation link is invalid or has expired.
              </p>
              <Button variant="link" size="sm" onClick={() => navigate(v2Path('/login'))}>
                Go to sign in
              </Button>
            </div>
          )}

          {phase === 'ready' && (
            <>
              <p role="heading" aria-level={2} className="mb-1 text-lg font-semibold">
                Welcome{firstName ? `, ${firstName}` : ''}
              </p>
              <p className="text-muted-foreground mb-5 text-sm">
                Set a password for <strong>{email}</strong> to finish setting up your account.
              </p>

              {error && <AuthAlert>{error}</AuthAlert>}

              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>

                {/* The one capture surface a new hire is guaranteed to see.
                    Optional, and the hint under it says so: a blank submits
                    normally. The wrapper follows the label-plus-input pair the
                    fields above use rather than importing a form pattern this
                    page does not have. */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="phone">Phone number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="(555) 123-4567"
                    value={phone}
                    onChange={(e) => {
                      setPhone(formatPhoneInput(e.target.value));
                      setPhoneTouched(true);
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    Optional. Used to text you about jobs you are assigned to.
                  </p>
                </div>

                {/* Consent row. The label wraps its own control, so this is not
                    a FormField shape; the kit has no consent primitive either. */}
                <div className="text-muted-foreground flex items-start gap-2 text-sm">
                  <Checkbox
                    id="accept-terms"
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(v === true)}
                    className="mt-0.5"
                    aria-label="Agree to the Terms of Service and Privacy Policy"
                  />
                  <Label htmlFor="accept-terms" className="text-muted-foreground font-normal leading-relaxed">
                    I have read and agree to ServWave&apos;s{' '}
                    <ActionLink
                      href="https://www.servwave.com/terms/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Terms of Service
                    </ActionLink>{' '}
                    and{' '}
                    <ActionLink
                      href="https://www.servwave.com/privacy/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Privacy Policy
                    </ActionLink>
                    .
                  </Label>
                </div>
                {!agreed && (
                  <p className="text-muted-foreground text-xs">
                    Accept the Terms to continue with a password or Google.
                  </p>
                )}

                <Button type="submit" disabled={submitting || !agreed} className="w-full">
                  {submitting ? 'Setting up…' : 'Set password & sign in'}
                </Button>
              </form>

              <AuthDivider />

              <Button
                type="button"
                variant="outline"
                disabled={submitting || !agreed}
                className="w-full gap-3 [&_svg]:size-5"
                onClick={onGoogle}
              >
                <GoogleIcon />
                Continue with Google
              </Button>
              <p className="text-muted-foreground mt-4 text-center text-xs">
                Use Google with <strong>{email}</strong> - no password needed.
              </p>
            </>
          )}
        </AuthCard>
      </div>
    </div>
  );
}
