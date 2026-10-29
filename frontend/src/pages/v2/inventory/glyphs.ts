/**
 * Glyphs this module RENDERS, written as unicode escapes.
 *
 * CLAUDE.md forbids a literal em or en dash anywhere in source. Most of the
 * dashes this module used to carry were ordinary sentence punctuation in toasts,
 * tooltips and marketing copy, and were downgraded to a hyphen. The ones below
 * are CONTENT rather than punctuation, so they are escaped rather than changed
 * and the rendered output stays identical to the legacy page.
 */

/**
 * U+2014 EM DASH.
 *
 * Two uses:
 *
 *  - the purchase-order table's empty-value marker, which brackets its label
 *    on both sides ("[em] no job link [em]"); a hyphen there reads as a typo
 *    rather than as a placeholder;
 *  - the vendor delete/archive toasts, whose legacy strings are asserted
 *    verbatim by `src/__tests__/vendor-archive.test.tsx`. The v2 page carries
 *    the same copy, so keeping the character keeps the two pages one string.
 */
export const EM_DASH = '\u2014';
