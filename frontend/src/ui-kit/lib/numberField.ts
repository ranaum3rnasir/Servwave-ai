/* =============================================================================
   Money and quantity fields (mobile slice 37, rubric KB-04).

   A number field is never `<input type="number">`: that input spins under the
   mouse wheel (a focused amount changes while the page scrolls), draws a
   spinner, and on a phone opens a keyboard without the decimal point. The
   number kinds in src/ui-kit/lib/fieldKind.ts are text inputs instead:

     money     -> decimal keypad   (an amount of money)
     quantity  -> decimal keypad   (a quantity that can be fractional: 1.5 h)
     percent   -> decimal keypad   (a rate or share in percent)
     count     -> numeric keypad   (a whole number: days, units on a shelf)

   The kit Input and the legacy Input do the rest from `kind` alone (see
   useNumberField.ts): they keep what is typed to digits and one point, keep a
   half-typed "12." on screen, and keep min / max / step as the field's
   validity. This file holds the pure rules they use:

     parseNumberField  text (or a number) -> a number, or null for nothing
     cleanNumberText   what a keystroke or a paste leaves in the box
     numberFieldError  the number input's own min / max / step checks

   The source guard src/__tests__/input-guards/number-field.guard.test.ts
   rejects a raw number input anywhere in the app.
   ============================================================================= */

export const NUMBER_KINDS = ['money', 'quantity', 'percent', 'count'] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

export function isNumberKind(kind: unknown): kind is NumberKind {
  return typeof kind === 'string' && (NUMBER_KINDS as readonly string[]).includes(kind);
}

export interface NumberOptions {
  /** Whether a negative number is a valid value. Default false. */
  allowNegative?: boolean;
  /**
   * The decimal separator people type: "." (default) or "," where the phone's
   * region writes 12,50. A phone's decimal keypad types its region's separator,
   * so with "," the comma is the point and a "." is a thousands separator.
   */
  decimalSeparator?: '.' | ',';
}

/** "1.234,5" -> "1,234.5": a comma-decimal text in the "." form the rules below read. */
function toPointDecimal(text: string, decimalSeparator: '.' | ','): string {
  return decimalSeparator === ',' ? text.replace(/[.,]/g, (c) => (c === ',' ? '.' : ',')) : text;
}

/** The decimal separator of the browser's region ("." when it cannot tell). */
export function localeDecimalSeparator(locale?: string): '.' | ',' {
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal');
    return part?.value === ',' ? ',' : '.';
  } catch {
    return '.';
  }
}

/** A plain number as text: optional minus, digits with at most one point. */
const PLAIN = /^-?(\d+\.?\d*|\.\d+)$/;
const WHOLE = /^-?\d+$/;
/** Commas only as thousands separators: 1,234 or 1,234,567.89 (never 12,5). */
const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d*)?$/;

/**
 * A number, or null for nothing. Reads what a person types or pastes: a blank
 * is null (not zero), thousands commas are read, a comma that is not a
 * thousands separator is refused (12,5 is never guessed into 125 or 12.5), a
 * `$` on money and a `%` on percent are read through, a count is a whole
 * number, and a negative is null unless allowed.
 */
export function parseNumberField(
  input: string | number | null | undefined,
  kind: NumberKind,
  { allowNegative = false, decimalSeparator = '.' }: NumberOptions = {},
): number | null {
  let n: number;
  if (input == null) return null;
  if (typeof input === 'number') {
    n = input;
  } else {
    let s = toPointDecimal(input.trim(), decimalSeparator);
    if (kind === 'money') s = s.replace(/^(-?)\$/, '$1');
    if (kind === 'percent') s = s.replace(/%$/, '');
    if (s.includes(',')) {
      if (!GROUPED.test(s)) return null;
      s = s.replace(/,/g, '');
    }
    if (!(kind === 'count' ? WHOLE : PLAIN).test(s)) return null;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return null;
  if (kind === 'count' && !Number.isInteger(n)) return null;
  if (n < 0 && !allowNegative) return null;
  return n === 0 ? 0 : n; // never -0
}

/**
 * What a keystroke or a paste leaves in the box: digits, one decimal point and
 * a leading minus where negatives are allowed. Everything else, thousands
 * commas included, is dropped, so "1,250.50" becomes "1250.50", as a number
 * input took it. With decimalSeparator "," a typed comma becomes the point:
 * "12,50" becomes "12.50". The box always holds a "." point (what callers
 * read), and it is cleaned again on every keystroke, so a "." already in it is
 * kept as the point rather than read as a thousands mark.
 *
 * A count keeps a typed point too. Dropping it would turn a typed "1.5" into
 * "15", a different amount the person may not notice; a count's keypad has no
 * point, and on a keyboard "1.5" stays visible and fails the whole-number
 * check (numberFieldError), as it did on the number input.
 */
export function cleanNumberText(text: string, _kind: NumberKind, { allowNegative = false, decimalSeparator = '.' }: NumberOptions = {}): string {
  const negative = allowNegative && text.trimStart().startsWith('-');
  let body = (decimalSeparator === ',' ? text.replace(/,/g, '.') : text).replace(/[^\d.]/g, '');
  const point = body.indexOf('.');
  if (point !== -1) body = body.slice(0, point + 1) + body.slice(point + 1).replace(/\./g, '');
  return (negative ? '-' : '') + body;
}

/** True when the text is a complete number (not blank, ".", "-" or "-."). */
export function isCompleteNumber(text: string): boolean {
  return PLAIN.test(text);
}

export interface NumberLimits {
  min?: number | string;
  max?: number | string;
  step?: number | string;
}

function limit(v: number | string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The number input's own checks, kept for the text field: null when valid,
 * otherwise the message the browser shows if a form is submitted without
 * `noValidate`. A blank is valid (`required` is the form's business), and the
 * step counts from min, as the number input's did.
 */
export function numberFieldError(text: string, { min, max, step }: NumberLimits): string | null {
  if (text === '') return null;
  if (!isCompleteNumber(text)) return 'Enter a number.';
  const n = Number(text);
  const lo = limit(min);
  const hi = limit(max);
  if (lo !== null && n < lo) return `Enter ${lo} or more.`;
  if (hi !== null && n > hi) return `Enter ${hi} or less.`;
  const st = step === 'any' ? null : limit(step);
  if (st !== null && st > 0) {
    const steps = (n - (lo ?? 0)) / st;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return st === 1 ? 'Enter a whole number.' : `Use steps of ${st}.`;
  }
  return null;
}
