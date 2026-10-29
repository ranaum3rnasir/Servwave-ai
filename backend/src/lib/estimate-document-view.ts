/**
 * The estimate document VIEW-MODEL (#2028 slice 2).
 *
 * An estimate is drawn on three surfaces — two pdfmake templates and one React page — and each
 * used to decide for itself which sections exist, how a priced versus unpriced scope block is
 * presented, how discounts are summarised and what the totals rows are. Those four decisions are
 * made once here, into plain data.
 *
 * Nothing in this file knows about pdfmake or the DOM. That is the point: the content coverage
 * for the whole estimate document lives here and is asserted directly, and a renderer is left
 * with layout only. `lib/estimate-document.ts` decides what a document is SELECTED from; this
 * decides what it SAYS.
 */
import { asScopeArray, type ScopeOfWork } from './scopes';
import { countsTowardTotals } from './invoice-totals';
import { areSelectionsLocked } from './estimates/selectionLock';

/** A photo attached to a scope-of-work block. The URL is always freshly signed, never stored. */
export interface DocumentPhoto {
  id: string;
  url: string;
  caption: string | null;
}

/** A row in the document's single priced list: a line item, or a scope-of-work block. */
export interface DocumentRow {
  kind: 'line_item' | 'scope';
  /** Stable within one document — used as a render key, never shown. */
  key: string;
  /** The bold first line. A line item's description is split on its first newline. */
  title: string;
  /** The rest of the description, or a scope's body. Null when there is none. */
  detail: string | null;
  /** MATERIAL / SERVICE for a line item; null for a scope, which has no item type. */
  itemType: string | null;
  quantity: number | null;
  unitPrice: number | null;
  /**
   * The pre-discount figure, shown struck through beside `netAmount` when `discounted`.
   * Null when nothing is struck through.
   */
  grossAmount: number | null;
  /**
   * What this row costs, after its own discount. Null ONLY for a row that carries no amount at
   * all — an unpriced scope block — which is distinct from a zero, since a zero claims the work
   * is free.
   *
   * An optional row the customer has not selected keeps its figure (Ran, 2026-09-13): the
   * customer is entitled to see what they were offered and what it would cost. Whether that
   * figure is INSIDE the document's own totals is `countsTowardTotals`, which is what a surface
   * reads to mark the row — never this field's nullness.
   */
  netAmount: number | null;
  /**
   * #2053 — this row is an OPTIONAL add-on. A surface may mark it; nothing here requires one to.
   * Always false on a document written before optional items existed (both flags absent).
   */
  optional: boolean;
  /**
   * #2053 — whether this row's money is inside the document's own Subtotal. The single predicate
   * `recomputeInvoiceTotals` accumulates on (`lib/invoice-totals.ts`), applied to the same row —
   * never re-implemented here, so the printed list and the persisted totals cannot drift.
   */
  countsTowardTotals: boolean;
  /**
   * #2089 - true once this document's selections are LOCKED (deposit paid, or the estimate WON
   * with no deposit) - the same value on every row of one document. Absent on a row built before
   * this existed, which `optionalMarkerFor` reads as unlocked, so a frozen version keeps printing
   * exactly what it always did.
   */
  locked?: boolean;
  discounted: boolean;
  /**
   * How the line's OWN discount was expressed — 'PERCENTAGE' with a rate, or a fixed amount — so
   * a surface can caption it ("Discount: 10% (-$50.00)"), as the web page does. Null when the
   * line carries a discount amount but no type, which legacy rows do. Neither PDF template
   * captions it today; the field is here so the two halves of the mirror stay one shape.
   */
  discountType: string | null;
  discountValue: number | null;
  /** The discount actually taken off this line. Null when there is none. */
  discountAmount: number | null;
  /** The price-book item's own image, when it has one. */
  imageUrl: string | null;
  /**
   * The photos attached to THIS scope block, in upload order (#2029). Empty for a line item —
   * line items carry no uploaded photos at all, only the price-book item's own `imageUrl`.
   * These are the only uploaded images anywhere on the document: not the lead's attachments,
   * not the job's, not the estimate's own file panel.
   */
  photos: DocumentPhoto[];
}

/** The two sections a document can print. A section exists only when it has content. */
export type DocumentSectionKind = 'scope' | 'line_items';

/**
 * One printed section of the document. Emitted only when it carries something, so no surface
 * ever draws an empty header.
 */
