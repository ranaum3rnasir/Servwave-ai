/**
 * realtimePublish.ts — Supabase Realtime broadcast publisher
 *
 * Publishes a signal to each recipient's private channel so connected clients
 * know to refetch. The payload carries no content, only "something changed" —
 * the refetch goes back through the API, which is where row visibility is
 * enforced. That is the reason this is a BROADCAST rather than a
 * `postgres_changes` subscription: a client subscribed straight to the table
 * would bypass `commVisibilityWhere` (RLS enforces org isolation only, not the
 * per-role anchor scoping), so the server has to decide who hears what.
 *
 * Channel topic format: org:{organizationId}:user:{recipientId}. The Realtime
 * authorization policy on `realtime.messages` is
 * `topic LIKE 'org:%:user:' || auth.uid()`, so per-user topics are the only
 * ones a client can subscribe to — an org-wide topic would be rejected.
 *
 * Best-effort and off the request: the publish functions only queue the pings (the staff app listens to none of them
 * today, so no request should wait for them), and the queue is sent in a few batched requests after the response has been
 * written; one failure never stops the others. Never throws. Plain fetch with the service key: no client channel
 * objects and no connection per person (see PINGS_PER_REQUEST), and never supabaseAdmin.auth.* (would poison the
 * shared service-role client).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * How many pings go in one request. The live service's broadcast endpoint takes an array of messages, so a whole roster
 * is a handful of requests, not one request (and one connection set-up) per person: that per-person cost was seconds of
 * CPU on the small hosted instance, which stalled every other request while an alert went out (scenario pass 2). Each
 * message is a topic, an event and a one-line payload, so 100 is a few tens of kilobytes.
 */
const PINGS_PER_REQUEST = 100;

/** The vendor client's own send timeout; a request still open after this is aborted. */
const PING_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A request that has not answered after this long is given up on whatever the transport does, so a hung connection
 * cannot hold the drain for good. The backstop around the whole request.
 */
const PING_GIVE_UP_MS = 15_000;

/**
 * The most pings waiting to go out. A ping only says "refetch", so a backlog this deep (the vendor has been down for
 * minutes) is stale by the time it would go out; the newest are dropped, with one warning, rather than growing for ever.
 */
const MAX_WAITING = 5_000;

/** Pings from a request are let go this long after its response has been written, so they never share the turn with it. */
const PING_AFTER_RESPONSE_MS = 25;

/** Pings raised outside a request (a webhook, a timer) start after this delay, so a caller that is still answering is not competed with. */
const PING_START_DELAY_MS = 250;

interface Ping {
  event: string;
  recipientId: string;
  organizationId: string;
}

/** The pings one API request raised; they are held until its response has been written. */
interface RequestPings {
  held: Ping[];
  released: boolean;
}

const requestScope = new AsyncLocalStorage<RequestPings>();
const heldScopes = new Set<RequestPings>();
let heldTotal = 0;

const waiting: Ping[] = [];
let draining = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainWaiters: Array<() => void> = [];

/**
 * Holds the pings an API request raises until its response has been written (or the connection closed), then lets them
 * go. A ping is CPU on the one thread that also answers requests; started while the handler is still reading, it made
 * the answer wait as long as it would have if awaited.
 */
export function runWithPingScope<T>(
  res: { once(event: 'finish' | 'close', listener: () => void): unknown },
  run: () => T,
): T {
  const store: RequestPings = { held: [], released: false };
  const release = () => releaseRequestPings(store);
  res.once('finish', release);
  res.once('close', release);
  return requestScope.run(store, run);
}

function releaseRequestPings(store: RequestPings): void {
  if (store.released) return;
  store.released = true;
  heldScopes.delete(store);
  heldTotal -= store.held.length;
  for (const ping of store.held) waiting.push(ping);
  const any = store.held.length > 0;
  store.held = [];
  if (any) scheduleDrain(PING_AFTER_RESPONSE_MS);
}

/**
 * One request to the live service carrying many messages: the same topic, event and payload, and the same private-channel
 * flag, that a client channel's `send` posts when the channel was never joined (the library's own REST door), without
 * a channel object or a connection per person. The service answers 202 when it has taken them.
 */
