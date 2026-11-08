/**
 * Estimate endpoints changed/added by the entity redesign + the estimate workspace redesign.
 *
 * - duplicate: accepts an optional { target_lead_id } to clone onto a different lead.
 * - create: anchored by ONE of lead_id / customer_id / job_id (the backend accepts any one and
 *   eagerly creates an empty DRAFT); lead_id is no longer required.
 * - Line items + scopes of work (v12 unified line-items, plan §2a, Wave 3): see the dedicated
 *   section below — these mirror `@/lib/api/jobs.ts`/`@/lib/api/invoices.ts`'s line/scope CRUD,
 *   but the response envelope follows Invoice's `{ estimate }` convention, not Job's
 *   `{ line, billing }` (Estimate persists its own subtotal/total_amount, so the backend
 *   recomputes + returns the whole updated row rather than a computed-on-read preview).
 * - Lifecycle verbs (R4, port-plan §3.2/§10.3): mark-sent/status/approve-internal/
 *   decline-internal/void-approval, added alongside R4's status control. `revise()` (clone into a
 *   new DRAFT, supersede the source) is retired from the UI per §14.4 — backtodraft is the
 *   same-row recall that replaces it — so no wrapper is exported here; the backend route and its
 *   e2e coverage (`e2e/helpers/api-client.ts`) are untouched.
 *
 * Routes verified against backend/src/routes/estimate.routes.ts +
 * backend/src/controllers/estimate-lines.controller.ts.
 */
import api from '@/lib/axios';
// Scope is defined once in jobs.ts (Job needs the richer listJobScopes) and imported here so
// Estimate.scopes / Job.scopes / Invoice.scopes — the same JSONB shape on all three — never
// silently drift (same re-export convention as `@/lib/api/invoices.ts`).
import type { Scope } from './jobs';
export type { Scope };
import type { EstimateStatusValue } from '@/constants/estimateStatus';

/** POST /api/estimates/:id/mark-sent — stamp SENT without emailing; shares send()'s deposit/T&C ceremony. */
export function markEstimateSent(id: string, body: { deposit_required: boolean; payment_methods: string[]; message_body?: string }) {
  return api.post(`/api/estimates/${id}/mark-sent`, body).then((r) => r.data);
}

/** PATCH /api/estimates/:id/status — retained alias: backtodraft (same-row recall) or backtosent. */
export function setEstimateStatus(id: string, transition: 'backtodraft' | 'backtosent') {
  return api.patch(`/api/estimates/${id}/status`, { transition }).then((r) => r.data);
}

/**
 * PATCH /api/estimates/:id/status — the free setter (Spec B1). Estimate status is UNORDERED: any
 * of the six exposed statuses is reachable from any other, forward or backward. Only integrity
 * rules refuse:
 *
 *   400  leaving WON when the job is already invoiced or the deposit carries payments
 *   400  DECLINED without a lost_reason
 *
 * SENT is not special here. It is a label, and setting it mints no customer link - only send,
 * resend and mark-sent do that. (A 409 SEND_CEREMONY_REQUIRED used to guard this and pointed
 * callers at POST /:id/mark-sent, which accepts DRAFT only, so the advice could not be followed.)
 */
export function setEstimateStatusTo(
  id: string,
  status: EstimateStatusValue,
  reason?: { lost_reason?: string; cancelled_reason?: string },
) {
  return api.patch(`/api/estimates/${id}/status`, { status, ...reason }).then((r) => r.data);
}

/** POST /api/estimates/:id/approve-internal — staff-recorded verbal/off-platform win, no signature. */
export function approveEstimateInternal(id: string) {
  return api.post(`/api/estimates/${id}/approve-internal`, {}).then((r) => r.data);
}

/** POST /api/estimates/:id/decline-internal — staff-recorded loss; lost_reason is required. */
export function declineEstimateInternal(id: string, lost_reason: string) {
  return api.post(`/api/estimates/${id}/decline-internal`, { lost_reason }).then((r) => r.data);
}

/** POST /api/estimates/:id/void-approval — D13 guarded unwind (WON → SENT), ADMIN-only. */
export function voidEstimateApproval(id: string) {
  return api.post(`/api/estimates/${id}/void-approval`, {}).then((r) => r.data);
}

