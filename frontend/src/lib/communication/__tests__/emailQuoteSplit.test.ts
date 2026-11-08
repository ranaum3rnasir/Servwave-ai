// Email slice 9 (render hardening) - quote-stripping detection.
//
// We do not hand-roll "is this line a quote" heuristics (house rule: reach
// for a vetted library at parsing edge cases). email-reply-parser
// (crisp-oss, maintained, MIT, zero deps) already knows the "On DATE, NAME
// <EMAIL> wrote:" reply-header shapes across ~10 locales and where a
// top-posted reply's quoted history begins; these tests lock our thin
// wrapper around it, not the library's own detection logic.
import { describe, it, expect } from 'vitest';
import { splitQuotedText, splitQuotedHtml } from '../emailQuoteSplit';

describe('splitQuotedText (plain-body paragraphs)', () => {
  it('returns everything as visible when there is no quote header', () => {
    const paragraphs = ['Hi there,', 'Just checking in, no reply needed.', 'Thanks,\nJane'];
    const result = splitQuotedText(paragraphs);
    expect(result.quoted).toEqual([]);
    expect(result.visible.join(' ')).toContain('Just checking in');
  });

  it('cuts everything from the "On DATE, NAME <EMAIL> wrote:" header onward into quoted', () => {
    const paragraphs = [
      'Sounds good, see you then.',
      'On Aug 3, 2026, at 9:00 AM, John Doe <john@example.com> wrote:\n\n> Can you check on the invoice status?\n>\n> Thanks,\n> John',
    ];
    const result = splitQuotedText(paragraphs);
    expect(result.visible.join('\n')).toContain('Sounds good, see you then.');
    expect(result.visible.join('\n')).not.toContain('invoice status');
    expect(result.quoted.join('\n')).toContain('John Doe <john@example.com> wrote:');
    expect(result.quoted.join('\n')).toContain('invoice status');
  });

  it('returns an empty split for an empty paragraph array', () => {
    const result = splitQuotedText([]);
    expect(result).toEqual({ visible: [], quoted: [] });
  });
});

describe('splitQuotedHtml (sanitized HTML body)', () => {
  it('treats the whole body as visible when there is no quote header', () => {
    const html = '<p>Hi there,</p><p>Just checking in, no reply needed.</p>';
    const result = splitQuotedHtml(html);
    expect(result.quotedHtml).toBe('');
    expect(result.visibleHtml).toContain('Just checking in');
  });

  it('splits a reply paragraph from a trailing "On ... wrote:" + blockquote pair', () => {
    const html =
      '<p>Sounds good, see you then.</p>' +
      '<p>On Aug 3, 2026, at 9:00 AM, John Doe &lt;john@example.com&gt; wrote:</p>' +
      '<blockquote><p>Can you check on the invoice status?</p></blockquote>';
    const result = splitQuotedHtml(html);
    expect(result.visibleHtml).toContain('Sounds good, see you then.');
    expect(result.visibleHtml).not.toContain('invoice status');
    expect(result.quotedHtml).toContain('wrote:');
    expect(result.quotedHtml).toContain('invoice status');
    // The reply paragraph's own markup survives untouched in the visible half.
    expect(result.visibleHtml).toContain('<p>Sounds good, see you then.</p>');
  });

  it('does not throw or strip a script tag inside the quoted portion', () => {
    // This is a pure DOMParser-based string transform, not a live iframe -
    // nothing here ever "executes" a script either way. The server-side
    // sanitizer (backend/src/lib/email-html.ts) already strips <script> in
    // the real path; this only proves the split itself is inert if one
    // reaches here anyway (a sanitizer bypass) - it must not throw, and
    // stripping it is not this function's job, only the render sandbox's
    // (EMAIL_IFRAME_SANDBOX in emailBodyFrame.ts).
    const html =
      '<p>Reply text.</p>' +
      '<p>On Aug 3, 2026, at 9:00 AM, John Doe &lt;john@example.com&gt; wrote:</p>' +
      '<blockquote><script>window.__pwned = true;</script><p>quoted</p></blockquote>';
    expect(() => splitQuotedHtml(html)).not.toThrow();
    const result = splitQuotedHtml(html);
    expect(result.visibleHtml).toContain('Reply text.');
    expect(result.quotedHtml).toContain('quoted');
  });

  it('returns an empty split for empty input', () => {
    expect(splitQuotedHtml('')).toEqual({ visibleHtml: '', quotedHtml: '' });
  });

  it('keeps a bare top-level <img> (empty textContent) instead of dropping it', () => {
    // Regression: a top-level block with no text of its own - e.g. an <img>
    // not wrapped in a <p>/<div> - used to be filtered out of `blocks`
    // entirely before the visible/quoted split ran, so it vanished from
    // BOTH halves rather than landing in either one.
    const html =
      '<p>See the photo below.</p>' +
      '<img src="https://cdn.example.com/photo.jpg" alt="job site" />' +
      '<p>On Aug 3, 2026, at 9:00 AM, John Doe &lt;john@example.com&gt; wrote:</p>' +
      '<blockquote><p>quoted stuff</p></blockquote>';

    const result = splitQuotedHtml(html);

    expect(result.visibleHtml).toContain('cdn.example.com/photo.jpg');
    expect(result.visibleHtml).toContain('See the photo below.');
    expect(result.quotedHtml).toContain('quoted stuff');
  });

  it('keeps a bare text node\'s literal escaped markup inert through the split', () => {
    // A customer can type the literal characters "<b>bold</b>" as plain
    // text; the server sanitizer keeps that inert by entity-encoding it, so
    // the sanitized HTML that reaches the client carries "&lt;b&gt;" as a
    // bare text node directly in <body> (no wrapping element - this is the
    // shape that hits serializeNode's text node branch, not its element
    // branch). Regression for a real bug: serializeNode used to return
    // node.textContent RAW - which is always the DECODED characters, i.e.
    // the literal string "<b>bold</b>" - so re-embedding it verbatim handed
    // buildEmailSrcDoc's later re-parse a real <b> element built from text
    // that was supposed to stay inert.
    const html =
      'Some inline text with literal &lt;b&gt;bold&lt;/b&gt; escaped' +
      '<p>On Aug 3, 2026, at 9:00 AM, John Doe &lt;john@example.com&gt; wrote:</p>' +
      '<blockquote><p>quoted stuff</p></blockquote>';

    const result = splitQuotedHtml(html);

    expect(result.visibleHtml).toContain('&lt;b&gt;');
    expect(result.visibleHtml).not.toContain('<b>bold</b>');
  });
});
