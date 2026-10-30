import { keepPreviousData, useQuery } from '@tanstack/react-query';

import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';

/**
 * The Payments page's data (payments go-live P5). The page reads ServWave's own ledger through
 * `/api/payments-page/*`; nothing here talks to the payment processor.
 */

/** Dollars. `next_payout.amount` is the money from payments not yet in any payout, all time (not the period). */
export interface PaymentsSummary {
  collected: number;
  fees: number;
  net: number;
  refunds: number;
  /** Payments counted in `collected`. */
  count: number;
  /** Counted payments whose fees are not confirmed yet. */
  fees_pending: number;
  /** Payments of the period with a dispute still open (the Disputed chip's count). Absent on older payloads. */
  disputed_count?: number;
  next_payout: {
    amount: number;
    in_transit: number;
    /** 'YYYY-MM-DD', or null when no payout is scheduled. */
    date: string | null;
    schedule_text: string | null;
    bank_label: string | null;
  };
}

export const paymentsPageKeys = {
  all: ['payments-page'] as const,
  list: (orgId: string | undefined, params: PaymentsListParams) => ['payments-page', 'payments', orgId, params] as const,
  detail: (orgId: string | undefined, id: string) => ['payments-page', 'payment', orgId, id] as const,
  summary: (orgId: string | undefined, from: string, to: string) =>
    ['payments-page', 'summary', orgId, from, to] as const,
  attention: (orgId: string | undefined, view: AttentionView, params: AttentionParams) =>
    ['payments-page', 'attention', orgId, view, params] as const,
  payouts: (orgId: string | undefined, page: number) => ['payments-page', 'payouts', orgId, page] as const,
  payout: (orgId: string | undefined, id: string) => ['payments-page', 'payout', orgId, id] as const,
  payoutPayments: (orgId: string | undefined, id: string, page: number) =>
    ['payments-page', 'payout-payments', orgId, id, page] as const,
};

/**
 * The four tiles' numbers for a period. The previous period's numbers stay on screen while the next ones load
 * (`keepPreviousData`), so changing the period never blanks the tiles. The key carries the dates and the org, so
 * one org's totals are never shown to another sign-in on the same browser.
 */
export function usePaymentsSummary({ from, to }: { from: string; to: string }, { enabled = true }: { enabled?: boolean } = {}) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.summary(orgId, from, to),
    queryFn: () =>
      api.get('/api/payments-page/summary', { params: { from, to } }).then((r) => r.data as PaymentsSummary),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ---- The payments list ----------------------------------------------------------------------------------------------

/** How a payment reads on the page (the API's words; `Voided` is not a facet but a row can wear it). */
export type PaymentDisplayStatus =
  | 'Succeeded' | 'Pending' | 'Failed' | 'Disputed' | 'Charged back' | 'Voided' | 'Refunded' | 'Partially refunded';

/** One row of the Payments tab. A row the caller cannot open has `restricted: true` and no customer or invoice. */
export interface PaymentRow {
  id: string;
  /** ISO instant. */
  date: string;
  status: PaymentDisplayStatus;
  method: 'CARD' | 'ACH';
  method_label: string;
  method_detail: string;
  /** What hit the card: invoice amount + tip + service fee. */
  amount: number;
  /** null while no fee has been captured. */
  fee: number | null;
  net: number | null;
  refunded: number;
  payout: { id: string; reference: string; status: string; arrival_date: string | null } | null;
  payout_status: 'awaiting' | 'in_transit' | 'paid' | 'failed' | null;
  customer: { id: string; name: string } | null;
  invoice: { id: string; number: string } | null;
  restricted: boolean;
}

