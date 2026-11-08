import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useForm, useFieldArray, Controller, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Building2, Check, ChevronDown, Pencil, Plus, Search, Upload, X,
} from 'lucide-react';

import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError, formatPhoneInput } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
// The schema is IMPORTED, never restated. `customer-form-schema-optional-fields.test.ts`
// exercises every superRefine rule against this exact export, so a second copy
// here would let the v2 form and its own contract test disagree.
import { customerSchema } from '@/lib/customers/customerSchema';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';

import { BackLink } from '../_shared/backLink';
import { DatePicker } from '../_shared/datePicker';
import { v2Path, preferV2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { DuplicateCustomerDialog } from './components/duplicateCustomerDialog';

type CustomerFormData = z.infer<typeof customerSchema>;

/**
 * A customer write (name/email/phone) has to reach every OTHER query that embeds a copy of
 * that contact info, or the copy goes stale for the full 5-minute staleTime with nothing to
 * refetch it (refetchOnWindowFocus is off) - same class as #1718's job-visits gap, one entity
 * over. `jobListSelect`/`leadListSelect` both embed `customer.email` for the schedule board's
 * notify composer (SRVW-243), and `jobDetailSelect` embeds it for the job page - none of those
 * are keyed by customer id, so this invalidates by PREFIX rather than naming one job/lead.
 */
function invalidateEmbeddedCustomerCopies(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
  queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
  queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
  queryClient.invalidateQueries({ queryKey: ['job'] });
  queryClient.invalidateQueries({ queryKey: ['lead'] });
}

// --- Duplicate-customer guard helpers ---------------------------------------

/** Loose, comparison-only email normalize: trim + lowercase. */
const normalizeEmail = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Loose, comparison-only phone normalize: digits only, strip a leading US country code. */
function normalizePhone(v: string | null | undefined): string {
  let d = (v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

/** Narrow an axios error to the backend's 409 `duplicate` payload (or null). */
function getDuplicate(err: unknown): ExistingCustomer | null {
  const r = (
    err as { response?: { status?: number; data?: { error?: string; existing?: ExistingCustomer } } }
  )?.response;
  if (r?.status === 409 && r?.data?.error === 'duplicate' && r.data.existing) return r.data.existing;
  return null;
}

/** Compare the submitted email/phone against the existing record to drive the highlight. */
function computeMatchedFields(
  submitted: { email?: string | null; phone?: string | null },
  existing: ExistingCustomer,
): { email: boolean; phone: boolean } {
  // #1996 — a redacted match carries no `email`/`phone` to compare against; the backend's own
  // matched booleans are the only signal available.
  if (isRedactedMatch(existing)) {
    return { email: Boolean(existing.matched.email), phone: Boolean(existing.matched.phone) };
  }
  const subEmail = normalizeEmail(submitted.email);
  const subPhone = normalizePhone(submitted.phone);
  return {
    email: Boolean(subEmail) && subEmail === normalizeEmail(existing.email),
    phone: Boolean(subPhone) && subPhone === normalizePhone(existing.phone),
  };
}

/** Top-level customers eligible to be a billing-group parent (franchise). */
interface ParentCustomerOption {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  parent_id?: string | null;
}

// --- Small local building blocks --------------------------------------------

/** Label above control, message below. The kit's FormField needs a FormProvider
 *  and a per-field Controller; this form registers most fields directly, so the
 *  three-part row is assembled here instead. */
function Field({
  label, htmlFor, required, optional, hint, error, children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive ms-0.5" aria-hidden>*</span>}
        {optional && <span className="text-muted-foreground ms-1 font-normal">(optional)</span>}
      </Label>
      {hint && <p className="text-muted-foreground text-[12px] leading-normal">{hint}</p>}
      {children}
      {error && <p className="text-destructive text-[12px] font-medium">{error}</p>}
    </div>
  );
}

/** A radio row built from primitives - the kit ships no RadioGroup. */
function RadioRow({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={checked}
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="h-auto justify-start gap-2.5 px-0 font-normal"
    >
      <span className={checked ? 'border-brand grid size-4 place-items-center rounded-full border' : 'border-input grid size-4 place-items-center rounded-full border'}>
        {checked && <span className="bg-brand size-2 rounded-full" />}
      </span>
      <span className={checked ? 'font-medium' : undefined}>{label}</span>
    </Button>
  );
}

/**
 * /v2/customers/new and /v2/customers/:id/edit.
 *
 * One component, discriminated by `useParams().id`, exactly as the legacy page.
 * The schema, the edit-mode hydration rules, `buildPayload`, both mutations,
 * the duplicate-guard flow and the certificate upload are the legacy page's,
 * imported or copied verbatim. Two things are load-bearing and easy to lose:
 *
 *  - the form submits the FORMATTED phone string ("(555) 123-4567"); the
 *    backend normalises to digits and the UI re-masks on read. Sending digits
 *    would be a logic change.
 *  - billing-mirror detection compares line1/city/state/zip and NOT line2,
 *    because the backend's copy omits line2 (#438). Adding line2 to the
 *    comparison silently regresses that bug.
 *
 * The three `data-testid`s the e2e suite selects on are carried over verbatim:
 * `customer-form`, `customer-form-submit`, `customer-billing-group`.
 */
export default function CustomerFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isEdit = Boolean(id);
  useRecordVisit('clients', isEdit ? 'Edit Customer' : 'New Customer');
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'ADMIN';

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customer-form', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${id}`);
      return data.customer;
    },
    enabled: isEdit,
    staleTime: 0,
  });

  const { data: org } = useOrganization();

  // Dialer create-prefill: /customers/new?phone=+1XXXXXXXXXX seeds the phone
  // field (defaultValues are consumed on first mount only - read once).
  const phoneParam = new URLSearchParams(location.search).get('phone');

  const emptyDefaults: CustomerFormData = {
    segment: undefined,
    first_name: '',
    last_name: '',
    company_name: '',
    email: '',
    phone: !isEdit && phoneParam ? formatPhoneInput(normalizePhone(phoneParam)) : '',
    phone_ext: '',
    extra_emails: [],
    phones: [],
    ad_source: '',
    source: '',
    allow_billing: false,
    tax_exempt: false,
    account_type: 'individual',
    is_franchise: false,
    parent_id: '',
    billing_terms: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    zip: '',
    billing_same_as_service_location: true,
    billing_address_line1: '',
    billing_address_line2: '',
    billing_city: '',
    billing_state: '',
    billing_zip: '',
    notes: '',
    created_at: '',
  };

  // Derived from server data rather than pushed in by an effect - avoids the
  // timing hazard `reset()` in an effect has.
  const editValues = useMemo(() => {
    if (!customer) return undefined;
    const loc =
      customer.service_locations?.find((l: { is_primary: boolean }) => l.is_primary) ||
      customer.service_locations?.[0];
    const billingSet = Boolean(
      customer.billing_address_line1 || customer.billing_city || customer.billing_state || customer.billing_zip,
    );
    // Rows saved with "same as service" mirror the service address into
    // billing_* (buildPayload + the backend's applyBillingCopy). Compare only
    // line1/city/state/zip - NOT line2 - because the backend copy omits line2,
    // so mirrored rows would never match if line2 were compared.
    const billingMirrorsService =
      billingSet &&
      (customer.billing_address_line1 || '') === (loc?.address_line1 || '') &&
      (customer.billing_city || '') === (loc?.city || '') &&
      (customer.billing_state || '') === (loc?.state || '') &&
      (customer.billing_zip || '') === (loc?.zip || '');
    const hasDifferentBilling = billingSet && !billingMirrorsService;
    return {
      segment: (customer.segment as 'RESIDENTIAL' | 'COMMERCIAL' | undefined) || undefined,
      first_name: customer.first_name || '',
      last_name: customer.last_name || '',
      company_name: customer.company_name || '',
      email: customer.email || '',
      phone: formatPhoneInput(customer.phone || ''),
      phone_ext: customer.phone_ext || '',
      extra_emails:
        customer.extra_emails?.map((e: { email: string; label?: string | null }) => ({
          email: e.email,
          label: e.label || '',
        })) || [],
      phones:
        customer.phones?.map(
          (p: { phone: string; label?: string | null; extension?: string | null; is_primary?: boolean }) => ({
            phone: formatPhoneInput(p.phone || ''),
            label: p.label || '',
            extension: p.extension || '',
            is_primary: p.is_primary ?? false,
          }),
        ) || [],
      ad_source: customer.ad_source || '',
      source: customer.source ?? customer.ad_source ?? '',
      allow_billing: customer.allow_billing ?? false,
      tax_exempt: customer.tax_exempt ?? false,
      // parent_id set -> "Under a Franchise"; otherwise individual, with the
      // "this is a franchise" checkbox reflecting is_parent.
      account_type: (customer.parent_id ? 'under' : 'individual') as 'individual' | 'under',
      is_franchise: customer.parent_id ? false : Boolean(customer.is_parent),
      parent_id: customer.parent_id || '',
      billing_terms: customer.billing_terms || '',
      address_line1: loc?.address_line1 || '',
      address_line2: loc?.address_line2 || '',
      city: loc?.city || '',
      state: loc?.state || '',
      zip: loc?.zip || '',
      billing_same_as_service_location: !hasDifferentBilling,
      // #438: revealing the billing box must open BLANK, never pre-filled with
      // the service address.
      billing_address_line1: hasDifferentBilling ? customer.billing_address_line1 || '' : '',
      billing_address_line2: hasDifferentBilling ? customer.billing_address_line2 || '' : '',
      billing_city: hasDifferentBilling ? customer.billing_city || '' : '',
      billing_state: hasDifferentBilling ? customer.billing_state || '' : '',
      billing_zip: hasDifferentBilling ? customer.billing_zip || '' : '',
      notes: customer.notes || '',
      created_at: customer?.created_at ? customer.created_at.slice(0, 10) : '',
    };
  }, [customer]);

  const form = useForm<CustomerFormData>({
    // account_type's z.enum().default() gives the schema a narrower input type
    // than its output type, which hookform-resolvers v5's tightened generics no
    // longer match against CustomerFormData directly - cast to the resolver
    // shape useForm actually needs; runtime behavior is unchanged. Same cast the
    // legacy CustomerFormPage carries.
    resolver: zodResolver(customerSchema) as Resolver<CustomerFormData>,
    defaultValues: emptyDefaults,
    // `values`, not `reset`: server data wins on every refetch.
    values: editValues,
    mode: 'onTouched',
  });

  const {
    fields: emailFields, append: appendEmail, remove: removeEmail,
  } = useFieldArray({ control: form.control, name: 'extra_emails' });

  const {
    fields: phoneFields, append: appendPhone, remove: removePhone,
  } = useFieldArray({ control: form.control, name: 'phones' });

  const accountType = form.watch('account_type');
  const isFranchise = form.watch('is_franchise');
  const parentId = form.watch('parent_id');
  const billingSame = form.watch('billing_same_as_service_location');
  const taxExempt = form.watch('tax_exempt');
  const allowBilling = form.watch('allow_billing');
  const segment = form.watch('segment');

  const [moreOpen, setMoreOpen] = useState(false);
  const [franchiseQuery, setFranchiseQuery] = useState('');
  const [debouncedFranchiseQuery, setDebouncedFranchiseQuery] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const certInputRef = useRef<HTMLInputElement | null>(null);

  // Duplicate-customer guard: the existing record from a 409, the form data to
  // resubmit with override, and which field(s) collided.
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CustomerFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({
    email: false, phone: false,
  });

  // 250 ms so the server-side query does not fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFranchiseQuery(franchiseQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [franchiseQuery]);

  // Top-level customers - candidates for the franchise/parent picker. Only
  // enabled while "Under a Franchise" is selected. limit:100 matches the
  // backend cap; the `search` term narrows server-side instead.
  const { data: parentCandidates = [] } = useQuery<ParentCustomerOption[]>({
    queryKey: ['customers-parent-candidates', debouncedFranchiseQuery],
    queryFn: async () => {
      const { data } = await api.get('/api/customers', {
        params: { is_parent: true, search: debouncedFranchiseQuery || undefined, limit: 100 },
      });
      return data.customers as ParentCustomerOption[];
    },
    enabled: accountType === 'under',
  });

  // The persisted parent (edit mode), fetched by id so the pill shows the real
  // name even when the parent is not in the search-filtered candidate list.
  const { data: persistedParent } = useQuery<ParentCustomerOption | null>({
    queryKey: ['customer-parent', parentId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${parentId}`);
      return (data.customer as ParentCustomerOption) ?? null;
    },
    enabled: isEdit && Boolean(parentId),
  });

  // Eligible parents = top-level customers, excluding self (edit mode).
  const parentOptions = useMemo(
    () => parentCandidates.filter((c) => !c.parent_id && c.id !== id),
    [parentCandidates, id],
  );

  const pickedParent = useMemo(() => {
    if (!parentId) return null;
    const match = parentCandidates.find((c) => c.id === parentId);
    const resolved = match ?? (persistedParent?.id === parentId ? persistedParent : null);
    return { id: parentId, label: resolved ? customerDisplayName(resolved) : 'Selected franchise' };
  }, [parentId, parentCandidates, persistedParent]);

  const primaryLocation =
    customer?.service_locations?.find((l: { is_primary: boolean }) => l.is_primary) ||
    customer?.service_locations?.[0];

  const franchiseMatches = useMemo(() => {
    const q = franchiseQuery.trim().toLowerCase();
    if (!q) return [];
    return parentOptions.filter((c) => customerDisplayName(c).toLowerCase().includes(q));
  }, [franchiseQuery, parentOptions]);

  const uploadCert = async (customerId: string) => {
    if (!certFile) return;
    const fd = new FormData();
    fd.append('file', certFile);
    fd.append('display_name', 'Tax Exempt Certificate');
    fd.append('description', 'Tax exempt certificate');
    await api.post(`/api/attachments/customer/${customerId}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const buildPayload = (data: CustomerFormData, adminOverride?: boolean) => {
    const {
      address_line1, address_line2, city, state, zip, extra_emails, phones,
      // UI-only fields - resolved/renamed before sending to the backend.
      account_type, is_franchise, parent_id, billing_same_as_service_location,
      created_at,
      ...rest
    } = data;

    const hasLocation = Boolean(address_line1 && city && state && zip);

    let resolvedParentId: string | null = null;
    let billToCustomerId: string | null = null;
    let isParent = false;
    if (account_type === 'under' && parent_id?.trim()) {
      resolvedParentId = parent_id;
      billToCustomerId = parent_id; // bill to the franchise
    } else if (account_type === 'individual' && is_franchise) {
      isParent = true;
    }

    const billingAddress = billing_same_as_service_location
      ? {
          billing_address_line1: hasLocation ? address_line1 : null,
          billing_address_line2: hasLocation ? address_line2 || null : null,
          billing_city: hasLocation ? city : null,
          billing_state: hasLocation ? state : null,
          billing_zip: hasLocation ? zip : null,
        }
      : {
          billing_address_line1: rest.billing_address_line1 || null,
          billing_address_line2: rest.billing_address_line2 || null,
          billing_city: rest.billing_city || null,
          billing_state: rest.billing_state || null,
          billing_zip: rest.billing_zip || null,
        };

    const payload: Record<string, unknown> = {
      segment: rest.segment || 'RESIDENTIAL',
      first_name: rest.first_name?.trim() || null,
      last_name: rest.last_name?.trim() || null,
      company_name: rest.company_name?.trim() || null,
      email: rest.email?.trim() || null,
      phone: rest.phone, // formatted string - the backend normalises
      phone_ext: rest.phone_ext || null,
      ad_source: rest.source || null,
      source: rest.source || null,
      allow_billing: rest.allow_billing ?? false,
      tax_exempt: rest.tax_exempt ?? false,
      billing_terms: rest.billing_terms || null,
      notes: rest.notes?.trim() || null,
      is_parent: isParent,
      parent_id: resolvedParentId,
      bill_to_customer_id: billToCustomerId,
      ...billingAddress,
      extra_emails: (extra_emails || [])
        .filter((e) => (e.email || '').trim())
        .map((e) => ({ email: (e.email as string).trim(), label: e.label || undefined })),
      phones: (phones || [])
        .filter((p) => (p.phone || '').trim())
        .map((p) => ({
          phone: p.phone as string,
          label: p.label || undefined,
          extension: p.extension || undefined,
          is_primary: p.is_primary ?? false,
        })),
      ...(adminOverride && created_at ? { created_at } : {}),
    };

    return { payload, hasLocation, address_line1, address_line2, city, state, zip };
  };

  /** Create or edit -> the customer id. `override` bypasses the duplicate guard. */
  const save = async (data: CustomerFormData, override = false): Promise<string> => {
    const { payload, hasLocation, address_line1, address_line2, city, state, zip } =
      buildPayload(data, isAdmin);

    if (isEdit && id) {
      const { data: res } = await api.patch(`/api/customers/${id}`, payload);
      if (hasLocation) {
        const locData = { address_line1, address_line2: address_line2 || undefined, city, state, zip };
        if (primaryLocation) {
          await api.patch(`/api/customers/${id}/locations/${primaryLocation.id}`, locData);
        } else {
          await api.post(`/api/customers/${id}/locations`, { ...locData, is_primary: true });
        }
      }
      return res.customer?.id ?? id;
    }

    const createPayload = {
      ...payload,
      ...(hasLocation
        ? { locations: [{ address_line1, address_line2: address_line2 || undefined, city, state, zip, is_primary: true }] }
        : {}),
    };
    const { data: res } = await api.post(
      override ? '/api/customers?override=true' : '/api/customers',
      createPayload,
    );
    return res.customer?.id as string;
  };

  // The cert upload is DECOUPLED from the save: a failed upload must not reject
  // the mutation (the customer is already saved), so it is swallowed here and
  // surfaced as its own toast.
  const saveThenUploadCert = async (data: CustomerFormData, override = false): Promise<string> => {
    const customerId = await save(data, override);
    try {
      await uploadCert(customerId);
    } catch {
      toast.error('Certificate upload failed', {
        description: 'Customer saved, but the certificate upload failed - you can upload it later.',
      });
    }
    return customerId;
  };

  /** Route a 409 `duplicate` to the dialog instead of the inline error block. */
  const handleSubmitError = (err: unknown, data: CustomerFormData) => {
    const dup = getDuplicate(err);
    if (dup) {
      setDupExisting(dup);
      setPendingData(data);
      setDupMatched(computeMatchedFields(data, dup));
    }
  };

  const clearDupState = () => {
    setDupExisting(null);
    setPendingData(null);
    setDupMatched({ email: false, phone: false });
  };

  const submitMutation = useMutation({
    mutationFn: ({ data, override }: { data: CustomerFormData; override?: boolean }) =>
      saveThenUploadCert(data, override),
    onSuccess: (customerId) => {
      clearDupState();
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      invalidateEmbeddedCustomerCopies(queryClient);
      if (isEdit && id) {
        queryClient.invalidateQueries({ queryKey: ['customer', id] });
        navigate(v2Path(`/customers/${id}`));
      } else if (returnTo && customerId) {
        navigate(`${returnTo}?newCustomerId=${customerId}`, { replace: true });
      } else {
        navigate(v2Path(`/customers/${customerId || ''}`));
      }
    },
    onError: (err, { data }) => handleSubmitError(err, data),
  });

  const saveAndLeadMutation = useMutation({
    mutationFn: ({ data, override }: { data: CustomerFormData; override?: boolean }) =>
      saveThenUploadCert(data, override),
    onSuccess: (customerId) => {
      clearDupState();
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      invalidateEmbeddedCustomerCopies(queryClient);
      if (isEdit && id) queryClient.invalidateQueries({ queryKey: ['customer', id] });
      navigate(preferV2Path(`/leads/new?customer_id=${customerId}`));
    },
    onError: (err, { data }) => handleSubmitError(err, data),
  });

  const pending = submitMutation.isPending || saveAndLeadMutation.isPending;
  const rawMutationError = submitMutation.error || saveAndLeadMutation.error;
  // The duplicate case is handled by the dialog - do not also surface the raw
  // "duplicate" string inline.
  const mutationError = getDuplicate(rawMutationError) ? null : rawMutationError;
  const errors = form.formState.errors;

  /** Which create path opened the dialog, so "Create anyway" replays that one. */
  const dupSource = useRef<'submit' | 'lead'>('submit');

  const onSubmitForm = form.handleSubmit((d) => {
    dupSource.current = 'submit';
    submitMutation.mutate({ data: d });
  });
  const onSaveAndLead = form.handleSubmit((d) => {
    dupSource.current = 'lead';
    saveAndLeadMutation.mutate({ data: d });
  });

  const handleCreateAnyway = () => {
    if (!pendingData) return;
    if (dupSource.current === 'lead') {
      saveAndLeadMutation.mutate({ data: pendingData, override: true });
    } else {
      submitMutation.mutate({ data: pendingData, override: true });
    }
  };

  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    // setFocus works for the registered email input; for the Controller-wrapped
    // phone we fall back to the element id.
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  const handleOpenExisting = () => {
    if (!dupExisting) return;
    const target = dupExisting.id;
    setDupExisting(null);
    navigate(v2Path(`/customers/${target}`));
  };

  const isOverriding =
    (submitMutation.isPending || saveAndLeadMutation.isPending) && Boolean(pendingData);

  if (isEdit && isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const sourceOptions = org?.source_options ?? [];
  const billingTermsOptions = org?.billing_terms_options ?? [];
  const currentSource = form.watch('source');
  const resolvedSourceOptions =
    currentSource && !sourceOptions.includes(currentSource) ? [currentSource, ...sourceOptions] : sourceOptions;
  const currentTerms = form.watch('billing_terms');
  const resolvedTermsOptions =
    currentTerms && !billingTermsOptions.includes(currentTerms) ? [currentTerms, ...billingTermsOptions] : billingTermsOptions;

  return (
    <div>
      <PageHeader
        title={isEdit ? 'Edit Customer' : 'New Customer'}
        back={<BackLink onClick={() => navigate(-1)} />}
      />

      <form id="customer-form" data-testid="customer-form" onSubmit={onSubmitForm}>
        {/* No Card around the form, matching LeadFormPage and
            StandaloneInvoiceFormPage: the page canvas already frames this
            content, so a card here drew a second border a few pixels inside the
            first and the fields read as boxed-in. The form keeps the card's
            horizontal rhythm through px-1 and gets its separation from spacing
            instead. */}
        <div className="px-1 pt-2">
          {/* items-start keeps the two columns independent: growth on the left
              never moves the right. */}
          <div className="grid grid-cols-1 items-start gap-x-10 gap-y-4 lg:grid-cols-2">
            {/* LEFT - contact */}
            <div className="flex flex-col gap-4">
              <p role="heading" aria-level={2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Contact
              </p>

              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-[12px]">Enter a first name or a company name below.</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="First Name" htmlFor="first_name" error={errors.first_name?.message}>
                    <Input id="first_name" placeholder="Jane" aria-invalid={!!errors.first_name} {...form.register('first_name')} />
                  </Field>
                  <Field label="Last Name" htmlFor="last_name" optional error={errors.last_name?.message}>
                    <Input id="last_name" placeholder="Alvarez" {...form.register('last_name')} />
                  </Field>
                </div>
                <Field label="Company" htmlFor="company_name" error={errors.company_name?.message}>
                  <Input id="company_name" placeholder="Acme Restaurant Group" aria-invalid={!!errors.company_name} {...form.register('company_name')} />
                </Field>
              </div>

              {/* Phone - live-formatted, validated on blur */}
              <div className="flex flex-col gap-2">
                <Label htmlFor="phone">Phone</Label>
                <p className="text-muted-foreground text-[12px]">Provide a phone number or an email below.</p>
                <div>
                  <div className="flex items-center gap-2">
                    <Controller
                      control={form.control}
                      name="phone"
                      render={({ field }) => (
                        <Input
                          id="phone"
                          className="w-44"
                          aria-invalid={!!errors.phone}
                          inputMode="tel"
                          placeholder="(555) 123-4567"
                          value={field.value || ''}
                          onChange={(e) => field.onChange(formatPhoneInput(e.target.value))}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                    <Input className="w-20" placeholder="Ext" inputMode="numeric" {...form.register('phone_ext')} />
                    <span className="w-8 shrink-0" aria-hidden />
                  </div>
                  {errors.phone && <p className="text-destructive mt-1 text-[12px] font-medium">{errors.phone.message}</p>}
                </div>

                {phoneFields.map((field, index) => (
                  <div key={field.id}>
                    <div className="flex items-center gap-2">
                      <Controller
                        control={form.control}
                        name={`phones.${index}.phone`}
                        render={({ field: f }) => (
                          <Input
                            className="w-44"
                            aria-invalid={!!errors.phones?.[index]?.phone}
                            inputMode="tel"
                            placeholder="Additional phone"
                            value={f.value || ''}
                            onChange={(e) => f.onChange(formatPhoneInput(e.target.value))}
                            onBlur={f.onBlur}
                          />
                        )}
                      />
                      <Input className="w-20" placeholder="Ext" inputMode="numeric" {...form.register(`phones.${index}.extension`)} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove phone"
                        onClick={() => removePhone(index)}
                      >
                        <X />
                      </Button>
                    </div>
                    {errors.phones?.[index]?.phone && (
                      <p className="text-destructive mt-1 text-[12px] font-medium">
                        {errors.phones[index]?.phone?.message}
                      </p>
                    )}
                  </div>
                ))}

                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto self-start px-0"
                  onClick={() => appendPhone({ phone: '', label: '', extension: '', is_primary: false })}
                >
                  <Plus />
                  Add Phone
                </Button>
              </div>

              {/* Email - optional; validated on blur when provided */}
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <div>
                  <div className="flex items-center gap-2">
                    <Input
                      id="email"
                      className="flex-1"
                      aria-invalid={!!errors.email}
                      type="email"
                      placeholder="jane@example.com"
                      {...form.register('email')}
                    />
                    <span className="w-8 shrink-0" aria-hidden />
                  </div>
                  {errors.email && <p className="text-destructive mt-1 text-[12px] font-medium">{errors.email.message}</p>}
                </div>

                {emailFields.map((field, index) => (
                  <div key={field.id}>
                    <div className="flex items-center gap-2">
                      <Input
                        className="flex-1"
                        aria-invalid={!!errors.extra_emails?.[index]?.email}
                        type="email"
                        placeholder="Additional email"
                        {...form.register(`extra_emails.${index}.email`)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove email"
                        onClick={() => removeEmail(index)}
                      >
                        <X />
                      </Button>
                    </div>
                    {errors.extra_emails?.[index]?.email && (
                      <p className="text-destructive mt-1 text-[12px] font-medium">
                        {errors.extra_emails[index]?.email?.message}
                      </p>
                    )}
                  </div>
                ))}

                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto self-start px-0"
                  onClick={() => appendEmail({ email: '', label: '' })}
                >
                  <Plus />
                  Add Email
                </Button>
              </div>

              {/* Source - one control writes BOTH `source` and legacy `ad_source`. */}
              <Field label="How Did They Hear About Us?" htmlFor="source" error={errors.source?.message}>
                <SelectField
                  id="source"
                  value={currentSource || '__none__'}
                  onValueChange={(val) => {
                    const next = val === '__none__' ? '' : val;
                    form.setValue('source', next, { shouldValidate: true });
                    form.setValue('ad_source', next);
                  }}
                  invalid={!!errors.source}
                  placeholder="Select source"
                  options={
                    resolvedSourceOptions.length > 0
                      ? resolvedSourceOptions.map((s) => ({ value: s, label: s }))
                      : [{ value: '__none__', label: 'No options - add some in Settings', disabled: true }]
                  }
                />
              </Field>

              {isEdit && isAdmin && (
                <Field label="Customer Since" htmlFor="created_at">
                  {/* watch/setValue rather than register(): the picker is a
                      controlled value/onChange pair, not a native input RHF can
                      attach a ref to. Same 'YYYY-MM-DD' string in the form
                      state either way, so the payload is untouched. */}
                  <DatePicker
                    id="created_at"
                    max={new Date().toISOString().slice(0, 10)}
                    value={form.watch('created_at') || ''}
                    onChange={(v) => form.setValue('created_at', v, { shouldDirty: true })}
                  />
                </Field>
              )}
            </div>

            {/* RIGHT - service address, then Notes */}
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <p role="heading" aria-level={2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  Service Address
                </p>
                <p className="text-muted-foreground text-[12px]">
                  Optional - add it if you have one; you can add it later.
                </p>
                <AddressAutocomplete
                  id="address_line1"
                  placeholder="Start typing an address..."
                  value={form.watch('address_line1') || ''}
                  onChange={(val) => form.setValue('address_line1', val)}
                  onSelect={(place) => {
                    form.setValue('address_line1', place.address_line1);
                    form.setValue('address_line2', place.address_line2 || '');
                    form.setValue('city', place.city);
                    form.setValue('state', place.state);
                    form.setValue('zip', place.zip);
                  }}
                />
                {errors.address_line1 && (
                  <p className="text-destructive text-[12px] font-medium">{errors.address_line1.message}</p>
                )}
                <div className="grid grid-cols-6 gap-3">
                  <Input className="col-span-3" aria-invalid={!!errors.city} placeholder="City" {...form.register('city')} />
                  <Input className="col-span-1" aria-invalid={!!errors.state} placeholder="State" maxLength={2} {...form.register('state')} />
                  <Input className="col-span-2" aria-invalid={!!errors.zip} placeholder="ZIP" {...form.register('zip')} />
                </div>
                {(errors.city || errors.state || errors.zip) && (
                  <p className="text-destructive text-[12px] font-medium">
                    {errors.city?.message || errors.state?.message || errors.zip?.message}
                  </p>
                )}

                <ServiceLocationMap
                  addressLine1={form.watch('address_line1')}
                  city={form.watch('city')}
                  state={form.watch('state')}
                  zip={form.watch('zip')}
                />

                {/* Inverted billing - default same as service location */}
                {billingSame ? (
                  <div className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm">
                    <Check className="text-status-green size-4 shrink-0" />
                    <span className="text-muted-foreground">Billing address is the same as the service address</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="ms-auto h-auto px-0"
                      onClick={() => {
                        // Revealing the box must open it BLANK (#438).
                        form.setValue('billing_address_line1', '');
                        form.setValue('billing_address_line2', '');
                        form.setValue('billing_city', '');
                        form.setValue('billing_state', '');
                        form.setValue('billing_zip', '');
                        form.setValue('billing_same_as_service_location', false);
                      }}
                    >
                      <Pencil />
                      Use a different billing address
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Billing Address</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => form.setValue('billing_same_as_service_location', true)}
                      >
                        <Check />
                        Same as service address
                      </Button>
                    </div>
                    <AddressAutocomplete
                      id="billing_address_line1"
                      placeholder="Start typing an address..."
                      value={form.watch('billing_address_line1') || ''}
                      onChange={(val) => form.setValue('billing_address_line1', val)}
                      onSelect={(place) => {
                        form.setValue('billing_address_line1', place.address_line1);
                        form.setValue('billing_address_line2', place.address_line2 || '');
                        form.setValue('billing_city', place.city);
                        form.setValue('billing_state', place.state);
                        form.setValue('billing_zip', place.zip);
                      }}
                    />
                    <div className="grid grid-cols-6 gap-3">
                      <Input className="col-span-3" placeholder="City" {...form.register('billing_city')} />
                      <Input className="col-span-1" placeholder="State" maxLength={2} {...form.register('billing_state')} />
                      <Input className="col-span-2" placeholder="ZIP" {...form.register('billing_zip')} />
                    </div>
                  </div>
                )}
              </div>

              <Field label="Notes" htmlFor="notes">
                <Textarea id="notes" className="resize-none" rows={6} placeholder="Internal notes..." {...form.register('notes')} />
              </Field>
            </div>
          </div>

          {/* More Details - holds the billing-group / franchise config.
              `customer-billing-group` is the e2e anchor. */}
          <div data-testid="customer-billing-group" className="mt-6 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-0"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
            >
              <ChevronDown className={moreOpen ? 'rotate-180 transition' : 'transition'} />
              More Details (optional)
            </Button>

            {moreOpen && (
              <div className="mt-4 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
                {/* Card 1 - Home/Business + Account Type */}
                <div className="flex h-full flex-col gap-3 rounded-lg border p-4">
                  <Field label="Home or Business?" htmlFor="segment" optional>
                    <SelectField
                      id="segment"
                      value={segment || '__none__'}
                      onValueChange={(val) =>
                        form.setValue('segment', val === '__none__' ? undefined : (val as 'RESIDENTIAL' | 'COMMERCIAL'))
                      }
                      placeholder="Select"
                      options={[
                        { value: 'RESIDENTIAL', label: 'Home (residential)' },
                        { value: 'COMMERCIAL', label: 'Business (commercial)' },
                      ]}
                    />
                  </Field>

                  <div className="flex flex-col gap-3 border-t pt-3">
                    <span className="text-sm font-medium">Account Type</span>
                    <div role="radiogroup" className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <RadioRow
                          checked={accountType === 'individual'}
                          onClick={() => form.setValue('account_type', 'individual')}
                          label="Individual Account"
                        />
                        {/* inline-flex + gap: the Label is a plain inline box,
                            so the checkbox and its wording sat one typed space
                            apart and read as a single glued word. */}
                        <Label
                          htmlFor="is_franchise"
                          className={
                            accountType !== 'individual'
                              ? 'inline-flex shrink-0 items-center gap-2 text-xs font-normal opacity-40'
                              : 'inline-flex shrink-0 items-center gap-2 text-xs font-normal'
                          }
                        >
                          <Checkbox
                            id="is_franchise"
                            checked={accountType === 'individual' && Boolean(isFranchise)}
                            disabled={accountType !== 'individual'}
                            onCheckedChange={(v) => form.setValue('is_franchise', v === true)}
                          />
                          This is a franchise
                        </Label>
                      </div>
                      <RadioRow
                        checked={accountType === 'under'}
                        onClick={() => {
                          form.setValue('account_type', 'under');
                          form.setValue('is_franchise', false);
                        }}
                        label="Under a Franchise"
                      />
                    </div>

                    {/* Reserved slot so picking an account type does not resize the card. */}
                    <div className="min-h-[64px] ps-[26px]">
                      {accountType === 'under' && (
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="franchise-search">
                            Franchise
                            <span className="text-muted-foreground ms-1 font-normal">(optional)</span>
                          </Label>
                          {pickedParent ? (
                            <div className="bg-muted flex items-center gap-2 rounded-lg border px-3 py-2">
                              <Building2 className="text-muted-foreground size-4" />
                              <span className="text-sm">{pickedParent.label}</span>
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="ms-auto h-auto px-0"
                                onClick={() => {
                                  form.setValue('parent_id', '');
                                  setFranchiseQuery('');
                                }}
                              >
                                Change
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2">
                              <Input
                                id="franchise-search"
                                startIcon={<Search />}
                                value={franchiseQuery}
                                onChange={(e) => setFranchiseQuery(e.target.value)}
                                placeholder="Search by name..."
                              />
                              {franchiseQuery && (
                                <div className="overflow-hidden rounded-lg border">
                                  {franchiseMatches.map((m) => (
                                    <Button
                                      key={m.id}
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="w-full justify-start rounded-none font-normal"
                                      onClick={() => {
                                        form.setValue('parent_id', m.id);
                                        setFranchiseQuery('');
                                      }}
                                    >
                                      <Building2 />
                                      {customerDisplayName(m)}
                                    </Button>
                                  ))}
                                  {franchiseMatches.length === 0 && (
                                    <p className="text-muted-foreground px-3 py-2 text-sm">
                                      No matching accounts found.
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Card 2 - Allow Billing + Tax Exempt */}
                <div className="flex h-full flex-col rounded-lg border p-4">
                  <div className="pb-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="allow_billing" className="text-sm font-medium">Allow Billing</Label>
                      <Switch
                        id="allow_billing"
                        checked={Boolean(allowBilling)}
                        onCheckedChange={(checked) => form.setValue('allow_billing', checked)}
                      />
                    </div>
                    {/* Reserved height so toggling does not jump the card. */}
                    <div className="mt-3 min-h-[84px]">
                      {allowBilling && (
                        <Field label="Billing Terms" htmlFor="billing_terms" optional>
                          <SelectField
                            id="billing_terms"
                            value={currentTerms || '__none__'}
                            onValueChange={(val) => form.setValue('billing_terms', val === '__none__' ? '' : val)}
                            placeholder="Select terms"
                            options={
                              resolvedTermsOptions.length > 0
                                ? resolvedTermsOptions.map((t) => ({ value: t, label: t }))
                                : [{ value: '__none__', label: 'No options - add some in Settings', disabled: true }]
                            }
                          />
                        </Field>
                      )}
                    </div>
                  </div>

                  <div className="border-t pt-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="tax_exempt" className="text-sm font-medium">Tax Exempt</Label>
                      <Switch
                        id="tax_exempt"
                        checked={Boolean(taxExempt)}
                        onCheckedChange={(checked) => form.setValue('tax_exempt', checked)}
                      />
                    </div>
                    <div className="mt-3 min-h-[44px]">
                      {taxExempt && (
                        <div className="flex items-center gap-3">
                          <Button type="button" variant="outline" size="sm" onClick={() => certInputRef.current?.click()}>
                            <Upload />
                            Upload Certificate
                          </Button>
                          <span className="text-muted-foreground text-xs">
                            {certFile ? certFile.name : 'PDF or image'}
                          </span>
                          {/* The kit Input rather than a raw <input>: the
                              raw-tag ratchet sits at its floor for `input`, so
                              a v2 page may not add one. Hidden and driven by
                              the button above; the value is cleared after each
                              pick so re-choosing the same file still fires. */}
                          <Input
                            ref={certInputRef}
                            type="file"
                            accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
                            className="hidden"
                            aria-hidden
                            tabIndex={-1}
                            onChange={(e) => {
                              const f = e.target.files?.[0] ?? null;
                              setCertFile(f);
                              e.target.value = '';
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {mutationError && (
            <div className="text-destructive mt-4 text-sm">
              <p>{extractApiError(mutationError, 'Something went wrong')}</p>
              {(() => {
                const details = (
                  mutationError as { response?: { data?: { details?: { field: string; message: string }[] } } }
                )?.response?.data?.details;
                if (!details?.length) return null;
                return (
                  <ul className="mt-1 list-disc ps-4 text-xs">
                    {details.map((d, i) => (
                      <li key={i}>
                        <span className="font-medium">{d.field}</span>: {d.message}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          )}

          {/* Footer. The legacy page pins this to the viewport bottom; in the v2
              shell the page scrolls as one column, so the actions close the form
              they act on instead of floating over it. */}
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t pt-4">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onSaveAndLead}>
              Save &amp; Create Lead
            </Button>
            <Button type="submit" data-testid="customer-form-submit" disabled={pending}>
              {pending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Customer'}
            </Button>
          </div>
        </div>
      </form>

      <DuplicateCustomerDialog
        open={Boolean(dupExisting)}
        existing={dupExisting}
        matchedFields={dupMatched}
        onOpenExisting={handleOpenExisting}
        onEditField={handleEditField}
        onCreateAnyway={handleCreateAnyway}
        onClose={() => setDupExisting(null)}
        isOverriding={isOverriding}
      />
    </div>
  );
}
