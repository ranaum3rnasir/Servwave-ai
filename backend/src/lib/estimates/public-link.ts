/**
 * Revoking an estimate's public link (#2090, rulings 15-17), and the one predicate that decides
 * when to.
 *
 * `getPublic` matches on `where: { id, public_token: token }` alone — no status check — so the
 * ONLY thing that retires a customer's link is nulling the column. `valid_until` goes with it so
 * a revoked row carries no stale expiry date either.
 *
 * Spread into the `data` of whichever write retires the document, so every dead-link path ends at
 * the same 404 the customer already sees for a wrong token. A6 uses it on supersede; A5 uses it
 * on a changed edit. The next send mints a fresh token from `existing.public_token ?? …`, and
 * writes a fresh `valid_until` with it — the two are one object and are minted and retired
 * together.
 */
import { asScopeArray } from '../scopes';

export const REVOKE_PUBLIC_LINK = { public_token: null, valid_until: null } as const;

/** Money and quantity are all `Decimal(_, 2)`; `tax_rate` is `Decimal(6, 5)`. */
function atScale(value: unknown, decimals: number): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

const money = (v: unknown) => atScale(v, 2);

/**
 * One line of the customer's document. Every field here is rendered to them — see
 * `estimateDocumentLineItemSelect` (lib/estimate-document.ts), the single projection all three
 * customer surfaces are built from, and `toDocumentRows` (lib/estimate-document-view.ts), which
 * turns each of these into a printed row.
 *
 * `id` is deliberately absent: the whole-document PATCH deletes and re-creates every line, so ids
 * churn on an edit that changed nothing the customer can see.
 *
 * So is `sequence`. The document renders ORDER, not the stored number (`DocumentRow` has no such
 * field), and the projection below is already an ordered array, so the value adds nothing — while
 * costing a great deal. `deleteLine` does not resequence, so a stored `1,3` is an ordinary state,
 * and `update()` rebuilds its list as `sequence: idx + 1`; comparing the raw values made a
 * byte-identical re-save after a line delete look like a changed document and retire a live link
 * (and, through the PENDING rule, unrecoverably null a customer's signature).
 *
 * And so is `is_taxable`, on lines and on scope blocks alike. Neither PDF template nor the public
 * page reads it — `buildEstimateDocumentView` never projects it. It reaches the customer only as
 * `tax_amount`, which this projection already carries, so at a 0% rate or for a tax-exempt
 * customer flipping it moves nothing rendered.
 */
export interface CustomerVisibleLine {
  description?: unknown;
  item_type?: unknown;
  quantity?: unknown;
  unit_price?: unknown;
  line_total?: unknown;
  discount_type?: unknown;
  discount_value?: unknown;
  discount_amount?: unknown;
  is_optional?: unknown;
  is_selected?: unknown;
  /** Stands in for the ONE image a line renders (`price_book_item.image_url`, #2029). */
  price_book_item_id?: unknown;
}

/**
 * The estimate-level half. Optional keys are for a call site that cannot move them — the granular
 * line/scope endpoints never write `scope_notes`, `discount_name` or the deposit pair, so they
 * pass neither side and the comparison is unaffected.
 */
export interface CustomerVisibleDocumentInput {
  subtotal?: unknown;
  tax_amount?: unknown;
  total_amount?: unknown;
  discount_amount?: unknown;
  tax_rate?: unknown;
  discount_type?: unknown;
  discount_value?: unknown;
  discount_name?: unknown;
  deposit_type?: unknown;
  deposit_value?: unknown;
  scope_notes?: unknown;
  /** The raw JSONB column, or an already-parsed array. */
  scopes?: unknown;
  line_items?: readonly CustomerVisibleLine[] | null;
}

/**
 * A stable projection of EXACTLY what the customer's three surfaces render, and nothing else.
 *
 * Built as an array of primitives rather than an object literal so the comparison cannot depend on
 * key order — `scopes` is a raw JSONB blob whose key order changes whenever a block is rewritten.
 */
function project(doc: CustomerVisibleDocumentInput): unknown[] {
  const scopes = asScopeArray(doc.scopes).map((s) => [
    s.id,
    s.title,
    s.body,
    money(s.flat_price),
    // #2053 read-time defaults: a block written before the feature carries neither key, and the
    // document renders it as a required, counted block.
    s.is_optional ?? false,
    s.is_selected ?? true,
    // NOT included: `internal_cost` (stripped by `stripScopeCost` before the document is built)
    // and the rep's recommendation column (stripped by `stripScopeSendSnapshot`; it is the REP's
    // own state, and A3 exists precisely so a rep's tick no longer 404s the customer
    // mid-decision). Naming that column here would also widen a deliberate A2 allowlist.
  ]);

  const lines = (doc.line_items ?? []).map((l) => [
    l.description,
    l.item_type,
    money(l.quantity),
    money(l.unit_price),
    money(l.line_total),
    l.discount_type ?? null,
    money(l.discount_value),
    money(l.discount_amount),
    l.is_optional ?? false,
    l.is_selected ?? true,
    l.price_book_item_id ?? null,
    // NOT included: `unit_cost` / `markup_percent`. Neither is selected by
    // `estimateDocumentLineItemSelect` or by `estimatePublicSelect` — they are staff-only margin
    // data (D2/D8, `stripEstimateCost`), so moving one changes nothing the customer was quoted.
    // The rep's recommendation column is absent for the same reason as on a scope, and
    // `sequence`/`is_taxable` for the reasons on `CustomerVisibleLine` above.
  ]);

  return [
    money(doc.subtotal),
    money(doc.tax_amount),
    money(doc.total_amount),
    money(doc.discount_amount),
    // Printed as its own "Tax (n%)" line, so a rate that moves while the amount does not is still
    // a different document.
    atScale(doc.tax_rate, 5),
    doc.discount_type ?? null,
    money(doc.discount_value),
    doc.discount_name ?? null,
    // The deposit the customer is asked for. Not part of `estimateDocumentSelect`, but the figure
    // the public page and the deposit invoice behind it are built from, and already part of the
    // pre-A5 predicate — narrowing it would be a regression.
    doc.deposit_type ?? null,
    money(doc.deposit_value),
    // The scope narrative, rendered under the "Scope of Work" heading (`model.scopeNotes`).
    // `name` / `scope_name` are NOT here: neither is selected by any document surface, so they
    // are staff labels on the tab strip and change nothing the customer opens.
    doc.scope_notes ?? null,
    scopes,
    lines,
  ];
}

/**
 * THE predicate: would the customer's page, and both PDFs, render this differently?
 *
 * Ran's ruling of 2026-09-19 is scoped to the DOCUMENT, not to its four totals columns: a changed
 * description, item type, scope prose, or a quantity-and-price swap that nets to the same figure
 * are all a different offer, and the old URL has to die. The pre-A5 predicate compared only
 * subtotal / tax_amount / total_amount / discount_amount, so every one of those reached the
 * customer's live page silently.
 *
 * Both write paths that can move a sent estimate call this and nothing else —
 * `update()` (the whole-document PATCH) and `recomputeAndPersist` (every granular line and scope
 * endpoint) — so the two surfaces cannot drift apart.
 */
export function customerVisibleDocumentChanged(
  before: CustomerVisibleDocumentInput,
  after: CustomerVisibleDocumentInput,
): boolean {
  return JSON.stringify(project(before)) !== JSON.stringify(project(after));
}
