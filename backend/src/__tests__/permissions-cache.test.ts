import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedGrants,
  setCachedGrants,
  clearPermissionCache,
} from '../lib/permissions/permissionCache';
import type { Grant } from '../lib/permissions/defineAbility';

// Entity-redesign Phase 5 — permission-cache invalidation primitive.
//
// There is no runtime role_permissions WRITE endpoint in this branch (grant CRUD /
// org-permission-settings UI is future Phase-7 work), so clearPermissionCache() has no
// in-process caller today; the DB backfill migration is invalidated by a worker restart.
// These tests pin the invalidation PRIMITIVE itself so the forward-looking Org-Permissions
// UI write handler can call clearPermissionCache(orgId) and trust the cache is evicted.

const ORG_A = 'org-aaaa-0000-0000-0000-000000000001';
const ORG_B = 'org-bbbb-0000-0000-0000-000000000002';

const STALE_GRANT: Grant = { action: 'reactivate_deposit', subject: 'Estimate' };

describe('permission cache invalidation', () => {
  beforeEach(() => {
    clearPermissionCache(); // start from a clean cache each test
  });

  it('clearPermissionCache() evicts seeded grants so a re-read sees the post-fold set', () => {
    setCachedGrants(ORG_A, 'DISPATCHER', [STALE_GRANT]);
    expect(getCachedGrants(ORG_A, 'DISPATCHER')).not.toBeNull();

    clearPermissionCache();

    // Cache is empty → the next attachAbility read falls through to rolePermission.findMany,
    // which (post-fold) no longer returns reactivate_deposit and DOES return the new grants.
    expect(getCachedGrants(ORG_A, 'DISPATCHER')).toBeNull();
  });

  it('clearPermissionCache(orgId) scopes eviction to a single org', () => {
    setCachedGrants(ORG_A, 'DISPATCHER', [STALE_GRANT]);
    setCachedGrants(ORG_B, 'DISPATCHER', [STALE_GRANT]);

    clearPermissionCache(ORG_A);

    expect(getCachedGrants(ORG_A, 'DISPATCHER')).toBeNull();
    expect(getCachedGrants(ORG_B, 'DISPATCHER')).not.toBeNull();
  });
});
