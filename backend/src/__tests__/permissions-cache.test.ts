import { describe, it, expect, beforeEach } from 'vitest';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { getCachedSwitches, setCachedSwitches, clearAllSwitchCaches } from '../lib/permissions/switches/cache';

// Permission-cache invalidation. The cache is the per-person cache of resolved switch values (role-permission rows
// are no longer read, so nothing else is cached). clearPermissionCache is the entry point that drops it.

const ORG_A = 'org-aaaa-0000-0000-0000-000000000001';
const ORG_B = 'org-bbbb-0000-0000-0000-000000000002';
const VALUES = { view_jobs: true };

describe('permission cache invalidation', () => {
  beforeEach(() => {
    clearAllSwitchCaches();
  });

  it('clearPermissionCache(orgId) evicts every person of that org and leaves other orgs alone', () => {
    setCachedSwitches('user-a1', ORG_A, VALUES);
    setCachedSwitches('user-a2', ORG_A, VALUES);
    setCachedSwitches('user-b1', ORG_B, VALUES);

    clearPermissionCache(ORG_A);

    expect(getCachedSwitches('user-a1')).toBeNull();
    expect(getCachedSwitches('user-a2')).toBeNull();
    expect(getCachedSwitches('user-b1')).toEqual(VALUES);
  });

  it('clearPermissionCache() with no argument evicts everything', () => {
    setCachedSwitches('user-a1', ORG_A, VALUES);
    setCachedSwitches('user-b1', ORG_B, VALUES);

    clearPermissionCache();

    expect(getCachedSwitches('user-a1')).toBeNull();
    expect(getCachedSwitches('user-b1')).toBeNull();
  });
});