export interface DocumentSection {
  kind: DocumentSectionKind;
  /**
   * The heading printed above the section, identical on every surface. NULL when the document
   * has only this one section and therefore needs no heading over it — see `documentSections`.
   */
  title: string | null;
  /**
   * The narrative scope-of-work paragraph. Only ever set on the scope section — it belongs to
   * the same section as the scope blocks so a document that has both does not print the words
   * "Scope of Work" twice under different content.
   */
  notes: string | null;
  rows: DocumentRow[];
}

export type TotalsRowKind = 'subtotal' | 'line_discounts' | 'discount' | 'tax' | 'total';

export interface TotalsRow {
  kind: TotalsRowKind;
  label: string;
  amount: number;
  /** Rendered as a subtraction (a leading minus) rather than a plain figure. */
  negative: boolean;
}

export interface EstimateDocumentView {
  number: string;
  createdAt: Date;
  status: string;
  /** The narrative scope-of-work field. Null when empty, so no surface draws an empty header. */
  scopeNotes: string | null;
  rows: DocumentRow[];
  /** True when at least one row is a line item / a scope — what the section gates read. */
  hasLineItems: boolean;
  hasScopes: boolean;
  totals: TotalsRow[];
  /** Resolved through the send-time snapshot, so a SENT estimate keeps the copy it was sent with. */
  terms: string;
  notes: string;
  paymentTerms: string;
  signature: { data: string; at: Date | null } | null;
  taxRate: number;
}

/**
 * The customer-facing copy for an optional add-on, in ONE place for both PDF templates (the
 * frontend half of the mirror carries the same two strings for the web page). Ran can reword
 * either without reading a renderer.
 *
 * The marker sits on the row, beside the figure it qualifies; the note sits under the totals, so
 * a reader who only reads the bottom of the document still learns that some figure above is not
 * in what they are being asked to pay. "Optional" is the word the estimate editor already puts
 * beside the Selected switch, so the salesperson and the customer read the same term.
 *
 * #2090 - the note names the MARKER, not the category. It used to read "Optional items are not
 * included in the Total", which was false the moment any add-on was taken: a rep pre-selecting one
 * (and, since slice 3, a customer ticking one) puts real money inside the Total while the sentence
 * below it denied there was any. Pointing at the marker keeps it true in every state the note can
 * render in, and it renders only while at least one row still carries that marker
 * (`hasOptionalExtras`). It names no figure, so no arithmetic can go stale under it.
 */
export const OPTIONAL_ROW_MARKER = 'Optional (not included)';
/**
 * The tag on an add-on the customer HAS taken. Ran, 2026-09-18: "Let's just say included, not
 * optional." It used to read "Optional", which kept a trace of whose choice the row was on a
 * signed document; the word the customer needs at that point is whether it is in the price, and
 * it is the same word the estimate editor's own tag uses for the same state.
 */
export const OPTIONAL_INCLUDED_MARKER = 'Included';
export const OPTIONAL_TOTALS_NOTE = 'Items marked not included are outside the Total.';
/**
 * #2089 - the marker an untaken add-on carries once selections are LOCKED (deposit paid, or the
 * estimate WON with no deposit): not merely "not included" any more, but a choice the customer
 * will not get to revisit. `optionalMarkerFor` is the only place that reads it.
 */
export const OPTIONAL_DECLINED_MARKER = 'Declined';

/**
 * The rows whose printed amount is OUTSIDE the document's own totals: an optional add-on the
 * customer has not selected. This is the one thing a surface has to know to mark a row — derived
 * from the state the row already carries, never re-derived from the flags, and deliberately not a
 * field, since a version frozen before this existed (#2030) would not carry it.
 */
export function isOptionalExtra(row: { optional: boolean; countsTowardTotals: boolean }): boolean {
  return row.optional && !row.countsTowardTotals;
}

/**
 * #2090 - the caption a row carries, or null when it carries none. The ONE place the two markers
 * are chosen between, so the web page and both PDF templates cannot label the same row
 * differently. A row that was never optional gets null, which is what keeps every document written
 * before optional items existed byte-identical.
 *
 * #2089 - `locked` (absent on any row built before this existed, which reads as unlocked) swaps
 * an untaken add-on's marker from "not included" to "Declined" once the customer's choice is
 * closed. A TAKEN add-on keeps the plain "Optional" tag regardless of lock state - the lock only
 * ever answers what happens to the ones nobody chose.
 */