/** POST /api/estimates/:id/duplicate — optionally onto a different lead. */
export function duplicateEstimate(id: string, body?: { target_lead_id?: string }) {
  return api.post(`/api/estimates/${id}/duplicate`, body).then((r) => r.data);
}

/**
 * POST /api/estimates/:id/copy-to-invoice — convert directly into a standalone Invoice,
 * independent of the Job pipeline. No request body. 403 unless ADMIN/DISPATCHER; 409 if the
 * estimate already has a Job, or if a non-VOIDED kind:'STANDARD' invoice already exists for it
 * (already copied).
 */
export function copyEstimateToInvoice(id: string): Promise<{ invoice: { id: string; invoice_number: string } }> {
  return api.post(`/api/estimates/${id}/copy-to-invoice`).then((r) => r.data);
}

/**
 * POST /api/estimates - create. Anchored by ONE of lead_id / customer_id / job_id (lead_id is no
 * longer required - the backend accepts any single anchor and eagerly creates an empty DRAFT). The
 * payload is intentionally loose (the workspace owns the full field set + validation).
 */
export function createEstimate(
  payload: { lead_id?: string; customer_id?: string; job_id?: string } & Record<string, unknown>,
) {
  return api.post('/api/estimates', payload).then((r) => r.data);
}

/**
 * PATCH /api/estimates/:id — partial update. Accepts name, scope_name, scope_notes, tax_rate,
 * line_items, discount fields, and deposit fields. SENT/PENDING estimates are editable unless
 * locked (deposit PAID, or org lock_on_send ON) — a locked edit 400s with "locked" in the error.
 */
export function updateEstimate(id: string, body: Record<string, unknown>) {
  return api.patch(`/api/estimates/${id}`, body).then((r) => r.data);
}

/** DELETE /api/estimates/:id — drafts only (backend-enforced). */
export function deleteEstimate(id: string) {
  return api.delete(`/api/estimates/${id}`).then((r) => r.data);
}

/** A row from GET /api/estimates - just enough for the "Attach estimate" picker (job-items-estimate-parity Part C). */
export interface AttachableEstimate {
  id: string;
  estimate_number: string;
  status: string;
  total_amount: number | string;
  customer_id: string;
  job_id: string | null;
}

/**
 * GET /api/estimates?customer_id=... - the standalone/lead-anchored estimates for one customer,
 * for the "Attach estimate" picker. Mirrors CustomerDetailPage.tsx's identical call. Filtered
 * client-side (not yet attached to a job, still in-flight) - the backend has no "unattached" or
 * "in-flight" filter facet, and this list is small (per-customer, capped) so it doesn't need one.
 */
export function listCustomerEstimates(customerId: string): Promise<AttachableEstimate[]> {
  return api.get('/api/estimates', { params: { customer_id: customerId, limit: 50 } })
    .then((r) => r.data.estimates);
}

/**
 * POST /api/estimates/:id/attach-to-job (transition 16, job-items-estimate-parity Part C) - 
 * attach an existing standalone estimate to an existing job. The backend re-keys the estimate's
 * number into the job's own container; returns the updated `{ estimate }`.
 */
export function attachEstimateToJob(id: string, jobId: string) {
  return api.post(`/api/estimates/${id}/attach-to-job`, { job_id: jobId }).then((r) => r.data);
}

/** GET /api/estimates/:id/history — audit_logs scoped to this estimate, newest first. */
export function getEstimateHistory(id: string) {
  return api.get(`/api/estimates/${id}/history`).then((r) => r.data);
}

/**
 * GET /api/estimates/:id/versions — the past versions of this estimate, summary only, oldest
 * first (#2030). Read-only: there is no write verb on the versions paths at all.
 *
 * Separate from `getEstimateHistory` on purpose. The activity query is unchanged by the version
 * work; the two streams are fetched independently and merged in the client, so a failure to load
 * versions can never cost a reader the activity trail they already had.
 */
export function listEstimateVersions(id: string) {
  return api.get(`/api/estimates/${id}/versions`).then((r) => r.data);
}

/** POST /api/estimates/:id/ai/draft-scope — draft a scope-of-work paragraph from line items. */
export function draftEstimateScope(id: string) {
  return api.post(`/api/estimates/${id}/ai/draft-scope`).then((r) => r.data);
}

/** GET /api/scope-presets?q= — reusable named/priced scope-of-work presets. */
export function listScopePresets(q?: string) {
  return api.get('/api/scope-presets', { params: q ? { q } : undefined }).then((r) => r.data);
}

