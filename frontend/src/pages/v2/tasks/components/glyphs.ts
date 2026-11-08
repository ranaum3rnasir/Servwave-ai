/**
 * Non-ASCII glyphs the legacy Tasks UI renders, written as unicode escapes.
 *
 * The repo forbids an em or en dash anywhere in source (CLAUDE.md), but several
 * of these are RENDERED CONTENT, not prose: the empty-value placeholder in a
 * table cell, the warning mark on the At Risk lane, the overflow marker in a
 * calendar cell. Dropping them would change what the page shows; writing them
 * as escapes keeps the rendered output identical to the legacy page while no
 * source file carries the character itself.
 */

/** Empty-value placeholder. */
export const EM_DASH = '\u2014';
/** Date-range separator in the calendar week label. */
export const EN_DASH = '\u2013';
/** Warning mark, prefixes the At Risk lane label and the risk badge. */
export const WARN = '\u26A0';
/** Fullwidth plus, prefixes a calendar cell overflow marker. */
export const FULLWIDTH_PLUS = '\uFF0B';
/** Pennant, marks an assignee row that has overdue work. */
export const PENNANT = '\u2691';
/** Horizontal ellipsis, used in truncation and in-flight button labels. */
export const ELLIPSIS = '\u2026';
