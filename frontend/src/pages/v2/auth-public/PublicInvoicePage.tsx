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
import { Thumbnail } from '@/components/ui/thumbnail';
import { defaultBrandColor } from '@/lib/branding';
// PURE helpers only. `useScheduleTimezone()` must NEVER be called from this page: it
// reads `useOrganization()`, which would fire an authenticated request from an
// UNAUTHENTICATED surface and log a 401 for every customer who opens their invoice.
// The page fetches with bare `fetch()`, not axios, and imports the helpers from the Intl-only
// module (`schedule-tz-intl`), so neither the signed-in data layer nor date-fns-tz is in a
// customer's download (mobile slice 47).
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  ORG_DAY_FORMAT,
  formatInstant,
  orgDayDiffIntl,
} from '@/lib/schedule-tz-intl';
import { formatCurrency, formatPhone } from '@/lib/utils';
import { publicPdfHref } from '@/lib/public-pdf-href';
import { paymentCounts } from '@/lib/payment-ledger';
import { MIN_PARTIAL_CENTS, centsToDollars, parseDollarsToCents, tipPresetCents } from '@/lib/public-pay-amounts';
import type { PaymentState, RefundState } from '@/types/entities';
import { describePayment, paymentStateLabel, refundStateLabel, type PaymentDisplayFields } from '@/lib/payment-display';
import { fetchPublicDocument } from '@/lib/platform/earlyPublicFetch';

import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui-kit/components/ui/table';

import {
  PublicActionError,
  PublicBusinessContact,
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
  // SRVW-54 - rendered beside the number in the "call us at ..." lines, never appended to it.
  phone_ext?: string | null;
  /** The business's own email (mobile slice 28), a mail link in the footer. Absent on old payloads. */
  email?: string | null;
  /**
   * #1821 - the BUSINESS's IANA zone, served by `invoice.controller.ts` getPublic.
   * Optional and nullable on purpose: a bundle cached from before that deploy will not
   * receive it, and `Organization.timezone` is itself nullable. Both cases fall back to a
   * FIXED named zone, never to the viewer's browser.
   */
  timezone?: string | null;
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

/**
 * Payments go-live slice 24 (#1073) - a scope-of-work block, as the public payload carries it:
 * customer-safe fields only (the backend's `toPublicScopes` allowlist; no cost). `flat_price` is
 * null on a narrative block that is not separately priced; a priced block's figure is already in
 * the subtotal. Decimal-backed money can arrive as a string, like every money field here.
 */
interface PublicScope {
  id: string;
  title: string;
  body: string;
  flat_price: number | string | null;
  is_taxable: boolean;
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
  /** Absent on a payload from before slice 24. */
  scopes?: PublicScope[];
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
      // F-55: the token route withholds the street lines, so a current payload has neither.
      address_line1?: string | null;
      address_line2?: string | null;
      city: string;
      state: string;
      zip: string;
    };
  } | null;
  // Payments go-live slice 05: state, so only SUCCEEDED payments count as received.
  payments: (PaymentDisplayFields & { id: string; amount: number | string; paid_at: string; state?: PaymentState })[];
  // Payments go-live slice 28 - what was given back or is on its way (a failed refund is not sent).
  refunds?: { id: string; amount: number | string; state: RefundState; created_at: string }[];
}

/* --- Helpers --- */

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit Card',
  ACH: 'Bank payment',
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

type CheckoutMethod = 'card' | 'bank';

/** Slice 26 - the tip the homeowner picked: nothing, one of the org's presets, or their own figure. */
type TipChoice = { kind: 'none' } | { kind: 'preset'; pct: number } | { kind: 'custom' };

/** Slice 26 - what this invoice offers beyond paying it whole (the backend's resolver answer). */
interface PublicPaymentOptions {
  allow_partial: boolean;
  tips: { enabled: boolean; presets: number[] };
}

/**
 * Slice 25 - the one state the page renders from (the backend's `publicPayState`). The checkout
 * door refuses every state but PAYABLE.
 */
type PayState = 'PAYABLE' | 'PROCESSING' | 'PAID' | 'VOIDED' | 'CHANGED' | 'CLOSED';
const PAY_STATES: readonly string[] = ['PAYABLE', 'PROCESSING', 'PAID', 'VOIDED', 'CHANGED', 'CLOSED'];

/**
 * What a CHANGED invoice tells the homeowner. A deposit link is held for one of two reasons (the
 * backend's depositHoldReason), each with its own words; anything else changed is the general line.
 */
function changedMessage(holdReason: string | null): string {
  if (holdReason === 'SUPERSEDED') {
    return 'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.';
  }
  if (holdReason === 'ESTIMATE_IN_DRAFT') {
    return 'This deposit is on hold while the estimate is being updated. Please contact us if you would like to pay it now.';
  }
  return 'This invoice has changed. Please contact us for the current amount.';
}

