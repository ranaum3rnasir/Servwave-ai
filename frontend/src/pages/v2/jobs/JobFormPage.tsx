import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useOrganization } from '@/lib/api/shared/organization';
import { useAssignableUsers } from '@/lib/api/users';
import { useJobCreatorPrefill } from '@/lib/api/jobs';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAbility } from '@/lib/ability';
import { extractApiError } from '@/lib/utils';
import { phoneFieldValue } from '@/ui-kit/lib/phoneField';
import { phoneParamDigits } from '@/lib/phonePrefill';
import { useFormFlow } from '@/ui-kit/lib/formFlow';
import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { buildCreateJobPayload } from '@/lib/job-create-payload';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { createJobFormSchema, type CreateJobFormData as CreateFormData } from '@/lib/job-create-schema';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import {
  PickOrCreateCustomer,
  type PickCustomer,
  getDuplicateCustomer as getDuplicate,
  computeMatchedCustomerFields as computeMatchedFields,
} from '@/components/crm/PickOrCreateCustomer';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Switch } from '@/ui-kit/components/ui/switch';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { BackLink } from '../_shared/backLink';
import { ScheduleTimeFields } from '../_shared/scheduleTimeFields';
import { PersonSlotField } from '../_shared/personSlotField';
import { ScheduleClashNotice } from '../_shared/scheduleClashNotice';
import type { ScheduleConflictItem } from '../_shared/scheduleConflict';
import { v2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { useNoOptionsLabel } from '@/lib/useIsAdmin';

type ServiceLocation = {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
};

function formatLocationLabel(loc: ServiceLocation): string {
  const line = [loc.address_line1, loc.address_line2].filter(Boolean).join(', ');
  return `${line} - ${loc.city}, ${loc.state} ${loc.zip}`;
}

/**
 * Label + control + error, the shape `pages/v2/customers/CustomerFormPage.tsx`
 * settled on.
 *
 * NOT the kit's `form/formField.tsx`: that one is a `Controller` wrapper that
 * requires a `FormProvider` and a `render` prop per field, and this form is
 * built on `register`/`watch` with three of its controls (AddressAutocomplete,
 * PickOrCreateCustomer, Select) supplying their own DOM. Rewriting the form onto
 * the Controller API would be a logic change, not a restyle. The a11y contract
 * that matters - label association by id, the error text beneath the control -
 * is reproduced by hand.
 */
function Field({
  label, htmlFor, required, error, children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive ms-0.5" aria-hidden>*</span>}
      </Label>
      {children}
      {error && <p data-error-for={htmlFor} className="text-destructive text-[12px] font-medium">{error}</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    // role/aria-level rather than an h2: the raw-tag ratchet counts heading
    // elements outside the primitives and sits at its floor.
    <p role="heading" aria-level={2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {children}
    </p>
  );
}

/**
 * /v2/jobs/new - create only. There is no edit route for jobs.
 *
 * The guard stays exactly where App.tsx leaves it: a page-level redirect on
 * `create Job`, evaluated BEFORE any hook in the outer component, with the form
 * itself in a child so the hook order stays legal. `create Job` is a per-user
 * grantable capability, so a technician who holds the grant reaches this page
 * and a bare technician is bounced.
 */
export default function JobFormPage() {
  useRecordVisit('jobs', 'New Job');
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();

  if (!ability.can('create', 'Job')) {
    return <Navigate to={v2Path('/jobs')} replace />;
  }

  // Read ONCE on render, exactly as the legacy page does - not reactive to a
  // later URL change.
  const searchParams = new URLSearchParams(location.search);
  const customerIdParam = searchParams.get('customer_id');
  // Create-prefill from the Texts inbox and the dialer: /jobs/new?phone=+1XXXXXXXXXX seeds the phone field.
  const phoneParam = searchParams.get('phone');
  return (
    <CreateJobForm
      queryClient={queryClient}
      ability={ability}
      preselectedCustomerId={customerIdParam}
      prefillPhone={phoneParam}
    />
  );
}

function CreateJobForm({
  queryClient,
  ability,
  preselectedCustomerId,
  prefillPhone,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  ability: AppAbility;
  preselectedCustomerId?: string | null;
  prefillPhone?: string | null;
}) {
  const noOptions = useNoOptionsLabel();
  const { data: org } = useOrganization();
  // The schedule fields are zoneless wall-clock in the ORG's zone, not the
  // browser's, so the payload builder needs the zone to resolve them - without
  // it a Manila-booked 9am job stores as 9pm New York. Same call, same place as
  // the legacy form.
  const timezone = useScheduleTimezone();
  // Only a person with Assign people to jobs gets pickers (S03.16); anyone else sees the creator rule's result as
  // fixed text and the server applies it, so neither roster is asked for.
  const mayNamePeople = ability.can('assign', 'Job');
  const sellerRoster = useAssignableUsers({ purpose: 'directory', eligibleFor: 'owner', enabled: mayNamePeople });
  const dispatcherRoster = useAssignableUsers({ purpose: 'directory', eligibleFor: 'dispatcher', enabled: mayNamePeople });
  const assignableSellers = sellerRoster.data ?? [];
  const assignableDispatchers = dispatcherRoster.data ?? [];
  // The creator rule's pre-fill (Sold By or Dispatcher, never both): the form shows it, the create route applies it.
  const { data: prefill, isPending: prefillPending, isError: prefillFailed } = useJobCreatorPrefill();
  const me = useAuthStore((s) => s.user);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<PickCustomer | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  // "I'll do this visit" puts the creator, and only the creator, on visit 1 (S03.17). Checked to start with for a
  // person without Assign people to jobs, for whom this is the only scheduling they do; unchecked for a holder.
  const [doItMyself, setDoItMyself] = useState(!mayNamePeople);
  // A clash with the creator's other work: the server's verdict on the last try, and the form it refused, so
  // "Schedule anyway" can send the same job again with `visit_force`.
  const [clash, setClash] = useState<{ data: CreateFormData; when: string; conflicts: ScheduleConflictItem[] } | null>(null);
  // "Schedule anyway" stays chosen if the duplicate-customer guard sends the same job again afterwards.
  const forceVisit = useRef(false);
  const scheduleKey = (d: CreateFormData) => [d.scheduled_date, d.scheduled_time, d.scheduled_end_date, d.scheduled_end_time].join('|');

  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CreateFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({ email: false, phone: false });
  const [openingExisting, setOpeningExisting] = useState(false);

  // Mobile slice 38: Next/Done keys, and a failed submit lands on the first
  // error in page order (react-hook-form's own focus follows registration order
  // and cannot reach the controlled customer block).
  const flow = useFormFlow();
  const form = useForm<CreateFormData>({
    resolver: zodResolver(createJobFormSchema),
    shouldFocusError: false,
    defaultValues: {
      first_name: '', last_name: '', company_name: '',
      phone: prefillPhone ? phoneFieldValue(phoneParamDigits(prefillPhone)) : '',
      phone_ext: '', email: '',
      service_location_id: '',
      service_address_line1: '', service_address_line2: '', service_city: '', service_state: '', service_zip: '',
      service_request: '', job_type: '', ad_source: '',
      scheduled_date: '', scheduled_time: '', scheduled_end_date: '', scheduled_end_time: '',
    },
  });

  // What the two people fields hold: whatever the person picked, else the pre-fill. The fields stay unset until a
  // picker is used, so the pre-fill is not their work (an untouched form never asks before leaving).
  const soldById = form.watch('sold_by_id') ?? prefill?.sold_by_id ?? '';
  const dispatcherId = form.watch('dispatcher_id') ?? prefill?.dispatcher_id ?? '';

  // Leaving a half-filled form asks first (mobile slice 66). A customer chosen before the page
  // opened (`?customer_id=`) is not work; typing, or choosing a different customer here, is.
  const leave = useLeaveGuard(
    form.formState.isDirty
      || (selectedCustomerId !== null && selectedCustomerId !== (preselectedCustomerId ?? null)),
  );

  const serviceLocationId = form.watch('service_location_id');
  const addingNewLocation = serviceLocationId === '__add_new__';

  const { data: preselectedCustomer } = useQuery({
    queryKey: ['customer-prefill', preselectedCustomerId],
    queryFn: async () => {
      // #2041 slice 1 - the org-wide picker's expand endpoint (Ran's carve-out).
      const { data } = await api.get(`/api/customers/picker/${preselectedCustomerId}`);
      return data.customer as PickCustomer;
    },
    enabled: Boolean(preselectedCustomerId),
  });

  useEffect(() => {
    if (preselectedCustomer && !selectedCustomerId) {
      selectCustomer(preselectedCustomer);
    }
  }, [preselectedCustomer]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectCustomer = (c: PickCustomer) => {
    setSelectedCustomerId(c.id);
    setSelectedCustomer(c);
    form.setValue('first_name', c.first_name || '');
    form.setValue('last_name', c.last_name || '');
    form.setValue('company_name', c.company_name || '');
    form.setValue('phone', phoneFieldValue(c.phone ?? ''));
    form.setValue('phone_ext', c.phone_ext || '');
    form.setValue('email', c.email || '');
    form.setValue('ad_source', c.ad_source || '');
    const loc = c.service_locations?.find((l) => l.is_primary) || c.service_locations?.[0];
    if (loc) {
      form.setValue('service_location_id', loc.id);
      form.setValue('service_address_line1', loc.address_line1);
      form.setValue('service_address_line2', loc.address_line2 || '');
      form.setValue('service_city', loc.city);
      form.setValue('service_state', loc.state);
      form.setValue('service_zip', loc.zip);
    } else {
      form.setValue('service_location_id', '__add_new__');
      form.setValue('service_address_line1', '');
      form.setValue('service_address_line2', '');
      form.setValue('service_city', '');
      form.setValue('service_state', '');
      form.setValue('service_zip', '');
    }
  };

  const mutation = useMutation({
    mutationFn: async ({ data, override }: { data: CreateFormData; override?: boolean }) => {
      // A holder saves what the pickers hold (kept, changed or cleared); anyone else sends no people and the
      // server applies the creator rule, so what the form showed is what is saved.
      const people = mayNamePeople ? { sold_by_id: soldById || null, dispatcher_id: dispatcherId || null } : undefined;
      // Visit 1's crew is the creator alone, offered only to a person who can be on a crew; the server refuses anyone else.
      const visitCrew = prefill?.can_be_on_crew && doItMyself && me?.id ? [me.id] : undefined;
      const body = buildCreateJobPayload(data, { selectedCustomerId, showSchedule, timezone, people, visitCrew, forceVisit: forceVisit.current });
      // "Create anyway" (override) bypasses BOTH the new-customer duplicate guard
      // and the existing-customer cross-customer accretion guard.
      const url = override ? '/api/jobs?override=true' : '/api/jobs';
      const { data: res } = await api.post(url, body);
      return res;
    },
    onSuccess: (res) => {
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      // A new job on the customer, and "Schedule this job now" books its Visit 1 in the same
      // request (job.controller create).
      if (res.job?.id) refreshAfterVisitWrite(queryClient, { jobId: res.job.id });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      // Route to the new job only if this user can read jobs at all and can open this one; a
      // create-only grantee would hit "Job not found", and a creator on Attached scope who handed the job to
      // others would hit the not-authorised screen, so both go to the list. The latter is told the job is saved.
      // Class-level check (no instance) avoids fail-closed on row-scoped reads.
      const canOpen = Boolean(res.job?.id) && ability.can('read', 'Job') && res.job_openable !== false;
      if (res.job?.id && ability.can('read', 'Job') && res.job_openable === false) {
        toast.success(`Job ${res.job.job_number} created. You are not on it, so it will not show in your list.`);
      }
      leave.finish(canOpen ? v2Path(`/jobs/${res.job.id}`) : v2Path('/jobs'));
    },
    onError: (err, { data }) => {
      const refused = (err as { response?: { status?: number; data?: { conflicts?: ScheduleConflictItem[] } } }).response;
      if (refused?.status === 409 && Array.isArray(refused.data?.conflicts)) setClash({ data, when: scheduleKey(data), conflicts: refused.data.conflicts });
      const dup = getDuplicate(err);
      if (dup) {
        setDupExisting(dup);
        setPendingData(data);
        setDupMatched(computeMatchedFields(data, dup));
      }
    },
  });

  const handleOpenExisting = async () => {
    if (!dupExisting || openingExisting) return;
    const target = dupExisting;
    const draftAdSource = (form.getValues('ad_source') || '').trim();
    const draftAddress = {
      service_location_id: form.getValues('service_location_id') || '',
      service_address_line1: form.getValues('service_address_line1') || '',
      service_address_line2: form.getValues('service_address_line2') || '',
      service_city: form.getValues('service_city') || '',
      service_state: form.getValues('service_state') || '',
      service_zip: form.getValues('service_zip') || '',
    };
    setOpeningExisting(true);
    try {
      // #2041 slice 1 - the org-wide picker's expand endpoint (Ran's carve-out).
      const { data } = await api.get(`/api/customers/picker/${target.id}`);
      selectCustomer(data.customer as PickCustomer);
    } catch {
      // #1996 — a redacted match carries no first_name/last_name/company_name/phone/email to
      // build a fallback from, and the requester cannot read the real record either; bail
      // without selecting a customer.
      if (isRedactedMatch(target)) return;
      const fallback: PickCustomer = {
        id: target.id,
        first_name: target.first_name || '',
        last_name: target.last_name || '',
        company_name: target.company_name,
        phone: target.phone || '',
        email: target.email,
        service_locations: [],
      };
      selectCustomer(fallback);
      form.setValue('service_location_id', draftAddress.service_location_id || '__add_new__');
      form.setValue('service_address_line1', draftAddress.service_address_line1);
      form.setValue('service_address_line2', draftAddress.service_address_line2);
      form.setValue('service_city', draftAddress.service_city);
      form.setValue('service_state', draftAddress.service_state);
      form.setValue('service_zip', draftAddress.service_zip);
    } finally {
      if (draftAdSource) form.setValue('ad_source', draftAdSource);
      setOpeningExisting(false);
      setDupExisting(null);
    }
  };

  // The belt-and-braces DOM focus is why PickOrCreateCustomer's phone and email
  // inputs carry literal ids.
  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // A clash describes the time and the people that produced it; changing either retires it.
  const resetClash = () => {
    forceVisit.current = false;
    setClash(null);
  };

  const handleCreateAnyway = () => {
    if (!pendingData) return;
    mutation.mutate({ data: pendingData, override: true });
  };

  const isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting;

  const errors = form.formState.errors;
  // ...and a clash with the creator's other work has its own block below.
  const inlineError = getDuplicate(mutation.error) || clash ? null : mutation.error;

  const jobTypeOptions = org?.job_type_options ?? [];
  const baseSourceOptions = org?.source_options ?? [];
  const currentSource = form.watch('ad_source');
  // The CURRENT value is prepended when the org list no longer contains it, so
  // an inherited legacy source is not silently dropped on save.
  const sourceOptions = currentSource && !baseSourceOptions.includes(currentSource)
    ? [currentSource, ...baseSourceOptions]
    : baseSourceOptions;

  return (
    <div>
      <PageHeader
        title="New Job"
        back={<BackLink onClick={leave.leaveBack} />}
      />

      {/* No Card around the form, matching every other v2 create page
          (`leads/LeadFormPage.tsx`, `invoices/StandaloneInvoiceFormPage.tsx`).
          The page canvas already frames this content, so a card here drew a
          second border a few pixels inside the first and the fields read as
          boxed-in. The form keeps the card's horizontal rhythm through px-1 and
          gets its separation from spacing instead. */}
      <form noValidate {...flow.formProps} onSubmit={form.handleSubmit((d) => { forceVisit.current = false; mutation.mutate({ data: d }); }, flow.focusFirstInvalid)}>
        <div className="px-1 pt-2">
          {/* items-start keeps the two columns independent: growth on the left
              never moves the right. */}
          <div className="grid grid-cols-1 items-start gap-x-10 gap-y-6 lg:grid-cols-2">
            {/* LEFT - who and where */}
            <div className="flex flex-col gap-3">
              <SectionLabel>Client Details</SectionLabel>

              {/* No kit equivalent: the five-field contact block with its own
                  typeahead over /api/customers and the inline duplicate
                  banner. Reused as-is (ledger row). */}
              <PickOrCreateCustomer
                fields={{
                  first_name: form.watch('first_name') || '',
                  last_name: form.watch('last_name') || '',
                  company_name: form.watch('company_name') || '',
                  phone: form.watch('phone') || '',
                  phone_ext: form.watch('phone_ext') || '',
                  email: form.watch('email') || '',
                }}
                onFieldChange={(field, val) => {
                  // The job form renders no Secondary Phone input (showSecondaryPhone is
                  // off), so that one alone has no RHF field. phone_ext does (SRVW-54).
                  if (field === 'secondary_phone') return;
                  form.setValue(field, val, { shouldDirty: true });
                  // Workiz-style accretion: editing phone/email keeps the link
                  // (it accretes on submit); only a name/company edit forks a
                  // new customer.
                  const isIdentityField =
                    field === 'first_name' || field === 'last_name' || field === 'company_name';
                  if (isIdentityField && selectedCustomerId) {
                    setSelectedCustomerId(null);
                    setSelectedCustomer(null);
                  }
                }}
                selectedCustomer={selectedCustomer}
                onSelectCustomer={selectCustomer}
                required
                showPhoneExt
                errors={{
                  first_name: errors.first_name?.message,
                  last_name: errors.last_name?.message,
                  phone: errors.phone?.message,
                  phone_ext: errors.phone_ext?.message,
                  email: errors.email?.message,
                }}
                duplicate={dupExisting}
                duplicateMatchedFields={dupMatched}
                onUseExisting={handleOpenExisting}
                onEditField={handleEditField}
                onCreateAnyway={handleCreateAnyway}
                onDismissDuplicate={() => setDupExisting(null)}
                isOverriding={isOverriding}
              />

              <div className="border-t pt-3">
                <SectionLabel>Service Location</SectionLabel>
              </div>

              {selectedCustomer && (
                <Field label="Location" htmlFor="service_location_id" required>
                  <SelectField
                    value={serviceLocationId || ''}
                    onValueChange={(val) => {
                      form.setValue('service_location_id', val, { shouldDirty: true });
                      if (val === '__add_new__') {
                        form.setValue('service_address_line1', '', { shouldValidate: true, shouldDirty: true });
                        form.setValue('service_address_line2', '', { shouldDirty: true });
                        form.setValue('service_city', '', { shouldValidate: true, shouldDirty: true });
                        form.setValue('service_state', '', { shouldValidate: true, shouldDirty: true });
                        form.setValue('service_zip', '', { shouldValidate: true, shouldDirty: true });
                      } else {
                        const loc = (selectedCustomer.service_locations ?? []).find((l) => l.id === val);
                        if (loc) {
                          form.setValue('service_address_line1', loc.address_line1, { shouldValidate: true });
                          form.setValue('service_address_line2', loc.address_line2 || '');
                          form.setValue('service_city', loc.city, { shouldValidate: true });
                          form.setValue('service_state', loc.state, { shouldValidate: true });
                          form.setValue('service_zip', loc.zip, { shouldValidate: true });
                        }
                      }
                    }}
                    id="service_location_id"
                    placeholder="Select a service location"
                    options={[
                      ...(selectedCustomer.service_locations ?? []).map((loc) => ({
                        value: loc.id, label: formatLocationLabel(loc),
                      })),
                      { value: '__add_new__', label: '+ Add new location' },
                    ]}
                  />
                </Field>
              )}

              {(!selectedCustomer || addingNewLocation) && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_80px]">
                    <Field label="Address" htmlFor="service_address_line1" required error={errors.service_address_line1?.message}>
                      {/* No kit equivalent: a places-provider typeahead that
                          writes four fields at once. Reused as-is. */}
                      <AddressAutocomplete
                        id="service_address_line1"
                        value={form.watch('service_address_line1') || ''}
                        onChange={(val) => form.setValue('service_address_line1', val, { shouldValidate: true, shouldDirty: true })}
                        onSelect={(place) => {
                          form.setValue('service_address_line1', place.address_line1, { shouldValidate: true, shouldDirty: true });
                          form.setValue('service_city', place.city, { shouldValidate: true, shouldDirty: true });
                          form.setValue('service_state', place.state, { shouldValidate: true, shouldDirty: true });
                          form.setValue('service_zip', place.zip, { shouldValidate: true, shouldDirty: true });
                        }}
                      />
                    </Field>
                    <Field label="Unit" htmlFor="service_address_line2">
                      <Input kind="address-line2" personalAutofill={false} id="service_address_line2" {...form.register('service_address_line2')} />
                    </Field>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="City" htmlFor="service_city" required error={errors.service_city?.message}>
                      <Input kind="city" personalAutofill={false} id="service_city" aria-invalid={!!errors.service_city} {...form.register('service_city')} />
                    </Field>
                    <Field label="State" htmlFor="service_state" required error={errors.service_state?.message}>
                      <Input kind="state" personalAutofill={false} id="service_state" maxLength={2} aria-invalid={!!errors.service_state} {...form.register('service_state')} />
                    </Field>
                    <Field label="ZIP" htmlFor="service_zip" required error={errors.service_zip?.message}>
                      <Input kind="postal-code" personalAutofill={false} id="service_zip" aria-invalid={!!errors.service_zip} {...form.register('service_zip')} />
                    </Field>
                  </div>
                </>
              )}

              <ServiceLocationMap
                addressLine1={form.watch('service_address_line1')}
                city={form.watch('service_city')}
                state={form.watch('service_state')}
                zip={form.watch('service_zip')}
              />
            </div>

            {/* RIGHT - what and when */}
            <div className="flex flex-col gap-3">
              <SectionLabel>Job Details</SectionLabel>

              <Field label="Service Request" htmlFor="service_request" required error={errors.service_request?.message}>
                <Textarea
                  id="service_request"
                  rows={3}
                  placeholder="Describe the work needed..."
                  aria-invalid={!!errors.service_request}
                  {...form.register('service_request')}
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Job Type" htmlFor="job_type">
                  <SelectField
                    value={form.watch('job_type') || ''}
                    onValueChange={(v) => form.setValue('job_type', v, { shouldDirty: true })}
                    id="job_type"
                    placeholder="Select..."
                    options={
                      jobTypeOptions.length > 0
                        ? jobTypeOptions.map((t) => ({ value: t, label: t }))
                        : [{ value: '__none__', label: noOptions, disabled: true }]
                    }
                  />
                </Field>
                <Field label="Source" htmlFor="ad_source">
                  <SelectField
                    value={form.watch('ad_source') || ''}
                    onValueChange={(v) => form.setValue('ad_source', v, { shouldDirty: true })}
                    id="ad_source"
                    placeholder="Select..."
                    options={
                      sourceOptions.length > 0
                        ? sourceOptions.map((s) => ({ value: s, label: s }))
                        : [{ value: '__none__', label: noOptions, disabled: true }]
                    }
                  />
                </Field>
              </div>

              {/* Sold By and Dispatcher hold the creator rule's pre-fill: pickers with Assign people to jobs, fixed text otherwise. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PersonSlotField
                  label="Sold By"
                  empty="No Sold By"
                  picker={mayNamePeople}
                  value={soldById}
                  ready={!prefillPending}
                  onChange={(v) => form.setValue('sold_by_id', v, { shouldDirty: true })}
                  roster={assignableSellers}
                  me={me}
                  loading={sellerRoster.isLoading}
                  failed={sellerRoster.isError && !sellerRoster.data}
                  onRetry={() => void sellerRoster.refetch()}
                />
                <PersonSlotField
                  label="Dispatcher"
                  empty="No dispatcher"
                  picker={mayNamePeople}
                  value={dispatcherId}
                  ready={!prefillPending}
                  onChange={(v) => form.setValue('dispatcher_id', v, { shouldDirty: true })}
                  roster={assignableDispatchers}
                  me={me}
                  loading={dispatcherRoster.isLoading}
                  failed={dispatcherRoster.isError && !dispatcherRoster.data}
                  onRetry={() => void dispatcherRoster.refetch()}
                />
              </div>

              <div className="flex items-center justify-between border-t pt-3">
                <SectionLabel>Schedule</SectionLabel>
                <Switch
                  checked={showSchedule}
                  onCheckedChange={setShowSchedule}
                  aria-label="Schedule this job now"
                />
              </div>

              {showSchedule && (
                <>
                  {/* The ONE scheduling field set - the same component the board
                      popover, the drop modal and the walkthrough tab render, so a job
                      is booked here exactly the way it is booked there. Driven from
                      watch/setValue rather than register(): these are controlled
                      value/onChange pickers, not native inputs RHF can ref. All four
                      form fields are read AND written, so nothing is derived from a
                      narrower value, and the state stays the same zoneless
                      'YYYY-MM-DD' / 'HH:MM' pairs - `buildCreateJobPayload` is
                      untouched. */}
                  <ScheduleTimeFields
                    idPrefix="job"
                    value={{
                      date: form.watch('scheduled_date') || '',
                      startTime: form.watch('scheduled_time') || '',
                      endDate: form.watch('scheduled_end_date') || '',
                      endTime: form.watch('scheduled_end_time') || '',
                    }}
                    onChange={(next) => {
                      form.setValue('scheduled_date', next.date, { shouldDirty: true });
                      form.setValue('scheduled_time', next.startTime, { shouldDirty: true });
                      form.setValue('scheduled_end_date', next.endDate, { shouldDirty: true });
                      form.setValue('scheduled_end_time', next.endTime, { shouldDirty: true });
                      resetClash();
                    }}
                  />
                  {/* Visit 1 can carry the creator and nobody else: the crew is changed afterwards with the normal flow. */}
                  {prefill?.can_be_on_crew && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="v2-job-do-it-myself"
                        checked={doItMyself}
                        onCheckedChange={(v) => { setDoItMyself(v === true); resetClash(); }}
                      />
                      <Label htmlFor="v2-job-do-it-myself" className="cursor-pointer">I'll do this visit</Label>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {clash && clash.when === scheduleKey(form.getValues()) && (
            <div className="mt-4">
              <ScheduleClashNotice
                conflicts={clash.conflicts}
                timezone={timezone}
                message="You are already booked over this slot."
                pending={mutation.isPending}
                onScheduleAnyway={() => { forceVisit.current = true; mutation.mutate({ data: clash.data }); }}
              />
            </div>
          )}

          {inlineError && (
            <p className="text-destructive mt-4 text-sm">
              {extractApiError(inlineError, 'Something went wrong')}
            </p>
          )}

          {/* Without the pre-fill the form cannot say who the job will hold, so it does not save blind. */}
          {prefillFailed && (
            <p className="text-destructive mt-4 text-sm">Couldn't load Sold By and Dispatcher. Reload the page to try again.</p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t pt-4">
            <Button type="button" variant="ghost" onClick={leave.leaveBack}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending || prefillFailed || prefillPending}>
              {mutation.isPending ? 'Creating...' : 'Create Job'}
            </Button>
          </div>
        </div>
      </form>
      {leave.leaveDialog}
    </div>
  );
}
