import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useForm, useFieldArray, Controller, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { useAuthStore } from '@/stores/auth.store';
import { cn, extractApiError, formatPhoneInput } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
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
import { toast } from '@/components/ui/use-toast';
import { customerDisplayName } from '@/lib/customer-name';
import {
  DuplicateCustomerDialog,
  isRedactedMatch,
  type ExistingCustomer,
} from '@/components/customers/DuplicateCustomerDialog';
import { todayLocalDay } from '@/lib/format-date';
import {
  ArrowLeft,
  Plus,
  X,
  Check,
  Pencil,
  Upload,
  Building2,
  ChevronDown,
  Search,
} from 'lucide-react';
import { DatePicker } from '@/components/form/DatePicker';

// ─── Shared helpers ported from the locked A2 prototype ──────────────

// The live phone input mask moved to the shared formatPhoneInput in @/lib/utils (#352).


// Both State inputs are one narrow grid column, sized for a 2-letter code. Imported rows
// hold a full state name, and the field can only show a fragment of it ("sey"), so the
// message has to carry the value it actually found.
const STATE_CODE_MSG = 'Use the 2-letter state code';
const stateCodeIssue = (v: string | undefined) => ({
  message: v && v.trim().length > 2 ? `${STATE_CODE_MSG} (found "${v}")` : STATE_CODE_MSG,
});

// ─── Duplicate-customer guard helpers (spec §5.2) ──────────────

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
    err as {
      response?: { status?: number; data?: { error?: string; existing?: ExistingCustomer } };
    }
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

// ─── Blocked-submit reporting ──────────────────────────
//
// A rule whose field has no error surface makes the Save button do nothing at all:
// handleSubmit refuses, no request goes out, and the page says nothing. The billing_*
// rules were in exactly that state, so every customer imported with a full state name
// ("New Jersey") was unsavable with no way to tell why. These helpers back a form-level
// summary driven off the whole error object, so this can never go silent again for any
// field, including ones added later.

interface BlockedField {
  path: string;
  message: string;
}

/** Flatten RHF's nested error object into one `{path, message}` row per failing field. */
function flattenFieldErrors(errors: unknown, prefix = ''): BlockedField[] {
  if (!errors || typeof errors !== 'object') return [];
  const out: BlockedField[] = [];
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    // `ref` holds a DOM node and `types` the multi-error map - neither is a field.
    if (key === 'ref' || key === 'types' || !value || typeof value !== 'object') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      out.push({ path, message });
    } else {
      out.push(...flattenFieldErrors(value, path));
    }
  }
  return out;
}

// Only the labels title-casing the path can't reach on its own.
const FIELD_LABELS: Record<string, string> = {
  address_line1: 'Street Address',
  address_line2: 'Street Address Line 2',
  billing_address_line1: 'Billing Street Address',
  billing_address_line2: 'Billing Street Address Line 2',
  zip: 'ZIP',
  billing_zip: 'Billing ZIP',
  phone_ext: 'Phone Extension',
  extra_emails: 'Email',
  phones: 'Phone',
};

/**
 * Human label for a field path - `billing_state` → "Billing State", and array rows
 * carry their 1-based position (`phones.1.phone` → "Phone 2").
 */
function fieldLabel(path: string): string {
  const segments = path.split('.');
  const index = segments.find((s) => /^\d+$/.test(s));
  const leaf = [...segments].reverse().find((s) => !/^\d+$/.test(s)) ?? path;
  const base =
    FIELD_LABELS[path] ??
    FIELD_LABELS[leaf] ??
    leaf.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return index === undefined ? base : `${base} ${Number(index) + 1}`;
}

// Top-level customers eligible to be a billing-group parent (franchise).
interface ParentCustomerOption {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  parent_id?: string | null;
}

import { customerSchema, type CustomerFormData } from '@/lib/customers/customerSchema';

// ─── Tiny shared label (asterisk for required) ───────

function FieldLabel({
  children,
  required,
  optional,
  htmlFor,
}: {
  children: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
}) {
  return (
    <Label tone="strong" htmlFor={htmlFor} className="text-sm font-medium">
      {children}
      {required && <span className="text-danger"> *</span>}
      {optional && <span className="ml-1 font-normal text-text-secondary">(optional)</span>}
    </Label>
  );
}

/** A radio row styled from primitives (no radio-group component in the repo). */
function RadioRow({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    // Custom radio option (role="radio"), not a Button-shaped control - left raw
    // per the program's non-Button-shape carve-out.
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className="flex items-center gap-2.5 text-left text-sm"
    >
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary' : 'border-secondary-dark',
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className={cn(checked && 'font-medium')}>{label}</span>
    </button>
  );
}

// ─── Component ───────────────────────────────────────

