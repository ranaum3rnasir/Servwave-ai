import { useState, useEffect, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  CreditCard,
  AlertTriangle,
  Clock,
  Banknote,
  Landmark,
  Wallet,
  ChevronLeft,
} from 'lucide-react';

import { ActionLink } from '@/components/ui/action-link';
// PURE helpers only. `useScheduleTimezone()` must NEVER be called from this page: it
// reads `useOrganization()`, which would fire an authenticated request from an
// UNAUTHENTICATED surface and log a 401 for every customer who opens their invoice.
// Importing the module is inert - the page fetches with bare `fetch()`, not axios.
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  ORG_DAY_FORMAT,
  formatInstant,
  orgDayDiff,
} from '@/lib/schedule-tz';
import { formatCurrency, formatPhone } from '@/lib/utils';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui-kit/components/ui/table';

import {
  PublicCard,
  PublicCardTitle,
  PublicColumn,
  PublicLoading,
  PublicNotice,
  PublicPage,
  PublicUnavailable,
} from './components/publicShell';

/* --- Types --- */

interface PublicOrganization {
  name: string;
  logo_url?: string | null;
  brand_color?: string | null;
  phone?: string | null;
  /**
   * #1821 - the BUSINESS's IANA zone, served by `invoice.controller.ts` getPublic.
   * Optional and nullable on purpose: a bundle cached from before that deploy will not
   * receive it, and `Organization.timezone` is itself nullable. Both cases fall back to a
   * FIXED named zone, never to the viewer's browser.
   */
  timezone?: string | null;
  accepted_payment_methods?: string[];
}

interface PublicLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number | string;
  is_taxable: boolean;
  line_total: number | string;
}

interface PublicCustomer {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

interface PublicInvoice {
  id: string;
  invoice_number: string;
  status: string;
  kind?: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  // Job-less DEPOSIT invoices have no job; the payer + lines come from the
  // top-level customer / line_items fields instead.
  customer?: PublicCustomer | null;
  line_items?: PublicLineItem[];
  job: {
    job_number: string;
    estimate: {
      estimate_number: string;
      discount_name: string | null;
      discount_type: string | null;
      discount_value: number | string | null;
      tax_rate: number | string;
      line_items: PublicLineItem[];
    } | null;
    charges: PublicLineItem[];
    customer: PublicCustomer;
    service_location: {
      address_line1: string;
      address_line2: string | null;
      city: string;
      state: string;
      zip: string;
    };
  } | null;
  payments: { id: string; amount: number | string; method: string; paid_at: string }[];
}

/* --- Helpers --- */

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit Card',
  EXTERNAL_CARD: 'Credit Card',
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank Transfer',
  CASH: 'Cash',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

const METHOD_ICONS: Record<string, typeof CreditCard> = {
  CARD: CreditCard,
  EXTERNAL_CARD: CreditCard,
  CHECK: Banknote,
  BANK_TRANSFER: Landmark,
  CASH: Wallet,
  ZELLE: Wallet,
  VENMO: Wallet,
  CASH_APP: Wallet,
  OTHER: Wallet,
};

const INSTRUCTION_KEYS: Record<string, string> = {
  CHECK: 'check',
  BANK_TRANSFER: 'bank_transfer',
  CASH: 'cash',
};

/**
 * `toLocaleString()`'s numeric default, pinned to the org zone and carrying the zone
 * label. This is the one line on the page that shows a CLOCK time rather than a calendar
 * day, and the reader is a customer who may well be in another zone: without the label a
 * 10:35 PM receipt stamp is simply unexplainable to them. It also drops the seconds
 * `toLocaleString()` printed - a receipt is not a log line.
 */
const ORG_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

function formatMethodLabel(method: string): string {
  return METHOD_LABELS[method] || method;
}

// Collapse CARD + EXTERNAL_CARD into a single customer-facing entry. CARD
// always wins when both are present (matches the controller's routing).
function collapseCardMethods(methods: string[]): string[] {
  const out: string[] = [];
  let seenCard = false;
  for (const m of methods) {
    if (m === 'CARD' || m === 'EXTERNAL_CARD') {
      if (seenCard) continue;
      seenCard = true;
      out.push(methods.includes('CARD') ? 'CARD' : 'EXTERNAL_CARD');
    } else {
      out.push(m);
    }
  }
  return out;
}

/** The backend error string an axios-shaped rejection carries, if any. */
function backendError(err: unknown): string {
  const shaped = err as { response?: { data?: { error?: string } } };
  return shaped?.response?.data?.error ?? (err as Error).message;
}

/* --- Component --- */

/**
 * /v2/p/invoices/:id - the CRM-kit rebuild of `pages/PublicInvoicePage.tsx`.
 *
 * UNAUTHENTICATED, exactly as the public estimate page: bare `fetch()` against
 * `GET /api/invoices/:id/public?token=` and
 * `POST /api/invoices/:id/public/checkout?token=`, no axios, no Supabase
 * session, no auth store, no ability context, no org query.
 *
 * TWO ASYMMETRIES WITH THE ESTIMATE PAGE ARE REPRODUCED AS-IS, not repaired:
 *  - `?payment=success` sets the banner and strips the param but does NOT
 *    refetch, so the amount due can be briefly stale (the copy says so);
 *  - there is no org branding bar here, even though `data.organization` is
 *    fetched. Only `organization.name`, `organization.phone` and (since #1821)
 *    `organization.timezone` are used - `logo_url` and `brand_color` still are not.
 * Both are noted in the module's gap ledger as observed-but-not-fixed.
 */
export default function PublicInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = searchParams.get('token');
  const paymentParam = searchParams.get('payment');

  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [organization, setOrganization] = useState<PublicOrganization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [paymentBanner, setPaymentBanner] = useState<{ type: 'success' | 'warning'; message: string } | null>(null);
  const [availableMethods, setAvailableMethods] = useState<string[]>([]);
  const [paymentInstructions, setPaymentInstructions] = useState<Record<string, string>>({});
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  // Card service fee - display-only preview computed server-side.
  const [serviceFeePreview, setServiceFeePreview] = useState(0);

