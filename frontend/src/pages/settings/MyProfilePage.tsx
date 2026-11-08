import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuthStore, userDisplayName } from '@/stores/auth.store';
import { useUpdateMe, useChangeMyPassword, type UpdateMePayload } from '@/lib/api/users';
import { useSettingsBar } from './SettingsLayout';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import MyTimeLog from '@/components/timeclock/MyTimeLog';
import { AvatarUploadControl } from '@/components/settings/AvatarUploadControl';
import { formatPhone, formatPhoneInput } from '@/lib/utils';

interface ProfileFormValues {
  first_name: string;
  last_name: string;
  phone: string;
  phone_ext: string;
}

function dirtyValues(
  dirtyFields: Record<string, unknown>,
  values: ProfileFormValues,
): UpdateMePayload {
  const out: UpdateMePayload = {};
  if (dirtyFields.first_name) out.first_name = values.first_name;
  if (dirtyFields.last_name) out.last_name = values.last_name;
  if (dirtyFields.phone) out.phone = values.phone || null;
  if (dirtyFields.phone_ext) out.phone_ext = values.phone_ext || null;
  return out;
}

export default function MyProfilePage() {
  const user = useAuthStore((s) => s.user);
  // Merge the saved row back into the cached auth user so the header (name) and
  // this page reflect the change immediately — no full /api/auth/me re-fetch.
  const applyUserPatch = useAuthStore((s) => s.applyUserPatch);
  const updateMe = useUpdateMe();
  const changePassword = useChangeMyPassword();
  const { registerSaver } = useSettingsBar();

  const form = useForm<ProfileFormValues>({
    defaultValues: { first_name: '', last_name: '', phone: '', phone_ext: '' },
  });
  const { register, reset, handleSubmit, formState, watch, setValue } = form;
  const isDirty = formState.isDirty;

  useEffect(() => {
    if (user) {
      reset({
        first_name: user.first_name ?? '',
        last_name: user.last_name ?? '',
        phone: formatPhone(user.phone ?? ''),
        phone_ext: user.phone_ext ?? '',
      });
    }
  }, [user, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values);
    if (Object.keys(payload).length === 0) return;
    const updated = await updateMe.mutateAsync(payload);
    // Refresh the cached auth user so the header / store reflect the new name/phone.
    applyUserPatch({
      first_name: updated.first_name,
      last_name: updated.last_name,
      phone: updated.phone,
      phone_ext: updated.phone_ext,
      has_login: updated.has_login,
    });
    reset(values);
  });

  useEffect(() => {
    registerSaver({ save: onSubmit, discard: () => user && reset(), isDirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  // ── Password change (separate, self-contained form) ───────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const passwordTooShort = newPassword.length > 0 && newPassword.length < 8;
  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  // SECURITY (review #4): the current password is required — the backend re-authenticates with it
  // before changing the password, so a stolen session can't silently reset credentials.
  const canSubmitPassword =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !changePassword.isPending;

  const submitPassword = async () => {
    if (!canSubmitPassword) return;
    await changePassword.mutateAsync({ currentPassword, newPassword });
    toast({ title: 'Password updated' });
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  // Hide the password card only for seats with no login at all (`has_login` ===
  // false). Password and Google-login users both keep it (Google users can also
  // set a password). `has_login` now comes from /api/auth/me; default to showing.
  const showPasswordSection = user?.has_login !== false;

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <Heading level={3}>Photo</Heading>
        <AvatarUploadControl
          avatarUrl={user?.avatar_url}
          displayName={userDisplayName(user)}
          onChange={(avatar_url) => applyUserPatch({ avatar_url })}
        />
      </Card>

      <Card className="space-y-4">
        <Heading level={3}>My Details</Heading>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First name" required>
            <Input {...register('first_name', { required: true })} />
          </Field>
          <Field label="Last name" required>
            <Input {...register('last_name', { required: true })} />
          </Field>
          <Field label="Phone">
            <Input
              type="tel"
              value={watch('phone') ?? ''}
              onChange={(e) => setValue('phone', formatPhoneInput(e.target.value), { shouldDirty: true })}
            />
          </Field>
          <Field label="Phone extension">
            <Input {...register('phone_ext')} />
          </Field>
          <Field label="Email">
            <Input value={user?.email ?? ''} disabled readOnly />
          </Field>
          <Field label="Role">
            <Input value={user?.role ?? ''} disabled readOnly />
          </Field>
        </div>
        <p className="text-xs text-text-secondary">
          Your role, team, and access are managed by an administrator.
        </p>
      </Card>

      <MyTimeLog />

      {showPasswordSection && (
        <Card className="space-y-4">
          <Heading level={3}>Change Password</Heading>
          <div className="grid max-w-md gap-4">
            <Field label="Current password">
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              {passwordTooShort && (
                <p className="text-xs text-danger">Password must be at least 8 characters.</p>
              )}
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
              {passwordMismatch && <p className="text-xs text-danger">Passwords do not match.</p>}
            </Field>
            <div>
              <Button
                variant="solid" tone="business"
                size="sm"
                disabled={!canSubmitPassword}
                onClick={() => void submitPassword()}
              >
                {changePassword.isPending ? 'Updating…' : 'Update Password'}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children}
    </div>
  );
}
