import { env } from '../../config/env';

/**
 * Bee access gate:
 * - Demo companies (`is_demo === true`)
 * - Companies with the `bee` feature entitlement
 * - Companies explicitly listed in `BEE_ALLOWED_ORG_IDS` (comma-separated UUIDs)
 *
 * Fails closed on every missing flag.
 */
export function isBeeAllowedOrg(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  const raw = env.BEE_ALLOWED_ORG_IDS ?? '';
  if (!raw.trim()) return false;
  const target = orgId.trim().toLowerCase();
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

export function beeAvailable(params: {
  features?: readonly string[];
  isDemo?: boolean;
  orgId?: string | null;
}): boolean {
  if (params.isDemo === true) return true;
  if ((params.features ?? []).includes('bee')) return true;
  if (isBeeAllowedOrg(params.orgId)) return true;
  return false;
}
