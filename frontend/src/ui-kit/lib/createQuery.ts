/**
 * What both combobox families share for a list the user can ADD to (DESIGN_SYSTEM.md §4.2):
 *
 *   - the search text is TIDIED before it is filtered or handed over - invisible format
 *     characters removed, trimmed, every run of whitespace collapsed to one space - so
 *     "Part   order " finds, and pre-fills, the name "Part order";
 *   - the fixed create row pinned below the list reads `DEFAULT_CREATE_LABEL` unless the call
 *     site names the thing ("Create category"). It is the same row, with the same words, before
 *     anything is typed, while searching and when nothing matches.
 *
 * In `ui-kit/lib` so both `@/ui-kit/components/form/combobox` and the app's
 * `@/components/ui/combobox` read the one definition (the app may import the kit, not the reverse).
 */
export function tidyQuery(query: string): string {
  // Invisible format characters (\p{Cf}: zero-width space/joiners, BOM, word joiner...) first.
  return query.replace(/\p{Cf}/gu, '').trim().replace(/\s+/g, ' ');
}

/** The create row's wording when the call site does not name what it creates. */
export const DEFAULT_CREATE_LABEL = 'Create new';
