// ─── Logistic Orders (spec 2026-07-20) — TanStack Query seam over /api/logistic-orders ──────
//
// New feature ⇒ real-API only (no USE_MOCK branch), mirroring the Assets block in inventory.ts.
// Server contract (backend/src/controllers/logistic-order.controller.ts):
//   GET  /            → { data: LogisticOrderListRow[]; page; limit; total }   (flat, NOT meta.total)
//   GET  /:id         → LogisticOrderDetail                                    (bare object)
//   POST /            → LogisticOrderDetail (201)
//   PATCH /:id        → LogisticOrderDetail
//   POST /:id/submit  → LogisticOrderDetail
//   POST /:id/approve → LogisticOrderDetail
//   POST /:id/process → ProcessLogisticOrderResult   (NOT the detail shape — line movements)
//   POST /:id/cancel  → LogisticOrderDetail
//   DELETE /:id       → { success: true }
//
// Every LO-reading role holds an UNCONDITIONAL read, but the list still 403s for roles without
// it (SALES-minus etc.) — `retry: false` on the queries so a 403 doesn't retry-loop (the shipped
// useJobMaterialCost idiom). All mutations invalidate ['logistic-orders']; the three that MOVE
// STOCK (process / delete / a PROCESSED-line edit) also invalidate ['inventory'] so balances,
// movement log and low-stock counts refresh.
import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import api from '@/lib/axios';

// ─── Domain enums ────────────────────────────────────────────────────────────
export type LogisticOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSED'
  | 'CANCELLED'
  | 'RETURNED';

/** Line-validation reason codes carried by a 422 LO_LINE_INVALID detail. */
export type LoLineIssue =
  | 'NO_LINES'
  | 'MISSING_LOCATION'
  | 'UNKNOWN_LOCATION'
  | 'ITEM_UNAVAILABLE'
  | 'UNKNOWN_LINE'
  | 'DUPLICATE_LINE';

// ─── Request bodies ──────────────────────────────────────────────────────────

/**
 * One line as the write endpoints (create / update) accept it. `id` present = an existing line
 * (a PROCESSED edit diffs off it); absent = a new line. The server snapshots item_sku/item_name
 * from item_id — the client never sends them. `from_location_id` is nullable on a draft and only
 * required at process time (else 422 MISSING_LOCATION).
 */
export interface LoLineInput {
  id?: string;
  item_id: string;
  qty: number;
  from_location_id: string | null;
  sequence?: number;
}

/** POST body. Every anchor is optional; the number takes the most specific one at creation. */
export interface CreateLogisticOrderBody {
  job_id?: string;
  invoice_id?: string;
  estimate_id?: string;
  lead_id?: string;
  customer_id?: string;
  service_plan_id?: string;
  notes?: string | null;
  lines?: LoLineInput[];
}

/** PATCH body — `lines` is a full replace (diffed server-side; PROCESSED routes through the delta engine). */
export interface UpdateLogisticOrderBody {
  notes?: string | null;
  cancelled_reason?: string | null;
  lines?: LoLineInput[];
}

export interface LoListFilters {
  status?: LogisticOrderStatus;
  job_id?: string;
  invoice_id?: string;
  service_plan_id?: string;
  q?: string;
  page?: number;
  limit?: number;
  sortDir?: 'asc' | 'desc';
}

// ─── Response shapes (camelCase, as the controller mappers emit them) ─────────

/** Anchor id + human number for every linkable parent; each field is absent when unlinked. */
export interface LoAnchors {
  jobId?: string;
  jobNumber?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  estimateId?: string;
  estimateNumber?: string;
  leadId?: string;
  leadNumber?: string;
  customerId?: string;
  customerNumber?: string;
  servicePlanId?: string;
  servicePlanNumber?: string;
}

/** Actor snapshot on the trail; null when the step has not happened / user was deleted. */
export type LoPerson = { id: string; name: string } | null;

/** A line on the DETAIL payload (mapLoLine). itemSku/itemName are creation-time snapshots. */
export interface LoDetailLine {
  id: string;
  itemId?: string;
  itemSku: string;
  itemName: string;
  qty: number;
  fromLocationId?: string;
  fromLocationName?: string;
  sequence: number;
}