export function optionalMarkerFor(row: { optional: boolean; countsTowardTotals: boolean; locked?: boolean }): string | null {
  if (!row.optional) return null;
  if (isOptionalExtra(row)) return row.locked ? OPTIONAL_DECLINED_MARKER : OPTIONAL_ROW_MARKER;
  return OPTIONAL_INCLUDED_MARKER;
}

/** True when the document offers at least one such row — what gates the totals note. */
export function hasOptionalExtras(model: { rows: DocumentRow[] }): boolean {
  return model.rows.some(isOptionalExtra);
}

/**
 * #2089 - "N of M optional add-ons included", or null when the document offers none (M=0), so a
 * document written before optional items existed prints nothing new. M counts every optional ROW
 * - a line item or a scope block alike (#2053 R8, the same rule `isOptionalExtra` already reads
 * off the row rather than re-deriving from raw flags), matching the definition the internal staff
 * receipt card already uses. No currency figure - just a count.
 */
export function optionalSummaryFor(model: { rows: DocumentRow[] }): string | null {
  const optionalRows = model.rows.filter((r) => r.optional);
  if (optionalRows.length === 0) return null;
  const included = optionalRows.filter((r) => r.countsTowardTotals).length;
  return `${included} of ${optionalRows.length} optional add-ons included`;
}

/** Cents-rounded. Floats are not money. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Net amount actually contributed to the subtotal by one line.
 *
 * Number()-coerced because the controllers hand the raw Prisma row through, so these arrive as
 * Decimal rather than number despite the declared types.
 */
export function lineNetTotal(li: { line_total: number; discount_amount: number }): number {
  return round2(Number(li.line_total) - Number(li.discount_amount));
}

/** True when a document-level discount exists (Decimal-safe). */
export function hasDocDiscount(e: { discount_amount: number }): boolean {
  return Number(e.discount_amount) > 0;
}

/**
 * The copy to print: the send-time snapshot for anything that has left DRAFT, the org's live copy
 * for a draft (which has no snapshot yet) and for legacy rows that predate snapshotting.
 */
export function pickContent(snap: string | null, live: string, status: string): string {
  if (status === 'DRAFT') return live;
  return snap ?? live;
}

interface EstimateForView {
  estimate_number: string;
  created_at: Date;
  status: string;
  subtotal: number;
  discount_amount: number;
  discount_name: string | null;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  signature_data: string | null;
  signature_at: Date | null;
  snapshot_terms: string | null;
  snapshot_notes: string | null;
  snapshot_payment_terms: string | null;
  scope_notes?: string | null;
  scopes?: Omit<ScopeOfWork, 'internal_cost'>[] | null;
  /**
   * Scope photos arrive FLAT — `scopes` is a JSONB array with no relational row per block to nest
   * them under — so they carry `scope_id` and are grouped here, once, rather than by each surface.
   * `url` is a freshly-signed Storage url; `storage_path` never reaches a renderer.
   */
  scope_photos?: Array<{ id: string; scope_id: string; url?: string | null; caption?: string | null }> | null;
  line_items: Array<{
    id?: string;
    // #2053 — absent on every pre-migration row and on every Job/Invoice line; `countsTowardTotals`
    // reads an absent pair as "counts", which is the unconditional-sum behaviour that predates it.
    is_optional?: boolean | null;
    is_selected?: boolean | null;
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    discount_amount: number;
    discount_type?: string | null;
    discount_value?: number | null;
    price_book_item?: { image_url?: string | null } | null;
  }>;
  /**
   * #2089 - the ONLY thing `areSelectionsLocked` needs beyond `status`. Optional because several
   * existing callers (the org settings PDF preview, a handful of pinned fixtures) build this
   * shape without it - an estimate with no invoices at all is simply never locked on a deposit,
   * which is the correct, pre-existing fallback `areSelectionsLocked` already has.
   */
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}

interface OrgForView {
  estimate_terms: string;
  estimate_notes: string;
  estimate_payment_terms: string;
}

/** The bold first line and the rest, as every surface splits a line-item description. */
export function splitDescription(description: string): { title: string; detail: string | null } {
  const parts = description.split('\n');
  const detail = parts.slice(1).join('\n');
  return { title: parts[0] ?? '', detail: detail.length > 0 ? detail : null };
}