export interface PaymentTimelineEntry {
  label: string;
  at: string;
  note: string | null;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export interface PaymentDetail extends PaymentRow {
  invoice_amount: number;
  tip: number;
  service_fee: number;
  /** The ServWave-worded reason, only for a Failed payment. */
  failure_text: string | null;
  refunds: Array<{ amount: number; state: 'PENDING' | 'SUCCEEDED' | 'FAILED'; created_at: string; reason_category: string | null; by: string | null }>;
  dispute: {
    id: string;
    status: string;
    reason_text: string;
    amount: number;
    respond_by: string | null;
    closed_at: string | null;
  } | null;
  timeline: PaymentTimelineEntry[];
  refundable_amount: number;
  can_refund: boolean;
  can_respond_dispute: boolean;
  can_open_invoice: boolean;
}

export interface PaymentsListResponse {
  payments: PaymentRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Everything the list and the export are filtered by. Empty values are left out by axios. */
export interface PaymentsListParams {
  from: string;
  to: string;
  chip?: string;
  q?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  /** Facet params from the filter state: status, method, payout_status, amount_min, amount_max. */
  [facet: string]: string | number | undefined;
}

/** One page of payments. The previous page stays on screen while the next loads. */
export function usePaymentsList(params: PaymentsListParams, { enabled = true }: { enabled?: boolean } = {}) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.list(orgId, params),
    queryFn: () => api.get('/api/payments-page/payments', { params }).then((r) => r.data as PaymentsListResponse),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * One payment's detail. `seed` (the list row) shows instantly while the detail loads; the detail has more than a
 * row does, so `seed` is typed as a row and the drawer reads detail-only fields only from `data`.
 */
export function usePaymentDetail(id: string | null) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.detail(orgId, id ?? ''),
    queryFn: () => api.get(`/api/payments-page/payments/${id}`).then((r) => r.data as PaymentDetail),
    enabled: Boolean(id),
    retry: false,
  });
}

export interface PaymentsExportRow extends PaymentRow {
  customer_name: string;
  invoice_number: string;
}

/** Every payment matching the filters, for the CSV (the server answers 413 past 10,000). */
export function fetchPaymentsExport(params: PaymentsListParams) {
  const { page: _page, limit: _limit, sortBy: _sortBy, sortDir: _sortDir, ...filters } = params;
  return api
    .get('/api/payments-page/payments/export', { params: filters, silentErrors: true })
    .then((r) => (r.data as { payments: PaymentsExportRow[] }).payments);
}

/**
 * What is left of a payment's net once its refunds come off (dollars, whole cents). The row's `net` is the processor's
 * figure before any refund; the summary subtracts refunds the same way, for payments whose net is known. Null stays
 * null: a net not confirmed yet is a dash, never a number.
 */
export function netAfterRefunds(p: { net: number | null; refunded: number }): number | null {
  if (p.net == null) return null;
  return Math.round(p.net * 100 - p.refunded * 100) / 100;
}


// ---- Needs attention (P7) -------------------------------------------------------------------------------------------

export type AttentionView = 'open' | 'resolved';
export type AttentionType =
  | 'failed_payment' | 'failed_refund' | 'dispute' | 'failed_payout' | 'unmatched_payment' | 'unmatched_refund';
export type AttentionActionId =
  | 'contact_customer' | 'mark_resolved' | 'refund_again' | 'mark_settled' | 'respond' | 'update_bank_account' | 'refund';

/** One item as the server shows it to this caller (P4). `actions` is what THIS caller may do, in display order. */
export interface AttentionItem {
  /** `<type>:<source row id>` */
  key: string;
  type: AttentionType;
  status: AttentionView;
  title: string;
  detail: string;
  amount: number | null;
  /** ISO instant. */
  date: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  resolution: { text: string; note: string | null } | null;
  respond_by: string | null;
  days_left: number | null;
  payment_id: string | null;
  payout_id: string | null;
  /** The short reference the payouts list shows ("PO-XXXXXX"); only on a failed payout. */
  payout_reference: string | null;
  dispute_id: string | null;
  invoice: { id: string; number: string } | null;
  customer: { id: string; name: string } | null;
  restricted: boolean;
  actions: AttentionActionId[];
  refund_again: {
    invoice_id: string;
    payment_id: string;
    amount: number;
    reason_category: string | null;
    reason: string | null;
  } | null;
}