/** POST /api/scope-presets — save the current scope as a reusable preset. */
export function createScopePreset(body: { name: string; emoji?: string | null; scope_text: string; priced?: boolean; price?: number | null; category?: string | null }) {
  return api.post('/api/scope-presets', body).then((r) => r.data);
}

// ─── Line items + scopes of work (v12 unified line-items, plan §2a, Wave 3) ──────────────────
//
// Every MUTATING endpoint here (add/update/delete/reorder, both lines and scopes) returns the
// WHOLE updated estimate as `{ estimate }` — estimateDetailSelect-shaped, cost-stripped when the
// caller can't `read Invoice` (backend/src/controllers/estimate-lines.controller.ts's
// recomputeAndPersist + stripEstimateCost). This is Invoice's convention, not Job's: unlike
// JobLineItem's parent Job (no persisted subtotal/total_amount — job-lines' "billing" is a
// computed-on-read preview only), Estimate already carries real, persisted
// subtotal/tax_amount/total_amount/discount_amount columns other surfaces (PDF, public page, list
// view) rely on, so every mutation recomputes + persists them and hands back the full row. Only
// `listEstimateScopes` (GET, read-only) differs from Job/Invoice's scope-list shape — it returns
// `{ scopes }` alone, no `billing` key (Estimate has nothing analogous to compute).
//
// Granular line/scope mutation is only permitted while the estimate is DRAFT/SENT/PENDING — the
// same three statuses the whole-document PATCH /:id already gates edits on. A mutation against a
// frozen estimate (WON/DECLINED/ARCHIVED/EXPIRED/SUPERSEDED) 400s with
// "Only draft or sent estimates can be edited".

/**
 * A line item on an Estimate — the same shape as `InvoiceLineItem`/`JobLineItem`
 * (`@/lib/api/jobs.ts`), EXCEPT `price_book_item` here carries only `image_url` (no `photo_url`) —
 * estimateDetailSelect's nested select omits it (backend/src/controllers/estimate.controller.ts
 * `estimateDetailSelect.line_items`).
 */
export interface EstimateLineItem {
  id: string;
  estimate_id: string;
  sequence: number;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  unit_cost: string | number | null;
  markup_percent: string | number | null;
  is_taxable: boolean;
  line_total: string | number;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value: string | number | null;
  discount_amount: string | number;
  item_type: 'SERVICE' | 'MATERIAL';
  price_book_item_id: string | null;
  price_book_item?: { image_url: string | null } | null;
  /** #2053 slice 1 — see `InvoiceLineItem`'s identical pair (`@/lib/api/jobs`). */
  is_optional?: boolean;
  is_selected?: boolean;
  /** The rep's recommendation: see `InvoiceLineItem.rep_selected` (`@/lib/api/jobs`). Read-only. */
  rep_selected?: boolean | null;
}

/**
 * R5f — a photo attached to an Estimate line item or scope-of-work block. `url` is ALWAYS a
 * fresh, ready-to-use signed image URL returned by the backend — never construct or sign one
 * client-side (mirrors Inventory's `StageAttachment.dataUrl` convention).
 */
export interface EstimatePhoto {
  id: string;
  url: string;
  mime_type: string;
  /** Nullable column — the upload-response path (unlike GET /:id) sends `undefined` (key omitted) rather than `null` when unset. */
  caption?: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  /** Nullable column — same undefined-vs-null wire wrinkle as `caption` above. */
  size_bytes?: number | null;
}

/**
 * A scope-of-work photo — same shape as `EstimatePhoto` plus the owning block's own stable
 * `scope_id`. Scope photos come back as ONE flat top-level array on the estimate
 * (`scope_photos[]`), not nested inside `scopes[]` (the backend has no server-side attach point
 * on the scopes JSONB column) — group by `scope_id` client-side to associate with each block.
 */
export interface EstimateScopePhoto extends EstimatePhoto {
  scope_id: string;
}

/**
 * The `{ estimate }` envelope every granular line/scope endpoint below returns — the FULL
 * estimateDetailSelect-shaped, cost-stripped row (the same object GET /api/estimates/:id
 * returns). Deliberately NOT an exhaustive re-declaration of every estimateDetailSelect field
 * (lead/customer nesting, deposit info, signature, etc. — callers needing those keep using their
 * own richer local type, e.g. `PanelEstimate` in `InfoPanel.tsx`, extended with `scopes: Scope[]`
 * and `line_items: EstimateLineItem[]` per this file) — just the two shapes this surface's
 * callers need typed. Every other field is still present on the object at runtime and reachable
 * via the `Record<string, unknown>` intersection.
 */
