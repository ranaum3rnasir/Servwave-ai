// How the vendor console filter sits next to Sentry's console breadcrumbs, measured with the
// real SDK rather than assumed.
//
// src/instrument.ts runs Sentry.init first. With a DSN set, the default Breadcrumbs
// integration wraps console.* during init, so the filter (imported right after) wraps
// Sentry's wrapper. A dropped line therefore never reaches Sentry at all, and a renamed
// error reaches it already renamed. This file reproduces that order on the real global
// console: spy (stands in for the browser's output) -> Sentry.init -> import the filter.
//
// Its own file because both Sentry.init and the filter's import-time install patch the
// global console for the rest of the file.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as Sentry from '@sentry/react';
import type { Breadcrumb } from '@sentry/react';

const crumbs: Breadcrumb[] = [];
// Every envelope the client would have sent, serialised the way the wire sees it. The
// in-memory breadcrumb is NOT what reaches Sentry: the SDK normalises event data to
// normalizeDepth (default 3, as in src/instrument.ts) first, and anything deeper becomes
// "[Object]" / "[Array]".
const sentEnvelopes: string[] = [];
const output = {
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
};

function consoleCrumbs() {
  return crumbs.filter((c) => c.category === 'console');
}

function reset() {
  crumbs.length = 0;
  output.log.mockClear();
  output.error.mockClear();
}

beforeAll(() => {
  Sentry.init({
    // A syntactically valid DSN enables the client (and so its integrations); the
    // transport below means nothing is ever sent.
    dsn: 'https://public@o0.ingest.sentry.io/0',
    transport: () => ({
      send: async (envelope: unknown) => {
        sentEnvelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
    beforeBreadcrumb(crumb) {
      crumbs.push(crumb);
      return crumb;
    },
  });
});

describe('vendor console filter vs Sentry console breadcrumbs', () => {
  it('without the filter, a vendor line becomes a Sentry breadcrumb (the control)', () => {
    reset();
    console.log('[CTM Embed] requesting access', { url: '/x' });
    expect(consoleCrumbs().map((c) => c.message)).toContain('[CTM Embed] requesting access [object Object]');
    expect(output.log).toHaveBeenCalledTimes(1);
  });

  describe('once the filter is imported after Sentry.init', () => {
    beforeAll(async () => {
      await import('../vendorConsoleFilter');
    });

    it('a dropped vendor line reaches neither the output nor Sentry', () => {
      reset();
      console.log('[CTM Embed] requesting access', { url: '/x' });
      console.log('attach ctm-phone-skeleton');
      expect(output.log).not.toHaveBeenCalled();
      expect(consoleCrumbs()).toHaveLength(0);
    });

    it('a renamed error reaches Sentry already renamed', () => {
      reset();
      console.error('[CTM Embed] access request failed', { url: '/x' });
      const messages = consoleCrumbs().map((c) => String(c.message));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^\[Phone\] access request failed/);
      expect(messages.join(' ')).not.toContain('CTM');
      expect(output.error).toHaveBeenCalledWith('[Phone] access request failed', { url: '/x' });
    });

    // Part 2 (Ran, 2026-10-02): the breadcrumb's data carries the console arguments, so they
    // must reach Sentry already sanitised too - no stack, no vendor element, no vendor token.
    it("a renamed error's breadcrumb carries no vendor token anywhere in its data", () => {
      reset();
      const error = new TypeError('Failed to fetch');
      error.stack =
        'TypeError: Failed to fetch\n    at CtmPhoneEmbed.fetchUserAccess (https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js:1:61700)';
      const script = document.createElement('script');
      script.dataset.ctmDeviceEmbedScript = 'true';
      script.src = 'https://app.calltrackingmetrics.com/x.js';
      const event = new Event('error');
      script.dispatchEvent(event);
      // Preconditions: the raw values really do name the vendor.
      expect(error.stack).toMatch(/calltrackingmetrics/);
      expect(event.target).toBe(script);

      console.error('[CTM Embed] access request failed', { url: '/api/ctm/access', error });
      console.error('[CTM Embed] device embed script failed', event);

      const found = consoleCrumbs();
      expect(found).toHaveLength(2);
      for (const crumb of found) {
        // Something to check, or "no vendor token" proves nothing.
        expect(crumb.data).toBeDefined();
        const args = (crumb.data as { arguments?: unknown[] }).arguments;
        expect(Array.isArray(args)).toBe(true);
        expect(args).toHaveLength(2);
        const dump = JSON.stringify(crumb);
        expect(dump.length).toBeGreaterThan(2);
        expect(dump).not.toMatch(/ctm|calltracking/i);
      }
      expect((found[0]!.data as { arguments: unknown[] }).arguments[1]).toEqual({
        url: '/api/[redacted]/access',
        error: 'TypeError: Failed to fetch',
      });
      expect((found[1]!.data as { arguments: unknown[] }).arguments[1]).toEqual({ type: 'error' });
    });

    // Verifier finding on #2389: a nested error copied to { name, message } sat one level
    // below normalizeDepth, so the SENT breadcrumb read "error":"[Object]" - before the
    // sanitiser it read "[TypeError]". The error class and message must survive the wire.
    it("the SENT envelope's breadcrumb still names the error, with no vendor token", async () => {
      reset();
      sentEnvelopes.length = 0;
      // Earlier tests left breadcrumbs on the scope, including the pre-filter control's raw
      // vendor line. Start clean so the whole serialised envelope can be checked.
      Sentry.getIsolationScope().clearBreadcrumbs();
      Sentry.getCurrentScope().clearBreadcrumbs();
      const error = new TypeError('Failed to fetch');
      error.stack =
        'TypeError: Failed to fetch\n    at CtmPhoneEmbed.fetchUserAccess (https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js:1:61700)';
      console.error('[CTM Embed] access request failed', { url: '/api/ctm/access', error });
      Sentry.captureMessage('envelope probe');
      await Sentry.flush(2000);

      const withCrumb = sentEnvelopes.filter((e) => e.includes('[Phone] access request failed'));
      // Something was sent and it carries the breadcrumb, or the checks below prove nothing.
      expect(withCrumb).toHaveLength(1);
      const wire = withCrumb[0]!;
      expect(wire.length).toBeGreaterThan(2);
      expect(wire).toContain('"error":"TypeError: Failed to fetch"');
      expect(wire).toContain('"url":"/api/[redacted]/access"');
      expect(wire).not.toContain('"error":"[Object]"');
      expect(wire).not.toMatch(/calltracking|ctm/i);
    });

    it('an ordinary log still becomes a breadcrumb and still prints', () => {
      reset();
      console.log('ordinary app log', 1);
      expect(consoleCrumbs().map((c) => c.message)).toEqual(['ordinary app log 1']);
      expect(output.log).toHaveBeenCalledWith('ordinary app log', 1);
    });
  });
});