export interface LogisticOrderDetail {
  id: string;
  number: string;
  /** Per-anchor sequence int (1, 2, …); null for a flat standalone LO. */
  seq: number | null;
  status: LogisticOrderStatus;
  notes: string | null;
  anchors: LoAnchors;
  lines: LoDetailLine[];
  lineCount: number;
  createdBy: LoPerson;
  submittedBy: LoPerson;
  approvedBy: LoPerson;
  processedBy: LoPerson;
  submittedAt: string | null;
  approvedAt: string | null;
  processedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A row on the LIST payload (mapLoListRow) — lighter than the detail. */
export interface LogisticOrderListRow {
  id: string;
  number: string;
  seq: number | null;
  status: LogisticOrderStatus;
  anchors: LoAnchors;
  lineCount: number;
  createdBy: LoPerson;
  processedAt: string | null;
  createdAt: string;
}

export interface LogisticOrderListResponse {
  data: LogisticOrderListRow[];
  page: number;
  limit: number;
  total: number;
}

/** One processed/edited line's movement result (process + PROCESSED-edit responses). */
export interface ProcessedLoLineResult {
  lineId: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  qty: number;
  /** Post-movement on_hand at the source; null when no balance row was touched. */
  onHandAfter: number | null;
  /** Warn-mode only — the location went (or stayed) below zero. */
  shortage: boolean;
}

/** POST /:id/process response — NOT the detail shape. */
export interface ProcessLogisticOrderResult {
  id: string;
  number: string;
  status: 'PROCESSED';
  processedAt: string;
  lines: ProcessedLoLineResult[];
  /** The subset of `lines` that went negative — the warn-mode toast payload. */
  warnings: ProcessedLoLineResult[];
}

// ─── Error shapes + one parser ───────────────────────────────────────────────
//
// There is no error envelope in this API — each verb answers with `{ error: <CODE>, … }`. A
// component catches the axios error and calls `extractLoError(err)` to get a discriminated union
// it can switch on. The single-line ShortageError race-backstop (flat `{item_id,…}`) is normalised
// into the aggregate SHORTAGE `details[]` form so there is exactly one shortage code path.

/** One short line in a 409 SHORTAGE (aggregate) response. */
export interface LoShortageDetail {
  item_id: string;
  item_sku: string;
  item_name: string;
  location_id: string;
  location_name: string | null;
  requested: number;
  available: number;
}

/** One bad line in a 422 LO_LINE_INVALID response. line_id is null for whole-order + new-line issues. */
export interface LoLineInvalidDetail {
  line_id: string | null;
  item_sku: string | null;
  item_name: string | null;
  reason: LoLineIssue;
  message: string;
}

export type LoApiError =
  | { kind: 'SHORTAGE'; message: string; details: LoShortageDetail[] }
  | { kind: 'LO_LINE_INVALID'; message: string; details: LoLineInvalidDetail[] }
  | { kind: 'STALE_STATUS'; message: string; expectedStatus: LogisticOrderStatus[] }
  | { kind: 'ITEM_SWAP_FORBIDDEN'; message: string; lineId: string }
  | { kind: 'ANCHOR_NOT_FOUND'; message: string; anchor: string }
  | { kind: 'JOB_CANCELLED'; message: string };

function errBody(err: unknown): { status?: number; data?: Record<string, unknown> } | null {
  const r = (err as { response?: { status?: number; data?: unknown } })?.response;
  if (!r || typeof r.data !== 'object' || r.data === null) return null;
  return { status: r.status, data: r.data as Record<string, unknown> };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * Map an axios error from any LO verb to its typed shape, or null when it is not a recognised LO
 * error (callers fall through to a generic toast). Switch on `.kind`.
 */
export function extractLoError(err: unknown): LoApiError | null {
  const b = errBody(err);
  if (!b?.data) return null;
  const d = b.data;
  const code = str(d.error);
  const message = str(d.message, 'Something went wrong');

  switch (code) {
    case 'SHORTAGE': {
      if (Array.isArray(d.details)) {
        return { kind: 'SHORTAGE', message, details: d.details as LoShortageDetail[] };
      }
      // Flat single-line ShortageError (per-line race backstop) → normalise to one detail.
      return {
        kind: 'SHORTAGE',
        message,
        details: [
          {
            item_id: str(d.item_id),
            item_sku: str(d.item_sku),
            item_name: str(d.item_name),
            location_id: str(d.location_id),
            location_name: typeof d.location_name === 'string' ? d.location_name : null,
            requested: Number(d.requested ?? 0),
            available: Number(d.available ?? 0),
          },
        ],
      };
    }
    case 'LO_LINE_INVALID':
      return {
        kind: 'LO_LINE_INVALID',
        message,
        details: Array.isArray(d.details) ? (d.details as LoLineInvalidDetail[]) : [],
      };
    case 'STALE_STATUS':
      return {
        kind: 'STALE_STATUS',
        message,
        expectedStatus: Array.isArray(d.expected_status)
          ? (d.expected_status as LogisticOrderStatus[])
          : [],
      };
    case 'ITEM_SWAP_FORBIDDEN':
      return { kind: 'ITEM_SWAP_FORBIDDEN', message, lineId: str(d.line_id) };
    case 'ANCHOR_NOT_FOUND':
      return { kind: 'ANCHOR_NOT_FOUND', message, anchor: str(d.anchor) };
    case 'JOB_CANCELLED':
      return { kind: 'JOB_CANCELLED', message };
    default:
      return null;
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * List LOs. queryKey ['logistic-orders', filters] — the filters object is appended raw. Pass a
 * narrow filter for a badge count and read `.data.total` (e.g. { status: 'PENDING_APPROVAL',
 * limit: 1 }). `retry: false`: a 403 for a non-reader must not retry-loop.
 */
export function useLogisticOrders(
  filters: LoListFilters = {},
  options?: Omit<UseQueryOptions<LogisticOrderListResponse>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<LogisticOrderListResponse>({
    queryKey: ['logistic-orders', filters],
    queryFn: () =>
      api.get('/api/logistic-orders', { params: filters }).then((r) => r.data),
    retry: false,
    ...options,
  });
}

/** A single LO's detail. queryKey ['logistic-orders', id]. Disabled until an id is supplied. */
export function useLogisticOrder(
  id: string | null,
  options?: Omit<UseQueryOptions<LogisticOrderDetail>, 'queryKey' | 'queryFn' | 'enabled'>,
) {
  return useQuery<LogisticOrderDetail>({
    queryKey: ['logistic-orders', id],
    queryFn: () => api.get(`/api/logistic-orders/${id}`).then((r) => r.data),
    enabled: !!id,
    retry: false,
    ...options,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function useCreateLogisticOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLogisticOrderBody) =>
      api.post('/api/logistic-orders', body).then((r) => r.data as LogisticOrderDetail),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logistic-orders'] }),
  });
}

/**
 * PATCH a LO. A PROCESSED edit moves stock (delta post), so this also invalidates ['inventory'].
 * Editing an open (pre-processed) LO doesn't, but the shared invalidation is cheap and correct.
 */
export function useUpdateLogisticOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & UpdateLogisticOrderBody) =>
      api.patch(`/api/logistic-orders/${id}`, body).then((r) => r.data as LogisticOrderDetail),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logistic-orders'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useSubmitLo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/logistic-orders/${id}/submit`).then((r) => r.data as LogisticOrderDetail),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logistic-orders'] }),
  });
}

export function useApproveLo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/logistic-orders/${id}/approve`).then((r) => r.data as LogisticOrderDetail),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logistic-orders'] }),
  });
}

/** Process (deduct). Moves stock → invalidate LO + inventory. */
export function useProcessLo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post(`/api/logistic-orders/${id}/process`)
        .then((r) => r.data as ProcessLogisticOrderResult),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logistic-orders'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useCancelLo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cancelled_reason }: { id: string; cancelled_reason?: string | null }) =>
      api
        .post(`/api/logistic-orders/${id}/cancel`, { cancelled_reason })
        .then((r) => r.data as LogisticOrderDetail),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logistic-orders'] }),
  });
}

/** Delete. A PROCESSED LO returns its stock first (server-side) → invalidate LO + inventory. */
export function useDeleteLo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/logistic-orders/${id}`).then((r) => r.data as { success: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logistic-orders'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}
