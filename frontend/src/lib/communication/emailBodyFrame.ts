// Email slice 9 (render hardening) - the srcDoc transform behind the
// EmailBodyFrame component.
//
// SECURITY LAYERING. backend/src/lib/email-html.ts::sanitizeEmailHtml is
// layer 1 (server-side, at ingest): scripts/iframes/event handlers already
// stripped before a body ever reaches the client. This file is layer 2: the
// client-side render sandbox, so a sanitizer bug or a future relaxed
// allowlist does not immediately execute script in the authenticated app's
// own DOM. The two things below are that layer's whole job.
//
// --- the sandbox value -------------------------------------------------
// AdGuard's own safe-HTML-email renderer (see their engineering blog, "How
// we created a safe, rich, modern HTML email renderer") uses exactly
// `sandbox="allow-popups allow-popups-to-escape-sandbox"` with
// `credentialless` + `referrerpolicy="no-referrer"`, and deliberately no
// allow-same-origin. Close's own writeup of the same problem ("Rendering
// untrusted HTML email, safely") uses allow-same-origin too - specifically
// to read the iframe's contentDocument.scrollHeight for auto-sizing. That is
// the one mistake this slice's plan calls out by name: allow-same-origin
// gives the framed document access to the PARENT's origin's storage/DOM the
// moment allow-scripts is ever added back (by a future slice, a copy-paste,
// a merge) - and is unsafe defense-in-depth even paired with no-scripts
// today, because it is one flag away from a real escape rather than zero.
// EMAIL_IFRAME_SANDBOX matches AdGuard's config, not Close's:
//   - no allow-scripts: nothing in this frame ever runs, full stop. The
//     content should already be script-free post-sanitizer; this is the
//     backstop that holds even if that first layer is ever bypassed.
//   - no allow-same-origin: the framed document renders in an opaque,
//     cross-origin-equivalent browsing context. The parent cannot reach
//     into it (no contentDocument access) and it cannot reach the parent.
//   - allow-popups + allow-popups-to-escape-sandbox: sanitizeEmailHtml
//     already rewrites every <a> to target="_blank" rel="noopener
//     noreferrer" (its own transformTags call). Without allow-popups, that
//     click is simply swallowed - dead link, no visible failure. Without
//     allow-top-navigation (never added - an email body must never be able
//     to navigate the app itself away), the fallback if popups were also
//     blocked would be the iframe navigating ITSELF to the link, silently
//     replacing the read pane with an arbitrary external page trapped in a
//     420px box - worse than either. allow-popups makes a normal new tab
//     open instead; allow-popups-to-escape-sandbox is required alongside it
//     so that new tab is a REAL, fully-functional tab (scripts, storage,
//     everything) rather than one that inherits this frame's own
//     no-scripts sandbox and can't run the destination site at all.
export const EMAIL_IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

// --- auto-sizing: why a fixed height, not a measured one ---------------
// The plan allows a fixed max-height + internal scroll as a fallback "if
// content-height auto-sizing proves impractical to unit-test meaningfully
// under jsdom" - here it is not just impractical to test, it is impossible
// to IMPLEMENT without giving back one of the two properties above:
//   - postMessage-from-inside-the-frame requires a <script> to run inside
//     the srcDoc to measure scrollHeight and post it out. That needs
//     allow-scripts, which this sandbox exists specifically to omit.
//   - reading iframe.contentDocument.scrollHeight from the PARENT requires
//     allow-same-origin (Close's approach) - the exact mistake this slice's
//     plan calls out.
//   - rendering the same HTML into a hidden, non-sandboxed node in the
//     parent's OWN document purely to measure its height was considered and
//     rejected: that is dangerouslySetInnerHTML-ing untrusted content into
//     the live authenticated app a second time, off-screen or not - it
//     defeats the entire point of this slice.
// Every route to true content-driven auto-sizing costs one of the two
// security properties this file exists to add, so a fixed height with the
// browser's own native iframe scrollbar is the correct trade-off, not
// merely the simpler one.
export const EMAIL_IFRAME_HEIGHT_PX = 420;

