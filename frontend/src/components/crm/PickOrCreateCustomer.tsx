import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/patterns/FormField';
import { Phone, Mail } from 'lucide-react';
import { formatPhone, formatPhoneInput } from '@/lib/utils';
import {
  DuplicateCustomerDialog,
  isRedactedMatch,
  type ExistingCustomer,
} from '@/components/customers/DuplicateCustomerDialog';

// ─── Public types ─────────────────────────────────────
//
// A reusable pick-or-create-customer control extracted from the lead form
// (standalone-invoices plan §5.1). It renders the contact-field typeahead
// (first/last/phone/email/company) + the customer-search dropdown + the
// duplicate-customer dialog UI. It is fully CONTROLLED: the parent owns the
// field values, the selected-customer object, and the create network call —
// because the create endpoint diverges per call site (leads bundle a
// `new_customer` into POST /api/leads; the standalone invoice page POSTs
// /api/customers, override resubmits differ). This keeps the component a thin,
// generic adapter that both RHF forms and local-state pages can drive, and
// mirrors how `DuplicateCustomerDialog` was already designed (presentational +
// delegating).

/**
 * A customer record as returned by the customers search/detail endpoints.
 *
 * #2041 slice 1 — the create-form typeaheads now hit the org-wide picker endpoint
 * (`GET /api/customers/picker`), which can answer with a REDACTED row for a customer the
 * requester cannot fully read (`restricted: true`): only `id`, `first_name`, `last_name`,
 * `company_name`, `phone_last4` and `city`, never `phone`/`email`/`service_locations`. Every
 * contact field below is therefore optional so a restricted row still type-checks; callers must
 * fill what is present and leave the rest blank rather than assume it exists (never throw).
 */
export interface PickCustomer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name?: string | null;
  phone?: string | null;
  phone_ext?: string | null;
  secondary_phone?: string | null;
  secondary_phone_ext?: string | null;
  email?: string | null;
  ad_source?: string | null;
  /** Present on a readable picker row only — never redacted (it is a flag, not contact data). */
  tax_exempt?: boolean;
  extra_emails?: { id: string; email: string; label?: string | null }[];
  service_locations?: {
    id: string;
    address_line1: string;
    address_line2?: string | null;
    city: string;
    state: string;
    zip: string;
    is_primary: boolean;
  }[];
  /** True for a redacted picker row (#2041 slice 2 - unconditional in slice 1). */
  restricted?: boolean;
  /** Only present on a restricted row - the last 4 digits of the phone, string, never the full number. */
  phone_last4?: string;
  /** Only present on a restricted row - the primary service location's city. */
  city?: string | null;
}

/** The controlled contact fields (phone_ext/secondary_phone are optional — opt-in per call site). */
export interface CustomerContactFields {
  first_name: string;
  last_name: string;
  company_name: string;
  phone: string;
  phone_ext?: string;
  email: string;
  secondary_phone?: string;
}

export type CustomerContactField = keyof CustomerContactFields;

export interface PickOrCreateCustomerProps {
  /** The five contact field values (the parent's source of truth). */
  fields: CustomerContactFields;
  /** A field's input changed — typically also clears `selectedCustomer` (new-customer mode). */
  onFieldChange: (field: CustomerContactField, value: string) => void;
  /** The currently-selected existing customer (or null while authoring a new one). */
  selectedCustomer: PickCustomer | null;
  /** An existing customer was picked from the search dropdown. */
  onSelectCustomer: (customer: PickCustomer) => void;

  /** Mark the contact fields required (adds asterisks). */
  required?: boolean;
  /** Per-field validation messages. */
  errors?: Partial<Record<CustomerContactField, string | undefined>>;
  /** Show the read-only "Additional Contacts" block for a selected existing customer. */
  showAdditionalContacts?: boolean;
  /** Render a narrow "Ext" input beside Phone (drives fields.phone_ext). */
  showPhoneExt?: boolean;
  /** Show an editable Secondary Phone input while authoring a NEW customer. */
  showSecondaryPhone?: boolean;

