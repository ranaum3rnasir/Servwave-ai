import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Loader2 } from 'lucide-react';

import api from '@/lib/axios';
import { formatCurrency, extractApiError, formatTaxRatePercent } from '@/lib/utils';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { useUnappliedDetail } from '@/lib/api/paymentsPage';
import { postAttached } from '@/lib/paymentsChannel';
import { Alert } from '@/components/ui/alert';
import { phoneFieldValue } from '@/ui-kit/lib/phoneField';
import { useFormFlow } from '@/ui-kit/lib/formFlow';
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

type ContactErrors = Partial<Record<CustomerContactField, string>>;

/**
 * Mobile slice 38 (A11Y-07): the new customer's contact, checked before it is
 * sent, with the same rules and words as the lead and job forms
 * (lib/job-create-schema.ts). Without it an empty submit went to the server and
 * came back as one line at the foot of the page, with no field to land on.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function contactErrorsFor(c: CustomerContactFields): ContactErrors {
  const errs: ContactErrors = {};
  if (!c.first_name?.trim() && !c.company_name?.trim()) errs.first_name = 'Enter a first name or a company name';
  const phone = c.phone?.trim() ?? '';
  const email = c.email?.trim() ?? '';
  if (!phone && !email) errs.phone = 'Enter a phone number or an email';
  else if (phone && phone.length < 7) errs.phone = 'Enter a valid phone number';
  if (email && !EMAIL_SHAPE.test(email)) errs.email = 'Invalid email';
  return errs;
}

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
  phone_ext: '',
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

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A query-string id, or null: the address is typed by anyone, and an id is put into a request path. */
const idParam = (raw: string | null): string | null => (raw && ID_SHAPE.test(raw) ? raw : null);

