/**
 * textPreview.ts - the preview of an inbound text that a bell alert carries (Roles & Permissions, PRD 8, S08.23).
 *
 * The first 80 characters of what the customer wrote, with every run of whitespace and every newline collapsed into one
 * space (the bell row is one short line), counted in the characters a person sees: an emoji, a flag, a family or a letter with
 * its combining accents is one character and is never cut in half. The cut adds no ellipsis. A text with no words (a picture
 * alone) has an empty preview, and the alert then says only who texted.
 *
 * It is plain text all the way: the bell prints it as text, so markup in a message is shown, never interpreted.
 */

/** How many characters of an inbound text the alert carries. */
export const TEXT_PREVIEW_LENGTH = 80;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function textAlertPreview(words: string): string {
  const collapsed = words.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TEXT_PREVIEW_LENGTH) return collapsed;
  const kept: string[] = [];
  for (const { segment } of graphemes.segment(collapsed)) {
    if (kept.length === TEXT_PREVIEW_LENGTH) break;
    kept.push(segment);
  }
  return kept.join('');
}
