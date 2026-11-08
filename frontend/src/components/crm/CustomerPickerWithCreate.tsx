import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Search, Loader2, Plus } from 'lucide-react';
import api from '@/lib/axios';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/patterns/FormField';
import { formatPhoneInput, extractApiError } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import { useAppAbility } from '@/contexts/AbilityContext';
import {
  PickOrAccreteLocation, ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue, type NewAddressFields,
} from '@/components/crm/PickOrAccreteLocation';
import { getDuplicateCustomer, computeMatchedCustomerFields } from '@/components/crm/PickOrCreateCustomer';
import {
  DuplicateCustomerDialog,
  isRedactedMatch,
  type ExistingCustomer,
} from '@/components/customers/DuplicateCustomerDialog';

export interface CustomerLite {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  customer_number: string;
}

/** Collapsed one-line label for the trigger. The dropdown rows show more — see `customerRow`. */
export function customerLabel(c: Pick<CustomerLite, 'first_name' | 'last_name' | 'company_name' | 'customer_number'>): string {
  return c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.customer_number;
}

/**
 * Splits a customer into the two lines a dropdown row shows.
 *
 * Display order is customer ID, first name, last name, company, email. The ID always leads —
 * it's the one field every customer has. The rest follow in that order, and a missing field
 * is skipped rather than leaving a hole: none of them is required, so a company-only or
 * email-only customer is legitimate and still reads correctly.
 *
 * (`customerLabel` can't be reused here: it collapses to `company_name` when there is one,
 * which hides the person's name entirely and renders two contacts at the same company as
 * identical rows.)
 */
export function customerRow(c: CustomerLite): { primary: string; details: string } {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return {
    primary: [`#${c.customer_number}`, person].filter(Boolean).join(' '),
    details: [c.company_name, c.email].filter(Boolean).join(' · '),
  };
}

const EMPTY_ADDRESS: NewAddressFields = { address_line1: '', address_line2: '', city: '', state: '', zip: '' };
const addressComplete = (a: NewAddressFields) =>
  a.address_line1.trim() !== '' && a.city.trim() !== '' && a.state.trim().length === 2 && a.zip.trim().length >= 5;

export interface CustomerPickerWithCreateProps {
  value: string;
  /**
   * Display label for `value`. Required (even when `value` is '') so a consumer can't
   * silently render a placeholder-looking label for a real selection.
   */
  valueLabel: string;
  onChange: (id: string, label: string) => void;
  /**
   * Show the "Create new customer" row (and let a search term drop into the create form).
   * Defaults to `true` so every existing caller keeps today's behaviour byte-identical.
   * Pass `false` for a picker that must offer existing customers only - e.g. the Event
   * dialog's participants field, where the product owner asked for no inline create.
   */
  allowCreate?: boolean;
}