export function buildEstimateDocumentView(
  estimate: EstimateForView,
  org: OrgForView,
): EstimateDocumentView {
  // #2089 - one lock verdict for the whole document; every row stamps the same value.
  const locked = areSelectionsLocked(estimate);
  const lineRows: DocumentRow[] = estimate.line_items.map((li, i) => {
    const { title, detail } = splitDescription(li.description);
    const counts = countsTowardTotals(li);
    // An optional row is priced exactly like any other, discount and all: the figure it prints is
    // what the customer would pay if they took it, which is the whole point of showing it. It is
    // kept out of the SUMMARY of discounts below, because that row is a subtraction from this
    // document's Subtotal and an add-on the customer has not taken was never in it.
    const discounted = Number(li.discount_amount) > 0;
    return {
      kind: 'line_item',
      key: li.id ?? `line-${i}`,
      title,
      detail,
      itemType: li.item_type,
      quantity: Number(li.quantity),
      unitPrice: Number(li.unit_price),
      grossAmount: discounted ? Number(li.line_total) : null,
      netAmount: lineNetTotal(li),
      optional: li.is_optional === true,
      countsTowardTotals: counts,
      locked,
      discounted,
      discountType: discounted ? (li.discount_type ?? null) : null,
      discountValue: discounted && li.discount_type ? Number(li.discount_value) : null,
      discountAmount: discounted ? Number(li.discount_amount) : null,
      imageUrl: li.price_book_item?.image_url ?? null,
      photos: [],
    };
  });

  const photosByScope = new Map<string, DocumentPhoto[]>();
  for (const photo of estimate.scope_photos ?? []) {
    const bucket = photosByScope.get(photo.scope_id) ?? [];
    bucket.push({ id: photo.id, url: photo.url ?? '', caption: photo.caption ?? null });
    photosByScope.set(photo.scope_id, bucket);
  }

  // Scope blocks sit in the SAME list, right after the line items, so whatever a surface prints
  // above the totals is the literal sum of what the subtotal contains. An unpriced block carries
  // no amount to reconcile.
  const scopes = asScopeArray(estimate.scopes);
  const scopeRows: DocumentRow[] = scopes.map((scope) => {
    const counts = countsTowardTotals(scope);
    return {
    kind: 'scope',
    key: scope.id,
    title: scope.title,
    detail: scope.body || null,
    itemType: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    netAmount: scope.flat_price != null ? Number(scope.flat_price) : null,
    optional: scope.is_optional === true,
    countsTowardTotals: counts,
    locked,
    discounted: false,
    discountType: null,
    discountValue: null,
    discountAmount: null,
    imageUrl: null,
    photos: photosByScope.get(scope.id) ?? [],
    };
  });

  // Only the discounts that actually came off this document's Subtotal. An unselected add-on's
  // discount was never in it, so subtracting it here would claim a saving the customer is not
  // getting — the same reason the row itself prints no amount.
  const lineDiscountTotal = round2(
    estimate.line_items
      .filter((li) => countsTowardTotals(li))
      .reduce((sum, li) => sum + (Number(li.discount_amount) || 0), 0),
  );

  const totals: TotalsRow[] = [
    { kind: 'subtotal', label: 'Subtotal', amount: Number(estimate.subtotal), negative: false },
    ...(lineDiscountTotal > 0
      ? [{ kind: 'line_discounts' as const, label: 'Line Discounts', amount: lineDiscountTotal, negative: true }]
      : []),
    // The document-level discount sits between subtotal and tax, matching the order
    // calculateTotals applies it in. Without this row Subtotal + Tax visibly disagrees with Total.
    ...(hasDocDiscount(estimate)
      ? [{
          kind: 'discount' as const,
          label: estimate.discount_name || 'Discount',
          amount: Number(estimate.discount_amount),
          negative: true,
        }]
      : []),
    { kind: 'tax', label: 'Tax', amount: Number(estimate.tax_amount), negative: false },
    { kind: 'total', label: 'Total', amount: Number(estimate.total_amount), negative: false },
  ];

  return {
    number: estimate.estimate_number,
    createdAt: estimate.created_at,
    status: estimate.status,
    scopeNotes: estimate.scope_notes?.trim() ? estimate.scope_notes : null,
    rows: [...lineRows, ...scopeRows],
    hasLineItems: lineRows.length > 0,
    hasScopes: scopeRows.length > 0,
    totals,
    terms: pickContent(estimate.snapshot_terms, org.estimate_terms, estimate.status),
    notes: pickContent(estimate.snapshot_notes, org.estimate_notes, estimate.status),
    paymentTerms: pickContent(estimate.snapshot_payment_terms, org.estimate_payment_terms, estimate.status),
    signature: estimate.signature_data
      ? { data: estimate.signature_data, at: estimate.signature_at }
      : null,
    taxRate: Number(estimate.tax_rate),
  };
}

