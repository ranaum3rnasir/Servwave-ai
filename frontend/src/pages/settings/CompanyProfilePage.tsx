import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useOrganization, useUpdateOrganization, type OrgFormValues } from '@/lib/api/organization';
import { formatPhone, formatPhoneInput } from '@/lib/utils';
import { useSettingsBar } from './SettingsLayout';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';
import { TimeCombobox } from '@/components/form/TimeCombobox';
import { SelectField } from '@/components/form/SelectField';

type FormValues = Partial<OrgFormValues>;

const DOC_ROWS = [
  { label: 'Customers', prefixKey: 'customer_prefix', nextKey: 'customer_next_number' },
  { label: 'Leads', prefixKey: 'lead_prefix', nextKey: 'lead_next_number' },
  { label: 'Estimates', prefixKey: 'estimate_prefix', nextKey: 'estimate_next_number' },
  { label: 'Jobs', prefixKey: 'job_prefix', nextKey: 'job_next_number' },
  { label: 'Invoices', prefixKey: 'invoice_prefix', nextKey: 'invoice_next_number' },
  { label: 'Service Plans', prefixKey: 'service_plan_prefix', nextKey: 'service_plan_next_number' },
] as const;

/**
 * The zones ServWave's customers actually operate in. US SMB contractors, so this is the
 * standard US set rather than the ~400-entry IANA list, which is unusable in a dropdown.
 *
 * A picker rather than a text box because this value is load-bearing now: every scheduled
 * time in the product is resolved and rendered against it, and a typo like "Eastern" makes
 * Intl throw. The server rejects non-IANA values too - the two guards are independent.
 */
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time - America/New_York' },
  { value: 'America/Chicago', label: 'Central Time - America/Chicago' },
  { value: 'America/Denver', label: 'Mountain Time - America/Denver' },
  { value: 'America/Phoenix', label: 'Mountain Time, no DST - America/Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific Time - America/Los_Angeles' },
  { value: 'America/Anchorage', label: 'Alaska Time - America/Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time - Pacific/Honolulu' },
];

