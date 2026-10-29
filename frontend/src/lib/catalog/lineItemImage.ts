/**
 * lineItemImage.ts — the ONE place a line row decides which of a linked catalog item's two
 * image columns it renders.
 *
 * A `PriceBookItem` stores its image in one of two columns, and both are legitimate storage
 * strategies rather than duplicates: a megabyte-capped text column that holds inline data URIs,
 * and a URL-validated short one. `backend/src/lib/catalog/item-resolution.ts` is the source of
 * truth for the precedence between them; this is its frontend mirror, and it must not drift —
 * `frontend/src/__tests__/estimate-line-image-survives-reload.test.tsx` pins the answer the two
 * have to agree on.
 *
 * Why a mirror rather than consuming a resolved answer off the wire, which is what the catalog
 * picker does (see `itemPresentation.ts`): a document line's `price_book_item` relation arrives
 * as the RAW columns on all three line surfaces (estimate, job, invoice), so the choice is
 * genuinely made here. What it replaces is worse — LineItemRow and EstimateLineItemsEditor each
 * made that choice for themselves, in the OPPOSITE order to the backend, so an item with both
 * columns populated rendered one picture on an estimate row and a different one everywhere else.
 * One shared answer for the three rows is the point; the shape of the answer is not negotiable
 * per surface.
 *
 * An empty or whitespace-only string is an ABSENCE, not an image — it is what a cleared form
 * control and a `''` default both write. Same rule as the backend's own `presentString`.
 */

/** The two columns a catalog item's image can live in. Both optional — a row may carry neither. */
export interface LineItemImageColumns {
  photo_url?: string | null;
  image_url?: string | null;
}

function presentString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length === 0 ? null : value;
}

/**
 * The image to render for a line's linked catalog item, or `null` for "no image".
 *
 * Takes the whole relation (which is itself nullable for an ad-hoc line) rather than two loose
 * columns, so a caller cannot half-apply it.
 */
export function resolveLineItemImage(item: LineItemImageColumns | null | undefined): string | null {
  if (!item) return null;
  return presentString(item.photo_url) ?? presentString(item.image_url);
}
