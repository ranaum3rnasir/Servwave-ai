/**
 * Payments go-live P4 - one Needs attention item as the API shows it: ServWave's words, the caller's actions, and the
 * names left out when the caller cannot open the invoice. Pure: the rows come from ./queries.ts.
 */
import { describeDisputeReason, describeFailure, describeRefundFailure, FAILURE_FALLBACK } from '../../lib/payment-failure-reasons';
import { unappliedReasonTexts } from '../../lib/unapplied-reason-text';
import { isPastBankRefundWindow } from '../../lib/refund-rules';
import { bankPaymentFailedComposeSubject, bankPaymentFailedSentence, greetingNameOf } from '../../lib/bank-payment-failed-text';
import { customerNameOf, payoutReference, shortCode } from '../payments-page';
import type { RawRow } from './queries';
import {
  classifyDispute, classifyFailedPayment, classifyFailedPayout, classifyFailedRefund, classifyUnapplied, type Classified, type PersonResolution,
} from './rules';

/** What the caller may do, asked once per request. */
export interface Caps {
  /** Refund payments: refund, mark resolved, answer a dispute. */
  refund: boolean;
  /** Send payment links: ask the customer to pay again. */
  sendLink: boolean;
  /** Manage payout account. */
  payoutAccount: boolean;
  /** Create invoices AND Standalone invoices AND Show Invoices page: the new invoice page opens, so the button may show (C-35). */
  createInvoice: boolean;
}

export type ActionId =
  | 'contact_customer' | 'mark_resolved' | 'refund_again' | 'respond' | 'update_bank_account' | 'refund' | 'attach_to_invoice' | 'create_invoice';

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
      return classifyUnapplied({
        status: row.src_status ?? '', refundedAt: row.resolved_ts, updatedAt: row.resolved_ts ?? row.date, note: row.res_note, by: row.res_by, at: row.res_at,
      });
  }
}

function words(row: RawRow): { title: string; detail: string } {
  switch (row.type) {
    case 'failed_payment':
      // A debit the bank took back AFTER it cleared (the payment was voided) has no failure code to describe.
      return { title: 'Bank payment failed', detail: row.returned_after_clearing ? 'The bank returned this payment after it had cleared.' : describeFailure(row.code) };
    case 'failed_refund': {
      return { title: 'Refund failed', detail: describeRefundFailure(row.code) };
    }
    case 'dispute':
      if (row.is_bank_return) return { title: 'Bank payment returned', detail: describeDisputeReason(row.code) };
      return { title: row.is_open ? 'Dispute needs a response' : 'Customer dispute', detail: describeDisputeReason(row.code) };
    case 'failed_payout': {
      const d = describeFailure(row.code);
      return { title: 'Payout failed', detail: d === FAILURE_FALLBACK ? 'The payout did not reach your bank' : d };
    }
    case 'unmatched_refund':
      return { title: 'Unapplied refund', detail: unappliedReasonTextOf(row).short };
    default:
      return { title: 'Unapplied payment', detail: unappliedReasonTextOf(row).short };
  }
}

/** The 7.15 reason words for an unapplied row. The list shows `short`; the item detail (V7-09) adds `long`. */
function unappliedReasonTextOf(row: RawRow) {
  return unappliedReasonTexts({
    reason: row.code ?? '', invoiceStatus: row.invoice_status, invoiceNumber: row.invoice_number,
    invoiceTotal: row.invoice_total == null ? null : Number(row.invoice_total), amount: row.amount == null ? null : Number(row.amount), sameAmountPaid: row.same_amount_paid,
  });
}

/** The actions this caller has on an open item, in display order. Resolved items and restricted ones have none that name the invoice. */
export function actionsFor(row: RawRow, restricted: boolean, caps: Caps, now: Date): ActionId[] {
  if (!row.is_open) return [];
  const out: ActionId[] = [];
  switch (row.type) {
    case 'failed_payment':
      // Contact customer opens the contact dialog and sends nothing itself, so it needs only an item the caller can open.
      if (!restricted) out.push('contact_customer');
      if (!restricted && caps.refund) out.push('mark_resolved');
      break;
    case 'failed_refund':
      if (!restricted && caps.refund) {
        const windowClosed = row.pay_method && row.pay_paid_at ? isPastBankRefundWindow({ method: row.pay_method, paid_at: row.pay_paid_at }, now) : false;
        if (row.refundable && !windowClosed) out.push('refund_again');
        out.push('mark_resolved');
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
        // Money that already sits on a payment row (a bank payment that cleared onto an invoice that could not take it)
        // is neither attached nor made into an invoice: its payment row exists (C-34, C-46).
        if (!row.on_payment_row) {
          out.push('attach_to_invoice');
          if (caps.createInvoice) out.push('create_invoice');
        }
        if (row.refundable) out.push('refund');
        out.push('mark_resolved');
      }
      break;
    case 'unmatched_refund':
      if (!restricted && caps.refund) {
        if (!row.on_payment_row) out.push('attach_to_invoice');
        out.push('mark_resolved');
      }
      break;
  }
  return out;
}