  /* --- Fetch invoice --- */

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation of the URL token; there is no external system to sync with
      setError('Invalid link - token missing');
      setLoading(false);
      return;
    }

    fetch(`${import.meta.env.VITE_API_URL || ''}/api/invoices/${id}/public?token=${encodeURIComponent(token)}`)
      .then((res) => {
        if (!res.ok) throw new Error('Invoice not found');
        return res.json();
      })
      .then((data) => {
        setInvoice(data.invoice);
        setOrganization(data.organization ?? null);
        setAvailableMethods(data.available_payment_methods || []);
        setPaymentInstructions(data.payment_instructions || {});
        setServiceFeePreview(Number(data.service_fee_preview) || 0);
      })
      .catch(() => {
        setError('This invoice is no longer available.');
      })
      .finally(() => setLoading(false));
  }, [id, token]);

  // Handle Stripe return params
  useEffect(() => {
    if (!paymentParam) return;
    if (paymentParam === 'success') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the Stripe return param out of the URL once, then clears it; the URL IS the external system here
      setPaymentBanner({ type: 'success', message: 'Payment received! It may take a moment to process.' });
    } else if (paymentParam === 'cancelled') {
      setPaymentBanner({ type: 'warning', message: 'Payment was cancelled. You can try again.' });
    }
    // Clear the query param so refresh doesn't re-trigger
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('payment');
    setSearchParams(newParams, { replace: true });
  }, [paymentParam]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Loading & error states --- */

  if (loading) return <PublicLoading />;

  if (error && !invoice) {
    return <PublicUnavailable title="Unavailable" message={error} />;
  }

  if (!invoice) return null;

  /* --- Derived values --- */

  const amountDue = Number(invoice.amount_due);
  // "chosen to pay by card" = the card panel is the one currently revealed.
  const cardFeeSelected = selectedMethod === 'CARD' && serviceFeePreview > 0;

  const isVoided = invoice.status === 'VOIDED';
  const isPaid = invoice.status === 'PAID';
  const isPayable = invoice.status === 'SENT' || invoice.status === 'PARTIAL';

  // #1821 - every date on this page renders on the BUSINESS's clock, not the customer's.
  // This is the one surface whose viewer's zone is genuinely unknown, so
  // `toLocaleDateString()` with no `timeZone` was at its most damaging here. The fallback
  // is a FIXED named zone, NEVER `Intl.DateTimeFormat().resolvedOptions().timeZone` - a
  // browser fallback is the bug wearing a default's clothing.
  const timeZone = organization?.timezone || DEFAULT_SCHEDULE_TIMEZONE;

  // Same rule as the invoices list (`pages/v2/invoices/invoicesColumns.tsx:50`) and the
  // detail page: payable, and the ORG's calendar day has moved PAST the due day.
  // `invoiceMoney.isOverdue` is not reusable - its `InvoiceDetail` requires
  // tax_rate/public_token/voided_at, which this public payload deliberately withholds - so
  // the predicate is rebuilt from the same `orgDayDiff` primitive the list uses. The old
  // raw-instant compare told a customer his invoice was late from the moment the due
  // INSTANT passed: for a due_date stored at 02:35Z that was 10:35 PM the evening BEFORE
  // on the business's clock, contradicting the due date printed inches above it.
  const overdue = isPayable && !!invoice.due_date && orgDayDiff(invoice.due_date, timeZone) < 0;

  // Job-less DEPOSIT invoices carry the payer at the top level; job invoices
  // resolve it from the job. Fall back gracefully so neither path crashes.
  const payer = invoice.customer ?? invoice.job?.customer ?? null;
  const location = invoice.job?.service_location ?? null;
  const estimateLineItems = invoice.job?.estimate?.line_items ?? [];
  const jobCharges = invoice.job?.charges ?? [];
  // Deposit (job-less) invoices render their own line_items in the same shape.
  const ownLineItems = invoice.line_items ?? [];

  /* --- Checkout handler --- */

  const handleCheckout = async () => {
    if (!token) return;
    setCheckoutLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/invoices/${id}/public/checkout?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create checkout session');
      }
      const data = await res.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    } catch (err) {
      // Map the card-unavailable 400 to friendly homeowner copy instead of the
      // raw backend string; the generic fallback also stops any other raw
      // backend string from leaking to the homeowner.
      const msg = backendError(err);
      const orgName = organization?.name ?? 'This business';
      setError(
        /card payments? (are|is) not/i.test(msg)
          ? `${orgName} isn't accepting card payments right now - choose another payment method or contact us.`
          : 'Something went wrong starting your payment. Please try again or contact us.',
      );
    } finally {
      setCheckoutLoading(false);
    }
  };

  /* --- Voided state --- */

  if (isVoided) {
    return (
      <PublicUnavailable
        title="Invoice Voided"
        message="This invoice has been voided. Please contact us for assistance."
      />
    );
  }

  /* --- Invoice document --- */

  const renderLineItemsTable = () => {
    const hasEstimateItems = estimateLineItems.length > 0;
    const hasJobCharges = jobCharges.length > 0;
    // Job-less (deposit) invoices fall back to the invoice's own line_items.
    const ownItems = !invoice.job ? ownLineItems : [];
    const hasOwnItems = ownItems.length > 0;

    if (!hasEstimateItems && !hasJobCharges && !hasOwnItems) {
      return <p className="text-subtle-foreground py-2 text-sm italic">No line items</p>;
    }

    // Alignment rides an inner span, not a className on TableCell: the kit's
    // TableCell ships no `align` prop and the component-API ratchet for
    // TableCell is at its floor, so an appearance override there would raise a
    // ceiling instead of solving the problem.
    const NumCell = ({ strong, children }: { strong?: boolean; children: ReactNode }) => (
      <TableCell>
        <span className={strong ? 'block text-right font-medium' : 'block text-right'}>
          {children}
        </span>
      </TableCell>
    );

    const row = (item: PublicLineItem, source: 'estimate' | 'job' | null) => (
      <TableRow key={item.id}>
        <TableCell>
          <div className="flex items-start gap-2">
            <div>
              <p>{item.description}</p>
              {item.is_taxable && <span className="text-subtle-foreground text-xs">Taxable</span>}
            </div>
            {source === 'estimate' && (
              <Badge variant="softNeutral" size="sm">
                Estimate
              </Badge>
            )}
            {source === 'job' && (
              <Badge variant="softAmber" size="sm">
                Job
              </Badge>
            )}
          </div>
        </TableCell>
        <NumCell>{item.quantity}</NumCell>
        <NumCell>{formatCurrency(Number(item.unit_price))}</NumCell>
        <NumCell strong>{formatCurrency(Number(item.line_total))}</NumCell>
      </TableRow>
    );

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit Price</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {estimateLineItems.map((item) => row(item, 'estimate'))}
          {jobCharges.map((item) => row(item, 'job'))}
          {ownItems.map((item) => row(item, null))}
        </TableBody>
      </Table>
    );
  };

  const renderTotals = () => {
    const subtotal = Number(invoice.subtotal);
    const discountAmount = Number(invoice.discount_amount);
    const taxAmount = Number(invoice.tax_amount);
    const depositCredit = Number(invoice.deposit_credit);
    const totalAmount = Number(invoice.total_amount);
    const totalPayments = invoice.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const estimateData = invoice.job?.estimate;

    return (
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="text-muted-foreground flex justify-between">
          <span>Subtotal</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>

        {discountAmount > 0 && (
          <div className="text-muted-foreground flex justify-between">
            <span>
              Discount
              {estimateData?.discount_name && (
                <span className="text-subtle-foreground ml-1">({estimateData.discount_name})</span>
              )}
            </span>
            <span className="text-status-green-emphasis">-{formatCurrency(discountAmount)}</span>
          </div>
        )}

        {taxAmount > 0 && (
          <div className="text-muted-foreground flex justify-between">
            <span>
              Tax
              {estimateData?.tax_rate && (
                <span className="text-subtle-foreground ml-1">({Number(estimateData.tax_rate)}%)</span>
              )}
            </span>
            <span>{formatCurrency(taxAmount)}</span>
          </div>
        )}

        <div className="flex justify-between border-t pt-1 font-medium">
          <span>Total</span>
          <span>{formatCurrency(totalAmount)}</span>
        </div>

        {depositCredit > 0 && (
          <div className="text-muted-foreground flex justify-between">
            <span>Deposit credit</span>
            <span className="text-status-green-emphasis">-{formatCurrency(depositCredit)}</span>
          </div>
        )}

        {totalPayments > 0 && (
          <div className="text-muted-foreground flex justify-between">
            <span>Payments received</span>
            <span className="text-status-green-emphasis">-{formatCurrency(totalPayments)}</span>
          </div>
        )}

        <div className="flex justify-between border-t-2 pt-2">
          <span className="text-base font-bold">Amount Due</span>
          <span className="text-base font-bold">{formatCurrency(amountDue)}</span>
        </div>

        {/* Always present in the breakdown; only carries an amount once the
            customer has chosen to pay by card. */}
        <div className="text-muted-foreground flex justify-between border-t pt-1.5">
          <span>
            Service fee
            <span className="text-subtle-foreground ml-1 text-xs">(card payments only)</span>
          </span>
          <span>{cardFeeSelected ? formatCurrency(serviceFeePreview) : '-'}</span>
        </div>

        {cardFeeSelected && (
          <div className="flex justify-between font-medium">
            <span>Total due by card</span>
            <span>{formatCurrency(amountDue + serviceFeePreview)}</span>
          </div>
        )}
      </div>
    );
  };

  const renderInvoiceDocument = () => (
    <PublicCard>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p role="heading" aria-level={1} className="text-2xl font-bold">
              INVOICE
            </p>
            <p className="text-muted-foreground mt-1 text-sm">{invoice.invoice_number}</p>
            {invoice.job?.estimate && (
              <p className="text-subtle-foreground mt-0.5 text-xs">
                Estimate {invoice.job.estimate.estimate_number} · Job {invoice.job.job_number}
              </p>
            )}
            {token && (
              <ActionLink
                href={`/api/invoices/${invoice.id}/public/pdf?token=${encodeURIComponent(token)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block"
              >
                Download PDF
              </ActionLink>
            )}
          </div>
          <div className="flex flex-col gap-1 text-right text-sm">
            {invoice.sent_at && (
              <p className="text-muted-foreground">
                <span className="text-subtle-foreground">Sent: </span>
                {formatInstant(invoice.sent_at, timeZone, ORG_DAY_FORMAT)}
              </p>
            )}
            {invoice.due_date && (
              <p className="text-muted-foreground">
                <span className="text-subtle-foreground">Due: </span>
                {formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)}
              </p>
            )}
            {invoice.paid_at && (
              <p className="text-status-green-emphasis font-medium">
                Paid {formatInstant(invoice.paid_at, timeZone, ORG_DAY_FORMAT)}
              </p>
            )}
          </div>
        </div>

        {/* Customer and location */}
        <div className="grid grid-cols-1 gap-4 border-t pt-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-subtle-foreground mb-1 text-xs uppercase tracking-wide">Bill To</p>
            {payer ? (
              <>
                <p className="font-medium">
                  {payer.first_name} {payer.last_name}
                </p>
                {payer.email && <p className="text-muted-foreground">{payer.email}</p>}
                {payer.phone && <p className="text-muted-foreground">{formatPhone(payer.phone)}</p>}
              </>
            ) : (
              <p className="text-subtle-foreground italic">-</p>
            )}
          </div>
          {location ? (
            <div>
              <p className="text-subtle-foreground mb-1 text-xs uppercase tracking-wide">
                Service Address
              </p>
              <p>{location.address_line1}</p>
              {location.address_line2 && <p>{location.address_line2}</p>}
              <p>
                {location.city}, {location.state} {location.zip}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-subtle-foreground mb-1 text-xs uppercase tracking-wide">Type</p>
              <p>{invoice.kind === 'DEPOSIT' ? 'Deposit' : 'Invoice'}</p>
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="border-t pt-4">{renderLineItemsTable()}</div>

        {/* Totals */}
        <div className="ml-auto max-w-xs border-t pt-4">{renderTotals()}</div>

        {/* Payment history */}
        {invoice.payments.length > 0 && (
          <div className="border-t pt-4">
            <p className="text-subtle-foreground mb-2 text-xs uppercase tracking-wide">
              Payment History
            </p>
            <div className="flex flex-col gap-1.5">
              {invoice.payments.map((payment) => (
                <div key={payment.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {formatMethodLabel(payment.method)} - {formatInstant(payment.paid_at, timeZone, ORG_DAY_FORMAT)}
                  </span>
                  <span className="font-medium">{formatCurrency(Number(payment.amount))}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </PublicCard>
  );

  /* --- Main render --- */

  return (
    <PublicPage>
      <PublicColumn>
        {/* Non-fatal error banner */}
        {error && invoice && (
          <PublicNotice tone="danger">
            <p>{error}</p>
          </PublicNotice>
        )}

        {/* Payment return banner */}
        {paymentBanner && (
          <PublicNotice
            tone={paymentBanner.type === 'success' ? 'success' : 'warning'}
            icon={paymentBanner.type === 'success' ? <CheckCircle2 /> : <AlertTriangle />}
          >
            <p className="font-medium">{paymentBanner.message}</p>
          </PublicNotice>
        )}

        {renderInvoiceDocument()}

        {/* Paid state */}
        {isPaid && (
          <PublicNotice tone="success" icon={<CheckCircle2 />}>
            <p className="font-medium">Paid in Full</p>
            {invoice.paid_at && (
              <p className="text-xs">
                Payment completed on {formatInstant(invoice.paid_at, timeZone, ORG_TIMESTAMP_FORMAT)}
              </p>
            )}
          </PublicNotice>
        )}

        {/* Overdue notice */}
        {overdue && (
          <PublicNotice tone="warning" icon={<Clock />}>
            <p className="font-medium">
              This invoice was due on {formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)}
            </p>
          </PublicNotice>
        )}

        {/* Payment methods section */}
        {isPayable && amountDue > 0 && availableMethods.length > 0 && (
          <PublicCard>
            {selectedMethod === 'CARD' ? (
              // Selected CARD: fee breakdown, then checkout
              <div className="flex flex-col gap-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit gap-1 px-0"
                  onClick={() => setSelectedMethod(null)}
                >
                  <ChevronLeft /> Back to payment methods
                </Button>
                <PublicCardTitle>Pay by Card</PublicCardTitle>
                <div className="bg-muted flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
                  <div className="text-muted-foreground flex justify-between">
                    <span>Amount due</span>
                    <span>{formatCurrency(amountDue)}</span>
                  </div>
                  {serviceFeePreview > 0 && (
                    <div className="text-muted-foreground flex justify-between">
                      <span>Service fee</span>
                      <span>{formatCurrency(serviceFeePreview)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-1.5 font-medium">
                    <span>Total charged to card</span>
                    <span>{formatCurrency(amountDue + serviceFeePreview)}</span>
                  </div>
                </div>
                {serviceFeePreview > 0 && (
                  <p className="text-subtle-foreground text-xs">
                    A service fee applies to card payments only.
                  </p>
                )}
                <Button className="w-full" size="lg" onClick={handleCheckout} isLoading={checkoutLoading}>
                  {!checkoutLoading && <CreditCard />}
                  Pay {formatCurrency(amountDue + serviceFeePreview)}
                </Button>
              </div>
            ) : selectedMethod ? (
              // Selected non-card method: show instructions
              <div className="flex flex-col gap-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit gap-1 px-0"
                  onClick={() => setSelectedMethod(null)}
                >
                  <ChevronLeft /> Back to payment methods
                </Button>
                <PublicCardTitle>
                  Pay by {formatMethodLabel(selectedMethod)} - {formatCurrency(amountDue)}
                </PublicCardTitle>
                {/* EXTERNAL_CARD shows the call-us block; real CARD never
                    reaches this branch (Stripe handles checkout inline). */}
                {selectedMethod === 'EXTERNAL_CARD' ? (
                  <div className="bg-muted rounded-lg border p-3 text-sm">
                    To pay by credit card, please call our office
                    {organization?.phone ? ` at ${formatPhone(organization.phone)}` : ''}.
                  </div>
                ) : (
                  paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || ''] && (
                    <div className="bg-muted whitespace-pre-wrap rounded-lg border p-3 text-sm">
                      {paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || '']}
                    </div>
                  )
                )}
                <p className="text-muted-foreground text-xs">
                  Once we receive your payment, your invoice will be updated automatically.
                </p>
              </div>
            ) : (
              // Method picker
              <div className="flex flex-col gap-3">
                <PublicCardTitle level={2}>Payment Options</PublicCardTitle>
                {collapseCardMethods(availableMethods).map((method) => {
                  const Icon = METHOD_ICONS[method] || CreditCard;
                  const isCard = method === 'CARD' || method === 'EXTERNAL_CARD';
                  // CARD takes the inline Stripe-breakdown panel; the raw token
                  // (CARD vs EXTERNAL_CARD) is what decides routing.
                  const cardIsStripe = method === 'CARD';
                  return (
                    <div key={method}>
                      {cardIsStripe ? (
                        // Card on STRIPE: click reveals the fee breakdown first.
                        <div className="flex flex-col gap-3 rounded-lg border p-4">
                          <div className="flex items-center gap-2">
                            <CreditCard className="text-muted-foreground size-5" />
                            <span className="text-sm font-medium">Pay by Card</span>
                          </div>
                          <Button className="w-full" size="lg" onClick={() => setSelectedMethod('CARD')}>
                            <CreditCard />
                            Pay {formatCurrency(amountDue)} by Card
                          </Button>
                        </div>
                      ) : (
                        // EXTERNAL_CARD or any non-card method: click-to-reveal
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-between py-3"
                          onClick={() => setSelectedMethod(method)}
                        >
                          <span className="flex items-center gap-2">
                            <Icon />
                            Pay {isCard ? 'with' : 'by'} {formatMethodLabel(method)}
                          </span>
                          <span className="text-muted-foreground text-sm">
                            {formatCurrency(amountDue)}
                          </span>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </PublicCard>
        )}
      </PublicColumn>
    </PublicPage>
  );
}
