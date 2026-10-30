import type { SwitchValue } from './catalog';

/**
 * The resolved switch values of a person, cached by person for a short time. The cache is cleared on
 * any change to the person, to their role, or to the role they fall back to, so a change is visible
 * on the very next request and the TTL only bounds a change made some other way.
 */
export type ResolvedSwitches = Record<string, SwitchValue>;

interface Entry {
  organizationId: string;
  values: ResolvedSwitches;
  expiresAt: number;
}

const TTL_MS = 60 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const cache = new Map<string, Entry>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}, EVICTION_INTERVAL_MS).unref();

export function getCachedSwitches(userId: string): ResolvedSwitches | null {
  const entry = cache.get(userId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.values;
}

export function setCachedSwitches(userId: string, organizationId: string, values: ResolvedSwitches): void {
  cache.set(userId, { organizationId, values, expiresAt: Date.now() + TTL_MS });
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
