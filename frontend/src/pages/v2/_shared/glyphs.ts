/**
 * Glyphs this module RENDERS, written as unicode escapes.
 *
 * CLAUDE.md forbids a literal em or en dash anywhere in source. The prose
 * dashes in this module were downgraded to hyphens; the two below are CONTENT,
 * so they are escaped here and the rendered output stays identical to the
 * legacy page.
 */

/**
 * U+2014 EM DASH - the empty-value placeholder returned by the shared field
 * formatters (date, contact, location) when a plan has nothing to show. It is
 * the same placeholder the legacy tables render, and a hyphen in a numeric
 * column reads as a minus sign.
 */
export const EM_DASH = '\u2014';

/**
 * U+2013 EN DASH - separates the two ends of the plan's date range
 * ("Jan 1, 2026 [en] Dec 31, 2026"). A range separator, not punctuation.
 */
export const EN_DASH = '\u2013';

/**
 * U+2026 HORIZONTAL ELLIPSIS - the trailing mark on a prompt that opens
 * something ("Set due date[...]"). Rendered content, and a three-dot run is a
 * different glyph that wraps differently.
 */
export const ELLIPSIS = '\u2026';
