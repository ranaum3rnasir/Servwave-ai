// Payments page read API (payments go-live P3) - pure mapping, no Prisma/Express, so it unit-tests with fixtures
// (same doctrine as payments-report.ts). Every number the Payments page shows comes from ServWave's own rows.
//
// Nothing here names the processor and no processor id leaves this module: the payout `reference` is a short
// ServWave code from the row's own uuid.

import { statusLabel, methodLabel, type DbPaymentMethod } from './payments-report';
import { describePaymentDetail } from '../lib/payment-display';

export type PaymentDisplayStatus =
  | 'Succeeded' | 'Pending' | 'Failed' | 'Disputed' | 'Refund failed' | 'Charged back' | 'Voided' | 'Refunded' | 'Partially refunded';

export type PayoutStatusKey = 'awaiting' | 'in_transit' | 'paid' | 'failed';

export interface StatusInput {
  state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  /** The invoice face amount of the payment (Payment.amount). */
  amount: number;
  /** Sum of the payment's SUCCEEDED refunds, in dollars. */
  succeededRefundTotal: number;
  voidedAt: Date | null;
  voidCategory: string | null;
  /** A dispute on this payment is NEEDS_RESPONSE or UNDER_REVIEW. */
  openDispute: boolean;
  /** A refund of this payment failed and no person or later refund has dealt with it (FAILED_REFUND_OPEN). */
  refundFailedOpen: boolean;
}

const cents = (n: number): number => Math.round(n * 100);
const dollars = (c: number): number => c / 100;

/**
 * How a payment reads on the page. A processing payment is Pending and a failed one Failed whatever else is recorded;
 * a collected one is Disputed while a dispute is open, then Refund failed while a failed refund is unhandled, then (via the report's own statusLabel) Charged back, Refunded,
 * Partially refunded or Voided, else Succeeded.
 */
export function paymentDisplayStatus(p: StatusInput): PaymentDisplayStatus {
  if (p.state === 'PROCESSING') return 'Pending';
  if (p.state === 'FAILED') return 'Failed';
  if (p.openDispute) return 'Disputed';
  if (p.refundFailedOpen) return 'Refund failed';
  const label = statusLabel({
    amount: p.amount,
    refundedAt: p.succeededRefundTotal > 0 ? new Date(0) : null,
    refundedAmount: p.succeededRefundTotal > 0 ? p.succeededRefundTotal : null,
    voidedAt: p.voidedAt,
    voidCategory: p.voidCategory,
  });
  if (label === 'Partly refunded') return 'Partially refunded';
  if (label === 'Charged back' || label === 'Voided' || label === 'Refunded') return label;
  return 'Succeeded';
}

/** What hit the card: invoice amount + tip + service fee, added in whole cents. */
export function chargedAmount(p: { amount: number; tip: number | null; serviceFee: number | null }): number {
  return dollars(cents(p.amount) + cents(p.tip ?? 0) + cents(p.serviceFee ?? 0));
}

/** Processing fee + platform fee, or null while neither has been captured (the page shows a dash). */
export function feeOf(p: { stripeFee: number | null; platformFee: number | null }): number | null {
  if (p.stripeFee == null && p.platformFee == null) return null;
  return dollars(cents(p.stripeFee ?? 0) + cents(p.platformFee ?? 0));
}

/** A payout's short display code, from ServWave's own row id (never the processor's payout id). */
export function payoutReference(id: string): string {
  return shortCode('PO-', id);
}

