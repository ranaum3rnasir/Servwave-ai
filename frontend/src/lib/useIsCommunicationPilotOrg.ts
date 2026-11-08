import { useAuthStore } from '@/stores/auth.store';

/**
 * Which real (non-demo) organizations are the Phase-0 CTM pilot — currently
 * just Northwind Services. Unrelated to the `phone` plan entitlement
 * (module access is gated by `useFeature('phone')` now); this is a narrower
 * allowlist for the still-unfinished CTM sub-surfaces below.
 *
 * The allowlist is org ids, overridable via VITE_COMMUNICATION_ALLOWED_ORG_IDS
 * (comma-separated). Northwind Services carries the same id in staging and prod, so
 * the hardcoded default works in every environment.
 */
// Northwind Services — same org id in staging and prod.
const DEFAULT_ALLOWED_ORG_IDS = ['11111111-2222-4333-8444-555555555555'];

/** The org-id allowlist, from VITE_COMMUNICATION_ALLOWED_ORG_IDS or the default. */
export function communicationAllowedOrgIds(): string[] {
  const raw = import.meta.env.VITE_COMMUNICATION_ALLOWED_ORG_IDS as string | undefined;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORG_IDS;
}

/**
 * True ONLY for an allowlisted real CTM pilot org (currently just Northwind Services &
 * Security) — NOT demo orgs.
 *
 * Drives access (alongside `useIsDemoOrg`) to the phone-module surfaces not
 * yet ready for every real org: the still-unfinished Call flows / Call groups
 * editors (don't persist or reach CTM as shipped), and Call training (real
 * DB-backed scenarios, but content is only seeded for the pilot + demo so
 * far). Callers combine this with the demo flag — pilot org OR demo org may
 * see these; every other real org is locked out (nav + route guard) so
 * nothing looks half-built. Fails closed to `false`.
 */
export function useIsCommunicationPilotOrg(): boolean {
  return useAuthStore((s) => {
    const u = s.user;
    if (!u) return false;
    return communicationAllowedOrgIds().includes(u.organization_id);
  });
}
