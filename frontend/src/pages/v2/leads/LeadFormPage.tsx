import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';

import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/shared/organization';
import { useAddJobType } from '@/lib/api/jobTypes';
import { useAssignableUsers } from '@/lib/api/users';
import { useLeadCreatorPrefill } from '@/lib/api/leads';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useAssignUserPermission } from '@/lib/users/useAssignUserPermission';
import type { ScheduleConflictItem } from '@/pages/v2/_shared/scheduleConflict';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAbility } from '@/lib/ability';
import { extractApiError, formatPhone } from '@/lib/utils';
import { phoneFieldValue } from '@/ui-kit/lib/phoneField';
import { phoneParamDigits } from '@/lib/phonePrefill';
import {
  createLeadFormSchema, editLeadFormSchema, editLeadDetailsFormSchema,
  type CreateLeadFormData as CreateFormData, type EditLeadFormData as EditFormData,
} from '@/lib/lead-form-schemas';
import {
  getDuplicateCustomer as getDuplicate,
  computeMatchedCustomerFields as computeMatchedFields,
  type PickCustomer,
} from '@/components/crm/PickOrCreateCustomer';
import type { ServiceLocationOption } from '@/components/crm/PickOrAccreteLocation';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import { ServiceLocationMap } from '@/components/crm/service-location-map';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Separator } from '@/ui-kit/components/ui/separator';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { TextLengthCounter } from '@/components/form';
import { LONG_TEXT_MAX } from '@/lib/textLimits';

import { v2Path } from '../uiV2';
import { TaxWarningDialog } from './components/leadDialogs';
import { BackLink } from '../_shared/backLink';
import { LoadError } from '../_shared/loadError';
import { isNotFoundError } from '../_shared/loadErrorState';
import { DateField } from '@/ui-kit/components/form/dateField';
import { PickCustomerFields } from '../_shared/pickCustomer';
import { PersonSlotField } from '../_shared/personSlotField';
import { ScheduleClashNotice } from '../_shared/scheduleClashNotice';
import { PickLocation } from '../_shared/pickLocation';
import { TimeField } from '@/ui-kit/components/form/timeField';
import { useRecordVisit } from '../pageBreadcrumbs';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';
import { useFormFlow } from '@/ui-kit/lib/formFlow';
import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { dayAndTimeToIso, useScheduleTimezone } from '@/lib/schedule-tz';
import { leadOffers, type LeadAction } from './components/leadShared';
import { useNoOptionsLabel } from '@/lib/useIsAdmin';

type SearchCustomer = PickCustomer;
type ServiceLocation = ServiceLocationOption;

function combineDatetime(date?: string, time?: string): string | undefined {
  if (!date) return undefined;
  const t = time || '00:00';
  return new Date(`${date}T${t}:00`).toISOString();
}

function extractDate(iso?: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function extractTime(iso?: string | null): string {
  if (!iso) return '';
  return iso.slice(11, 16);
}

/**
 * /v2/leads/new and /v2/leads/:id/edit.
 *
 * One file, two inner components, exactly as the legacy page: the create/edit
 * split is by COMPONENT, so the edit-mode early returns cannot cause a
 * hook-order violation. Merging them would introduce one.
 */
export default function LeadFormPage() {
  useRecordVisit('leads', 'New Lead');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const isEdit = Boolean(id);

  const { data: lead, isLoading, isError, error, refetch, isFetching } = useQuery({
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
          <Spinner size="lg" />
        </div>
      );
    }
    // A failed request is an error with a Retry (mobile slice 68); only a 404 is "not found".
    if (!lead && isError && !isNotFoundError(error)) {
      return (
        <Card>
          <LoadError title="Couldn't load this lead." onRetry={() => { void refetch(); }} retrying={isFetching} />
        </Card>
      );
    }
    if (!lead) {
      return (
        <Card>
          <CardContent className="text-center">
            <p className="text-muted-foreground">Lead not found.</p>
            <Button variant="outline" className="mt-4" onClick={() => navigate(v2Path('/leads'))}>Back to Leads</Button>
          </CardContent>
        </Card>
      );
    }
    // Keyed by the lead: another lead gets a fresh form, so its fields and the Notes baseline are filled from it together.
    return <EditLeadForm key={id} lead={lead} leadId={id!} navigate={navigate} queryClient={queryClient} />;
  }

  const searchParams = new URLSearchParams(location.search);
  const customerIdParam = searchParams.get('customer_id');
  // Dialer create-prefill: /leads/new?phone=+1XXXXXXXXXX seeds the phone field.
  const phoneParam = searchParams.get('phone');
  return (
    <CreateLeadForm
      queryClient={queryClient}
      ability={ability}
      returnTo={(location.state as { returnTo?: string } | null)?.returnTo}
      preselectedCustomerId={customerIdParam}
      prefillPhone={phoneParam}
    />
  );
}

