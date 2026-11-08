/**
 * Invoice money-model endpoints (entity-redesign §8).
 *
 * - credit: NEW — apply a credit / give-back (admin-only).
 * - voidPayment: NEW — void a single recorded payment (payment_id in the BODY, not path).
 * - refund: CHANGED — now partial + multiple. The body supports amount/method/payment_id
 *   /reason/reason_category plus the tax flag. Omitting `amount` = full-balance refund,
 *   which keeps the existing RefundDepositDialog full-refund call valid.
 *
 * Routes + payload field names verified against backend/src/controllers/invoice.controller.ts
 * (refundInvoiceSchema, creditInvoiceSchema, voidPaymentSchema).
 */
import api from '@/lib/axios';
import type { RefundCategory, VoidPaymentReason, PaymentMethod } from '@/types/entities';
// Scope is defined once in jobs.ts (Job needs the richer listJobScopes) and imported here so
// Job.scopes / Invoice.scopes — the same JSONB shape on both entities — never silently drift.
export type { Scope } from './jobs';

/** Body for POST /api/invoices/:id/refund — partial-capable. */
export interface RefundInvoicePayload {
  /** Omit for a full-balance refund. */
  amount?: number;
  payment_id?: string;
  method?: PaymentMethod;
  reference_number?: string;
  /** Backend field: when true, the refund is treated as a non-taxable concession. */
  non_taxable_concession?: boolean;
  reason_category: RefundCategory;
  reason: string;
}

/** Body for POST /api/invoices/:id/credit. */
export interface CreditInvoicePayload {
  amount: number;
  reason: string;
  category?: string;
  /** When true the give-back is issued as cash refund instead of a balance credit. */
  refund_instead?: boolean;
  /**
   * Only valid together with refund_instead, and only when a balance is owed - never on a
   * deposit invoice. Puts the refunded money back on the customer's balance instead of
   * recording it as a write-off (docs/adr/0004-refund-never-reopens-amount-due.md).
   */
  reopen_balance?: boolean;
  method?: PaymentMethod;
  non_taxable_concession?: boolean;
}

/** Body for POST /api/invoices/:id/void-payment. */
export interface VoidPaymentPayload {
  payment_id: string;
  void_category: Exclude<VoidPaymentReason, 'CHARGEBACK'>;
  reason: string;
}

/** POST /api/invoices/:id/refund — partial or full refund of a paid invoice. */
export function refundInvoice(id: string, body: RefundInvoicePayload) {
  return api.post(`/api/invoices/${id}/refund`, body).then((r) => r.data);
}

/** POST /api/invoices/:id/credit — apply a credit / give-back. */
export function creditInvoice(id: string, body: CreditInvoicePayload) {
  return api.post(`/api/invoices/${id}/credit`, body).then((r) => r.data);
}

/** POST /api/invoices/:id/void-payment — void a single recorded payment. */
export function voidPayment(invoiceId: string, body: VoidPaymentPayload) {
  return api.post(`/api/invoices/${invoiceId}/void-payment`, body).then((r) => r.data);
}

/**
 * POST /api/invoices/:id/payment-link — mint (or reuse) a payable public link WITHOUT sending
 * an email. NOT gated by the org email_sending_enabled toggle. A DRAFT invoice is minted a
 * token and flipped to SENT (a payable link requires the invoice to be issued); an
 * already-issued invoice just returns its existing token (idempotent).
 */
export function createInvoicePaymentLink(invoiceId: string) {
  return api.post(`/api/invoices/${invoiceId}/payment-link`).then((r) => r.data as { invoice: unknown; url: string });
}

// ─── Line-item CRUD ───────────────────────────────────────────────────────────

/** Body for POST /api/invoices/:id/line-items — add a line. */
export interface AddLineItemPayload {
  description: string;
  item_type: 'SERVICE' | 'MATERIAL';
  quantity: number;
  unit_price: number;
  unit_cost?: number | null;
  markup_percent?: number | null;
  is_taxable: boolean;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discount_value?: number;
  price_book_item_id?: string;
}

