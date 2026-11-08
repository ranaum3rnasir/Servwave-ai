import { useEffect, useState } from 'react';

import { useOrganization, useUpdateOrganization } from '@/lib/api/organization';
import { useAuthStore } from '@/stores/auth.store';
import { supabase } from '@/lib/supabase';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
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
 *   3. Change Password here goes through supabase-js directly (re-auth then
 *      updateUser). My Profile has a SECOND implementation that goes through the
 *      API. Both survive the swap; merging them is a behaviour change.
 */
export default function SecurityPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();
  const email = useAuthStore((s) => s.user?.email ?? '');

  const [sms, setSms] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [smsSetupOpen, setSmsSetupOpen] = useState(false);

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

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
    setPwBusy(true);
    try {
      // Re-authenticate with the current password before allowing a change.
      const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: pw.current });
      if (reauthError) {
        setPwMsg({ ok: false, text: 'Current password is incorrect.' });
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: pw.next });
      if (error) setPwMsg({ ok: false, text: error.message });
      else {
        setPwMsg({ ok: true, text: 'Password updated.' });
        setPw({ current: '', next: '', confirm: '' });
      }
    } finally {
      setPwBusy(false);
    }
  };

  const messageClass = (ok: boolean) =>
    ok ? 'text-status-green-emphasis text-sm' : 'text-destructive text-sm';

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
                id="email-mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
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
        <div className="space-y-1.5">
          <Label htmlFor="sec-current-password" className="text-xs">
            Current password
            <span className="text-destructive ms-0.5" aria-hidden>*</span>
          </Label>
          <Input
            id="sec-current-password"
            type="password"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sec-new-password" className="text-xs">
            New password
            <span className="text-destructive ms-0.5" aria-hidden>*</span>
          </Label>
          <Input
            id="sec-new-password"
            type="password"
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sec-confirm-password" className="text-xs">
            Confirm new password
            <span className="text-destructive ms-0.5" aria-hidden>*</span>
          </Label>
          <Input
            id="sec-confirm-password"
            type="password"
            value={pw.confirm}
            onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
          />
        </div>
        {pwMsg && <p className={messageClass(pwMsg.ok)}>{pwMsg.text}</p>}
        <div className="flex justify-end">
          <Button onClick={() => void changePassword()} disabled={pwBusy}>
            {pwBusy ? 'Updating...' : 'Update password'}
          </Button>
        </div>
      </Section>

      <Dialog open={smsSetupOpen} onOpenChange={setSmsSetupOpen}>
        <DialogContent>
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
