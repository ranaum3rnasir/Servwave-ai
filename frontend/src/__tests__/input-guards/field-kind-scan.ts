/* =============================================================================
   Source scanner for the field kind guard (mobile slice 23, KB-03 / KB-05).

   A field says what it holds with `kind` (src/ui-kit/lib/fieldKind.ts) and
   never sets the email/search type, keyboard mode or autofill token by hand.
   Two findings:
     * hand-set: an email/search type or a personal-data / one-time-code
       autofill token written on the tag, or `kind` beside a hand-set type,
       keyboard mode or autofill token;
     * missing: a field that plainly is an email, search, ZIP, name or address
       field (by its id, name, placeholder, aria-label or registered form
       path) with no `kind`.
   Phone (slice 36) and money/quantity (slice 37) are not judged here yet.
   ============================================================================= */
import { NOT_TEXT_TYPE, TAG_NAME, isCommentLine, lineOf, openingTag, type Offence } from './scan';

/** Tags that draw a text field and can take a kind (or spread fieldKindProps). */
const KIND_TAGS = new Set(['input', 'Input', 'CommandPrimitive.Input']);
/**
 * A wrapper field (`<LabeledInput>`, `<TextField>`...) that passes `type` on to
 * an input. Only its hand-set type and autofill are judged: whether it takes a
 * kind at all is the wrapper's business. `<ContactCell type="email">` is a
 * display cell, not a field, and does not match.
 */
const WRAPPER_TAG = /(Input|Field)$/;

/** Autofill tokens a field kind owns; writing one by hand bypasses the kind. */
const KIND_TOKENS = /^(email|one-time-code|postal-code|name|given-name|family-name|street-address|address-line[123]|address-level[1-4])$/;

