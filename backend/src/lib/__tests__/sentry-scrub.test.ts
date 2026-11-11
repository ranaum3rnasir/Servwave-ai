/**
 * Error reports never carry a reset token or a password (conductor brief §3.3: "never logged:
 * check request loggers, Sentry breadcrumbs and audit metadata").
 *
 * The backend reports with local variables and request data turned on (instrument.ts), so a throw
 * inside the reset path would otherwise ship the token and the new password in a frame's locals or
 * in the request body. Seam: the event the SDK is about to send, before and after the hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { scrubSentryEvent } from '../sentry-scrub';

const secret = () => randomBytes(16).toString('base64url');

describe('scrubSentryEvent', () => {
  it('removes sensitive values from stack-frame locals, at any depth', () => {
    const token = secret();
    const password = secret();
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: '/app/src/lib/other.ts', vars: { count: 3, parsed: { data: { token, password } }, token_hash: token } },
              ],
            },
          },
        ],
      },
    };

    const out = JSON.stringify(scrubSentryEvent(event));

    expect(out).not.toContain(token);
    expect(out).not.toContain(password);
    expect(out).toContain('"count":3');
  });

  it('drops every local of a frame in the password code, whatever the variable is called', () => {
    const password = secret();
    const event = {
      exception: { values: [{ stacktrace: { frames: [{ filename: '/app/src/lib/password-reset.ts', vars: { s: password } }] } }] },
    };

    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(password);
  });

  it('removes sensitive fields from the request body, as an object or as text', () => {
    const token = secret();
    const password = secret();
    for (const data of [{ token, password, email: 'a@b.c' }, JSON.stringify({ token, password, email: 'a@b.c' })]) {
      const out = JSON.stringify(scrubSentryEvent({ request: { url: 'https://api.test/api/auth/password/reset', data } }));
      expect(out).not.toContain(token);
      expect(out).not.toContain(password);
    }
  });

  it('drops a request body it cannot read on a password route', () => {
    const password = secret();
    const out = scrubSentryEvent({ request: { url: 'https://api.test/api/auth/password/reset', data: `token=x&password=${password}` } });
    expect(JSON.stringify(out)).not.toContain(password);
  });

  it('masks tokens in request and breadcrumb URLs', () => {
    const token = secret();
    const out = scrubSentryEvent({
      request: { url: `https://app.test/reset-password?token=${token}`, query_string: `token=${token}` },
      breadcrumbs: [{ category: 'http', data: { url: `https://app.test/accept-invite?token=${token}` } }],
    });
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it('masks the URL token of an inbound vendor webhook even when the URL has no query string (#3446)', () => {
    const token = 'a1b2'.repeat(16);
    const out = scrubSentryEvent({
      request: { url: `https://api.test/api/webhooks/web-form/forminator/${token}` },
      breadcrumbs: [{ category: 'http', data: { url: `/api/webhooks/call-tracking/callrail/${token}/post` } }],
    });
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).toContain('/api/webhooks/web-form/forminator/REDACTED');
  });

  it('drops a webhook request\'s whole query string, whose keys the vendor chooses (#3446)', () => {
    const out = scrubSentryEvent({
      request: {
        url: 'https://api.test/api/webhooks/call-tracking/callrail/x1y2z3/pre?callername=DOE%2CJANE',
        query_string: 'callername=DOE%2CJANE&callernum=%2B16095550123',
      },
    });
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('DOE');
    expect(flat).not.toContain('6095550123');
  });

  it('cleans a sampled trace of a webhook request: span attributes, span descriptions and the transaction name (#3446)', () => {
    const token = 'b2c3'.repeat(16);
    const url = `https://api.test/api/webhooks/call-tracking/callrail/${token}/pre?callername=DOE%2CJANE&callernum=%2B16095550123`;
    const attrs = {
      'url.full': url,
      'http.url': url,
      'http.target': `/api/webhooks/call-tracking/callrail/${token}/pre?callername=DOE%2CJANE`,
      'url.path': `/api/webhooks/call-tracking/callrail/${token}/pre`,
      'url.query': 'callername=DOE%2CJANE&callernum=%2B16095550123',
      'http.method': 'POST',
    };
    const out = scrubSentryEvent({
      type: 'transaction',
      transaction: `POST /api/webhooks/call-tracking/callrail/${token}/pre`,
      contexts: { trace: { data: attrs }, otel: { attributes: attrs } },
      spans: [{ description: `POST /api/webhooks/call-tracking/callrail/${token}/pre`, data: attrs }],
    });
    const flat = JSON.stringify(out);
    for (const leaked of [token, 'DOE', '6095550123']) expect(flat).not.toContain(leaked);
    expect(flat).toContain('POST /api/webhooks/call-tracking/callrail/REDACTED/pre');
    expect((out as any).contexts.trace.data['http.method']).toBe('POST');
  });

  it('leaves the trace of an ordinary request as it was', () => {
    const event = {
      type: 'transaction',
      transaction: 'GET /api/leads',
      contexts: { trace: { data: { 'url.full': 'https://api.test/api/leads?page=2', 'url.query': 'page=2' } } },
    };
    expect(scrubSentryEvent(event)).toBe(event);
  });

  it('masks one-time codes and tokens in a request query string sent as [key, value] pairs', () => {
    const otp = secret();
    const token = secret();
    const out = scrubSentryEvent({
      request: { query_string: [['email_otp', otp], ['token', token], ['page', '2']] },
    }) as { request: { query_string: string[][] } };

    expect(JSON.stringify(out)).not.toContain(otp);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.request.query_string).toEqual([['email_otp', '[Filtered]'], ['token', '[Filtered]'], ['page', '2']]);
  });

  /** A frame from a vendor SDK, outside the password code, so only key and URL rules apply. */
  const vendorFrame = (vars: Record<string, unknown>) => ({
    exception: { values: [{ stacktrace: { frames: [{ filename: '/app/node_modules/vendor-sdk/dist/client.js', vars }] } }] },
  });

  it('removes one-time codes and action links from frame locals, whatever they are called', () => {
    const otp = secret();
    const link = secret();
    const out = JSON.stringify(
      scrubSentryEvent(vendorFrame({ email_otp: otp, otp_code: otp, properties: { action_link: link, verification_type: 'recovery' } })),
    );

    expect(out).not.toContain(otp);
    expect(out).not.toContain(link);
    expect(out).toContain('"verification_type":"recovery"');
  });

  it("masks a vendor's signing key held in a frame local, under any spelling of `…key` (#3446)", () => {
    const out = scrubSentryEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: '/app/src/controllers/call-tracking-webhook.controller.ts',
                  vars: {
                    integration: { id: 'i1', organization_id: 'o1', signing_key: 'sk-test-1' },
                    signingKey: 'sk-test-2',
                    PRIVATE_KEY: 'sk-test-3',
                    sortOrder: 'newest',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const flat = JSON.stringify(out);
    for (const leaked of ['sk-test-1', 'sk-test-2', 'sk-test-3']) expect(flat).not.toContain(leaked);
    expect(flat).toContain('"sortOrder":"newest"');
    expect(flat).toContain('"organization_id":"o1"');
  });

  it('masks a token inside a URL-valued string in a vendor frame, at any depth', () => {
    const token = secret();
    const out = JSON.stringify(
      scrubSentryEvent(
        vendorFrame({
          href: `https://auth.example/verify?token=${token}&type=recovery`,
          nested: { list: [`/reset-password?token=${token}`], redirect: `https://app.test/x?a=1&access_token=${token}` },
        }),
      ),
    );

    expect(out).not.toContain(token);
    expect(out).toContain('type=recovery');
  });

  it('leaves locals that are not URLs, or URLs with nothing sensitive, as they were', () => {
    const vars = { note: 'token= is fine in prose? yes', plain: 'https://app.test/jobs?page=2', count: 1, word: 'footprint', otpless: false };
    expect(scrubSentryEvent(vendorFrame(vars))).toEqual(vendorFrame(vars));
  });

  it('leaves an event with nothing sensitive as it was', () => {
    const event = { message: 'boom', request: { url: 'https://api.test/api/jobs' }, extra: { jobId: 'j-1' } };
    expect(scrubSentryEvent(event)).toEqual(event);
  });
});

describe('instrument.ts applies it to everything the SDK sends', () => {
  it.each(['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb'])('%s', async (hook) => {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init }));
    await import('../../instrument.js');
    const token = secret();

    const options = init.mock.calls[0][0] as Record<string, (e: unknown) => unknown>;
    const out = options[hook]!({ request: { url: `https://app.test/reset-password?token=${token}` }, data: { url: `/x?token=${token}` } });

    expect(JSON.stringify(out)).not.toContain(token);
    vi.doUnmock('@sentry/node');
  });
});