/** The online methods: each opens the hosted checkout for its own kind of session. */
/** A dollar figure typed with more than two decimals (12.345): a number, but not dollars and cents. */
const TOO_MANY_DECIMALS = /^\$?[\d,]*\.\d{3,}$/;

function checkoutMethodOf(method: string): CheckoutMethod | null {
  return method === 'CARD' ? 'card' : method === 'ACH' ? 'bank' : null;
}

/**
 * Slice 25 - refusals that mean the invoice is no longer what the page shows (it changed, was
 * paid or closed, a bank payment covers it, or a deposit was put on hold). The page re-reads the
 * invoice and shows its true state instead of an error.
 */
const STALE_PAGE_CODES = new Set([
  'INVOICE_CHANGED',
  // Slice 26: a method, a tip or a partial amount the page offered is no longer offered, or the
  // amount payable now shrank under the figure typed.
  'PAYMENT_OPTIONS_CHANGED',
  'AMOUNT_ABOVE_PAYABLE_NOW',
  'INVOICE_NOT_PAYABLE',
  'PAYMENT_PROCESSING',
  'DEPOSIT_SUPERSEDED',
  'DEPOSIT_ON_HOLD',
  'DEPOSIT_ALREADY_PAID',
  'DEPOSIT_VOIDED',
  'DEPOSIT_CLOSED',
]);

/**
 * Refusals whose message was written for the homeowner (slice 16's neutral "Paying online isn't
 * available for this invoice."): shown as they are. Matched on the code, never on the wording.
 */
const HOMEOWNER_MESSAGE_CODES = new Set(['ONLINE_PAYMENT_UNAVAILABLE']);

/** What the homeowner reads when the checkout door refuses for any other reason. */
function refusalMessage(refusal: { code?: unknown; error?: unknown }, orgName: string): string {
  const error = typeof refusal.error === 'string' ? refusal.error : '';
  if (typeof refusal.code === 'string' && HOMEOWNER_MESSAGE_CODES.has(refusal.code) && error) return error;
  // Slice 26: a bad figure the server caught beside the field the homeowner typed it in.
  if (refusal.code === 'AMOUNT_BELOW_MINIMUM') return 'The smallest payment is $1.00.';
  if (refusal.code === 'AMOUNT_NOT_WHOLE_CENTS') return 'Enter an amount in dollars and cents.';
  if (refusal.code === 'TIP_OUT_OF_BOUNDS') return 'That tip is too large. Choose a smaller tip.';
  // The method-unavailable refusals map to friendly copy instead of the raw backend string; the
  // generic fallback stops any other raw backend string from reaching the homeowner.
  if (/card payments? (are|is) not/i.test(error)) {
    return `${orgName} isn't accepting card payments right now - choose another payment method or contact us.`;
  }
  if (/bank payments? (are|is) not/i.test(error)) {
    return `${orgName} isn't accepting bank payments right now - choose another payment method or contact us.`;
  }
  return 'Something went wrong starting your payment. Please try again or contact us.';
}

/* --- Component --- */

/**
 * /p/invoices/:id - the public invoice page a customer opens from their link.
 *
 * UNAUTHENTICATED, exactly as the public estimate page: bare `fetch()` against
 * `GET /api/invoices/:id/public?token=` and
 * `POST /api/invoices/:id/public/checkout?token=`, no axios, no Supabase
 * session, no auth store, no ability context, no org query.
 *
 * Coming back from the hosted checkout (`?payment=success&method=card|bank`) shows a confirmation
 * screen and no checkout (payments go-live slice 25): the payment may not have reached the invoice
 * yet, so a Pay button there could take the same money twice. "View invoice" re-reads the invoice.
 * (Repaired by slice 24: the page carries the same org branding bar as the estimate page.)
 */
