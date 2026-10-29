import type { Grant } from './defineAbility';

interface CachedGrants {
  grants: Grant[];
  expiresAt: number;
}

const GRANT_TTL_MS = 60 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const grantCache = new Map<string, CachedGrants>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of grantCache) {
    if (v.expiresAt <= now) grantCache.delete(k);
  }
}, EVICTION_INTERVAL_MS).unref();

function cacheKey(orgId: string, role: string): string {
  return `${orgId}:${role}`;
}

export function getCachedGrants(orgId: string, role: string): Grant[] | null {
  const entry = grantCache.get(cacheKey(orgId, role));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.grants;
}

export function setCachedGrants(orgId: string, role: string, grants: Grant[]): void {
  grantCache.set(cacheKey(orgId, role), { grants, expiresAt: Date.now() + GRANT_TTL_MS });
}

export function clearPermissionCache(orgId?: string): void {
  if (!orgId) { grantCache.clear(); return; }
  for (const k of grantCache.keys()) {
    if (k.startsWith(`${orgId}:`)) grantCache.delete(k);
  }
}