export function CustomerPickerWithCreate({ value, valueLabel, onChange, allowCreate = true }: CustomerPickerWithCreateProps) {
  const ability = useAppAbility();
  const canCreate = allowCreate && ability.can('create', 'Customer');
  const { toast } = useToast();
  const qc = useQueryClient();

  // Per-instance DOM ids: this component lives in components/shared and may be mounted
  // more than once on a page, and duplicate ids would silently cross-wire the labels.
  // Colons are stripped from React's `useId` output so the ids stay CSS-selector-safe.
  const uid = useId().replace(/:/g, '');
  const fieldId = (name: string) => `${uid}-${name}`;

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'search' | 'create'>('search');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // create-form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [loc, setLoc] = useState<PickOrAccreteLocationValue>({ locationId: ADD_NEW_LOCATION, address: EMPTY_ADDRESS });
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<ExistingCustomer | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({ email: false, phone: false });
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // This picker is opened from inside a modal Dialog (e.g. New Service Plan). Radix's
  // Dialog locks page-wide wheel scrolling (`react-remove-scroll`) while open, and this
  // Popover's results list is portalled as a sibling of the Dialog's own content — not a
  // descendant — so it's caught by that lock too: the browser's native scroll on this div
  // never fires. React's `onWheel` prop can't work around it either, since React attaches
  // wheel listeners passively and `preventDefault()` inside one is a silent no-op.
  //
  // A callback ref (not a `useEffect` keyed on `open`/`mode`) is required here: Radix mounts
  // the popover content's children a tick after `open` flips true (its own presence/animation
  // machinery), so an effect keyed on `open`/`mode` still sees a null ref when it runs. The
  // callback ref fires exactly when this div actually mounts/unmounts, so it can't miss it.
  const attachResults = useCallback((el: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // deltaY is only already in pixels when deltaMode is DOM_DELTA_PIXEL (0). Firefox in
      // particular can report DOM_DELTA_LINE (1) for wheel/trackpad input, where deltaY is a
      // small line count — scale it to a pixel-ish amount so the scroll speed doesn't feel stuck.
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      el.scrollTop += delta;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanupRef.current = () => el.removeEventListener('wheel', onWheel);
  }, []);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['customer-picker-search', debouncedQ],
    queryFn: async () => {
      const { data } = await api.get('/api/customers', { params: { search: debouncedQ || undefined, limit: 15 } });
      return data.customers as CustomerLite[];
    },
    enabled: open && mode === 'search',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const customers = data ?? [];

  const resetCreate = () => {
    setFirstName(''); setLastName(''); setCompanyName(''); setPhone(''); setEmail('');
    setLoc({ locationId: ADD_NEW_LOCATION, address: EMPTY_ADDRESS });
    setDup(null); setDupMatched({ email: false, phone: false });
  };
  const close = () => { setOpen(false); setMode('search'); setQ(''); resetCreate(); };

  const startCreate = () => {
    const query = q.trim();
    resetCreate();
    // Only treat the query as a phone number when it actually looks like one: enough digits
    // for a real number AND no letters. A loose digit count misfires on names that merely
    // contain digits — "A1 Garage Doors 24" would seed Phone with "(124) " and leave the
    // name blank.
    const looksLikePhone = query.replace(/\D/g, '').length >= 7 && !/[a-z]/i.test(query);
    if (query.includes('@')) setEmail(query);
    else if (looksLikePhone) setPhone(formatPhoneInput(query));
    else if (query) setFirstName(query);
    setMode('create');
  };

  const identityOk = (firstName.trim() !== '' || companyName.trim() !== '') && (phone.trim() !== '' || email.trim() !== '');
  const canSave = identityOk && addressComplete(loc.address) && !saving;

  async function createCustomer(override = false) {
    setSaving(true);
    const a = loc.address;
    try {
      const { data } = await api.post(override ? '/api/customers?override=true' : '/api/customers', {
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        company_name: companyName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        locations: [{
          address_line1: a.address_line1.trim(),
          ...(a.address_line2.trim() ? { address_line2: a.address_line2.trim() } : {}),
          city: a.city.trim(), state: a.state.trim(), zip: a.zip.trim(), is_primary: true,
        }],
      });
      const created = data.customer as CustomerLite;
      qc.invalidateQueries({ queryKey: ['customers'] });
      // …and this picker's own search cache, or the customer just created stays missing
      // from its results for `staleTime` (30s).
      qc.invalidateQueries({ queryKey: ['customer-picker-search'] });
      onChange(created.id, customerLabel(created));
      close();
    } catch (err) {
      const d = getDuplicateCustomer(err);
      if (d) { setDup(d); setDupMatched(computeMatchedCustomerFields({ email, phone }, d)); }
      else toast({ title: 'Could not create customer', description: extractApiError(err, 'Please try again.'), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        {/* type="button": Button has no default type, so it would submit a host form. */}
        <Button type="button" variant="outline" className="w-full justify-between font-normal">
          <span className="truncate">{value ? valueLabel : 'Select customer'}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] p-2"
        // The duplicate dialog is a modal Dialog rendered outside this popover's content
        // tree, so its mount/auto-focus reads as an outside interaction and would dismiss
        // the popover — taking the dialog down with it. `saving` is held too, so the guard
        // doesn't go cold between "Create anyway" clearing `dup` and the override POST
        // settling (both batch into one render).
        onInteractOutside={(e) => { if (dup || saving) e.preventDefault(); }}
      >
        {mode === 'search' ? (
          <>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <Input autoFocus aria-label="Search customers" placeholder="Search name, company, phone, email…" value={q}
                onChange={(e) => setQ(e.target.value)} className="h-9 pl-8" />
            </div>
            <div ref={attachResults} className="max-h-60 overflow-y-auto">
              {isFetching && customers.length === 0 && (
                <p className="flex items-center gap-2 px-2 py-2 text-sm text-text-secondary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                </p>
              )}
              {isError && (
                <p className="px-2 py-2 text-sm text-danger">Couldn't load customers. Try again.</p>
              )}
              {!isFetching && !isError && customers.length === 0 && (
                <EmptyState density="flush" title="No matches" />
              )}
              {customers.map((c) => {
                const { primary, details } = customerRow(c);
                return (
                  // Dropdown-menu-item result row, not Button-shaped - left raw.
                  <button key={c.id} type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-background-light"
                    onClick={() => { onChange(c.id, customerLabel(c)); close(); }}>
                    <span className="block truncate">{primary}</span>
                    {details && <span className="block truncate text-xs text-text-secondary">{details}</span>}
                  </button>
                );
              })}
            </div>
            {canCreate && (
              // Dropdown-menu-item action row (part of the same result-list stack above), not
              // Button-shaped - left raw.
              <button type="button"
                className="mt-2 flex w-full items-center gap-2 rounded border-t border-border px-2 py-2 text-left text-sm font-medium text-primary hover:bg-primary/5"
                onClick={startCreate}>
                <Plus className="h-4 w-4" /> Create {q.trim() ? `"${q.trim()}"` : 'new customer'}
              </button>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-text-primary">New customer</p>
            <div className="grid grid-cols-2 gap-2">
              <FormField label="First name" htmlFor={fieldId('first')}>
                <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </FormField>
              <FormField label="Last name" htmlFor={fieldId('last')}>
                <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Company" htmlFor={fieldId('company')}>
              <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </FormField>
            <div className="grid grid-cols-2 gap-2">
              <FormField label="Phone" htmlFor={fieldId('phone')}>
                <Input inputMode="tel" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} />
              </FormField>
              <FormField label="Email" htmlFor={fieldId('email')}>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
            </div>
            <p className="text-xs text-text-secondary">Provide a phone or an email.</p>
            <PickOrAccreteLocation locations={[]} showPicker={false} required label="Service address" value={loc} onChange={setLoc} idPrefix={fieldId('address')} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setMode('search')} disabled={saving}>Back</Button>
              <Button type="button" variant="solid" tone="business" size="sm" onClick={() => createCustomer(false)} disabled={!canSave}>
                {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Create &amp; select
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
      <DuplicateCustomerDialog
        open={Boolean(dup)}
        existing={dup}
        matchedFields={dupMatched}
        onOpenExisting={() => {
          // #1996 — a redacted match carries no name/company to build a label from, and the
          // requester cannot read that record anyway; dismiss without selecting it.
          if (dup && !isRedactedMatch(dup)) onChange(dup.id, customerLabel(dup));
          setDup(null);
          close();
        }}
        onEditField={() => setDup(null)}
        onCreateAnyway={() => { setDup(null); createCustomer(true); }}
        onClose={() => setDup(null)}
        isOverriding={saving}
      />
    </Popover>
  );
}
