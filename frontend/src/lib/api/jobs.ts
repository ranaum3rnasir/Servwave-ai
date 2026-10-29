/**
 * Job endpoints introduced by the entity redesign.
 *
 * - reopen: NEW — reopen a completed job (admin-only).
 *
 * NOTE (Phase-8 cleanup, not this phase): the JobCharge surface is retired. The backend
 * now returns 410 Gone on every mutation of /api/jobs/:id/charges and an empty list on
 * GET. The charge add/edit/delete calls still inline in JobDetailPage must be removed
 * with their UI in Phase 8 — they compile today but 410 at runtime.
 *
 * SERV10X-38 (job-owned items, Tasks 3/5): a job tracks its own billable line items
 * (`JobLineItem`) BEFORE any invoice exists — the Items tab (Task 6) reads/writes these
 * via listJobLines/addJobLine/updateJobLine/deleteJobLine. `createJobInvoice` bills them
 * (flat draw or itemized) via the explicit POST /api/jobs/:id/invoices. The prior
 * lazy-invoice-creation-on-first-add endpoint this replaces no longer exists on the backend.
 *
 * Routes verified against backend/src/routes/job.routes.ts.
 */
import api from '@/lib/axios';

/** POST /api/jobs/:id/reopen — reopen a completed job. */
export function reopenJob(id: string) {
  return api.post(`/api/jobs/${id}/reopen`).then((r) => r.data);
}

/** POST /api/jobs/:id/dispatcher — set or clear the job's dispatcher (#291). */
export function setJobDispatcher(id: string, dispatcherId: string | null) {
  return api.post(`/api/jobs/${id}/dispatcher`, { dispatcher_id: dispatcherId }).then((r) => r.data);
}

/**
 * Inventory P1 — per-line stock sync state. NOT_TRACKED: free-text line or untracked
 * catalog item (never touches stock). UNSYNCED: tracked item, no deduction yet.
 * SYNCED: stock was deducted from `stock_location_id` when the line was added/synced.
 */
export type StockSyncStatus = 'NOT_TRACKED' | 'UNSYNCED' | 'SYNCED';

/** A single line item on an invoice. */
export interface InvoiceLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  /** Cost/margin data — Job lines carry these today; present here so the shared table can render them for either surface. */
  unit_cost?: string | number | null;
  markup_percent?: string | number | null;
  is_taxable: boolean;
  line_total: string | number;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value: string | number | null;
  discount_amount: string | number;
  item_type: 'SERVICE' | 'MATERIAL';
  price_book_item_id: string | null;
  /** Linked catalog item's photo (null for custom lines) — drives the row thumbnail. */
  price_book_item?: { image_url: string | null; photo_url: string | null } | null;
  /**
   * Inventory P1 — optional so public-page payloads and pre-P1 responses stay valid;
   * absent is treated exactly like NOT_TRACKED (no chip, no sync affordance).
   */
  stock_status?: StockSyncStatus;
  stock_location_id?: string | null;
  /**
   * #2053 slice 1 — estimate-only. `is_optional` offers the line, `is_selected` decides whether
   * it counts. Optional here (R7) rather than a parallel estimate-only line type, since
   * AddLineDialog's `editingLine`/`LineItemRow` share this type across all three surfaces; Job
   * and Invoice never populate either field.
   */
  is_optional?: boolean;
  is_selected?: boolean;
  /**
   * The REP'S RECOMMENDATION - estimate-only, and READ-ONLY to the client. It is what the rep is
   * offering; `is_selected` beside it is the live answer on the document (the customer's own
   * tick, and what the totals are filtered on), and every send publishes this onto that.
   *
   * READ-ONLY is the part to hold on to. The editor's checkbox RENDERS this value, but it still
   * PATCHes `is_selected`, and the server routes that write to whichever column the estimate's
   * status calls for (`routeSelectionWrite`, backend estimate-lines.controller.ts). This key is
   * never sent in a create/update payload - the backend schema strips it if you try.
   *
   * Null/absent means the rep never expressed a preference on that row; a send leaves those rows
   * alone and the editor falls back to `is_selected`.
   */
  rep_selected?: boolean | null;
  /**
   * #2045 — present only on an Estimate line (Job/Invoice lines never carry it). Drives the row's
   * "+" upload affordance: an opt-in discriminator taken from the data, never a new prop, since
   * this row component is shared across the Estimate/Job/Invoice grids.
   */
  estimate_id?: string | null;
  /**
   * #2045 — `EstimateLineItemPhoto` rows attached directly to this line (ad-hoc lines only; a
   * linked line's image always comes from `price_book_item.image_url`/`photo_url`).
   */
  photos?: Array<{ id: string; url: string; mime_type: string; caption?: string }>;
}

