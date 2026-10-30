/**
 * Payments go-live slice 28: how a payment reads in the payment history.
 *
 * Office users answer "how did I pay?" from one line: the card brand and last four, the wallet it
 * came through, or the bank and its last four. A hand-recorded payment reads its method. The
 * customer's own public page reads the same lines. Nothing here names the processor: the org and
 * its customers see the payment METHOD, never the service it is routed through.
 */
import type { PaymentState, RefundState } from '@/types/entities';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import type { PaymentMethod } from '@/lib/api/organization';
import { formatCurrency } from '@/lib/utils';

/** The details captured from the charge, for display only. All optional: older rows have none. */
export interface PaymentDisplayFields {
  method: string;
  wallet?: 'APPLE_PAY' | 'GOOGLE_PAY' | 'LINK' | null;
  card_brand?: string | null;
  card_last4?: string | null;
  bank_name?: string | null;
  bank_last4?: string | null;
}

const DOTS = '••••';

const CARD_BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

const WALLETS: Record<'APPLE_PAY' | 'GOOGLE_PAY', string> = { APPLE_PAY: 'Apple Pay', GOOGLE_PAY: 'Google Pay' };

/** "Something new" from "SOMETHING_NEW" / "something new": a code is never shown raw. */
function tidy(code: string): string {
  const words = code.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cardLine(p: PaymentDisplayFields): string | null {
  const brand = p.card_brand ? (CARD_BRANDS[p.card_brand.toLowerCase()] ?? tidy(p.card_brand)) : null;
  const last4 = p.card_last4 ? `${DOTS} ${p.card_last4}` : null;
  if (brand && last4) return `${brand} ${last4}`;
  return brand ?? last4;
}

/**
 * One line: how this payment was made. `forCustomer` is the customer's own page, which never says
 * "ACH": a bank payment with no bank on record reads "Bank payment" there.
 */
export function describePayment(p: PaymentDisplayFields, opts: { forCustomer?: boolean } = {}): string {
  if (p.method === 'ACH') {
    // Backstop: the API already drops the processor sandbox's bank name; never render it if one slips through.
    const bankName = p.bank_name && !/stripe|^test bank$/i.test(p.bank_name) ? p.bank_name : null;
    if (bankName && p.bank_last4) return `${bankName} ${DOTS} ${p.bank_last4}`;
    if (bankName) return bankName;
    if (p.bank_last4) return `Bank ${DOTS} ${p.bank_last4}`;
    return opts.forCustomer ? 'Bank payment' : PAYMENT_METHOD_LABELS.ACH;
  }
  if (p.method === 'CARD') {
    // Link keeps no card of its own on the record: whatever card is on file is not what the customer
    // chose, so it is never shown (and never with an expiry).
    if (p.wallet === 'LINK') return 'Link';
    const card = cardLine(p);
    if (p.wallet === 'APPLE_PAY' || p.wallet === 'GOOGLE_PAY') {
      return card ? `${WALLETS[p.wallet]} (${card})` : WALLETS[p.wallet];
    }
    return card ?? PAYMENT_METHOD_LABELS.CARD;
  }
  return PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? tidy(p.method);
}

/** The state a payment row wears when it is not simply received money, else null. */
export function paymentStateLabel(state: PaymentState | string | null | undefined): 'Processing' | 'Failed' | null {
  if (state === 'PROCESSING') return 'Processing';
  if (state === 'FAILED') return 'Failed';
  return null;
}

/** The state a refund row wears when it has not simply landed, else null. */
export function refundStateLabel(state: RefundState | string | null | undefined): 'Pending' | 'Failed' | null {
  if (state === 'PENDING') return 'Pending';
  if (state === 'FAILED') return 'Failed';
  return null;
}

// Aligned to the backend RefundCategory enum.
const REFUND_REASON_LABELS: Record<string, string> = {
  CUSTOMER_REQUEST: 'Customer request',
  ERROR: 'Billing error',
  GOODWILL: 'Goodwill',
  OVERPAYMENT: 'Overpayment',
  CHARGEBACK: 'Chargeback',
  OTHER: 'Other',
};

/** A refund's reason as a person reads it. */
export function refundReasonLabel(category: string | null | undefined): string {
  if (!category) return '';
  return REFUND_REASON_LABELS[category] ?? tidy(category);
}

/** The "Processing $X" badge text for the bank money still clearing on an invoice, else null. */
export function processingBadgeText(amount: number | string | null | undefined): string | null {
  const n = Number(amount ?? 0);
  return n > 0 ? `Processing ${formatCurrency(n)}` : null;
}
