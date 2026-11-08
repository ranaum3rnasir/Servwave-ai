import { useEffect, useState } from 'react';
import { useOrganization, useUpdateOrganization } from '@/lib/api/organization';
import { useSettingsBar } from './SettingsLayout';
import { useAuthStore } from '@/stores/auth.store';
import { supabase } from '@/lib/supabase';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

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

  return (
    <div className="max-w-2xl space-y-6">
      <Card className="space-y-4">
        <Heading level={3}>Two-Factor Authentication</Heading>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-primary">Require SMS verification at login</span>
            <p className="text-xs text-text-secondary">A one-time code is texted to each user when they sign in.</p>
          </div>
          <Switch checked={sms} onCheckedChange={onToggleSms} />
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Heading level={3}>Email authentication</Heading>
            <p className="mt-1 text-xs text-text-secondary">
              Protect your own account with a one-time code emailed to you each time you sign in.
            </p>
          </div>
          {emailEnrolled !== null && emailChallengeId === null && (
            emailEnrolled ? (
              <Button variant="ghost" onClick={() => void disableEmail()} disabled={emailBusy}>
                {emailBusy ? 'Working…' : 'Disable email authentication'}
              </Button>
            ) : (
              <Button onClick={() => void startEmailSetup()} disabled={emailBusy}>
                {emailBusy ? 'Working…' : 'Enable email authentication'}
              </Button>
            )
          )}
        </div>

        {emailChallengeId !== null && (
          <div className="space-y-3 border-t border-border pt-4">
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
              <p className="text-xs text-text-secondary">We just emailed you a code. Enter it to turn this on.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelEmailSetup} disabled={emailBusy}>
                Cancel
              </Button>
              <Button onClick={() => void confirmEmailEnable()} disabled={emailBusy || emailCode.length < 6}>
                {emailBusy ? 'Confirming…' : 'Confirm'}
              </Button>
            </div>
          </div>
        )}

        {emailMsg && (
          <p className={`text-sm ${emailMsg.ok ? 'text-success' : 'text-danger'}`}>{emailMsg.text}</p>
        )}
      </Card>

      <Card className="space-y-4">
        <Heading level={3}>Change Password</Heading>
        <div className="space-y-1.5">
          <Label className="text-xs">
            Current password<span className="ml-0.5 text-danger">*</span>
          </Label>
          <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            New password<span className="ml-0.5 text-danger">*</span>
          </Label>
          <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            Confirm new password<span className="ml-0.5 text-danger">*</span>
          </Label>
          <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        </div>
        {pwMsg && <p className={`text-sm ${pwMsg.ok ? 'text-success' : 'text-danger'}`}>{pwMsg.text}</p>}
        <div className="flex justify-end">
          <Button onClick={() => void changePassword()} disabled={pwBusy}>
            {pwBusy ? 'Updating…' : 'Update password'}
          </Button>
        </div>
      </Card>

      <Dialog open={smsSetupOpen} onOpenChange={setSmsSetupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up SMS authentication</DialogTitle>
            <DialogDescription>
              When enabled, every user will be asked to enter a one-time code sent to their phone after their password.
              SMS delivery isn’t connected yet, so this is saved as your organization’s policy and starts enforcing once
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