export interface JobFinancials {
  final_invoice: {
    id: string;
    invoice_number: string;
    status: string;
    total_amount: string | number;
    amount_due: string | number;
    sent_at: string | null;
    paid_at: string | null;
    // NOTE: `kind` is NOT returned by the A4 endpoint on final_invoice — omitted (C1-M1 cleanup).
  } | null;
  /** Multi-draw aggregates (Spec B2). Absent when the requester cannot see pricing. */
  first_sent_at?: string | null;
  total_invoiced?: number;
  total_paid?: number;
  invoices: Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: string | number;
    amount_due: string | number;
    sent_at: string | null;
    paid_at: string | null;
    kind: string;
    tip: string | number | null;
    tax_rate: string | number | null;
    tax_amount: string | number | null;
    discount_amount: string | number | null;
    subtotal: string | number | null;
    line_items: InvoiceLineItem[];
  }>;
  payments: Array<{
    id: string;
    amount: string | number;
    method: string;
    paid_at: string;
    /** The kind of the invoice this payment was applied to (DEPOSIT, STANDARD, etc.). */
    invoice_kind?: string;
    /** The invoice number for this payment. */
    invoice_number?: string;
    /**
     * Task 3.4 (spec §7.3) — per-payment fee breakdown, populated post-commit once Stripe
     * reconciles the charge (Task 3.3's captureStripeFees / nightly sweep). Null/undefined for
     * cash/check/legacy payments and for a CARD payment not yet reconciled — PaymentsTab renders
     * nothing in that case.
     */
    stripe_fee_amount?: string | number | null;
    platform_fee_amount?: string | number | null;
    net_amount?: string | number | null;
    /**
     * The customer's own money, charged on top of the face `amount` and therefore inside the
     * basis `net_amount` is measured against (D1/D10 keep both out of `amount` and out of
     * invoice totals). PaymentsTab itemizes them so its Gross → Net column adds up.
     */
    service_fee_amount?: string | number | null;
    tip_amount?: string | number | null;
    /** 'DEPOSIT-CREDIT' marks a synthetic mirror of a deposit's drawdown — not new cash. */
    reference_number?: string | null;
  }>;
}

/** GET /api/jobs/:id/financials — aggregated financials for a job. */
export function getJobFinancials(id: string): Promise<JobFinancials> {
  return api.get(`/api/jobs/${id}/financials`).then((r) => r.data);
}

export interface JobTaskSummary {
  open: number;
  overdue: number;
  at_risk: number;
  next_due_at: string | null;
}

/** GET /api/tasks/summary — task signal counts for a linked entity (e.g. a Job). */
export function getJobTaskSummary(id: string): Promise<JobTaskSummary> {
  return api
    .get('/api/tasks/summary', { params: { linked_entity_type: 'JOB', linked_entity_id: id } })
    .then((r) => r.data);
}

// ─── Job-owned line items (SERV10X-38) ────────────────────────────────────────

/**
 * A line item owned directly by a JOB — tracked before any invoice exists. Structurally a
 * superset of `InvoiceLineItem` (same shape the shared grid components already render),
 * plus the job-only `unit_cost`/`markup_percent` fields. `price_book_item` (photo) IS populated
 * here — job-lines.controller.ts's `jobLineSelect` carries the nested relation so the shared
 * row can render the catalog photo, same as the invoice detail select.
 */
export interface JobLineItem extends InvoiceLineItem {
  job_id: string;
  unit_cost: string | number | null;
  markup_percent: string | number | null;
}

