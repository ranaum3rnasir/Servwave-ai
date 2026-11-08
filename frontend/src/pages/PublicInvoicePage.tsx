import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { ActionLink } from '@/components/ui/action-link';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  CreditCard,
  AlertTriangle,
  Clock,
  Banknote,
  Landmark,
  Wallet,
  ChevronLeft,
} from 'lucide-react';
import { formatCurrency, formatPhone } from '@/lib/utils';
import { formatExactDay } from '@/lib/format-date';

// ─── Types ──────────────────────────────────────────

/**
 * #2031 slice 5 — why a deposit link is refusing money, as the backend reports it
 * (invoice.controller's `depositHoldReason`). Both are temporary and neither means the link is
 * dead: the next send re-prices this same deposit behind this same link.
 */
type DepositHoldReason = 'SUPERSEDED' | 'ESTIMATE_IN_DRAFT' | null;

/** Narrows whatever the payload carried; anything unrecognised means "payable", never a mystery
 *  banner. The doors refuse independently, so guessing here could only ever cost a valid payment. */
function readHoldReason(value: unknown): DepositHoldReason {
  return value === 'SUPERSEDED' || value === 'ESTIMATE_IN_DRAFT' ? value : null;
}

/**
 * A refusal that arrives AFTER the page loaded is recognised by its stable code, never by its
 * wording — matching wording is how the superseded refusal came to be answered with "please try
 * again", advice that could not work (F5).
 */
const HOLD_BY_REFUSAL_CODE: Record<string, Exclude<DepositHoldReason, null> | undefined> = {
  DEPOSIT_SUPERSEDED: 'SUPERSEDED',
  DEPOSIT_ON_HOLD: 'ESTIMATE_IN_DRAFT',
};

interface PublicOrganization {
  name: string;
  logo_url?: string | null;
  brand_color?: string | null;
  phone?: string | null;
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
    service_location: { address_line1: string; address_line2: string | null; city: string; state: string; zip: string };
  } | null;
  payments: { id: string; amount: number | string; method: string; paid_at: string }[];
}

// ─── Helpers ────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit Card',
  EXTERNAL_CARD: 'Credit Card',
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank Transfer',
  CASH: 'Cash',
  // R5b (2026-07-22) — D3.
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
  // R5b — peer-to-peer apps share Wallet, same "collapse to one icon" precedent as CARD above.
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

function formatMethodLabel(method: string): string {
  return METHOD_LABELS[method] || method;
}

// §4.5 — collapse CARD + EXTERNAL_CARD into a single customer-facing entry.
// CARD always wins when both are present (matches the controller's routing).
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

