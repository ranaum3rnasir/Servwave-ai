/* =============================================================================
   Source scanner for the number field guard (mobile slice 37, KB-04).

   A money, quantity, percent or count field states its kind
   (`<Input kind="money" />`); it is never `type="number"`. A number input
   spins under the mouse wheel, draws a spinner and, on a phone, opens a keypad
   without the decimal point. One finding:

     * `type="number"` (or any `type={...}` expression that can be "number")
       on a text field: `<input>`, `<Input>`, cmdk's input, or a wrapper field
       named *Input / *Field that passes its type on.

   Chart axes (`<XAxis type="number">`) are not fields and are not read.
   ============================================================================= */
import { NOT_TEXT_TYPE, TAG_NAME, isCommentLine, lineOf, openingTag, type Offence } from './scan';
import { attributeValue } from './field-kind-scan';

const FIELD_TAGS = new Set(['input', 'Input', 'CommandPrimitive.Input']);
/** A wrapper field (`<LabeledInput>`, `<TextField>`...) that passes `type` on to an input. */
const WRAPPER_TAG = /(Input|Field)$/;

/** Block comments blanked out (newlines kept, so line numbers hold). */
function withoutBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

export function findNumberInputs(source: string): Offence[] {
  const src = withoutBlockComments(source);
  const out: Offence[] = [];
  const tagName = new RegExp(TAG_NAME.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = tagName.exec(src))) {
    const tag = m[1]!;
    if (!FIELD_TAGS.has(tag) && !WRAPPER_TAG.test(tag)) continue;
    if (isCommentLine(src, m.index)) continue;
    const opening = openingTag(src, m.index);
    if (tag === 'input' && NOT_TEXT_TYPE.test(opening)) continue;
    const type = attributeValue(opening, 'type');
    if (type === null) continue;
    // A literal "number", or an expression that can yield it: {'number'}, {x ? 'number' : 'text'}.
    if (type === 'number' || /["'`]number["'`]/.test(type)) {
      out.push({ token: `<${tag}> type="number" (use kind="money" | "quantity" | "percent" | "count")`, line: lineOf(src, m.index) });
    }
  }
  return out;
}
