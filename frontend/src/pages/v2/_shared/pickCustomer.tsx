import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Mail, MapPin, Pencil, Phone } from 'lucide-react';

import api from '@/lib/axios';
import { formatPhone, formatPhoneInput } from '@/lib/utils';
import {
  isRedactedMatch,
  type ExistingCustomer,
  type FullExistingCustomer,
} from '@/components/customers/DuplicateCustomerDialog';
import type {
  CustomerContactField, CustomerContactFields, PickCustomer,
} from '@/components/crm/PickOrCreateCustomer';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

/**
 * v2 pick-or-create-customer control.
 *
 * A kit rebuild of `components/crm/PickOrCreateCustomer` + its
 * `DuplicateCustomerDialog`. It stays fully CONTROLLED and delegating for the
 * same reason the original is: the create call diverges per call site, so the
 * parent owns the fields, the selected customer and the network call. The
 * shared TYPES and the duplicate-guard helpers are imported from the original
 * rather than restated, so the two controls can never disagree about the
 * payload shape.
 */

export interface PickCustomerFieldsProps {
  fields: CustomerContactFields;
  onFieldChange: (field: CustomerContactField, value: string) => void;
  selectedCustomer: PickCustomer | null;
  onSelectCustomer: (customer: PickCustomer) => void;
  required?: boolean;
  errors?: Partial<Record<CustomerContactField, string | undefined>>;
  showPhoneExt?: boolean;
  showSecondaryPhone?: boolean;
  duplicate?: ExistingCustomer | null;
  duplicateMatchedFields?: { email: boolean; phone: boolean };
  onUseExisting?: () => void;
  onCreateAnyway?: () => void;
  onEditField?: (field: 'email' | 'phone') => void;
  onDismissDuplicate?: () => void;
  isOverriding?: boolean;
}

function CustomerDropdown({
  results, onSelect,
}: {
  results?: PickCustomer[];
  onSelect: (c: PickCustomer) => void;
}) {
  return (
    <div className="bg-kit-popover absolute top-full left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border shadow-lg">
      {results?.map((c) => (
        <Button
          key={c.id}
          type="button"
          variant="ghost"
          className="h-auto w-full flex-col items-start gap-0.5 rounded-none px-3 py-2.5 text-left font-normal"
          onClick={() => onSelect(c)}
        >
          <span className="font-medium">
            {c.first_name} {c.last_name}{c.company_name ? ` (${c.company_name})` : ''}
          </span>
          <span className="text-muted-foreground text-xs">
            {formatPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}
          </span>
        </Button>
      ))}
      {results?.length === 0 && (
        <p className="text-muted-foreground px-3 py-2.5 text-sm">No customers found</p>
      )}
    </div>
  );
}

function displayName(c: FullExistingCustomer): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return c.company_name || person || 'Existing customer';
}