export default function PublicInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = searchParams.get('token');
  const paymentParam = searchParams.get('payment');
  const methodParam = searchParams.get('method');

  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [organization, setOrganization] = useState<PublicOrganization | null>(null);
  const [loading, setLoading] = useState(true);
  // Only a failure to load the invoice. A failed checkout is `checkoutError`, shown beside Pay.
  const [error, setError] = useState('');
  // The method whose checkout is opening, so only that button spins.
  const [checkoutLoading, setCheckoutLoading] = useState<CheckoutMethod | null>(null);
  // `id` remounts the alert on every failure, so a repeated failure is announced and focused again.
  const [checkoutError, setCheckoutError] = useState<{ message: string; id: number } | null>(null);
  // Below sm the line items are stacked rows, not a four-column table (mobile slice 28). A hook,
  // not CSS, so only one of the two structures is in the DOM for assistive technology.
  const stackLines = useMediaQuery('(max-width: 639px)');
  // A cancelled checkout: a banner over the invoice, which can be paid again.
  const [cancelledBanner, setCancelledBanner] = useState(false);
  // Slice 25 - back from a completed checkout: which confirmation to show instead of the invoice.
  const [confirmation, setConfirmation] = useState<CheckoutMethod | null>(null);
  // Bumped to re-read the invoice (leaving the confirmation, or after the invoice changed).
  const [reloadKey, setReloadKey] = useState(0);
  // The checkout door said the invoice changed under the page; it has been re-read.
  const [changedSinceOpened, setChangedSinceOpened] = useState(false);
  const [availableMethods, setAvailableMethods] = useState<string[]>([]);
  // Slice 25 - what can be paid online now (the amount due less bank payments still clearing).
  // Absent on a payload from before slice 25, which then pays the amount due.
  const [payableNowAmount, setPayableNowAmount] = useState<number | null>(null);
  const [processingAmount, setProcessingAmount] = useState(0);
  const [servedPayState, setServedPayState] = useState<PayState | null>(null);
  const [holdReason, setHoldReason] = useState<string | null>(null);
  const [paymentInstructions, setPaymentInstructions] = useState<Record<string, string>>({});
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  // Slice 26 - partial amount and tip. `amountText` null = the whole payable-now amount.
  const [paymentOptions, setPaymentOptions] = useState<PublicPaymentOptions>({ allow_partial: false, tips: { enabled: false, presets: [] } });
  const [amountText, setAmountText] = useState<string | null>(null);
  const [tipChoice, setTipChoice] = useState<TipChoice>({ kind: 'none' });
  const [customTipText, setCustomTipText] = useState('');

  /* --- Fetch invoice --- */

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation of the URL token; there is no external system to sync with
      setError('Invalid link - token missing');
      setLoading(false);
      return;
    }

    // The first load takes the request public/public-early.js started before this code arrived.
    fetchPublicDocument(`${import.meta.env.VITE_API_URL || ''}/api/invoices/${id}/public?token=${encodeURIComponent(token)}`)
      .then((res) => {
        if (!res.ok) throw new Error('Invoice not found');
        return res.json();
      })
      .then((data) => {
        setInvoice(data.invoice);
        setOrganization(data.organization ?? null);
        setAvailableMethods(data.available_payment_methods || []);
        setPayableNowAmount(typeof data.payable_now === 'number' ? data.payable_now : null);
        setProcessingAmount(typeof data.processing_amount === 'number' ? data.processing_amount : 0);
        setServedPayState(PAY_STATES.includes(data.pay_state) ? (data.pay_state as PayState) : null);
        setHoldReason(typeof data.deposit_hold_reason === 'string' ? data.deposit_hold_reason : null);
        setPaymentInstructions(data.payment_instructions || {});
        const options = data.payment_options;
        setPaymentOptions({
          allow_partial: options?.allow_partial === true,
          tips: {
            enabled: options?.tips?.enabled === true,
            presets: Array.isArray(options?.tips?.presets) ? options.tips.presets.filter((n: unknown) => typeof n === 'number') : [],
          },
        });
      })
      .catch(() => {
        setError('This invoice is no longer available.');
      })
      .finally(() => setLoading(false));
  }, [id, token, reloadKey]);

  // Handle Stripe return params
  useEffect(() => {
    if (!paymentParam) return;
    if (paymentParam === 'success') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the checkout return param out of the URL once, then clears it; the URL IS the external system here
      setConfirmation(methodParam === 'bank' ? 'bank' : 'card');
    } else if (paymentParam === 'cancelled') {
      setCancelledBanner(true);
    }
    // Clear the query params so refresh doesn't re-trigger
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('payment');
    newParams.delete('method');
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
  const payableNow = payableNowAmount ?? amountDue;

  // A payload from before slice 25 carries no pay_state; its status alone decides, as it used to.
  const payState: PayState =
    servedPayState ??
    (invoice.status === 'VOIDED'
      ? 'VOIDED'
      : invoice.status === 'PAID'
        ? 'PAID'
        : invoice.status === 'SENT' || invoice.status === 'PARTIAL'
          ? 'PAYABLE'
          : 'CLOSED');
  const isVoided = payState === 'VOIDED';
  const isPaid = payState === 'PAID';
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
  const overdue = isPayable && !!invoice.due_date && orgDayDiffIntl(invoice.due_date, timeZone) < 0;

  // Job-less DEPOSIT invoices carry the payer at the top level; job invoices
  // resolve it from the job. Fall back gracefully so neither path crashes.
  const payer = invoice.customer ?? invoice.job?.customer ?? null;
  const location = invoice.job?.service_location ?? null;
  const estimateLineItems = invoice.job?.estimate?.line_items ?? [];
  const jobCharges = invoice.job?.charges ?? [];
  // Deposit (job-less) invoices render their own line_items in the same shape.
  const ownLineItems = invoice.line_items ?? [];
  const scopes = invoice.scopes ?? [];
  // The rows the line-item block prints, each with the badge naming where it came from. Slice 24
  // rule: the customer page never prints a line that is not part of the invoice's total.
  //   1. The invoice's OWN lines always win, on a job invoice as on a deposit.
  //   2. No own lines but scope blocks: print nothing here - the priced scope blocks above ARE
  //      the subtotal, so an estimate line or job charge beside them would not add up.
  //   3. Neither: a job invoice raised before invoices owned their lines (pre 2026-06-04), whose
  //      subtotal was summed from the job's estimate lines plus its job charges at creation. Only
  //      that legacy invoice falls back to them. (The public payload no longer selects
  //      `job.charges`; the charges were backfilled into invoice lines, so in practice only the
  //      estimate lines can still arrive here.)
  // The invoice PDF (backend lib/pdf/invoice-select.ts) prints the invoice's own lines and scope
  // blocks only, with no fallback at all.
  const printedLines: Array<[PublicLineItem, 'estimate' | 'job' | null]> =
    ownLineItems.length > 0
      ? ownLineItems.map((item) => [item, null] as [PublicLineItem, null])
      : scopes.length > 0
        ? []
        : [
            ...estimateLineItems.map((item) => [item, 'estimate'] as [PublicLineItem, 'estimate']),
            ...jobCharges.map((item) => [item, 'job'] as [PublicLineItem, 'job']),
          ];

  /* --- Checkout handler --- */

  const handleCheckout = async (method: CheckoutMethod, extra: { amount?: number; tip?: number } = {}) => {
    if (!token) return;
    setCheckoutError(null);
    setCheckoutLoading(method);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/invoices/${id}/public/checkout?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The amount this page shows: the door refuses it as changed when the invoice moved since.
          body: JSON.stringify({ method, expected_amount: payableNow, ...extra }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.checkout_url) {
        // eslint-disable-next-line react-hooks/immutability -- deliberate full-page handoff to the hosted checkout; leaving the page is the intent
        window.location.href = data.checkout_url;
        return;
      }
      if (typeof data.code === 'string' && STALE_PAGE_CODES.has(data.code)) {
        // The page is out of date: re-read the invoice and show where it now stands.
        setChangedSinceOpened(data.code === 'INVOICE_CHANGED');
        setSelectedMethod(null);
        setAmountText(null);
        setTipChoice({ kind: 'none' });
        setCustomTipText('');
        setLoading(true);
        setReloadKey((k) => k + 1);
        return;
      }
      const message = refusalMessage(data, organization?.name ?? 'This business');
      setCheckoutError((prev) => ({ message, id: (prev?.id ?? 0) + 1 }));
    } catch {
      const message = refusalMessage({}, organization?.name ?? 'This business');
      setCheckoutError((prev) => ({ message, id: (prev?.id ?? 0) + 1 }));
    } finally {
      setCheckoutLoading(null);
    }
  };

  /* --- Voided state --- */

  if (isVoided) {
    // Slice 28b: a deposit on a closed estimate can hold a real payment ($200 of $500). "Voided"
    // would say the money is gone, so an invoice that holds a payment says what it holds.
    const held = invoice.payments.filter(paymentCounts).reduce((sum, p) => sum + Number(p.amount), 0);
    if (held > 0) {
      // The wording follows the invoice KIND, not "it holds a payment": a voided standard invoice
      // that took money is not a deposit.
      const isDeposit = invoice.kind === 'DEPOSIT';
      return (
        <PublicUnavailable
          title={isDeposit ? 'Deposit Closed' : 'Invoice Closed'}
          message={`This ${isDeposit ? 'deposit' : 'invoice'} is closed. A payment of ${formatCurrency(held)} was received on it. Please contact us for assistance.`}
        />
      );
    }
    return (
      <PublicUnavailable
        title="Invoice Voided"
        message="This invoice has been voided. Please contact us for assistance."
      />
    );
  }

  /* --- Invoice document --- */

  // Slice 24 (#1073) - what the customer is paying for, in the order it was written. A narrative
  // block that is not separately priced shows no amount: $0.00 would say the work is free.
  // One structure at every width: the amount wraps under the text when the row runs out of room.
  const renderScopeOfWork = () => (
    <section aria-labelledby="public-invoice-scope-heading" className="border-t pt-4">
      <h2 id="public-invoice-scope-heading" className="text-subtle-foreground mb-2 text-xs uppercase tracking-wide">
        Scope of work
      </h2>
      <ul className="flex flex-col divide-y">
        {scopes.map((scope) => (
          <li key={scope.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3 text-sm first:pt-0">
            <div className="min-w-0 flex-1 basis-48">
              <p className="font-medium [overflow-wrap:anywhere]">{scope.title}</p>
              {scope.body && (
                <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{scope.body}</p>
              )}
            </div>
            {scope.flat_price != null && (
              <p className="ml-auto shrink-0 font-medium tabular-nums">{formatCurrency(Number(scope.flat_price))}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );

  const renderLineItemsTable = () => {
    if (printedLines.length === 0) {
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

    const sourceBadge = (source: 'estimate' | 'job' | null) =>
      source === 'estimate' ? (
        <Badge variant="softNeutral" size="sm">
          Estimate
        </Badge>
      ) : source === 'job' ? (
        <Badge variant="softAmber" size="sm">
          Job
        </Badge>
      ) : null;

    const lines = printedLines;

    // Below sm: one stacked row per line, the description at full width and then the quantity,
    // unit price and amount, each under its own label. Nothing scrolls sideways at 320 px.
    if (stackLines) {
      const figure = (label: string, value: ReactNode, strong?: boolean) => (
        <div className={strong ? 'flex min-w-0 flex-col text-right' : 'flex min-w-0 flex-col'}>
          <dt className="text-subtle-foreground text-xs">{label}</dt>
          <dd className={strong ? 'font-medium tabular-nums' : 'tabular-nums'}>{value}</dd>
        </div>
      );
      return (
        <ul aria-label="Line items" className="flex flex-col divide-y">
          {lines.map(([item, source]) => (
            <li key={item.id} className="flex flex-col gap-1.5 py-3 text-sm first:pt-0">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.description}</p>
                {sourceBadge(source)}
              </div>
              {item.is_taxable && <span className="text-subtle-foreground text-xs">Taxable</span>}
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {figure('Qty', item.quantity)}
                {figure('Unit Price', formatCurrency(Number(item.unit_price)))}
                {figure('Amount', formatCurrency(Number(item.line_total)), true)}
              </dl>
            </li>
          ))}
        </ul>
      );
    }

    const row = (item: PublicLineItem, source: 'estimate' | 'job' | null) => (
      <TableRow key={item.id}>
        <TableCell>
          <div className="flex items-start gap-2">
            <div>
              <p>{item.description}</p>
              {item.is_taxable && <span className="text-subtle-foreground text-xs">Taxable</span>}
            </div>
            {sourceBadge(source)}
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
        <TableBody>{lines.map(([item, source]) => row(item, source))}</TableBody>
      </Table>
    );
  };

  const renderTotals = () => {
    const subtotal = Number(invoice.subtotal);
    const discountAmount = Number(invoice.discount_amount);
    const taxAmount = Number(invoice.tax_amount);
    const depositCredit = Number(invoice.deposit_credit);
    const totalAmount = Number(invoice.total_amount);
    const totalPayments = invoice.payments.filter(paymentCounts).reduce((sum, p) => sum + Number(p.amount), 0);
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

        {/* Slice 25 - a bank payment still clearing: not money received yet, but not owed twice. */}
        {processingAmount > 0 && (
          <div data-testid="public-invoice-processing" className="text-muted-foreground flex justify-between">
            <span>Processing</span>
            <span>{formatCurrency(processingAmount)}</span>
          </div>
        )}
      </div>
    );
  };

  const renderInvoiceDocument = () => (
    <PublicCard>
      <div className="flex flex-col gap-6">
        {/* Header. Wraps at 320 (mobile slice 28): the dates drop under the number rather than
            squeezing it. */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
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
                href={publicPdfHref('invoices', invoice.id, token)}
                className="mt-2 block"
              >
                View PDF
              </ActionLink>
            )}
          </div>
          <div className="flex flex-col gap-1 text-sm sm:text-right">
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
                {payer.email && <p className="text-muted-foreground [overflow-wrap:anywhere]">{payer.email}</p>}
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
              {location.address_line1 && <p>{location.address_line1}</p>}
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

        {scopes.length > 0 && renderScopeOfWork()}

        {/* Line items. Slice 24: a scope-only invoice is not empty, so it never says "No line
            items" under the scope of work it does carry. */}
        {(printedLines.length > 0 || scopes.length === 0) && (
          <div className="border-t pt-4">{renderLineItemsTable()}</div>
        )}

        {/* Totals */}
        <div data-testid="public-invoice-totals" className="w-full border-t pt-4 sm:ml-auto sm:max-w-xs">
          {renderTotals()}
        </div>

        {/* Payment history. Slice 28: each payment reads the way the customer paid; one still
            clearing says Processing and one that did not go through says Failed, so neither
            looks like money received. Refunds follow the payments. */}
        {invoice.payments.length > 0 && (
          <div className="border-t pt-4">
            <p className="text-subtle-foreground mb-2 text-xs uppercase tracking-wide">
              Payment History
            </p>
            <div className="flex flex-col gap-1.5">
              {invoice.payments.map((payment) => {
                const state = paymentStateLabel(payment.state);
                return (
                  <div key={payment.id} className="flex justify-between text-sm" data-state={payment.state ?? 'SUCCEEDED'}>
                    <span className="text-muted-foreground">
                      {describePayment(payment, { forCustomer: true })} - {formatInstant(payment.paid_at, timeZone, ORG_DAY_FORMAT)}
                      {state && <span className="text-subtle-foreground ml-2 text-xs font-medium uppercase tracking-wide">{state}</span>}
                    </span>
                    <span className={state ? 'text-muted-foreground' : 'font-medium'}>{formatCurrency(Number(payment.amount))}</span>
                  </div>
                );
              })}
              {(invoice.refunds ?? []).map((refund) => {
                const state = refundStateLabel(refund.state);
                return (
                  <div key={refund.id} className="flex justify-between text-sm" data-refund-state={refund.state}>
                    <span className="text-muted-foreground">
                      Refund - {formatInstant(refund.created_at, timeZone, ORG_DAY_FORMAT)}
                      {state && <span className="text-subtle-foreground ml-2 text-xs font-medium uppercase tracking-wide">{state}</span>}
                    </span>
                    <span className="font-medium">-{formatCurrency(Number(refund.amount))}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </PublicCard>
  );

  /* --- Pay panel (slice 25) --- */

  // The online methods in the resolver's order, then the manual ones. A card taken over the phone
  // (EXTERNAL_CARD) is a manual method: it is left out beside an online card, and when the business
  // has no phone to call.
  const onlineMethods = availableMethods.flatMap((m) => checkoutMethodOf(m) ?? []);
  const manualMethods = availableMethods.filter(
    (m) => !checkoutMethodOf(m) && !(m === 'EXTERNAL_CARD' && (onlineMethods.includes('card') || !organization?.phone)),
  );
  const manualLabel = (method: string) =>
    method === 'EXTERNAL_CARD' ? 'card over the phone' : formatMethodLabel(method);

  const renderPayPanel = () => {
    if (selectedMethod) {
      // A manual method: the business's own instructions.
      return (
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
            Pay by {manualLabel(selectedMethod)} - {formatCurrency(payableNow)}
          </PublicCardTitle>
          {selectedMethod === 'EXTERNAL_CARD' ? (
            <div className="bg-muted rounded-lg border p-3 text-sm">
              {/* SRVW-54 - number plus extension, concatenated for DISPLAY only; the two are
                  stored separately so inbound call attribution still matches. */}
              Call us at {formatPhone(organization?.phone ?? '')}
              {organization?.phone_ext ? ` ext. ${organization.phone_ext}` : ''} to pay by card.
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
      );
    }

    // Slice 26 - the amount and the tip, in whole cents. The server re-validates all of it.
    const payableNowCents = Math.round(payableNow * 100);
    const canPayPart = paymentOptions.allow_partial && payState === 'PAYABLE' && payableNowCents > MIN_PARTIAL_CENTS;
    const amountInput = amountText ?? (payableNowCents / 100).toFixed(2);
    const typedAmountCents = canPayPart ? parseDollarsToCents(amountInput) : payableNowCents;
    const amountError =
      !canPayPart
        ? null
        : typedAmountCents === null && TOO_MANY_DECIMALS.test(amountInput.trim())
          // A figure with a third decimal is an amount, just not in dollars and cents: not "empty".
          ? 'Enter an amount in dollars and cents.'
          : typedAmountCents === null || amountInput.trim() === ''
            ? 'Enter an amount to pay.'
            : typedAmountCents < MIN_PARTIAL_CENTS
            ? 'The smallest payment is $1.00.'
            : typedAmountCents > payableNowCents
              ? `That is more than the ${formatCurrency(payableNow)} that can be paid now.`
              : null;
    const amountCents = amountError ? null : typedAmountCents;

    const invoiceTotalCents = Math.round(Number(invoice.total_amount) * 100);
    const taxCents = Math.round(Number(invoice.tax_amount) * 100);
    const tipsOn = paymentOptions.tips.enabled;
    const presetTips = tipPresetCents({
      presets: paymentOptions.tips.presets,
      payingCents: amountCents ?? 0,
      totalCents: invoiceTotalCents,
      taxCents,
    });
    let tipError: string | null = null;
    let tipCents = 0;
    if (tipsOn && tipChoice.kind === 'preset') {
      tipCents = presetTips[paymentOptions.tips.presets.indexOf(tipChoice.pct)] ?? 0;
    } else if (tipsOn && tipChoice.kind === 'custom' && customTipText.trim() !== '') {
      const typedTip = parseDollarsToCents(customTipText);
      if (typedTip === null) tipError = 'Enter a tip of $0.00 or more.';
      else if (typedTip > invoiceTotalCents) tipError = `A tip can be at most ${formatCurrency(invoiceTotalCents / 100)}.`;
      else tipCents = typedTip;
    }
    const totalCents = amountCents === null || tipError ? null : amountCents + tipCents;
    const canPay = totalCents !== null;
    const showTotalLine = canPayPart || tipsOn;
    const payExtras = () => ({
      ...(canPayPart && amountCents !== null && amountCents !== payableNowCents ? { amount: centsToDollars(amountCents) } : {}),
      ...(tipCents > 0 ? { tip: centsToDollars(tipCents) } : {}),
    });

    return (
      <div className="flex flex-col gap-3">
        <PublicCardTitle level={2}>Payment Options</PublicCardTitle>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Amount due</span>
          <span className="font-medium tabular-nums">{formatCurrency(payableNow)}</span>
        </div>
        {onlineMethods.length > 0 && canPayPart && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="public-invoice-amount">Amount to pay</Label>
            <div className="relative">
              <span className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden>$</span>
              <Input
                id="public-invoice-amount"
                inputMode="decimal"
                autoComplete="off"
                className="pl-7 tabular-nums"
                value={amountInput}
                onChange={(e) => setAmountText(e.target.value)}
                aria-invalid={amountError ? true : undefined}
                aria-describedby={amountError ? 'public-invoice-amount-error' : undefined}
              />
            </div>
            {amountError && (
              <p id="public-invoice-amount-error" className="text-status-red-emphasis text-xs">{amountError}</p>
            )}
          </div>
        )}
        {onlineMethods.length > 0 && tipsOn && (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold">Add a tip</p>
            <div className="flex flex-wrap gap-2">
              {paymentOptions.tips.presets.map((pct, i) => {
                const chosen = tipChoice.kind === 'preset' && tipChoice.pct === pct;
                return (
                  <Button
                    key={pct}
                    type="button"
                    size="sm"
                    variant={chosen ? 'default' : 'outline'}
                    aria-pressed={chosen}
                    onClick={() => setTipChoice({ kind: 'preset', pct })}
                  >
                    {pct}% ({formatCurrency(centsToDollars(presetTips[i] ?? 0))})
                  </Button>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant={tipChoice.kind === 'custom' ? 'default' : 'outline'}
                aria-pressed={tipChoice.kind === 'custom'}
                onClick={() => setTipChoice({ kind: 'custom' })}
              >
                Custom
              </Button>
              <Button
                type="button"
                size="sm"
                variant={tipChoice.kind === 'none' ? 'default' : 'outline'}
                aria-pressed={tipChoice.kind === 'none'}
                onClick={() => setTipChoice({ kind: 'none' })}
              >
                No tip
              </Button>
            </div>
            {tipChoice.kind === 'custom' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="public-invoice-tip">Tip amount</Label>
                <div className="relative">
                  <span className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden>$</span>
                  <Input
                    id="public-invoice-tip"
                    inputMode="decimal"
                    autoComplete="off"
                    className="pl-7 tabular-nums"
                    value={customTipText}
                    onChange={(e) => setCustomTipText(e.target.value)}
                    aria-invalid={tipError ? true : undefined}
                    aria-describedby={tipError ? 'public-invoice-tip-error' : undefined}
                  />
                </div>
                {tipError && <p id="public-invoice-tip-error" className="text-status-red-emphasis text-xs">{tipError}</p>}
              </div>
            )}
          </div>
        )}
        {onlineMethods.length > 0 && showTotalLine && totalCents !== null && (
          <p className="flex justify-between border-t pt-3 text-sm font-semibold" data-testid="public-invoice-charge-total">
            <span>{`You'll be charged ${formatCurrency(centsToDollars(totalCents))}`}</span>
          </p>
        )}
        {onlineMethods.map((method, index) => {
          const isCard = method === 'card';
          const Icon = isCard ? CreditCard : Landmark;
          return (
            <div key={method} className="flex flex-col gap-1">
              <Button
                className="w-full"
                size="lg"
                // The first online method is the primary action.
                variant={index === 0 ? 'default' : 'outline'}
                onClick={() => handleCheckout(method, payExtras())}
                isLoading={checkoutLoading === method}
                disabled={checkoutLoading !== null || !canPay}
              >
                {checkoutLoading !== method && <Icon />}
                {isCard ? 'Pay by card' : 'Pay by bank'}
              </Button>
              {!isCard && (
                <p className="text-subtle-foreground text-xs">
                  Pay from your bank account. Bank payments take a few business days to clear.
                </p>
              )}
            </div>
          );
        })}
        {checkoutError && <PublicActionError key={checkoutError.id} message={checkoutError.message} />}
        {manualMethods.length > 0 && (
          <div className={onlineMethods.length > 0 ? 'flex flex-col gap-2 border-t pt-3' : 'flex flex-col gap-2'}>
            {onlineMethods.length > 0 && (
              <p className="text-subtle-foreground text-xs uppercase tracking-wide">Other ways to pay</p>
            )}
            {manualMethods.map((method) => {
              const Icon = METHOD_ICONS[method] || Wallet;
              return (
                <Button
                  key={method}
                  variant="outline"
                  // Wraps at 320 rather than clipping the label or the price (slice 28).
                  className="h-auto w-full justify-between whitespace-normal py-3 text-left"
                  onClick={() => setSelectedMethod(method)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon />
                    Pay by {manualLabel(method)}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-sm">{formatCurrency(payableNow)}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /* --- Main render --- */

  // Slice 24 - the contractor's branding, the same bar the public estimate page carries: the brand
  // colour is org data, so it rides an inline style (a token cannot express a per-tenant value). A
  // fixed-height logo, so the bar does not grow when it arrives.
  const brandBar = (
    <header
      style={{ backgroundColor: organization?.brand_color || defaultBrandColor() }}
      className="flex w-full items-center px-4 py-4"
    >
      {organization?.logo_url ? (
        <Thumbnail
          src={organization.logo_url}
          alt={organization.name}
          className="h-10 w-auto max-w-[50%] min-w-0 object-contain"
        />
      ) : (
        <span className="text-on-fill min-w-0 text-lg font-bold [overflow-wrap:anywhere]">
          {organization?.name || 'ServWave'}
        </span>
      )}
    </header>
  );

  // Slice 25 - back from a completed checkout. A card payment is received; a bank payment is only
  // on its way, and the homeowner is told how long it takes.
  if (confirmation) {
    const viewInvoice = () => {
      setConfirmation(null);
      setLoading(true);
      setReloadKey((k) => k + 1);
    };
    return (
      <PublicPage>
        {brandBar}
        <PublicColumn>
          <PublicCard>
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              {confirmation === 'card' ? (
                <CheckCircle2 className="text-status-green-emphasis size-12" aria-hidden />
              ) : (
                <Clock className="text-status-blue-emphasis size-12" aria-hidden />
              )}
              <PublicCardTitle level={1}>
                {confirmation === 'card' ? 'Payment received' : 'Your bank payment is processing'}
              </PublicCardTitle>
              {confirmation === 'bank' && (
                <p className="text-muted-foreground text-sm">It usually takes a few business days.</p>
              )}
              <p className="text-muted-foreground text-sm">Thank you for paying invoice {invoice.invoice_number}.</p>
              <Button variant="outline" onClick={viewInvoice}>
                View invoice
              </Button>
            </div>
          </PublicCard>
          {organization && (
            <PublicBusinessContact
              name={organization.name}
              phone={organization.phone}
              phoneExt={organization.phone_ext}
              email={organization.email}
            />
          )}
        </PublicColumn>
      </PublicPage>
    );
  }

  return (
    <PublicPage>
      {brandBar}

      <PublicColumn>
        {/* Non-fatal error banner */}
        {error && invoice && (
          <PublicNotice tone="danger">
            <p>{error}</p>
          </PublicNotice>
        )}

        {/* Slice 25 - the checkout door found the invoice changed; this is the re-read invoice. */}
        {changedSinceOpened && (
          <PublicNotice tone="warning" icon={<AlertTriangle />}>
            <p className="font-medium">This invoice changed since you opened it. Please check the amount below before paying.</p>
          </PublicNotice>
        )}

        {/* Back from a cancelled checkout */}
        {cancelledBanner && (
          <PublicNotice tone="warning" icon={<AlertTriangle />}>
            <p className="font-medium">Payment was cancelled. You can try again.</p>
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

        {/* Slice 25 - the invoice changed under the link, or takes no money online at all. */}
        {payState === 'CHANGED' && (
          <PublicNotice tone="warning" icon={<AlertTriangle />}>
            <p className="font-medium">{changedMessage(holdReason)}</p>
          </PublicNotice>
        )}
        {payState === 'CLOSED' && (
          <PublicNotice tone="neutral">
            <p>This invoice can&apos;t be paid online. Please contact us with any questions.</p>
          </PublicNotice>
        )}

        {/* Slice 25 - a bank payment covers what is due; it clears by itself. */}
        {payState === 'PROCESSING' && (
          <PublicNotice tone="info" icon={<Clock />}>
            <p className="font-medium">Your bank payment is processing. It usually takes a few business days.</p>
          </PublicNotice>
        )}

        {/* Payment methods section. With no way to pay on offer (an override holding only methods
            the account cannot take), the page says how to pay instead of showing nothing. */}
        {payState === 'PAYABLE' && payableNow > 0 && (
          onlineMethods.length + manualMethods.length > 0 ? (
            <PublicCard>{renderPayPanel()}</PublicCard>
          ) : (
            <PublicNotice tone="neutral">
              <p>To pay this invoice, please contact {organization?.name ?? 'us'}.</p>
            </PublicNotice>
          )
        )}

        {/* The business's phone and email as a call link and a mail link (mobile slice 28). */}
        {organization && (
          <PublicBusinessContact
            name={organization.name}
            phone={organization.phone}
            phoneExt={organization.phone_ext}
            email={organization.email}
          />
        )}
      </PublicColumn>
    </PublicPage>
  );
}
