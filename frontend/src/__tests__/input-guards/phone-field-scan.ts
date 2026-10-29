/* =============================================================================
   Source scanner for the phone field guard (mobile slice 36, KB-02).

   Every phone field is a <PhoneInput> (src/ui-kit/components/form/phoneInput.tsx):
   the "phone" field kind plus the value rules that keep a stored international
   number whole. A text field (`<input>`, `<Input>`) that plainly holds a phone
   number is an offence. A field holds a phone number when it says so by:
     * a telephone keypad, type or autofill: inputMode="tel", type="tel",
       autoComplete="tel..." (not the extension's "tel-extension"), kind="phone";
     * its id or name ("phone", "location-phone", "secondary_phone");
     * its registered form path or bound value (register('phone'),
       `phones.${i}.phone`, value={fields.phone}, value={form.contactPhone});
     * its placeholder or aria-label ("Phone", "(555) 123-4567",
       "To phone number").
   An extension box is not a phone number (it states kind="phone-extension"),
   and a field with another kind (a search field whose placeholder mentions
   "phone") is left to that kind.
   ============================================================================= */
import { NOT_TEXT_TYPE, TAG_NAME, isCommentLine, lineOf, openingTag, type Offence } from './scan';
import { attributeValue } from './field-kind-scan';

const TEXT_TAGS = new Set(['input', 'Input']);

/** A string literal (or `{"..."}` / `{'...'}` / a plain template) as plain text; null for anything computed. */
function literal(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith('{')) return value;
  const m = /^\{\s*(["'`])([^"'`$]*)\1\s*\}$/.exec(value);
  return m ? m[2]! : null;
}

const EXTENSION = /ext(ension)?\b|_ext$|Ext$/i;
/** "phone", "secondary_phone", "contactPhone", "location-phone", "phone-tab-x" - a word "phone", not "phones" or "phoneSearch". */
const PHONE_WORD = /(^|[\s_.-])phone($|[\s_.-])|[a-z]Phone$/;
/** (555) 123-4567, 555-123-4567: a phone number's shape. */
const PHONE_SHAPE = /\(\d{3}\)\s*\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/;

/** Why `opening` is a phone field, or null when it is not one. */
export function phoneFieldReason(opening: string): string | null {
  const kind = literal(attributeValue(opening, 'kind'));
  if (kind === 'phone') return 'kind="phone"';
  // Another stated kind (search, email, phone-extension...) owns the field.
  if (attributeValue(opening, 'kind') !== null) return null;
  if (/\{\s*\.\.\.\s*fieldKindProps\(\s*["'](?!phone["'])/.test(opening)) return null;
  if (/\{\s*\.\.\.\s*fieldKindProps\(\s*["']phone["']/.test(opening)) return 'fieldKindProps("phone")';

  const inputMode = literal(attributeValue(opening, 'inputMode'));
  if (inputMode === 'tel') return 'inputMode="tel"';
  const type = literal(attributeValue(opening, 'type'));
  if (type === 'tel') return 'type="tel"';
  const auto = literal(attributeValue(opening, 'autoComplete'));
  if (auto && /^tel(?!-extension)/.test(auto)) return `autoComplete="${auto}"`;

  for (const attr of ['id', 'name']) {
    const v = literal(attributeValue(opening, attr));
    if (v && PHONE_WORD.test(v) && !EXTENSION.test(v)) return `${attr}="${v}"`;
  }
  for (const r of opening.matchAll(/register\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    const path = r[1]!;
    if (PHONE_WORD.test(path.split('.').pop() ?? '') && !EXTENSION.test(path)) return `register("${path}")`;
  }
  const bound = /^\{\s*[\w.?]*?(\w+)\s*((\?\?|\|\|)\s*(['"])\4\s*)?\}$/.exec(attributeValue(opening, 'value') ?? '')?.[1];
  if (bound && PHONE_WORD.test(bound) && !EXTENSION.test(bound)) return `value={...${bound}}`;

  for (const attr of ['placeholder', 'aria-label']) {
    const v = literal(attributeValue(opening, attr));
    if (!v || EXTENSION.test(v)) continue;
    if (PHONE_SHAPE.test(v)) return `${attr}="${v}"`;
    if (/^(secondary |additional |contact |mobile |cell |work )?phone( number)?$/i.test(v.trim()) || /\bphone number$/i.test(v.trim())) return `${attr}="${v}"`;
  }
  return null;
}

/** Block comments blanked out (newlines kept, so line numbers hold). */
function withoutBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/** Every text field in `source` that holds a phone number and is not a <PhoneInput>. */
export function findRawPhoneFields(source: string): Offence[] {
  const src = withoutBlockComments(source);
  const out: Offence[] = [];
  const tagName = new RegExp(TAG_NAME.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = tagName.exec(src))) {
    const tag = m[1]!;
    if (!TEXT_TAGS.has(tag) || isCommentLine(src, m.index)) continue;
    const opening = openingTag(src, m.index);
    if (tag === 'input' && NOT_TEXT_TYPE.test(opening)) continue;
    const reason = phoneFieldReason(opening);
    if (reason) out.push({ token: `<${tag}> ${reason} (use <PhoneInput>)`, line: lineOf(src, m.index) });
  }
  return out;
}
