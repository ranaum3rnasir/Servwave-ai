import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { Heading } from '@/components/ui/heading';
import { Loader2, Receipt } from 'lucide-react';
import { cn, formatCurrency, extractApiError, formatPhoneInput, formatTaxRatePercent } from '@/lib/utils';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import {
  PickOrCreateCustomer,
  type PickCustomer,
  type CustomerContactFields,
  type CustomerContactField,
  getDuplicateCustomer,
  computeMatchedCustomerFields,
} from '@/components/crm/PickOrCreateCustomer';
import {
  PickOrAccreteLocation,
  ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue,
  type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
import {
  LineItemsEditor,
  blankLineItem,
  type LineItem,
} from '@/components/crm/LineItemsEditor';
import { useMediaQuery } from '@/hooks/useIsMobile';

// ─── Types ──────────────────────────────────────────

interface StateTaxRate {
  state_code: string;
  state_name: string;
  tax_rate: number;
}

const EMPTY_CONTACT: CustomerContactFields = {
  first_name: '',
  last_name: '',
  company_name: '',
  phone: '',
  email: '',
};

const EMPTY_LOCATION: PickOrAccreteLocationValue = {
  locationId: '',
  address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
};

// Pick the customer's primary location id (fallback: first), or '' if none.
function defaultLocationId(customer: PickCustomer): string {
  const locs = customer.service_locations ?? [];
  const primary = locs.find((l) => l.is_primary) ?? locs[0];
  return primary?.id ?? '';
}

// ─── Component ──────────────────────────────────────
//
// Standalone Invoice — author owned line items on an invoice with no
// estimate/job to snapshot from (standalone-invoices plan §3, slice 4). One
// capability, full-page authoring surface. Customer-
// anchored: pick/create a customer → pick/accrete a service location (drives
// tax, Design A) → author lines → submit. Server is authoritative for tax/
// totals. ADMIN + DISPATCHER only (matches the backend 403 + CASL grant).

export default function StandaloneInvoiceFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The form uses a two-up layout at `lg` (sticky sidebar + main) and stacks below it.
  // Mount the customer/location/totals block in EXACTLY ONE of the two layouts via this JS
  // gate rather than shipping both behind CSS `hidden lg:block` / `lg:hidden`: PickOrCreateCustomer's
  // Radix duplicate-customer dialog portals to <body>, so CSS can't suppress the second copy and
  // two stacked dialogs (with duplicate #email/#phone IDs) would render (#259). This gate is the
  // single source of truth for which layout is in the DOM; in jsdom matchMedia is mocked false →
  // the desktop sidebar variant renders.
  const isBelowLg = useMediaQuery('(max-width: 1023.98px)');

  // ── Customer (controlled, mirrors CreateLeadForm) ──
  const [contact, setContact] = useState<CustomerContactFields>(EMPTY_CONTACT);
  const [selectedCustomer, setSelectedCustomer] = useState<PickCustomer | null>(null);
  const selectedCustomerId = selectedCustomer?.id ?? null;

  // ── Duplicate-customer guard ──
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({
    email: false,
    phone: false,
  });
  const [openingExisting, setOpeningExisting] = useState(false);

  // ── Location ──
  const [locationValue, setLocationValue] = useState<PickOrAccreteLocationValue>(EMPTY_LOCATION);

  // ── Line items ──
  const [lineItems, setLineItems] = useState<LineItem[]>([blankLineItem()]);
  const [lineErrors, setLineErrors] = useState<(string | undefined)[]>([]);

  // ── Tax-rate reference (Design A — location-driven; preview only, server authoritative) ──
  const { data: taxRatesData } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: async () => {
      const { data } = await api.get('/api/state-tax-rates');
      return data.data as StateTaxRate[];
    },
  });

  const customerLocations: ServiceLocationOption[] = selectedCustomer?.service_locations ?? [];

  // The customer-search payload (PickCustomer) omits tax_exempt, so a customer picked
  // from the dropdown would otherwise preview as taxed even when exempt. Fetch the
  // customer detail (GET /api/customers/:id returns tax_exempt) so the preview is
  // correct before save. Falls back to any tax_exempt already on the selected object
  // (e.g. the "open existing" path already fetches the full record).
  const { data: selectedCustomerDetail } = useQuery({
    queryKey: ['customer', selectedCustomerId, 'tax_exempt'],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${selectedCustomerId}`);
      return (data.customer ?? {}) as { tax_exempt?: boolean };
    },
    enabled: Boolean(selectedCustomerId),
  });
  const taxExempt = Boolean(
    selectedCustomerDetail?.tax_exempt ??
      (selectedCustomer as { tax_exempt?: boolean } | null)?.tax_exempt,
  );

  // Resolve the chosen location's state for the tax preview.
  const resolvedState = useMemo(() => {
    if (locationValue.locationId && locationValue.locationId !== ADD_NEW_LOCATION) {
      const loc = customerLocations.find((l) => l.id === locationValue.locationId);
      return loc?.state ?? null;
    }
    if (locationValue.locationId === ADD_NEW_LOCATION) {
      return locationValue.address.state || null;
    }
    return null;
  }, [locationValue, customerLocations]);

  const previewTaxRate = useMemo(() => {
    if (taxExempt) return 0;
    if (!resolvedState) return null; // unknown — server will resolve on save
    const rate = taxRatesData?.find(
      (r) => r.state_code.toLowerCase() === resolvedState.toLowerCase(),
    );
    return rate ? Number(rate.tax_rate) : null;
  }, [taxExempt, resolvedState, taxRatesData]);

  // ── Totals (preview — mirrors backend computeOwnedLineTotals: no discounts) ──
  const totals = useMemo(() => {
    let subtotal = 0;
    let taxableSubtotal = 0;
    for (const item of lineItems) {
      const qty = Number(item.quantity) || 0;
      const price = Number(item.unit_price) || 0;
      const lineTotal = Math.round(qty * price * 100) / 100;
      subtotal += lineTotal;
      if (item.is_taxable) taxableSubtotal += lineTotal;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    taxableSubtotal = Math.round(taxableSubtotal * 100) / 100;
    const taxAmount = previewTaxRate != null ? Math.round(taxableSubtotal * previewTaxRate * 100) / 100 : null;
    const total = taxAmount != null ? Math.round((subtotal + taxAmount) * 100) / 100 : null;
    return { subtotal, taxableSubtotal, taxAmount, total };
  }, [lineItems, previewTaxRate]);

  // ── Build the standalone POST body ──
  const buildPayload = () => {
    // Map LineItemsEditor's {name, detail} → API {description}; coerce numbers; drop blank rows
    // (no name AND no price). Same submit mapping the other line-item authoring surfaces use.
    const line_items = lineItems
      .filter((li) => li.name.trim() !== '' || (Number(li.unit_price) || 0) > 0)
      .map((li) => ({
        description: li.detail ? `${li.name}\n${li.detail}` : li.name,
        quantity: Number(li.quantity) || 0,
        unit_price: Number(li.unit_price) || 0,
        is_taxable: li.is_taxable,
        item_type: li.item_type,
        ...(li.price_book_item_id ? { price_book_item_id: li.price_book_item_id } : {}),
      }));

    // Location → API: real id ⇒ { service_location_id }; '__add_new__' ⇒ { address }; none ⇒
    // omit (server defaults to the customer's primary).
    let location: { service_location_id: string } | { address: Record<string, string> } | Record<string, never> = {};
    if (locationValue.locationId && locationValue.locationId !== ADD_NEW_LOCATION) {
      location = { service_location_id: locationValue.locationId };
    } else if (locationValue.locationId === ADD_NEW_LOCATION && locationValue.address.address_line1.trim()) {
      location = {
        address: {
          address_line1: locationValue.address.address_line1,
          ...(locationValue.address.address_line2 ? { address_line2: locationValue.address.address_line2 } : {}),
          city: locationValue.address.city,
          state: locationValue.address.state,
          zip: locationValue.address.zip,
        },
      };
    }

    return { customer_id: selectedCustomerId!, line_items, ...location };
  };

  // ── Create-customer mutation (inline "create new" — mirrors LeadFormPage) ──
  const createCustomer = useMutation({
    mutationFn: async ({ override }: { override?: boolean }) => {
      const { data } = await api.post(
        override ? '/api/customers?override=true' : '/api/customers',
        {
          first_name: contact.first_name || undefined,
          last_name: contact.last_name || undefined,
          company_name: contact.company_name || undefined,
          email: contact.email,
          phone: contact.phone,
        },
      );
      return data.customer as PickCustomer;
    },
    onSuccess: (customer) => {
      setDupExisting(null);
      setDupMatched({ email: false, phone: false });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      selectCustomer(customer);
    },
    onError: (err: unknown) => {
      const dup = getDuplicateCustomer(err);
      if (dup) {
        setDupExisting(dup);
        setDupMatched(computeMatchedCustomerFields({ email: contact.email, phone: contact.phone }, dup));
      }
    },
  });

  // ── Create-invoice mutation ──
  const createInvoice = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/api/invoices', buildPayload());
      return data.invoice as { id: string };
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices/${invoice.id}`);
    },
  });

  // ── Customer helpers ──
  const selectCustomer = (c: PickCustomer) => {
    setSelectedCustomer(c);
    setContact({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      company_name: c.company_name || '',
      phone: formatPhoneInput(c.phone || ''),
      email: c.email || '',
    });
    // Default the location to the customer's primary (or force the add-new form if none).
    const locId = defaultLocationId(c);
    if (locId) {
      const loc = (c.service_locations ?? []).find((l) => l.id === locId)!;
      setLocationValue({
        locationId: locId,
        address: {
          address_line1: loc.address_line1,
          address_line2: loc.address_line2 || '',
          city: loc.city,
          state: loc.state,
          zip: loc.zip,
        },
      });
    } else {
      setLocationValue({
        locationId: ADD_NEW_LOCATION,
        address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
      });
    }
  };

  const clearSelectedCustomer = () => {
    setSelectedCustomer(null);
    setLocationValue(EMPTY_LOCATION);
  };

  // Resolving the duplicate-customer guard must ALSO reset the failed create-customer
  // request: the 409 leaves createCustomer in isError, and the bottom error region renders
  // on (createInvoice.isError || createCustomer.isError) && !dupExisting — so once dupExisting
  // clears, the stale "duplicate" 409 would reappear (#267). reset() clears it at the source.
  const dismissDuplicate = () => {
    setDupExisting(null);
    createCustomer.reset();
  };

  const handleFieldChange = (field: CustomerContactField, value: string) => {
    setContact((prev) => ({ ...prev, [field]: value }));
    // Editing a field after picking an existing customer drops back to new-customer mode.
    if (selectedCustomerId) clearSelectedCustomer();
  };

  // Dialog: "Open existing customer" → fetch the full record (for service_locations) then select it.
  const handleOpenExisting = async () => {
    if (!dupExisting || openingExisting) return;
    const target = dupExisting;
    setOpeningExisting(true);
    try {
      const { data } = await api.get(`/api/customers/${target.id}`);
      selectCustomer(data.customer as PickCustomer);
    } catch {
      // #1996 — a redacted match carries no first_name/last_name/company_name/phone/email to
      // build a fallback from, and the requester cannot read the real record either; bail
      // without selecting a customer.
      if (isRedactedMatch(target)) return;
      // Fall back to a minimal record so the invoice still attaches to the existing customer.
      selectCustomer({
        id: target.id,
        first_name: target.first_name || '',
        last_name: target.last_name || '',
        company_name: target.company_name,
        phone: target.phone || '',
        email: target.email,
        service_locations: [],
      });
    } finally {
      setOpeningExisting(false);
      dismissDuplicate();
    }
  };

  // Dialog: "Edit email/phone" → close + focus the offending input.
  const handleEditField = (field: 'email' | 'phone') => {
    dismissDuplicate();
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // Dialog: "Create anyway" → resubmit the customer create with override.
  const handleCreateAnyway = () => {
    createCustomer.mutate({ override: true });
  };

  const isOverriding = (createCustomer.isPending && Boolean(dupExisting)) || openingExisting;

  // ── Submit ──
  const handleSubmit = () => {
    // Need a customer first: pick one, or create the authored one inline.
    if (!selectedCustomerId) {
      createCustomer.mutate({});
      return;
    }
    // Validate at least one non-blank line with a name. A "kept" (non-blank) line
    // mirrors buildPayload's filter (name OR price); it needs a name, and a quantity
    // > 0 (the backend zod is z.number().positive(), so a blank/0 qty 400s opaquely).
    const errs = lineItems.map((li) => {
      const kept = li.name.trim() !== '' || (Number(li.unit_price) || 0) > 0;
      if (li.name.trim() === '' && (Number(li.unit_price) || 0) > 0) return 'Required';
      if (kept && li.name.trim() !== '' && !(Number(li.quantity) > 0)) return 'Quantity must be greater than 0';
      return undefined;
    });
    const hasNamedLine = lineItems.some((li) => li.name.trim() !== '');
    if (!hasNamedLine || errs.some(Boolean)) {
      setLineErrors(errs.map((e, i) => e ?? (!hasNamedLine && i === 0 ? 'Add at least one line item' : undefined)));
      return;
    }
    setLineErrors([]);
    createInvoice.mutate();
  };

  const submitting = createInvoice.isPending || (createCustomer.isPending && !dupExisting);

  return (
    <div className="space-y-4">
      <Breadcrumb
        items={[
          { label: 'Invoices', href: '/invoices' },
          { label: 'New Invoice' },
        ]}
      />

      <div className="flex items-center justify-between">
        <Heading level={1} className="flex items-center gap-2">
          <Receipt className="h-5 w-5 shrink-0 text-primary" />
          New Invoice
        </Heading>
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button variant="solid" tone="business" type="submit" form="standalone-invoice-form" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {selectedCustomerId ? 'Create Invoice' : 'Continue'}
          </Button>
        </div>
      </div>

      {/* noValidate: handleSubmit owns ALL validation. Without it, the qty Input's native
          min="0.01" (LineItemsEditor) makes qty 0/blank :invalid and the browser bubble
          preempts onSubmit, shadowing the inline error "Quantity must be greater than 0".
          No required native constraints exist on this form (customer/location "required" is
          label-only), so this drops no real client validation. See #260. */}
      <form
        id="standalone-invoice-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="flex gap-4 items-start">
          {/* ─── Sidebar (sticky, 280px) — customer + location + summary ─── */}
          {!isBelowLg && (
          <div className="w-[300px] shrink-0 sticky top-4 space-y-4">
            <Card padding="sm" className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Customer</p>
              <PickOrCreateCustomer
                fields={contact}
                onFieldChange={handleFieldChange}
                selectedCustomer={selectedCustomer}
                onSelectCustomer={selectCustomer}
                required
                duplicate={dupExisting}
                duplicateMatchedFields={dupMatched}
                onUseExisting={handleOpenExisting}
                onEditField={handleEditField}
                onCreateAnyway={handleCreateAnyway}
                onDismissDuplicate={dismissDuplicate}
                isOverriding={isOverriding}
              />
            </Card>

            {selectedCustomer && (
              <Card padding="sm" className="space-y-3">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Service Location</p>
                <PickOrAccreteLocation
                  locations={customerLocations}
                  showPicker
                  label="Location"
                  value={locationValue}
                  onChange={setLocationValue}
                  pickerNote={
                    <p className="mt-1 text-xs text-text-secondary">
                      Tax is calculated from this service location on save.
                    </p>
                  }
                />
              </Card>
            )}

            {/* Totals */}
            <Card padding="sm" className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Subtotal</span>
                <span className="font-medium tabular-nums">{formatCurrency(totals.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">
                  {taxExempt
                    ? 'Tax (exempt)'
                    : previewTaxRate != null
                      ? `Tax (${formatTaxRatePercent(previewTaxRate)}%)`
                      : 'Tax'}
                </span>
                <span className="font-medium tabular-nums">
                  {totals.taxAmount != null ? formatCurrency(totals.taxAmount) : '—'}
                </span>
              </div>
              <div className="border-t pt-2 flex justify-between">
                <span className="font-semibold text-text-primary">Total</span>
                <span className="font-bold text-lg tabular-nums">
                  {totals.total != null ? formatCurrency(totals.total) : formatCurrency(totals.subtotal)}
                </span>
              </div>
              {!taxExempt && previewTaxRate == null && (
                <p className="text-xs text-text-secondary pt-1">
                  Tax is calculated from the service location on save.
                </p>
              )}
            </Card>
          </div>
          )}

          {/* ─── Main area ─── */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Mobile: customer + location */}
            {isBelowLg && (
            <Card padding="sm" className="space-y-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Customer</p>
              <PickOrCreateCustomer
                fields={contact}
                onFieldChange={handleFieldChange}
                selectedCustomer={selectedCustomer}
                onSelectCustomer={selectCustomer}
                required
                duplicate={dupExisting}
                duplicateMatchedFields={dupMatched}
                onUseExisting={handleOpenExisting}
                onEditField={handleEditField}
                onCreateAnyway={handleCreateAnyway}
                onDismissDuplicate={dismissDuplicate}
                isOverriding={isOverriding}
              />
              {selectedCustomer && (
                <>
                  <div className="border-t border-border pt-3">
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Service Location</p>
                  </div>
                  <PickOrAccreteLocation
                    locations={customerLocations}
                    showPicker
                    label="Location"
                    value={locationValue}
                    onChange={setLocationValue}
                  />
                </>
              )}
            </Card>
            )}

            {!selectedCustomer ? (
              <Card className="text-center">
                <p className="text-sm text-text-secondary">
                  Select or create a customer to start adding line items.
                </p>
              </Card>
            ) : (
              <>
                {lineErrors.some(Boolean) && (
                  <p className="text-xs text-danger">
                    {lineErrors.find(Boolean)}
                  </p>
                )}
                <LineItemsEditor
                  value={lineItems}
                  onChange={setLineItems}
                  itemNameErrors={lineErrors}
                />
              </>
            )}

            {/* Mobile totals */}
            {isBelowLg && (
            <Card padding="sm" className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Subtotal</span>
                <span className="font-medium tabular-nums">{formatCurrency(totals.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">
                  {taxExempt ? 'Tax (exempt)' : previewTaxRate != null ? `Tax (${formatTaxRatePercent(previewTaxRate)}%)` : 'Tax'}
                </span>
                <span className="font-medium tabular-nums">
                  {totals.taxAmount != null ? formatCurrency(totals.taxAmount) : '—'}
                </span>
              </div>
              <div className="border-t pt-2 flex justify-between">
                <span className="font-semibold">Total</span>
                <span className="font-bold text-lg tabular-nums">
                  {totals.total != null ? formatCurrency(totals.total) : formatCurrency(totals.subtotal)}
                </span>
              </div>
            </Card>
            )}
          </div>
        </div>

        {(createInvoice.isError || createCustomer.isError) && !dupExisting && (
          <p className="text-sm text-danger mt-2">
            {extractApiError(createInvoice.error ?? createCustomer.error, 'Failed to create invoice')}
          </p>
        )}
      </form>
    </div>
  );
}
