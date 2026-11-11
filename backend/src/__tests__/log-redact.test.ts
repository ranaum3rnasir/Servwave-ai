import { describe, it, expect } from 'vitest';
import { redactUrl, redactWebhookUrlsIn } from '../lib/log-redact';

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
  describe('inbound vendor webhooks (/api/webhooks/...) log their route shape only (#3446)', () => {
    const TOKEN = 'ad1b7e6f00000000000000000000000000000000000000000000000000c0ffee';

    it('masks the URL token in the path and drops every query value, keeping provider and phase', () => {
      const out = redactUrl(
        `/api/webhooks/call-tracking/callrail/${TOKEN}/pre?callername=DOE%2CJANE&callernum=%2B16095550123&recording=https%3A%2F%2Fx.test%2Fr%3Faccess_key%3Dk1`,
      );
      expect(out).toBe('/api/webhooks/call-tracking/callrail/REDACTED/pre?REDACTED');
      for (const leaked of [TOKEN, 'DOE', '6095550123', 'access_key', 'k1']) expect(out).not.toContain(leaked);
    });

    it('masks the token of a receiver with no query string and no phase', () => {
      expect(redactUrl(`/api/webhooks/web-form/forminator/${TOKEN}`)).toBe('/api/webhooks/web-form/forminator/REDACTED');
    });

    it('drops the query of the phone-system receiver too (generic rule, not a key list)', () => {
      expect(redactUrl('/api/webhooks/ctm/starts?token=t-secret&caller_number=%2B16095550123')).toBe(
        '/api/webhooks/ctm/starts?REDACTED',
      );
    });

    it('keeps a plain receiver path untouched', () => {
      expect(redactUrl('/api/webhooks/stripe')).toBe('/api/webhooks/stripe');
    });

    it('treats an absolute URL the same way (error reports carry those)', () => {
      expect(redactUrl(`https://api.example.com/api/webhooks/web-form/forminator/${TOKEN}?x=1`)).toBe(
        'https://api.example.com/api/webhooks/web-form/forminator/REDACTED?REDACTED',
      );
    });

    it('masks any segment that is not a plain word, so a short or mixed-case token is caught too', () => {
      expect(redactUrl('/api/webhooks/web-form/forminator/Ab12')).toBe('/api/webhooks/web-form/forminator/REDACTED');
      expect(redactUrl('/api/webhooks/web-form/forminator/a%2Fb')).toBe('/api/webhooks/web-form/forminator/REDACTED');
    });

    it('does not touch a path that only starts with the same letters', () => {
      expect(redactUrl('/api/webhooks-health/abc123')).toBe('/api/webhooks-health/abc123');
      expect(redactUrl('/api/leads/3f2a9c1e-0000-4000-8000-000000000001')).toBe(
        '/api/leads/3f2a9c1e-0000-4000-8000-000000000001',
      );
    });

    it('finds a webhook address anywhere inside a longer text', () => {
      expect(
        redactWebhookUrlsIn(`POST https://api.example.com/api/webhooks/web-form/forminator/${TOKEN}?phone_1=6095550123 failed`),
      ).toBe('POST https://api.example.com/api/webhooks/web-form/forminator/REDACTED?REDACTED failed');
      expect(redactWebhookUrlsIn('GET /api/leads?page=2')).toBe('GET /api/leads?page=2');
    });

    it("drops the whole query even when it holds a quote, as a raw URL can (a caller named O'Brien)", () => {
      const url = `/api/webhooks/call-tracking/callrail/${TOKEN}/post?callername=Sean%20O'Brien&callernum=%2B16095550123`;
      expect(redactWebhookUrlsIn(`POST ${url} 500`)).toBe('POST /api/webhooks/call-tracking/callrail/REDACTED/post?REDACTED 500');
      expect(redactUrl(url)).toBe('/api/webhooks/call-tracking/callrail/REDACTED/post?REDACTED');
      expect(redactWebhookUrlsIn(`/api/webhooks/web-form/forminator/${TOKEN}?'&phone_1=6095550123`)).toBe(
        '/api/webhooks/web-form/forminator/REDACTED?REDACTED',
      );
    });

    it("keeps a route parameter's name and an optional parameter's mark, which are never a credential", () => {
      expect(redactWebhookUrlsIn('POST /api/webhooks/call-tracking/:provider/:urlToken/:phase?')).toBe(
        'POST /api/webhooks/call-tracking/:provider/:urlToken/:phase?',
      );
    });
  });
});