  // ─ Duplicate-customer guard (parent owns the create call + override) ─
  /** The existing record from a 409 `duplicate` (null keeps the dialog closed). */
  duplicate?: ExistingCustomer | null;
  /** Which field(s) collided (drives the highlight). */
  duplicateMatchedFields?: { email: boolean; phone: boolean };
  /** Dialog "Open existing customer". */
  onUseExisting?: () => void;
  /** Dialog "Create anyway" — parent resubmits the create with `override`. */
  onCreateAnyway?: () => void;
  /** Dialog "Edit email/phone" — parent should refocus the offending field. */
  onEditField?: (field: 'email' | 'phone') => void;
  /** Dialog dismissed without acting. */
  onDismissDuplicate?: () => void;
  /** Spinner on "Create anyway" while the override request is in flight. */
  isOverriding?: boolean;
}

// ─── Search dropdown ──────────────────────────────────

function CustomerDropdown({
  results,
  onSelect,
}: {
  results?: PickCustomer[];
  onSelect: (c: PickCustomer) => void;
}) {
  return (
    <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface-light shadow-lg max-h-60 overflow-y-auto">
      {results?.map((c) => (
        // Dropdown-menu-item result row, not Button-shaped - left raw.
        <button key={c.id} type="button" className="w-full px-3 py-2.5 text-left hover:bg-background-light text-sm" onClick={() => onSelect(c)}>
          <p className="font-medium">{c.first_name} {c.last_name}{c.company_name ? ` (${c.company_name})` : ''}</p>
          <p className="text-xs text-text-secondary">{formatPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</p>
        </button>
      ))}
      {results?.length === 0 && <EmptyState density="flush" title="No customers found" />}
    </div>
  );
}

// ─── Component ────────────────────────────────────────

export function PickOrCreateCustomer({
  fields,
  onFieldChange,
  selectedCustomer,
  onSelectCustomer,
  required = false,
  errors,
  showAdditionalContacts = true,
  showPhoneExt = false,
  showSecondaryPhone = false,
  duplicate = null,
  duplicateMatchedFields = { email: false, phone: false },
  onUseExisting,
  onCreateAnyway,
  onEditField,
  onDismissDuplicate,
  isOverriding = false,
}: PickOrCreateCustomerProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeSearchField, setActiveSearchField] = useState<CustomerContactField | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeFieldValue = activeSearchField ? (fields[activeSearchField] || '') : '';

  const { data: searchResults } = useQuery({
    queryKey: ['customers-picker', activeFieldValue],
    queryFn: async () => {
      // #2041 slice 1 - the org-wide create-form picker (Ran's carve-out): a rep must be able
      // to start a job on a customer they have never worked with, so this stays org-wide even
      // once the Customers list/detail/search are row-scoped.
      const { data } = await api.get('/api/customers/picker', { params: { search: activeFieldValue, limit: 6 } });
      return data.customers as PickCustomer[];
    },
    enabled: activeFieldValue.length >= 2 && showDropdown,
  });

  // Close dropdown on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setActiveSearchField(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleChange = (field: CustomerContactField, value: string) => {
    setActiveSearchField(field);
    setShowDropdown(true);
    onFieldChange(field, value);
  };

  const handleFocus = (field: CustomerContactField) => {
    if ((fields[field] || '').length >= 2) {
      setActiveSearchField(field);
      setShowDropdown(true);
    }
  };

  // Split a full name typed into First Name (e.g. "John Veise Alvarez") into
  // first/last on the LAST space, on blur only. No-op when an existing customer
  // is picked (otherwise the split would emit onFieldChange, which both call
  // sites treat as clearing the selection back to new-customer mode), when the
  // first name has no space, or when Last Name already has a value.
  const handleFirstNameBlur = () => {
    if (selectedCustomer) return;
    const trimmed = (fields.first_name || '').trim();
    if (!trimmed.includes(' ')) return;
    if ((fields.last_name || '').trim().length > 0) return;
    const { first_name, last_name } = splitFullName(trimmed);
    onFieldChange('first_name', first_name);
    onFieldChange('last_name', last_name);
  };

  const handleSelect = (c: PickCustomer) => {
    setShowDropdown(false);
    setActiveSearchField(null);
    onSelectCustomer(c);
  };

  return (
    <div className="space-y-3" ref={dropdownRef}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="relative">
          {/* First name is the only field that takes `required`. Phone and email are
              each individually optional - the parent form's Zod schema enforces that
              at least one of them is present (SERV10X-35) - so neither shows a bare
              asterisk. */}
          <FormField label="First Name" required={required} error={errors?.first_name}>
            <Input
              placeholder="Search..."
              value={fields.first_name}
              onChange={(e) => handleChange('first_name', e.target.value)}
              onFocus={() => handleFocus('first_name')}
              onBlur={handleFirstNameBlur}
              autoComplete="off"
            />
          </FormField>
          {activeSearchField === 'first_name' && showDropdown && activeFieldValue.length >= 2 && (
            <CustomerDropdown results={searchResults} onSelect={handleSelect} />
          )}
        </div>
        <div className="relative">
          <FormField label="Last Name" error={errors?.last_name}>
            <Input
              placeholder="Search..."
              value={fields.last_name}
              onChange={(e) => handleChange('last_name', e.target.value)}
              onFocus={() => handleFocus('last_name')}
              autoComplete="off"
            />
          </FormField>
          {activeSearchField === 'last_name' && showDropdown && activeFieldValue.length >= 2 && (
            <CustomerDropdown results={searchResults} onSelect={handleSelect} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="relative">
          {/* Render prop, not a cloned child: the control is a two-input row, and
              the id has to land on the phone Input specifically - three host
              pages refocus it by `document.getElementById('phone')` after a
              duplicate-customer collision, so `htmlFor` stays the literal id. */}
          <FormField label="Phone" htmlFor="phone" error={errors?.phone}>
            {(fieldProps) => (
              <div className="flex items-center gap-2">
                <Input
                  {...fieldProps}
                  className="flex-1"
                  placeholder="Search..."
                  inputMode="tel"
                  value={fields.phone}
                  onChange={(e) => handleChange('phone', formatPhoneInput(e.target.value))}
                  onFocus={() => handleFocus('phone')}
                  autoComplete="off"
                />
                {showPhoneExt && (
                  <Input
                    id="phone_ext"
                    className="w-20"
                    placeholder="Ext"
                    inputMode="numeric"
                    maxLength={10}
                    value={fields.phone_ext ?? ''}
                    // Not routed through handleChange: an extension is never a customer
                    // search term, so it must not open the typeahead dropdown.
                    onChange={(e) => onFieldChange('phone_ext', e.target.value)}
                    autoComplete="off"
                  />
                )}
              </div>
            )}
          </FormField>
          {/* Second message for a second control in the same row. FormField has
              one `error` slot, which is spoken for by `errors.phone` above, so
              this one stays call-site markup rather than growing the pattern. */}
          {errors?.phone_ext && <p className="mt-1 text-xs text-danger">{errors.phone_ext}</p>}
          {activeSearchField === 'phone' && showDropdown && activeFieldValue.length >= 2 && (
            <CustomerDropdown results={searchResults} onSelect={handleSelect} />
          )}
        </div>
        <div className="relative">
          <FormField label="Email" htmlFor="email" error={errors?.email}>
            <Input
              placeholder="Search..."
              value={fields.email}
              onChange={(e) => handleChange('email', e.target.value)}
              onFocus={() => handleFocus('email')}
              autoComplete="off"
            />
          </FormField>
          {activeSearchField === 'email' && showDropdown && activeFieldValue.length >= 2 && (
            <CustomerDropdown results={searchResults} onSelect={handleSelect} />
          )}
        </div>
      </div>
      {required && (
        <p className="-mt-2 text-xs text-text-secondary">Provide a phone number or an email above.</p>
      )}

      {showSecondaryPhone && !selectedCustomer && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField
            label="Secondary Phone"
            htmlFor="secondary_phone"
            error={errors?.secondary_phone}
          >
            <Input
              placeholder="Optional second number"
              inputMode="tel"
              value={fields.secondary_phone ?? ''}
              onChange={(e) => onFieldChange('secondary_phone', formatPhoneInput(e.target.value))}
              autoComplete="off"
            />
          </FormField>
        </div>
      )}

      <div className="relative">
        <FormField label="Company Name">
          <Input
            placeholder="Search..."
            value={fields.company_name}
            onChange={(e) => handleChange('company_name', e.target.value)}
            onFocus={() => handleFocus('company_name')}
            autoComplete="off"
          />
        </FormField>
        {activeSearchField === 'company_name' && showDropdown && activeFieldValue.length >= 2 && (
          <CustomerDropdown results={searchResults} onSelect={handleSelect} />
        )}
      </div>

      {/* Additional contacts (read-only, shown when an existing customer is selected) */}
      {showAdditionalContacts && selectedCustomer && (selectedCustomer.secondary_phone || selectedCustomer.phone_ext || (selectedCustomer.extra_emails && selectedCustomer.extra_emails.length > 0)) && (
        <div className="rounded-lg border border-border bg-background-light/50 px-3 py-2.5 space-y-1.5">
          <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Additional Contacts</p>
          {selectedCustomer.phone_ext && (
            <div className="flex items-center gap-2 text-sm text-text-primary">
              <Phone className="h-3.5 w-3.5 text-text-secondary shrink-0" />
              <span>{formatPhone(selectedCustomer.phone)} ext. {selectedCustomer.phone_ext}</span>
            </div>
          )}
          {selectedCustomer.secondary_phone && (
            <div className="flex items-center gap-2 text-sm text-text-primary">
              <Phone className="h-3.5 w-3.5 text-text-secondary shrink-0" />
              <span>
                {formatPhone(selectedCustomer.secondary_phone)}
                {selectedCustomer.secondary_phone_ext ? ` ext. ${selectedCustomer.secondary_phone_ext}` : ''}
              </span>
              <span className="text-xs text-text-secondary">(secondary)</span>
            </div>
          )}
          {selectedCustomer.extra_emails?.map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-sm text-text-primary">
              <Mail className="h-3.5 w-3.5 text-text-secondary shrink-0" />
              <span className="break-all">{e.email}</span>
              {e.label && <span className="text-xs text-text-secondary">({e.label})</span>}
            </div>
          ))}
        </div>
      )}

      <DuplicateCustomerDialog
        open={Boolean(duplicate)}
        existing={duplicate}
        matchedFields={duplicateMatchedFields}
        onOpenExisting={() => onUseExisting?.()}
        onEditField={(field) => onEditField?.(field)}
        onCreateAnyway={() => onCreateAnyway?.()}
        onClose={() => onDismissDuplicate?.()}
        isOverriding={isOverriding}
      />
    </div>
  );
}

