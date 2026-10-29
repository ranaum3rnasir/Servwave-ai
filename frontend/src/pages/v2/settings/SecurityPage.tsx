import { useEffect, useState } from 'react';

import { useOrganization, useUpdateOrganization } from '@/lib/api/organization';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { supabase } from '@/lib/supabase';
import { dropStoredAuthSession } from '@/lib/auth-listener';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { PasswordInput } from '@/ui-kit/components/ui/passwordInput';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Switch } from '@/ui-kit/components/ui/switch';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { SettingRow } from './components/field';

/**
 * Settings > Login & Security.
 *
 * Three independent mechanisms, deliberately NOT unified:
 *   1. SMS 2FA is an ORG-level policy on the organization record, saved through
 *      the shared Save bar.
 *   2. Email OTP is a PER-USER enrollment on /api/auth/mfa/*, raw axios, local
 *      state only. It must never route through useUpdateOrganization - that
 *      flips the dormant org flag instead.
 *   3. Change Password calls POST /api/users/me/password, which re-checks the
 *      current password, sets the new one, signs out the other devices, audits and
 *      notifies (password reset spec §4). The browser never talks to the auth
 *      provider here. The old browser-side re-check + update skipped the server,
 *      and in the 2026-10-25 live test the password changed with no message.
 *      Most likely cause: that handler had no catch, so a rejection from the auth
 *      client after its write left the card blank. The mechanism exists (the auth
 *      library rethrows a USER_UPDATED subscriber's error after saving), but no
 *      throwing listener was identified in this app; a promise that never settles
 *      would leave the card blank the same way. Ruled out: a remount (staging
 *      request log shows none), a stale bundle (the deployed chunk had this render),
 *      CSS, and a reset clearing the message. Every failure now lands in the catch.
 *      If the other devices could not be signed out, the card says so in a warning
 *      and offers "Sign out everywhere": the normal sign-out, which ends every
 *      session including this one. The server keeps THIS device signed in (decision
 *      §9.2); if it reports that this device's session ended too
 *      (`this_device_signed_out`, only when the auth provider demanded a fresher
 *      sign-in first), the page opens sign-in with the "password updated" notice.
 *      A user who signs in only with Google has no current password to type, so for
 *      them the card shows "Set a password by email" instead of the form (spec §4.1,
 *      slice 06). The server decides who that is (GET /api/users/me/password-status);
 *      the button emails the reset link to the address on their own record.
 */

const PASSWORD_UPDATED = "Password updated. You've been signed out on your other devices.";
// The server changed the password but could not end the other sessions: say so, never promise it.
const PASSWORD_UPDATED_OTHERS_ACTIVE =
  "Password updated. We couldn't sign out your other devices. Sign out everywhere to end every session.";
const PASSWORD_FAILED = "We couldn't update your password. Try again or contact ServWave support.";
// The app toaster defaults to 4 s; the confirmation must still be readable 5 s later (§4.3).
const PASSWORD_TOAST_MS = 10_000;

const LINK_NOT_SENT = "We couldn't send the email. Try again or contact ServWave support.";
// The per-user limiter answers a bare 429 with no code and generic text (review item 2).
const LINK_TOO_MANY = "You've asked for too many links. Use the newest email, or try again in 15 minutes.";

/**
 * The password changed, but the server reports this device's session ended with it (the server
 * keeps it whenever it can; decision §9.2). Drop this browser's copy of the ended session, never
 * every device's, and open sign-in with the "password updated" notice, instead of letting the next
 * page bounce the user there unexplained. A full page load, like the 401 path in lib/axios.ts, so
 * nothing of the ended session lingers in memory.
 */
async function leaveEndedSession(othersStillSignedIn: boolean): Promise<void> {
  let signedOut: boolean;
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    signedOut = !error;
  } catch {
    signedOut = false;
  }
  // Refused or offline: the client keeps the stored session, and the page load would restore it.
  if (!signedOut) dropStoredAuthSession();
  window.location.replace(`/login?reset=1${othersStillSignedIn ? '&others=1' : ''}`);
}

