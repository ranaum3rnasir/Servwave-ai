import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useOrganization, useUpdateOrganization, type OrgFormValues } from '@/lib/api/shared/organization';
import { formatPhone } from '@/lib/utils';

import { Input } from '@/ui-kit/components/ui/input';
import { PhoneInput } from '@/ui-kit/components/form/phoneInput';
import { Switch } from '@/ui-kit/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { TimeField } from '@/ui-kit/components/form/timeField';
import { TabStrip, TabPanel } from '../_shared/tabs';
import { useSettingsBar } from './settingsBar';
import { Section, FlushCard } from './components/section';
import { Field, SettingRow } from './components/field';

type FormValues = Partial<OrgFormValues>;

const DOC_ROWS = [
  { label: 'Customers', prefixKey: 'customer_prefix', nextKey: 'customer_next_number' },
  { label: 'Leads', prefixKey: 'lead_prefix', nextKey: 'lead_next_number' },
  { label: 'Estimates', prefixKey: 'estimate_prefix', nextKey: 'estimate_next_number' },
  { label: 'Jobs', prefixKey: 'job_prefix', nextKey: 'job_next_number' },
  { label: 'Invoices', prefixKey: 'invoice_prefix', nextKey: 'invoice_next_number' },
  { label: 'Service Plans', prefixKey: 'service_plan_prefix', nextKey: 'service_plan_next_number' },
] as const;

function dirtyValues(dirtyFields: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dirtyFields)) {
    if (dirtyFields[k]) out[k] = values[k];
  }
  return out;
}

/**
 * Settings > Company Profile.
 *
 * RHF with NO zod resolver, deliberately: validation on this screen is
 * server-side except for the forward-only numbering floor below, which throws a
 * `ValidationError` so the shell toasts it instead of falsely reporting
 * "Settings saved". Only dirty keys are PATCHed.
 *
 * `register` is kept (rather than a controlled value/onChange) because the e2e
 * spec fills `input[name="display_name"]` - the `name` attribute only exists
 * because RHF's register puts it there.
 */
