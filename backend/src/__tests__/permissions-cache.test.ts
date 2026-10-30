import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { getCachedSwitches, setCachedSwitches, clearAllSwitchCaches, runWithSwitchesStamp, JUST_READ_MS } from '../lib/permissions/switches/cache';

// Permission-cache invalidation. The cache is the per-person cache of resolved switch values (role-permission rows
// are no longer read, so nothing else is cached). clearPermissionCache is the entry point that drops it.
// Ticket 37: a copy is kept under the switches stamp it was resolved under and is read by a request of that person only while
// it carries the same stamp, so the reads below run as that person's request; anyone else may reuse only values just read.

const ORG_A = 'org-aaaa-0000-0000-0000-000000000001';
const ORG_B = 'org-bbbb-0000-0000-0000-000000000002';
const VALUES = { view_jobs: true };
const STAMP = 'stamp-1';
const cachedFor = (userId: string, stamp = STAMP) => runWithSwitchesStamp(userId, stamp, () => getCachedSwitches(userId));

describe('permission cache invalidation', () => {
  beforeEach(() => {
    clearAllSwitchCaches();
  });

  it('clearPermissionCache(orgId) evicts every person of that org and leaves other orgs alone', () => {
    setCachedSwitches('user-a1', ORG_A, VALUES, STAMP);
    setCachedSwitches('user-a2', ORG_A, VALUES, STAMP);
    setCachedSwitches('user-b1', ORG_B, VALUES, STAMP);

    clearPermissionCache(ORG_A);

    expect(cachedFor('user-a1')).toBeNull();
    expect(cachedFor('user-a2')).toBeNull();
    expect(cachedFor('user-b1')).toEqual(VALUES);
  });

  it('clearPermissionCache() with no argument evicts everything', () => {
    setCachedSwitches('user-a1', ORG_A, VALUES, STAMP);
    setCachedSwitches('user-b1', ORG_B, VALUES, STAMP);

    clearPermissionCache();

    expect(cachedFor('user-a1')).toBeNull();
    expect(cachedFor('user-b1')).toBeNull();
  });

  it('serves a copy to its person\'s request only under the stamp it was kept under (ticket 37)', () => {
    setCachedSwitches('user-a1', ORG_A, VALUES, STAMP);

    expect(cachedFor('user-a1')).toEqual(VALUES);
    // The stamp moved (a change made on any server): the copy is not used, however new it is.
    expect(cachedFor('user-a1', 'stamp-2')).toBeNull();
  });

  it('lets anyone else reuse values only for a moment after they were read (ticket 37)', () => {
    vi.useFakeTimers();
    try {
      setCachedSwitches('user-a1', ORG_A, VALUES, null);
      // An alert lane judging people right after reading them all, with no signed-in person of its own or another one.
      expect(getCachedSwitches('user-a1')).toEqual(VALUES);
      expect(runWithSwitchesStamp('user-a2', STAMP, () => getCachedSwitches('user-a1'))).toEqual(VALUES);
      vi.advanceTimersByTime(JUST_READ_MS + 1);
      expect(getCachedSwitches('user-a1')).toBeNull();
      // Values read for someone else are no copy for the person's own request, which carries a stamp they were not read under.
      setCachedSwitches('user-a1', ORG_A, VALUES, null);
      expect(cachedFor('user-a1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
