import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';

import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useUpdateMe, type UpdateMePayload } from '@/lib/api/users';
import MyTimeLog from '@/components/timeclock/MyTimeLog';
import { formatPhone } from '@/lib/utils';
import { isUsableUserPhone, userPhoneForSubmit, USER_PHONE_INVALID_MESSAGE } from '@/lib/user-phone';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { PhoneInput } from '@/ui-kit/components/form/phoneInput';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { Field, SettingRow } from './components/field';

const SECURITY_PATH = '/settings/security';

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
  // E.164, not the masked display form the box shows - the column must hold ONE
  // spelling, and normalizing here is what makes the reopened form match it.
  if (dirtyFields.phone) out.phone = userPhoneForSubmit(values.phone);
  if (dirtyFields.phone_ext) out.phone_ext = values.phone_ext || null;
  return out;
}

/**
 * Settings > My Profile.
 *
 * The password is changed in one place only, Login & Security (password reset
 * spec §4.1, decision §9.1). This page just links there.
 */
export default function MyProfilePage() {
  const user = useAuthStore((s) => s.user);
  // Merge the saved row back into the cached auth user so the header (name) and
  // this page reflect the change immediately - no full /api/auth/me re-fetch.
  const applyUserPatch = useAuthStore((s) => s.applyUserPatch);
  const updateMe = useUpdateMe();
  const { registerSaver } = useSettingsBar();
  const navigate = useNavigate();
  const guardDirty = useSettingsGuard((s) => s.isDirty);
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const form = useForm<ProfileFormValues>({
    defaultValues: { first_name: '', last_name: '', phone: '', phone_ext: '' },
  });
  const { register, reset, handleSubmit, formState, watch, setValue } = form;
  const isDirty = formState.isDirty;

  // The id this form was last hydrated FROM - not a boolean, because a genuine
  // identity change still has to re-hydrate (see below).
  const hydratedUserId = useRef<string | null>(null);

  // Hydrate once per identity, and never over an edit in progress.
  //
  // `user` is a brand new OBJECT on every /api/auth/me revalidation - the store
  // does `set({ user: data.user })` and Zustand has no structural sharing - and
  // that revalidation is unattended. Depending on the object alone therefore
  // re-ran this effect mid-edit, and `reset()` threw the typed value away.
  //
  // Worse than the lost keystrokes: `reset()` also takes `isDirty` back to
  // false, and SettingsLayout pushes that same flag into the settings guard
  // store, so the unsaved-changes prompt stopped asking. The user could then
  // walk away from edits they still believed were pending. That is exactly the
  // loss d0a1995df separated `canSave` from `isDirty` to prevent, arriving
  // through a different door - the guard is not wrong, it has been lied to.
  //
  // BOTH conditions are needed; neither alone is enough:
  //   - the dirty check stops a same-user refetch from clobbering an edit, but
  //     on its own it would strand the PREVIOUS user's values in the form when
  //     a session changes identity while dirty. checkAuth() treats that as a
  //     real case - it clears the whole query cache when /api/auth/me answers
  //     with a different id - so this form must not be the one surface still
  //     showing the old account.
  //   - the id check re-hydrates on that identity change, but on its own it
  //     would freeze a pristine form against a profile edited elsewhere, and
  //     against the applyUserPatch this page performs after its own save.
  //
  // `isDirty` is deliberately NOT a dependency. It is a getter on RHF's
  // formState Proxy: listing it would re-arm the effect on every dirty flip,
  // which is the re-run this change exists to remove. The value read here is
  // the one from the render that scheduled this run, which is exactly the
  // question being asked - is the form dirty NOW, as this user object arrives.
  //
  // Same seed-once shape BrandingPage and SecurityPage already use one file
  // over, where the gate is a `loaded` flag for the same stated reason.
  useEffect(() => {
    if (!user) return;
    const identityChanged = hydratedUserId.current !== user.id;
    if (!identityChanged && isDirty) return;
    hydratedUserId.current = user.id;
    reset({
      first_name: user.first_name ?? '',
      last_name: user.last_name ?? '',
      phone: formatPhone(user.phone ?? ''),
      phone_ext: user.phone_ext ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, reset]);

  // The same rule the API enforces, scoped to what was actually TYPED. Gating on
  // the stored value instead would lock a user out of their own name whenever
  // their number predates normalization, which is the admin-dialog defect in a
  // different chair.
  const phoneRejected =
    Boolean(formState.dirtyFields.phone) && !isUsableUserPhone(watch('phone'));

  const onSubmit = handleSubmit(async (values) => {
    // Refuse the write, but SAY so. Returning quietly here left the shell's save
    // bar to toast "Settings saved" over a save that never happened; a
    // ValidationError is the contract the shell already reads (SettingsLayout's
    // handleSave), the same one Branding uses for its invalid brand-color hex.
    if (phoneRejected) {
      const err = new Error(USER_PHONE_INVALID_MESSAGE);
      err.name = 'ValidationError';
      throw err;
    }
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
    // TWO signals, deliberately separate.
    //
    // `isDirty` is the TRUE dirty state and nothing else, because it is not just
    // the Save button: SettingsLayout pushes it into the settings guard store,
    // which arms the unsaved-changes confirm for the topbar user menu, the
    // sidebar, GlobalSearch, browser reload/tab-close and the settings sub-nav.
    // ANDing an unusable phone into it disarmed all of that, so a user with a
    // half-typed number could walk away and silently lose their name edit too.
    //
    // `canSave` is the other half: it greys the Save button while the number is
    // unusable, WITHOUT disarming any of the above. Without it the bar offered a
    // live Save that sent nothing and answered with an error toast.
    //
    // `save` still refuses (see onSubmit). The button being dead is the polite
    // half; the throw is the half that explains itself, and it is what a
    // keyboard submit or a future caller would hit.
    //
    // `phoneRejected` stays in the deps: `save` closes over it, so the shell must
    // be handed a fresh closure - and a fresh `canSave` - whenever it flips.
    registerSaver({
      save: onSubmit,
      discard: () => user && reset(),
      isDirty,
      canSave: !phoneRejected,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, phoneRejected]);

  return (
    <div className="space-y-6">
      <Section title="My Details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            <Input kind="given-name" {...register('first_name', { required: true })} />
          </Field>
          <Field label="Last name" required>
            <Input kind="family-name" {...register('last_name', { required: true })} />
          </Field>
          <Field label="Phone">
            <PhoneInput
              value={watch('phone') ?? ''}
              onValueChange={(v) => setValue('phone', v, { shouldDirty: true })}
            />
            {phoneRejected && (
              <p className="text-destructive text-xs">{USER_PHONE_INVALID_MESSAGE}</p>
            )}
          </Field>
          <Field label="Phone extension">
            <Input kind="phone-extension" {...register('phone_ext')} />
          </Field>
          <Field label="Email">
            <Input kind="email" value={user?.email ?? ''} disabled readOnly />
          </Field>
          <Field label="Role">
            <Input value={user?.role ?? ''} disabled readOnly />
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">
          Your role, team, and access are managed by an administrator.
        </p>
      </Section>

      {/* No kit counterpart: MyTimeLog owns a geofenced clock, its own queries and
          its own entry list. Reused whole and recorded in the ledger. */}
      <MyTimeLog />

      <Section>
        <SettingRow
          title="Password"
          control={
            // A real link (new tab, copy address), routed through the same
            // unsaved-changes guard as the settings sub-nav.
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link
                to={SECURITY_PATH}
                onClick={(e) => {
                  if (!guardDirty) return;
                  e.preventDefault();
                  requestLeave(() => navigate(SECURITY_PATH));
                }}
              >
                Change your password in Login &amp; Security
              </Link>
            </Button>
          }
        />
      </Section>
    </div>
  );
}