/** 1x1 transparent GIF - the placeholder an <img> gets pointed at while
 *  images are blocked. A `data:` URI is safe to hand to the DOM here because
 *  this string never went through sanitizeEmailHtml - it is ours, not
 *  attacker-controlled, and never persisted, only built fresh into the next
 *  srcDoc string for this render. */
const BLANK_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

/** Base styling for the framed document. This is a STANDALONE HTML document
 *  rendered inside a sandboxed iframe with no access to the app's own
 *  stylesheet or design tokens (tokens.css never loads in here - there is no
 *  shared origin to load it from) - the app's "no raw hex/palette class"
 *  component rule targets Tailwind call sites in OUR components, which this
 *  is not. Kept deliberately minimal and colour-light: no explicit
 *  foreground/background colour is set at all, so the frame just inherits
 *  the browser's own light/dark UA defaults via color-scheme rather than
 *  this file hardcoding either. */
const BASE_STYLES = [
  ':root { color-scheme: light dark; }',
  'body { margin: 0; padding: 12px; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }',
  'img, table { max-width: 100%; }',
  'table { border-collapse: collapse; }',
].join('\n');

/** Strip any `background-image: url(...)` declaration from an inline style
 *  value. Belt-and-braces: sanitizeEmailHtml's own allowedStyles list does
 *  not include background-image today (only colour, background colour, the
 *  font properties, paragraph alignment and a handful of others - see that
 *  file's allowlist), so this should
 *  already be unreachable in practice. It is still handled here, in the
 *  same transform pass as the <img> src rewrite below, as the second layer
 *  this whole file exists to be: if the server allowlist is ever widened
 *  or has a matching bug, a CSS-based tracking pixel does not silently
 *  bypass the client-side "Load images" gate that <img src> already has. */
function stripBackgroundImage(styleValue: string): string {
  return styleValue.replace(/background-image\s*:\s*url\([^)]*\)\s*;?/gi, '').trim();
}

/** True if `html` contains anything the "Load images" gate would need to
 *  unblock - a remote <img>, or a CSS background-image on any inline style
 *  attribute. Lets the caller skip rendering the "Images are hidden - Load
 *  images" affordance on a body that never had any. */
export function htmlHasBlockableImages(html: string): boolean {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelectorAll('img').length > 0) return true;
  return Array.from(doc.querySelectorAll('[style]')).some((el) => {
    const style = el.getAttribute('style') ?? '';
    return stripBackgroundImage(style) !== style;
  });
}

/**
 * Build the full HTML document string for the message-body iframe's srcDoc.
 *
 * `html` is always the PRISTINE, already-server-sanitized body - every call
 * reparses it from scratch rather than mutating a carried-over DOM, so
 * toggling `loadImages` back and forth is idempotent with no restore-the-
 * original-value bookkeeping needed: when images are blocked, this rewrites
 * <img src> and strips background-image; when they are allowed, it simply
 * leaves both untouched, because the parse it started from still has the
 * real values.
 */
export function buildEmailSrcDoc(html: string, loadImages: boolean): string {
  const doc = new DOMParser().parseFromString(html ?? '', 'text/html');

  if (!loadImages) {
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      if (img.getAttribute('src')) img.setAttribute('src', BLANK_IMAGE_SRC);
    }
    for (const el of Array.from(doc.querySelectorAll('[style]'))) {
      const style = el.getAttribute('style');
      if (!style) continue;
      const stripped = stripBackgroundImage(style);
      if (stripped !== style) el.setAttribute('style', stripped);
    }
  }

  const bodyContent = doc.body ? doc.body.innerHTML : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8" />' +
    '<style>' +
    BASE_STYLES +
    '</style></head><body>' +
    bodyContent +
    '</body></html>'
  );
}
