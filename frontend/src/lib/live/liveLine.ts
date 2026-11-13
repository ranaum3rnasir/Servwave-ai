/**
 * The live line (#3472): one long-lived GET /api/live per tab, down which the server pushes the few messages that tell a
 * screen to show or drop something now (services/live/liveLines.ts on the server). Its first message (live.hello) says
 * what the server does: a screen checks far less often only while the line is open and the server says the work that
 * keeps it current runs there (useLiveLineSays); otherwise it keeps checking as before. It never changes what a screen
 * shows, only when.
 *
 * - Opened with fetch and a stream reader (EventSource cannot send a header): the sign-in token goes in the
 *   Authorization header, never in the URL.
 * - One line per tab, shared by every screen that uses it (useLiveLine counts them); closed a few seconds after the last
 *   one goes, so moving between pages keeps it.
 * - When it drops (the network, the server's ~55-minute limit, a deploy) the screens fall back at once and it reconnects
 *   after a growing random wait: 1-12 s the first time, then up to 60 s. Every reconnect announces itself (LIVE_REOPENED)
 *   so each screen re-reads once, since it may have missed a message meanwhile.
 * - The server sends a keep-alive every 25 s. A line that has said nothing for 60 s (a connection the browser has not
 *   noticed is dead: a laptop that slept, a network that changed) is treated as dropped: the same fall back and reconnect.
 * - A hidden tab keeps its line for 30 minutes, then closes it; it reopens (and re-reads) when the tab is shown again.
 * - Sign-out closes it (storeReset).
 *
 * Silent: nothing is logged to the console and nothing on screen changes when it opens, drops or is refused.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getAccessToken } from '@/lib/supabase';
import { registerStoreReset } from '@/lib/storeReset';

export interface LiveMessage {
  type: string;
  data: Record<string, unknown>;
}

/** Sent to the listeners each time the line opens again after it was closed: the screen re-reads once. */
export const LIVE_REOPENED = 'live.reopened';
/**
 * The server's first message on a line: what it says about itself (#3469), for example `spider_tick` (Spider's check
 * runs there). Kept by the line while it is open (useLiveLineSays), not passed to the listeners.
 */
export const LIVE_HELLO = 'live.hello';

const HIDDEN_CLOSE_MS = 30 * 60_000;
/** The last screen using the line has gone: closed after this, unless another takes it up (a page change). */
const RELEASE_GRACE_MS = 5_000;
/** A line that stayed open this long starts its next reconnect over from the first, shortest wait. */
const STABLE_MS = 30_000;
/** A line that has received nothing, not even the server's 25-second keep-alive, for this long is taken to have dropped. */
export const LIVE_IDLE_MS = 60_000;
/** The longest a server's Retry-After is honoured for. */
const RETRY_AFTER_MAX_MS = 10 * 60_000;

/**
 * The wait before reconnect number `attempt` (1 = the first after a drop): 1-12 s, then halves of a doubling cap up to
 * 60 s. After a deploy every line drops at the same moment; 1-12 s spreads their returns over at least 10 s.
 */
export function liveBackoffMs(attempt: number, random: () => number = Math.random): number {
  if (attempt <= 1) return 1_000 + random() * 11_000;
  const cap = Math.min(60_000, 10_000 * 2 ** (attempt - 1));
  return cap / 2 + random() * (cap / 2);
}

const listeners = new Set<(m: LiveMessage) => void>();
const openListeners = new Set<() => void>();

let users = 0;
/** Bumped by closeLiveLine (sign-out), so a release from before it counts for nothing. */
let generation = 0;
let isOpen = false;
/** What the server said in this line's hello; empty until it says it, and again once the line closes. */
let hello: Record<string, unknown> = {};
let current: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let openedBefore = false;
let closedWhileHidden = false;

function setOpen(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  if (!next) hello = {};
  for (const fn of openListeners) fn();
}

function setHello(next: Record<string, unknown>): void {
  hello = next;
  for (const fn of openListeners) fn();
}

function dispatch(message: LiveMessage): void {
  for (const fn of listeners) {
    try {
      fn(message);
    } catch {
      // One screen's handler must not stop the others.
    }
  }
}

function parseBlock(block: string): LiveMessage | null {
  let type: string | null = null;
  const data: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!type || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data.join('\n')) as unknown;
    return { type, data: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t);
  return null;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function scheduleRetry(retryAfterMs = 0): void {
  retryTimer = clearTimer(retryTimer);
  if (users === 0 || closedWhileHidden) return;
  attempt += 1;
  retryTimer = setTimeout(connect, Math.max(liveBackoffMs(attempt), Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)));
}