function CreateLeadForm({
  queryClient, ability, returnTo, preselectedCustomerId, prefillPhone,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  ability: AppAbility;
  returnTo?: string;
  preselectedCustomerId?: string | null;
  prefillPhone?: string | null;
}) {
  const noOptions = useNoOptionsLabel();
  const { data: org } = useOrganization();
  // Owner picker (#389) - owner-eligible users only; the backend eligible_for
  // filter mirrors the create-time eligibility guard.
  // `directory`, not `jobCrew`: the lead OWNER is not job crew. `POST/PATCH /api/leads` asks
  // slot eligibility for the Owner, never `isAssigneeSetPermitted`, so `assign User` governs nothing here -
  // and scoping by it collapsed this dropdown to one row for a custom role holding
  // `read User` + `create Lead` while the API still accepted anybody.
  // Only a person with Assign people to leads gets pickers (S03.15); anyone else sees the creator rule's
  // result as fixed text, and the server applies it, so neither roster is asked for.
  const mayNamePeople = ability.can('assign', 'Lead');
  const ownerRoster = useAssignableUsers({ purpose: 'directory', eligibleFor: 'owner', enabled: mayNamePeople });
  const dispatcherRoster = useAssignableUsers({ purpose: 'directory', eligibleFor: 'dispatcher', enabled: mayNamePeople });
  const assignableOwners = ownerRoster.data ?? [];
  const assignableDispatchers = dispatcherRoster.data ?? [];
  // The creator rule's pre-fill (Owner or Dispatcher, never both): the form shows it, the create route applies it.
  const { data: prefill, isPending: prefillPending, isError: prefillFailed } = useLeadCreatorPrefill();
  const me = useAuthStore((s) => s.user);
  const addJobType = useAddJobType();
  const [addingJobType, setAddingJobType] = useState<string | null>(null);
  const jobTypeField = useRef<HTMLDivElement>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<SearchCustomer | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  // Who does the walkthrough the time books. A person with Book walkthroughs picks the Performers (empty to
  // start with); anyone else has the "I'll do this walkthrough" checkbox, checked by default, which puts
  // only them on it. The server books the time as a real walkthrough visit with these people on it.
  const mayBookWalkthroughs = ability.can('schedule_walkthrough', 'Lead');
  // The Notes box writes the lead's general note (#3104), so it shows only to a person who may add a lead note: Add notes
  // or Edit leads, the rule the Notes tab and POST /api/leads/:id/notes follow.
  const mayAddLeadNote = ability.can('add_note', 'Lead') || ability.can('update', 'Lead');
  const { actorId, actorKnownPeople } = useAssignUserPermission();
  const [performerIds, setPerformerIds] = useState<string[]>([]);
  const [doItMyself, setDoItMyself] = useState(true);
  // A performer already booked over that slot: the server's verdict on the last try, and the form it refused,
  // so "Schedule anyway" can send the same lead again with `walkthrough_force`.
  const [clash, setClash] = useState<{ data: CreateFormData; when: string; conflicts: ScheduleConflictItem[] } | null>(null);
  // "Schedule anyway" stays chosen if the duplicate-customer guard sends the same lead again afterwards.
  const forceWalkthrough = useRef(false);
  // The walkthrough is booked at the organisation's clock, as booking from the lead page is.
  const timezone = useScheduleTimezone();
  const scheduleKey = (d: CreateFormData) => [d.scheduled_date, d.scheduled_time, d.scheduled_end_date, d.scheduled_end_time].join('|');

  // Duplicate-customer guard: the existing record from a 409, the form data to
  // resubmit with override, and which field(s) collided.
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CreateFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({ email: false, phone: false });
  // In-flight guard for "Open existing customer": awaits the customer refetch
  // before swapping the draft, so a double-click cannot fire two fetches.
  const [openingExisting, setOpeningExisting] = useState(false);

  // Mobile slice 38: Next/Done keys, and a failed submit lands on the first
  // error in page order (react-hook-form's own focus follows registration order
  // and cannot reach the controlled customer block).
  const flow = useFormFlow();
  const form = useForm<CreateFormData>({
    resolver: zodResolver(createLeadFormSchema),
    shouldFocusError: false,
    defaultValues: {
      first_name: '', last_name: '', company_name: '',
      phone: prefillPhone ? phoneFieldValue(phoneParamDigits(prefillPhone)) : '',
      phone_ext: '',
      secondary_phone: '',
      email: '',
      service_location_id: '',
      service_address_line1: '', service_address_line2: '', service_city: '', service_state: '', service_zip: '',
      service_request: '', notes: '', job_type: '', ad_source: '',
      scheduled_date: '', scheduled_time: '', scheduled_end_date: '', scheduled_end_time: '',
    },
  });

  // What the two people fields hold: whatever the person picked, else the pre-fill. The fields stay unset until a
  // picker is used, so the pre-fill is not their work (an untouched form never asks before leaving), and a picker
  // mounts with its value already in hand (see PersonSlotField's key).
  const ownerId = form.watch('assigned_to') ?? prefill?.owner_id ?? '';
  const dispatcherId = form.watch('dispatcher_id') ?? prefill?.dispatcher_id ?? '';

  // Leaving a half-filled form asks first (mobile slice 66). What the link prefilled (a dialer
  // phone, a customer chosen before the page opened) is not work; typing, or choosing a different
  // customer here, is.
  const leave = useLeaveGuard(
    form.formState.isDirty
      || (selectedCustomerId !== null && selectedCustomerId !== (preselectedCustomerId ?? null)),
  );

  const commitJobType = () => {
    const trimmed = (addingJobType ?? '').trim();
    if (!trimmed) return;
    form.setValue('job_type', trimmed, { shouldDirty: true });
    const existing = org?.job_type_options ?? [];
    if (!existing.includes(trimmed)) {
      addJobType.mutate(trimmed);
    }
    setAddingJobType(null);
  };

  // '__add_new__' reveals the inline new-location sub-form (accreted via new_location).
  const serviceLocationId = form.watch('service_location_id');

  const { data: preselectedCustomer } = useQuery({
    queryKey: ['customer-prefill', preselectedCustomerId],
    queryFn: async () => {
      // #2041 slice 1 - the org-wide picker's expand endpoint (Ran's carve-out).
      const { data } = await api.get(`/api/customers/picker/${preselectedCustomerId}`);
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
      form.setValue('phone', phoneFieldValue(preselectedCustomer.phone ?? ''));
      form.setValue('phone_ext', preselectedCustomer.phone_ext || '');
      form.setValue('email', preselectedCustomer.email || '');
      form.setValue('ad_source', preselectedCustomer.ad_source || '');
      const loc = preselectedCustomer.service_locations?.find((l) => l.is_primary)
        || preselectedCustomer.service_locations?.[0];
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
    form.setValue('phone', phoneFieldValue(c.phone ?? ''));
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
      // Customer has no locations yet - leave the location blank (it is optional)
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
      const walkthroughStart = showSchedule ? dayAndTimeToIso(data.scheduled_date, data.scheduled_time, timezone) : undefined;
      const walkthroughPerformers = mayBookWalkthroughs
        ? performerIds
        : doItMyself && prefill?.can_be_on_crew && actorId ? [actorId] : [];
      const baseLeadFields = {
        service_request: data.service_request,
        notes: mayAddLeadNote ? data.notes || undefined : undefined,
        job_type: data.job_type || undefined,
        // A holder saves what the pickers hold (kept, changed or cleared); anyone else sends no people and the
        // server applies the creator rule, so what the form showed is what is saved.
        ...(mayNamePeople ? { assigned_to: ownerId || null, dispatcher_id: dispatcherId || null } : {}),
        scheduled_start: walkthroughStart,
        scheduled_end: showSchedule ? dayAndTimeToIso(data.scheduled_end_date, data.scheduled_end_time, timezone) : undefined,
        // The people on the walkthrough: the Performers picked by a person with Book walkthroughs, or only the creator
        // for anyone else who left "I'll do this walkthrough" checked. With a time, none is a walkthrough with nobody
        // on it; with no time, people make a "To be scheduled" walkthrough and nobody makes none.
        ...(walkthroughStart || walkthroughPerformers.length > 0 ? { walkthrough_performer_ids: walkthroughPerformers } : {}),
        ...(forceWalkthrough.current ? { walkthrough_force: true } : {}),
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
        // Existing customer: pick a ServiceLocation (id) or accrete a new one.
        const pickedExisting = data.service_location_id && data.service_location_id !== '__add_new__';
        const { data: res } = await api.post(override ? '/api/leads?override=true' : '/api/leads', {
          customer_id: selectedCustomerId,
          ad_source: data.ad_source || undefined,
          // Workiz-style accretion: a typed phone/email is added as a new secondary
          // contact method on the customer - the primary is never overwritten.
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
      // driven by stale state from a prior duplicate encounter.
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      setClash(null);
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      if (!selectedCustomerId) {
        const c = res.lead?.customer;
        const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || c?.company_name || 'New customer';
        const phone = formatPhone(c?.phone);
        toast('Customer created', { description: phone ? `${name} · ${phone}` : name });
      }
      if (returnTo && res.lead?.customer_id) {
        leave.finish(`${returnTo}?newCustomerId=${res.lead.customer_id}`, { replace: true });
      } else {
        // Class-level read check (no instance) - avoids fail-closed on the row-scoped
        // OWN_LEAD condition so a SALES owner still lands on their new lead; a role
        // with no Lead read grant goes to the list instead of a "not found" page.
        leave.finish(
          res.lead?.id && ability.can('read', 'Lead')
            ? v2Path(`/leads/${res.lead.id}`)
            : v2Path('/leads'),
        );
      }
    },
    onError: (err, { data }) => {
      const refused = (err as { response?: { status?: number; data?: { conflicts?: ScheduleConflictItem[] } } }).response;
      if (refused?.status === 409 && Array.isArray(refused.data?.conflicts)) setClash({ data, when: scheduleKey(data), conflicts: refused.data.conflicts });
      const dup = getDuplicate(err);
      if (dup) {
        setDupExisting(dup);
        setPendingData(data);
        setDupMatched(computeMatchedFields(data, dup));
      } else {
        // Any other answer (a number refused after Create anyway) closes the dialog, so the form's error line shows it.
        setDupExisting(null);
      }
    },
  });

  // "Open existing customer" -> switch the lead to USE that existing customer
  // while preserving the lead draft.
  const handleOpenExisting = async () => {
    if (!dupExisting || openingExisting) return;
    const target = dupExisting;
    // Preserve a Source the user set for THIS lead - selectCustomer would
    // otherwise overwrite it with the customer's ad_source.
    const draftAdSource = (form.getValues('ad_source') || '').trim();
    // Preserve any address already typed, in case the existing customer has no
    // locations - do not blank it.
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
      // Await the refetch FIRST, then swap the draft, then close the dialog - so a
      // failed fetch never leaves the dialog closed with nothing applied.
      // #2041 slice 1 - the org-wide picker's expand endpoint (Ran's carve-out).
      const { data } = await api.get(`/api/customers/picker/${target.id}`);
      selectCustomer(data.customer as SearchCustomer);
    } catch {
      // #1996 — a redacted match carries no first_name/last_name/company_name/phone/email to
      // build a fallback from, and the requester cannot read the real record either; bail
      // without selecting a customer.
      if (isRedactedMatch(target)) return;
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
      // selectCustomer blanked the address (no locations on the fallback) -
      // restore what the user had typed rather than wiping it out.
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

  // "Edit email / phone" -> close + focus the offending input. setFocus can be
  // stolen back as the dialog unmounts, so also target the element by id next frame.
  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // A clash describes the time and the people that produced it; changing either retires it.
  const resetClash = () => {
    forceWalkthrough.current = false;
    setClash(null);
  };

  const handleCreateAnyway = () => {
    if (!pendingData) return;
    mutation.mutate({ data: pendingData, override: true });
  };

  // Lock the dialog's actions while either the override resubmit OR the
  // open-existing refetch is in flight.
  const isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting;

  const errors = form.formState.errors;
  // The duplicate case is handled by the dialog - do not also surface the raw
  // "duplicate" string in the inline error line.
  // ...and a clash with a performer's other work has its own block below.
  const inlineError = getDuplicate(mutation.error) || clash ? null : mutation.error;

  const jobTypeOptions = (() => {
    const base = org?.job_type_options ?? [];
    const current = form.watch('job_type');
    return current && !base.includes(current) ? [current, ...base] : base;
  })();
  const sourceOptions = (() => {
    const base = org?.source_options ?? [];
    const current = form.watch('ad_source');
    return current && !base.includes(current) ? [current, ...base] : base;
  })();

  return (
    <div>
      <PageHeader
        title="New Lead"
        back={<BackLink onClick={leave.leaveBack} />}
      />

      {/* No Card around the form. The page canvas already frames this content,
          so a card here drew a second border a few pixels inside the first and
          the fields read as boxed-in. The form keeps the card's horizontal
          rhythm through px-1 and gets its separation from spacing instead. */}
      <div className="px-1 pt-2">
          <form noValidate {...flow.formProps} onSubmit={form.handleSubmit((d) => { forceWalkthrough.current = false; mutation.mutate({ data: d }); }, flow.focusFirstInvalid)} className="flex flex-col gap-7">
            <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
              {/* Left: who + where */}
              <div className="flex flex-col gap-5">
                <p className="text-muted-foreground text-xs font-semibold uppercase">Client Details</p>

                <PickCustomerFields
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
                    form.setValue(field, val, { shouldDirty: true });
                    // Workiz-style accretion: editing phone/email keeps the link (it
                    // accretes on submit); only a name/company edit forks a new customer.
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

                <Separator />
                <p className="text-muted-foreground text-xs font-semibold uppercase">Service Location</p>

                <PickLocation
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
                    form.setValue('service_location_id', next.locationId, { shouldDirty: true });
                    form.setValue('service_address_line1', next.address.address_line1, { shouldValidate: true, shouldDirty: true });
                    form.setValue('service_address_line2', next.address.address_line2, { shouldDirty: true });
                    form.setValue('service_city', next.address.city, { shouldValidate: true, shouldDirty: true });
                    form.setValue('service_state', next.address.state, { shouldValidate: true, shouldDirty: true });
                    form.setValue('service_zip', next.address.zip, { shouldValidate: true, shouldDirty: true });
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

              {/* Right: what + when */}
              <div className="flex flex-col gap-5">
                <p className="text-muted-foreground text-xs font-semibold uppercase">Lead Details</p>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="v2-service-request">Service Request *</Label>
                  <Textarea
                    id="v2-service-request"
                    {...form.register('service_request')}
                    rows={3}
                    placeholder="Describe the service needed..."
                  />
                  <TextLengthCounter length={(form.watch('service_request') ?? '').length} max={LONG_TEXT_MAX} />
                  {errors.service_request && <p data-error-for="v2-service-request" className="text-destructive text-xs">{errors.service_request.message}</p>}
                </div>

                {mayAddLeadNote && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="v2-notes">Notes</Label>
                  <Textarea id="v2-notes" {...form.register('notes')} rows={2} placeholder="Internal notes..." />
                  <TextLengthCounter length={(form.watch('notes') ?? '').length} max={LONG_TEXT_MAX} />
                  {errors.notes && <p data-error-for="v2-notes" className="text-destructive text-xs">{errors.notes.message}</p>}
                </div>
                )}

                <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
                  <div ref={jobTypeField} className="flex flex-col gap-1.5">
                    <Label>Job Type</Label>
                    <SelectField
                      aria-label="Job Type"
                      value={form.watch('job_type') || ''}
                      onValueChange={(v) => {
                        if (v === '__add_new__') { setAddingJobType(''); return; }
                        form.setValue('job_type', v, { shouldDirty: true });
                      }}
                      placeholder="Select..."
                      options={[
                        ...(jobTypeOptions.length > 0
                          ? jobTypeOptions.map((t) => ({ value: t, label: t }))
                          : [{
                            value: '__none__',
                            label: ability.can('update', 'Organization') ? 'No options - add below' : 'No options',
                            disabled: true,
                          }]),
                        ...(ability.can('update', 'Organization')
                          ? [{ value: '__add_new__', label: '+ Add new type…' }]
                          : []),
                      ]}
                    />
                    {addingJobType !== null && (
                      <div className="flex gap-2">
                        <Input
                          autoFocus={canAutoFocus()}
                          value={addingJobType}
                          maxLength={50}
                          onChange={(e) => setAddingJobType(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitJobType(); }
                            // Escape closes just this row and puts the person back on the select that opened it.
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              e.stopPropagation();
                              setAddingJobType(null);
                              jobTypeField.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
                            }
                          }}
                          placeholder="New job type (press Enter or Add)"
                        />
                        <Button type="button" size="sm" onClick={commitJobType} disabled={!addingJobType.trim()}>Add</Button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Source</Label>
                    <SelectField
                      aria-label="Source"
                      value={form.watch('ad_source') || ''}
                      onValueChange={(v) => form.setValue('ad_source', v, { shouldDirty: true })}
                      placeholder="Select..."
                      options={
                        sourceOptions.length > 0
                          ? sourceOptions.map((s) => ({ value: s, label: s }))
                          : [{ value: '__none__', label: noOptions, disabled: true }]
                      }
                    />
                  </div>
                  {/* Owner and Dispatcher hold the creator rule's pre-fill: pickers with Assign people to leads, fixed text otherwise. */}
                  <PersonSlotField
                    label="Owner"
                    empty="No owner"
                    picker={mayNamePeople}
                    value={ownerId}
                    ready={!prefillPending}
                    onChange={(v) => form.setValue('assigned_to', v, { shouldDirty: true })}
                    roster={assignableOwners}
                    me={me}
                    loading={ownerRoster.isLoading}
                    failed={ownerRoster.isError && !ownerRoster.data}
                    onRetry={() => void ownerRoster.refetch()}
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

                <Separator />
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs font-semibold uppercase">Schedule walkthrough</p>
                  <Switch checked={showSchedule} onCheckedChange={setShowSchedule} aria-label="Schedule walkthrough" />
                </div>

                {showSchedule && <ScheduleFields form={form} />}
                {/* Who does it sits beside the time, not inside it, so performers can be saved without a time (the
                    walkthrough then shows as "To be scheduled"): a Performers picker for a person with Book
                    walkthroughs, the "I'll do this walkthrough" checkbox for anyone else who can be on a crew. */}
                {mayBookWalkthroughs && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="v2-lead-performers">Performers</Label>
                    <MultiAssigneeSelect
                      id="v2-lead-performers"
                      value={performerIds}
                      onChange={(ids) => { setPerformerIds(ids); resetClash(); }}
                      purpose="walkthroughPerformer"
                      placeholder="Add performer..."
                      knownPeople={actorKnownPeople}
                    />
                    {!showSchedule && (
                      <p className="text-muted-foreground text-xs">Without a time, the walkthrough shows as To be scheduled.</p>
                    )}
                  </div>
                )}
                {!mayBookWalkthroughs && prefill?.can_be_on_crew && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="v2-lead-do-it-myself"
                        checked={doItMyself}
                        onCheckedChange={(v) => { setDoItMyself(v === true); resetClash(); }}
                      />
                      <Label htmlFor="v2-lead-do-it-myself" className="cursor-pointer">I'll do this walkthrough</Label>
                    </div>
                    {!showSchedule && doItMyself && (
                      <p className="text-muted-foreground text-xs">Without a time, the walkthrough shows as To be scheduled.</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {clash && clash.when === scheduleKey(form.getValues()) && (
              <ScheduleClashNotice
                conflicts={clash.conflicts}
                timezone={timezone}
                message="A performer is already booked over this slot."
                pending={mutation.isPending}
                onScheduleAnyway={() => { forceWalkthrough.current = true; mutation.mutate({ data: clash.data }); }}
              />
            )}
            {inlineError && (
              <p className="text-destructive text-sm">{extractApiError(inlineError, 'Something went wrong')}</p>
            )}
            {/* Without the pre-fill the form cannot say who the lead will hold, so it does not save blind. */}
            {prefillFailed && (
              <p className="text-destructive text-sm">Couldn't load the Owner and Dispatcher. Reload the page to try again.</p>
            )}

            <Separator />
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={leave.leaveBack}>Cancel</Button>
              <Button type="submit" disabled={mutation.isPending || prefillFailed || ((mayNamePeople || !mayBookWalkthroughs) && prefillPending)}>
                {mutation.isPending ? 'Creating...' : 'Create Lead'}
              </Button>
            </div>
          </form>
      </div>
      {leave.leaveDialog}
    </div>
  );
}

/**
 * The four schedule controls, shared by both forms. Typed against the two form
 * shapes rather than generically: both carry the same four optional string
 * fields, and a generic would only obscure that.
 */
function ScheduleFields({
  form,
}: {
  form: ReturnType<typeof useForm<CreateFormData>> | ReturnType<typeof useForm<EditFormData>>;
}) {
  const f = form as ReturnType<typeof useForm<CreateFormData>>;
  return (
    <>
      {/* One column below sm: side by side, a 180 px date and a 140 px time do not fit a 320 px
          phone, so each takes the full width there and keeps its fixed width from sm up. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="v2-start-date">Start Date</Label>
          {/* watch/setValue rather than register(): the picker is a controlled
              value/onChange pair, not a native input RHF can ref. The form state
              is the same 'YYYY-MM-DD' string, exactly as for TimeField beside it. */}
          <DateField
            id="v2-start-date"
            value={f.watch('scheduled_date') || ''}
            onChange={(v) => f.setValue('scheduled_date', v, { shouldDirty: true })}
            className="w-full sm:w-[180px]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="v2-start-time">Start Time</Label>
          <TimeField
            id="v2-start-time"
            variant="select"
            className="w-full sm:w-[140px]"
            value={f.watch('scheduled_time') || ''}
            onChange={(v) => f.setValue('scheduled_time', v, { shouldDirty: true })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="v2-end-date">End Date</Label>
          <DateField
            id="v2-end-date"
            value={f.watch('scheduled_end_date') || ''}
            onChange={(v) => f.setValue('scheduled_end_date', v, { shouldDirty: true })}
            className="w-full sm:w-[180px]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="v2-end-time">End Time</Label>
          <TimeField
            id="v2-end-time"
            variant="select"
            className="w-full sm:w-[140px]"
            value={f.watch('scheduled_end_time') || ''}
            onChange={(v) => f.setValue('scheduled_end_time', v, { shouldDirty: true })}
          />
        </div>
      </div>
    </>
  );
}

function EditLeadForm({
  lead, leadId, navigate, queryClient,
}: {
  lead: Record<string, unknown>;
  leadId: string;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const noOptions = useNoOptionsLabel();
  const { data: org } = useOrganization();
  const ability = useAppAbility();
  const addJobType = useAddJobType();
  const [addingJobType, setAddingJobType] = useState<string | null>(null);
  const jobTypeField = useRef<HTMLDivElement>(null);
  const [showSchedule, setShowSchedule] = useState(Boolean(lead.scheduled_start || lead.scheduled_end));
  const [taxWarnOpen, setTaxWarnOpen] = useState(false);

  const customer = lead.customer as { service_locations?: ServiceLocation[] } | undefined;
  const customerLocations = customer?.service_locations ?? [];
  // Location freezes once any estimate exists (backend returns 400 otherwise).
  const hasEstimates = ((lead.estimates as unknown[] | undefined)?.length ?? 0) > 0;
  // What the server says this person may change on THIS lead. The lead's creator without Edit leads gets the plain
  // details only: the address, the source and the walkthrough times stay with whoever holds Edit leads, so those
  // controls are not shown and their fields are not sent.
  const actions = lead as { actions?: LeadAction[] };
  const mayEditAddress = leadOffers(actions, 'edit_address', true);
  const mayEditSource = leadOffers(actions, 'edit_source', true);
  const mayEditSchedule = leadOffers(actions, 'edit_schedule', true);
  const locationLocked = hasEstimates || !mayEditAddress;

  /*
   * The lead's location is its ANCHOR (`service_location`); the deprecated inline `service_*`
   * columns are a LEGACY FALLBACK for records that predate it. Reading the columns first got
   * this file three separate ways:
   *
   *   - `leadState` came from `service_state`, which the update path never writes. On any lead
   *     created since the anchor arrived that column is null, so EVERY pick counted as a state
   *     change and fired the tax warning "from — to NJ" on a move that changed no state at all.
   *     (69 of 208 leads on staging are that shape.)
   *   - the frozen (has-estimates) box below rendered those same columns, so those leads showed
   *     a locked address of "-" — the page hiding the very thing the lock is about.
   *
   * One derivation, anchor-first, feeds both.
   */
  const anchor = lead.service_location as ServiceLocation | null | undefined;
  const leadAddressLine1 = anchor?.address_line1 ?? (lead.service_address_line1 as string | null) ?? '';
  const leadAddressLine2 = anchor?.address_line2 ?? (lead.service_address_line2 as string | null) ?? '';
  const leadCity = anchor?.city ?? (lead.service_city as string | null) ?? '';
  const leadZip = anchor?.zip ?? (lead.service_zip as string | null) ?? '';
  // Compared and displayed upper-cased: a state is a code, and staging holds rows stored as
  // 'ny'. Without this a lowercase row reads as a change from itself, and the warning quotes
  // the raw column back at the reader ("from ny to FL").
  const leadState = (anchor?.state ?? (lead.service_state as string | null) ?? '').toUpperCase();

  /*
   * The lead's anchor IS the answer when it has one — no matching required. The address match
   * below is the legacy path, for a lead that carries only the deprecated columns.
   *
   * Anchor-last was the dangerous order. On a lead anchored with those columns null (79 of 208 on
   * staging), the match found nothing and fell through to the customer's PRIMARY location, so the
   * form opened pre-selecting an address the lead was not on — and "Save Changes" on an otherwise
   * untouched form would then re-point the lead to it. A silent move of the site the work is at,
   * triggered by opening a form and saving it.
   */
  const initialLocation = (anchor?.id && customerLocations.find((l) => l.id === anchor.id))
    || customerLocations.find(
      (l) => l.address_line1 === (lead.service_address_line1 as string) && l.zip === (lead.service_zip as string),
    )
    || customerLocations.find((l) => l.is_primary)
    || customerLocations[0];

  // The text the Notes box was filled with (#3104), captured ONCE, when this form mounts and fills the box. The save sends
  // the box only when it differs from this (Ran's build ruling 4): an untouched box leaves the general note as it is, even
  // if someone else changed or removed it meanwhile. The box is filled once too (useForm's defaultValues are read at
  // mount and nothing here resets the form), so a later refetch of the lead moves neither the box nor this baseline.
  // The page mounts this form only once the lead has loaded, and remounts it for another lead (keyed by id).
  const [loadedNotes] = useState(() => (lead.general_note as { content?: string } | null | undefined)?.content ?? '');

  const form = useForm<EditFormData>({
    resolver: zodResolver(mayEditAddress ? editLeadFormSchema : editLeadDetailsFormSchema),
    defaultValues: {
      service_request: lead.service_request as string,
      // The lead's general note (#3104): the box edits that note in place. Empty when the lead has none.
      notes: loadedNotes,
      job_type: (lead.job_type as string) || '',
      ad_source: ((lead.customer as { ad_source?: string | null })?.ad_source) || '',
      scheduled_date: extractDate(lead.scheduled_start as string | null),
      scheduled_time: extractTime(lead.scheduled_start as string | null),
      scheduled_end_date: extractDate(lead.scheduled_end as string | null),
      scheduled_end_time: extractTime(lead.scheduled_end as string | null),
      service_location_id: initialLocation?.id || '',
      service_address_line1: leadAddressLine1,
      service_address_line2: leadAddressLine2,
      service_city: leadCity,
      service_state: leadState,
      service_zip: leadZip,
    },
  });

  const commitJobType = () => {
    const trimmed = (addingJobType ?? '').trim();
    if (!trimmed) return;
    form.setValue('job_type', trimmed);
    const existing = org?.job_type_options ?? [];
    if (!existing.includes(trimmed)) {
      addJobType.mutate(trimmed);
    }
    setAddingJobType(null);
  };

  const serviceLocationId = form.watch('service_location_id');
  const newState = (form.watch('service_state') || '').toUpperCase();
  // A state change (and the location actually changed) triggers the tax warning.
  const isStateChange = !locationLocked && Boolean(newState) && newState !== leadState;

  const mutation = useMutation({
    mutationFn: async (data: EditFormData) => {
      const pickedExisting = data.service_location_id && data.service_location_id !== '__add_new__';
      const locationFields = locationLocked
        // Location is frozen, or not this person's to change - do not send any location-change inputs.
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
        ...((data.notes ?? '') !== loadedNotes ? { notes: data.notes || null } : {}),
        job_type: data.job_type || null,
        ...(mayEditSource ? { ad_source: data.ad_source || null } : {}),
        ...(mayEditSchedule
          ? {
              scheduled_start: showSchedule ? (combineDatetime(data.scheduled_date, data.scheduled_time) || null) : null,
              scheduled_end: showSchedule ? (combineDatetime(data.scheduled_end_date, data.scheduled_end_time) || null) : null,
            }
          : {}),
        ...locationFields,
      };
      const { data: res } = await api.patch(`/api/leads/${leadId}`, payload);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      // The Notes box edits the general note: the Notes tab and the Activity panel show the change.
      queryClient.invalidateQueries({ queryKey: ['notes', 'LEAD', leadId] });
      queryClient.invalidateQueries({ queryKey: ['timeline', 'LEAD', leadId] });
      navigate(v2Path(`/leads/${leadId}`));
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

  const jobTypeOptions = (() => {
    const base = org?.job_type_options ?? [];
    const current = form.watch('job_type');
    return current && !base.includes(current) ? [current, ...base] : base;
  })();
  const sourceOptions = (() => {
    const base = org?.source_options ?? [];
    const current = form.watch('ad_source');
    return current && !base.includes(current) ? [current, ...base] : base;
  })();

  return (
    <div>
      <PageHeader
        title="Edit Lead"
        back={<BackLink onClick={() => navigate(-1)} />}
      />

      {/* No Card around the form. The page canvas already frames this content,
          so a card here drew a second border a few pixels inside the first and
          the fields read as boxed-in. The form keeps the card's horizontal
          rhythm through px-1 and gets its separation from spacing instead. */}
      <div className="px-1 pt-2">
          <form noValidate onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-7">
            <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
              <div className="flex flex-col gap-5">
                <p className="text-muted-foreground text-xs font-semibold uppercase">Lead Details</p>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="v2-edit-service-request">Service Request *</Label>
                  <Textarea id="v2-edit-service-request" {...form.register('service_request')} rows={3} />
                  <TextLengthCounter length={(form.watch('service_request') ?? '').length} max={LONG_TEXT_MAX} />
                  {errors.service_request && <p className="text-destructive text-xs">{errors.service_request.message}</p>}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="v2-edit-notes">Notes</Label>
                  <Textarea id="v2-edit-notes" {...form.register('notes')} rows={2} placeholder="Internal notes..." />
                  <TextLengthCounter length={(form.watch('notes') ?? '').length} max={LONG_TEXT_MAX} />
                  {errors.notes && <p className="text-destructive text-xs">{errors.notes.message}</p>}
                </div>

                <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
                  <div ref={jobTypeField} className="flex flex-col gap-1.5">
                    <Label>Job Type</Label>
                    <SelectField
                      aria-label="Job Type"
                      value={form.watch('job_type') || ''}
                      onValueChange={(v) => {
                        if (v === '__add_new__') { setAddingJobType(''); return; }
                        form.setValue('job_type', v);
                      }}
                      placeholder="Select type..."
                      options={[
                        ...(jobTypeOptions.length > 0
                          ? jobTypeOptions.map((t) => ({ value: t, label: t }))
                          : [{
                            value: '__none__',
                            label: ability.can('update', 'Organization') ? 'No options - add below' : 'No options',
                            disabled: true,
                          }]),
                        ...(ability.can('update', 'Organization')
                          ? [{ value: '__add_new__', label: '+ Add new type…' }]
                          : []),
                      ]}
                    />
                    {addingJobType !== null && (
                      <div className="flex gap-2">
                        <Input
                          autoFocus={canAutoFocus()}
                          value={addingJobType}
                          maxLength={50}
                          onChange={(e) => setAddingJobType(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitJobType(); }
                            // Escape closes just this row and puts the person back on the select that opened it.
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              e.stopPropagation();
                              setAddingJobType(null);
                              jobTypeField.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
                            }
                          }}
                          placeholder="New job type (press Enter or Add)"
                        />
                        <Button type="button" size="sm" onClick={commitJobType} disabled={!addingJobType.trim()}>Add</Button>
                      </div>
                    )}
                  </div>
                  {mayEditSource && (
                    <div className="flex flex-col gap-1.5">
                      <Label>Source</Label>
                      <SelectField
                        aria-label="Source"
                        value={form.watch('ad_source') || ''}
                        onValueChange={(v) => form.setValue('ad_source', v)}
                        placeholder="Select source..."
                        options={
                          sourceOptions.length > 0
                            ? sourceOptions.map((s) => ({ value: s, label: s }))
                            : [{ value: '__none__', label: noOptions, disabled: true }]
                        }
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-5">
                <p className="text-muted-foreground text-xs font-semibold uppercase">Service Location</p>

                {locationLocked ? (
                  <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Lock className="text-muted-foreground size-3.5" />
                      {[leadAddressLine1, leadAddressLine2].filter(Boolean).join(', ') || '-'}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {[leadCity, leadState, leadZip].filter(Boolean).join(', ')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {hasEstimates
                        ? 'Locked - revise or duplicate the estimate to change the service location.'
                        : 'Locked - only people who can edit leads can change the service location.'}
                    </p>
                  </div>
                ) : (
                  <PickLocation
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
                        <p className="text-status-amber-emphasis text-xs">
                          Changing to {newState} will change the tax rate for new estimates.
                        </p>
                      ) : undefined
                    }
                  />
                )}

                {mayEditSchedule && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <p className="text-muted-foreground text-xs font-semibold uppercase">Schedule walkthrough</p>
                      <Switch checked={showSchedule} onCheckedChange={setShowSchedule} aria-label="Schedule walkthrough" />
                    </div>

                    {showSchedule && <ScheduleFields form={form} />}
                  </>
                )}
              </div>
            </div>

            {mutation.error && (
              <p className="text-destructive text-sm">{extractApiError(mutation.error, 'Something went wrong')}</p>
            )}

            <Separator />
            <div className="flex flex-wrap justify-end gap-3">
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
