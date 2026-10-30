import type { Request, Response } from 'express';
import type { Subject } from './catalog';

/**
 * The server check behind the "Apply discounts" switch: every write that sets or changes a discount
 * on an estimate or an invoice needs it, and every other edit is left alone.
 *
 * "Sets or changes" is judged against what is stored, never by whether a discount field is merely
 * present in the request: the edit forms send a line's whole shape, and a plain quantity edit that
 * echoes the line's unchanged discount back must not be refused. A field left out of the request
 * keeps its stored value.
 */

export const DISCOUNT_REFUSAL = 'You do not have permission to apply discounts.';

type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';

/** The discount fields of a request body. */
export interface DiscountFields {
  discount_type?: DiscountType | null;
  discount_value?: unknown;
}

/** The discount fields of a stored row. */
export interface StoredDiscount {
  discount_type: DiscountType | null;
  discount_value: unknown;
}

/** A comparable form of the discount a type and value stand for; '' when there is none. */
function signature(type: DiscountType | null | undefined, value: unknown): string {
  const amount = value == null ? 0 : Number(value);
  return type && amount > 0 ? `${type}:${amount}` : '';
}

/** Would writing `incoming` over `stored` (null for a row that does not exist yet) set or change the discount? */
export function changesDiscount(incoming: DiscountFields, stored: StoredDiscount | null): boolean {
  const type = incoming.discount_type !== undefined ? incoming.discount_type : stored?.discount_type;
  const value = incoming.discount_value !== undefined ? incoming.discount_value : stored?.discount_value;
  return signature(type, value) !== signature(stored?.discount_type, stored?.discount_value);
}

/**
 * Would replacing a document's whole list of lines change the discounts the stored lines carry?
 * The replacement carries no line ids, so the lists are compared as sets of discounts, in any order.
 */
export function changesLineDiscounts(incoming: DiscountFields[], stored: StoredDiscount[]): boolean {
  const asSet = (rows: DiscountFields[]) =>
    rows.map((r) => signature(r.discount_type, r.discount_value)).filter(Boolean).sort().join('|');
  return asSet(incoming) !== asSet(stored);
}

/** Would setting an invoice's billing discount to `incoming` (undefined = left out) change what is stored? */
export function changesInvoiceDiscount(incoming: number | undefined, stored: unknown): boolean {
  if (incoming === undefined) return false;
  return Math.round(incoming * 100) !== Math.round(Number(stored ?? 0) * 100);
}

/**
 * Answers 403 and returns true when the request changes a discount and the person lacks Apply
 * discounts; the caller returns. Returns false, writing nothing, in every other case.
 */
export function refusedForDiscount(
  req: Request,
  res: Response,
  subject: 'Estimate' | 'Invoice' | 'Job',
  changes: boolean,
): boolean {
  if (!changes) return false;
  if (req.ability?.can('apply_discount', subject as Subject)) return false;
  res.status(403).json({ error: DISCOUNT_REFUSAL });
  return true;
}