export interface AttentionResponse {
  items: AttentionItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  counts: { open: number; resolved: number };
}

export interface AttentionParams {
  page?: number;
  limit?: number;
  q?: string;
  /** Narrow to these item types. */
  type?: AttentionType[];
  /** Only the items that belong to this payment. */
  payment_id?: string;
}

/**
 * One page of Needs attention items. The card, the chip's badge and the history table all read through this hook, so
 * their counts come from the same answer and never disagree. The previous page stays on screen while the next loads.
 */
export function useAttention(view: AttentionView, params: AttentionParams = {}, { enabled = true }: { enabled?: boolean } = {}) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.attention(orgId, view, params),
    queryFn: () =>
      api.get('/api/payments-page/attention', { params: { view, ...params } }).then((r) => r.data as AttentionResponse),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ---- Dispute evidence (payments go-live P11) -------------------------------------------------------------------------

/** The documents an office user attaches, one file per kind (the API's field names). */
export const EVIDENCE_FILE_FIELDS = [
  'receipt', 'customer_communication', 'customer_signature', 'service_documentation',
  'cancellation_policy', 'refund_policy', 'uncategorized_file',
] as const;
export type EvidenceFileField = (typeof EVIDENCE_FILE_FIELDS)[number];

export const EVIDENCE_TEXT_FIELDS = [
  'uncategorized_text', 'product_description', 'service_date', 'customer_name', 'customer_email_address',
] as const;
export type EvidenceTextField = (typeof EVIDENCE_TEXT_FIELDS)[number];

export interface EvidenceFile {
  attachment_id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  /** null for a file picked in this session and not saved yet: pages are counted on the server. */
  page_count: number | null;
  /** Set on a failed save when the card network refused this very file (the draft is stored all the same). */
  refused?: boolean;
}

export interface DisputeEvidenceState {
  dispute: {
    id: string;
    status: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED';
    reason_text: string;
    amount: number;
    respond_by: string | null;
    days_left: number | null;
    is_bank_return: boolean;
    closed_at: string | null;
    outcome: 'won' | 'lost' | 'closed' | null;
    /** The customer and the invoice the payment was for (the invoice id is what files attach to). */
    customer_name: string;
    invoice: { id: string; number: string };
  };
  form: {
    files: Record<string, EvidenceFile | null>;
    /** What is stored: '' where nothing is. */
    text: Record<string, string>;
    /** Prefills for the customer name, email and service date; never counted, sent only when the form sends them. */
    defaults: Record<string, string>;
    version: number;
  };
  totals: { bytes: number; pages: number; chars: number };
  limits: { max_bytes: number; max_pages: number; max_chars: number; types: string[] };
  submitted: {
    at: string | null;
    by_name: string | null;
    count: number;
    files: Array<{ field: string; file_name: string }>;
  } | null;
  can_edit: boolean;
  can_submit: boolean;
  recommended: string[];
}

export interface DisputeEvidenceSaved extends DisputeEvidenceState {
  staged?: boolean;
  /** 'empty': saved with nothing in it. */
  warnings?: string[];
}

export const disputeEvidenceKeys = {
  one: (orgId: string | undefined, id: string) => ['payments-page', 'dispute-evidence', orgId, id] as const,
};

/** One dispute's evidence form state. A dispute the caller may not open answers 404, which is not retried. */
export function useDisputeEvidence(id: string | null) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: disputeEvidenceKeys.one(orgId, id ?? ''),
    queryFn: () => api.get(`/api/payments-page/disputes/${id}/evidence`).then((r) => r.data as DisputeEvidenceState),
    enabled: Boolean(id),
    retry: false,
  });
}