/** A short display code: the prefix plus the first 8 hex of a ServWave row's uuid, uppercased. Never a processor id. */
export type ShortCodePrefix = 'PO-' | 'PMT-' | 'DSP-' | 'RCV-' | 'REF-';
export function shortCode(prefix: ShortCodePrefix, id: string): string {
  return `${prefix}${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** Where a payment's money is: not paid out yet, on its way, paid, or the payout failed. Null when it is not collected money. */
export function payoutStatusOf(
  payment: { state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED'; voided: boolean },
  payoutStatus: string | null,
): PayoutStatusKey | null {
  if (!payoutStatus) return payment.state === 'SUCCEEDED' && !payment.voided ? 'awaiting' : null;
  if (payoutStatus === 'PENDING' || payoutStatus === 'IN_TRANSIT') return 'in_transit';
  if (payoutStatus === 'PAID') return 'paid';
  return 'failed';
}

export interface PayoutScheduleSummary {
  interval: string | null;
  weekly_anchor: string | null;
  delay_days: number | null;
  bank_label: string | null;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Read the stored organizations.payout_summary JSON defensively; null when it is not the expected shape. */
export function readPayoutSummary(raw: unknown): PayoutScheduleSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    interval: str(o.interval),
    weekly_anchor: str(o.weekly_anchor),
    delay_days: typeof o.delay_days === 'number' ? o.delay_days : null,
    bank_label: str(o.bank_label),
  };
}

export function payoutScheduleText(s: PayoutScheduleSummary | null): string | null {
  if (!s?.interval) return null;
  if (s.interval === 'daily') return 'Daily';
  if (s.interval === 'manual') return 'Manual';
  if (s.interval === 'monthly') return 'Monthly';
  if (s.interval === 'weekly') {
    const day = s.weekly_anchor ? s.weekly_anchor.charAt(0).toUpperCase() + s.weekly_anchor.slice(1).toLowerCase() : null;
    return day ? `Weekly on ${day}s` : 'Weekly';
  }
  return null;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The next payout day ('YYYY-MM-DD') computed from the company's schedule and today's org day; null when it cannot be known. */
export function nextPayoutDate(s: PayoutScheduleSummary | null, today: string): string | null {
  if (!s?.interval) return null;
  if (s.interval === 'daily') return addDays(today, Math.max(1, s.delay_days ?? 1));
  if (s.interval === 'weekly') {
    const target = WEEKDAYS.indexOf((s.weekly_anchor ?? '').toLowerCase());
    if (target < 0) return null;
    const todayIdx = new Date(`${today}T00:00:00Z`).getUTCDay();
    const ahead = ((target - todayIdx + 7) % 7) || 7;
    return addDays(today, ahead);
  }
  return null;
}

export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger';
export interface TimelineEntry { label: string; at: string; note: string | null; tone: TimelineTone }

const money = (n: number): string => `$${n.toFixed(2)}`;

export interface TimelineInput {
  method: string;
  state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  paidAt: Date;
  failureText: string | null;
  refunds: Array<{ amount: number; state: 'PENDING' | 'SUCCEEDED' | 'FAILED'; createdAt: Date }>;
  dispute: { status: string; createdAt: Date; closedAt: Date | null } | null;
  payout: { reference: string; arrivalDate: Date | null; status: string } | null;
  /** Whether the person may see prices: a refund's line names its amount only then (re-audit P2-2, `canSeePrices`). */
  figures: boolean;
}

/** The payment's story in ServWave's words, built from ServWave rows only, oldest first. */
export function buildTimeline(p: TimelineInput): TimelineEntry[] {
  const out: Array<TimelineEntry & { sort: number }> = [];
  const push = (label: string, at: Date, note: string | null, tone: TimelineTone) =>
    out.push({ label, at: at.toISOString(), note, tone, sort: at.getTime() });

  if (p.method === 'ACH') {
    push('Processing', p.paidAt, null, 'neutral');
    if (p.state === 'SUCCEEDED') push('Cleared', p.paidAt, null, 'success');
    if (p.state === 'FAILED') push('Failed', p.paidAt, p.failureText, 'danger');
  } else if (p.state === 'FAILED') {
    push('Failed', p.paidAt, p.failureText, 'danger');
  } else {
    push(p.state === 'PROCESSING' ? 'Processing' : 'Paid', p.paidAt, null, p.state === 'PROCESSING' ? 'neutral' : 'success');
  }

  if (p.payout) {
    const at = p.payout.arrivalDate ?? p.paidAt;
    if (p.payout.status === 'PAID') push(`Paid out in ${p.payout.reference}`, at, null, 'success');
    else if (p.payout.status === 'FAILED' || p.payout.status === 'CANCELED') push(`Payout ${p.payout.reference} failed`, at, null, 'danger');
    else push(`On its way in ${p.payout.reference}`, at, null, 'neutral');
  }
  for (const r of p.refunds) {
    const of = p.figures ? ` of ${money(r.amount)}` : '';
    if (r.state === 'SUCCEEDED') push(p.figures ? `Refunded ${money(r.amount)}` : 'Refunded', r.createdAt, null, 'neutral');
    else if (r.state === 'PENDING') push(`Refund${of} pending`, r.createdAt, null, 'warning');
    else push(`Refund${of} failed`, r.createdAt, null, 'danger');
  }
  if (p.dispute) {
    push('Dispute opened', p.dispute.createdAt, null, 'warning');
    if (p.dispute.closedAt) {
      const tone: TimelineTone = p.dispute.status === 'WON' || p.dispute.status === 'CLOSED' ? 'success' : 'danger';
      push('Dispute closed', p.dispute.closedAt, p.dispute.status === 'WON' ? 'Won' : p.dispute.status === 'LOST' ? 'Lost' : null, tone);
    }
  }
  return out.sort((a, b) => a.sort - b.sort).map(({ sort: _s, ...e }) => e);
}


// ---- Row mapping ------------------------------------------------------------------------------------------------

export interface PaymentRowInput {
  id: string;
  amount: number;
  tip: number | null;
  serviceFee: number | null;
  stripeFee: number | null;
  platformFee: number | null;
  net: number | null;
  method: DbPaymentMethod;
  state: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  paidAt: Date;
  voidedAt: Date | null;
  voidCategory: string | null;
  wallet: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  bankName: string | null;
  bankLast4: string | null;
  refunds: Array<{ amount: number; state: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>;
  openDispute: boolean;
  refundFailedOpen: boolean;
  payout: { id: string; status: string; arrivalDate: Date | null } | null;
  invoice: { id: string; number: string };
  customer: { id: string; name: string; customer_number: string };
}

const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function succeededRefundTotal(refunds: Array<{ amount: number; state: string }>): number {
  return dollars(refunds.filter((r) => r.state === 'SUCCEEDED').reduce((sum, r) => sum + cents(r.amount), 0));
}

/** A customer's name as the page reads it: the company, else first and last name. */
export function customerNameOf(c: { company_name: string | null; first_name: string | null; last_name: string | null }): string {
  if (c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Unknown';
}

/**
 * One payment as a row on the Payments tab. A row the caller cannot open (`restricted`) keeps its amounts, status,
 * method and payout and loses the customer and the invoice.
 */
export function toPageRow(p: PaymentRowInput, restricted: boolean) {
  const refunded = succeededRefundTotal(p.refunds);
  return {
    id: p.id,
    reference: shortCode('PMT-', p.id),
    date: p.paidAt.toISOString(),
    status: paymentDisplayStatus({
      state: p.state, amount: p.amount, succeededRefundTotal: refunded, voidedAt: p.voidedAt, voidCategory: p.voidCategory, openDispute: p.openDispute,
      refundFailedOpen: p.refundFailedOpen,
    }),
    method: p.method,
    method_label: methodLabel(p.method),
    method_detail: describePaymentDetail({
      method: p.method, wallet: p.wallet, cardBrand: p.cardBrand, cardLast4: p.cardLast4, bankName: p.bankName, bankLast4: p.bankLast4,
    }),
    amount: chargedAmount({ amount: p.amount, tip: p.tip, serviceFee: p.serviceFee }),
    fee: feeOf({ stripeFee: p.stripeFee, platformFee: p.platformFee }),
    net: p.net,
    refunded,
    payout: p.payout
      ? { id: p.payout.id, reference: payoutReference(p.payout.id), status: p.payout.status, arrival_date: dayOf(p.payout.arrivalDate) }
      : null,
    payout_status: payoutStatusOf({ state: p.state, voided: p.voidedAt != null }, p.payout?.status ?? null),
    customer: restricted ? null : p.customer,
    invoice: restricted ? null : p.invoice,
    restricted,
  };
}
