import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { getDestination, isDemoDestUnlockedForOrg } from './layout/nav-registry';

interface DemoOnlyRouteProps {
  /**
   * Nav-registry key of the destination behind this guard. Supplying it lets the
   * guard honour that destination's `demoOnlyUnlockOrgIds` allowlist, so a named
   * real org reaches the page. Omit it and only demo orgs get through.
   */
  navKey?: string;
}

/**
 * Route guard for demo-only surfaces — mock-only pages not yet backed by a real
 * API (e.g. Marketing). Real (non-demo) orgs are redirected to the dashboard so
 * the page can't be reached by typing the URL; demo orgs pass through.
 *
 * Pairs with the sidebar's `demoOnly` lock (see nav-registry / Sidebar): the nav
 * shows the entry greyed as "coming soon", this blocks direct navigation. Both
 * sides read the same `demoOnlyUnlockOrgIds` allowlist through
 * `isDemoDestUnlockedForOrg`, so an allowlisted org gets an unlocked row AND
 * reaches the page - unlocking one without the other would click straight into
 * a redirect.
 *
 * Mounted inside the authed AppLayout, so auth + role are already enforced
 * upstream by <ProtectedRoute>. `useIsDemoOrg` fails closed to `false` (real
 * org), and an absent or unknown `navKey` yields no allowlist, so a missing flag
 * keeps real orgs out rather than leaking the mock surface.
 */
export default function DemoOnlyRoute({ navKey }: DemoOnlyRouteProps = {}) {
  const isDemoOrg = useIsDemoOrg();
  const orgId = useAuthStore((s) => s.user?.organization_id);
  const dest = navKey ? getDestination(navKey) : undefined;
  const unlocked = !!dest && isDemoDestUnlockedForOrg(dest, orgId);
  if (!isDemoOrg && !unlocked) return <Navigate to="/" replace />;
  return <Outlet />;
}
