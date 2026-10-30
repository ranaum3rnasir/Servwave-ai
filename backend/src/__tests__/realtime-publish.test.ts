/* =============================================================================
   Roles & Permissions (scenario pass 2, third timing re-check): the live-update pings must not starve the service.

   Every ping used to be its own channel object and its own request to the live service (about 100 per alert). That is
   CPU on the one thread that also answers requests: invisible on a laptop, seconds on the small hosted instance, during
   which even a 404 or the health probe waited (measured: GET /health 2.4 s while a Reopen was in flight). A roster is now
   a few batched requests, sent after the response has been written, with the loop handed back between requests.

   Seam: publishNotificationsChanged / publishEmailsChanged and the one thing they call, the global fetch to the live
   service's broadcast door.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import {
  publishNotificationsChanged,
  publishEmailsChanged,
  flushRealtimePublishes,
  runWithPingScope,
} from '../services/notifications/realtimePublish';

const ORG_ID = 'org-aaaa-0000-0000-000000000001';
const USER_A = 'user-aaaa-0000-0000-000000000001';
const USER_B = 'user-bbbb-0000-0000-000000000002';
const BROADCAST_URL = 'https://test.supabase.co/realtime/v1/api/broadcast';

interface Message { topic: string; event: string; payload: unknown; private: boolean }

const fetchStub = vi.fn();
const bodiesOf = (): Message[][] =>
  fetchStub.mock.calls.map((c) => (JSON.parse((c[1] as { body: string }).body) as { messages: Message[] }).messages);

/** CPU spent by one call to the live service, in whichever form a sender makes it. */
let burnMs = 0;
function burn(): void {
  const end = performance.now() + burnMs;
  while (performance.now() < end) { /* CPU */ }
}

/** A client channel per person is another way to reach the live service; it is stubbed too, so that path shows up as well. */
let channelsMade = 0;
function installClientChannels() {
  const admin = supabaseAdmin as unknown as Record<string, unknown>;
  admin.channel = () => {
    channelsMade += 1;
    return { send: async () => { burn(); return 'ok'; } };
  };
  admin.removeChannel = async () => 'ok';
}

