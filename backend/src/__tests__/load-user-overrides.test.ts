import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { loadUserOverrides } from '../lib/permissions/loadUserOverrides';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

describe('loadUserOverrides (cache-or-DB)', () => {
  beforeEach(() => {
    clearUserOverrideCache();
    vi.clearAllMocks();
  });

  it('maps DB rows to PermissionOverride and serves the second read from cache', async () => {
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'create', subject: 'Invoice', effect: 'allow' },
    ]);
    const first = await loadUserOverrides('u1');
    expect(first).toEqual([{ action: 'create', subject: 'Invoice', effect: 'allow' }]);
    const second = await loadUserOverrides('u1');
    expect(second).toEqual(first);
    expect(prisma.userPermissionOverride.findMany).toHaveBeenCalledTimes(1); // cached
  });

  it('caches an empty result (no repeat DB hit for a user with no overrides)', async () => {
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await loadUserOverrides('u2')).toEqual([]);
    await loadUserOverrides('u2');
    expect(prisma.userPermissionOverride.findMany).toHaveBeenCalledTimes(1);
  });

  it('coerces any non-"deny" effect to "allow" (defensive)', async () => {
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'create', subject: 'Invoice', effect: 'garbage' },
    ]);
    const overrides = await loadUserOverrides('u3');
    expect(overrides[0].effect).toBe('allow');
  });

  it('scopes the DB query to the given user_id', async () => {
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await loadUserOverrides('u4');
    expect(prisma.userPermissionOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'u4' } }),
    );
  });
});