/**
 * The Items tab's full totals section - computed on read, never persisted (see
 * computeJobBilling). tax_rate/discount follow the job's linked estimate (job-items-estimate-
 * parity D1/D2): job.estimate ?? linked_estimates[0], the SAME source both invoice doors derive
 * their own tax/discount from, so this preview and the invoice minted from it always agree.
 */
export interface JobBilling {
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  invoiced: number;
  remaining: number;
  /** Spec B1 (B-5): non-zero whenever invoiced exceeds total — remaining alone clamps at zero. */
  over_billed: number;
}

/** GET /api/jobs/:id/line-items — the job's current lines + a running billing preview. */
export function listJobLines(jobId: string): Promise<{ lines: JobLineItem[]; billing: JobBilling }> {
  return api.get(`/api/jobs/${jobId}/line-items`).then((r) => r.data);
}

/** Body for POST /api/jobs/:id/line-items — add a job-owned line. */
export interface AddJobLinePayload {
  description: string;
  quantity: number;
  unit_price: number;
  unit_cost?: number | null;
  markup_percent?: number | null;
  is_taxable: boolean;
  item_type: 'SERVICE' | 'MATERIAL';
  price_book_item_id?: string;
}

/** POST /api/jobs/:id/line-items — add a job-owned line; returns `{ line, billing }`. */
export function addJobLine(
  jobId: string,
  body: AddJobLinePayload,
): Promise<{ line: JobLineItem; billing: JobBilling }> {
  return api.post(`/api/jobs/${jobId}/line-items`, body).then((r) => r.data);
}

/** Body for PATCH /api/jobs/:id/line-items/:lineId — update a job-owned line. */
export interface UpdateJobLinePayload {
  description?: string;
  quantity?: number;
  unit_price?: number;
  unit_cost?: number | null;
  markup_percent?: number | null;
  is_taxable?: boolean;
  item_type?: 'SERVICE' | 'MATERIAL';
}

/** PATCH /api/jobs/:id/line-items/:lineId — update a job-owned line; returns `{ line, billing }`. */
export function updateJobLine(
  jobId: string,
  lineId: string,
  body: UpdateJobLinePayload,
): Promise<{ line: JobLineItem; billing: JobBilling }> {
  return api.patch(`/api/jobs/${jobId}/line-items/${lineId}`, body).then((r) => r.data);
}

/** DELETE /api/jobs/:id/line-items/:lineId — remove a job-owned line; returns `{ billing }`. */
export function deleteJobLine(jobId: string, lineId: string): Promise<{ billing: JobBilling }> {
  return api.delete(`/api/jobs/${jobId}/line-items/${lineId}`).then((r) => r.data);
}

/**
 * PATCH /api/jobs/:id/line-items/reorder — persist a full drag-and-drop reorder. `order` must be
 * the complete top-to-bottom list of this job's current line-item ids. Returns `{ line, billing }`
 * where `line` is the FULL resequenced array (a reorder touches every line, not just one).
 */
export function reorderJobLines(
  jobId: string,
  order: string[],
): Promise<{ line: JobLineItem[]; billing: JobBilling }> {
  return api.patch(`/api/jobs/${jobId}/line-items/reorder`, { order }).then((r) => r.data);
}

// ─── Scope-of-work CRUD (Batch 3) ─────────────────────────────────────────────

/**
 * A flat-priced, non-line-item scope-of-work block (`backend/src/lib/scopes.ts` `ScopeOfWork`).
 * Job.scopes and Invoice.scopes share this exact JSONB shape — defined once here (Job needs the
 * richer `listJobScopes`) and imported into `@/lib/api/invoices` rather than duplicated, so the
 * two never silently drift.
 */
export interface Scope {
  id: string;
  title: string;
  body: string;
  flat_price: number | null;
  is_taxable: boolean;
  /** Margin data — absent from the response entirely (not null) when the caller can't `read Invoice` (see `stripScopeCost`). */
  internal_cost?: number | null;
  /** #2053 slice 1 — estimate-only, same doc as InvoiceLineItem's identical pair above. */
  is_optional?: boolean;
  is_selected?: boolean;
  /** The rep's recommendation: same doc as `InvoiceLineItem.rep_selected` above. */
  rep_selected?: boolean | null;
}