/** Brace depth and open quote at `end` of an opening tag. */
function depthAt(tag: string, end: number): { depth: number; quote: string | null } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < end; i++) {
    const c = tag[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return { depth, quote };
}

/** The value of attribute `name` at the tag's own depth: a literal's contents or a `{...}` expression. */
export function attributeValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}=`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const { depth, quote } = depthAt(tag, m.index);
    if (depth !== 0 || quote) continue;
    const at = m.index + m[0].length;
    const open = tag[at];
    if (open === '"' || open === "'") return tag.slice(at + 1, tag.indexOf(open, at + 1));
    if (open === '{') {
      let d = 0;
      let end = at;
      for (; end < tag.length; end++) {
        if (tag[end] === '{') d++;
        else if (tag[end] === '}' && --d === 0) break;
      }
      return tag.slice(at, end + 1);
    }
  }
  return null;
}

/** A string literal (or `{"..."}`) as plain text; null for anything computed. */
function literal(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith('{')) return value;
  const m = /^\{\s*(["'`])([^"'`$]*)\1\s*\}$/.exec(value);
  return m ? m[2]! : null;
}

export type ExpectedKind = 'one-time-code' | 'email' | 'search' | 'postal-code' | 'given-name' | 'family-name' | 'organization' | 'street' | 'address-line2' | 'city' | 'state';

/** The kind a field plainly is, from what it calls itself; null when it says nothing clear. */
export function expectedKind(tag: string): ExpectedKind | null {
  const placeholder = (attributeValue(tag, 'placeholder') ?? '').trim();
  const aria = (attributeValue(tag, 'aria-label') ?? '').trim();
  const ids = [attributeValue(tag, 'id'), attributeValue(tag, 'name')].filter(Boolean).join(' ');
  const registered = [...tag.matchAll(/register\(\s*[`'"]([^`'"]+)[`'"]/g)].map((r) => r[1]).join(' ');
  const inputMode = attributeValue(tag, 'inputMode') ?? '';
  const auto = attributeValue(tag, 'autoComplete') ?? '';
  // Phone fields belong to slice 36 (the phone input); not judged here.
  if (/tel/.test(inputMode) || /(^|[\s_.-])(phone|tel)/i.test(ids) || /^\{?\s*["'`]?(secondary\s)?phone\b/i.test(aria)) return null;
  if (/one-time-code/.test(auto) || /(mfa|otp|verification)[-_ ]?code/i.test(ids)) return 'one-time-code';
  // What the field is bound to (id, name, form path) beats what its placeholder
  // says: the customer block's name and email fields say "Search..." because
  // they double as a typeahead, but they hold a name and an email.
  // `value={fields.email}`: the last property of a plain bound value.
  // A `|| ''` or `?? ''` fallback is still a plain bound value.
  const bound = /^\{\s*[\w.?]*?(\w+)\s*((\?\?|\|\|)\s*['"]{2}\s*)?\}$/.exec(attributeValue(tag, 'value') ?? '')?.[1] ?? '';
  const names = `${ids} ${registered} ${bound}`;
  // An email's subject, body or sender local part is not an email address.
  if (/subject|body|template|local-?part|signature/i.test(names)) return null;
  // `search`, `query`, `q`, a camelCase `poSearch` / `jobSearch`, or `searchValue` / `searchTerm` / `searchQuery`.
  if (/^(search|query|q)$/i.test(bound) || /[a-z]Search$|^search(Value|Term|Text|Query|Input)$/.test(bound)) return 'search';
  const byName = fromWords(names, true);
  if (byName) return byName;
  if (/^\{?\s*["'`]?search\b/i.test(placeholder) || /^\{?\s*["'`]?search\b/i.test(aria) || /search\w*placeholder/i.test(placeholder)) return 'search';
  return fromWords(`${placeholder} ${aria}`, false) ?? (/^(street|address)$/i.test(placeholder) ? 'street' : null);
}

function fromWords(words: string, bound: boolean): ExpectedKind | null {
  if (/e-?mail/i.test(words)) return 'email';
  if (/zip|postal/i.test(words)) return 'postal-code';
  if (/first[\s_-]?name|given[\s_-]?name/i.test(words)) return 'given-name';
  if (/last[\s_-]?name|family[\s_-]?name/i.test(words)) return 'family-name';
  if (bound) {
    if (/company[-_]?name/i.test(words)) return 'organization';
    if (/(^|[\s_.])(street|address_?line_?1|address1|addressLine1)\b/i.test(words)) return 'street';
    if (/address_?line_?2|address2|addressLine2/i.test(words)) return 'address-line2';
    if (/(^|[\s_.-])city\b/i.test(words)) return 'city';
    if (/(^|[\s_.-])state(\s|$)/i.test(words)) return 'state';
  } else {
    if (/^\s*street\b/i.test(words)) return 'street';
    if (/^\s*city\s*$/i.test(words)) return 'city';
    if (/^\s*state\s*$/i.test(words)) return 'state';
  }
  return null;
}

/** Block comments blanked out (newlines kept, so line numbers hold). */
function withoutBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

export function findFieldKindOffences(source: string): Offence[] {
  const src = withoutBlockComments(source);
  const out: Offence[] = [];
  const tagName = new RegExp(TAG_NAME.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = tagName.exec(src))) {
    const tag = m[1]!;
    const wrapper = !KIND_TAGS.has(tag) && WRAPPER_TAG.test(tag);
    if ((!KIND_TAGS.has(tag) && !wrapper) || isCommentLine(src, m.index)) continue;
    const opening = openingTag(src, m.index);
    if (tag === 'input' && NOT_TEXT_TYPE.test(opening)) continue;
    const line = lineOf(src, m.index);
    const type = literal(attributeValue(opening, 'type'));
    const auto = literal(attributeValue(opening, 'autoComplete'));
    if (type === 'email' || type === 'search') out.push({ token: `<${tag}> type="${type}" (use kind)`, line });
    if (auto && KIND_TOKENS.test(auto)) out.push({ token: `<${tag}> autoComplete="${auto}" (use kind)`, line });
    if (attributeValue(opening, 'kind') !== null) {
      for (const a of ['type', 'inputMode', 'autoComplete']) {
        if (attributeValue(opening, a) !== null) out.push({ token: `<${tag}> kind beside ${a}`, line });
      }
      continue;
    }
    if (wrapper) continue;
    if (/\{\s*\.\.\.\s*(fieldKindProps\(|searchKeyboard\b|kindProps\b)/.test(opening)) continue;
    const expected = expectedKind(opening);
    if (expected) out.push({ token: `<${tag}> ${expected} field without kind`, line });
  }
  return out;
}
