import { lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppAbility } from '@/contexts/AbilityContext';
import { DEFAULT_LAYOUT_KEYS, getDestination } from './nav-registry';

const DashboardPage = lazy(() => import('@/pages/DashboardPage'));

/** Safe landing when an ability permits no sidebar destination at all. */
const FALLBACK_HREF = '/leads';

/**
 * Ability-aware landing for the app root (`/`).
 *
 * The dashboard is the canonical home, but its `read Dashboard` grant is now
 * admin/dispatcher-only (SALES lost it for security). The sidebar item already
 * hides for SALES (it's CASL-gated), but the `/` route still mounted
 * DashboardPage → `GET /api/dashboard` 403 → broken landing.
 *
 * So: if the user can `read Dashboard`, render the dashboard; otherwise redirect
 * to the FIRST destination the user may access, in the sidebar's display order.
 * We reuse the SAME filter the sidebar uses (`getDestination` +
 * `ability.can(action, subject)` over the canonical `DEFAULT_LAYOUT_KEYS`
 * order — see Sidebar.tsx), excluding the dashboard row itself and any
 * `comingSoon` items. Falls back to `/leads` if nothing is allowed.
 */
export default function HomeRoute() {
  const ability = useAppAbility();

  if (ability.can('read', 'Dashboard')) {
    return <DashboardPage />;
  }

  const firstAllowed = DEFAULT_LAYOUT_KEYS.map((key) => getDestination(key)).find(
    (dest) =>
      !!dest &&
      dest.key !== 'dashboard' &&
      !dest.comingSoon &&
      ability.can(dest.action, dest.subject)
  );

  return <Navigate replace to={firstAllowed?.href ?? FALLBACK_HREF} />;
}