export default function CustomerFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isEdit = Boolean(id);
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
  // field (defaultValues are only consumed on first mount — read once).
  // normalizePhone strips the E.164 country code so the 10-digit mask applies.
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

  // Derive form values from server data — avoids useEffect timing issues.
  const editValues = useMemo(() => {
    if (!customer) return undefined;
    const loc =
      customer.service_locations?.find((l: { is_primary: boolean }) => l.is_primary) ||
      customer.service_locations?.[0];
    const billingSet = Boolean(
      customer.billing_address_line1 || customer.billing_city || customer.billing_state || customer.billing_zip,
    );
    // Rows saved with "same as service" mirror the service address into billing_* (buildPayload +
    // backend applyBillingCopy). Compare only line1/city/state/zip — NOT line2 — because the backend
    // copy omits line2, so mirrored rows would never match if line2 were compared.
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
        customer.extra_emails?.map(
          (e: { email: string; label?: string | null; receives_emails?: boolean }) => ({
            email: e.email,
            label: e.label || '',
            // Addresses that predate the opt-in come back false; never assume true here.
            receives_emails: e.receives_emails ?? false,
          }),
        ) || [],
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
      // Account type: parent_id set → "Under a Franchise"; otherwise individual,
      // with the "this is a franchise" checkbox reflecting is_parent (no children → top-level).
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
    // shape useForm actually needs; runtime behavior is unchanged.
    resolver: zodResolver(customerSchema) as Resolver<CustomerFormData>,
    defaultValues: emptyDefaults,
    values: editValues,
    mode: 'onTouched',
  });

  const {
    fields: emailFields,
    append: appendEmail,
    remove: removeEmail,
  } = useFieldArray({ control: form.control, name: 'extra_emails' });

  const {
    fields: phoneFields,
    append: appendPhone,
    remove: removePhone,
  } = useFieldArray({ control: form.control, name: 'phones' });

  const accountType = form.watch('account_type');
  const isFranchise = form.watch('is_franchise');
  const parentId = form.watch('parent_id');
  const billingSame = form.watch('billing_same_as_service_location');
  const taxExempt = form.watch('tax_exempt');
  const allowBilling = form.watch('allow_billing');
  const moreDetailsRevealed = form.watch('segment');

  const [moreOpen, setMoreOpen] = useState(false);
  const [franchiseQuery, setFranchiseQuery] = useState('');
  const [debouncedFranchiseQuery, setDebouncedFranchiseQuery] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const certInputRef = useRef<HTMLInputElement | null>(null);

  // Duplicate-customer guard (spec §5.2): the existing record from a 409, the
  // form data to resubmit with override, and which field(s) collided.
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [pendingData, setPendingData] = useState<CustomerFormData | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({
    email: false,
    phone: false,
  });

  // Fields that refused the last submit - drives the form-level summary.
  const [blockedFields, setBlockedFields] = useState<BlockedField[]>([]);
  const blockedSummaryRef = useRef<HTMLDivElement | null>(null);

  // Debounce the franchise search term (250ms) so the server-side query doesn't fire on
  // every keystroke (FIX 1).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFranchiseQuery(franchiseQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [franchiseQuery]);

  // Top-level customers — candidates for the franchise/parent picker.
  // Server-side searchable (backend supports `search` + `is_parent`); only enabled while
  // the "Under a Franchise" option is selected so we don't fetch when the picker is hidden.
  // limit:100 matches the backend cap (was 200, which the backend silently capped → franchises
  // beyond 100 were unreachable; now the `search` term narrows server-side instead).
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

  // The specific persisted parent (edit mode) — fetched by id so the pill shows the real
  // name even when the parent isn't in the (possibly search-filtered) candidate list (FIX 2).
  const { data: persistedParent } = useQuery<ParentCustomerOption | null>({
    queryKey: ['customer-parent', parentId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${parentId}`);
      return (data.customer as ParentCustomerOption) ?? null;
    },
    enabled: isEdit && Boolean(parentId),
  });

  // Eligible parents = top-level customers, excluding self (edit mode). Keep the client-side
  // safety filter even though the backend already scopes by is_parent + search.
  const parentOptions = useMemo(
    () => parentCandidates.filter((c) => !c.parent_id && c.id !== id),
    [parentCandidates, id],
  );

  // Picked franchise label — prefer the live candidate list, then the dedicated by-id fetch,
  // and only fall back to a generic label if neither resolved (FIX 2).
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

  // Upload a staged tax-exempt certificate after the customer is saved.
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

  // Build the customer payload (shared by create + edit).
  const buildPayload = (data: CustomerFormData, adminOverride?: boolean) => {
    const {
      address_line1,
      address_line2,
      city,
      state,
      zip,
      extra_emails,
      phones,
      // UI-only fields — resolved/renamed before sending to the backend.
      account_type,
      is_franchise,
      parent_id,
      billing_same_as_service_location,
      // Admin-only field handled separately below.
      created_at,
      ...rest
    } = data;

    const hasLocation = Boolean(address_line1 && city && state && zip);

    // Account-type → billing-group mapping.
    let resolvedParentId: string | null = null;
    let billToCustomerId: string | null = null;
    let isParent = false;
    if (account_type === 'under' && parent_id?.trim()) {
      resolvedParentId = parent_id;
      billToCustomerId = parent_id; // bill to the franchise
    } else if (account_type === 'individual' && is_franchise) {
      isParent = true;
    }

    // Inverted billing: when "same as service location", mirror the service address.
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
      segment: rest.segment || 'RESIDENTIAL', // default RESIDENTIAL when unset
      first_name: rest.first_name?.trim() || null,
      last_name: rest.last_name?.trim() || null,
      company_name: rest.company_name?.trim() || null,
      email: rest.email?.trim() || null,
      phone: rest.phone, // formatted string (matches existing behavior)
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
        .map((e) => ({
          email: (e.email as string).trim(),
          label: e.label || undefined,
          // Explicit on every save: the API recreates these rows and reads a missing
          // flag as false, so an omitted value would silently opt the address out.
          receives_emails: e.receives_emails ?? false,
        })),
      phones: (phones || [])
        .filter((p) => (p.phone || '').trim())
        .map((p) => ({
          phone: p.phone as string,
          label: p.label || undefined,
          extension: p.extension || undefined,
          is_primary: p.is_primary ?? false,
        })),
      // Admin-only: include created_at only when admin and value is non-empty.
      ...(adminOverride && created_at ? { created_at } : {}),
    };

    return { payload, hasLocation, address_line1, address_line2, city, state, zip };
  };

  // Save (create or edit) → returns the customer id. `override` bypasses the
  // duplicate-customer guard on the create path (spec §5.2).
  const save = async (data: CustomerFormData, override = false): Promise<string> => {
    const { payload, hasLocation, address_line1, address_line2, city, state, zip } = buildPayload(data, isAdmin);

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

  // Save the customer, then attempt the cert upload. The cert upload is DECOUPLED from the
  // save: a failed upload must NOT reject the mutation (the customer is already saved), so we
  // swallow it here and surface a distinct toast instead (FIX 3b).
  const saveThenUploadCert = async (data: CustomerFormData, override = false): Promise<string> => {
    const customerId = await save(data, override);
    try {
      await uploadCert(customerId);
    } catch {
      toast({
        title: 'Certificate upload failed',
        description: 'Customer saved, but the certificate upload failed — you can upload it later.',
        variant: 'destructive',
      });
    }
    return customerId;
  };

  // Route a 409 `duplicate` error to the dialog instead of letting it surface as
  // the raw "duplicate" text via `mutationError`.
  const handleSubmitError = (err: unknown, data: CustomerFormData) => {
    const dup = getDuplicate(err);
    if (dup) {
      setDupExisting(dup);
      setPendingData(data);
      setDupMatched(computeMatchedFields(data, dup));
    }
  };

  // Primary submit — create / save changes.
  const submitMutation = useMutation({
    mutationFn: ({ data, override }: { data: CustomerFormData; override?: boolean }) =>
      saveThenUploadCert(data, override),
    onSuccess: (customerId) => {
      // Clear the duplicate-guard state explicitly so `isOverriding` can never be
      // driven by stale state from a prior duplicate encounter (finding 4).
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      if (isEdit && id) {
        queryClient.invalidateQueries({ queryKey: ['customer', id] });
        navigate(`/customers/${id}`);
      } else if (returnTo && customerId) {
        navigate(`${returnTo}?newCustomerId=${customerId}`, { replace: true });
      } else {
        navigate(`/customers/${customerId || ''}`);
      }
    },
    onError: (err, { data }) => handleSubmitError(err, data),
  });

  // Save & Create Lead — same save path, then jump to the new-lead form.
  const saveAndLeadMutation = useMutation({
    mutationFn: ({ data, override }: { data: CustomerFormData; override?: boolean }) =>
      saveThenUploadCert(data, override),
    onSuccess: (customerId) => {
      // Clear the duplicate-guard state explicitly so `isOverriding` can never be
      // driven by stale state from a prior duplicate encounter (finding 4).
      setDupExisting(null);
      setPendingData(null);
      setDupMatched({ email: false, phone: false });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      if (isEdit && id) queryClient.invalidateQueries({ queryKey: ['customer', id] });
      navigate(`/leads/new?customer_id=${customerId}`);
    },
    onError: (err, { data }) => handleSubmitError(err, data),
  });

  const pending = submitMutation.isPending || saveAndLeadMutation.isPending;
  const rawMutationError = submitMutation.error || saveAndLeadMutation.error;
  // The duplicate case is handled by the dialog — don't also surface the raw
  // "duplicate" string in the inline error block.
  const mutationError = getDuplicate(rawMutationError) ? null : rawMutationError;
  const errors = form.formState.errors;

  // Which create path triggered the open duplicate dialog — so "Create anyway"
  // resubmits the same one.
  const dupSource = useRef<'submit' | 'lead'>('submit');

  // A submit that validation refuses never reaches the network, so the only feedback
  // is what we render here. Report every failing field and put the caret on the first
  // one - a field whose own inline error is off-screen (or absent) is still named.
  const handleBlockedSubmit = (formErrors: typeof errors) => {
    const blocked = flattenFieldErrors(formErrors);
    setBlockedFields(blocked);
    const first = blocked[0];
    if (!first) return;
    // The summary renders at the bottom of an inner scroll area, so leaving the viewport
    // where it is would repeat the original complaint. Put the caret on the offending
    // input when there is one (the user can fix it straight away), and only fall back to
    // scrolling the summary when the path has no rendered control - a collapsed panel,
    // or a field that has no input of its own.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLElement>(
        `#customer-form [name="${CSS.escape(first.path)}"]`,
      );
      if (input) {
        input.focus();
        // The field is too narrow to show a long value, so select it: the next keystroke
        // replaces the whole thing rather than appending to a fragment.
        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) input.select();
        input.scrollIntoView({ block: 'center' });
      } else {
        blockedSummaryRef.current?.scrollIntoView({ block: 'center' });
      }
    });
  };

  const onSubmitForm = form.handleSubmit((d) => {
    setBlockedFields([]);
    dupSource.current = 'submit';
    submitMutation.mutate({ data: d });
  }, handleBlockedSubmit);
  const onSaveAndLead = form.handleSubmit((d) => {
    setBlockedFields([]);
    dupSource.current = 'lead';
    saveAndLeadMutation.mutate({ data: d });
  }, handleBlockedSubmit);

  // Dialog: "Create anyway" → resubmit the originating create with override.
  const handleCreateAnyway = () => {
    if (!pendingData) return;
    if (dupSource.current === 'lead') {
      saveAndLeadMutation.mutate({ data: pendingData, override: true });
    } else {
      submitMutation.mutate({ data: pendingData, override: true });
    }
  };

  // Dialog: "Edit email / phone" → close + focus the offending input.
  const handleEditField = (field: 'email' | 'phone') => {
    setDupExisting(null);
    // setFocus works for the registered email input; for the Controller-wrapped
    // phone we fall back to the element id.
    form.setFocus(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // Dialog: "Open existing customer" → navigate to its detail page (spec §5.2).
  const handleOpenExisting = () => {
    if (!dupExisting) return;
    const target = dupExisting.id;
    setDupExisting(null);
    navigate(`/customers/${target}`);
  };

  const isOverriding =
    (submitMutation.isPending || saveAndLeadMutation.isPending) && Boolean(pendingData);

  if (isEdit && isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const sourceOptions = org?.source_options ?? [];
  const billingTermsOptions = org?.billing_terms_options ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* scroll area */}
      <div className="flex-1 overflow-auto">
        <div className="p-6">
          {/* Header */}
          <div className="mb-4 flex items-center gap-3">
            <Button
              variant="ghost" tone="subtle"
              size="sm"
              className="-ml-1"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Back
            </Button>
            <Heading>{isEdit ? 'Edit Customer' : 'New Customer'}</Heading>
          </div>

          <form id="customer-form" data-testid="customer-form" onSubmit={onSubmitForm}>
            <div className="rounded-xl border border-border bg-surface-light p-6 shadow-card">
              {/* items-start keeps the two columns independent: left growth never moves the right */}
              <div className="grid grid-cols-1 items-start gap-x-10 gap-y-4 lg:grid-cols-2">
                {/* LEFT — full contact column */}
                <div className="space-y-4">
                  {/* eyebrow style, no matching Heading variant - left raw */}
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Contact</h3>

                  {/* Name fields — first name OR company required (see helper text) */}
                  <div className="space-y-3">
                    <p className="text-xs text-text-secondary">Enter a first name or a company name below.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField label="First Name" htmlFor="first_name" error={errors.first_name?.message}>
                        <Input placeholder="Jane" {...form.register('first_name')} />
                      </FormField>
                      <FormField label="Last Name" htmlFor="last_name" optional error={errors.last_name?.message}>
                        <Input placeholder="Alvarez" {...form.register('last_name')} />
                      </FormField>
                    </div>
                    <FormField label="Company" htmlFor="company_name" error={errors.company_name?.message}>
                      <Input placeholder="Acme Restaurant Group" {...form.register('company_name')} />
                    </FormField>
                  </div>

                  {/* Phone — live-formatted + validated on blur */}
                  <div className="space-y-2">
                    <FieldLabel>Phone</FieldLabel>
                    <p className="text-xs text-text-secondary">Provide a phone number or an email below.</p>
                    {/* Primary phone row */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Controller
                          control={form.control}
                          name="phone"
                          render={({ field }) => (
                            <Input
                              id="phone"
                              className="w-44"
                              invalid={!!errors.phone}
                              inputMode="tel"
                              placeholder="(555) 123-4567"
                              value={field.value || ''}
                              onChange={(e) => field.onChange(formatPhoneInput(e.target.value))}
                              onBlur={field.onBlur}
                            />
                          )}
                        />
                        <Input className="w-20" placeholder="Ext" inputMode="numeric" {...form.register('phone_ext')} />
                        <span className="w-4 shrink-0" aria-hidden />
                      </div>
                      {errors.phone && <p className="mt-1 text-xs text-danger">{errors.phone.message}</p>}
                    </div>

                    {/* Additional phones */}
                    {phoneFields.map((field, index) => (
                      <div key={field.id}>
                        <div className="flex items-center gap-2">
                          <Controller
                            control={form.control}
                            name={`phones.${index}.phone`}
                            render={({ field: f }) => (
                              <Input
                                className="w-44"
                                invalid={!!errors.phones?.[index]?.phone}
                                inputMode="tel"
                                placeholder="Additional phone"
                                value={f.value || ''}
                                onChange={(e) => f.onChange(formatPhoneInput(e.target.value))}
                                onBlur={f.onBlur}
                              />
                            )}
                          />
                          <Input className="w-20" placeholder="Ext" inputMode="numeric" {...form.register(`phones.${index}.extension`)} />
                          {/* Inline icon-only remove with no hover background at all - every
                              ghost/danger cell adds a hover:bg-danger/10 this site never had,
                              left raw to avoid inventing a visual state. */}
                          <button
                            type="button"
                            onClick={() => removePhone(index)}
                            className="shrink-0 text-text-secondary hover:text-danger"
                            aria-label="Remove phone"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {errors.phones?.[index]?.phone && (
                          <p className="mt-1 text-xs text-danger">{errors.phones[index]?.phone?.message}</p>
                        )}
                      </div>
                    ))}

                    {/* Idle-brand text CTA with no hover state at all - link/brand would add a
                        hover:underline this site never had, left raw per the PaymentFeeBreakdown.tsx
                        precedent (no matching link cell without inventing a hover treatment). */}
                    <button
                      type="button"
                      onClick={() => appendPhone({ phone: '', label: '', extension: '', is_primary: false })}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary"
                    >
                      <Plus className="h-3 w-3" /> Add Phone
                    </button>
                  </div>

                  {/* Email — optional; validated on blur when provided */}
                  <div className="space-y-2">
                    <FieldLabel>Email</FieldLabel>
                    {/* Primary email row */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Input
                          id="email"
                          className="flex-1"
                          invalid={!!errors.email}
                          type="email"
                          placeholder="jane@example.com"
                          {...form.register('email')}
                        />
                        <span className="w-4 shrink-0" aria-hidden />
                      </div>
                      {errors.email && <p className="mt-1 text-xs text-danger">{errors.email.message}</p>}
                      {/* The primary has no opt-in switch (it always receives), so say so
                          rather than leave the asymmetry with the rows below unexplained. */}
                      <p className="mt-1 text-xs text-text-secondary">Always receives automated emails.</p>
                    </div>

                    {/* Additional emails — each carries its own automated-mail opt-in. */}
                    {emailFields.map((field, index) => (
                      <div key={field.id}>
                        <div className="flex items-center gap-2">
                          <Input
                            className="flex-1"
                            invalid={!!errors.extra_emails?.[index]?.email}
                            type="email"
                            placeholder="Additional email"
                            {...form.register(`extra_emails.${index}.email`)}
                          />
                          {/* Same icon remove with no hover background at all as "Remove
                              phone" above - left raw for the same reason. */}
                          <button
                            type="button"
                            onClick={() => removeEmail(index)}
                            className="shrink-0 text-text-secondary hover:text-danger"
                            aria-label="Remove email"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {errors.extra_emails?.[index]?.email && (
                          <p className="mt-1 text-xs text-danger">{errors.extra_emails[index]?.email?.message}</p>
                        )}
                        {/* pr-6 keeps the row aligned with the input above it, clearing the
                            remove-button column. Disabled until there is an address to opt in. */}
                        <div className="mt-1.5 flex items-center gap-2 pr-6">
                          <Controller
                            control={form.control}
                            name={`extra_emails.${index}.receives_emails`}
                            render={({ field: f }) => (
                              <Switch
                                id={`extra-email-receives-${index}`}
                                checked={!!f.value}
                                onCheckedChange={f.onChange}
                                disabled={!form.watch(`extra_emails.${index}.email`)?.trim()}
                              />
                            )}
                          />
                          {/* Default Label appearance + cursor-pointer, the same pairing
                              every other Switch in the app uses (see AddLineDialog). */}
                          <Label htmlFor={`extra-email-receives-${index}`} className="cursor-pointer">
                            Receives automated emails
                          </Label>
                        </div>
                      </div>
                    ))}

                    {/* Same hover-less brand CTA as "Add Phone" above - left raw for the
                        same reason. */}
                    <button
                      type="button"
                      onClick={() => appendEmail({ email: '', label: '', receives_emails: true })}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary"
                    >
                      <Plus className="h-3 w-3" /> Add Email
                    </button>
                  </div>

                  {/* Source */}
                  <div>
                    <FieldLabel htmlFor="source">How Did They Hear About Us?</FieldLabel>
                    <Select
                      value={form.watch('source') || '__none__'}
                      onValueChange={(val) => {
                        const next = val === '__none__' ? '' : val;
                        // Keep the new `source` column AND legacy ad_source in sync.
                        form.setValue('source', next, { shouldValidate: true });
                        form.setValue('ad_source', next);
                      }}
                    >
                      <SelectTrigger invalid={!!errors.source} className="mt-1">
                        <SelectValue placeholder="Select source" />
                      </SelectTrigger>
                      <SelectContent>
                        {(() => {
                          const current = form.watch('source');
                          const options =
                            current && !sourceOptions.includes(current) ? [current, ...sourceOptions] : sourceOptions;
                          return options.length > 0 ? (
                            options.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="__none__" disabled>
                              No options — add some in Settings
                            </SelectItem>
                          );
                        })()}
                      </SelectContent>
                    </Select>
                    {errors.source && <p className="mt-1 text-xs text-danger">{errors.source.message}</p>}
                  </div>

                  {/* Admin-only: backdate "Customer since" for imported records */}
                  {isEdit && isAdmin && (
                    <div>
                      <FieldLabel htmlFor="created_at">Customer Since</FieldLabel>
                      <DatePicker
                        id="created_at"
                        className="mt-1"
                        max={todayLocalDay()}
                        value={form.watch('created_at') || ''}
                        onChange={(v) => form.setValue('created_at', v, { shouldDirty: true })}
                      />
                    </div>
                  )}
                </div>

                {/* RIGHT — service address (reserved height) then a static Notes box */}
                <div>
                  <div className="lg:min-h-[320px]">
                    <div className="space-y-3">
                      {/* eyebrow style, no matching Heading variant - left raw */}
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        Service Address
                      </h3>
                      <p className="text-xs text-text-secondary">
                        Optional — add it if you have one; you can add it later.
                      </p>
                      <AddressAutocomplete
                        id="address_line1"
                        placeholder="Start typing an address…"
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
                        <p className="text-xs text-danger">{errors.address_line1.message}</p>
                      )}
                      <div className="grid grid-cols-6 gap-3">
                        <Input className="col-span-3" invalid={!!errors.city} placeholder="City" {...form.register('city')} />
                        <Input className="col-span-1" invalid={!!errors.state} placeholder="State" maxLength={2} {...form.register('state')} />
                        <Input className="col-span-2" invalid={!!errors.zip} placeholder="ZIP" {...form.register('zip')} />
                      </div>
                      {(errors.city || errors.state || errors.zip) && (
                        <p className="text-xs text-danger">
                          {errors.city?.message || errors.state?.message || errors.zip?.message}
                        </p>
                      )}

                      <ServiceLocationMap
                        addressLine1={form.watch('address_line1')}
                        city={form.watch('city')}
                        state={form.watch('state')}
                        zip={form.watch('zip')}
                      />

                      {/* Inverted billing — default same as service location */}
                      {billingSame ? (
                        <div className="flex items-center gap-2 rounded-lg bg-background-light px-3 py-2.5 text-sm text-text-secondary">
                          <Check className="h-4 w-4 text-success" />
                          <span>Billing address is the same as the service address</span>
                          {/* Idle-brand text CTA with no hover state at all, same as "Add
                              Phone"/"Add Email" above - left raw for the same reason. */}
                          <button
                            type="button"
                            onClick={() => {
                              form.setValue('billing_address_line1', '');
                              form.setValue('billing_address_line2', '');
                              form.setValue('billing_city', '');
                              form.setValue('billing_state', '');
                              form.setValue('billing_zip', '');
                              form.setValue('billing_same_as_service_location', false);
                            }}
                            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary"
                          >
                            <Pencil className="h-3 w-3" /> Use a different billing address
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3 rounded-lg border border-border p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">Billing Address</span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => form.setValue('billing_same_as_service_location', true)}
                            >
                              <Check className="h-4 w-4" /> Same as service address
                            </Button>
                          </div>
                          <AddressAutocomplete
                            id="billing_address_line1"
                            placeholder="Start typing an address…"
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
                          {errors.billing_address_line1 && (
                            <p className="text-xs text-danger">{errors.billing_address_line1.message}</p>
                          )}
                          <div className="grid grid-cols-6 gap-3">
                            <Input className="col-span-3" invalid={!!errors.billing_city} placeholder="City" {...form.register('billing_city')} />
                            <Input className="col-span-1" invalid={!!errors.billing_state} placeholder="State" maxLength={2} {...form.register('billing_state')} />
                            <Input className="col-span-2" invalid={!!errors.billing_zip} placeholder="ZIP" {...form.register('billing_zip')} />
                          </div>
                          {(errors.billing_city || errors.billing_state || errors.billing_zip) && (
                            <p className="text-xs text-danger">
                              {errors.billing_city?.message ||
                                errors.billing_state?.message ||
                                errors.billing_zip?.message}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 lg:mt-0">
                    <FormField label="Notes" htmlFor="notes">
                      <Textarea className="resize-none" rows={6} placeholder="Internal notes..." {...form.register('notes')} />
                    </FormField>
                  </div>
                </div>
              </div>

              {/* More Details (mode A) — holds the relocated billing-group/franchise config (e2e anchor: customer-billing-group) */}
              <div data-testid="customer-billing-group" className="mt-6 border-t border-border pt-4">
                <div>
                  {/* Plain-text disclosure toggle whose sizing/hover doesn't match link/brand -
                      no hover state at all, same as the TestWorkflowDialog.tsx precedent - left raw. */}
                  <button
                    type="button"
                    onClick={() => setMoreOpen((o) => !o)}
                    className="flex items-center gap-2 text-sm font-medium text-primary"
                  >
                    <ChevronDown className={cn('h-4 w-4 transition', moreOpen && 'rotate-180')} />
                    More Details (optional)
                  </button>

                  {moreOpen && (
                    <div className="mt-4 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
                      {/* Card 1 — Home/Business + Account Type */}
                      <div className="flex h-full flex-col gap-3 rounded-lg border border-border p-4">
                        {/* Home or Business? */}
                        <div>
                          <FieldLabel optional>Home or Business?</FieldLabel>
                          <Select
                            value={moreDetailsRevealed || '__none__'}
                            onValueChange={(val) =>
                              form.setValue(
                                'segment',
                                val === '__none__' ? undefined : (val as 'RESIDENTIAL' | 'COMMERCIAL'),
                              )
                            }
                          >
                            <SelectTrigger className="mt-1">
                              <SelectValue placeholder="Select" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="RESIDENTIAL">Home (residential)</SelectItem>
                              <SelectItem value="COMMERCIAL">Business (commercial)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Account Type */}
                        <div className="border-t border-border pt-3">
                          <div className="space-y-3">
                            <span className="text-sm font-medium">Account Type</span>
                            <div role="radiogroup" className="space-y-2.5">
                              <div className="flex items-center justify-between gap-3">
                                <RadioRow
                                  checked={accountType === 'individual'}
                                  onClick={() => form.setValue('account_type', 'individual')}
                                  label="Individual Account"
                                />
                                {/* Checkbox row (label wraps its control) - not a FormField-shape site, left raw. */}
                                <label
                                  className={cn(
                                    'flex shrink-0 cursor-pointer items-center gap-2 text-xs text-text-secondary',
                                    accountType !== 'individual' && 'opacity-40',
                                  )}
                                >
                                  <Checkbox
                                    checked={accountType === 'individual' && Boolean(isFranchise)}
                                    disabled={accountType !== 'individual'}
                                    onCheckedChange={(v) => form.setValue('is_franchise', v === true)}
                                  />
                                  This is a franchise
                                </label>
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

                            {/* Reserved slot for the franchise picker (Mode A — no resize) */}
                            <div className="min-h-[64px] pl-[26px]">
                              {accountType === 'under' && (
                                <>
                                  <FieldLabel optional>Franchise</FieldLabel>
                                  {pickedParent ? (
                                    <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-background-light px-3 py-2">
                                      <Building2 className="h-4 w-4 text-text-secondary" />
                                      <span className="text-sm">{pickedParent.label}</span>
                                      {/* Idle-brand text CTA with no hover state at all, same as
                                          "Add Phone"/"Add Email" above - left raw for the same reason. */}
                                      <button
                                        type="button"
                                        className="ml-auto text-xs font-medium text-primary"
                                        onClick={() => {
                                          form.setValue('parent_id', '');
                                          setFranchiseQuery('');
                                        }}
                                      >
                                        Change
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="mt-1 space-y-2">
                                      <div className="relative">
                                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                                        <Input
                                          className="pl-9"
                                          value={franchiseQuery}
                                          onChange={(e) => setFranchiseQuery(e.target.value)}
                                          placeholder="Search by name…"
                                        />
                                      </div>
                                      {franchiseQuery && (
                                        <div className="overflow-hidden rounded-lg border border-border">
                                          {/* Listbox-row search-result click target, not a
                                              Button-shaped control - left raw per the program's
                                              non-Button-shape carve-out. */}
                                          {franchiseMatches.map((m) => (
                                            <button
                                              key={m.id}
                                              type="button"
                                              onClick={() => {
                                                form.setValue('parent_id', m.id);
                                                setFranchiseQuery('');
                                              }}
                                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background-light"
                                            >
                                              <Building2 className="h-4 w-4 text-text-secondary" /> {customerDisplayName(m)}
                                            </button>
                                          ))}
                                          {franchiseMatches.length === 0 && (
                                            <div className="px-3 py-2 text-sm text-text-secondary">
                                              No matching accounts found.
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Card 2 — Allow Billing + Tax Exempt */}
                      <div className="flex h-full flex-col rounded-lg border border-border p-4">
                        {/* Allow Billing */}
                        <div className="pb-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">Allow Billing</span>
                            <Switch
                              checked={Boolean(allowBilling)}
                              onCheckedChange={(checked) => form.setValue('allow_billing', checked)}
                            />
                          </div>
                          <div className="mt-3 min-h-[84px]">
                            {allowBilling && (
                              <>
                                <FieldLabel optional>Billing Terms</FieldLabel>
                                <Select
                                  value={form.watch('billing_terms') || '__none__'}
                                  onValueChange={(val) =>
                                    form.setValue('billing_terms', val === '__none__' ? '' : val)
                                  }
                                >
                                  <SelectTrigger className="mt-1">
                                    <SelectValue placeholder="Select terms" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {(() => {
                                      const current = form.watch('billing_terms');
                                      const options =
                                        current && !billingTermsOptions.includes(current)
                                          ? [current, ...billingTermsOptions]
                                          : billingTermsOptions;
                                      return options.length > 0 ? (
                                        options.map((t) => (
                                          <SelectItem key={t} value={t}>
                                            {t}
                                          </SelectItem>
                                        ))
                                      ) : (
                                        <SelectItem value="__none__" disabled>
                                          No options — add some in Settings
                                        </SelectItem>
                                      );
                                    })()}
                                  </SelectContent>
                                </Select>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Tax Exempt */}
                        <div className="border-t border-border pt-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">Tax Exempt</span>
                            <Switch
                              checked={Boolean(taxExempt)}
                              onCheckedChange={(checked) => form.setValue('tax_exempt', checked)}
                            />
                          </div>
                          <div className="mt-3 min-h-[44px]">
                            {taxExempt && (
                              <div className="flex items-center gap-3">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => certInputRef.current?.click()}
                                >
                                  <Upload className="mr-1.5 h-4 w-4" /> Upload Certificate
                                </Button>
                                <span className="text-xs text-text-secondary">
                                  {certFile ? certFile.name : 'PDF or image'}
                                </span>
                                <input
                                  ref={certInputRef}
                                  type="file"
                                  accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
                                  className="hidden"
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
              </div>

              {/* Blocked by validation - never let a refused submit look like nothing happened */}
              {blockedFields.length > 0 && (
                <div ref={blockedSummaryRef} data-testid="customer-form-blocked" className="mt-4 text-sm text-danger">
                  <p>Fix these fields before saving:</p>
                  <ul className="mt-1 list-disc pl-4 text-xs">
                    {blockedFields.map((f) => (
                      <li key={f.path}>
                        <span className="font-medium">{fieldLabel(f.path)}</span>: {f.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Submit error */}
              {mutationError && (
                <div className="mt-4 text-sm text-danger">
                  <p>{extractApiError(mutationError, 'Something went wrong')}</p>
                  {(() => {
                    const details = (
                      mutationError as { response?: { data?: { details?: { field: string; message: string }[] } } }
                    )?.response?.data?.details;
                    if (!details?.length) return null;
                    return (
                      <ul className="mt-1 list-disc pl-4 text-xs">
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
            </div>
          </form>
        </div>
      </div>

      {/* Pinned footer — opaque, full width, flush to the bottom of the scroll area */}
      <div className="shrink-0 border-t border-border bg-surface-light px-6 py-4 shadow-[0_-2px_12px_rgb(var(--text-primary)/0.06)]">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="ghost" disabled={pending} onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onSaveAndLead}>
            Save &amp; Create Lead
          </Button>
          <Button variant="solid" tone="business" type="submit" form="customer-form" data-testid="customer-form-submit" disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Customer'}
          </Button>
        </div>
      </div>

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
