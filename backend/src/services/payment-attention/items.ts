/**
 * Payments go-live P4 - one Needs attention item as the API shows it: ServWave's words, the caller's actions, and the
 * names left out when the caller cannot open the invoice. Pure: the rows come from ./queries.ts.
 */
import { describeDisputeReason, describeFailure, FAILURE_FALLBACK } from '../../lib/payment-failure-reasons';
import { unappliedReasonText } from '../../lib/unapplied-reason-text';
import { isPastBankRefundWindow } from '../../lib/refund-rules';
import { customerNameOf, payoutReference } from '../payments-page';
import type { RawRow } from './queries';
import {
  classifyDispute, classifyFailedPayment, classifyFailedPayout, classifyFailedRefund, classifyUnapplied, type Classified, type PersonResolution,
} from './rules';

/** What the caller may do, asked once per request. */
export interface Caps {
  /** Refund payments: refund, mark settled, answer a dispute. */
  refund: boolean;
  /** Send payment links: ask the customer to pay again. */
  sendLink: boolean;
  /** Manage payout account. */
  payoutAccount: boolean;
}

export type ActionId = 'contact_customer' | 'mark_resolved' | 'refund_again' | 'mark_settled' | 'respond' | 'update_bank_account' | 'refund';

const DAY_MS = 86_400_000;

function personResolution(row: RawRow): PersonResolution | null {
  if (!row.res_kind) return null;
  return { kind: row.res_kind === 'SETTLED' ? 'SETTLED' : 'RESOLVED', note: row.res_note, by: row.res_by, at: row.res_at ?? row.date };
}

/** The row's state and, once resolved, the words for it. The database decided open; these only word the rest. */
export function classify(row: RawRow): Classified {
  switch (row.type) {
    case 'failed_payment':
      return classifyFailedPayment({
        resolution: personResolution(row), invoiceStatus: row.invoice_status ?? '',
        later: row.later_at ? { method: row.later_method ?? '', at: row.later_at } : null,
      });
    case 'failed_refund':
      return classifyFailedRefund({ resolution: personResolution(row), later: row.later_at ? { by: row.later_by, at: row.later_at } : null });
    case 'dispute':
      return classifyDispute({ status: row.src_status ?? '', at: row.resolved_ts });
    case 'failed_payout':
      return classifyFailedPayout({ resolution: personResolution(row), laterPaidAt: row.later_at });
    default:
      return classifyUnapplied({ status: row.src_status ?? '', refundedAt: row.resolved_ts, updatedAt: row.resolved_ts ?? row.date });
  }
}

function words(row: RawRow): { title: string; detail: string } {
  switch (row.type) {
    case 'failed_payment':
      return { title: 'Bank payment failed', detail: describeFailure(row.code) };
    case 'failed_refund': {
      const d = describeFailure(row.code);
      return { title: 'Refund failed', detail: d === FAILURE_FALLBACK ? 'The refund did not reach the customer' : d };
    }
    case 'dispute':
      if (row.is_bank_return) return { title: 'Bank payment returned', detail: describeDisputeReason(row.code) };
      return { title: row.is_open ? 'Dispute needs a response' : 'Customer dispute', detail: describeDisputeReason(row.code) };
    case 'failed_payout': {
      const d = describeFailure(row.code);
      return { title: 'Payout failed', detail: d === FAILURE_FALLBACK ? 'The payout did not reach your bank' : d };
    }
    case 'unmatched_refund':
      return { title: 'Refund sent that is not on an invoice', detail: unappliedReasonText(row.code ?? '', row.invoice_status) };
    default:
      return { title: 'Money received that is not on an invoice', detail: unappliedReasonText(row.code ?? '', row.invoice_status) };
  }
}

/** The actions this caller has on an open item, in display order. Resolved items and restricted ones have none that name the invoice. */
export function actionsFor(row: RawRow, restricted: boolean, caps: Caps, now: Date): ActionId[] {
  if (!row.is_open) return [];
  const out: ActionId[] = [];
  switch (row.type) {
    case 'failed_payment':
      if (!restricted && caps.sendLink && row.customer_email) out.push('contact_customer');
      if (!restricted && caps.refund) out.push('mark_resolved');
      break;
    case 'failed_refund':
      if (!restricted && caps.refund) {
        const windowClosed = row.pay_method && row.pay_paid_at ? isPastBankRefundWindow({ method: row.pay_method, paid_at: row.pay_paid_at }, now) : false;
        if (row.refundable && !windowClosed) out.push('refund_again');
        out.push('mark_settled');
      }
      break;
    case 'dispute':
      if (!restricted && caps.refund && !row.is_bank_return && row.src_status === 'NEEDS_RESPONSE' && (!row.due_by || row.due_by.getTime() > now.getTime())) out.push('respond');
      break;
    case 'failed_payout':
      if (caps.payoutAccount) out.push('update_bank_account');
      break;
    case 'unmatched_payment':
      if (!restricted && caps.refund) {
        if (row.refundable) out.push('refund');
        out.push('mark_resolved');
      }
      break;
    case 'unmatched_refund':
      if (!restricted && caps.refund) out.push('mark_resolved');
      break;
  }
  return out;
}

export function toItem(row: RawRow, ctx: { openable: ReadonlySet<string>; caps: Caps; now: Date }) {
  const restricted = row.invoice_id != null && !ctx.openable.has(row.invoice_id);
  const state = classify(row);
  const { title, detail } = words(row);
  return {
    key: row.key,
    type: row.type,
    status: row.is_open ? ('open' as const) : ('resolved' as const),
    title,
    // A restricted item keeps its kind, amount, date and status only: free text and source ids can name the customer.
    detail: restricted ? '' : detail,
    amount: row.amount == null ? null : Number(row.amount),
    date: row.date.toISOString(),
    resolved_at: state.open ? null : (state.at?.toISOString() ?? null),
    resolved_by_name: state.open || restricted ? null : state.by,
    resolution: state.open ? null : { text: state.text, note: restricted ? null : state.note },
    respond_by: row.type === 'dispute' ? (row.due_by?.toISOString() ?? null) : null,
    days_left: row.type === 'dispute' && row.is_open && row.due_by ? Math.ceil((row.due_by.getTime() - ctx.now.getTime()) / DAY_MS) : null,
    payment_id: restricted ? null : row.payment_id,
    payout_id: restricted ? null : row.payout_id,
    // The same short code the payouts list shows (never the processor's id); a payout belongs to no invoice, so it is never restricted.
    payout_reference: row.type === 'failed_payout' && row.payout_id ? payoutReference(row.payout_id) : null,
    dispute_id: restricted ? null : row.dispute_id,
    invoice: row.invoice_id && !restricted ? { id: row.invoice_id, number: row.invoice_number } : null,
    customer: row.customer_id && !restricted
      ? { id: row.customer_id, name: customerNameOf({ company_name: row.company_name, first_name: row.first_name, last_name: row.last_name }) }
      : null,
    restricted,
    actions: actionsFor(row, restricted, ctx.caps, ctx.now),
    refund_again: row.type === 'failed_refund' && row.is_open && !restricted && row.invoice_id && row.payment_id
      ? { invoice_id: row.invoice_id, payment_id: row.payment_id, amount: Number(row.amount), reason_category: row.rf_category, reason: row.rf_reason }
      : null,
  };
}

export type AttentionItem = ReturnType<typeof toItem>;