export type EstimateDetail = {
  id: string;
  status: string;
  scopes: Scope[];
  line_items: EstimateLineItem[];
  /** R5f — flat array of every scope-of-work photo on this estimate; group by `scope_id` client-side. */
  scope_photos?: EstimateScopePhoto[];
} & Record<string, unknown>;

/** Body for POST /api/estimates/:id/line-items — add a line item. `is_taxable`/`item_type` default server-side (true/SERVICE) when omitted. */
export interface AddEstimateLinePayload {
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable?: boolean;
  item_type?: 'SERVICE' | 'MATERIAL';
  price_book_item_id?: string | null;
  unit_cost?: number | null;
  markup_percent?: number | null;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value?: number | null;
  /** #2053 slice 1 — non-optional implies selected (normalised server-side, never a 400). */
  is_optional?: boolean;
  is_selected?: boolean;
}

/**
 * Body for PATCH /api/estimates/:id/line-items/:lineId — update a line item. `price_book_item_id`
 * is excluded — an existing line's catalog ref can't be repointed after creation (mirrors
 * Job/Invoice's identical exclusion on their own update schemas).
 */
export interface UpdateEstimateLinePayload {
  description?: string;
  quantity?: number;
  unit_price?: number;
  is_taxable?: boolean;
  item_type?: 'SERVICE' | 'MATERIAL';
  unit_cost?: number | null;
  markup_percent?: number | null;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value?: number | null;
  /** #2053 slice 1 — see `AddEstimateLinePayload`'s identical pair above. */
  is_optional?: boolean;
  is_selected?: boolean;
}

/** POST /api/estimates/:id/line-items — add a line item; returns `{ estimate }` (the FULL updated estimate — see this section's header). */
export function addEstimateLine(
  estimateId: string,
  body: AddEstimateLinePayload,
): Promise<{ estimate: EstimateDetail }> {
  return api.post(`/api/estimates/${estimateId}/line-items`, body).then((r) => r.data);
}

/** PATCH /api/estimates/:id/line-items/:lineId — update a line item; returns `{ estimate }`. */
export function updateEstimateLine(
  estimateId: string,
  lineId: string,
  body: UpdateEstimateLinePayload,
): Promise<{ estimate: EstimateDetail }> {
  return api.patch(`/api/estimates/${estimateId}/line-items/${lineId}`, body).then((r) => r.data);
}

/** DELETE /api/estimates/:id/line-items/:lineId — remove a line item; returns `{ estimate }`. */
export function deleteEstimateLine(estimateId: string, lineId: string): Promise<{ estimate: EstimateDetail }> {
  return api.delete(`/api/estimates/${estimateId}/line-items/${lineId}`).then((r) => r.data);
}

/**
 * PATCH /api/estimates/:id/line-items/reorder — persist a full drag-and-drop reorder in ONE
 * request (avoids the lost-update race of firing one PATCH per moved line — same convention as
 * `reorderJobLines`/`reorderInvoiceLines`). `order` must be the complete top-to-bottom list of
 * this estimate's current line-item ids. Returns `{ estimate }`.
 */
export function reorderEstimateLines(estimateId: string, order: string[]): Promise<{ estimate: EstimateDetail }> {
  return api.patch(`/api/estimates/${estimateId}/line-items/reorder`, { order }).then((r) => r.data);
}

/** GET /api/estimates/:id/scopes — the estimate's current scope-of-work blocks. No `billing` key (unlike Job/Invoice) — Estimate persists its own subtotal/total_amount; see this section's header. */
export function listEstimateScopes(estimateId: string): Promise<{ scopes: Scope[] }> {
  return api.get(`/api/estimates/${estimateId}/scopes`).then((r) => r.data);
}

/** Body for POST /api/estimates/:id/scopes — add a scope-of-work block. */
export interface AddEstimateScopePayload {
  title: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
  /** #2053 slice 1 — non-optional implies selected (normalised server-side, never a 400). */
  is_optional?: boolean;
  is_selected?: boolean;
}

