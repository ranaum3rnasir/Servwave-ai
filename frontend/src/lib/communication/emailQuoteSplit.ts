// Email slice 9 (render hardening) - quote-stripping detection.
//
// We write quoted text back onto every reply (InlineComposer's "···" quote
// toggle) but never strip it from a body we RECEIVE - every inbound message
// renders its entire history inline, every time, forever. This file decides
// where the boundary is; the two call sites (EmailMessageBody, for plain
// paragraphs and for sanitized HTML) only apply the split and render a
// disclosure around it.
//
// Detection is entirely delegated to email-reply-parser (crisp-oss, MIT, zero
// deps, actively maintained - ~1M inbound emails/day at Crisp per its own
// README) rather than hand-rolled, per this repo's own house rule to reach
// for a vetted library at parsing edge cases (CSV/dates/money/timezones -
// and, as it turns out, "where does a quoted reply begin" belongs on that
// list too: it needs ~10 locales' worth of "On DATE, NAME <EMAIL> wrote:"
// header shapes plus common signature patterns, none of which is worth
// reinventing). quotequail, the plan's other named candidate, is not
// published on npm (`npm view quotequail` -> 404, checked 2026-08-05) and was
// not considered further.
import EmailReplyParser from 'email-reply-parser';

export interface QuoteSplitResult {
  visible: string[];
  quoted: string[];
}

export interface HtmlQuoteSplitResult {
  visibleHtml: string;
  quotedHtml: string;
}

/** Re-paragraph a block of text on blank-line boundaries, same convention
 *  `splitQuotedText` joins paragraphs with below. Trims and drops empties. */
function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Split a plain-text message body (the `Email.body` paragraph array) into
 * the visible reply and the quoted history beneath it.
 *
 * Paragraphs are joined with a blank line (the same convention the reader
 * already renders them with - one `<p>` per array entry) purely so
 * email-reply-parser sees paragraph boundaries as blank lines; the result is
 * re-paragraphed from whatever the library decided is visible/quoted, rather
 * than trying to map its answer back onto the ORIGINAL array indices. A
 * mapping like that would silently break the moment a single array entry
 * carries the entire message (reply + quote together) as one blob, which is
 * a real shape this app's data can take - re-deriving both halves straight
 * from the library's own text avoids depending on the caller's granularity
 * at all.
 */
export function splitQuotedText(paragraphs: string[]): QuoteSplitResult {
  if (paragraphs.length === 0) return { visible: [], quoted: [] };

  const fullText = paragraphs.join('\n\n');
  const email = new EmailReplyParser().read(fullText);
  const quotedText = email.getQuotedText().trim();

  if (!quotedText) {
    return { visible: paragraphs, quoted: [] };
  }

  const visibleText = email.getVisibleText().trim();
  return {
    visible: visibleText ? toParagraphs(visibleText) : [],
    quoted: toParagraphs(quotedText),
  };
}

/** Plain-text approximation of one top-level HTML block, for feeding to
 *  email-reply-parser's line-based detector. Block-level children (p, div,
 *  blockquote, table...) become one unit each; a bare text node directly in
 *  body (no wrapping element) is read as-is. */
function blockText(node: ChildNode): string {
  return (node.textContent ?? '').trim();
}

/** HTML-escape a decoded text node's value before it re-enters a markup string.
 *  `.textContent` always returns DECODED characters - for source `&lt;b&gt;`
 *  it is the literal string `<b>`, not the entity form - so re-embedding it
 *  verbatim hands the next HTML parser (buildEmailSrcDoc's own DOMParser
 *  re-parse of this function's output) a real `<b>` element built from what
 *  was supposed to be inert text a customer literally typed. This is true
 *  regardless of what the server sanitizer did upstream: sanitizing input
 *  and serializing a parsed DOM node back to a string are different
 *  operations, and only escaping at the second one keeps the round-trip
 *  safe. */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Serialize a node back to markup: an Element's own outerHTML (already
 *  correctly escaped by the browser's own serializer), or an escaped text
 *  node's data. */
function serializeNode(node: ChildNode): string {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element).outerHTML
    : escapeHtmlText(node.textContent ?? '');
}

/**
 * Split sanitized HTML into the visible reply and the quoted history.
 *
 * Same library, same "everything from the cut point onward is quoted" model
 * as splitQuotedText - but here the ORIGINAL MARKUP has to survive the split
 * (tables, links, images), so plain-text re-derivation isn't an option. This
 * walks the body's direct children as blocks, finds the first block whose
 * text isn't contained in the library's own getVisibleText() (i.e. the first
 * block email-reply-parser folded into the quote), and cuts there. Every
 * real email HTML shape (Gmail, Outlook, Apple Mail) already renders each
 * paragraph/heading/blockquote as its own top-level element, so this lines
 * up with the library's line-based decision without re-implementing it.
 */
export function splitQuotedHtml(html: string): HtmlQuoteSplitResult {
  if (!html) return { visibleHtml: '', quotedHtml: '' };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Keep every element node as its own block regardless of text content - a
  // bare top-level `<img>`, `<hr>`, or `<br>` (not wrapped in a `<p>`/`<div>`)
  // has empty .textContent but is still real content that must survive the
  // split. Only whitespace-only TEXT nodes (blank formatting gaps between
  // tags) are dropped here; an element with no text of its own still gets a
  // slot in `blocks` so `serializeNode` below can carry it through to
  // whichever half it lands in.
  const blocks = Array.from(doc.body.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || blockText(n).length > 0,
  );

  if (blocks.length === 0) return { visibleHtml: html, quotedHtml: '' };

  const fullText = blocks.map(blockText).join('\n\n');
  const email = new EmailReplyParser().read(fullText);
  const quotedText = email.getQuotedText().trim();

  if (!quotedText) {
    return { visibleHtml: html, quotedHtml: '' };
  }

  const visibleText = email.getVisibleText().trim();
  let cut = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    if (!visibleText.includes(blockText(blocks[i]!))) {
      cut = i;
      break;
    }
  }

  // Every block matched the visible text (shouldn't happen once quotedText
  // is non-empty, but a quote we can't place is not a quote we hide).
  if (cut >= blocks.length) {
    return { visibleHtml: html, quotedHtml: '' };
  }

  return {
    visibleHtml: blocks.slice(0, cut).map(serializeNode).join(''),
    quotedHtml: blocks.slice(cut).map(serializeNode).join(''),
  };
}
