import { useAuthStore } from '@/stores/auth.store';

/**
 * Returns allowed organization IDs from VITE_SPIDER_ALLOWED_ORG_IDS (comma-separated).
 */
export function spiderAllowedOrgIds(): string[] {
  const raw = (import.meta as any).env?.VITE_SPIDER_ALLOWED_ORG_IDS as string | undefined;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * True when Spider is enabled for the signed-in user's organization:
 * 1. Demo organizations (org_is_demo: true)
 * 2. Organizations explicitly allowlisted via VITE_SPIDER_ALLOWED_ORG_IDS
 * 3. Organizations with explicit feature override / entitlement (org_features includes 'spider')
 *
 * Fails closed to false when unauthenticated or not allowed.
 */
export function useIsSpiderAllowed(): boolean {
  return useAuthStore((s) => {
    const user = s.user;
    if (!user) return false;
    if (user.org_is_demo) return true;

    const allowedIds = spiderAllowedOrgIds();
    if (user.organization_id && allowedIds.includes(user.organization_id.toLowerCase())) {
      return true;
    }

    if (user.org_features && user.org_features.includes('spider')) {
      return true;
    }

    if ((user as any).feature_overrides?.spider === true) {
      return true;
    }

    return false;
  });
}
