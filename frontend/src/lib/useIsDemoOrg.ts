import { useAuthStore } from '@/stores/auth.store';

/**
 * True when the signed-in user's organization is flagged `is_demo`.
 *
 * Demo orgs (e.g. "Servwave Test") keep the mock-first surfaces — currently the
 * not-yet-backed Reports — so sales can show the full vision to prospects. Real
 * orgs get DB-backed reports only and never see fabricated data.
 *
 * Sourced from the auth store (hydrated synchronously from /api/auth/me), so it
 * is available on first render with no fetch/flash. Fails closed to `false`
 * (real org) when the flag is absent — we never leak mocks to a real org.
 */
export function useIsDemoOrg(): boolean {
  return useAuthStore((s) => s.user?.org_is_demo ?? false);
}