const errorCode = (err: unknown): string | undefined => (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
const statusOf = (err: unknown): number | undefined => (err as { response?: { status?: number } } | null)?.response?.status;
const totalRefused0 = (err: unknown) => errorCode(err) === 'INVOICE_TOTAL_BELOW_PAYMENT';
const cents = (dollars: number) => Math.round(dollars * 100);
const PAYMENT_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const PRICE_ABOVE_ZERO = 'Enter a price above $0.00.';
const TOTAL_BELOW_PAYMENT = (amount: number) => `The invoice must be at least ${formatCurrency(amount)} so the payment fits.`;

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
  subtotal, taxAmount, total, taxExempt, previewTaxRate, showHint, paymentToRecord,
}: {
  subtotal: number;
  taxAmount: number | null;
  total: number | null;
  taxExempt: boolean;
  previewTaxRate: number | null;
  showHint: boolean;
  /** Capture mode: the payment this invoice will record, already worded. */
  paymentToRecord?: string;
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
      {paymentToRecord && (
        <dl className="flex flex-col gap-0.5 border-t pt-3 text-sm">
          <dt className="text-muted-foreground">Payment to record</dt>
          <dd className="font-medium tabular-nums">{paymentToRecord}</dd>
        </dl>
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
 * discount support. Opens on Standalone invoices (the route
 * guard); the backend decides the create on Standalone invoices.
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
  const tz = useScheduleTimezone();

  // -- Opened from elsewhere (read once) --------------------------------------
  // `customer_id`: the customer page's "new invoice" link and the Payments drawer's "Create invoice" both land here with
  // the customer chosen. `unapplied_payment_id`: capture mode, the invoice records that unapplied payment when saved.
  const [searchParams] = useSearchParams();
  const [customerParam] = useState(() => idParam(searchParams.get('customer_id')));
  const [captureParam] = useState(() => idParam(searchParams.get('unapplied_payment_id')));

  const captureRead = useUnappliedDetail(captureParam ? `unmatched_payment:${captureParam}` : null);
  // Only a payment that is still open, and that this person may create an invoice for, turns the mode on. Anything else
  // (gone, resolved, a refund, no right to) renders the normal page without a word.
  const capture = useMemo(() => {
    const d = captureRead.data;
    if (!captureParam || !d) return null;
    const usable = d.kind === 'PAYMENT' && d.status === 'open' && !d.restricted && d.actions.includes('create_invoice')
      && d.amount != null && d.amount > 0;
    return usable ? { amount: d.amount as number, receivedAt: d.payer?.received_at ?? d.created_at, description: d.payer?.description?.trim() || null, card: d.payer?.detail ?? null } : null;
  }, [captureParam, captureRead.data]);
  // Until the payment has been read (or failed to be), the page cannot know whether this is a capture: no Save yet.
  const captureSettling = Boolean(captureParam) && captureRead.isPending;
  const captureDay = capture ? formatInstant(capture.receivedAt, tz, PAYMENT_DAY) : null;
  const paymentToRecord = capture
    ? [formatCurrency(capture.amount), capture.card, captureDay].filter(Boolean).join(' · ')
    : undefined;

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
  // Capture mode: the price messages, one per row, drawn under the price field.
  const [priceErrors, setPriceErrors] = useState<(string | undefined)[]>([]);
  // Set by the first failed submit; from then on the messages follow what is typed.
  const [checkContact, setCheckContact] = useState(false);
  const contactErrors: ContactErrors = checkContact ? contactErrorsFor(contact) : {};
  // Mobile slice 38: Next/Done keys, and a failed submit lands on the first error.
  const flow = useFormFlow();

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

  // Capture mode: one line carrying the payment, filled in once when the payment has loaded.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!capture || prefilled.current) return;
    prefilled.current = true;
    // Never over lines the person has already typed.
    setLineItems((current) =>
      current.some((li) => li.name.trim() !== '' || (Number(li.unit_price) || 0) > 0)
        ? current
        : [{ ...blankLineItem(), name: capture.description ?? 'Payment received', quantity: 1, unit_price: capture.amount }],
    );
  }, [capture]);

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

    return { customer_id: selectedCustomerId!, line_items, ...location, ...(capture ? { unapplied_capture_id: captureParam! } : {}) };
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
          phone_ext: contact.phone_ext || undefined,
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
      } else {
        // Any other answer (a number refused after Create anyway) closes the dialog, so the form's error line shows it.
        setDupExisting(null);
      }
    },
  });

  // The first kept row carries a price message (a rejected total belongs to the invoice, and the price is what to change).
  function showPriceError(message: string) {
    const at = Math.max(0, lineItems.findIndex((li) => li.name.trim() !== '' || (Number(li.unit_price) || 0) > 0));
    const next: (string | undefined)[] = [];
    next[at] = message;
    setPriceErrors(next);
    flow.focusFirstInvalid();
  }

  // -- Create-invoice mutation ----------------------------------------------
  const createInvoice = useMutation({
    mutationFn: async () => {
      // In capture mode the page words the refusals itself, so the shared error toast stays out of the way.
      const { data } = capture
        ? await api.post('/api/invoices', buildPayload(), { silentErrors: true })
        : await api.post('/api/invoices', buildPayload());
      return { invoice: data.invoice as { id: string; invoice_number?: string }, attached: Boolean(data.attached_capture) };
    },
    onSuccess: ({ invoice, attached }) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      // Tell the Payments tab this was opened from, so it refreshes itself and says so.
      if (capture && attached && invoice.invoice_number) postAttached({ invoice_number: invoice.invoice_number, amount: capture.amount });
      navigate(v2Path(`/invoices/${invoice.id}`));
    },
    onError: (err: unknown) => {
      // The server's own check of the same rule the page makes before posting (the preview total is blank while tax is unknown).
      if (capture && errorCode(err) === 'INVOICE_TOTAL_BELOW_PAYMENT') {
        showPriceError(TOTAL_BELOW_PAYMENT(capture.amount));
      }
    },
  });

  // -- Customer helpers -----------------------------------------------------
  const selectCustomer = (c: PickCustomer) => {
    setSelectedCustomer(c);
    setContact({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      company_name: c.company_name || '',
      phone: phoneFieldValue(c.phone || ''),
      phone_ext: c.phone_ext || '',
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

  // The address names a customer: choose them, defaulting the location. A customer who cannot be read leaves the blank form.
  const preselectRead = useQuery({
    queryKey: ['customer', customerParam, 'preselect'],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/picker/${customerParam}`);
      return data.customer as PickCustomer | undefined;
    },
    enabled: Boolean(customerParam),
    retry: false,
  });
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !preselectRead.data) return;
    preselected.current = true;
    selectCustomer(preselectRead.data);
  });

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
    if (captureSettling) return;
    // Need a customer first: pick one, or create the authored one inline.
    if (!selectedCustomerId) {
      setCheckContact(true);
      if (Object.keys(contactErrorsFor(contact)).length) {
        flow.focusFirstInvalid();
        return;
      }
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
      flow.focusFirstInvalid();
      return;
    }
    setLineErrors([]);
    if (capture) {
      // The payment has to fit on the invoice (no invoice ends up owing less than what was paid on it): every kept price is
      // above zero, and the total with tax reaches the payment. The server checks the same, and has the last word.
      const keptRow = (li: LineItem) => li.name.trim() !== '' || (Number(li.unit_price) || 0) > 0;
      const zero = lineItems.map((li) => (keptRow(li) && !(Number(li.unit_price) > 0) ? PRICE_ABOVE_ZERO : undefined));
      if (zero.some(Boolean)) {
        setPriceErrors(zero);
        flow.focusFirstInvalid();
        return;
      }
      if (totals.total != null && cents(totals.total) < cents(capture.amount)) {
        showPriceError(TOTAL_BELOW_PAYMENT(capture.amount));
        return;
      }
    }
    setPriceErrors([]);
    createInvoice.mutate();
  };

  // In capture mode every refusal is worded at the top of the page, where the banner is, and brought into view.
  const refusal = capture && createInvoice.isError && !totalRefused0(createInvoice.error)
    ? extractApiError(createInvoice.error, 'The invoice could not be saved.')
    : null;
  const refusalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refusal) return;
    refusalRef.current?.scrollIntoView?.({ block: 'center' });
    refusalRef.current?.focus();
  }, [refusal, createInvoice.submittedAt]);
  const submitting = createInvoice.isPending || (createCustomer.isPending && !dupExisting);
  // A payment that is already attached or refunded cannot be saved against: no retry on this page.
  const captureRefused = Boolean(capture) && statusOf(createInvoice.error) === 409;
  const totalRefused = Boolean(capture) && errorCode(createInvoice.error) === 'INVOICE_TOTAL_BELOW_PAYMENT';

  const customerBlock = (
    <PickCustomerFields
      fields={contact}
      onFieldChange={handleFieldChange}
      selectedCustomer={selectedCustomer}
      onSelectCustomer={selectCustomer}
      required
      showPhoneExt
      errors={selectedCustomerId ? undefined : contactErrors}
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
      {capture && (
        <Alert tone="neutral" role="status" className="mb-4 flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p><b>This invoice will record {formatCurrency(capture.amount)} received on {captureDay}.</b></p>
        </Alert>
      )}
      {refusal && (
        <Alert ref={refusalRef} tone="danger" role="alert" tabIndex={-1} className="mb-4">
          <p>{refusal}</p>
        </Alert>
      )}
      <PageHeader
        title="New Invoice"
        actions={
          <>
            <Button type="button" variant="outline" className="max-sm:h-11" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" className="max-sm:h-11" form="standalone-invoice-form" disabled={submitting || captureRefused || captureSettling}>
              {submitting && <Loader2 className="animate-spin" />}
              {selectedCustomerId ? (capture ? 'Save invoice' : 'Create Invoice') : 'Continue'}
            </Button>
          </>
        }
      />

      <form
        id="standalone-invoice-form"
        noValidate
        {...flow.formProps}
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
                paymentToRecord={paymentToRecord}
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
                  onChange={(next) => {
                    setLineItems(next);
                    setPriceErrors([]);
                  }}
                  itemNameErrors={lineErrors}
                  itemPriceErrors={priceErrors}
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
                paymentToRecord={paymentToRecord}
              />
            )}
          </div>
        </div>

        {(createInvoice.isError || createCustomer.isError) && !dupExisting && !totalRefused && !refusal && (
          <p className="text-destructive mt-2 text-sm">
            {extractApiError(createInvoice.error ?? createCustomer.error, 'Failed to create invoice')}
          </p>
        )}
      </form>
    </div>
  );
}