/** Body for PATCH /api/invoices/:id/line-items/:lineId — update a line. */
export interface UpdateLineItemPayload {
  quantity?: number;
  unit_price?: number;
  unit_cost?: number | null;
  markup_percent?: number | null;
  is_taxable?: boolean;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value?: number | null;
  item_type?: 'SERVICE' | 'MATERIAL';
}

/** Body for PATCH /api/invoices/:id/billing — update tip / invoice-level discount / tax rate. */
export interface UpdateInvoiceBillingPayload {
  tip?: number | null;
  discount_amount?: number | null;
  /** Sales-tax rate as a FRACTION (e.g. 0.0663 for 6.63%). 0 = No tax. */
  tax_rate?: number | null;
}

/** POST /api/invoices/:id/line-items — add a line item; returns the updated invoice. */
export function addInvoiceLine(invoiceId: string, body: AddLineItemPayload) {
  return api.post(`/api/invoices/${invoiceId}/line-items`, body).then((r) => r.data);
}

/** PATCH /api/invoices/:id/line-items/:lineId — update a line item; returns the updated invoice. */
export function updateInvoiceLine(invoiceId: string, lineId: string, body: UpdateLineItemPayload) {
  return api.patch(`/api/invoices/${invoiceId}/line-items/${lineId}`, body).then((r) => r.data);
}

/** DELETE /api/invoices/:id/line-items/:lineId — remove a line item; returns the updated invoice. */
export function deleteInvoiceLine(invoiceId: string, lineId: string) {
  return api.delete(`/api/invoices/${invoiceId}/line-items/${lineId}`).then((r) => r.data);
}

/**
 * PATCH /api/invoices/:id/line-items/reorder — persist a full drag-and-drop reorder. `order`
 * must be the complete top-to-bottom list of this invoice's current line-item ids. Returns the
 * updated invoice.
 */
export function reorderInvoiceLines(invoiceId: string, order: string[]) {
  return api.patch(`/api/invoices/${invoiceId}/line-items/reorder`, { order }).then((r) => r.data);
}

/** PATCH /api/invoices/:id/billing — update tip and/or invoice-level discount; returns the updated invoice. */
export function updateInvoiceBilling(invoiceId: string, body: UpdateInvoiceBillingPayload) {
  return api.patch(`/api/invoices/${invoiceId}/billing`, body).then((r) => r.data);
}

// ─── Scope-of-work CRUD (Batch 3) ─────────────────────────────────────────────

/** Body for POST /api/invoices/:id/scopes — add a scope-of-work block. */
export interface AddInvoiceScopePayload {
  title: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
}

/** Body for PATCH /api/invoices/:id/scopes/:idx — update a scope-of-work block. */
export interface UpdateInvoiceScopePayload {
  title?: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
}

/** POST /api/invoices/:id/scopes — add a scope-of-work block; returns `{ invoice }` (the updated invoice, already includes `scopes` per `invoiceDetailSelect`). */
export function addInvoiceScope(invoiceId: string, body: AddInvoiceScopePayload) {
  return api.post(`/api/invoices/${invoiceId}/scopes`, body).then((r) => r.data);
}

/** PATCH /api/invoices/:id/scopes/:idx — update a scope-of-work block; returns `{ invoice }`. */
export function updateInvoiceScope(invoiceId: string, idx: number, body: UpdateInvoiceScopePayload) {
  return api.patch(`/api/invoices/${invoiceId}/scopes/${idx}`, body).then((r) => r.data);
}

/** DELETE /api/invoices/:id/scopes/:idx — remove a scope-of-work block; returns `{ invoice }`. */
export function deleteInvoiceScope(invoiceId: string, idx: number) {
  return api.delete(`/api/invoices/${invoiceId}/scopes/${idx}`).then((r) => r.data);
}

/**
 * PATCH /api/invoices/:id/scopes/reorder — persist a full scope-block reorder atomically in ONE
 * request. `order` must be the complete top-to-bottom list of this invoice's current scope ids.
 * Replaces the previous "diff the target order against the current one and PATCH just the
 * changed indices" strategy, which fired two concurrent PATCH /scopes/:idx calls for a simple
 * two-block swap (Move up/down) — a lost-update race, since each is a non-atomic whole-column
 * read-modify-write with no locking. Returns `{ invoice }` (already includes the reordered `scopes`).
 */
