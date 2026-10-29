import { describe, it, expect } from 'vitest';
import { redactUrl } from '../lib/log-redact';

describe('redactUrl', () => {
  it('redacts a token query value but keeps the path and key name', () => {
    expect(redactUrl('/api/auth/invite?token=abc123.sig')).toBe('/api/auth/invite?token=REDACTED');
  });

  it('returns the url unchanged when there is no query string', () => {
    expect(redactUrl('/api/auth/invite')).toBe('/api/auth/invite');
  });

  it('preserves non-sensitive params and only redacts sensitive ones', () => {
    const out = redactUrl('/api/leads?page=2&token=secretvalue&status=OPEN');
    expect(out).toContain('page=2');
    expect(out).toContain('status=OPEN');
    expect(out).toContain('token=REDACTED');
    expect(out).not.toContain('secretvalue');
  });

  it('redacts every sensitive key family', () => {
    const raw =
      '/x?secret=s1&password=p1&otp=111111&code=abcd&access_token=t1&refresh_token=t2&api_key=k1&apikey=k2&signature=g1&sig=g2&invite_token=i1';
    const out = redactUrl(raw);
    for (const leaked of ['s1', 'p1', '111111', 'abcd', 't1', 't2', 'k1', 'k2', 'g1', 'g2', 'i1']) {
      expect(out).not.toContain(leaked);
    }
    // key names remain so logs stay useful
    expect(out).toContain('secret=REDACTED');
    expect(out).toContain('access_token=REDACTED');
  });

  it('matches sensitive keys case-insensitively', () => {
    const out = redactUrl('/x?Token=leak1&SECRET=leak2&PassWord=leak3');
    expect(out).not.toContain('leak1');
    expect(out).not.toContain('leak2');
    expect(out).not.toContain('leak3');
    expect(out).toBe('/x?Token=REDACTED&SECRET=REDACTED&PassWord=REDACTED');
  });

  it('redacts all occurrences of a repeated sensitive key', () => {
    const out = redactUrl('/x?token=one&token=two');
    expect(out).not.toContain('one');
    expect(out).not.toContain('two');
  });
});