/** Body for PATCH /api/estimates/:id/scopes/:idx — update a scope-of-work block. */
export interface UpdateEstimateScopePayload {
  title?: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
  /** #2053 slice 1 — see `AddEstimateScopePayload`'s identical pair above. */
  is_optional?: boolean;
  is_selected?: boolean;
}

/** POST /api/estimates/:id/scopes — add a scope-of-work block; returns `{ estimate }` (the FULL updated estimate, already includes the new `scopes` entry per `estimateDetailSelect`). */
export function addEstimateScope(
  estimateId: string,
  body: AddEstimateScopePayload,
): Promise<{ estimate: EstimateDetail }> {
  return api.post(`/api/estimates/${estimateId}/scopes`, body).then((r) => r.data);
}

/** PATCH /api/estimates/:id/scopes/:idx — update a scope-of-work block; returns `{ estimate }`. */
export function updateEstimateScope(
  estimateId: string,
  idx: number,
  body: UpdateEstimateScopePayload,
): Promise<{ estimate: EstimateDetail }> {
  return api.patch(`/api/estimates/${estimateId}/scopes/${idx}`, body).then((r) => r.data);
}

/** DELETE /api/estimates/:id/scopes/:idx — remove a scope-of-work block; returns `{ estimate }`. */
export function deleteEstimateScope(estimateId: string, idx: number): Promise<{ estimate: EstimateDetail }> {
  return api.delete(`/api/estimates/${estimateId}/scopes/${idx}`).then((r) => r.data);
}

/**
 * PATCH /api/estimates/:id/scopes/reorder — persist a full scope-block reorder atomically in ONE
 * request (avoids the lost-update race of firing one PATCH /scopes/:idx per moved block — same
 * convention as `reorderJobScopes`/`reorderInvoiceScopes`). `order` must be the complete
 * top-to-bottom list of this estimate's current scope ids. Returns `{ estimate }`.
 */
export function reorderEstimateScopes(estimateId: string, order: string[]): Promise<{ estimate: EstimateDetail }> {
  return api.patch(`/api/estimates/${estimateId}/scopes/reorder`, { order }).then((r) => r.data);
}

// ─── Scope-of-work photos (R5f) ──────────────────────────────────────────────────────────────
//
// Storage-backed, multipart uploads — mirrors `useUploadStageAttachment`/`useDeleteStageAttachment`
// (`@/lib/api/inventory.ts`)'s FormData-building convention: a single `file` field, no extra
// metadata parts (these endpoints don't accept caption/source on upload). Every response's `url`
// is always a fresh, ready-to-use signed URL — never construct/sign one client-side.

/**
 * POST /api/price-book/items/:id/image — #2045's narrow "fill if empty" endpoint. Lets a
 * requester who may edit the given estimate (but not necessarily `update PriceBook`) set an
 * image-less catalog item's picture from one of the estimate's linked lines. `estimateId` is sent
 * so the backend can enforce the requester's own estimate row scope; refuses (403) once the item
 * already has an image — replacing an existing image stays a `PATCH /api/price-book/items/:id`
 * (`update PriceBook`) action, unchanged. Mirrors `uploadScopePhoto`'s FormData convention — the
 * per-line-item photo path this comment once pointed at was retired in #2029.
 */
export function fillPriceBookItemImage(
  itemId: string,
  file: File,
  estimateId: string,
): Promise<{ item: { id: string; image_url: string } }> {
  const form = new FormData();
  form.append('file', file);
  form.append('estimate_id', estimateId);
  return api
    .post(`/api/price-book/items/${itemId}/image`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
}

/**
 * POST /api/estimates/:id/scopes/:scopeId/photos — attach a photo to a scope-of-work block.
 * `scopeId` is the block's own stable `id` field (`Scope.id`), NOT its array index.
 */
export function uploadScopePhoto(
  estimateId: string,
  scopeId: string,
  file: File,
): Promise<{ photo: EstimatePhoto }> {
  const form = new FormData();
  form.append('file', file);
  return api
    .post(`/api/estimates/${estimateId}/scopes/${scopeId}/photos`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
}

/** DELETE /api/estimates/:id/scopes/:scopeId/photos/:photoId — 204 on success. */
export function deleteScopePhoto(estimateId: string, scopeId: string, photoId: string): Promise<void> {
  return api.delete(`/api/estimates/${estimateId}/scopes/${scopeId}/photos/${photoId}`).then(() => undefined);
}
