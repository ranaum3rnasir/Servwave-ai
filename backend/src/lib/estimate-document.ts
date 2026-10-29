/**
 * The one definition of what an estimate DOCUMENT is made of (#2028 slice 1).
 *
 * An estimate is rendered to a customer on three surfaces — the previewed PDF, the PDF attached
 * to the customer's email, and the public web page. Each surface used to carry its own Prisma
 * `select`, and they disagreed: the emailed PDF's omitted `scopes`, `scope_notes` and both
 * discount fields, so a document whose money lives in a priced scope-of-work block printed line
 * items summing to far less than its own Sub total. calculateTotals() folds every priced scope's
 * flat_price into subtotal/total_amount on every write path, so a surface that does not SELECT
 * the scopes cannot print an arithmetic that reconciles — the defect is invisible in the
 * templates and lives entirely in the selects.
 *
 * Every document surface therefore spreads `estimateDocumentSelect`, and nothing but this file
 * decides which estimate fields a customer-facing document is built from. Surfaces still add
 * their own NON-document fields on top (authorization anchors, deposit invoices, send_config).
 */
import { asScopeArray, stripScopeCost, type ScopeOfWork } from './scopes';

/**
 * The customer/service-location/lead sub-selects, split out so a call site that needs to widen
 * one (getPdf loads `lead.lead_assignees` for its per-row authorization gate) can spread the
 * document's own keys rather than restating them.
 */
export const estimateDocumentCustomerSelect = {
  first_name: true,
  last_name: true,
  company_name: true,
  email: true,
  phone: true,
} as const;

export const estimateDocumentServiceLocationSelect = {
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  zip: true,
} as const;

export const estimateDocumentLeadSelect = {
  service_address_line1: true,
  service_address_line2: true,
  service_city: true,
  service_state: true,
  service_zip: true,
  customer: {
    select: {
      ...estimateDocumentCustomerSelect,
      service_locations: {
        where: { is_primary: true },
        take: 1,
        select: { is_primary: true, ...estimateDocumentServiceLocationSelect },
      },
    },
  },
} as const;

export const estimateDocumentLineItemSelect = {
  id: true,
  sequence: true,
  description: true,
  item_type: true,
  quantity: true,
  unit_price: true,
  is_taxable: true,
  // GROSS (quantity × unit_price). calculateTotals adds `line_total - discount_amount` to the
  // subtotal, so every surface needs discount_amount alongside it to print a reconciling figure.
  line_total: true,
  discount_type: true,
  discount_value: true,
  discount_amount: true,
  // #2053 — the selection flags `recomputeInvoiceTotals` accumulates on. The customer-facing
  // document reads the PERSISTED subtotal, which already excludes an optional-unselected item, so
  // without these the view-model is structurally blind: it would print an amount on a row the
  // Subtotal beneath it does not contain. Neither is a cost field — they are part of what the
  // customer was offered, and the token-gated public read carries them (#2053 R9).
  is_optional: true,
  is_selected: true,
  // #2029 — a line item's ONE image, and the only one it has: an attribute of the stock/price-book
  // item, never an upload (the per-line-item upload path was retired in slice 1). Now selected on
  // every document surface, not just the web page, so the PDF can draw it too.
  price_book_item: { select: { image_url: true } },
} as const;

/** Everything a customer-facing estimate document is built from. */
export const estimateDocumentSelect = {
  id: true,
  estimate_number: true,
  status: true,
  created_at: true,
  organization_id: true,
  // subtotal is PRE-estimate-discount; total = (subtotal - discount_amount) + tax_amount.
  subtotal: true,
  discount_type: true,
  discount_value: true,
  discount_name: true,
  discount_amount: true,
  tax_rate: true,
  tax_amount: true,
  total_amount: true,
  signature_data: true,
  signature_at: true,
  // The send-time snapshot of the org's terms/notes/payment terms. pickContent() falls back to
  // the live org copy for DRAFT rows only, so a surface missing these shows a SENT estimate the
  // org's CURRENT terms rather than the ones the customer was actually sent.
  snapshot_terms: true,
  snapshot_notes: true,
  snapshot_payment_terms: true,
  // Both scope shapes: `scope_notes` is the legacy single narrative field, `scopes` the JSONB
  // array of flat-priced blocks that calculateTotals folds into the subtotal.
  scope_notes: true,
  scopes: true,
  // #2029 — the photos attached to the scope blocks. Flat (not nested under `scopes`, which is a
  // raw JSONB array with no server-side attach point); every consumer groups them by `scope_id`
  // through the document view-model. `storage_path` is selected only so it can be exchanged for a
  // freshly-signed url — it must never reach a response.
  scope_photos: {
    select: {
      id: true, scope_id: true, storage_path: true, mime_type: true,
      caption: true, uploaded_at: true, uploaded_by: true, size_bytes: true,
    },
    orderBy: { uploaded_at: 'asc' as const },
  },
  customer: { select: estimateDocumentCustomerSelect },
  service_location: { select: estimateDocumentServiceLocationSelect },
  lead: { select: estimateDocumentLeadSelect },
  line_items: {
    select: estimateDocumentLineItemSelect,
    orderBy: { sequence: 'asc' as const },
  },
  // #2089 — `areSelectionsLocked` (estimate-document-view.ts) finds the deposit row by `kind`
  // among these to decide whether an untaken optional row now reads "Declined". Not a cost
  // field, and the customer-facing public route already selects this same shape for the
  // identical reason (see `estimatePublicSelect`'s own comment).
  invoices: {
    where: { kind: 'DEPOSIT' as const },
    select: { kind: true, status: true },
    take: 1,
  },
} as const;

/**
 * Normalise a row selected with `estimateDocumentSelect` into the shape the renderers consume.
 *
 * Two things every surface would otherwise have to remember:
 *  - `scopes` is a JSONB column, so it reads back as `null` (never `[]`) when no scope has ever
 *    been added — `asScopeArray` is the guard, and a renderer reaching into the raw column is a
 *    bug even when it appears to work.
 *  - a stored scope carries `internal_cost` (staff-only margin data). Stripping it here means a
 *    surface that serialises the document to the customer — the public web page does exactly
 *    that — cannot leak it by forgetting to.
 */
export function toEstimateDocument<T extends { scopes?: unknown }>(
  row: T,
): Omit<T, 'scopes'> & { scopes: Omit<ScopeOfWork, 'internal_cost'>[] } {
  return { ...row, scopes: stripScopeCost(asScopeArray(row.scopes)) };
}

export type EstimateDocumentRow = Parameters<typeof toEstimateDocument>[0];