beforeEach(() => {
  vi.clearAllMocks();
  channelsMade = 0;
  burnMs = 0;
  fetchStub.mockReset();
  fetchStub.mockImplementation(async () => {
    burn();
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal('fetch', fetchStub);
  installClientChannels();
});

afterEach(async () => {
  await flushRealtimePublishes();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('publishNotificationsChanged', () => {
  it('posts one message per recipient on the same private topic, event and payload a subscriber listens for', async () => {
    await publishNotificationsChanged([USER_A, USER_B], ORG_ID);
    await flushRealtimePublishes();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]![0]).toBe(BROADCAST_URL);
    const init = fetchStub.mock.calls[0]![1] as { method: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ apikey: 'test-service-role-key', Authorization: 'Bearer test-service-role-key', 'Content-Type': 'application/json' });
    expect(bodiesOf()[0]).toEqual([
      { topic: `org:${ORG_ID}:user:${USER_A}`, event: 'notifications.changed', payload: { type: 'notifications.changed' }, private: true },
      { topic: `org:${ORG_ID}:user:${USER_B}`, event: 'notifications.changed', payload: { type: 'notifications.changed' }, private: true },
    ]);
  });

  it('sends the email-list event on its own event name, in the same batch as other events', async () => {
    await publishNotificationsChanged([USER_A], ORG_ID);
    await publishEmailsChanged([USER_B], ORG_ID);
    await flushRealtimePublishes();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(bodiesOf()[0]!.map((m) => [m.topic, m.event, m.payload])).toEqual([
      [`org:${ORG_ID}:user:${USER_A}`, 'notifications.changed', { type: 'notifications.changed' }],
      [`org:${ORG_ID}:user:${USER_B}`, 'emails.changed', { type: 'emails.changed' }],
    ]);
  });

  it('resolves, throws nothing and logs one warning when the service cannot be reached, and sends the next batch anyway', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
    fetchStub.mockRejectedValueOnce(new Error('network error'));
    const roster = Array.from({ length: 150 }, (_, i) => `user-${i}`);

    await expect(publishNotificationsChanged(roster, ORG_ID)).resolves.toBeUndefined();
    await flushRealtimePublishes();

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('realtimePublish');
  });

  it('logs the refusal when the service answers with an error status', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
    fetchStub.mockResolvedValueOnce(new Response('nope', { status: 401 }));

    await publishNotificationsChanged([USER_A], ORG_ID);
    await flushRealtimePublishes();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('401');
  });

  it('gives up on a request that never answers, after the give-up time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const warn = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
      fetchStub.mockImplementation(() => new Promise<never>(() => {}));
      await publishNotificationsChanged([USER_A], ORG_ID);

      const drained = flushRealtimePublishes();
      await vi.advanceTimersByTimeAsync(15_000);
      await drained;

      expect(String(warn.mock.calls[0]![0])).toContain('gave up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves void for an empty recipient list and sends nothing', async () => {
    await expect(publishNotificationsChanged([], ORG_ID)).resolves.toBeUndefined();
    await flushRealtimePublishes();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('never references supabaseAdmin.auth', async () => {
    const auth = vi.fn();
    Object.defineProperty(supabaseAdmin, 'auth', { get: auth, configurable: true });
    try {
      await publishNotificationsChanged([USER_A], ORG_ID);
      await flushRealtimePublishes();
      expect(auth).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(supabaseAdmin, 'auth');
    }
  });
});

describe('what an alert to a whole company costs', () => {
  const roster = Array.from({ length: 300 }, (_, i) => `user-${i}`);

  it('makes a handful of requests for 300 recipients and creates no client channel', async () => {
    await publishNotificationsChanged(roster, ORG_ID);
    await flushRealtimePublishes();

    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(Math.ceil(300 / 100));
    expect(channelsMade).toBe(0);
    const topics = bodiesOf().flat().map((m) => m.topic);
    expect(topics).toHaveLength(300);
    expect(new Set(topics)).toEqual(new Set(roster.map((id) => `org:${ORG_ID}:user:${id}`)));
  });

  it('never holds the event loop for long while 300 pings drain through a transport that costs CPU per call', async () => {
    // Each call to the live service costs CPU on the one thread; a sender that starts many of them in the same turn
    // (one per person, 20 at once) holds the loop for the sum, which is what starved the hosted service.
    burnMs = 10;
    // A timer that asks to run every 5 ms: how late it ever runs is how long the loop was held.
    let last = performance.now();
    let maxDelayMs = 0;
    const watch = setInterval(() => {
      const now = performance.now();
      maxDelayMs = Math.max(maxDelayMs, now - last - 5);
      last = now;
    }, 5);

    await publishNotificationsChanged(roster, ORG_ID);
    await flushRealtimePublishes();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(watch);

    expect(fetchStub.mock.calls.length + channelsMade).toBeGreaterThan(0);
    // A batch is one burn plus the loop's own tick; 20 burns in a row would be 200 ms.
    expect(maxDelayMs, `the event loop was held for up to ${maxDelayMs.toFixed(0)} ms`).toBeLessThan(100);
  });
});

describe('the pings run after the caller, not inside it', () => {
  /** A response as the server sees it: it says 'finish' when the answer has been written. */
  const response = () => new EventEmitter() as EventEmitter & { once: EventEmitter['once'] };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('resolves before any ping has been sent', async () => {
    await publishNotificationsChanged([USER_A, USER_B], ORG_ID);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('holds a request\'s pings until its response has been written, then sends them without being asked', async () => {
    const res = response();
    await runWithPingScope(res, () => publishNotificationsChanged([USER_A, USER_B], ORG_ID));

    await sleep(300); // longer than the start delay of a ping raised outside a request
    expect(fetchStub).not.toHaveBeenCalled();

    res.emit('finish');
    expect(fetchStub, 'not in the same turn as the answer').not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(bodiesOf()[0]).toHaveLength(2);
  });

  it('lets go of a request\'s pings when the connection closes without a finished answer', async () => {
    const res = response();
    await runWithPingScope(res, () => publishNotificationsChanged([USER_A], ORG_ID));

    res.emit('close');
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1), { timeout: 2_000 });
  });

  it('keeps each request\'s pings to itself until that request has answered', async () => {
    const first = response();
    const second = response();
    await runWithPingScope(first, () => publishNotificationsChanged([USER_A], ORG_ID));
    await runWithPingScope(second, () => publishNotificationsChanged([USER_B], ORG_ID));

    first.emit('finish');
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(bodiesOf()[0]!.map((m) => m.topic)).toEqual([`org:${ORG_ID}:user:${USER_A}`]);
    await sleep(100);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    second.emit('finish');
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2), { timeout: 2_000 });
  });

  it('sends a ping raised outside any request on its own, after a short delay', async () => {
    await publishNotificationsChanged([USER_A], ORG_ID);
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1), { timeout: 2_000 });
  });
});
