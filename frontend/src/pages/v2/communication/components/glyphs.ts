/**
 * Glyphs this module RENDERS, written as unicode escapes.
 *
 * CLAUDE.md forbids a literal em or en dash anywhere in source. Most of the
 * dashes this module used to carry were ordinary sentence punctuation in toast
 * copy and were simply downgraded to a hyphen - a status toast does not need a
 * typographic dash. The two below are different: they are not punctuation but
 * CONTENT whose exact bytes matter, so they are escaped here rather than
 * changed, and the rendered output stays identical to the legacy page.
 */

/**
 * U+2014 EM DASH.
 *
 * Two uses, both load-bearing:
 *
 *  - the empty-value placeholder in the inbox rail's forwarding row, where a
 *    hyphen would read as a stray minus sign next to the arrow glyph;
 *  - repeated three times as the quoted-reply rule in an outgoing email body.
 *    That text leaves the product, so it is mail formatting rather than source
 *    style, and every mail client draws the same rule the same way.
 */
export const EM_DASH = '\u2014';