/** Body for POST /api/jobs/:id/scopes — add a scope-of-work block. */
export interface AddJobScopePayload {
  title: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
}

/** Body for PATCH /api/jobs/:id/scopes/:idx — update a scope-of-work block. */
export interface UpdateJobScopePayload {
  title?: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
}

/** GET /api/jobs/:id/scopes — the job's current scopes + a running billing preview. */
export function listJobScopes(jobId: string): Promise<{ scopes: Scope[]; billing: JobBilling }> {
  return api.get(`/api/jobs/${jobId}/scopes`).then((r) => r.data);
}

/** POST /api/jobs/:id/scopes — add a scope-of-work block; returns `{ scopes, billing }` (the FULL post-mutation array, not just the new block). */
export function addJobScope(
  jobId: string,
  body: AddJobScopePayload,
): Promise<{ scopes: Scope[]; billing: JobBilling }> {
  return api.post(`/api/jobs/${jobId}/scopes`, body).then((r) => r.data);
}

/** PATCH /api/jobs/:id/scopes/:idx — update a scope-of-work block; returns `{ scopes, billing }`. */
export function updateJobScope(
  jobId: string,
  idx: number,
  body: UpdateJobScopePayload,
): Promise<{ scopes: Scope[]; billing: JobBilling }> {
  return api.patch(`/api/jobs/${jobId}/scopes/${idx}`, body).then((r) => r.data);
}

/** DELETE /api/jobs/:id/scopes/:idx — remove a scope-of-work block; returns `{ billing }` ONLY — no `scopes` key (mirrors `deleteJobLine`), caller derives the next array itself. */
export function deleteJobScope(jobId: string, idx: number): Promise<{ billing: JobBilling }> {
  return api.delete(`/api/jobs/${jobId}/scopes/${idx}`).then((r) => r.data);
}

/**
 * PATCH /api/jobs/:id/scopes/reorder — persist a full scope-block reorder atomically in ONE
 * request. `order` must be the complete top-to-bottom list of this job's current scope ids.
 * Replaces the previous "diff the target order against the current one and PATCH just the
 * changed indices" strategy, which fired two concurrent PATCH /scopes/:idx calls for a simple
 * two-block swap (Move up/down) — a lost-update race, since each is a non-atomic whole-column
 * read-modify-write with no locking. Returns `{ scopes, billing }` (the FULL post-reorder array).
 */
export function reorderJobScopes(
  jobId: string,
  order: string[],
): Promise<{ scopes: Scope[]; billing: JobBilling }> {
  return api.patch(`/api/jobs/${jobId}/scopes/reorder`, { order }).then((r) => r.data);
}

/**
 * Body for POST /api/jobs/:id/invoices — exactly one of amount / percent / lineIds
 * (backend zod `.refine` enforces this). `amount`/`percent` are a flat draw against the
 * job's running total; `lineIds` copies those job lines onto the new invoice (itemized).
 */
export interface CreateJobInvoicePayload {
  amount?: number;
  percent?: number;
  lineIds?: string[];
  description?: string;
}

/** POST /api/jobs/:id/invoices — draw/itemized invoice creation; returns `{ invoice }`. */
export function createJobInvoice(
  jobId: string,
  body: CreateJobInvoicePayload,
): Promise<{ invoice: { id: string } & Record<string, unknown> }> {
  return api.post(`/api/jobs/${jobId}/invoices`, body).then((r) => r.data);
}

/**
 * POST /api/jobs/:id/estimates (SERV10X-60 Part B, job-items-estimate-parity) - copies this
 * job's own line items/scopes into a NEW job-anchored estimate; tax/discount are derived
 * server-side from the job's linked estimate (D1/D2), not accepted from the client. Returns
 * `{ estimate }`.
 */
export function createEstimateFromJobItems(
  jobId: string,
  body: { scope_notes?: string } = {},
): Promise<{ estimate: { id: string; estimate_number: string } & Record<string, unknown> }> {
  return api.post(`/api/jobs/${jobId}/estimates`, body).then((r) => r.data);
}