// ─── Component ──────────────────────────────────────

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
  // Slice 4 (card service fee) — display-only preview computed server-side (D8).
  const [serviceFeePreview, setServiceFeePreview] = useState(0);
  // Slice 8 (customer-facing tipping) — the ToggleGroup value: '10' | '15' | '20' | 'other' | ''
  // (Radix's "nothing selected" sentinel for type="single"). Nothing preselected (D11).
  const [tipPresetBps, setTipPresetBps] = useState<number[]>([]);
  // #2031 slice 5 — why this deposit cannot be paid right now, or null when it can. Two reasons,
  // both temporary: the estimate was edited after the deposit went out and the amount no longer
  // matches it ('SUPERSEDED'), or the estimate was recalled to draft and the document has been
  // withdrawn for changes ('ESTIMATE_IN_DRAFT'). In both cases the link is deliberately still
  // alive — the deposit is re-priced, never voided, on the next send, behind this same link — so
  // the page keeps rendering the document and withdraws only the payment options.
  const [depositHold, setDepositHold] = useState<DepositHoldReason>(null);
  const [tipSelection, setTipSelection] = useState('');
  const [tipOtherValue, setTipOtherValue] = useState('');

  // ─── Fetch invoice ─────────────────────────────────

  useEffect(() => {
    if (!token) {
      setError('Invalid link — token missing');
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
        setTipPresetBps(Array.isArray(data.tip_preset_bps) ? data.tip_preset_bps : []);
        setDepositHold(readHoldReason(data.deposit_hold_reason));
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
      setPaymentBanner({ type: 'success', message: 'Payment received! It may take a moment to process.' });
    } else if (paymentParam === 'cancelled') {
      setPaymentBanner({ type: 'warning', message: 'Payment was cancelled. You can try again.' });
    }
    // Clear the query param so refresh doesn't re-trigger
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('payment');
    setSearchParams(newParams, { replace: true });
  }, [paymentParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Loading & error states ────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-light">
        <Loader2 className="h-8 w-8 animate-spin text-text-soft" />
      </div>
    );
  }

  if (error && !invoice) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-light">
        <Card padding="lg" className="max-w-md text-center">
          <XCircle className="h-12 w-12 text-text-soft mx-auto mb-4" />
          <Heading level={2} scale="lg" className="mb-2">Unavailable</Heading>
          <p className="text-sm text-text-secondary">{error}</p>
        </Card>
      </div>
    );
  }

  if (!invoice) return null;

  // ─── Derived values ────────────────────────────────

  const amountDue = Number(invoice.amount_due);
  // Slice 4 — "chosen to pay by card" = the card panel is the one currently revealed.
  const cardFeeSelected = selectedMethod === 'CARD' && serviceFeePreview > 0;

  // Slice 8 — percentage is an input affordance only; the dollar figure is what is stored/sent
  // (D11). "Other" is clamped at zero so a stray negative can never reach the total.
  const tipDollars = tipSelection === 'other'
    ? Math.max(0, parseFloat(tipOtherValue) || 0)
    : tipSelection
      ? Math.round(amountDue * (Number(tipSelection) / 100) * 100) / 100
      : 0;

  const isVoided = invoice.status === 'VOIDED';
  const isPaid = invoice.status === 'PAID';
  // The checkout POST refuses a held deposit outright (invoice.controller's `depositHoldReason`,
  // the one predicate both ends answer to), so folding it in here is what keeps the page from
  // offering a button that is going to be declined.
  const isPayable = (invoice.status === 'SENT' || invoice.status === 'PARTIAL') && !depositHold;

  // Job-less DEPOSIT invoices carry the payer at the top level; job invoices
  // resolve it from the job. Fall back gracefully so neither path crashes.
  const payer = invoice.customer ?? invoice.job?.customer ?? null;
  const location = invoice.job?.service_location ?? null;
  const estimateLineItems = invoice.job?.estimate?.line_items ?? [];
  const jobCharges = invoice.job?.charges ?? [];
  // Deposit (job-less) invoices render their own line_items in the same table shape.
  const ownLineItems = invoice.line_items ?? [];

  // ─── Checkout handler ──────────────────────────────

  const handleCheckout = async () => {
    if (!token) return;
    setCheckoutLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/invoices/${id}/public/checkout?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tipDollars > 0 ? { tip: tipDollars } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // The refusal reason rides on a stable code, not on the wording — matching the copy is how
        // the superseded refusal came to be answered with "please try again" in the first place.
        throw Object.assign(
          new Error(data.error || 'Failed to create checkout session'),
          { code: typeof data.code === 'string' ? data.code : undefined },
        );
      }
      const data = await res.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    } catch (err) {
      // §6.8 — map the card-unavailable 400 to friendly homeowner copy instead of the
      // raw backend string; the generic fallback also stops any other raw backend
      // string from leaking to the homeowner.
      const msg = (err as any)?.response?.data?.error ?? (err as Error).message;
      const code = (err as { code?: string } | undefined)?.code;
      const orgName = organization?.name ?? 'This business';
      // #2031 slice 5 (F5) — this page can be older than the estimate behind it: it loaded while
      // the deposit was payable, so it offered a Pay button, and the estimate was edited or
      // recalled before the customer pressed it. Retrying is the one thing that cannot work, so
      // the page says what actually happened and converges on the state a fresh load would have
      // rendered — payment options withdrawn, the document still there.
      const holdFromRefusal = code ? HOLD_BY_REFUSAL_CODE[code] : undefined;
      if (holdFromRefusal) {
        setDepositHold(holdFromRefusal);
        setError(msg);
      } else {
        setError(/card payments? (are|is) not/i.test(msg)
          ? `${orgName} isn't accepting card payments right now — choose another payment method or contact us.`
          : 'Something went wrong starting your payment. Please try again or contact us.');
      }
    } finally {
      setCheckoutLoading(false);
    }
  };

  // ─── Voided state ──────────────────────────────────

  if (isVoided) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-light">
        <Card padding="lg" className="max-w-md text-center">
          <XCircle className="h-12 w-12 text-text-soft mx-auto mb-4" />
          <Heading level={2} scale="lg" className="mb-2">Invoice Voided</Heading>
          <p className="text-sm text-text-secondary">This invoice has been voided. Please contact us for assistance.</p>
        </Card>
      </div>
    );
  }

  // ─── Invoice document ─────────────────────────────

  const renderLineItemsTable = () => {
    const hasEstimateItems = estimateLineItems.length > 0;
    const hasJobCharges = jobCharges.length > 0;
    // Job-less (deposit) invoices fall back to the invoice's own line_items.
    const ownItems = !invoice.job ? ownLineItems : [];
    const hasOwnItems = ownItems.length > 0;

    if (!hasEstimateItems && !hasJobCharges && !hasOwnItems) {
      return (
        <p className="text-sm text-text-soft italic py-2">No line items</p>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-secondary uppercase tracking-wide">
              <th className="pb-2 pr-4 font-medium">Description</th>
              <th className="pb-2 pr-4 font-medium text-right">Qty</th>
              <th className="pb-2 pr-4 font-medium text-right">Unit Price</th>
              <th className="pb-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {estimateLineItems.map((item) => (
              <tr key={item.id}>
                <td className="py-2 pr-4">
                  <div className="flex items-start gap-2">
                    <div>
                      <p className="text-text-primary">{item.description}</p>
                      {item.is_taxable && (
                        <span className="text-xs text-text-soft">Taxable</span>
                      )}
                    </div>
                    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-neutral-surface text-neutral-text">
                      Estimate
                    </span>
                  </div>
                </td>
                <td className="py-2 pr-4 text-right text-text-primary">{item.quantity}</td>
                <td className="py-2 pr-4 text-right text-text-primary">{formatCurrency(Number(item.unit_price))}</td>
                <td className="py-2 text-right text-text-primary font-medium">{formatCurrency(Number(item.line_total))}</td>
              </tr>
            ))}
            {jobCharges.map((item) => (
              <tr key={item.id}>
                <td className="py-2 pr-4">
                  <div className="flex items-start gap-2">
                    <div>
                      <p className="text-text-primary">{item.description}</p>
                      {item.is_taxable && (
                        <span className="text-xs text-text-soft">Taxable</span>
                      )}
                    </div>
                    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-warning-surface text-warning-text">
                      Job
                    </span>
                  </div>
                </td>
                <td className="py-2 pr-4 text-right text-text-primary">{item.quantity}</td>
                <td className="py-2 pr-4 text-right text-text-primary">{formatCurrency(Number(item.unit_price))}</td>
                <td className="py-2 text-right text-text-primary font-medium">{formatCurrency(Number(item.line_total))}</td>
              </tr>
            ))}
            {ownItems.map((item) => (
              <tr key={item.id}>
                <td className="py-2 pr-4">
                  <div>
                    <p className="text-text-primary">{item.description}</p>
                    {item.is_taxable && (
                      <span className="text-xs text-text-soft">Taxable</span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right text-text-primary">{item.quantity}</td>
                <td className="py-2 pr-4 text-right text-text-primary">{formatCurrency(Number(item.unit_price))}</td>
                <td className="py-2 text-right text-text-primary font-medium">{formatCurrency(Number(item.line_total))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between text-text-secondary">
          <span>Subtotal</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>

        {discountAmount > 0 && (
          <div className="flex justify-between text-text-secondary">
            <span>
              Discount
              {estimateData?.discount_name && (
                <span className="text-text-soft ml-1">({estimateData.discount_name})</span>
              )}
            </span>
            <span className="text-success-text">−{formatCurrency(discountAmount)}</span>
          </div>
        )}

        {taxAmount > 0 && (
          <div className="flex justify-between text-text-secondary">
            <span>
              Tax
              {estimateData?.tax_rate && (
                <span className="text-text-soft ml-1">({Number(estimateData.tax_rate)}%)</span>
              )}
            </span>
            <span>{formatCurrency(taxAmount)}</span>
          </div>
        )}

        <div className="flex justify-between text-text-primary font-medium pt-1 border-t border-border">
          <span>Total</span>
          <span>{formatCurrency(totalAmount)}</span>
        </div>

        {depositCredit > 0 && (
          <div className="flex justify-between text-text-secondary">
            <span>Deposit credit</span>
            <span className="text-success-text">−{formatCurrency(depositCredit)}</span>
          </div>
        )}

        {totalPayments > 0 && (
          <div className="flex justify-between text-text-secondary">
            <span>Payments received</span>
            <span className="text-success-text">−{formatCurrency(totalPayments)}</span>
          </div>
        )}

        <div className="flex justify-between pt-2 border-t-2 border-text-primary">
          <span className="text-base font-bold text-text-primary">Amount Due</span>
          <span className="text-base font-bold text-text-primary">{formatCurrency(amountDue)}</span>
        </div>

        {/* Slice 4 (card service fee) — always present in the breakdown; only carries an amount
            once the customer has chosen to pay by card (Ran's explicit framing). */}
        <div className="flex justify-between text-text-secondary pt-1.5 border-t border-border">
          <span>
            Service fee
            <span className="text-text-soft ml-1 text-xs">(card payments only)</span>
          </span>
          <span>{cardFeeSelected ? formatCurrency(serviceFeePreview) : '—'}</span>
        </div>

        {cardFeeSelected && (
          <div className="flex justify-between text-text-primary font-medium">
            <span>Total due by card</span>
            <span>{formatCurrency(amountDue + serviceFeePreview)}</span>
          </div>
        )}
      </div>
    );
  };

  const renderInvoiceDocument = () => (
    <Card className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          {/* Dropped `tracking-tight`: Heading has no letter-spacing prop, and
              className is layout-only after conversion (layering-guard). */}
          <Heading level={1} scale="2xl" weight="bold">INVOICE</Heading>
          <p className="text-text-secondary text-sm mt-1">{invoice.invoice_number}</p>
          {invoice.job?.estimate && (
            <p className="text-text-soft text-xs mt-0.5">
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
        <div className="text-right text-sm space-y-1">
          {invoice.sent_at && (
            <p className="text-text-secondary">
              <span className="text-text-soft">Sent: </span>
              {new Date(invoice.sent_at).toLocaleDateString()}
            </p>
          )}
          {invoice.due_date && (
            <p className="text-text-secondary">
              <span className="text-text-soft">Due: </span>
              {formatExactDay(invoice.due_date)}
            </p>
          )}
          {invoice.paid_at && (
            <p className="text-success-text font-medium">
              Paid {new Date(invoice.paid_at).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      {/* Customer & location */}
      <div className="border-t border-border pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-text-soft uppercase tracking-wide mb-1">Bill To</p>
          {payer ? (
            <>
              <p className="font-medium text-text-primary">{payer.first_name} {payer.last_name}</p>
              {payer.email && <p className="text-text-secondary">{payer.email}</p>}
              {payer.phone && <p className="text-text-secondary">{formatPhone(payer.phone)}</p>}
            </>
          ) : (
            <p className="text-text-soft italic">—</p>
          )}
        </div>
        {location ? (
          <div>
            <p className="text-xs text-text-soft uppercase tracking-wide mb-1">Service Address</p>
            <p className="text-text-primary">{location.address_line1}</p>
            {location.address_line2 && <p className="text-text-primary">{location.address_line2}</p>}
            <p className="text-text-primary">{location.city}, {location.state} {location.zip}</p>
          </div>
        ) : (
          <div>
            <p className="text-xs text-text-soft uppercase tracking-wide mb-1">Type</p>
            <p className="text-text-primary">{invoice.kind === 'DEPOSIT' ? 'Deposit' : 'Invoice'}</p>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="border-t border-border pt-4">
        {renderLineItemsTable()}
      </div>

      {/* Totals */}
      <div className="border-t border-border pt-4 max-w-xs ml-auto">
        {renderTotals()}
      </div>

      {/* Payment history */}
      {invoice.payments.length > 0 && (
        <div className="border-t border-border pt-4">
          <p className="text-xs text-text-soft uppercase tracking-wide mb-2">Payment History</p>
          <div className="space-y-1.5">
            {invoice.payments.map((payment) => (
              <div key={payment.id} className="flex justify-between text-sm">
                <span className="text-text-secondary">
                  {formatMethodLabel(payment.method)} — {new Date(payment.paid_at).toLocaleDateString()}
                </span>
                <span className="text-text-primary font-medium">{formatCurrency(Number(payment.amount))}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );

  // ─── Main render ──────────────────────────────────

  return (
    <div className="fixed inset-0 bg-background-light overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-6 py-8 px-4">

        {/* Non-fatal error banner */}
        {error && invoice && (
          <Card padding="sm" tone="danger">
            <p className="text-sm text-danger-text">{error}</p>
          </Card>
        )}

        {/* Payment return banner */}
        {paymentBanner && (
          <Card padding="sm" tone={paymentBanner.type === 'success' ? 'success' : 'warning'}>
            <div className="flex items-center gap-3">
              {paymentBanner.type === 'success'
                ? <CheckCircle2 className="h-5 w-5 text-success-text" />
                : <AlertTriangle className="h-5 w-5 text-warning-text" />}
              <p className={`font-medium ${paymentBanner.type === 'success' ? 'text-success-text' : 'text-warning-text'}`}>
                {paymentBanner.message}
              </p>
            </div>
          </Card>
        )}

        {/* Invoice document */}
        {renderInvoiceDocument()}

        {/* Paid state — "Paid in Full" banner */}
        {isPaid && (
          <Card padding="sm" tone="success">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-success-text" />
              <div>
                <p className="font-medium text-success-text">Paid in Full</p>
                {invoice.paid_at && (
                  <p className="text-xs text-success-text">
                    Payment completed on {new Date(invoice.paid_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* #2031 slice 5 — the deposit cannot be paid right now, so no payment options. The two
            reasons read differently on purpose: one says the amount moved, the other says the
            document was withdrawn, and telling a customer the wrong one is its own small defect. */}
        {depositHold && !isPaid && (
          <Card padding="sm" tone="warning">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 shrink-0 text-warning-text" />
              <div>
                <p className="font-medium text-warning-text">
                  {depositHold === 'ESTIMATE_IN_DRAFT'
                    ? 'This deposit request is on hold'
                    : 'This deposit request is being updated'}
                </p>
                <p className="text-xs text-warning-text">
                  {depositHold === 'ESTIMATE_IN_DRAFT'
                    ? 'Your estimate is being updated, so this request cannot be paid at the moment. An updated request will follow — please get in touch if you need it sooner.'
                    : 'The estimate has changed since this request was sent, so the amount below is out of date. An updated request will follow — please get in touch if you need it sooner.'}
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Overdue notice */}
        {isPayable && invoice.due_date && new Date(invoice.due_date) < new Date() && (
          <Card padding="sm" tone="warning">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-warning-text" />
              <p className="font-medium text-warning-text">
                This invoice was due on {formatExactDay(invoice.due_date)}
              </p>
            </div>
          </Card>
        )}

        {/* Payment methods section */}
        {isPayable && amountDue > 0 && availableMethods.length > 0 && (
          <Card>
            {selectedMethod === 'CARD' ? (
              // ── Selected CARD: fee breakdown, then checkout ──
              <div className="space-y-4">
                <Button
                  type="button"
                  variant="ghost"
                  tone="subtle"
                  size={null}
                  className="gap-1"
                  onClick={() => setSelectedMethod(null)}
                >
                  <ChevronLeft className="h-4 w-4" /> Back to payment methods
                </Button>
                <Heading level={3}>Pay by Card</Heading>
                <div className="space-y-1.5 text-sm border rounded-lg p-3 bg-neutral-surface">
                  <div className="flex justify-between text-text-secondary">
                    <span>Amount due</span>
                    <span>{formatCurrency(amountDue)}</span>
                  </div>
                  {serviceFeePreview > 0 && (
                    <div className="flex justify-between text-text-secondary">
                      <span>Service fee</span>
                      <span>{formatCurrency(serviceFeePreview)}</span>
                    </div>
                  )}
                  {/* Slice 8 — stays fixed while the tip changes above; visible proof the fee is
                      never applied to the tip (D7 amendment). Only present once a tip is chosen. */}
                  {tipDollars > 0 && (
                    <div className="flex justify-between text-text-secondary">
                      <span>Tip</span>
                      <span>{formatCurrency(tipDollars)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-text-primary font-medium pt-1.5 border-t border-border">
                    <span>Total charged to card</span>
                    <span>{formatCurrency(amountDue + serviceFeePreview + tipDollars)}</span>
                  </div>
                </div>
                {serviceFeePreview > 0 && (
                  <p className="text-xs text-text-soft">A service fee applies to card payments only.</p>
                )}

                {/* Slice 8 (customer-facing tipping, D10/D11) — invoices only. Nothing preselected;
                    no "No tip" chip; percentage is an input affordance only, dollars are what is
                    stored/sent. Lives in this panel, not the invoice document (a tip is not owed). */}
                {tipPresetBps.length > 0 && (
                  <div className="space-y-2">
                    <Label size="sm">Add a tip? (optional)</Label>
                    <ToggleGroup
                      type="single"
                      variant="pill"
                      value={tipSelection}
                      onValueChange={(v) => setTipSelection(v)}
                      aria-label="Tip amount"
                    >
                      {tipPresetBps.map((bps) => {
                        const pct = bps / 100;
                        const dollars = Math.round(amountDue * (pct / 100) * 100) / 100;
                        return (
                          <ToggleGroupItem
                            key={pct}
                            value={String(pct)}
                            variant="pill"
                            className="inline-flex min-h-11 flex-col items-center justify-center gap-0 px-4 py-1.5"
                          >
                            <span>{pct}%</span>
                            <span className="text-xs opacity-80">{formatCurrency(dollars)}</span>
                          </ToggleGroupItem>
                        );
                      })}
                      <ToggleGroupItem value="other" variant="pill" className="min-h-11 px-4">
                        Other
                      </ToggleGroupItem>
                    </ToggleGroup>
                    {tipSelection === 'other' && (
                      <div className="space-y-1 max-w-[10rem]">
                        <Label htmlFor="tip-other-amount" size="sm">Tip amount</Label>
                        <Input
                          id="tip-other-amount"
                          type="number"
                          min={0}
                          step={0.01}
                          inputMode="decimal"
                          placeholder="0.00"
                          value={tipOtherValue}
                          onChange={(e) => setTipOtherValue(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )}

                <Button
                  className="w-full"
                  size="lg"
                  onClick={handleCheckout}
                  disabled={checkoutLoading}
                >
                  {checkoutLoading
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <CreditCard className="mr-2 h-5 w-5" />}
                  Pay {formatCurrency(amountDue + serviceFeePreview + tipDollars)}
                </Button>
              </div>
            ) : selectedMethod ? (
              // ── Selected non-card method: show instructions ──
              <div className="space-y-4">
                {/* ghost/subtle matches the idle text-text-secondary and hover:text-text-primary exactly
                    (this is its documented "back buttons" use case). gap-1 restores the raw's exact icon
                    gap over Button's base gap-2. One disclosed, not-restored delta: ghost/subtle also
                    adds a hover:bg-background-light highlight that the raw button didn't have. */}
                <Button
                  type="button"
                  variant="ghost"
                  tone="subtle"
                  size={null}
                  className="gap-1"
                  onClick={() => setSelectedMethod(null)}
                >
                  <ChevronLeft className="h-4 w-4" /> Back to payment methods
                </Button>
                <Heading level={3}>
                  Pay by {formatMethodLabel(selectedMethod)} — {formatCurrency(amountDue)}
                </Heading>
                {/* §4.5 — EXTERNAL_CARD shows the call-us block; real CARD
                    never reaches this branch (Stripe handles checkout inline). */}
                {selectedMethod === 'EXTERNAL_CARD' ? (
                  <div className="bg-neutral-surface border rounded-lg p-3 text-sm text-text-primary">
                    To pay by credit card, please call our office
                    {organization?.phone ? ` at ${formatPhone(organization.phone)}` : ''}.
                  </div>
                ) : (
                  paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || ''] && (
                    <div className="bg-neutral-surface border rounded-lg p-3 text-sm text-text-primary whitespace-pre-wrap">
                      {paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || '']}
                    </div>
                  )
                )}
                <p className="text-xs text-text-secondary">
                  Once we receive your payment, your invoice will be updated automatically.
                </p>
              </div>
            ) : (
              // ── Method picker ──
              <div className="space-y-3">
                <Heading level={2} scale="base">Payment Options</Heading>
                {collapseCardMethods(availableMethods).map((method) => {
                  const Icon = METHOD_ICONS[method] || CreditCard;
                  const isCard = method === 'CARD' || method === 'EXTERNAL_CARD';
                  // §4.5 — CARD takes the inline Stripe-breakdown panel; the
                  // raw token (CARD vs EXTERNAL_CARD) is what decides routing
                  // (controller side already enforces the gate).
                  const cardIsStripe = method === 'CARD';
                  return (
                    <div key={method}>
                      {cardIsStripe ? (
                        // Card on STRIPE: click reveals the fee breakdown before checkout.
                        <div className="border rounded-lg p-4 space-y-3">
                          <div className="flex items-center gap-2">
                            <CreditCard className="h-5 w-5 text-text-secondary" />
                            <span className="text-sm font-medium">Pay by Card</span>
                          </div>
                          <Button
                            className="w-full"
                            size="lg"
                            onClick={() => setSelectedMethod('CARD')}
                          >
                            <CreditCard className="mr-2 h-5 w-5" />
                            Pay {formatCurrency(amountDue)} by Card
                          </Button>
                        </div>
                      ) : (
                        // EXTERNAL_CARD or any non-card method: click-to-reveal button
                        <Button
                          variant="outline"
                          className="w-full justify-between h-auto py-3"
                          onClick={() => setSelectedMethod(method)}
                        >
                          <span className="flex items-center gap-2">
                            <Icon className="h-5 w-5" />
                            Pay {isCard ? 'with' : 'by'} {formatMethodLabel(method)}
                          </span>
                          <span className="text-sm text-text-secondary">{formatCurrency(amountDue)}</span>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

      </div>
    </div>
  );
}