const DISPUTE_STATUSES = ['NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'CLOSED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
const disputeStatusOf = (s: string | null): DisputeStatus | null => (DISPUTE_STATUSES as readonly string[]).includes(s ?? '') ? (s as DisputeStatus) : null;

function unappliedReference(row: RawRow): string | null {
  const id = row.key.slice(row.key.indexOf(':') + 1);
  if (row.type === 'unmatched_payment') return shortCode('RCV-', id);
  if (row.type === 'unmatched_refund') return shortCode('REF-', id);
  return null;
}

/**
 * The greeting name the automatic email uses (first and last name, else company, else "Customer"; noticeCustomer in
 * services/payment-reconciler/checkout-effects.ts), so the prefill and the email greet the customer the same way.
 */
const greetingName = (row: RawRow): string => greetingNameOf(row);

/**
 * The failed bank payment's prefilled email for the office's Contact customer. The pay link is only a finished string
 * from `payUrls` (built for a holder of Send payment links); the public token itself never reaches the response.
 */
function composeFor(row: RawRow, payUrls: ReadonlyMap<string, string | null> | undefined) {
  const payUrl = row.invoice_id ? (payUrls?.get(row.invoice_id) ?? null) : null;
  return {
    subject: bankPaymentFailedComposeSubject(row.invoice_number ?? ''),
    body: bankPaymentFailedSentence({ customerName: greetingName(row), amount: Number(row.amount), invoiceNumber: row.invoice_number ?? '', payUrl }),
  };
}

export function toItem(row: RawRow, ctx: { openable: ReadonlySet<string>; caps: Caps; now: Date; payUrls?: ReadonlyMap<string, string | null> }) {
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
    // A person's words are the resolution text itself now, so a restricted item gets the generic words, like its note (free text can name the customer).
    resolution: state.open ? null : { text: restricted && state.note != null ? 'Marked resolved' : state.text, note: restricted ? null : state.note },
    respond_by: row.type === 'dispute' ? (row.due_by?.toISOString() ?? null) : null,
    days_left: row.type === 'dispute' && row.is_open && row.due_by ? Math.ceil((row.due_by.getTime() - ctx.now.getTime()) / DAY_MS) : null,
    payment_id: restricted ? null : row.payment_id,
    // The short codes the pages show (never a processor id). A restricted item gets none, like its payment_id.
    payment_reference: !restricted && row.payment_id ? shortCode('PMT-', row.payment_id) : null,
    dispute_reference: !restricted && row.type === 'dispute' && row.dispute_id ? shortCode('DSP-', row.dispute_id) : null,
    // Unapplied money: RCV- for a payment received, REF- for a refund sent, from the id after the colon in the key.
    reference: restricted ? null : unappliedReference(row),
    // The dispute's own status words, for the Status pill; nothing for any other kind.
    dispute_status: !restricted && row.type === 'dispute' ? disputeStatusOf(row.src_status) : null,
    payout_id: restricted ? null : row.payout_id,
    // The same short code the payouts list shows (never the processor's id); a payout belongs to no invoice, so it is never restricted.
    payout_reference: row.type === 'failed_payout' && row.payout_id ? payoutReference(row.payout_id) : null,
    dispute_id: restricted ? null : row.dispute_id,
    invoice: row.invoice_id && !restricted ? { id: row.invoice_id, number: row.invoice_number } : null,
    customer: row.customer_id && !restricted
      ? { id: row.customer_id, customer_number: row.customer_number, name: customerNameOf({ company_name: row.company_name, first_name: row.first_name, last_name: row.last_name }) }
      : null,
    restricted,
    actions: actionsFor(row, restricted, ctx.caps, ctx.now),
    // Failed bank payment only: what Contact customer opens the email window with. Null for a restricted item and for every other kind.
    compose: row.type === 'failed_payment' && !restricted && row.invoice_id ? composeFor(row, ctx.payUrls) : null,
    refund_again: row.type === 'failed_refund' && row.is_open && !restricted && row.invoice_id && row.payment_id
      ? { invoice_id: row.invoice_id, payment_id: row.payment_id, amount: Number(row.amount), reason_category: row.rf_category, reason: row.rf_reason }
      : null,
  };
}

export type AttentionItem = ReturnType<typeof toItem>;
