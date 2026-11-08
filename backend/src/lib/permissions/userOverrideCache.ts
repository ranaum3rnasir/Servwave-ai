import type { PermissionOverride } from './defineAbility';

// Per-user permission override cache (RBAC Phase 2). Keyed by user_id so it stays separate
// from the per-org-per-role grant cache (permissionCache.ts). Same TTL/eviction shape.
interface CachedOverrides {
  overrides: PermissionOverride[];
  expiresAt: number;
}

const OVERRIDE_TTL_MS = 60 * 1000;
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const overrideCache = new Map<string, CachedOverrides>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of overrideCache) {
    if (v.expiresAt <= now) overrideCache.delete(k);
  }
}, EVICTION_INTERVAL_MS).unref();

export function getCachedUserOverrides(userId: string): PermissionOverride[] | null {
  const entry = overrideCache.get(userId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.overrides;
}

export function setCachedUserOverrides(userId: string, overrides: PermissionOverride[]): void {
  overrideCache.set(userId, { overrides, expiresAt: Date.now() + OVERRIDE_TTL_MS });
}

export function clearUserOverrideCache(userId?: string): void {
  if (!userId) {
    overrideCache.clear();
    return;
  }
  overrideCache.delete(userId);
}