// ─── Name helpers ─────────────────────────────────────────────────────────

/**
 * Split a full name on the LAST space (#435): everything before the last space
 * is the first name, everything after is the last name. A single word (no
 * space) yields no last name. Leading/trailing whitespace is trimmed.
 */
export function splitFullName(raw: string): { first_name: string; last_name: string } {
  const trimmed = (raw ?? '').trim();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return { first_name: trimmed, last_name: '' };
  return {
    first_name: trimmed.slice(0, lastSpace).trim(),
    last_name: trimmed.slice(lastSpace + 1).trim(),
  };
}

// ─── Duplicate-guard helpers (shared so call sites stay DRY) ───────────────

const normalizeEmail = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

function normalizePhone(v: string | null | undefined): string {
  let d = (v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

/** Narrow an axios error to the backend's 409 `duplicate` payload (or null). */
export function getDuplicateCustomer(err: unknown): ExistingCustomer | null {
  const r = (
    err as {
      response?: { status?: number; data?: { error?: string; existing?: ExistingCustomer } };
    }
  )?.response;
  if (r?.status === 409 && r?.data?.error === 'duplicate' && r.data.existing) return r.data.existing;
  return null;
}

/** Compare a submitted email/phone against the existing record to drive the highlight. */
export function computeMatchedCustomerFields(
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
