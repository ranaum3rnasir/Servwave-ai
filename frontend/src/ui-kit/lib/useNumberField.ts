/* =============================================================================
   The number kinds' behaviour inside the kit and legacy Input (mobile slice 37).

   With `kind` money / quantity / percent / count the Input is a text input
   (src/ui-kit/lib/fieldKind.ts), and this hook makes it behave like the
   number input it replaces, for every caller, without the caller changing:

   - What is typed or pasted is cleaned to digits, one point and a leading
     minus (numberField.ts cleanNumberText). Thousands commas are dropped, so
     "1,250.50" reaches the caller as "1250.50" (in a region that writes
     12,50 the comma is the point instead). A minus is kept even where
     min is 0, so the caller's own "must not be negative" message still shows.
   - The caller's onChange sees the value a number input reported: the clean
     text when it is a complete number, and "" for a half-typed "." or "-".
   - A half-typed number stays on screen. A caller that holds a NUMBER turns
     "12." into 12; the box keeps showing "12." while the caller's value is
     still that number (the same rule React applies to a number input).
   - min / max / step are not rendered (they mean nothing on a text input);
     they become the field's validity (numberFieldError), so a form that
     relied on the browser's own check still refuses the same values.
   - `onValueChange` (optional) hands over the parsed number, or null.

   For any other kind the props pass through untouched.
   ============================================================================= */
import * as React from 'react';

import type { FieldKind } from './fieldKind';
import { cleanNumberText, isCompleteNumber, isNumberKind, localeDecimalSeparator, numberFieldError, parseNumberField } from './numberField';

export interface NumberFieldProps {
  value?: React.InputHTMLAttributes<HTMLInputElement>['value'];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  /** Number kinds only: the parsed number on every change, or null for nothing. */
  onValueChange?: (value: number | null) => void;
}

/** The number a box's text stands for, or null (blank, ".", "-"). */
/**
 * What the decimal key types on this device: a phone in a region that writes
 * 12,50 types a comma, which is then the point (and "." a thousands mark).
 */
const DECIMAL_SEPARATOR = localeDecimalSeparator();

function numberOf(text: string): number | null {
  return isCompleteNumber(text) ? Number(text) : null;
}

function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
}

export function useNumberField(
  kind: FieldKind | undefined,
  { value, onChange, onBlur, min, max, step, onValueChange }: NumberFieldProps,
  ref: React.Ref<HTMLInputElement> | undefined,
) {
  const numeric = isNumberKind(kind);
  const node = React.useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const setRef = React.useCallback(
    (el: HTMLInputElement | null) => {
      node.current = el;
      assignRef(ref, el);
    },
    [ref],
  );

  // min / max / step as validity: what the number input checked on submit.
  React.useLayoutEffect(() => {
    const el = node.current;
    if (!numeric || !el) return;
    // A count is whole unless the caller names its own step (the number
    // input's implicit step was 1 as well).
    el.setCustomValidity(numberFieldError(el.value, { min, max, step: step ?? (kind === 'count' ? 1 : undefined) }) ?? '');
  });

  if (!numeric) return { value, onChange, onBlur, min, max, step, ref };

  // A typed minus always stays in the box, as on the number input: callers
  // explain a negative ("must be a non-negative number") rather than having
  // it silently flipped into a positive amount, and min marks it invalid.
  // Only the parsed number (onValueChange) follows min.
  const options = { allowNegative: true, decimalSeparator: DECIMAL_SEPARATOR };
  const parsing = { allowNegative: min === undefined || min === '' || Number(min) < 0, decimalSeparator: '.' as const };

  let shown = value;
  if (value !== undefined) {
    const outer = value == null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value);
    shown = draft !== null && numberOf(draft) === numberOf(outer) ? draft : outer;
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const raw = el.value;
    const clean = cleanNumberText(raw, kind, options);
    const reported = isCompleteNumber(clean) ? clean : '';
    const caret = el.selectionStart;
    setDraft(clean);
    // The caller reads e.target.value: give it what a number input reported,
    // then put the clean text back in the box.
    if (reported !== raw) el.value = reported;
    onChange?.(e);
    if (el.value !== clean) el.value = clean;
    if (clean !== raw && caret !== null) {
      const at = cleanNumberText(raw.slice(0, caret), kind, options).length;
      el.setSelectionRange(at, at);
    }
    onValueChange?.(parseNumberField(clean, kind, parsing));
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // A half-typed "." or "-" left behind is nothing: clear it.
    const el = e.currentTarget;
    if (el.value !== '' && !isCompleteNumber(el.value)) el.value = '';
    setDraft(null);
    onBlur?.(e);
  };

  return {
    value: shown,
    onChange: handleChange,
    onBlur: handleBlur,
    min: undefined,
    max: undefined,
    step: undefined,
    ref: setRef,
  };
}
