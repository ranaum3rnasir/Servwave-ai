import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedUserOverrides,
  setCachedUserOverrides,
  clearUserOverrideCache,
} from '../lib/permissions/userOverrideCache';
import type { PermissionOverride } from '../lib/permissions/defineAbility';

// RBAC Phase 2 — per-user override cache. Mirrors permissionCache but keyed by user_id,
// so it never pollutes the per-org-per-role grant cache. The override-mutation endpoint
// calls clearUserOverrideCache(userId) so a re-read picks up the change.
const USER_A = 'user-aaaa-0000-0000-0000-000000000001';
const USER_B = 'user-bbbb-0000-0000-0000-000000000002';
const OV: PermissionOverride[] = [{ action: 'create', subject: 'Invoice', effect: 'allow' }];

describe('per-user override cache', () => {
  beforeEach(() => clearUserOverrideCache());

  it('miss returns null before anything is set', () => {
    expect(getCachedUserOverrides(USER_A)).toBeNull();
  });

  it('set then get returns the cached overrides', () => {
    setCachedUserOverrides(USER_A, OV);
    expect(getCachedUserOverrides(USER_A)).toEqual(OV);
  });

  it('caches an empty list distinctly from a miss', () => {
    setCachedUserOverrides(USER_A, []);
    expect(getCachedUserOverrides(USER_A)).toEqual([]); // hit, not null
    expect(getCachedUserOverrides(USER_B)).toBeNull(); // miss
  });

  it('clearUserOverrideCache(userId) evicts only that user', () => {
    setCachedUserOverrides(USER_A, OV);
    setCachedUserOverrides(USER_B, OV);
    clearUserOverrideCache(USER_A);
    expect(getCachedUserOverrides(USER_A)).toBeNull();
    expect(getCachedUserOverrides(USER_B)).not.toBeNull();
  });

  it('clearUserOverrideCache() with no arg evicts all', () => {
    setCachedUserOverrides(USER_A, OV);
    setCachedUserOverrides(USER_B, OV);
    clearUserOverrideCache();
    expect(getCachedUserOverrides(USER_A)).toBeNull();
    expect(getCachedUserOverrides(USER_B)).toBeNull();
  });
});
