import type { Request } from 'express';
import { canSeePrices } from './enforce';

/**
 * The price columns the price book writes, by model. This is the WRITE side of what the central filter leaves out of a read
 * (`omitPricesFromAnswers`, prices.ts): a person without See prices never receives these, so a form they save has none to send,
 * and a save must therefore leave the stored value exactly as it is (costs already work this way: `canSeeCosts`).
 *
 * Every save path that writes one of these columns goes through `pricesToSave` (or, for the group lines the save replaces,
 * `lineValuesToSave` in the price-book controller). The table is checked against the schema and the filter's own price words in
 * permission-price-writes-db.test.ts: a new price column on one of these models fails the build until it is listed here and handled.
 */
export const PRICE_BOOK_PRICE_COLUMNS = {
  PriceBookItem: ['unit_price', 'sell_price', 'list_price'],
  ItemGroup: ['flat_rate_price_override'],
  ItemGroupLine: ['price_override'],
} as const satisfies Record<string, readonly string[]>;

export type PriceBookModel = keyof typeof PRICE_BOOK_PRICE_COLUMNS;

/**
 * The price columns of `model` to write: the values given when the saver has See prices, nothing at all when not (so an update
 * leaves the stored prices alone, and a create starts without them). A column outside the table is a programming error.
 */
export function pricesToSave<T extends Record<string, unknown>>(req: Request, model: PriceBookModel, values: T): Partial<T> {
  const known: readonly string[] = PRICE_BOOK_PRICE_COLUMNS[model];
  for (const key of Object.keys(values)) {
    if (!known.includes(key)) throw new Error(`${key} is not a price column of ${model}; list it in PRICE_BOOK_PRICE_COLUMNS`);
  }
  return canSeePrices(req) ? { ...values } : {};
}

/** Remove the price columns of `model` from an incoming body when the saver lacks See prices (so nothing downstream can write them). */
export function dropPriceColumns(req: Request, model: PriceBookModel, body: Record<string, unknown>): void {
  if (canSeePrices(req)) return;
  for (const key of PRICE_BOOK_PRICE_COLUMNS[model]) delete body[key];
}