export default function CompanyProfilePage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();
  const [activeTab, setActiveTab] = useState('profile');
  const form = useForm<FormValues>({ defaultValues: {} });
  const { register, reset, watch, setValue, handleSubmit, formState } = form;
  const isDirty = formState.isDirty;
  const ability = useAppAbility();
  const canEdit = ability.can('update', 'Organization');

  // The org id this form was last hydrated FROM. See MyProfilePage for the full
  // argument; the short version is that hydrating on the DATA OBJECT hands the
  // form back to the server mid-edit, and the `reset()` that does it also takes
  // `isDirty` to false, which SettingsLayout pushes into the settings guard
  // store - so the unsaved-changes prompt stops asking and the loss is silent.
  //
  // The trigger here is narrower than My Profile's, and measurably so.
  // `useOrganization` has no poll: it refetches on window focus, and TanStack's
  // default structural sharing returns the PREVIOUS object when the payload is
  // unchanged, so an ordinary refocus never re-runs this effect. What does is a
  // refocus that lands on a payload another admin has changed - any field, not
  // just one you are editing - and that wipes the form.
  //
  // BOTH conditions, mirroring MyProfilePage. The dirty check is the half that
  // stops the clobber. Keeping `org` as the dependency - rather than gating on
  // the id alone - is what lets a PRISTINE form go on tracking the server,
  // including the refetch that follows this page's own save. The id check is
  // what stops the dirty guard from wedging the form onto a stale company if
  // the org under the page ever changes identity.
  const hydratedOrgId = useRef<string | null>(null);

  useEffect(() => {
    const identityChanged = hydratedOrgId.current !== org?.id;
    if (!identityChanged && isDirty) return;
    if (org) {
      hydratedOrgId.current = org.id;
      reset({
        name: org.name ?? '',
        display_name: org.display_name ?? '',
        legal_name: org.legal_name ?? '',
        tax_id: org.tax_id ?? '',
        business_type: org.business_type ?? '',
        industry: org.industry ?? [],
        email: org.email ?? '',
        support_email: org.support_email ?? '',
        billing_email: org.billing_email ?? '',
        phone: formatPhone(org.phone ?? ''),
        phone_ext: org.phone_ext ?? '',
        website: org.website ?? '',
        timezone: org.timezone ?? '',
        currency: org.currency ?? 'USD',
        date_format: org.date_format ?? 'MM/DD/YYYY',
        country: org.country ?? 'US',
        address_line1: org.address_line1 ?? '',
        address_line2: org.address_line2 ?? '',
        city: org.city ?? '',
        state: org.state ?? '',
        postal_code: org.postal_code ?? '',
        mailing_same_as_hq: org.mailing_same_as_hq ?? true,
        mailing_address_line1: org.mailing_address_line1 ?? '',
        mailing_address_line2: org.mailing_address_line2 ?? '',
        mailing_city: org.mailing_city ?? '',
        mailing_state: org.mailing_state ?? '',
        mailing_postal_code: org.mailing_postal_code ?? '',
        mailing_country: org.mailing_country ?? 'US',
        email_sending_enabled: org.email_sending_enabled ?? true,
        sms_sending_enabled: org.sms_sending_enabled ?? true,
        customer_prefix: org.customer_prefix ?? 'C',
        customer_next_number: org.customer_next_number ?? 1,
        lead_prefix: org.lead_prefix ?? 'L',
        lead_next_number: org.lead_next_number ?? 1,
        estimate_prefix: org.estimate_prefix ?? 'E',
        estimate_next_number: org.estimate_next_number ?? 1,
        job_prefix: org.job_prefix ?? 'J',
        job_next_number: org.job_next_number ?? 1,
        invoice_prefix: org.invoice_prefix ?? 'I',
        invoice_next_number: org.invoice_next_number ?? 1,
        service_plan_prefix: org.service_plan_prefix ?? 'SP',
        service_plan_next_number: org.service_plan_next_number ?? 1,
        default_job_duration_min: org.default_job_duration_min ?? 120,
        default_walkthrough_duration_min: org.default_walkthrough_duration_min ?? 60,
        default_schedule_start_time: org.default_schedule_start_time ?? '08:00',
      });
    }
    // `isDirty` is read, not depended on: it is a getter on RHF's formState
    // Proxy, and listing it would re-arm this effect on every dirty flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reset]);

  // Forward-only floor per entity = the org's current "next number": you can skip ahead but
  // never go back into already-issued numbers (same rule as Workiz/QuickBooks/Xero). Mirrors the
  // backend collision guard, which rejects a next-number <= the highest number already issued.
  const nextFloor = (nextKey: string): number => {
    const raw = (org as unknown as Record<string, unknown> | undefined)?.[nextKey];
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
  };

  const onSubmit = handleSubmit(async (values) => {
    const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values as Record<string, unknown>);
    if (Object.keys(payload).length === 0) return;

    // Surface the floor as a clear message instead of round-tripping to a 400. Throw a
    // ValidationError so the settings save bar shows it and does NOT falsely toast "Settings saved".
    for (const row of DOC_ROWS) {
      if (!(row.nextKey in payload)) continue;
      const proposed = Number(payload[row.nextKey]);
      const floor = nextFloor(row.nextKey);
      if (Number.isFinite(proposed) && proposed < floor) {
        const err = new Error(
          `The next ${row.label} number cannot be lower than ${floor}. Existing documents keep their numbers.`,
        );
        err.name = 'ValidationError';
        throw err;
      }
    }

    await update.mutateAsync(payload as Partial<OrgFormValues>);
    reset(values);
  });

  useEffect(() => {
    registerSaver({ save: onSubmit, discard: () => org && reset(), isDirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const sameAsHq = watch('mailing_same_as_hq');
  const emailSendingEnabled = watch('email_sending_enabled');
  const smsSendingEnabled = watch('sms_sending_enabled');
  const industry = (watch('industry') as string[] | undefined) ?? [];
  const padding = org?.number_padding ?? 5;

  const numberPreview = (prefix: unknown, next: unknown) =>
    `${String(prefix ?? '')}${String(parseInt(String(next ?? '0'), 10) || 0).padStart(padding, '0')}`;

  return (
    <>
      <TabStrip
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'profile', label: 'Profile' },
          { value: 'numbering', label: 'Identifiers & Numbering' },
        ]}
      />

      {!canEdit && (
        <div className="border-border bg-muted text-muted-foreground mt-4 rounded-md border px-4 py-2 text-xs">
          Company details are managed by an administrator and are read-only for your account.
        </div>
      )}

      {/* A disabled fieldset, exactly as legacy: it locks every control inside in
          one place rather than threading a `disabled` prop through forty inputs. */}
      <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
        <TabPanel value="profile" activeValue={activeTab}>
          <div className="space-y-6 pt-4">
            <Section title="General & Legal">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Company Name" required><Input {...register('name')} /></Field>
                <Field label="Display / DBA Name"><Input {...register('display_name')} /></Field>
                <Field label="Legal Entity Name"><Input {...register('legal_name')} /></Field>
                <Field label="EIN / Tax ID"><Input {...register('tax_id')} /></Field>
                <Field label="Business Type">
                  <Input {...register('business_type')} placeholder="LLC, S-Corp, ..." />
                </Field>
                <Field label="Industry / Trades (comma-separated)">
                  <Input
                    value={industry.join(', ')}
                    onChange={(e) =>
                      setValue(
                        'industry',
                        e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        { shouldDirty: true },
                      )
                    }
                  />
                </Field>
              </div>
            </Section>

            <Section title="Contact">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* SRVW-54 - the extension sits IN the phone row, not in its own cell: it is
                    part of how the number is read, so it is drawn as part of the number. Same
                    shape as the customer quick-create (PickOrCreateCustomer.tsx). */}
                <Field label="Primary Phone" htmlFor="company-primary-phone">
                  <div className="flex flex-nowrap items-center gap-2">
                    <PhoneInput
                      id="company-primary-phone"
                      className="min-w-[10rem] flex-1"
                      value={watch('phone') ?? ''}
                      onValueChange={(v) => setValue('phone', v, { shouldDirty: true })}
                    />
                    <Input
                      kind="phone-extension"
                      className="w-16"
                      placeholder="Ext"
                      maxLength={10}
                      aria-label="Phone extension"
                      {...register('phone_ext')}
                    />
                  </div>
                </Field>
                <Field label="Primary Email"><Input kind="email" {...register('email')} /></Field>
                <Field label="Support Email"><Input kind="email" {...register('support_email')} /></Field>
                <Field label="Billing Email"><Input kind="email" {...register('billing_email')} /></Field>
                <Field label="Website"><Input type="url" placeholder="https://" {...register('website')} /></Field>
              </div>
            </Section>

            <Section title="Email Notifications">
              <SettingRow
                title="Send emails to customers and staff"
                hint="When turned off, no emails will be sent (invoices, estimates, job updates, etc.). Login and account-security emails are never affected."
                control={
                  <Switch
                    checked={emailSendingEnabled ?? true}
                    aria-label="Send emails to customers and staff"
                    onCheckedChange={(v) => setValue('email_sending_enabled', v, { shouldDirty: true })}
                  />
                }
              />
            </Section>

            <Section title="SMS Notifications">
              <SettingRow
                title="Send text messages to customers"
                hint="When turned off, no SMS will be sent - Automation Center texts and manual replies from the Communication module. Only applies to orgs with texting connected."
                control={
                  <Switch
                    checked={smsSendingEnabled ?? true}
                    aria-label="Send text messages to customers"
                    onCheckedChange={(v) => setValue('sms_sending_enabled', v, { shouldDirty: true })}
                  />
                }
              />
            </Section>

            <Section title="Localization & Defaults">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Time Zone"><Input placeholder="America/Chicago" {...register('timezone')} /></Field>
                <Field label="Currency"><Input maxLength={3} {...register('currency')} /></Field>
                <Field label="Date Format"><Input placeholder="MM/DD/YYYY" {...register('date_format')} /></Field>
                <Field label="Country"><Input maxLength={2} {...register('country')} /></Field>
              </div>

              <TimezoneComparison companyTz={watch('timezone') || null} />

              <div className="border-border border-t pt-4">
                <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wide">
                  Scheduling Defaults
                </p>
                <p className="text-muted-foreground mb-3 text-xs">
                  Used by the scheduler when a drop doesn&apos;t carry a time.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Default job duration (min)">
                    <Input
                      kind="count"
                      min={15}
                      max={1440}
                      step={15}
                      {...register('default_job_duration_min', { valueAsNumber: true })}
                    />
                  </Field>
                  <Field label="Default walkthrough duration (min)">
                    <Input
                      kind="count"
                      min={15}
                      max={1440}
                      step={15}
                      {...register('default_walkthrough_duration_min', { valueAsNumber: true })}
                    />
                  </Field>
                  <Field label="Default start time">
                    {/* The one field on this page NOT on register(): a picker is
                        a controlled value/onChange pair. Stored contract is
                        still 'HH:MM' - only the displayed text is 12-hour. */}
                    <TimeField
                      aria-label="Default start time"
                      value={watch('default_schedule_start_time') ?? ''}
                      onChange={(v) =>
                        setValue('default_schedule_start_time', v, { shouldDirty: true })
                      }
                    />
                  </Field>
                </div>
              </div>
            </Section>

            <Section title="Headquarters Address">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Street"><Input kind="street" {...register('address_line1')} /></Field>
                <Field label="Suite / Unit"><Input kind="address-line2" {...register('address_line2')} /></Field>
                <Field label="City"><Input kind="city" {...register('city')} /></Field>
                <Field label="State"><Input kind="state" {...register('state')} /></Field>
                <Field label="ZIP"><Input kind="postal-code" {...register('postal_code')} /></Field>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Switch
                  checked={!!sameAsHq}
                  aria-label="Mailing address same as headquarters"
                  onCheckedChange={(v) => setValue('mailing_same_as_hq', v, { shouldDirty: true })}
                />
                <span className="text-muted-foreground text-sm">
                  Mailing address same as headquarters
                </span>
              </div>

              {!sameAsHq && (
                <div className="border-border grid grid-cols-1 gap-4 rounded-md border p-4 sm:grid-cols-2">
                  <p className="text-muted-foreground col-span-full text-xs font-semibold uppercase tracking-wide">
                    Mailing Address
                  </p>
                  <Field label="Street"><Input kind="street" {...register('mailing_address_line1')} /></Field>
                  <Field label="Suite / Unit"><Input kind="address-line2" {...register('mailing_address_line2')} /></Field>
                  <Field label="City"><Input kind="city" {...register('mailing_city')} /></Field>
                  <Field label="State"><Input kind="state" {...register('mailing_state')} /></Field>
                  <Field label="ZIP"><Input kind="postal-code" {...register('mailing_postal_code')} /></Field>
                  <Field label="Country"><Input maxLength={2} {...register('mailing_country')} /></Field>
                </div>
              )}
            </Section>
          </div>
        </TabPanel>

        <TabPanel value="numbering" activeValue={activeTab}>
          <div className="pt-4">
            <Section
              title="Identifiers & Numbering"
              description={
                <>
                  The prefix and &ldquo;next number&rdquo; can both be changed at any time and apply to
                  documents issued from then on. The next number can&rsquo;t be set below a number
                  you&rsquo;ve already issued (that would create a duplicate); existing documents keep
                  their original numbers.
                </>
              }
            >
              <FlushCard>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead className="w-28">Prefix</TableHead>
                      <TableHead className="w-40">Next number</TableHead>
                      <TableHead>Preview</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {DOC_ROWS.map((row) => {
                      const floor = nextFloor(row.nextKey);
                      const current = Number(watch(row.nextKey as keyof FormValues));
                      const belowFloor = Number.isFinite(current) && current < floor;
                      return (
                        <TableRow key={row.label}>
                          <TableCell className="align-top">
                            <span className="flex h-10 items-center font-medium">{row.label}</span>
                          </TableCell>
                          <TableCell className="align-top">
                            <Input className="w-20" {...register(row.prefixKey as keyof FormValues)} />
                          </TableCell>
                          <TableCell className="align-top">
                            <Input
                              className="w-32"
                              kind="count"
                              min={floor}
                              {...register(row.nextKey as keyof FormValues, { valueAsNumber: true })}
                            />
                            <p
                              className={
                                belowFloor
                                  ? 'text-destructive mt-1 text-[11px]'
                                  : 'text-muted-foreground mt-1 text-[11px]'
                              }
                            >
                              {belowFloor ? `Cannot go below ${floor}` : `Minimum ${floor}`}
                            </p>
                          </TableCell>
                          <TableCell className="align-top">
                            <span className="text-muted-foreground flex h-10 items-center font-mono">
                              {numberPreview(
                                watch(row.prefixKey as keyof FormValues),
                                watch(row.nextKey as keyof FormValues),
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </FlushCard>
            </Section>
          </div>
        </TabPanel>
      </fieldset>
    </>
  );
}

function TimezoneComparison({ companyTz }: { companyTz: string | null }) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const timeIn = (tz: string): string | null => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(now);
    } catch {
      return null; // company tz is a free-text input; invalid IANA names make Intl throw RangeError
    }
  };
  const localTime = timeIn(localTz);
  const companyTime = companyTz ? timeIn(companyTz) : null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="border-border bg-muted rounded-md border p-3">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Your local time zone
        </p>
        <p className="text-sm">{localTz}</p>
        {localTime && <p className="text-muted-foreground text-xs">{localTime}</p>}
      </div>
      <div className="border-border bg-muted rounded-md border p-3">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Company time zone
        </p>
        <p className="text-sm">{companyTz || 'Not set'}</p>
        {companyTime && <p className="text-muted-foreground text-xs">{companyTime}</p>}
      </div>
    </div>
  );
}
