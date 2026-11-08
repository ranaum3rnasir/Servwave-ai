import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAbility } from '@/lib/ability';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/patterns/FormField';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { Switch } from '@/components/ui/switch';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import {
  PickOrCreateCustomer,
  type PickCustomer,
  getDuplicateCustomer as getDuplicate,
  computeMatchedCustomerFields as computeMatchedFields,
} from '@/components/crm/PickOrCreateCustomer';
import { ArrowLeft } from 'lucide-react';
import { formatPhoneInput, extractApiError } from '@/lib/utils';
import { buildCreateJobPayload } from '@/lib/job-create-payload';
import { createJobFormSchema, type CreateJobFormData as CreateFormData } from '@/lib/job-create-schema';
import { ScheduleTimeFields } from '@/components/schedule/ScheduleTimeFields';
import { useScheduleTimezone } from '@/lib/schedule-tz';

// ─── Types ───────────────────────────────────────────

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
  return `${line} — ${loc.city}, ${loc.state} ${loc.zip}`;
}

// ─── Page (create-only) ──────────────────────────────

export default function JobFormPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();

  if (!ability.can('create', 'Job')) {
    return <Navigate to="/jobs" replace />;
  }

  const customerIdParam = new URLSearchParams(location.search).get('customer_id');
  return <CreateJobForm navigate={navigate} queryClient={queryClient} ability={ability} preselectedCustomerId={customerIdParam} />;
}

// ─── Create Job Form ─────────────────────────────────