async function postChunk(chunk: Ping[]): Promise<void> {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: chunk.map(({ event, recipientId, organizationId }) => ({
        topic: `org:${organizationId}:user:${recipientId}`,
        event,
        payload: { type: event },
        private: true,
      })),
    }),
    signal: AbortSignal.timeout(PING_REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => {/* body already closed */});
  if (!response.ok) {
    logger.warn(`realtimePublish: the live service refused ${chunk.length} pings with status ${response.status} — skipping.`);
  }
}

/** Resolves when `chunk` is sent, or after the give-up time, whichever comes first. Never rejects. */
function sendOrGiveUp(chunk: Ping[]): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(`realtimePublish: gave up waiting for ${chunk.length} pings`);
      resolve();
    }, PING_GIVE_UP_MS);
    timer.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    postChunk(chunk).then(done, (err) => {
      logger.warn(`realtimePublish: failed to publish ${chunk.length} pings — skipping. err=${String(err)}`);
      done();
    });
  });
}

function settleDrainWaiters(): void {
  if (draining || waiting.length > 0) return;
  const done = drainWaiters;
  drainWaiters = [];
  for (const resolve of done) resolve();
}

/** A macrotask turn: whatever else is waiting on the event loop (a request, a health probe) runs before the next chunk. */
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Send what is waiting, one request at a time, handing the loop back between requests. Never throws. */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (waiting.length > 0) {
      await sendOrGiveUp(waiting.splice(0, PINGS_PER_REQUEST));
      if (waiting.length > 0) await nextMacrotask();
    }
  } finally {
    draining = false;
    settleDrainWaiters();
  }
}

function scheduleDrain(delayMs: number): void {
  if (draining || drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drain();
  }, delayMs);
  drainTimer.unref();
}

/**
 * Queue one broadcast event per recipient and return at once. Nothing here is on the caller's path: inside an API request
 * the pings wait for its response to be written, elsewhere they start after a short delay, and every failure is caught
 * and logged. Pings still queued when the process stops are dropped; they only ever say "refetch".
 */
function publishToRecipients(event: string, recipientIds: string[], organizationId: string): void {
  try {
    const room = Math.max(MAX_WAITING - waiting.length - heldTotal, 0);
    if (recipientIds.length > room) {
      logger.warn(`realtimePublish: ${waiting.length + heldTotal} pings already waiting, dropping ${recipientIds.length - room} ${event}`);
    }
    const pings = recipientIds.slice(0, room).map((recipientId) => ({ event, recipientId, organizationId }));
    if (pings.length === 0) return;
    const store = requestScope.getStore();
    if (store && !store.released) {
      for (const ping of pings) store.held.push(ping);
      heldTotal += pings.length;
      heldScopes.add(store);
      return;
    }
    for (const ping of pings) waiting.push(ping);
    scheduleDrain(PING_START_DELAY_MS);
  } catch (err) {
    logger.warn(`realtimePublish: could not queue ${event} — skipping. err=${String(err)}`);
  }
}

/**
 * Resolves when every ping queued so far has been sent (or failed). For tests and nothing else: it lets go of the pings
 * a request still holds and starts at once instead of after the delay, so it also works under fake timers.
 */
export function flushRealtimePublishes(): Promise<void> {
  return new Promise((resolve) => {
    drainWaiters.push(resolve);
    for (const store of [...heldScopes]) releaseRequestPings(store);
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    void drain();
    settleDrainWaiters();
  });
}

export async function publishNotificationsChanged(
  recipientIds: string[],
  organizationId: string,
): Promise<void> {
  publishToRecipients('notifications.changed', recipientIds, organizationId);
}

/**
 * Tell connected clients their EMAIL LIST is stale — separate from
 * `notifications.changed` so the Inbox does not refetch its whole message list
 * every time an unrelated notification (a job assignment, an overdue invoice)
 * fires. Same channel, different event.
 */
export async function publishEmailsChanged(
  recipientIds: string[],
  organizationId: string,
): Promise<void> {
  publishToRecipients('emails.changed', recipientIds, organizationId);
}
