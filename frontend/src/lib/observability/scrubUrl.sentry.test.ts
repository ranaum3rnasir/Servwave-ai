// V7-07a fix round 2: a scrub must never throw or drop. These run through the REAL SDK (no mock), because the first
// version threw on the SDK's own span objects (getter-only properties) and killed every transaction.
import { describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/react';

import { scrubEventUrls } from './scrubUrl';
import { sentryBaseOptions } from './sentryBase';

const PAY = 'https://pay.test/p/secret-token';
const COMPOSE = `/communication/inbox?compose=1&to=dana%40example.com&subject=Failed&body=${encodeURIComponent(PAY)}&customerId=c-1&mailbox=mine`;
const leaks = (v: unknown) => /secret-token|dana%40|subject=Failed/.test(JSON.stringify(v));

describe('a scrub never throws and never drops', () => {
  it('survives a getter-only property and a frozen object, returning the payload', () => {
    const getterOnly = {};
    Object.defineProperty(getterOnly, 'description', { get: () => `GET ${COMPOSE}`, enumerable: true });
    Object.defineProperty(getterOnly, '$', { get: () => 1, enumerable: true });
    const event = { spans: [getterOnly], request: Object.freeze({ url: COMPOSE }) };
    let out: unknown;
    expect(() => { out = scrubEventUrls(event); }).not.toThrow();
    expect(out).toBeTruthy();
    expect(leaks((out as typeof event).request)).toBe(false);
    expect(leaks((out as typeof event).spans)).toBe(false);
  });

  it('returns the original payload when something unexpected throws', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    expect(scrubEventUrls(hostile)).toBe(hostile);
  });
});

describe('a real transaction from the SDK', () => {
  it('is sent (not dropped), through the base hooks and the event processor, with its url fields scrubbed', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const errors: unknown[] = [];
    const base = sentryBaseOptions();
    Sentry.init({
      dsn: 'https://key@o0.ingest.sentry.io/1',
      tracesSampleRate: 1,
      beforeSend: base.beforeSend,
      beforeBreadcrumb: base.beforeBreadcrumb,
      beforeSendTransaction: (tx) => { const out = base.beforeSendTransaction(tx); sent.push(out as never); return out; },
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      integrations: [],
    });
    Sentry.addEventProcessor((e) => { if (!e.transaction && e.exception) errors.push(e); return e; });
    Sentry.addEventProcessor(scrubEventUrls);
    Sentry.startSpan({ name: COMPOSE, op: 'pageload', attributes: { 'url.full': `https://app.test${COMPOSE}`, 'url.query': COMPOSE.split('?')[1]! } }, () => {
      Sentry.startInactiveSpan({ name: `GET https://app.test${COMPOSE}`, attributes: { 'http.url': `https://app.test${COMPOSE}` } }).end();
    });
    await Sentry.flush(2000);
    expect(errors).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'transaction' });
    expect((sent[0]!.spans as unknown[]).length).toBe(1);
    expect(leaks(sent[0])).toBe(false);
  });
});
