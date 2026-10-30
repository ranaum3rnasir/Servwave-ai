import { AsyncLocalStorage } from 'async_hooks';
import type { SwitchValue } from './catalog';

/**
 * The resolved switch values of a person, kept in this server's memory for a short time.
 *
 * Each copy is kept under the switches stamp it was resolved under (lib/permissions/accessStamp.ts), and is used only by a
 * request of that same person whose stamp, read from the database when the request was signed in, is still the same. A
 * change made on another server, or straight in the database, moves the stamp, so this server stops using its copy on the
 * person's very next request (ticket 37); nothing has to reach this server to clear it. The clears below still drop a copy
 * at once on the server that made a change (after its transaction commits), and the TTL bounds the memory.
 *
 * A read for anyone other than the signed-in person of the request (an alert's recipients, a list of people, a webhook or a
 * scheduled run that has no signed-in person) has no fresh stamp for them. It may reuse only values read from the database a
 * moment ago (`JUST_READ_MS`): the alert lanes read a whole company in one batch and then judge each person in turn, and that
 * second step must not read everyone again. Older values are read again, so another server's change reaches those lanes
 * within that moment too.
 */
export type ResolvedSwitches = Record<string, SwitchValue>;

interface Entry {
  organizationId: string;
  /** The stamp the values were resolved under: the person's own request's, or null for a read on someone else's behalf. */
  stamp: string | null;
  values: ResolvedSwitches;
  readAt: number;
  expiresAt: number;
}

const TTL_MS = 60 * 1000;
/** How long values read for someone else may be reused: one batch read and the per-person checks right after it. */
export const JUST_READ_MS = 2 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const cache = new Map<string, Entry>();

/** The person a request is signed in as, and their switches stamp as read at sign-in (null when it could not be read). */
const requestStamp = new AsyncLocalStorage<{ userId: string; stamp: string | null }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}, EVICTION_INTERVAL_MS).unref();

/** Run the rest of a request as this person, whose switches stamp was just read from the database. */
export function runWithSwitchesStamp<T>(userId: string, stamp: string | null, fn: () => T): T {
  return requestStamp.run({ userId, stamp }, fn);
}

/** The switches stamp this request read for `userId`, or null when the request is not theirs (or has none). */
export function currentSwitchesStamp(userId: string): string | null {
  const ctx = requestStamp.getStore();
  return ctx && ctx.userId === userId ? ctx.stamp : null;
}

/**
 * The person's values from memory: for their own request, the copy resolved under the stamp the request read; for anyone
 * else, only values read from the database a moment ago.
 */
export function getCachedSwitches(userId: string): ResolvedSwitches | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  const now = Date.now();
  const stamp = currentSwitchesStamp(userId);
  if (stamp) return entry.stamp === stamp && entry.expiresAt > now ? entry.values : null;
  return now - entry.readAt <= JUST_READ_MS ? entry.values : null;
}

/**
 * Keep values just read from the database. `stamp` is the person's own request's stamp, read BEFORE the values were (a change
 * landing between the two then leaves the copy under the old stamp, which the next request no longer matches), or null for a
 * read on someone else's behalf.
 */
export function setCachedSwitches(userId: string, organizationId: string, values: ResolvedSwitches, stamp: string | null): void {
  const now = Date.now();
  cache.set(userId, { organizationId, stamp, values, readAt: now, expiresAt: now + TTL_MS });
}

/** A change to one person. */
export function clearSwitchCacheForUser(userId: string): void {
  cache.delete(userId);
}

/**
 * A change to a role. Every person of the org is dropped because a person may sit on the role, or
 * fall back to it, and the cache does not index who is based on which role.
 */
export function clearSwitchCacheForOrg(organizationId: string): void {
  for (const [k, v] of cache) {
    if (v.organizationId === organizationId) cache.delete(k);
  }
}

/** Drop every cached person. For a test that changes the mocked switch rows between requests. */
export function clearAllSwitchCaches(): void {
  cache.clear();
}