/** The server's own message for a refused change (it never carries provider wording). */
function passwordErrorText(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; details?: Array<{ message?: string }> } } })
    ?.response?.data;
  const detail = data?.details?.find((d) => d.message)?.message;
  if (detail) return detail;
  if (data?.error && data.error !== 'Validation failed') return data.error;
  return PASSWORD_FAILED;
}
export default function SecurityPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();
  // "Sign out everywhere" is the normal sign-out: the server revokes every session ('global').
  const logout = useAuthStore((s) => s.logout);

  const [sms, setSms] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [smsSetupOpen, setSmsSetupOpen] = useState(false);

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  // `warn`: the password changed but the other sessions are still open (review O2).
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string; warn?: boolean } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  // Bumped after a successful change so every revealed field goes back to hidden.
  const [pwResetKey, setPwResetKey] = useState(0);

  // Whether the signed-in user has a password at all. Only a strict `has_password: false` from the
  // server swaps the form for "Set a password by email"; a missing or malformed value, or a failed
  // check, shows the form, and the server still refuses a user who has none. While it loads (null)
  // the card shows a neutral placeholder, so a password manager is not offered a form that may vanish.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  // Per-user email-OTP enrollment. This is a DIFFERENT thing from the org-level
  // SMS policy above: it's driven by /api/auth/mfa/* for the signed-in user and
  // must NOT go through useUpdateOrganization (that flips the dormant org flag).
  const [emailEnrolled, setEmailEnrolled] = useState<boolean | null>(null);
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .get('/api/users/me/password-status', { silentErrors: true })
      .then(({ data }) => {
        if (active) setHasPassword(data?.has_password !== false);
      })
      .catch(() => {
        if (active) setHasPassword(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const sendPasswordLink = async () => {
    setLinkMsg(null);
    setLinkBusy(true);
    try {
      // No address in the request: the server sends to the one on the user's own record.
      const { data } = await api.post('/api/users/me/password/email-link', undefined, { silentErrors: true });
      setLinkMsg({ ok: true, text: `We've sent a link to ${data.email}. It expires in 1 hour.` });
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } })?.response;
      const serverText = response?.data?.error;
      let text = typeof serverText === 'string' && serverText ? serverText : LINK_NOT_SENT;
      if (response?.status === 429 && !response.data?.code) text = LINK_TOO_MANY;
      setLinkMsg({ ok: false, text });
    } finally {
      setLinkBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void api
      .get('/api/auth/mfa/status')
      .then(({ data }) => {
        if (active) setEmailEnrolled(!!data.enrolled);
      })
      .catch(() => {
        if (active) setEmailEnrolled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const startEmailSetup = async () => {
    setEmailMsg(null);
    setEmailBusy(true);
    try {
      const { data } = await api.post('/api/auth/mfa/setup');
      setEmailChallengeId(data.challengeId);
      setEmailCode('');
    } catch (err: unknown) {
      setEmailMsg({ ok: false, text: extractApiError(err, 'Could not start setup.') });
    } finally {
      setEmailBusy(false);
    }
  };

  const confirmEmailEnable = async () => {
    if (!emailChallengeId) return;
    setEmailMsg(null);
    setEmailBusy(true);
    try {
      await api.post('/api/auth/mfa/enable', { challengeId: emailChallengeId, code: emailCode.trim() });
      setEmailEnrolled(true);
      setEmailChallengeId(null);
      setEmailCode('');
      setEmailMsg({ ok: true, text: 'Email authentication is on.' });
    } catch (err: unknown) {
      setEmailMsg({ ok: false, text: extractApiError(err, 'That code didn’t match. Try again.') });
    } finally {
      setEmailBusy(false);
    }
  };

  const disableEmail = async () => {
    setEmailMsg(null);
    setEmailBusy(true);
    try {
      await api.post('/api/auth/mfa/disable');
      setEmailEnrolled(false);
      setEmailChallengeId(null);
      setEmailMsg({ ok: true, text: 'Email authentication is off.' });
    } catch (err: unknown) {
      setEmailMsg({ ok: false, text: extractApiError(err, 'Could not disable.') });
    } finally {
      setEmailBusy(false);
    }
  };

  const cancelEmailSetup = () => {
    setEmailChallengeId(null);
    setEmailCode('');
    setEmailMsg(null);
  };

  useEffect(() => {
    if (org && !loaded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate seed-the-form-once idiom, gated by `loaded` so a refetch never clobbers edits
      setSms(org.mfa_sms_enabled ?? false);
      setLoaded(true);
    }
  }, [org, loaded]);

  const isDirty = !!org && sms !== (org.mfa_sms_enabled ?? false);

  useEffect(() => {
    registerSaver({
      save: async () => {
        await update.mutateAsync({ mfa_sms_enabled: sms });
      },
      discard: () => {
        if (org) setSms(org.mfa_sms_enabled ?? false);
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, sms]);

  // Turning SMS 2FA on is a setup step (a modal), not a silent flip; turning it
  // off just disables the policy.
  const onToggleSms = (next: boolean) => {
    if (next) setSmsSetupOpen(true);
    else setSms(false);
  };

  const changePassword = async () => {
    setPwMsg(null);
    if (!pw.current) {
      setPwMsg({ ok: false, text: 'Enter your current password.' });
      return;
    }
    if (pw.next.length < 8) {
      setPwMsg({ ok: false, text: 'Password must be at least 8 characters.' });
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwMsg({ ok: false, text: 'Passwords do not match.' });
      return;
    }
    if (pw.next === pw.current) {
      setPwMsg({ ok: false, text: "Choose a password you haven't used here." });
      return;
    }
    setPwBusy(true);
    try {
      const { data } = await api.post('/api/users/me/password', { current_password: pw.current, password: pw.next });
      if (data?.this_device_signed_out === true) {
        await leaveEndedSession(data?.other_sessions_signed_out === false);
        return;
      }
      if (data?.other_sessions_signed_out === false) {
        setPwMsg({ ok: true, warn: true, text: PASSWORD_UPDATED_OTHERS_ACTIVE });
        toast.warning(PASSWORD_UPDATED_OTHERS_ACTIVE, { duration: PASSWORD_TOAST_MS });
      } else {
        setPwMsg({ ok: true, text: PASSWORD_UPDATED });
        toast.success(PASSWORD_UPDATED, { duration: PASSWORD_TOAST_MS });
      }
      setPw({ current: '', next: '', confirm: '' });
      setPwResetKey((k) => k + 1);
    } catch (err: unknown) {
      // Inline only: a wrong current password or a breached new one is the user's to fix here.
      setPwMsg({ ok: false, text: passwordErrorText(err) });
    } finally {
      setPwBusy(false);
    }
  };

  const messageClass = (ok: boolean) =>
    ok ? 'text-status-green-emphasis text-sm' : 'text-destructive text-sm';
  const warningClass = 'bg-status-amber-subtle text-status-amber-emphasis rounded-lg px-3 py-2 text-sm';

  return (
    <div className="max-w-2xl space-y-6">
      <Section title="Two-Factor Authentication">
        <SettingRow
          title="Require SMS verification at login"
          hint="A one-time code is texted to each user when they sign in."
          control={
            <Switch
              checked={sms}
              onCheckedChange={onToggleSms}
              aria-label="Require SMS verification at login"
            />
          }
        />
      </Section>

      <Section
        title="Email authentication"
        description="Protect your own account with a one-time code emailed to you each time you sign in."
        action={
          emailEnrolled !== null && emailChallengeId === null ? (
            emailEnrolled ? (
              <Button variant="ghost" onClick={() => void disableEmail()} disabled={emailBusy}>
                {emailBusy ? 'Working...' : 'Disable email authentication'}
              </Button>
            ) : (
              <Button onClick={() => void startEmailSetup()} disabled={emailBusy}>
                {emailBusy ? 'Working...' : 'Enable email authentication'}
              </Button>
            )
          ) : undefined
        }
      >
        {emailChallengeId !== null && (
          <div className="border-border space-y-3 border-t pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="email-mfa-code" className="text-xs">
                Verification code
              </Label>
              <Input
                kind="one-time-code"
                id="email-mfa-code"
                maxLength={6}
                placeholder="6-digit code"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
              />
              <p className="text-muted-foreground text-xs">
                We just emailed you a code. Enter it to turn this on.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelEmailSetup} disabled={emailBusy}>
                Cancel
              </Button>
              <Button onClick={() => void confirmEmailEnable()} disabled={emailBusy || emailCode.length < 6}>
                {emailBusy ? 'Confirming...' : 'Confirm'}
              </Button>
            </div>
          </div>
        )}

        {emailMsg && <p className={messageClass(emailMsg.ok)}>{emailMsg.text}</p>}
      </Section>

      <Section title="Change Password">
        {hasPassword === null ? (
          <div data-testid="password-card-loading" aria-busy="true" className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : hasPassword === false ? (
          <>
            <p className="text-sm">
              You sign in with Google. To also sign in with a password, use <strong>Set a password by email</strong>.
            </p>
            {linkMsg && (
              <p role={linkMsg.ok ? 'status' : 'alert'} className={messageClass(linkMsg.ok)}>
                {linkMsg.text}
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={() => void sendPasswordLink()} disabled={linkBusy}>
                {linkBusy ? 'Sending...' : 'Set a password by email'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="sec-current-password" className="text-xs">
                Current password
                <span className="text-destructive ms-0.5" aria-hidden>*</span>
              </Label>
              <PasswordInput
                id="sec-current-password"
                autoComplete="current-password"
                resetKey={pwResetKey}
                value={pw.current}
                onChange={(e) => setPw({ ...pw, current: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sec-new-password" className="text-xs">
                New password
                <span className="text-destructive ms-0.5" aria-hidden>*</span>
              </Label>
              <PasswordInput
                id="sec-new-password"
                aria-describedby="sec-new-password-hint"
                autoComplete="new-password"
                resetKey={pwResetKey}
                value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })}
              />
              <p id="sec-new-password-hint" className="text-muted-foreground text-xs">
                At least 8 characters. Don&rsquo;t reuse a password from another site.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sec-confirm-password" className="text-xs">
                Confirm new password
                <span className="text-destructive ms-0.5" aria-hidden>*</span>
              </Label>
              <PasswordInput
                id="sec-confirm-password"
                autoComplete="new-password"
                resetKey={pwResetKey}
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
              />
            </div>
            {pwMsg?.warn ? (
              <div role="status" className={warningClass}>
                <p>{pwMsg.text}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void logout()}>
                  Sign out everywhere
                </Button>
              </div>
            ) : (
              pwMsg && (
                <p role={pwMsg.ok ? 'status' : 'alert'} className={messageClass(pwMsg.ok)}>
                  {pwMsg.text}
                </p>
              )
            )}
            <div className="flex justify-end">
              <Button onClick={() => void changePassword()} disabled={pwBusy}>
                {pwBusy ? 'Updating...' : 'Update password'}
              </Button>
            </div>
          </>
        )}
      </Section>

      <Dialog open={smsSetupOpen} onOpenChange={setSmsSetupOpen}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>Set up SMS authentication</DialogTitle>
            <DialogDescription>
              When enabled, every user will be asked to enter a one-time code sent to their phone after their password.
              SMS delivery isn&rsquo;t connected yet, so this is saved as your organization&rsquo;s policy and starts enforcing once
              text messaging is configured.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSmsSetupOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setSms(true);
                setSmsSetupOpen(false);
              }}
            >
              Enable SMS 2FA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
