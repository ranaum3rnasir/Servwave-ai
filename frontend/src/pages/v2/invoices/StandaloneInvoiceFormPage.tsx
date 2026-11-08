import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import api from '@/lib/axios';
import { formatCurrency, extractApiError, formatPhoneInput, formatTaxRatePercent } from '@/lib/utils';
import { isRedactedMatch, type ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import {
  type PickCustomer,
  type CustomerContactFields,
  type CustomerContactField,
  getDuplicateCustomer,
  computeMatchedCustomerFields,
} from '@/components/crm/PickOrCreateCustomer';
import {
  ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue,
  type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
import { LineItemsEditor, blankLineItem, type LineItem } from '@/components/crm/LineItemsEditor';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';

import { v2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
// The kit rebuilds of the two legacy pickers, built for the leads module and
// PROP-COMPATIBLE with `crm/PickOrCreateCustomer` / `crm/PickOrAccreteLocation`
// (they import the originals' own types and duplicate-guard helpers). Imported
// rather than re-implemented so the duplicate-customer contract - issues #259
// and #267 - has one implementation, not two.
import { PickCustomerFields } from '../_shared/pickCustomer';
import { PickLocation } from '../_shared/pickLocation';

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

/** Pick the customer's primary location id (fallback: first), or '' if none. */
function defaultLocationId(customer: PickCustomer): string {
  const locs = customer.service_locations ?? [];
  const primary = locs.find((l) => l.is_primary) ?? locs[0];
  return primary?.id ?? '';
}

/** The label that opens each unframed sidebar section. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {children}
    </p>
  );
}

/**
 * The totals preview. Rendered in the sidebar on desktop and below the line
 * items on mobile - never both, see the media-query note on the page.
 *
 * Unframed: it used to be a third `<Card>` stacked under two others in a 300px
 * rail, which is what made the column read as a wall of boxes. A hairline above
 * the Total row is all the separation a four-line summary needs.
 */
function TotalsSummary({
  subtotal, taxAmount, total, taxExempt, previewTaxRate, showHint,
}: {
  subtotal: number;
  taxAmount: number | null;
  total: number | null;
  taxExempt: boolean;
  previewTaxRate: number | null;
  showHint: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Summary</SectionLabel>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">Subtotal</span>
        <span className="font-medium tabular-nums">{formatCurrency(subtotal)}</span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">
          {taxExempt
            ? 'Tax (exempt)'
            : previewTaxRate != null
              ? `Tax (${formatTaxRatePercent(previewTaxRate)}%)`
              : 'Tax'}
        </span>
        <span className="font-medium tabular-nums">
          {taxAmount != null ? formatCurrency(taxAmount) : '-'}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between border-t pt-3">
        <span className="font-semibold">Total</span>
        <span className="text-lg font-bold tabular-nums">
          {total != null ? formatCurrency(total) : formatCurrency(subtotal)}
        </span>
      </div>
      {showHint && (
        <p className="text-muted-foreground text-xs">
          Tax is calculated from the service location on save.
        </p>
      )}
    </div>
  );
}

/**
 * /v2/invoices/new - standalone invoice authoring on the CRM UI kit.
 *
 * Author owned line items on an invoice with no estimate or job to snapshot
 * from. Customer-anchored: pick or create a customer, pick or accrete a service
 * location (which drives tax), author lines, submit. THE SERVER IS
 * AUTHORITATIVE for tax and totals - everything computed here is a preview and
 * deliberately mirrors the backend's `computeOwnedLineTotals`, which has no
 * discount support. ADMIN + DISPATCHER only, matching the backend 403.
 *
 * Two behaviours below are load-bearing and are NOT presentation:
 *
 *  - `isBelowLg` mounts EXACTLY ONE of the two layouts. The customer block must
 *    never be rendered twice behind CSS `hidden lg:block`, because the
 *    duplicate-customer dialog portals to <body> and two copies would produce
 *    duplicate `#email` / `#phone` ids and two stacked dialogs (#259).
 *  - `noValidate` on the form. The quantity input carries a native `min`, and
 *    without it the browser bubble preempts onSubmit and hides the inline
 *    "Quantity must be greater than 0" message (#260).
 */
export default function StandaloneInvoiceFormPage() {
  useRecordVisit('invoices', 'New Invoice');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const isBelowLg = useMediaQuery('(max-width: 1023.98px)');

  // -- Customer -------------------------------------------------------------
  const [contact, setContact] = useState<CustomerContactFields>(EMPTY_CONTACT);
  const [selectedCustomer, setSelectedCustomer] = useState<PickCustomer | null>(null);
  const selectedCustomerId = selectedCustomer?.id ?? null;

  // -- Duplicate-customer guard ---------------------------------------------
  const [dupExisting, setDupExisting] = useState<ExistingCustomer | null>(null);
  const [dupMatched, setDupMatched] = useState<{ email: boolean; phone: boolean }>({
    email: false,
    phone: false,
  });
  const [openingExisting, setOpeningExisting] = useState(false);

  // -- Location -------------------------------------------------------------
  const [locationValue, setLocationValue] = useState<PickOrAccreteLocationValue>(EMPTY_LOCATION);

  // -- Line items -----------------------------------------------------------
  const [lineItems, setLineItems] = useState<LineItem[]>([blankLineItem()]);
  const [lineErrors, setLineErrors] = useState<(string | undefined)[]>([]);

  // -- Tax-rate reference (location-driven; preview only) --------------------
  const { data: taxRatesData } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: async () => {
      const { data } = await api.get('/api/state-tax-rates');
      return data.data as StateTaxRate[];
    },
  });

  // Memoised on the customer rather than re-defaulted to a fresh `[]` on every
  // render, so the tax-preview useMemo below is not invalidated every pass.
  const customerLocations: ServiceLocationOption[] = useMemo(
    () => selectedCustomer?.service_locations ?? [],
    [selectedCustomer],
  );

  // The customer-search payload omits tax_exempt, so a customer picked from the
  // dropdown would otherwise preview as taxed even when exempt.
  // #2041 slice 1 - repointed to the org-wide picker's expand endpoint (Ran's carve-out;
  // slice-1.md's "Expand calls" list). The picker projection now carries `tax_exempt` on a
  // readable row (it's a flag, not contact data), so this compensation still works.
  const { data: selectedCustomerDetail } = useQuery({
    queryKey: ['customer', selectedCustomerId, 'tax_exempt'],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/picker/${selectedCustomerId}`);
      return (data.customer ?? {}) as { tax_exempt?: boolean };
    },
    enabled: Boolean(selectedCustomerId),
  });
  const taxExempt = Boolean(selectedCustomerDetail?.tax_exempt ?? selectedCustomer?.tax_exempt);

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
    if (!resolvedState) return null; // unknown - server will resolve on save
    const rate = taxRatesData?.find(
      (r) => r.state_code.toLowerCase() === resolvedState.toLowerCase(),
    );
    return rate ? Number(rate.tax_rate) : null;
  }, [taxExempt, resolvedState, taxRatesData]);

  // -- Totals (preview - mirrors backend computeOwnedLineTotals: no discounts)
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

  // -- Build the standalone POST body ---------------------------------------
  const buildPayload = () => {
    // Map LineItemsEditor's {name, detail} -> API {description}; coerce numbers;
    // drop blank rows (no name AND no price).
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

    // Location -> API: real id => { service_location_id }; '__add_new__' =>
    // { address }; none => omit (server defaults to the customer's primary).
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

  // -- Create-customer mutation ---------------------------------------------
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

  // -- Create-invoice mutation ----------------------------------------------
  const createInvoice = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/api/invoices', buildPayload());
      return data.invoice as { id: string };
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(v2Path(`/invoices/${invoice.id}`));
    },
  });

  // -- Customer helpers -----------------------------------------------------
  const selectCustomer = (c: PickCustomer) => {
    setSelectedCustomer(c);
    setContact({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      company_name: c.company_name || '',
      phone: formatPhoneInput(c.phone || ''),
      email: c.email || '',
    });
    // Default the location to the customer's primary (or force the add-new form
    // if none).
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

  // Resolving the duplicate-customer guard must ALSO reset the failed
  // create-customer request: the 409 leaves createCustomer in isError, and the
  // bottom error region renders on
  // (createInvoice.isError || createCustomer.isError) && !dupExisting - so once
  // dupExisting clears, the stale "duplicate" 409 would reappear (#267).
  const dismissDuplicate = () => {
    setDupExisting(null);
    createCustomer.reset();
  };

  const handleFieldChange = (field: CustomerContactField, value: string) => {
    setContact((prev) => ({ ...prev, [field]: value }));
    // Editing a field after picking an existing customer drops back to
    // new-customer mode.
    if (selectedCustomerId) clearSelectedCustomer();
  };

  // Dialog: "Open existing customer" -> fetch the full record (for
  // service_locations) then select it.
  const handleOpenExisting = async () => {
    if (!dupExisting || openingExisting) return;
    const target = dupExisting;
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
      // Fall back to a minimal record so the invoice still attaches to the
      // existing customer.
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

  // Dialog: "Edit email/phone" -> close + focus the offending input.
  const handleEditField = (field: 'email' | 'phone') => {
    dismissDuplicate();
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };

  // Dialog: "Create anyway" -> resubmit the customer create with override.
  const handleCreateAnyway = () => {
    createCustomer.mutate({ override: true });
  };

  const isOverriding = (createCustomer.isPending && Boolean(dupExisting)) || openingExisting;

  // -- Submit ---------------------------------------------------------------
  const handleSubmit = () => {
    // Need a customer first: pick one, or create the authored one inline.
    if (!selectedCustomerId) {
      createCustomer.mutate({});
      return;
    }
    // Validate at least one non-blank line with a name. A "kept" (non-blank)
    // line mirrors buildPayload's filter (name OR price); it needs a name, and
    // a quantity > 0 (the backend zod is z.number().positive(), so a blank/0
    // qty 400s opaquely).
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

  const customerBlock = (
    <PickCustomerFields
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
  );

  return (
    <div>
      <PageHeader
        title="New Invoice"
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" form="standalone-invoice-form" disabled={submitting}>
              {submitting && <Loader2 className="animate-spin" />}
              {selectedCustomerId ? 'Create Invoice' : 'Continue'}
            </Button>
          </>
        }
      />

      <form
        id="standalone-invoice-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="flex items-start gap-8">
          {/* Sidebar (sticky) - customer + location + summary.
              NO CARDS. Three stacked bordered cards in a 300px rail is what the
              page read as "packed": every section paid a border and 36px of
              padding, and the two-up name fields inside the first one were the
              worst of it. The sections are the same, told apart now by a label
              and a wide gap instead of a frame, and the rail is wider so the
              paired fields stop crowding each other. */}
          {!isBelowLg && (
            <aside className="sticky top-4 flex w-[320px] shrink-0 flex-col gap-8">
              <div className="flex flex-col gap-3">
                <SectionLabel>Customer</SectionLabel>
                {customerBlock}
              </div>

              {selectedCustomer && (
                <div className="flex flex-col gap-3">
                  <SectionLabel>Service Location</SectionLabel>
                  <PickLocation
                    locations={customerLocations}
                    showPicker
                    label="Location"
                    value={locationValue}
                    onChange={setLocationValue}
                    pickerNote={
                      <p className="text-muted-foreground mt-1 text-xs">
                        Tax is calculated from this service location on save.
                      </p>
                    }
                  />
                </div>
              )}

              <TotalsSummary
                subtotal={totals.subtotal}
                taxAmount={totals.taxAmount}
                total={totals.total}
                taxExempt={taxExempt}
                previewTaxRate={previewTaxRate}
                showHint={!taxExempt && previewTaxRate == null}
              />
            </aside>
          )}

          {/* Main area */}
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {isBelowLg && (
              // Same unframing as the desktop rail: sections, not cards.
              <div className="flex flex-col gap-8">
                <div className="flex flex-col gap-3">
                  <SectionLabel>Customer</SectionLabel>
                  {customerBlock}
                </div>
                {selectedCustomer && (
                  <div className="flex flex-col gap-3">
                    <SectionLabel>Service Location</SectionLabel>
                    <PickLocation
                      locations={customerLocations}
                      showPicker
                      label="Location"
                      value={locationValue}
                      onChange={setLocationValue}
                    />
                  </div>
                )}
              </div>
            )}

            {!selectedCustomer ? (
              // An empty hint, not an empty box - a bordered card holding one
              // sentence was the emptiest frame on the page.
              <p className="text-muted-foreground py-10 text-center text-sm">
                Select or create a customer to start adding line items.
              </p>
            ) : (
              <>
                {lineErrors.some(Boolean) && (
                  <p className="text-destructive text-xs">{lineErrors.find(Boolean)}</p>
                )}
                <LineItemsEditor
                  value={lineItems}
                  onChange={setLineItems}
                  itemNameErrors={lineErrors}
                />
              </>
            )}

            {isBelowLg && (
              <TotalsSummary
                subtotal={totals.subtotal}
                taxAmount={totals.taxAmount}
                total={totals.total}
                taxExempt={taxExempt}
                previewTaxRate={previewTaxRate}
                showHint={false}
              />
            )}
          </div>
        </div>

        {(createInvoice.isError || createCustomer.isError) && !dupExisting && (
          <p className="text-destructive mt-2 text-sm">
            {extractApiError(createInvoice.error ?? createCustomer.error, 'Failed to create invoice')}
          </p>
        )}
      </form>
    </div>
  );
}