export function reorderInvoiceScopes(invoiceId: string, order: string[]) {
  return api.patch(`/api/invoices/${invoiceId}/scopes/reorder`, { order }).then((r) => r.data);
}

// ─── Price-book search ────────────────────────────────────────────────────────

/** A price-book item returned by search. */
export interface PriceBookItem {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: 'SERVICE' | 'MATERIAL';
  unit_cost: string | number;
  unit_price: string | number;
  taxable: boolean;
  category: string | null;
  /** Inventory P1 (C10): tells AddLineDialog to offer the deduct-from-location select. */
  track_inventory?: boolean;
  /** Present on the browse endpoint (`listItems` uses `include`, so the full row — incl. sku —
   *  comes back). The `/search` endpoint's `select` omits it, so it is undefined there. */
  sku?: string | null;
}

/**
 * GET /api/price-book/items/search?q=&type= — search catalog items.
 * `type` is optional; omit to search across both SERVICE and MATERIAL.
 */
export function searchPriceBookItems(
  q: string,
  type?: 'SERVICE' | 'MATERIAL',
): Promise<PriceBookItem[]> {
  const params = new URLSearchParams({ q });
  if (type) params.set('type', type);
  // The endpoint responds `{ data: [...] }` (see price-book.controller.searchItems).
  return api
    .get(`/api/price-book/items/search?${params.toString()}`)
    .then((r) => r.data?.data ?? r.data?.items ?? r.data ?? []);
}

/**
 * GET /api/price-book/items?is_active=true&limit=100 — browse the full active catalog;
 * optional `search` narrows server-side. Returns the same type/taxable shape as
 * searchPriceBookItems so browsed items flow through the add-line submit path unchanged.
 *
 * `trackedOnly` (Logistic Orders picker) adds `track_inventory=true` so only stocked items
 * come back — this endpoint uses Prisma `include`, so it already returns `track_inventory`
 * AND `sku`, unlike `/search` whose `select` omits both. No backend change needed.
 */
export function listPriceBookItems(
  search?: string,
  opts?: { trackedOnly?: boolean },
): Promise<PriceBookItem[]> {
  const params = new URLSearchParams({ is_active: 'true', limit: '100' });
  if (search) params.set('search', search);
  if (opts?.trackedOnly) params.set('track_inventory', 'true');
  return api.get(`/api/price-book/items?${params.toString()}`).then((r) => r.data?.data ?? []);
}

/** Body for POST /api/price-book/items — create a reusable catalog item. */
export interface CreatePriceBookItemPayload {
  name: string;
  type: 'SERVICE' | 'MATERIAL';
  unit_price: number;
  taxable: boolean;
  description?: string;
  /** Catalog cost. Omitted (not sent as 0) when the dialog's Unit cost field is blank. */
  unit_cost?: number;
}

/**
 * POST /api/price-book/items — create a catalog item (admin/dispatcher `create PriceBook`).
 * Used by the "Also save to price book" path in the add-line dialog. Returns the new item.
 */
export function createPriceBookItem(body: CreatePriceBookItemPayload): Promise<PriceBookItem> {
  return api.post('/api/price-book/items', body).then((r) => r.data?.data ?? r.data);
}

// ─── State tax rates (jurisdiction dropdown) ──────────────────────────────────

/** A US-state sales-tax rate row (tax_rate is a FRACTION, e.g. "0.0850"). */
export interface StateTaxRate {
  id: string;
  state_code: string;
  state_name: string;
  tax_rate: string | number;
}

/** GET /api/state-tax-rates — the jurisdiction list for the tax dropdown (mirrors the estimate form). */
export function fetchStateTaxRates(): Promise<StateTaxRate[]> {
  return api.get('/api/state-tax-rates').then((r) => r.data?.data ?? r.data ?? []);
}
