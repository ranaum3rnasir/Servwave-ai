/**
 * Glyphs this module RENDERS, written as unicode escapes.
 *
 * CLAUDE.md forbids a literal em or en dash anywhere in source - prose,
 * comments and code alike. The schedule surface renders both: an em dash joins
 * a record number to the thing it belongs to ("J00225 [em] Ada Lovelace") and
 * an en dash separates the two ends of a range ("9:00 AM [en] 11:00 AM").
 *
 * Those are CONTENT, not authoring style, and the e2e selector surface for this
 * page matches on rendered TEXT rather than testids, so they are escaped here
 * rather than downgraded to a hyphen. Rendered output is byte-identical to the
 * legacy page.
 */

/** U+2014 EM DASH - joins a record number to the thing it belongs to. */
export const EM = '\u2014';

/** U+2013 EN DASH - separates the two ends of a range. */
export const EN = '\u2013';