function CreateJobForm({
  navigate,
  queryClient,
  ability,
  preselectedCustomerId,
}: {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
  ability: AppAbility;
  preselectedCustomerId?: string | null;
}) {
  const { data: org } = useOrganization();
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<PickCustomer | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  // Schedule fields are zoneless wall clock; they mean the ORG's clock, never the browser's.
  const timezone = useScheduleTimezone();

  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CreateFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({ email: false, phone: false });
  const [openingExisting, setOpeningExisting] = useState(false);

  const form = useForm<CreateFormData>({
    resolver: zodResolver(createJobFormSchema),
    defaultValues: {
      first_name: '', last_name: '', company_name: '', phone: '', email: '',
      service_location_id: '',
      service_address_line1: '', service_address_line2: '', service_city: '', service_state: '', service_zip: '',
      service_request: '', job_type: '', ad_source: '',
      scheduled_date: '', scheduled_time: '', scheduled_end_date: '', scheduled_end_time: '',
    },
  });

  const serviceLocationId = form.watch('service_location_id');
  const addingNewLocation = serviceLocationId === '__add_new__';

  const { data: preselectedCustomer } = useQuery({
    queryKey: ['customer-prefill', preselectedCustomerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${preselectedCustomerId}`);
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
    form.setValue('phone', formatPhoneInput(c.phone ?? ''));
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
      const body = buildCreateJobPayload(data, { selectedCustomerId, showSchedule, timezone });
      // "Create anyway" (override) bypasses BOTH the new-customer duplicate guard and the
      // existing-customer cross-customer accretion guard (#800 follow-up).
      const url = override ? '/api/jobs?override=true' : '/api/jobs';
      const { data: res } = await api.post(url, body);
      return res;
    },
    onSuccess: (res) => {
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      // Route to the new job only if this user can read jobs at all; a create-only
      // role (no read grant) would hit "Job not found", so send them to the list.
      // Class-level check (no instance) avoids fail-closed on row-scoped read conditions.
      navigate(res.job?.id && ability.can('read', 'Job') ? `/jobs/${res.job.id}` : '/jobs');
    },
    onError: (err, { data }) => {
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
      const { data } = await api.get(`/api/customers/${target.id}`);
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

  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  const handleCreateAnyway = () => {
    if (!pendingData) return;
    mutation.mutate({ data: pendingData, override: true });
  };

  const isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting;

  const errors = form.formState.errors;
  const inlineError = getDuplicate(mutation.error) ? null : mutation.error;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" tone="subtle" size="sm" className="-ml-1" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <Heading>New Job</Heading>
      </div>

      <div className="rounded-xl bg-surface-light shadow-card border border-border p-6">
        <form onSubmit={form.handleSubmit((d) => mutation.mutate({ data: d }))} className="space-y-5">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Left: Who + Where */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Client Details</p>

              <PickOrCreateCustomer
                fields={{
                  first_name: form.watch('first_name') || '',
                  last_name: form.watch('last_name') || '',
                  company_name: form.watch('company_name') || '',
                  phone: form.watch('phone') || '',
                  email: form.watch('email') || '',
                }}
                onFieldChange={(field, val) => {
                  // The job form renders neither input (showSecondaryPhone/showPhoneExt
                  // are both off), so neither has a matching RHF field.
                  if (field === 'secondary_phone' || field === 'phone_ext') return;
                  form.setValue(field, val);
                  // Workiz-style accretion (spec §4): editing phone/email keeps the link (it
                  // will accrete on submit); only a name/company edit forks a new customer.
                  const isIdentityField = field === 'first_name' || field === 'last_name' || field === 'company_name';
                  if (isIdentityField && selectedCustomerId) {
                    setSelectedCustomerId(null);
                    setSelectedCustomer(null);
                  }
                }}
                selectedCustomer={selectedCustomer}
                onSelectCustomer={selectCustomer}
                required
                errors={{
                  first_name: errors.first_name?.message,
                  last_name: errors.last_name?.message,
                  phone: errors.phone?.message,
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

              <div className="border-t border-border pt-3">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Service Location</p>
              </div>

              {selectedCustomer && (
                <FormField label="Location *">
                  {(fieldProps) => (
                    <Select
                      value={serviceLocationId || ''}
                      onValueChange={(val) => {
                        form.setValue('service_location_id', val);
                        if (val === '__add_new__') {
                          form.setValue('service_address_line1', '', { shouldValidate: true });
                          form.setValue('service_address_line2', '');
                          form.setValue('service_city', '', { shouldValidate: true });
                          form.setValue('service_state', '', { shouldValidate: true });
                          form.setValue('service_zip', '', { shouldValidate: true });
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
                    >
                      <SelectTrigger {...fieldProps}><SelectValue placeholder="Select a service location" /></SelectTrigger>
                      <SelectContent>
                        {(selectedCustomer.service_locations ?? []).map((loc) => (
                          <SelectItem key={loc.id} value={loc.id}>{formatLocationLabel(loc)}</SelectItem>
                        ))}
                        <SelectItem value="__add_new__">+ Add new location</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}

              {(!selectedCustomer || addingNewLocation) && (
                <>
                  <div className="grid grid-cols-[1fr_80px] gap-3">
                    <FormField label="Address *" error={errors.service_address_line1?.message}>
                      {({ id }) => (
                        <AddressAutocomplete
                          id={id}
                          value={form.watch('service_address_line1') || ''}
                          onChange={(val) => form.setValue('service_address_line1', val, { shouldValidate: true })}
                          onSelect={(place) => {
                            form.setValue('service_address_line1', place.address_line1, { shouldValidate: true });
                            form.setValue('service_city', place.city, { shouldValidate: true });
                            form.setValue('service_state', place.state, { shouldValidate: true });
                            form.setValue('service_zip', place.zip, { shouldValidate: true });
                          }}
                        />
                      )}
                    </FormField>
                    <FormField label="Unit">
                      <Input {...form.register('service_address_line2')} />
                    </FormField>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <FormField label="City *" error={errors.service_city?.message}>
                      <Input {...form.register('service_city')} />
                    </FormField>
                    <FormField label="State *" error={errors.service_state?.message}>
                      <Input maxLength={2} {...form.register('service_state')} />
                    </FormField>
                    <FormField label="ZIP *" error={errors.service_zip?.message}>
                      <Input {...form.register('service_zip')} />
                    </FormField>
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

            {/* Right: What + When */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Job Details</p>

              <FormField label="Service Request *" error={errors.service_request?.message}>
                <Textarea {...form.register('service_request')} rows={3} placeholder="Describe the work needed..." />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Job Type">
                  {(fieldProps) => (
                    <Select value={form.watch('job_type') || ''} onValueChange={(v) => form.setValue('job_type', v)}>
                      <SelectTrigger {...fieldProps}><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {(org?.job_type_options ?? []).length > 0
                          ? (org?.job_type_options ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)
                          : <SelectItem value="__none__" disabled>No options — add in Settings</SelectItem>}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label="Source">
                  {(fieldProps) => (
                    <Select value={form.watch('ad_source') || ''} onValueChange={(v) => form.setValue('ad_source', v)}>
                      <SelectTrigger {...fieldProps}><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {(() => {
                          const baseOptions = org?.source_options ?? [];
                          const current = form.watch('ad_source');
                          const options = current && !baseOptions.includes(current) ? [current, ...baseOptions] : baseOptions;
                          return options.length > 0
                            ? options.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)
                            : <SelectItem value="__none__" disabled>No options — add in Settings</SelectItem>;
                        })()}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              </div>

              <div className="border-t border-border pt-3 flex items-center justify-between">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Schedule</p>
                <Switch checked={showSchedule} onCheckedChange={setShowSchedule} />
              </div>

              {showSchedule && (
                /* Same fields, same wording as the scheduler board and the job dialog -
                   the four form values are just where this page stores them. */
                <ScheduleTimeFields
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
                  }}
                />
              )}
            </div>
          </div>

          {inlineError && (
            <p className="text-sm text-danger">{extractApiError(inlineError, 'Something went wrong')}</p>
          )}

          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
            <Button variant="solid" tone="business" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating...' : 'Create Job'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