// ---- Payouts --------------------------------------------------------------------------------------------------------

/** The payouts API's status words (a text column on the server, so a value outside these still renders as itself). */
export type PayoutStatus = 'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELED';

/** One row of the Payouts tab. `arrival_date` is a calendar day ('YYYY-MM-DD'), not an instant. */
export interface PayoutRow {
  id: string;
  /** The short, ServWave-worded reference ("PO-XXXXXX"); never a processor id. */
  reference: string;
  arrival_date: string | null;
  status: PayoutStatus | string;
  destination_label: string | null;
  /** Dollars. */
  amount: number;
  /** Payments in the payout that still count (voided ones are left out). */
  payment_count: number;
}

export interface PayoutsListResponse {
  payouts: PayoutRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Charged amount, fees and net of the WHOLE payout (summed on the server, never over one page). */
export interface PayoutTotals {
  amount: number;
  fee: number;
  net: number;
}

export interface PayoutDetail extends PayoutRow {
  net_matches_payout: boolean;
  net_difference: number;
  /** The ServWave-worded reason, only for a Failed payout. */
  failure_text: string | null;
  /** What this caller may do about the payout; the server decides. */
  actions: { update_bank_account: boolean };
  totals: PayoutTotals;
}

/** One payment inside a payout. A row the caller cannot open has `restricted: true` and no customer or invoice. */
export interface PayoutPaymentRow {
  id: string;
  customer: { id: string; name: string } | null;
  invoice: { id: string; number: string } | null;
  restricted: boolean;
  /** A chargeback or other void: the row is listed, counts nothing, and its figures are 0. */
  voided: boolean;
  charged_amount: number;
  amount: number;
  fee: number | null;
  refunded: number;
  net: number | null;
}

export interface PayoutPaymentsResponse {
  payments: PayoutPaymentRow[];
  payment_count: number;
  voided_count: number;
  pagination: { page: number; limit: number; total: number; totalPages: number };
  totals: PayoutTotals;
}

export const PAYOUTS_PAGE_SIZE = 25;

/** One page of payouts, newest first. Not filtered by the period picker. */
export function usePayoutsList(page: number) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.payouts(orgId, page),
    queryFn: () =>
      api.get('/api/payments-page/payouts', { params: { page, limit: PAYOUTS_PAGE_SIZE } }).then((r) => r.data as PayoutsListResponse),
    placeholderData: keepPreviousData,
  });
}

/** One payout (its figures, its failure text and the totals of the whole payout). */
export function usePayoutDetail(id: string | null) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.payout(orgId, id ?? ''),
    queryFn: () => api.get(`/api/payments-page/payouts/${id}`).then((r) => r.data as PayoutDetail),
    enabled: Boolean(id),
    retry: false,
  });
}

export interface SaveDisputeEvidenceBody {
  version: number;
  files: Record<string, string | null>;
  text: Record<string, string>;
}

export const saveDisputeEvidence = (id: string, body: SaveDisputeEvidenceBody) =>
  api.put(`/api/payments-page/disputes/${id}/evidence`, body, { silentErrors: true }).then((r) => r.data as DisputeEvidenceSaved);

export const submitDisputeEvidence = (id: string, version: number) =>
  api.post(`/api/payments-page/disputes/${id}/evidence/submit`, { version }, { silentErrors: true }).then((r) => r.data as DisputeEvidenceState);

/** One page of the payments inside a payout; the previous page stays on screen while the next loads. */
export function usePayoutPayments(id: string | null, page: number) {
  const orgId = useAuthStore((s) => s.user?.organization_id);
  return useQuery({
    queryKey: paymentsPageKeys.payoutPayments(orgId, id ?? '', page),
    queryFn: () =>
      api
        .get(`/api/payments-page/payouts/${id}/payments`, { params: { page, limit: PAYOUTS_PAGE_SIZE } })
        .then((r) => r.data as PayoutPaymentsResponse),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
