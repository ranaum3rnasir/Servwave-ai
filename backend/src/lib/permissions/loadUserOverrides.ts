import { prisma } from '../prisma';
import type { PermissionOverride } from './defineAbility';
import { getCachedUserOverrides, setCachedUserOverrides } from './userOverrideCache';

const toOverride = (r: { action: string; subject: string; effect: string }): PermissionOverride => ({
  action: r.action,
  subject: r.subject,
  effect: r.effect === 'deny' ? 'deny' : 'allow',
});

// Fetch a user's permission overrides (cache-or-DB), keyed by user_id with a short TTL.
// ADMIN is `manage all` and is unaffected by overrides, so callers skip this for admins
// (avoids a per-request query for the superuser path).
export async function loadUserOverrides(userId: string): Promise<PermissionOverride[]> {
  const cached = getCachedUserOverrides(userId);
  if (cached) return cached;

  const rows = await prisma.userPermissionOverride.findMany({
    where: { user_id: userId },
    select: { action: true, subject: true, effect: true },
  });
  const overrides: PermissionOverride[] = rows.map(toOverride);

  setCachedUserOverrides(userId, overrides);
  return overrides;
}

/**
 * `loadUserOverrides` for a whole cohort in ONE query. A caller that has to derive scope for every
 * member of a list (the assignee picker's entity-access check) would otherwise pay a findMany per
 * candidate on a cold cache, which is the per-row query this table's short TTL only hides.
 *
 * Populates the SAME per-user cache, including an empty array for a user with no rows - the miss
 * has to be cached too, or every cohort read re-queries the users who have no overrides at all.
 */
export async function loadUserOverridesMany(
  userIds: string[],
): Promise<Map<string, PermissionOverride[]>> {
  const out = new Map<string, PermissionOverride[]>();
  const missing: string[] = [];
  for (const id of new Set(userIds)) {
    const cached = getCachedUserOverrides(id);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (!missing.length) return out;

  const rows = await prisma.userPermissionOverride.findMany({
    where: { user_id: { in: missing } },
    select: { user_id: true, action: true, subject: true, effect: true },
  });
  for (const id of missing) out.set(id, []);
  for (const r of rows) out.get(r.user_id)!.push(toOverride(r));
  for (const id of missing) setCachedUserOverrides(id, out.get(id)!);
  return out;
}