function retryAfterOf(res: Response): number {
  const seconds = Number(res.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
}

async function connect(): Promise<void> {
  retryTimer = clearTimer(retryTimer);
  if (users === 0 || current || closedWhileHidden) return;
  const token = getAccessToken();
  if (!token) {
    scheduleRetry();
    return;
  }
  const controller = new AbortController();
  current = controller;
  let openedAt = 0;
  let retryAfterMs = 0;
  // The idle watchdog: restarted by every chunk (the keep-alive included); when it runs out the line is aborted like a drop.
  let idled = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const watch = () => {
    watchdog = clearTimer(watchdog);
    watchdog = setTimeout(() => {
      idled = true;
      controller.abort();
    }, LIVE_IDLE_MS);
  };
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/live`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      retryAfterMs = retryAfterOf(res);
      return;
    }
    openedAt = Date.now();
    watch();
    // A first open on the first try missed nothing: the screens have just read. Any other open may have.
    const reopened = openedBefore || attempt > 0;
    openedBefore = true;
    setOpen(true);
    if (reopened) dispatch({ type: LIVE_REOPENED, data: {} });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      watch();
      pending += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = pending.indexOf('\n\n')) >= 0) {
        const message = parseBlock(pending.slice(0, cut));
        pending = pending.slice(cut + 2);
        if (message?.type === LIVE_HELLO) setHello(message.data);
        else if (message) dispatch(message);
      }
    }
  } catch {
    // The network, or our own close: told apart below.
  } finally {
    watchdog = clearTimer(watchdog);
    if (current === controller) current = null;
    setOpen(false);
    // An abort is our own close (a sign-out, a release, a hidden tab) unless the idle watchdog did it: that is a drop.
    if (!controller.signal.aborted || idled) {
      if (openedAt && Date.now() - openedAt >= STABLE_MS) attempt = 0;
      scheduleRetry(retryAfterMs);
    }
  }
}

function disconnect(): void {
  retryTimer = clearTimer(retryTimer);
  const controller = current;
  current = null;
  controller?.abort();
  setOpen(false);
}

function onVisibility(): void {
  if (isHidden()) {
    hiddenTimer ??= setTimeout(() => {
      hiddenTimer = null;
      if (!isHidden()) return;
      closedWhileHidden = true;
      disconnect();
    }, HIDDEN_CLOSE_MS);
    return;
  }
  hiddenTimer = clearTimer(hiddenTimer);
  if (closedWhileHidden) {
    closedWhileHidden = false;
    attempt = 0;
    void connect();
  }
}

function start(): void {
  graceTimer = clearTimer(graceTimer);
  if (users === 1) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (isHidden()) onVisibility();
  }
  void connect();
}

function stop(): void {
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  hiddenTimer = clearTimer(hiddenTimer);
  graceTimer = clearTimer(graceTimer);
  closedWhileHidden = false;
  attempt = 0;
  openedBefore = false;
  disconnect();
}

/** A screen starts using the line; returns its release. */
export function acquireLiveLine(): () => void {
  const mine = generation;
  users += 1;
  start();
  let released = false;
  return () => {
    if (released || mine !== generation) return;
    released = true;
    users -= 1;
    if (users > 0) return;
    graceTimer = clearTimer(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (users === 0) stop();
    }, RELEASE_GRACE_MS);
  };
}

/** Closes the line now and forgets every screen using it (sign-out). */
export function closeLiveLine(): void {
  generation += 1;
  users = 0;
  stop();
}

registerStoreReset(closeLiveLine);

/** Hears every message on the line (and LIVE_REOPENED); returns the unsubscribe. */
export function subscribeLiveMessages(fn: (m: LiveMessage) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function subscribeOpen(fn: () => void): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

/** Keeps the line open while the calling screen is mounted. */
export function useLiveLine(): void {
  useEffect(() => acquireLiveLine(), []);
}

/**
 * Whether the line is open AND its server said `key: true` in its hello (#3469). False while the line is closed, before
 * the hello arrives, and for a server that does not say it.
 */
export function useLiveLineSays(key: string): boolean {
  return useSyncExternalStore(subscribeOpen, () => isOpen && hello[key] === true, () => false);
}
