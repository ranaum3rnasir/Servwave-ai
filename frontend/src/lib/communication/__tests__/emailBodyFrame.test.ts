// Email slice 9 (render hardening) - the srcDoc transform behind
// EmailBodyFrame. Pure-function tests: no iframe execution needed, just
// proof that the built HTML string never carries a remote image src (or a
// CSS background-image) until "Load images" is on.
import { describe, it, expect } from 'vitest';
import {
  EMAIL_IFRAME_SANDBOX,
  buildEmailSrcDoc,
  htmlHasBlockableImages,
} from '../emailBodyFrame';

const TRACKING_PIXEL_URL = 'https://mail.example.com/track/open.gif?u=office-ip-123';

describe('EMAIL_IFRAME_SANDBOX', () => {
  it('never includes allow-same-origin (the Close mistake) or allow-scripts', () => {
    const flags = EMAIL_IFRAME_SANDBOX.split(/\s+/);
    expect(flags).not.toContain('allow-same-origin');
    expect(flags).not.toContain('allow-scripts');
  });

  it('allows popups (and lets them escape the sandbox) so a real link opens a real tab', () => {
    const flags = EMAIL_IFRAME_SANDBOX.split(/\s+/);
    expect(flags).toContain('allow-popups');
    expect(flags).toContain('allow-popups-to-escape-sandbox');
  });
});

describe('buildEmailSrcDoc - image blocking', () => {
  const html = `<p>See attached.</p><img src="${TRACKING_PIXEL_URL}" alt="logo" />`;

  it('does not carry the original remote src when images are blocked', () => {
    const srcDoc = buildEmailSrcDoc(html, false);
    expect(srcDoc).not.toContain(TRACKING_PIXEL_URL);
  });

  it('restores the original remote src once images are allowed', () => {
    const srcDoc = buildEmailSrcDoc(html, true);
    expect(srcDoc).toContain(TRACKING_PIXEL_URL);
  });

  it('strips a CSS background-image the same way, blocked by default', () => {
    const withBg = '<div style="background-image: url(\'' + TRACKING_PIXEL_URL + '\'); padding: 4px;">x</div>';
    const blocked = buildEmailSrcDoc(withBg, false);
    expect(blocked).not.toContain(TRACKING_PIXEL_URL);
    // The rest of the style declaration (padding) is untouched.
    expect(blocked).toContain('padding');

    const allowed = buildEmailSrcDoc(withBg, true);
    expect(allowed).toContain(TRACKING_PIXEL_URL);
  });

  it('is a no-op on a body with no images at all', () => {
    const textOnly = '<p>Just text, nothing to block.</p>';
    expect(buildEmailSrcDoc(textOnly, false)).toContain('Just text, nothing to block.');
  });

  it('wraps the sanitized content in a full HTML document for srcDoc', () => {
    const srcDoc = buildEmailSrcDoc('<p>hi</p>', false);
    expect(srcDoc).toMatch(/^<!doctype html>/i);
    expect(srcDoc).toContain('<p>hi</p>');
  });

  it('does not throw or strip a script tag - this function is not a re-sanitizer', () => {
    // NOTE on what this test does NOT prove: it only checks that
    // buildEmailSrcDoc is a dumb string transform that neither throws on nor
    // strips a <script> tag. It is NOT evidence that the tag can't execute -
    // this is a pure function, there is no iframe/sandbox involved at all
    // here. Script-execution blocking is the sandbox attribute's job
    // (EMAIL_IFRAME_SANDBOX, asserted above) enforced by real browser
    // sandbox semantics, which this jsdom-based suite cannot exercise (see
    // EmailBodyFrame.test.tsx's matching note for detail).
    const withScript = '<p>hi</p><script>window.__pwned = true;</script>';
    expect(() => buildEmailSrcDoc(withScript, false)).not.toThrow();
    // Not re-sanitized here: the server already stripped this in the real
    // path (backend/src/lib/email-html.ts); if it ever slipped through
    // anyway, the srcDoc carries it verbatim on purpose - stripping it here
    // would be a second allowlist pass this file deliberately doesn't own.
    expect(buildEmailSrcDoc(withScript, false)).toContain('<script>');
  });

  it('does not throw on empty input', () => {
    expect(() => buildEmailSrcDoc('', false)).not.toThrow();
  });
});

describe('htmlHasBlockableImages', () => {
  it('is true for a body with a remote <img>', () => {
    expect(htmlHasBlockableImages(`<img src="${TRACKING_PIXEL_URL}" />`)).toBe(true);
  });

  it('is true for a body with a CSS background-image', () => {
    expect(htmlHasBlockableImages(`<div style="background-image: url(${TRACKING_PIXEL_URL})">x</div>`)).toBe(true);
  });

  it('is false for a body with no images at all', () => {
    expect(htmlHasBlockableImages('<p>Just text.</p>')).toBe(false);
  });

  it('is false for empty input', () => {
    expect(htmlHasBlockableImages('')).toBe(false);
  });

  // Locks the classic shared-global-regex-with-.test() footgun: a `g`-flagged
  // RegExp's lastIndex persists across .test() calls, so a naive
  // implementation can silently miss a match on a later, unrelated string
  // once an earlier call has advanced it. Calling this twice in a row is
  // exactly the shape that bug needs to reproduce.
  it('gives the same answer on repeated calls (no shared-regex lastIndex drift)', () => {
    const withBg = `<div style="background-image: url(${TRACKING_PIXEL_URL})">x</div>`;
    expect(htmlHasBlockableImages(withBg)).toBe(true);
    expect(htmlHasBlockableImages(withBg)).toBe(true);
    expect(htmlHasBlockableImages('<p>Just text.</p>')).toBe(false);
  });
});
