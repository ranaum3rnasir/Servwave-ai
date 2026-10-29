/* =============================================================================
   Field kinds (mobile slice 23, rubric KB-03 and the search half of KB-05).

   A caller says WHAT a field holds, never which keyboard it needs:

     <Input kind="email" />            -> email type, email keyboard and autofill,
                                          no capitalisation, no spell-check
     <Input kind="postal-code" />      -> numeric keypad, postal-code autofill
     <input {...fieldKindProps('search')} />   (a raw field: same attributes)

   The kit Input and the legacy Input both take `kind`; SearchInput and the
   command-menu input default to `search`.

   Money, quantity, percent and count (slice 37) are text inputs with the
   decimal or numeric keypad, never number inputs: no spinner, and the mouse
   wheel never changes an amount. The kit and legacy Input also clean what is
   typed and keep min / max / step as validity for them; the rules are in
   src/ui-kit/lib/numberField.ts.

   Phone (slice 36) is a kind here, but callers never write `kind="phone"`:
   every phone field is a <PhoneInput> (src/ui-kit/components/form/phoneInput.tsx),
   which consumes this kind and also owns the value rules that keep a stored
   international number intact. Its extension box states `phone-extension`.

   Where staff record SOMEONE ELSE'S details (a customer's email, a vendor's
   address), pass `personalAutofill={false}`: the browser then does not offer
   the staff member's own name or address, while the type and keyboard stay
   right.

   Action key: only kinds that end what the user is doing name one (Search on
   a search field, Done on a one-time code). A field inside a form gets Next or
   Done from its position in that form (slice 38), not from its kind.

   The source guard src/__tests__/input-guards/field-kind.guard.test.ts keeps
   call sites on this function: no hand-set email/search type, keyboard mode or
   autofill token beside it.
   ============================================================================= */
import type * as React from 'react';

export const FIELD_KINDS = [
  'email',
  'search',
  'one-time-code',
  'name',
  'given-name',
  'family-name',
  'organization',
  'street',
  'address-line2',
  'city',
  'state',
  'postal-code',
  'phone',
  'phone-extension',
  'money',
  'quantity',
  'percent',
  'count',
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldKindAttributes {
  type: 'text' | 'email' | 'search' | 'tel';
  inputMode: 'text' | 'email' | 'search' | 'numeric' | 'decimal' | 'tel';
  autoComplete: string;
  autoCapitalize: 'none' | 'words' | 'characters';
  autoCorrect: 'on' | 'off';
  spellCheck: boolean;
  enterKeyHint: React.InputHTMLAttributes<HTMLInputElement>['enterKeyHint'];
}

export interface FieldKindOptions {
  /**
   * False where staff record a third party's details: the browser must not
   * offer the staff member's own email, name or address. Type and keyboard
   * are unchanged. Has no effect on search and one-time code.
   */
  personalAutofill?: boolean;
}

/** Plain words that are not personal data: capitalise nothing, correct nothing. */
const LITERAL = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;
/** A proper noun: capitalise each word, never "correct" it into a dictionary word. */
const PROPER_NOUN = { autoCapitalize: 'words', autoCorrect: 'off', spellCheck: false } as const;

const TABLE: Record<FieldKind, FieldKindAttributes & { personal: boolean }> = {
  email: { type: 'email', inputMode: 'email', autoComplete: 'email', ...LITERAL, enterKeyHint: undefined, personal: true },
  search: { type: 'search', inputMode: 'search', autoComplete: 'off', ...LITERAL, enterKeyHint: 'search', personal: false },
  'one-time-code': { type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code', ...LITERAL, enterKeyHint: 'done', personal: false },
  name: { type: 'text', inputMode: 'text', autoComplete: 'name', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  'given-name': { type: 'text', inputMode: 'text', autoComplete: 'given-name', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  'family-name': { type: 'text', inputMode: 'text', autoComplete: 'family-name', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  // A company name sits beside the person's name in the customer block.
  organization: { type: 'text', inputMode: 'text', autoComplete: 'organization', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  street: { type: 'text', inputMode: 'text', autoComplete: 'address-line1', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  'address-line2': { type: 'text', inputMode: 'text', autoComplete: 'address-line2', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  city: { type: 'text', inputMode: 'text', autoComplete: 'address-level2', ...PROPER_NOUN, enterKeyHint: undefined, personal: true },
  // Mostly a two-letter code (NJ): capitals, never corrected.
  state: { type: 'text', inputMode: 'text', autoComplete: 'address-level1', autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false, enterKeyHint: undefined, personal: true },
  // US ZIP codes: the numeric keypad. Still a text field, so a leading zero survives.
  'postal-code': { type: 'text', inputMode: 'numeric', autoComplete: 'postal-code', ...LITERAL, enterKeyHint: undefined, personal: true },
  // The telephone keypad (digits, +, *, #) and phone autofill. Only <PhoneInput> uses it.
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel', ...LITERAL, enterKeyHint: undefined, personal: true },
  // The extension box beside a phone number: digits only. A text field, so a leading zero survives.
  'phone-extension': { type: 'text', inputMode: 'numeric', autoComplete: 'tel-extension', ...LITERAL, enterKeyHint: undefined, personal: true },
  // Number kinds (slice 37): text inputs, so no spinner and no scroll-to-change.
  // The decimal keypad has the point; a count is whole, so it gets digits only.
  money: { type: 'text', inputMode: 'decimal', autoComplete: 'off', ...LITERAL, enterKeyHint: undefined, personal: false },
  quantity: { type: 'text', inputMode: 'decimal', autoComplete: 'off', ...LITERAL, enterKeyHint: undefined, personal: false },
  percent: { type: 'text', inputMode: 'decimal', autoComplete: 'off', ...LITERAL, enterKeyHint: undefined, personal: false },
  count: { type: 'text', inputMode: 'numeric', autoComplete: 'off', ...LITERAL, enterKeyHint: undefined, personal: false },
};

/** The input attributes for a field kind. Pure: same kind and options, same attributes. */
export function fieldKindAttributes(kind: FieldKind, options: FieldKindOptions = {}): FieldKindAttributes {
  const { personal, ...attrs } = TABLE[kind];
  if (personal && options.personalAutofill === false) return { ...attrs, autoComplete: 'off' };
  return attrs;
}

/**
 * Spreadable props for a field: `undefined` kind gives nothing, so a primitive
 * can always spread it. Drops an unset action key so React does not render an
 * empty attribute.
 */
export function fieldKindProps(kind: FieldKind | undefined, options: FieldKindOptions = {}): Partial<FieldKindAttributes> {
  if (!kind) return {};
  const { enterKeyHint, ...rest } = fieldKindAttributes(kind, options);
  return enterKeyHint ? { ...rest, enterKeyHint } : rest;
}
