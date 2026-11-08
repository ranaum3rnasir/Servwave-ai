import { describe, it, expect } from 'vitest';
import { parseAddress, sanitizeEmailHtml } from '../lib/email-html';

describe('parseAddress', () => {
  it('parses quoted display-name addresses', () => {
    expect(parseAddress('"Angel Miller" <angel@example.com>')).toEqual({
      name: 'Angel Miller',
      email: 'angel@example.com',
    });
  });

  it('parses bare addresses', () => {
    expect(parseAddress('angel@example.com')).toEqual({
      name: 'angel@example.com',
      email: 'angel@example.com',
    });
  });

  it('parses unquoted display names and lowercases the email', () => {
    expect(parseAddress('Angel <Angel@Example.com>')).toEqual({
      name: 'Angel',
      email: 'angel@example.com',
    });
  });

  it('is safe on empty input', () => {
    expect(parseAddress('')).toEqual({ name: '', email: '' });
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips scripts and inline event handlers', () => {
    const out = sanitizeEmailHtml('<p onclick="x()">hi</p><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });

  it('keeps basic formatting and https images', () => {
    const out = sanitizeEmailHtml('<p><b>bold</b></p><img src="https://x.com/a.png" alt="a">');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('https://x.com/a.png');
  });

  it('drops cid: inline image sources (unresolvable in the mirror)', () => {
    const out = sanitizeEmailHtml('<img src="cid:part1.abc" alt="logo">');
    expect(out).not.toContain('cid:');
  });

  it('forces safe link targets', () => {
    const out = sanitizeEmailHtml('<a href="https://x.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
  });

  it('removes iframes entirely', () => {
    expect(sanitizeEmailHtml('<iframe src="https://evil.com"></iframe>ok')).not.toContain('iframe');
  });
});
