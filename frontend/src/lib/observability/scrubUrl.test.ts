// V7-07a (C-27): the Email compose address can carry an invoice's pay link in `body`. Nothing the SDK sends may hold it.
import { describe, expect, it, vi } from 'vitest';

const PAY = 'https://pay.test/p/secret-token';
const COMPOSE =
  `/communication/inbox?compose=1&to=dana%40example.com&subject=Bank+payment+failed&body=${encodeURIComponent(PAY)}&customerId=c-1&jobId=j-1&invoiceId=i-1&mailbox=box-main`;

const added = vi.hoisted(() => ({ integration: undefined as undefined | { _initialOptions?: Record<string, unknown>; _recordingOptions?: Record<string, unknown> }, processors: [] as unknown[] }));
vi.mock('@sentry/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/react')>();
  return {
    ...actual,
    getClient: () => ({ addIntegration: (i: never) => { added.integration = i; } }),
  };
});

import { scrubComposeParams, scrubEventUrls } from './scrubUrl';
import { sentryBaseOptions } from './sentryBase';
import { addSessionReplay } from './replay';

const leaks = (v: unknown) => JSON.stringify(v).includes('secret-token') || JSON.stringify(v).includes('dana%40') || JSON.stringify(v).includes('Bank+payment');

describe('scrubComposeParams', () => {
  it('removes every compose parameter and keeps the rest', () => {
    expect(scrubComposeParams(COMPOSE)).toBe('/communication/inbox?mailbox=box-main');
  });
  it('drops the question mark when nothing is left, and keeps an absolute origin and a fragment', () => {
    expect(scrubComposeParams('https://app.example.test/communication/inbox?compose=1&to=a%40b.c#x')).toBe('https://app.example.test/communication/inbox#x');
  });
  it('works inside a span description and on a bare query string', () => {
    expect(scrubComposeParams(`navigation ${COMPOSE}`)).toBe('navigation /communication/inbox?mailbox=box-main');
    expect(scrubComposeParams('compose=1&to=a%40b.c&mailbox=m')).toBe('mailbox=m');
  });
  it('leaves other addresses, including ones with a to or body parameter, alone', () => {
    for (const u of ['/payments?tab=payouts', '/x?to=1&body=2', 'no url at all']) expect(scrubComposeParams(u)).toBe(u);
  });
});

describe('scrubEventUrls and where the SDK sends addresses', () => {
  it('scrubs an error event (request url, breadcrumbs)', () => {
    const event = scrubEventUrls({
      request: { url: `https://app.test${COMPOSE}`, query_string: COMPOSE.split('?')[1] },
      breadcrumbs: [{ category: 'navigation', data: { from: COMPOSE, to: '/payments' } }, { category: 'fetch', data: { url: '/api/x' } }],
    });
    expect(leaks(event)).toBe(false);
    expect(event.breadcrumbs[1]!.data.url).toBe('/api/x');
  });
  it('scrubs a transaction (trace url.full, span descriptions and data)', () => {
    const tx = scrubEventUrls({
      request: { url: `https://app.test${COMPOSE}` },
      contexts: { trace: { data: { 'url.full': `https://app.test${COMPOSE}`, 'url.query': COMPOSE.split('?')[1] } } },
      spans: [{ description: `GET https://app.test${COMPOSE}`, data: { 'http.url': `https://app.test${COMPOSE}` } }],
    });
    expect(leaks(tx)).toBe(false);
  });
  it('scrubs a replay event (urls) and a recording event (page meta href)', () => {
    expect(leaks(scrubEventUrls({ type: 'replay_event', urls: [`https://app.test${COMPOSE}`] }))).toBe(false);
    expect(leaks(scrubEventUrls({ type: 4, data: { href: `https://app.test${COMPOSE}` } }))).toBe(false);
  });
});

describe('every hook applies it', () => {
  const opts = sentryBaseOptions() as unknown as Record<string, (x: unknown) => unknown>;
  it.each(['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb'])('%s', (hook) => {
    expect(leaks(opts[hook]!({ request: { url: COMPOSE }, data: { from: COMPOSE } }))).toBe(false);
  });
  it('the replay recorder scrubs recording events', () => {
    addSessionReplay();
    const hook = (added.integration!._initialOptions as Record<string, (x: unknown) => unknown>).beforeAddRecordingEvent;
    expect(leaks(hook!({ type: 4, data: { href: COMPOSE } }))).toBe(false);
  });
});

describe('both entries register the scrubber as an event processor', () => {
  it.each(['../../instrument', '../../instrument-public'])('%s', async (entry) => {
    vi.resetModules();
    const calls: Array<(e: unknown) => unknown> = [];
    vi.doMock('@sentry/react', () => ({
      init: vi.fn(),
      addEventProcessor: (fn: (e: unknown) => unknown) => calls.push(fn),
      reactRouterV7BrowserTracingIntegration: vi.fn(),
      getClient: vi.fn(),
    }));
    await import(/* @vite-ignore */ entry);
    expect(calls).toHaveLength(1);
    expect(leaks(calls[0]!({ urls: [COMPOSE] }))).toBe(false);
    vi.doUnmock('@sentry/react');
  });
});

// Password reset spec §5.2 / conductor brief §3.3: a reset link's token (and an invite's) is a live credential. The
// page strips it from the address bar on load, but the SDK sees the address first (page-load transaction, navigation
// breadcrumbs, replay URLs).
describe('reset and invite link tokens', () => {
  const TOKEN = 'a1b2c3d4e5f6-live-reset-token';
  const RESET = `/reset-password?token=${TOKEN}`;
  const INVITE = `/accept-invite?token=${TOKEN}&x=1`;
  const holds = (v: unknown) => JSON.stringify(v).includes(TOKEN);

  it('removes the token from the address and keeps the rest', () => {
    expect(scrubComposeParams(`https://app.example.test${RESET}`)).toBe('https://app.example.test/reset-password');
    expect(scrubComposeParams(INVITE)).toBe('/accept-invite?x=1');
    expect(scrubComposeParams(`token=${TOKEN}&x=1`)).toBe('x=1');
  });

  it('scrubs it from a page-load transaction, breadcrumbs and a replay', () => {
    expect(holds(scrubEventUrls({
      transaction: RESET,
      request: { url: `https://app.example.test${RESET}`, query_string: `token=${TOKEN}` },
      contexts: { trace: { data: { 'url.full': `https://app.example.test${RESET}`, 'url.query': `?token=${TOKEN}` } } },
      spans: [{ description: `pageload ${RESET}`, data: { 'http.url': `https://app.example.test${RESET}` } }],
      breadcrumbs: [{ category: 'navigation', data: { from: RESET, to: '/reset-password' } }],
    }))).toBe(false);
    expect(holds(scrubEventUrls({ type: 'replay_event', urls: [`https://app.example.test${INVITE}`] }))).toBe(false);
    expect(holds(scrubEventUrls({ type: 4, data: { href: `https://app.example.test${RESET}` } }))).toBe(false);
  });

  it('every hook applies it', () => {
    const opts = sentryBaseOptions() as unknown as Record<string, (x: unknown) => unknown>;
    for (const hook of ['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb']) {
      expect(holds(opts[hook]!({ request: { url: RESET }, data: { from: RESET } }))).toBe(false);
    }
  });
});
