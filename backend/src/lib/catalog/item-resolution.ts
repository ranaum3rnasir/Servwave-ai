/**
 * item-resolution.ts — the single source of truth for "which column does a reader
 * of a catalog item actually read?".
 *
 * A `PriceBookItem` carries two columns per concept. They are two storage
 * STRATEGIES, not duplicates, and both are legitimate:
 *
 *   image   `photo_url`   @db.Text          — megabyte-capped, holds inline data URIs
 *           `image_url`   @db.VarChar(500)  — URL-validated and short
 *   price   `sell_price`  Decimal?          — the inventory/catalog vocabulary
 *           `unit_price`  Decimal (NOT NULL)— the older column estimates and invoices read
 *
 * Writes land in one column and a reader that names the other sees nothing, which is
 * how the price-book picker came to show a grey placeholder and $0.00 for an item the
 * price book lists with a photo and a price. This module decides WHICH column to read.
 * It never copies one column into the other — that would collapse two deliberate
 * storage strategies into one and blow the VarChar(500) cap with a data URI.
 *
 * `Resolved<T>` carries an explicit absent state so a caller can tell "no price" from
 * "a price of zero". A genuine 0 is a price; `null`/`undefined`/`''` are absences.
 * Consumers print "$0.00" for both: no item can be unpriced (`unit_price` is NOT NULL and
 * the create schema refuses a body with neither price), so the absent arm is defence, not
 * a state any row reaches. The "No price" label this once described was deleted.
 *
 * Reach: the resolution runs server-side and the ANSWER travels on the wire, so a
 * frontend component consumes it as `photoUrl` / `sellPrice` off the API payload
 * rather than re-deriving the column precedence for itself. That is deliberate — the
 * picker's search endpoint projects with an explicit `select`, and a column it does not
 * name is not on the wire at all, so no client-side resolution could ever fix it. That
 * select names all four columns for exactly this reason; anything that resolves through
 * this module must project every column it reads. `resolvedCatalogItemFields` is the
 * wire projection of the answers.
 */

/**
 * A value that is present, or explicitly absent.
 *
 * The absent arm carries NO `value` on purpose. An earlier shape gave it `value: null`,
 * which made `.value` readable on both arms — and `if (resolveItemSellPrice(row).value)`
 * then compiles and silently treats a genuine 0 as absent, which is the exact defect this
 * module exists to prevent. With the narrow shape that read is a type error: a caller must
 * either check `present` first, or go through `valueOrNull` and compare against `null`
 * rather than testing truthiness.
 */
export type Resolved<T> = { present: true; value: T } | { present: false };

const ABSENT = { present: false } as const;

/**
 * The resolved value, or `null` when absent — the explicit unwrap for a caller that wants
 * one nullable field rather than a branch (a wire projection, a mapper).
 *
 * Compare the result against `null`. Do NOT test it for truthiness: `0` is a real price
 * and `''` never survives resolution, so `if (valueOrNull(p))` is wrong in the one case
 * this module exists to get right.
 */
export function valueOrNull<T>(resolved: Resolved<T>): T | null {
  return resolved.present ? resolved.value : null;
}

/** The two columns an item's image can live in. Both optional — a projected row may carry neither. */
export interface CatalogItemImageColumns {
  photo_url?: unknown;
  image_url?: unknown;
}

/** The two columns an item's selling price can live in. Both optional, for the same reason. */
export interface CatalogItemPriceColumns {
  sell_price?: unknown;
  unit_price?: unknown;
}

/**
 * The column an item's cost lives in. Only ONE, unlike image and price — cost is here not
 * because it is ambiguous but because every reader of an item's money should go through one
 * module. `Number()` on the raw column mints a confident 0 out of an empty or malformed
 * value, and a 0 cost against a real price is a 100% margin where an uncosted line is
 * supposed to show an em dash. (`list_price` is the vendor's list price, a different
 * concept, and is deliberately not a fallback for this one.)
 */
export interface CatalogItemCostColumns {
  unit_cost?: unknown;
}

/**
 * A non-empty string, or absent. An empty string is an absence: it is what a cleared
 * form control and a `''` default both write, and neither is an image.
 */
function presentString(value: unknown): Resolved<string> {
  if (typeof value !== 'string') return ABSENT;
  const trimmed = value.trim();
  return trimmed.length === 0 ? ABSENT : { present: true, value };
}

/**
 * A finite number, or absent. Accepts a Prisma `Decimal` (unwrapped via `toNumber()`)
 * and a numeric string, which is how Decimal columns arrive through some serialisers.
 * `''` is an absence, NOT a zero — `Number('')` is 0, and silently minting a $0.00
 * price out of an empty column is the defect this module exists to stop.
 */
function presentNumber(value: unknown): Resolved<number> {
  if (value == null) return ABSENT;
  if (typeof value === 'number') return Number.isFinite(value) ? { present: true, value } : ABSENT;

  const decimal = value as { toNumber?: () => number };
  if (typeof decimal.toNumber === 'function') {
    const num = decimal.toNumber();
    return Number.isFinite(num) ? { present: true, value: num } : ABSENT;
  }

  if (typeof value === 'string') {
    if (value.trim().length === 0) return ABSENT;
    const num = Number(value);
    return Number.isFinite(num) ? { present: true, value: num } : ABSENT;
  }

  return ABSENT;
}

/** The image to render for a catalog item, or an explicit "no image". */
export function resolveItemImage(row: CatalogItemImageColumns): Resolved<string> {
  const canonical = presentString(row.photo_url);
  return canonical.present ? canonical : presentString(row.image_url);
}

/** The selling price of a catalog item, or an explicit "unpriced". Zero is a price. */
export function resolveItemSellPrice(row: CatalogItemPriceColumns): Resolved<number> {
  const canonical = presentNumber(row.sell_price);
  return canonical.present ? canonical : presentNumber(row.unit_price);
}

/** The cost of a catalog item, or an explicit "uncosted". Zero is a cost. */
export function resolveItemCost(row: CatalogItemCostColumns): Resolved<number> {
  return presentNumber(row.unit_cost);
}

/**
 * The wire projection every catalog-item payload carries alongside its raw columns:
 * one resolved answer per concept, with `null` as the explicit absent state.
 *
 * `photoUrl` / `sellPrice` / `unitCost` are deliberately camelCase — they are ANSWERS, not
 * columns, and they must not be mistaken for `photo_url` / `sell_price` / `unit_cost` by a
 * reader who then reintroduces the same fallback bug one layer up.
 *
 * `unitCost` is cost data: a caller that strips cost for a reader without pricing permission
 * must strip this answer too, or the strip leaks straight back through the projection.
 */
export function resolvedCatalogItemFields(
  row: CatalogItemImageColumns & CatalogItemPriceColumns & CatalogItemCostColumns,
): { photoUrl: string | null; sellPrice: number | null; unitCost: number | null } {
  return {
    photoUrl: valueOrNull(resolveItemImage(row)),
    sellPrice: valueOrNull(resolveItemSellPrice(row)),
    unitCost: valueOrNull(resolveItemCost(row)),
  };
}
