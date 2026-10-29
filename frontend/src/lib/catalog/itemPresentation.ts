/**
 * itemPresentation.ts — the ONE place the client reads a catalog item's money.
 *
 * Which of an item's two image columns and two price columns to read is decided
 * server-side, once, in `backend/src/lib/catalog/item-resolution.ts`; the answers
 * travel on the wire as `photoUrl` / `sellPrice` / `unitCost`, camelCase, with `null`
 * as the explicit absent state. Nothing here re-derives that choice — there is
 * deliberately no column precedence in this file, so there is nothing for it to drift
 * from, and a reader that reaches for the raw `unit_price` / `unit_cost` column instead
 * of these helpers is reintroducing the defect.
 *
 * (The picker's search endpoint projects with an explicit `select` that omits the
 * fallback columns outright, so a client-side resolution could never have worked
 * anyway: the data is not on the wire.)
 *
 * Four sites read an item's money and they must agree to the cent: the picker's item
 * card, the picker's footer running total, the line a host editor seeds when the
 * operator presses Add, and AddLineDialog's own search list and selected-item preview.
 * When they disagreed, the card promised $500.00, the footer said $0.00 and a $0.00 line
 * landed on the estimate.
 *
 * NO "No price" (Ran, 2026-09-18): `PriceBookItem.unit_price` is `Decimal(12,2)` NOT NULL
 * with no default and the create schema refuses a body carrying neither price column, so
 * an unpriced item is a state no row can reach. Every item has a price and `$0.00` IS a
 * price. An earlier revision of this file rendered the words "No price" for the absent
 * arm; that branch was unreachable and has been removed rather than left as dead copy.
 * The absent arm survives only in the types, for a projected or partial row.
 */

/**
 * The resolved money answers as a catalog payload carries them. Both optional: a caller
 * may still be handing a component a payload shaped before the resolution landed.
 */
export interface ResolvedCatalogItemMoney {
  sellPrice?: number | null;
  unitCost?: number | null;
}

/**
 * Every resolved answer a catalog-item payload carries — the wire mirror of the backend's
 * `resolvedCatalogItemFields`, field for field.
 *
 * Catalog-item types EXTEND this rather than re-declaring the three fields. Re-declaring
 * them per component is how this cluster's divergence started: a local type that listed
 * `image_url` and `unit_price` and omitted the answers made reading the raw column the
 * only thing the compiler would allow, and four surfaces drifted apart on the same row.
 * The entity types still differ from each other where they legitimately do (the search
 * endpoint's `category` shape, for one); the resolved answers are declared once, here.
 */
export interface ResolvedCatalogItemFields extends ResolvedCatalogItemMoney {
  /**
   * The image to render: an item's picture lives in `photo_url` OR `image_url` and the
   * backend decided which. `null` is the explicit "no image". Read this, never the raw
   * column — that choice belongs to the server and re-deriving it here is the defect.
   */
  photoUrl?: string | null;
}

/**
 * The selling price to show for a catalog item, and to seed a line with.
 *
 * INVARIANT the `0` fallback rests on: `unit_price` is NOT NULL, so the server-side
 * resolution always finds a price on a real row and this fallback is unreachable in
 * production — it exists to satisfy the type and to keep a projected or partial row from
 * rendering `NaN`. The same invariant and the same fallback are written down in
 * `inv-catalog.controller.ts`'s item mapper; if `unit_price` is ever made nullable, both
 * stop being unreachable and silently become the original defect. Revisit them together.
 */
export function catalogItemSellPrice(item: ResolvedCatalogItemMoney): number {
  return typeof item.sellPrice === 'number' && Number.isFinite(item.sellPrice) ? item.sellPrice : 0;
}

/**
 * The cost to seed a line with, or `null` for a genuinely uncosted item.
 *
 * Absence is NOT zero here and the two must never collapse: a cost of 0 against a real
 * price is a 100% margin, while an uncosted line is supposed to show an em dash. An item
 * with no cost, a malformed value and a cost the server stripped from the payload for a
 * reader without pricing permission all answer the same way — absent — so the caller
 * omits `unit_cost` from its payload rather than inventing a zero or forwarding a value
 * the backend would reject.
 */
export function catalogItemUnitCost(item: ResolvedCatalogItemMoney): number | null {
  return typeof item.unitCost === 'number' && Number.isFinite(item.unitCost) ? item.unitCost : null;
}

/**
 * The `unit_cost` fragment of a create-line payload: the cost when the item has one, and
 * nothing at all when it does not. Spread it — `...catalogItemCostPayload(item)`.
 */
export function catalogItemCostPayload(item: ResolvedCatalogItemMoney): { unit_cost?: number } {
  const cost = catalogItemUnitCost(item);
  return cost === null ? {} : { unit_cost: cost };
}
