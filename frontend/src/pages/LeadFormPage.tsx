import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useOrganization, useUpdateOrganization } from '@/lib/api/organization';
import { useAssignableUsers } from '@/lib/api/users';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAbility } from '@/lib/ability';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/patterns/FormField';
import { Switch } from '@/components/ui/switch';
import { TaxWarningDialog } from '@/components/leads/TaxWarningDialog';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import {
  PickOrCreateCustomer,
  type PickCustomer,
  getDuplicateCustomer as getDuplicate,
  computeMatchedCustomerFields as computeMatchedFields,
} from '@/components/crm/PickOrCreateCustomer';
import {
  PickOrAccreteLocation,
  type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { TimeSelect } from '@/components/form/TimeSelect';
import { ArrowLeft, Lock } from 'lucide-react';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import {
  createLeadFormSchema,
  editLeadFormSchema,
  type CreateLeadFormData as CreateFormData,
  type EditLeadFormData as EditFormData,
} from '@/lib/lead-form-schemas';
import { DatePicker } from '@/components/form/DatePicker';
import { useScheduleTimezone, dayAndTimeToIso, isoToOrgDay, isoToOrgTime } from '@/lib/schedule-tz';

// ─── Types ───────────────────────────────────────────

// Customer + service-location shapes are shared with the extracted controls.
type SearchCustomer = PickCustomer;
type ServiceLocation = ServiceLocationOption;

// ─── Helpers ─────────────────────────────────────────


/** ?phone= arrives E.164 (+1XXXXXXXXXX) from the dialer's create-prefill —
 *  strip a leading US country code so the 10-digit input mask applies. */
function phoneParamDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

// ─── Component ───────────────────────────────────────

export default function LeadFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const isEdit = Boolean(id);

  // ── Edit mode: fetch existing lead ──
  const { data: lead, isLoading } = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads/${id}`);
      return data.lead;
    },
    enabled: isEdit,
  });

  if (isEdit) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      );
    }
    if (!lead) {
      return (
        <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border text-center">
          <p className="text-text-secondary">Lead not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/leads')}>Back to Leads</Button>
        </div>
      );
    }
    return (
      <EditLeadForm
        lead={lead}
        leadId={id!}
        navigate={navigate}
        queryClient={queryClient}
      />
    );
  }

  const searchParams = new URLSearchParams(location.search);
  const customerIdParam = searchParams.get('customer_id');
  // Dialer create-prefill: /leads/new?phone=+1XXXXXXXXXX seeds the phone field.
  const phoneParam = searchParams.get('phone');
  return <CreateLeadForm navigate={navigate} queryClient={queryClient} ability={ability} returnTo={(location.state as { returnTo?: string } | null)?.returnTo} preselectedCustomerId={customerIdParam} prefillPhone={phoneParam} />;
}

// ─── Create Lead Form ────────────────────────────────

function CreateLeadForm({
  navigate,
  queryClient,
  ability,
  returnTo,
  preselectedCustomerId,
  prefillPhone,
}: {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
  ability: AppAbility;
  returnTo?: string;
  preselectedCustomerId?: string | null;
  /** ?phone= from the dialer's unknown-number "Create lead" affordance. */
  prefillPhone?: string | null;
}) {
  // Scheduling values mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const { data: org } = useOrganization();
  // Owner picker (#389) — owner-eligible users only (ADMIN/SALES/TECHNICIAN); the
  // backend eligible_for=owner filter mirrors the create-time eligibility guard.
  // DEAD v1 twin - kept in step with pages/v2/leads/LeadFormPage. Not invested in.
  const { data: assignableOwners = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'owner' });
  // Inline "+ Add new job type" (#388) — persist to org.job_type_options; null = row closed.
  const updateOrg = useUpdateOrganization();
  const [addingJobType, setAddingJobType] = useState<string | null>(null);
  const commitJobType = () => {
    const trimmed = (addingJobType ?? '').trim();
    if (!trimmed) return;
    form.setValue('job_type', trimmed);
    const existing = org?.job_type_options ?? [];
    if (!existing.includes(trimmed)) {
      updateOrg.mutate({ job_type_options: [...existing, trimmed] });
    }
    setAddingJobType(null);
  };
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<SearchCustomer | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);

  // Duplicate-customer guard (spec §5.3): the existing record from a 409 on the
  // inline new-customer path, the form data to resubmit with override, and which
  // field(s) collided.
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CreateFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({
    email: false,
    phone: false,
  });
  // In-flight guard for "Open existing customer": awaits the customer refetch
  // before swapping the draft, so a double-click can't fire two fetches.
  const [openingExisting, setOpeningExisting] = useState(false);

  const form = useForm<CreateFormData>({
    resolver: zodResolver(createLeadFormSchema),
    defaultValues: {
      first_name: '', last_name: '', company_name: '',
      phone: prefillPhone ? formatPhoneInput(phoneParamDigits(prefillPhone)) : '',
      phone_ext: '',
      secondary_phone: '',
      email: '',
      service_location_id: '',
      service_address_line1: '', service_address_line2: '', service_city: '', service_state: '', service_zip: '',
      service_request: '', notes: '', job_type: '', ad_source: '', assigned_to: '',
      scheduled_date: '', scheduled_time: '', scheduled_end_date: '', scheduled_end_time: '',
    },
  });

  // '__add_new__' reveals the inline new-location sub-form (accreted via new_location).
  const serviceLocationId = form.watch('service_location_id');

  // Auto-populate when navigating from customer detail or estimate dialog
  const { data: preselectedCustomer } = useQuery({
    queryKey: ['customer-prefill', preselectedCustomerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${preselectedCustomerId}`);
      return data.customer as SearchCustomer;
    },
    enabled: Boolean(preselectedCustomerId),
  });

  useEffect(() => {
    if (preselectedCustomer && !selectedCustomerId) {
      setSelectedCustomerId(preselectedCustomer.id);
      setSelectedCustomer(preselectedCustomer);
      form.setValue('first_name', preselectedCustomer.first_name || '');
      form.setValue('last_name', preselectedCustomer.last_name || '');
      form.setValue('company_name', preselectedCustomer.company_name || '');
      form.setValue('phone', formatPhoneInput(preselectedCustomer.phone ?? ''));
      form.setValue('phone_ext', preselectedCustomer.phone_ext || '');
      form.setValue('email', preselectedCustomer.email || '');
      form.setValue('ad_source', preselectedCustomer.ad_source || '');
      const loc = preselectedCustomer.service_locations?.find((l) => l.is_primary) || preselectedCustomer.service_locations?.[0];
      // Pick the primary location by id (no silent free-text). Mirror its address
      // into the legacy fields so a server-side fallback still has an address.
      if (loc) {
        form.setValue('service_location_id', loc.id);
        form.setValue('service_address_line1', loc.address_line1);
        form.setValue('service_address_line2', loc.address_line2 || '');
        form.setValue('service_city', loc.city);
        form.setValue('service_state', loc.state);
        form.setValue('service_zip', loc.zip);
      }
    }
  }, [preselectedCustomer]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectCustomer = (c: SearchCustomer) => {
    setSelectedCustomerId(c.id);
    setSelectedCustomer(c);
    form.setValue('first_name', c.first_name || '');
    form.setValue('last_name', c.last_name || '');
    form.setValue('company_name', c.company_name || '');
    form.setValue('phone', formatPhoneInput(c.phone ?? ''));
    form.setValue('phone_ext', c.phone_ext || '');
    form.setValue('secondary_phone', '');
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
      // Customer has no locations yet — leave the location blank (it's optional now)
      // instead of forcing the add-new sub-form.
      form.setValue('service_location_id', '');
      form.setValue('service_address_line1', '');
      form.setValue('service_address_line2', '');
      form.setValue('service_city', '');
      form.setValue('service_state', '');
      form.setValue('service_zip', '');
    }
  };

  const mutation = useMutation({
    mutationFn: async ({ data, override }: { data: CreateFormData; override?: boolean }) => {
      const baseLeadFields = {
        service_request: data.service_request,
        notes: data.notes || undefined,
        job_type: data.job_type || undefined,
        assigned_to: data.assigned_to || undefined,
        scheduled_start: showSchedule ? dayAndTimeToIso(data.scheduled_date, data.scheduled_time, timezone) : undefined,
        scheduled_end: showSchedule ? dayAndTimeToIso(data.scheduled_end_date, data.scheduled_end_time, timezone) : undefined,
      };

      const newLocationPayload = {
        address_line1: data.service_address_line1,
        address_line2: data.service_address_line2 || undefined,
        city: data.service_city,
        state: data.service_state,
        zip: data.service_zip,
      };

      const hasAddress = Boolean(data.service_address_line1?.trim());

      if (selectedCustomerId) {
        // Existing customer: pick a ServiceLocation (id) or accrete a new one (new_location).
        const pickedExisting = data.service_location_id && data.service_location_id !== '__add_new__';
        // override bypasses the cross-customer accretion guard (#800 follow-up) — "Create
        // anyway" accretes a typed phone/email even when it belongs to another customer.
        const { data: res } = await api.post(override ? '/api/leads?override=true' : '/api/leads', {
          customer_id: selectedCustomerId,
          ad_source: data.ad_source || undefined,
          // Workiz-style accretion (spec §5.3): a typed phone/email is added as a new
          // secondary contact method on the customer — the primary is never overwritten.
          phone: data.phone || undefined,
          email: data.email || undefined,
          ...baseLeadFields,
          ...(pickedExisting
            ? { service_location_id: data.service_location_id }
            : hasAddress ? { new_location: newLocationPayload } : {}),
        });
        return res;
      }

      // New customer: the primary location is created from the (free-text) address.
      const { data: res } = await api.post(override ? '/api/leads?override=true' : '/api/leads', {
        new_customer: {
          first_name: data.first_name, last_name: data.last_name,
          company_name: data.company_name || undefined, phone: data.phone || undefined,
          phone_ext: data.phone_ext || undefined,
          secondary_phone: data.secondary_phone || undefined, email: data.email || undefined,
          ad_source: data.ad_source || undefined,
          ...(hasAddress ? { location: {
            address_line1: data.service_address_line1, address_line2: data.service_address_line2 || undefined,
            city: data.service_city, state: data.service_state, zip: data.service_zip,
          } } : {}),
        },
        ...baseLeadFields,
      });
      return res;
    },
    onSuccess: (res) => {
      // Clear the duplicate-guard state explicitly so `isOverriding` can never be
      // driven by stale state from a prior duplicate encounter (finding 4).
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      if (!selectedCustomerId) {
        const c = res.lead?.customer;
        const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || c?.company_name || 'New customer';
        const phone = formatPhone(c?.phone);
        toast({ title: 'Customer created', description: phone ? `${name} · ${phone}` : name });
      }
      if (returnTo && res.lead?.customer_id) {
        navigate(`${returnTo}?newCustomerId=${res.lead.customer_id}`, { replace: true });
      } else {
        // Class-level read check (no instance) — avoids fail-closed on the row-scoped
        // OWN_LEAD condition so a SALES owner still lands on their new lead; a role with
        // no Lead read grant goes to the list instead of a "Lead not found" page.
        navigate(res.lead?.id && ability.can('read', 'Lead') ? `/leads/${res.lead.id}` : '/leads');
      }
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

  // Dialog: "Open existing customer" → switch the lead to USE that existing
  // customer while preserving the lead draft (spec §5.3). Refetch the full record
  // (for service_locations) then reuse selectCustomer, which only rebinds the
  // contact + location fields and leaves the service request / notes / schedule.
  const handleOpenExisting = async () => {
    if (!dupExisting || openingExisting) return;
    const target = dupExisting;
    // Preserve a Source the user set for THIS lead — selectCustomer would otherwise
    // overwrite it with the customer's ad_source (finding 1).
    const draftAdSource = (form.getValues('ad_source') || '').trim();
    // Preserve any address the user already typed, in case the existing customer
    // genuinely has no locations (finding 2 — don't blank it).
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
      // Await the refetch FIRST, then swap the draft, then close the dialog —
      // so a failed fetch never leaves the dialog closed with nothing applied (finding 2).
      const { data } = await api.get(`/api/customers/${target.id}`);
      selectCustomer(data.customer as SearchCustomer);
    } catch {
      // #1996 — a redacted match carries no first_name/last_name/company_name/phone/email to
      // build a fallback from, and the requester cannot read the real record either; bail
      // without selecting a customer.
      if (isRedactedMatch(target)) return;
      // Fall back to a minimal record so the lead is still attached to the
      // existing customer (location picker will offer "+ Add new location").
      const fallback: SearchCustomer = {
        id: target.id,
        first_name: target.first_name || '',
        last_name: target.last_name || '',
        company_name: target.company_name,
        phone: target.phone || '',
        email: target.email,
        ad_source: null,
        service_locations: [],
      };
      selectCustomer(fallback);
      // selectCustomer blanked the address (no locations on the fallback) — restore
      // what the user had typed rather than wiping it out.
      form.setValue('service_location_id', draftAddress.service_location_id || '__add_new__');
      form.setValue('service_address_line1', draftAddress.service_address_line1);
      form.setValue('service_address_line2', draftAddress.service_address_line2);
      form.setValue('service_city', draftAddress.service_city);
      form.setValue('service_state', draftAddress.service_state);
      form.setValue('service_zip', draftAddress.service_zip);
    } finally {
      // Restore the lead's own Source if the user had set one (finding 1).
      if (draftAdSource) form.setValue('ad_source', draftAdSource);
      setOpeningExisting(false);
      setDupExisting(null);
    }
  };

  // Dialog: "Edit email / phone" → close + focus the offending input. Mirror the
  // customer form: setFocus can be stolen back as the Radix dialog unmounts, so
  // also target the element by id on the next frame (finding 3).
  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // Dialog: "Create anyway" → resubmit the lead create with override.
  const handleCreateAnyway = () => {
    if (!pendingData) return;
    mutation.mutate({ data: pendingData, override: true });
  };

  // Lock the dialog's action buttons while either the override resubmit OR the
  // open-existing refetch is in flight (the latter also guards against a
  // double-click firing two fetches — finding 2).
  const isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting;

  const errors = form.formState.errors;
  // The duplicate case is handled by the dialog — don't also surface the raw
  // "duplicate" string in the inline error line.
  const inlineError = getDuplicate(mutation.error) ? null : mutation.error;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" tone="subtle" size="sm" className="-ml-1" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <Heading>New Lead</Heading>
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
                  phone_ext: form.watch('phone_ext') || '',
                  secondary_phone: form.watch('secondary_phone') || '',
                  email: form.watch('email') || '',
                }}
                onFieldChange={(field, val) => {
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
                showPhoneExt
                showSecondaryPhone
                errors={{
                  first_name: errors.first_name?.message,
                  last_name: errors.last_name?.message,
                  phone: errors.phone?.message,
                  phone_ext: errors.phone_ext?.message,
                  secondary_phone: errors.secondary_phone?.message,
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

              {/* Divider: Client → Location */}
              <div className="border-t border-border pt-3">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Service Location</p>
              </div>

              <PickOrAccreteLocation
                locations={selectedCustomer ? (selectedCustomer.service_locations ?? []) : []}
                showPicker={Boolean(selectedCustomer)}
                value={{
                  locationId: serviceLocationId || '',
                  address: {
                    address_line1: form.watch('service_address_line1') || '',
                    address_line2: form.watch('service_address_line2') || '',
                    city: form.watch('service_city') || '',
                    state: form.watch('service_state') || '',
                    zip: form.watch('service_zip') || '',
                  },
                }}
                onChange={(next) => {
                  form.setValue('service_location_id', next.locationId);
                  form.setValue('service_address_line1', next.address.address_line1, { shouldValidate: true });
                  form.setValue('service_address_line2', next.address.address_line2);
                  form.setValue('service_city', next.address.city, { shouldValidate: true });
                  form.setValue('service_state', next.address.state, { shouldValidate: true });
                  form.setValue('service_zip', next.address.zip, { shouldValidate: true });
                }}
                errors={{
                  address_line1: errors.service_address_line1?.message,
                  city: errors.service_city?.message,
                  state: errors.service_state?.message,
                  zip: errors.service_zip?.message,
                }}
              />

              <ServiceLocationMap
                addressLine1={form.watch('service_address_line1')}
                city={form.watch('service_city')}
                state={form.watch('service_state')}
                zip={form.watch('service_zip')}
              />
            </div>

            {/* Right: What + When */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Lead Details</p>

              <FormField label="Service Request *" error={errors.service_request?.message}>
                <Textarea {...form.register('service_request')} rows={3} placeholder="Describe the service needed..." />
              </FormField>

              <FormField label="Notes">
                <Textarea {...form.register('notes')} rows={2} placeholder="Internal notes..." />
              </FormField>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <FormField label="Job Type">
                    {(fieldProps) => (
                      <Select
                        value={form.watch('job_type') || ''}
                        onValueChange={(v) => { if (v === '__add_new__') { setAddingJobType(''); return; } form.setValue('job_type', v); }}
                      >
                        <SelectTrigger {...fieldProps}><SelectValue placeholder="Select..." /></SelectTrigger>
                        <SelectContent>
                          {(() => {
                            const baseOptions = org?.job_type_options ?? [];
                            const current = form.watch('job_type');
                            const options = current && !baseOptions.includes(current) ? [current, ...baseOptions] : baseOptions;
                            return options.length > 0
                              ? options.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)
                              : <SelectItem value="__none__" disabled>{ability.can('update', 'Organization') ? 'No options — add below' : 'No options — add in Settings'}</SelectItem>;
                          })()}
                          {ability.can('update', 'Organization') && (
                            <SelectItem value="__add_new__">+ Add new type…</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                  {addingJobType !== null && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        autoFocus
                        value={addingJobType}
                        maxLength={50}
                        onChange={(e) => setAddingJobType(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitJobType(); } }}
                        placeholder="New job type (press Enter or Add)"
                      />
                      <Button type="button" size="sm" onClick={commitJobType} disabled={!addingJobType.trim()}>Add</Button>
                    </div>
                  )}
                </div>
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
                {/* Owner picker (#389) — hidden for SALES, who auto-self-assign and lack the assign ability. */}
                {ability.can('assign', 'Lead') && (
                  <FormField label="Assign to">
                    {(fieldProps) => (
                      <Select value={form.watch('assigned_to') || ''} onValueChange={(v) => form.setValue('assigned_to', v)}>
                        <SelectTrigger {...fieldProps}><SelectValue placeholder="Unassigned" /></SelectTrigger>
                        <SelectContent>
                          {assignableOwners.map((u) => (
                            <SelectItem key={u.id} value={u.id}>{`${u.first_name} ${u.last_name}`}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                )}
              </div>

              {/* Divider: Details → Schedule */}
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Schedule</p>
                <Switch checked={showSchedule} onCheckedChange={setShowSchedule} />
              </div>

              {/* NOT converted to FormField (phase 11b deferral). TimeSelect declares an
                  `id` prop but never forwards it: it renders SelectField, whose API has no
                  `id` and which does not spread the rest of its props onto the trigger, so
                  FormField's generated id would reach no element and the label would point
                  at nothing. Converting only the sibling Date field would also leave the two
                  controls in each row vertically out of step, since FormField swaps the
                  label's line box for an explicit flex gap. Both halves convert together
                  once SelectField can carry an id. */}
              {showSchedule && (
                <>
                  <div className="flex gap-3">
                    <div>
                      <Label>Start Date</Label>
                      <DatePicker
                        aria-label="Start Date"
                        className="w-[180px]"
                        value={form.watch('scheduled_date') || ''}
                        onChange={(v) => form.setValue('scheduled_date', v, { shouldDirty: true })}
                      />
                    </div>
                    <div>
                      <Label>Start Time</Label>
                      <TimeSelect
                        value={form.watch('scheduled_time') || ''}
                        onChange={(v) => form.setValue('scheduled_time', v, { shouldDirty: true })}
                      />
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <div>
                      <Label>End Date</Label>
                      <DatePicker
                        aria-label="End Date"
                        className="w-[180px]"
                        value={form.watch('scheduled_end_date') || ''}
                        onChange={(v) => form.setValue('scheduled_end_date', v, { shouldDirty: true })}
                      />
                    </div>
                    <div>
                      <Label>End Time</Label>
                      <TimeSelect
                        value={form.watch('scheduled_end_time') || ''}
                        onChange={(v) => form.setValue('scheduled_end_time', v, { shouldDirty: true })}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Error */}
          {inlineError && (
            <p className="text-sm text-danger">
              {extractApiError(inlineError, 'Something went wrong')}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
            <Button variant="solid" tone="business" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating...' : 'Create Lead'}
            </Button>
          </div>
        </form>
      </div>

    </div>
  );
}

// ─── Edit Lead Form ──────────────────────────────────

function EditLeadForm({
  lead,
  leadId,
  navigate,
  queryClient,
}: {
  lead: Record<string, unknown>;
  leadId: string;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  // Scheduling values mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const { data: org } = useOrganization();
  // EditLeadForm has no ability prop — resolve it here for the #388 add-type gate.
  const ability = useAppAbility();
  // Inline "+ Add new job type" (#388) — persist to org.job_type_options; null = row closed.
  const updateOrg = useUpdateOrganization();
  const [addingJobType, setAddingJobType] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(
    Boolean(lead.scheduled_start || lead.scheduled_end)
  );
  const [taxWarnOpen, setTaxWarnOpen] = useState(false);

  const customer = lead.customer as { service_locations?: ServiceLocation[] } | undefined;
  const customerLocations = customer?.service_locations ?? [];
  // Location freezes once any estimate exists (backend returns 400 otherwise).
  const hasEstimates = ((lead.estimates as unknown[] | undefined)?.length ?? 0) > 0;
  const leadState = (lead.service_state as string | null) || '';

  // Best-effort: match the lead's current address to one of the customer's locations.
  const initialLocation = customerLocations.find(
    (l) => l.address_line1 === (lead.service_address_line1 as string) && l.zip === (lead.service_zip as string),
  ) || customerLocations.find((l) => l.is_primary) || customerLocations[0];

  const form = useForm<EditFormData>({
    resolver: zodResolver(editLeadFormSchema),
    defaultValues: {
      service_request: lead.service_request as string,
      notes: (lead.notes as string) || '',
      job_type: (lead.job_type as string) || '',
      ad_source: ((lead.customer as { ad_source?: string | null })?.ad_source) || '',
      scheduled_date: isoToOrgDay(lead.scheduled_start as string | null, timezone),
      scheduled_time: isoToOrgTime(lead.scheduled_start as string | null, timezone),
      scheduled_end_date: isoToOrgDay(lead.scheduled_end as string | null, timezone),
      scheduled_end_time: isoToOrgTime(lead.scheduled_end as string | null, timezone),
      service_location_id: initialLocation?.id || '',
      service_address_line1: (lead.service_address_line1 as string) || '',
      service_address_line2: (lead.service_address_line2 as string) || '',
      service_city: (lead.service_city as string) || '',
      service_state: (lead.service_state as string) || '',
      service_zip: (lead.service_zip as string) || '',
    },
  });

  const commitJobType = () => {
    const trimmed = (addingJobType ?? '').trim();
    if (!trimmed) return;
    form.setValue('job_type', trimmed);
    const existing = org?.job_type_options ?? [];
    if (!existing.includes(trimmed)) {
      updateOrg.mutate({ job_type_options: [...existing, trimmed] });
    }
    setAddingJobType(null);
  };

  const serviceLocationId = form.watch('service_location_id');
  const newState = form.watch('service_state') || '';
  // A state change (and the location actually changed) triggers the tax warning.
  const isStateChange = !hasEstimates && Boolean(newState) && newState !== leadState;

  const mutation = useMutation({
    mutationFn: async (data: EditFormData) => {
      const pickedExisting = data.service_location_id && data.service_location_id !== '__add_new__';
      const locationFields = hasEstimates
        // Location is frozen — do not send any location-change inputs.
        ? {}
        : pickedExisting
          ? { service_location_id: data.service_location_id }
          : {
              new_location: {
                address_line1: data.service_address_line1 || '',
                address_line2: data.service_address_line2 || undefined,
                city: data.service_city || '',
                state: data.service_state || '',
                zip: data.service_zip || '',
              },
            };
      const payload = {
        service_request: data.service_request,
        notes: data.notes || null,
        job_type: data.job_type || null,
        ad_source: data.ad_source || null,
        scheduled_start: showSchedule ? (dayAndTimeToIso(data.scheduled_date, data.scheduled_time, timezone) || null) : null,
        scheduled_end: showSchedule ? (dayAndTimeToIso(data.scheduled_end_date, data.scheduled_end_time, timezone) || null) : null,
        ...locationFields,
      };
      const { data: res } = await api.patch(`/api/leads/${leadId}`, payload);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      navigate(`/leads/${leadId}`);
    },
  });

  // Intercept submit: a state-changing location requires explicit confirmation first.
  const submit = (data: EditFormData) => {
    if (isStateChange) {
      setTaxWarnOpen(true);
      return;
    }
    mutation.mutate(data);
  };

  const confirmTaxWarning = () => {
    setTaxWarnOpen(false);
    mutation.mutate(form.getValues());
  };

  const errors = form.formState.errors;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" tone="subtle" size="sm" className="-ml-1" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <Heading>Edit Lead</Heading>
      </div>

      <div className="rounded-xl bg-surface-light shadow-card border border-border p-6">
        <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Column 1: Lead Details */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Lead Details</p>

              <FormField label="Service Request *" error={errors.service_request?.message}>
                <Textarea {...form.register('service_request')} rows={3} />
              </FormField>

              <FormField label="Notes">
                <Textarea {...form.register('notes')} rows={2} placeholder="Internal notes..." />
              </FormField>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <FormField label="Job Type">
                    {(fieldProps) => (
                      <Select
                        value={form.watch('job_type') || ''}
                        onValueChange={(v) => { if (v === '__add_new__') { setAddingJobType(''); return; } form.setValue('job_type', v); }}
                      >
                        <SelectTrigger {...fieldProps}><SelectValue placeholder="Select type..." /></SelectTrigger>
                        <SelectContent>
                          {(() => {
                            const baseOptions = org?.job_type_options ?? [];
                            const current = form.watch('job_type');
                            const options = current && !baseOptions.includes(current) ? [current, ...baseOptions] : baseOptions;
                            return options.length > 0
                              ? options.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)
                              : <SelectItem value="__none__" disabled>{ability.can('update', 'Organization') ? 'No options — add below' : 'No options — add in Settings'}</SelectItem>;
                          })()}
                          {ability.can('update', 'Organization') && (
                            <SelectItem value="__add_new__">+ Add new type…</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                  {addingJobType !== null && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        autoFocus
                        value={addingJobType}
                        maxLength={50}
                        onChange={(e) => setAddingJobType(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitJobType(); } }}
                        placeholder="New job type (press Enter or Add)"
                      />
                      <Button type="button" size="sm" onClick={commitJobType} disabled={!addingJobType.trim()}>Add</Button>
                    </div>
                  )}
                </div>
                <FormField label="Source">
                  {(fieldProps) => (
                    <Select value={form.watch('ad_source') || ''} onValueChange={(v) => form.setValue('ad_source', v)}>
                      <SelectTrigger {...fieldProps}><SelectValue placeholder="Select source..." /></SelectTrigger>
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
            </div>

            {/* Column 2: Service Location + Schedule */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Service Location</p>

              {hasEstimates ? (
                /* Location is frozen once an estimate exists. */
                <div className="rounded-lg border border-border bg-background-light/50 px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Lock className="h-3.5 w-3.5 text-text-secondary" />
                    {[lead.service_address_line1, lead.service_address_line2].filter(Boolean).join(', ') || '—'}
                  </div>
                  <p className="text-xs text-text-secondary">
                    {[lead.service_city, lead.service_state, lead.service_zip].filter(Boolean).join(', ')}
                  </p>
                  <p className="text-xs text-text-secondary">
                    Locked — revise or duplicate the estimate to change the service location.
                  </p>
                </div>
              ) : (
                <PickOrAccreteLocation
                  locations={customerLocations}
                  showPicker
                  label="Location"
                  value={{
                    locationId: serviceLocationId || '',
                    address: {
                      address_line1: form.watch('service_address_line1') || '',
                      address_line2: form.watch('service_address_line2') || '',
                      city: form.watch('service_city') || '',
                      state: form.watch('service_state') || '',
                      zip: form.watch('service_zip') || '',
                    },
                  }}
                  onChange={(next) => {
                    form.setValue('service_location_id', next.locationId);
                    form.setValue('service_address_line1', next.address.address_line1, { shouldValidate: true });
                    form.setValue('service_address_line2', next.address.address_line2);
                    form.setValue('service_city', next.address.city, { shouldValidate: true });
                    form.setValue('service_state', next.address.state, { shouldValidate: true });
                    form.setValue('service_zip', next.address.zip, { shouldValidate: true });
                  }}
                  pickerNote={
                    isStateChange ? (
                      <p className="mt-1 text-xs text-warning">
                        Changing to {newState} will change the tax rate for new estimates.
                      </p>
                    ) : undefined
                  }
                />
              )}

              {/* Divider: Address → Schedule */}
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Schedule</p>
                <Switch checked={showSchedule} onCheckedChange={setShowSchedule} />
              </div>

              {/* Same phase 11b deferral as the create form above: TimeSelect drops the id
                  FormField hands it, so these four fields stay hand wired for now. */}
              {showSchedule && (
                <>
                  <div className="flex gap-3">
                    <div>
                      <Label>Start Date</Label>
                      <DatePicker
                        aria-label="Start Date"
                        className="w-[180px]"
                        value={form.watch('scheduled_date') || ''}
                        onChange={(v) => form.setValue('scheduled_date', v, { shouldDirty: true })}
                      />
                    </div>
                    <div>
                      <Label>Start Time</Label>
                      <TimeSelect
                        value={form.watch('scheduled_time') || ''}
                        onChange={(v) => form.setValue('scheduled_time', v, { shouldDirty: true })}
                      />
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <div>
                      <Label>End Date</Label>
                      <DatePicker
                        aria-label="End Date"
                        className="w-[180px]"
                        value={form.watch('scheduled_end_date') || ''}
                        onChange={(v) => form.setValue('scheduled_end_date', v, { shouldDirty: true })}
                      />
                    </div>
                    <div>
                      <Label>End Time</Label>
                      <TimeSelect
                        value={form.watch('scheduled_end_time') || ''}
                        onChange={(v) => form.setValue('scheduled_end_time', v, { shouldDirty: true })}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Error */}
          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Something went wrong')}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </div>

      <TaxWarningDialog
        open={taxWarnOpen}
        onOpenChange={setTaxWarnOpen}
        oldState={leadState}
        newState={newState}
        onConfirm={confirmTaxWarning}
        confirmLabel="Save Changes"
        isPending={mutation.isPending}
      />
    </div>
  );
}
