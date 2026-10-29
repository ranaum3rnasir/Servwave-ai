/**
 * profitability.ts — the one calculator behind every margin / markup display.
 *
 * Given a cost and a price it answers three things: the margin, the markup, and
 * the STATE the pair is in. The state is the point of the module: every display
 * branches on it instead of inventing its own null-guard, which is how the
 * product ended up spelling one idea five ways and rendering a non-number where
 * a percentage belonged.
 *
 *   margin = (price - cost) / price × 100   — what share of the price is profit
 *   markup = (price - cost) / cost  × 100   — how much was added on top of cost
 *
 * Two guarantees every consumer may rely on:
 *
 *   1. No returned figure is ever non-finite. A figure is a real number or null.
 *   2. State 'normal' ALWAYS carries two real numbers. If the arithmetic cannot
 *      produce them - a cost so small that the markup overflows, say - the pair
 *      is reported as a bad cost, never as a normal one with a hole in it.
 *
 * Nothing here caps or clamps. Margin cannot exceed 100% because of its own
 * arithmetic (a usable cost is never negative), and markup is deliberately
 * unbounded — a $0.01 part sold for $1,000 really is a 9,999,900% markup.
 */

export type ProfitabilityState =
  /** A usable cost and a usable price: both figures are real numbers. */
  | 'normal'
  /** A cost was entered, and it is zero. Margin is real (100%); markup has no base. */
  | 'zero-cost'
  /** No cost was ever entered. Neither figure exists — show an em dash, never 100%. */
  | 'uncosted'
  /** A cost WAS entered and it cannot be used: negative, or too small to divide by. */
  | 'invalid-cost'
  /** The price is missing, zero, negative or not a number. Nothing can be divided by it. */
  | 'invalid-price';

export interface Profitability {
  state: ProfitabilityState;
  /** Share of the PRICE that is profit. Non-null only for 'normal' and 'zero-cost'. */
  marginPercent: number | null;
  /** How much was added on top of COST. Uncapped by design. Non-null only for 'normal'. */
  markupPercent: number | null;
}

/** What every display shows in place of a figure it does not have. */
export const NO_FIGURE = '—';

/**
 * The one sentence each state is allowed to say. Shown as the qualifying
 * caption, so a zero-cost 100% is never presented bare, an em dash always tells
 * the operator what would fill it in, and a bad cost is never described as a
 * missing one — the operator can see the bad value sitting in the field.
 */
export const PROFITABILITY_NOTE: Record<ProfitabilityState, string | null> = {
  normal: null,
  'zero-cost':
    'Unit cost is entered as zero, so the whole price counts as margin. Markup needs a cost above zero.',
  uncosted: 'Add a unit cost to see margin and markup.',
  'invalid-cost': 'Unit cost is not a usable amount, so margin and markup cannot be shown.',
  'invalid-price': 'Enter a sell price above zero to see margin and markup.',
};

/**
 * A value is a real entry only if it parses to a finite number. An empty
 * string, whitespace, null, undefined, "abc" and Infinity are all "never
 * entered" — but the string "0" is an entry, which is exactly what a
 * truthiness check gets wrong.
 */
function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function calculateProfitability(
  cost: number | string | null | undefined,
  price: number | string | null | undefined,
): Profitability {
  const none = { marginPercent: null, markupPercent: null };

  const p = toFiniteNumber(price);
  if (p === null || p <= 0) return { state: 'invalid-price', ...none };

  const c = toFiniteNumber(cost);
  if (c === null) return { state: 'uncosted', ...none };

  // A negative cost is a data error, NOT an absence: the operator can see the
  // value in the field, so telling them to "add a unit cost" would be nonsense.
  if (c < 0) return { state: 'invalid-cost', ...none };

  if (c === 0) {
    // The whole price is profit. Markup has nothing to be a percentage OF.
    return { state: 'zero-cost', marginPercent: 100, markupPercent: null };
  }

  const profit = p - c;
  const marginPercent = (profit / p) * 100;
  const markupPercent = (profit / c) * 100;

  // A cost can be positive and still too small to divide by (1e-320 overflows
  // the markup to Infinity). Guarantee 2: that is a cost we cannot use, not a
  // 'normal' pair carrying a number nobody can render.
  if (!Number.isFinite(marginPercent) || !Number.isFinite(markupPercent)) {
    return { state: 'invalid-cost', ...none };
  }

  return { state: 'normal', marginPercent, markupPercent };
}

/**
 * The one spelling of a profitability percentage: a whole number, grouped, with
 * a trailing "%", or the em dash when there is no figure. No ceiling is applied.
 */
export function formatProfitabilityPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_FIGURE;
  return `${Math.round(value).toLocaleString('en-US')}%`;
}
