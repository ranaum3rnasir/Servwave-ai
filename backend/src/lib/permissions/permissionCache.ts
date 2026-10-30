import { clearAllSwitchCaches, clearSwitchCacheForOrg } from './switches/cache';

/**
 * The permission cache is the per-person cache of resolved switch values (`switches/cache.ts`). Role-permission rows
 * are no longer read, so there is no cache of a role's stored grants any more; this entry point stays for the callers
 * that drop "everything cached about permissions" when an organisation's roles or people change.
 */
export function clearPermissionCache(orgId?: string): void {
  if (!orgId) {
    clearAllSwitchCaches();
    return;
  }
  clearSwitchCacheForOrg(orgId);
}