/**
 * Which sections the document prints, in order, and whether each is headed. #2028 slice 3, Ran's
 * rule: an estimate with only a scope of work prints no line-item structure; one with only line
 * items prints no scope section; one with both prints two distinct sections, each under its own
 * heading. A LONE section is printed bare — `title` is null — because a heading over the whole
 * document tells the reader nothing they cannot already see.
 *
 * Scope of work comes FIRST: it describes the job the line items then price, and the narrative
 * paragraph has always sat above the priced list on every surface, so leading with it moves
 * nothing the customer already reads at the top.
 *
 * Deliberately a function OF a model rather than a field ON one: an estimate version freezes the
 * model as JSON (#2030), and a version persisted before this slice existed carries no sections
 * field. Derived, a frozen document sections exactly like a freshly built one, with no migration.
 */
export function documentSections(
  model: { scopeNotes: string | null; rows: DocumentRow[] },
): DocumentSection[] {
  const scopeRows = model.rows.filter((r) => r.kind === 'scope');
  const lineRows = model.rows.filter((r) => r.kind === 'line_item');
  const sections: DocumentSection[] = [];
  if (model.scopeNotes || scopeRows.length > 0) {
    sections.push({ kind: 'scope', title: 'Scope of Work', notes: model.scopeNotes, rows: scopeRows });
  }
  if (lineRows.length > 0) {
    sections.push({ kind: 'line_items', title: 'Line Items', notes: null, rows: lineRows });
  }
  // A heading only earns its place when it tells the reader WHICH of two sections they are
  // looking at. Over a lone section it restates the document, so a single-section document
  // prints its content bare and every surface inherits that from here rather than gating for
  // itself. Symmetric on purpose (Ran, 2026-09-13, after reviewing the rendered PDFs): a
  // scope-only document loses "Scope of Work" exactly as a line-items-only one loses
  // "Line Items".
  if (sections.length < 2) return sections.map((section) => ({ ...section, title: null }));
  return sections;
}

// ─── #2090 - what the customer chose, and what they turned down ───────────────────────────────

export interface OptionSummary {
  /** Add-ons that ARE in this document's price, named as the document names them. */
  chosen: string[];
  /** Add-ons that are offered and not taken. */
  declined: string[];
}

/**
 * Split a built document's rows into the two lists a notification or an email names.
 *
 * Reads the row's own `optional` / `countsTowardTotals`, which is the same pair a surface reads to
 * mark a row, and the row's own `title`. So whatever the PDF prints beside "Optional (not
 * included)" is exactly what the email calls declined, by construction rather than by agreement.
 */
export function summariseDocumentOptions(
  rows: Pick<DocumentRow, 'title' | 'optional' | 'countsTowardTotals'>[],
): OptionSummary {
  return {
    chosen: rows.filter((r) => r.optional && r.countsTowardTotals).map((r) => r.title),
    declined: rows.filter((r) => r.optional && !r.countsTowardTotals).map((r) => r.title),
  };
}

/**
 * The same summary from the RAW rows, for a caller that has no reason to build a whole document
 * view (an approval notification needs two lists of names, not a rendered document).
 *
 * It is not a second derivation: the title comes from this file's own `splitDescription` and the
 * membership from `countsTowardTotals`, which are the two things `buildEstimateDocumentView` uses
 * to build a row's identity. `estimate-document-projection.test.ts` pins that the two agree.
 */
export function summariseEstimateOptions(estimate: {
  line_items?: Array<{ description: string; is_optional?: boolean | null; is_selected?: boolean | null }> | null;
  scopes?: unknown;
}): OptionSummary {
  return summariseDocumentOptions([
    ...(estimate.line_items ?? []).map((li) => ({
      title: splitDescription(li.description).title,
      optional: li.is_optional === true,
      countsTowardTotals: countsTowardTotals(li),
    })),
    ...asScopeArray(estimate.scopes).map((sc) => ({
      title: sc.title,
      optional: sc.is_optional === true,
      countsTowardTotals: countsTowardTotals(sc),
    })),
  ]);
}