function dirtyValues(dirtyFields: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dirtyFields)) {
    if (dirtyFields[k]) out[k] = values[k];
  }
  return out;
}

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

  useEffect(() => {
    if (org) {
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

  const timezoneValue = watch('timezone');
  const sameAsHq = watch('mailing_same_as_hq');
  const emailSendingEnabled = watch('email_sending_enabled');
  const smsSendingEnabled = watch('sms_sending_enabled');
  const industry = (watch('industry') as string[] | undefined) ?? [];
  const padding = org?.number_padding ?? 5;

  const numberPreview = (prefix: unknown, next: unknown) =>
    `${String(prefix ?? '')}${String(parseInt(String(next ?? '0'), 10) || 0).padStart(padding, '0')}`;

  return (
    <TabStrip
      active={activeTab}
      onChange={setActiveTab}
      tabs={[
        { value: 'profile', label: 'Profile' },
        { value: 'numbering', label: 'Identifiers & Numbering' },
      ]}
    >
      {!canEdit && (
        <div className="mt-4 rounded-lg border border-border bg-background-light px-4 py-2 text-xs text-text-secondary">
          Company details are managed by an administrator and are read-only for your account.
        </div>
      )}

      <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <TabsContent value="profile" className="space-y-6 pt-4">
        <Card className="space-y-4">
          <Heading level={3}>General &amp; Legal</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Company Name" required><Input {...register('name')} /></Field>
            <Field label="Display / DBA Name"><Input {...register('display_name')} /></Field>
            <Field label="Legal Entity Name"><Input {...register('legal_name')} /></Field>
            <Field label="EIN / Tax ID"><Input {...register('tax_id')} /></Field>
            <Field label="Business Type"><Input {...register('business_type')} placeholder="LLC, S-Corp, …" /></Field>
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
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>Contact</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Primary Phone">
              <Input
                type="tel"
                value={watch('phone') ?? ''}
                onChange={(e) => setValue('phone', formatPhoneInput(e.target.value), { shouldDirty: true })}
              />
            </Field>
            <Field label="Primary Email"><Input type="email" {...register('email')} /></Field>
            <Field label="Support Email"><Input type="email" {...register('support_email')} /></Field>
            <Field label="Billing Email"><Input type="email" {...register('billing_email')} /></Field>
            <Field label="Website"><Input type="url" placeholder="https://" {...register('website')} /></Field>
          </div>
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>Email Notifications</Heading>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-primary">Send emails to customers and staff</span>
              <p className="text-xs text-text-secondary">
                When turned off, no emails will be sent (invoices, estimates, job updates, etc.). Login and
                account-security emails are never affected.
              </p>
            </div>
            <Switch
              checked={emailSendingEnabled ?? true}
              onCheckedChange={(v) => setValue('email_sending_enabled', v, { shouldDirty: true })}
            />
          </div>
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>SMS Notifications</Heading>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-primary">Send text messages to customers</span>
              <p className="text-xs text-text-secondary">
                When turned off, no SMS will be sent - Automation Center texts and manual replies from the
                Communication module. Only applies to orgs with texting connected.
              </p>
            </div>
            <Switch
              checked={smsSendingEnabled ?? true}
              onCheckedChange={(v) => setValue('sms_sending_enabled', v, { shouldDirty: true })}
            />
          </div>
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>Localization &amp; Defaults</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Time Zone">
              <SelectField
                aria-label="Time Zone"
                value={watch('timezone') || ''}
                onValueChange={(v) => setValue('timezone', v, { shouldDirty: true })}
                placeholder="Select a time zone"
                // Carry a stored value that predates this list rather than silently dropping
                // it: the picker must never blank out a zone the org is actually running on.
                options={
                  timezoneValue && !TIMEZONE_OPTIONS.some((o) => o.value === timezoneValue)
                    ? [...TIMEZONE_OPTIONS, { value: timezoneValue, label: timezoneValue }]
                    : TIMEZONE_OPTIONS
                }
              />
            </Field>
            <Field label="Currency"><Input maxLength={3} {...register('currency')} /></Field>
            <Field label="Date Format"><Input placeholder="MM/DD/YYYY" {...register('date_format')} /></Field>
            <Field label="Country"><Input maxLength={2} {...register('country')} /></Field>
          </div>

          <CompanyClock companyTz={timezoneValue || null} />

          <div className="border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Scheduling Defaults
            </p>
            <p className="mb-3 text-xs text-text-secondary">
              Used by the scheduler when a drop doesn&apos;t carry a time.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Default job duration (min)">
                <Input
                  type="number"
                  min={15}
                  max={1440}
                  step={15}
                  {...register('default_job_duration_min', { valueAsNumber: true })}
                />
              </Field>
              <Field label="Default walkthrough duration (min)">
                <Input
                  type="number"
                  min={15}
                  max={1440}
                  step={15}
                  {...register('default_walkthrough_duration_min', { valueAsNumber: true })}
                />
              </Field>
              <Field label="Default start time">
                <TimeCombobox
                  aria-label="Default start time"
                  value={watch('default_schedule_start_time') || ''}
                  onChange={(v) =>
                    setValue('default_schedule_start_time', v, { shouldDirty: true })
                  }
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>Headquarters Address</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Street"><Input {...register('address_line1')} /></Field>
            <Field label="Suite / Unit"><Input {...register('address_line2')} /></Field>
            <Field label="City"><Input {...register('city')} /></Field>
            <Field label="State"><Input {...register('state')} /></Field>
            <Field label="ZIP"><Input {...register('postal_code')} /></Field>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Switch
              checked={!!sameAsHq}
              onCheckedChange={(v) => setValue('mailing_same_as_hq', v, { shouldDirty: true })}
            />
            <span className="text-sm text-text-secondary">Mailing address same as headquarters</span>
          </div>

          {!sameAsHq && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border border-border p-4">
              <p className="col-span-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Mailing Address
              </p>
              <Field label="Street"><Input {...register('mailing_address_line1')} /></Field>
              <Field label="Suite / Unit"><Input {...register('mailing_address_line2')} /></Field>
              <Field label="City"><Input {...register('mailing_city')} /></Field>
              <Field label="State"><Input {...register('mailing_state')} /></Field>
              <Field label="ZIP"><Input {...register('mailing_postal_code')} /></Field>
              <Field label="Country"><Input maxLength={2} {...register('mailing_country')} /></Field>
            </div>
          )}
        </Card>
      </TabsContent>

      <TabsContent value="numbering" className="pt-4">
        <Card>
          <Heading level={3} className="mb-1">Identifiers &amp; Numbering</Heading>
          <p className="mb-4 text-xs text-text-secondary">
            The prefix and “next number” can both be changed at any time and apply to documents issued from then on.
            The next number can’t be set below a number you’ve already issued (that would create a duplicate); existing
            documents keep their original numbers.
          </p>
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
                    <TableCell weight="medium">{row.label}</TableCell>
                    <TableCell>
                      <Input className="w-20" {...register(row.prefixKey as keyof FormValues)} />
                    </TableCell>
                    <TableCell>
                      <Input
                        className="w-32"
                        type="number"
                        min={floor}
                        {...register(row.nextKey as keyof FormValues, { valueAsNumber: true })}
                      />
                      <p className={`mt-1 text-[11px] ${belowFloor ? 'text-danger' : 'text-text-secondary'}`}>
                        {belowFloor ? `Cannot go below ${floor}` : `Minimum ${floor}`}
                      </p>
                    </TableCell>
                    <TableCell tone="muted" className="font-mono">
                      {numberPreview(watch(row.prefixKey as keyof FormValues), watch(row.nextKey as keyof FormValues))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </TabsContent>
      </fieldset>
    </TabStrip>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
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

/**
 * The company clock, and only the company clock.
 *
 * This used to sit beside a "Your local time zone" panel, which implied the two were both in
 * play. They are not: there is one company time zone and every scheduled time in the product
 * is stored and shown against it, so the viewer's own zone is not a fact worth surfacing here.
 */
function CompanyClock({ companyTz }: { companyTz: string | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  let companyTime: string | null = null;
  if (companyTz) {
    try {
      companyTime = new Intl.DateTimeFormat(undefined, {
        timeZone: companyTz,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(now);
    } catch {
      // A zone stored before the picker existed can still be unparseable; show the raw name
      // rather than crashing the settings page.
      companyTime = null;
    }
  }
  return (
    <div className="rounded-lg border border-border bg-background-light p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Company time zone</p>
      <p className="text-sm text-text-primary">{companyTz || 'Not set'}</p>
      {companyTime && <p className="text-xs text-text-secondary">It is currently {companyTime}</p>}
      <p className="mt-1 text-xs text-text-secondary">
        Every scheduled time in ServWave is shown on this clock, for everyone, wherever they are.
      </p>
    </div>
  );
}
