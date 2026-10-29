import { describe, it, expect } from 'vitest';
import { safeHref } from '@/lib/safe-href';

// F-14 — href/src bound to user/seed URLs must reject dangerous schemes (javascript:, data:, …)
// while passing legitimate http/https/mailto/tel and relative references unchanged.
describe('safeHref', () => {
  it('passes http and https URLs through unchanged', () => {
    expect(safeHref('http://example.com/x')).toBe('http://example.com/x');
    expect(safeHref('https://vendor.example.com')).toBe('https://vendor.example.com');
  });

  it('passes mailto and tel through unchanged', () => {
    expect(safeHref('mailto:sales@vendor.com')).toBe('mailto:sales@vendor.com');
    expect(safeHref('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('rejects javascript: URIs (the XSS sink), including case/whitespace evasion', () => {
    expect(safeHref('javascript:alert(document.cookie)')).toBeUndefined();
    expect(safeHref('  JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref('JAVASCRIPT:fetch("//evil")')).toBeUndefined();
  });

  it('rejects data:, vbscript:, blob:, and file: schemes', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined();
    expect(safeHref('blob:https://app/abc')).toBeUndefined();
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
  });

  it('returns undefined for empty / nullish input', () => {
    expect(safeHref('')).toBeUndefined();
    expect(safeHref('   ')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });

  it('passes relative and same-origin references through (no scheme to abuse)', () => {
    expect(safeHref('/estimates/E00001')).toBe('/estimates/E00001');
    expect(safeHref('#section')).toBe('#section');
    expect(safeHref('?token=x')).toBe('?token=x');
    expect(safeHref('vendor/page')).toBe('vendor/page'); // path-relative, ":" absent
  });

  it('does not misclassify a path that contains a colon after the first slash', () => {
    expect(safeHref('/path/with:colon')).toBe('/path/with:colon');
  });
});