function DuplicateCustomerDialog({
  existing, matchedFields, onOpenExisting, onEditField, onCreateAnyway, onClose, isOverriding,
}: {
  existing: ExistingCustomer | null;
  matchedFields: { email: boolean; phone: boolean };
  onOpenExisting: () => void;
  onEditField: (field: 'email' | 'phone') => void;
  onCreateAnyway: () => void;
  onClose: () => void;
  isOverriding: boolean;
}) {
  if (!existing) return null;

  // #1996 — the requester may not read the matched row. Branch BEFORE deriving
  // matchedEmail/matchedPhone below: this fixture's `matched` values are booleans, and
  // `false != null` is `true`, so the un-branched derivation would highlight a field that
  // never collided.
  if (isRedactedMatch(existing)) {
    // A well-formed wire payload always carries `matched` (duplicateConflictBody always sets
    // it), but a malformed/future one might not — guard with optional chaining rather than
    // trusting the (required-key) type at runtime.
    const matchedEmail = Boolean(existing.matched?.email);
    const matchedPhone = Boolean(existing.matched?.phone);
    const collided =
      matchedEmail && matchedPhone ? 'phone or email' : matchedEmail ? 'email' : matchedPhone ? 'phone' : null;

    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <AlertTriangle />
              Possible Duplicate Customer
            </DialogTitle>
            <DialogDescription>
              {collided
                ? <>A customer with this {collided} already exists. Ask an admin or dispatcher to link it.</>
                : 'A customer with these details already exists. Ask an admin or dispatcher to link it.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {matchedEmail && (
                <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('email')}>
                  <Pencil />
                  Edit email
                </Button>
              )}
              {matchedPhone && (
                <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('phone')}>
                  <Pencil />
                  Edit phone
                </Button>
              )}
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="ghost" size="sm" onClick={onCreateAnyway} isLoading={isOverriding}>
              Create anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const archived = !existing.is_active || Boolean(existing.archived_at);
  const addr = existing.primary_address;
  // The backend's relation-aware match info wins: it knows when a SECONDARY
  // phone/email matched, which the primary-only fallback cannot see.
  const matchedEmail = existing.matched ? existing.matched.email != null : matchedFields.email;
  const matchedPhone = existing.matched ? existing.matched.phone != null : matchedFields.phone;
  const emailShown = existing.matched?.email ?? existing.email;
  const phoneShown = existing.matched?.phone ?? existing.phone;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <AlertTriangle />
            Possible Duplicate Customer
          </DialogTitle>
          <DialogDescription>
            A customer with the same{' '}
            {matchedEmail && matchedPhone ? 'email and phone' : matchedEmail ? 'email' : 'phone'}{' '}
            already exists in your organization.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{displayName(existing)}</p>
                <p className="text-muted-foreground text-xs">{existing.customer_number}</p>
              </div>
              <Badge variant={archived ? 'softNeutral' : 'softGreen'} size="pill">
                {archived ? 'Archived' : 'Active'}
              </Badge>
            </div>

            {emailShown && (
              <p className={matchedEmail ? 'text-destructive flex items-center gap-2 text-sm font-medium' : 'text-muted-foreground flex items-center gap-2 text-sm'}>
                <Mail className="size-4 shrink-0" />
                <span className="truncate">{emailShown}</span>
                {matchedEmail && <span className="ms-auto shrink-0 text-xs">matches</span>}
              </p>
            )}
            {phoneShown && (
              <p className={matchedPhone ? 'text-destructive flex items-center gap-2 text-sm font-medium' : 'text-muted-foreground flex items-center gap-2 text-sm'}>
                <Phone className="size-4 shrink-0" />
                <span className="truncate">{formatPhone(phoneShown ?? '')}</span>
                {matchedPhone && <span className="ms-auto shrink-0 text-xs">matches</span>}
              </p>
            )}
            {addr && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <MapPin className="size-4 shrink-0" />
                <span className="truncate">{[addr.line1, addr.city, addr.state].filter(Boolean).join(', ')}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Button className="w-full justify-start" onClick={onOpenExisting}>
              <ArrowRight />
              Open existing customer
            </Button>
            {matchedEmail && (
              <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('email')}>
                <Pencil />
                Edit email
              </Button>
            )}
            {matchedPhone && (
              <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('phone')}>
                <Pencil />
                Edit phone
              </Button>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="ghost" size="sm" onClick={onCreateAnyway} isLoading={isOverriding}>
            Create anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PickCustomerFields({
  fields,
  onFieldChange,
  selectedCustomer,
  onSelectCustomer,
  required = false,
  errors,
  showPhoneExt = false,
  showSecondaryPhone = false,
  duplicate = null,
  duplicateMatchedFields = { email: false, phone: false },
  onUseExisting,
  onCreateAnyway,
  onEditField,
  onDismissDuplicate,
  isOverriding = false,
}: PickCustomerFieldsProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeSearchField, setActiveSearchField] = useState<CustomerContactField | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeFieldValue = activeSearchField ? (fields[activeSearchField] || '') : '';

  const { data: searchResults } = useQuery({
    queryKey: ['customers-picker', activeFieldValue],
    queryFn: async () => {
      // #2041 slice 1 - the org-wide create-form picker (Ran's carve-out): a rep must be able
      // to start a lead/estimate/invoice on a customer they have never worked with, so this
      // stays org-wide even once the Customers list/detail/search are row-scoped.
      const { data } = await api.get('/api/customers/picker', { params: { search: activeFieldValue, limit: 6 } });
      return data.customers as PickCustomer[];
    },
    enabled: activeFieldValue.length >= 2 && showDropdown,
  });

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

  // Split a full name typed into First Name on the LAST space, on blur only.
  const handleFirstNameBlur = () => {
    if (selectedCustomer) return;
    const trimmed = (fields.first_name || '').trim();
    if (!trimmed.includes(' ')) return;
    if ((fields.last_name || '').trim().length > 0) return;
    const lastSpace = trimmed.lastIndexOf(' ');
    onFieldChange('first_name', trimmed.slice(0, lastSpace).trim());
    onFieldChange('last_name', trimmed.slice(lastSpace + 1).trim());
  };

  const handleSelect = (c: PickCustomer) => {
    setShowDropdown(false);
    setActiveSearchField(null);
    onSelectCustomer(c);
  };

  const dropdownFor = (field: CustomerContactField) =>
    activeSearchField === field && showDropdown && activeFieldValue.length >= 2
      ? <CustomerDropdown results={searchResults} onSelect={handleSelect} />
      : null;

  const req = required ? ' *' : '';

  return (
    <div className="flex flex-col gap-3" ref={dropdownRef}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="relative flex flex-col gap-1.5">
          <Label htmlFor="v2-first-name">First Name{req}</Label>
          <Input
            id="v2-first-name"
            placeholder="Search..."
            value={fields.first_name}
            onChange={(e) => handleChange('first_name', e.target.value)}
            onFocus={() => handleFocus('first_name')}
            onBlur={handleFirstNameBlur}
            autoComplete="off"
          />
          {errors?.first_name && <p className="text-destructive text-xs">{errors.first_name}</p>}
          {dropdownFor('first_name')}
        </div>
        <div className="relative flex flex-col gap-1.5">
          <Label htmlFor="v2-last-name">Last Name</Label>
          <Input
            id="v2-last-name"
            placeholder="Search..."
            value={fields.last_name}
            onChange={(e) => handleChange('last_name', e.target.value)}
            onFocus={() => handleFocus('last_name')}
            autoComplete="off"
          />
          {errors?.last_name && <p className="text-destructive text-xs">{errors.last_name}</p>}
          {dropdownFor('last_name')}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="relative flex flex-col gap-1.5">
          <Label htmlFor="phone">Phone</Label>
          <div className="flex items-center gap-2">
            <Input
              id="phone"
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
                // Not routed through handleChange: an extension is never a
                // customer search term, so it must not open the typeahead.
                onChange={(e) => onFieldChange('phone_ext', e.target.value)}
                autoComplete="off"
              />
            )}
          </div>
          {errors?.phone && <p className="text-destructive text-xs">{errors.phone}</p>}
          {errors?.phone_ext && <p className="text-destructive text-xs">{errors.phone_ext}</p>}
          {dropdownFor('phone')}
        </div>
        <div className="relative flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            placeholder="Search..."
            value={fields.email}
            onChange={(e) => handleChange('email', e.target.value)}
            onFocus={() => handleFocus('email')}
            autoComplete="off"
          />
          {errors?.email && <p className="text-destructive text-xs">{errors.email}</p>}
          {dropdownFor('email')}
        </div>
      </div>
      {required && (
        <p className="text-muted-foreground text-xs">Provide a phone number or an email above.</p>
      )}

      {showSecondaryPhone && !selectedCustomer && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secondary_phone">Secondary Phone</Label>
            <Input
              id="secondary_phone"
              placeholder="Optional second number"
              inputMode="tel"
              value={fields.secondary_phone ?? ''}
              onChange={(e) => onFieldChange('secondary_phone', formatPhoneInput(e.target.value))}
              autoComplete="off"
            />
            {errors?.secondary_phone && <p className="text-destructive text-xs">{errors.secondary_phone}</p>}
          </div>
        </div>
      )}

      <div className="relative flex flex-col gap-1.5">
        <Label htmlFor="v2-company-name">Company Name</Label>
        <Input
          id="v2-company-name"
          placeholder="Search..."
          value={fields.company_name}
          onChange={(e) => handleChange('company_name', e.target.value)}
          onFocus={() => handleFocus('company_name')}
          autoComplete="off"
        />
        {dropdownFor('company_name')}
      </div>

      {selectedCustomer
        && (selectedCustomer.secondary_phone || selectedCustomer.phone_ext
          || (selectedCustomer.extra_emails && selectedCustomer.extra_emails.length > 0)) && (
        <div className="flex flex-col gap-1.5 rounded-lg border p-3">
          <p className="text-muted-foreground text-xs font-semibold uppercase">Additional Contacts</p>
          {selectedCustomer.phone_ext && (
            <p className="flex items-center gap-2 text-sm">
              <Phone className="text-muted-foreground size-3.5 shrink-0" />
              {formatPhone(selectedCustomer.phone)} ext. {selectedCustomer.phone_ext}
            </p>
          )}
          {selectedCustomer.secondary_phone && (
            <p className="flex items-center gap-2 text-sm">
              <Phone className="text-muted-foreground size-3.5 shrink-0" />
              {formatPhone(selectedCustomer.secondary_phone)}
              {selectedCustomer.secondary_phone_ext ? ` ext. ${selectedCustomer.secondary_phone_ext}` : ''}
              <span className="text-muted-foreground text-xs">(secondary)</span>
            </p>
          )}
          {selectedCustomer.extra_emails?.map((e) => (
            <p key={e.id} className="flex items-center gap-2 text-sm">
              <Mail className="text-muted-foreground size-3.5 shrink-0" />
              <span className="break-all">{e.email}</span>
              {e.label && <span className="text-muted-foreground text-xs">({e.label})</span>}
            </p>
          ))}
        </div>
      )}

      <DuplicateCustomerDialog
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
