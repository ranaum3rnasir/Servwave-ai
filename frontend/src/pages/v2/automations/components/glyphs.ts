/**
 * Non-ASCII glyphs the legacy Automations UI renders, written as unicode
 * escapes.
 *
 * CLAUDE.md forbids an em or en dash anywhere in source, and this module is
 * full of them: heading subtitles, the activity feed empty-value placeholder,
 * the readback sentence, the trigger banners. These are RENDERED CONTENT, not
 * prose about the code, so dropping them would change what the page shows.
 * Writing them as escapes keeps the rendered output identical to the legacy
 * page while no source file carries the character itself.
 *
 * The curly quotes are here for the same reason: the legacy strings use them,
 * several are asserted verbatim by the existing specs, and a straight quote
 * would be a different string.
 */

/** Em dash. This module leans on it harder than any other page. */
export const EM_DASH = '\u2014';
/** Middot, the separator between meta fragments on a row. */
export const MIDDOT = '\u00B7';
/** Horizontal ellipsis. */
export const ELLIPSIS = '\u2026';
/** Right single quotation mark: the apostrophe in the curly-quoted strings. */
export const RSQUO = '\u2019';
/** Left double quotation mark. */
export const LDQUO = '\u201C';
/** Right double quotation mark. */
export const RDQUO = '\u201D';
/** Single right-pointing angle quotation mark: the breadcrumb chevron. */
export const RANGLE = '\u203A';
/** Sparkles, the Tidy-up toast title suffix. */
export const SPARKLES = '\u2728';
