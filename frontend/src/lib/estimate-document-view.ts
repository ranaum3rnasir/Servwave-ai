/**
 * The estimate document VIEW-MODEL — frontend half (#2028 slice 2).
 *
 * A deliberate line-for-line MIRROR of `backend/src/lib/estimate-document-view.ts`. Frontend
 * cannot import backend code, so this is a manually-kept-in-sync duplicate, not a re-export —
 * the same pattern `lib/deposit.ts` and `constants/estimateStatus.ts` document. **If the backend
 * module changes, change this one too**, and vice versa: the backend one decides what the PDF
 * says and this one decides what the web page says, so any divergence puts a different document
 * in front of the customer depending on which one they open. That divergence is the whole reason
 * #2028 exists.
 *
 * Nothing here knows about the DOM. Which sections exist, how a priced versus unpriced scope
 * block is presented, how discounts are summarised and what the totals rows are: those decisions
 * live here, and `EstimateDocumentView` is left with layout.
 */
import { countsTowardTotals } from '@/components/jobs/items/money';

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
  /** The pre-discount figure, struck through beside `netAmount` when `discounted`. */
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
   * #2053 — whether this row's money is inside the document's own Subtotal. The same predicate
   * the server accumulates on (`countsTowardTotals`, mirrored in `components/jobs/items/money.ts`
   * from `backend/src/lib/invoice-totals.ts`) — never re-implemented here.
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
   * How the line's OWN discount was expressed — 'PERCENTAGE' with a rate, or a fixed amount —
   * so a surface can caption it ("Discount: 10% (-$50.00)"). Null when the line carries a
   * discount amount but no type, which legacy rows do: the amount still shows as the struck
   * through gross, but there is nothing truthful to say about how it was worked out.
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

export interface DocumentInput {
  scopeNotes?: string | null;
  lineItems: Array<{
    id?: string;
    description: string;
    item_type?: string;
    quantity: number | string;
    unit_price: number | string;
    line_total: number | string;
    discount_amount?: number | string | null;
    discount_type?: string | null;
    discount_value?: number | string | null;
    price_book_item?: { image_url?: string | null } | null;
    // #2053 — absent on every pre-migration row; `countsTowardTotals` reads an absent pair as
    // "counts", which is the unconditional-sum behaviour that predates the feature.
    is_optional?: boolean | null;
    is_selected?: boolean | null;
  }>;
  scopes?: Array<{ id: string; title: string; body?: string | null; flat_price?: number | string | null; is_optional?: boolean | null; is_selected?: boolean | null }>;
  /**
   * The estimate's scope photos, FLAT — the server has no relational row per scope block to nest
   * them under (scopes is a JSONB array), so they arrive as one list carrying `scope_id` and are
   * grouped here, once, rather than by each surface.
   */
  scopePhotos?: Array<{ id: string; scope_id: string; url: string; caption?: string | null }>;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  discountName?: string | null;
  discountAmount?: number | string | null;
  /**
   * #2089 - whether this document's selections are LOCKED, threaded straight through rather than
   * recomputed here: the caller already has the estimate's `status`/`invoices` and, on the public
   * page, already runs `areSelectionsLocked` over them for its own separate Optional add-ons
   * section (#2090). Defaults to false, which is every existing caller's unchanged behaviour.
   */
  locked?: boolean;
}

export interface EstimateDocumentModel {
  scopeNotes: string | null;
  rows: DocumentRow[];
  hasLineItems: boolean;
  hasScopes: boolean;
  totals: TotalsRow[];
}

/**
 * The customer-facing copy for an optional add-on — the same two strings the backend half carries
 * for the PDF templates, so the page and the attachment say the same thing about the same row.
 * Ran can reword either without reading a renderer.
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

/** Cents-rounded. Floats are not money. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The bold first line and the rest, as every surface splits a line-item description. */
function splitDescription(description: string): { title: string; detail: string | null } {
  const parts = description.split('\n');
  const detail = parts.slice(1).join('\n');
  return { title: parts[0] ?? '', detail: detail.length > 0 ? detail : null };
}

export function buildEstimateDocumentModel(input: DocumentInput): EstimateDocumentModel {
  // #2089 - one lock verdict for the whole document; every row stamps the same value.
  const locked = input.locked === true;
  const lineRows: DocumentRow[] = input.lineItems.map((li, i) => {
    const { title, detail } = splitDescription(li.description);
    const counts = countsTowardTotals(li);
    const discount = num(li.discount_amount);
    // An optional row is priced exactly like any other, discount and all: the figure it prints is
    // what the customer would pay if they took it, which is the whole point of showing it. It is
    // kept out of the SUMMARY of discounts below, because that row is a subtraction from this
    // document's Subtotal and an add-on the customer has not taken was never in it.
    const discounted = discount > 0;
    // The GROSS figure is quantity × unit_price. `line_total` is stored pre-discount, so the net
    // is what this row actually costs.
    const gross = round2(num(li.quantity) * num(li.unit_price));
    return {
      kind: 'line_item',
      key: li.id ?? `line-${i}`,
      title,
      detail,
      itemType: li.item_type ?? 'SERVICE',
      quantity: num(li.quantity),
      unitPrice: num(li.unit_price),
      grossAmount: discounted ? gross : null,
      netAmount: discounted ? round2(gross - discount) : num(li.line_total),
      optional: li.is_optional === true,
      countsTowardTotals: counts,
      locked,
      discounted,
      discountType: discounted ? (li.discount_type ?? null) : null,
      discountValue: discounted && li.discount_type ? num(li.discount_value) : null,
      discountAmount: discounted ? discount : null,
      imageUrl: li.price_book_item?.image_url ?? null,
      photos: [],
    };
  });

  const photosByScope = new Map<string, DocumentPhoto[]>();
  for (const photo of input.scopePhotos ?? []) {
    const bucket = photosByScope.get(photo.scope_id) ?? [];
    bucket.push({ id: photo.id, url: photo.url, caption: photo.caption ?? null });
    photosByScope.set(photo.scope_id, bucket);
  }

  // Scope blocks sit in the SAME list, right after the line items, so whatever is printed above
  // the totals is the literal sum of what the subtotal contains.
  const scopeRows: DocumentRow[] = (input.scopes ?? []).map((scope) => {
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
    netAmount: scope.flat_price != null ? num(scope.flat_price) : null,
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
    input.lineItems.filter((li) => countsTowardTotals(li)).reduce((sum, li) => sum + num(li.discount_amount), 0),
  );
  const docDiscount = num(input.discountAmount);

  const totals: TotalsRow[] = [
    { kind: 'subtotal', label: 'Subtotal', amount: input.subtotal, negative: false },
    ...(lineDiscountTotal > 0
      ? [{ kind: 'line_discounts' as const, label: 'Line Discounts', amount: lineDiscountTotal, negative: true }]
      : []),
    // The document-level discount sits between subtotal and tax, matching the order the server
    // applies it in. Without this row Subtotal + Tax visibly disagrees with Total.
    ...(docDiscount > 0
      ? [{ kind: 'discount' as const, label: input.discountName || 'Discount', amount: docDiscount, negative: true }]
      : []),
    { kind: 'tax', label: 'Tax', amount: input.taxAmount, negative: false },
    { kind: 'total', label: 'Total', amount: input.totalAmount, negative: false },
  ];

  return {
    scopeNotes: input.scopeNotes?.trim() ? input.scopeNotes : null,
    rows: [...lineRows, ...scopeRows],
    hasLineItems: lineRows.length > 0,
    hasScopes: scopeRows.length > 0,
    totals,
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
