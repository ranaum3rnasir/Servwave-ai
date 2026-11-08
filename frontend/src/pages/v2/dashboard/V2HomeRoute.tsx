import { lazy } from 'react';
import { Navigate } from 'react-router-dom';

import { useAppAbility } from '@/contexts/AbilityContext';
import { DEFAULT_LAYOUT_KEYS, getDestination } from '@/components/layout/nav-registry';

import { preferV2Path } from '../uiV2';

const DashboardPage = lazy(() => import('./DashboardPage'));

/** Safe landing when an ability permits no sidebar destination at all. */
const FALLBACK_HREF = '/leads';

/**
 * `/v2` - the v2 layer's ability-aware landing, mirroring
 * `components/layout/HomeRoute` decision for decision.
 *
 * The legacy `HomeRoute` cannot simply be reused: it hard-imports
 * `pages/DashboardPage`, so mounting it here would render the LEGACY dashboard
 * inside the kit shell. What it decides, though, is not duplicated - the
 * ability, the ordered key list and the destination lookup are all IMPORTED
 * from the same `nav-registry` the legacy resolver and the sidebar read, so
 * there is no second copy of the rule anywhere:
 *
 *   `read Dashboard`  -> the dashboard renders (ADMIN via `manage all`,
 *                        DISPATCHER via an explicit grant)
 *   otherwise         -> the FIRST destination the ability allows, in the
 *                        sidebar's display order, skipping the dashboard row
 *                        itself and anything `comingSoon`
 *   nothing allowed   -> `/leads`
 *
 * Without that indirection SALES and TECHNICIAN - neither of whom is granted
 * `read Dashboard` - would render the page and 403 on `GET /api/dashboard`,
 * which is the exact bug the legacy resolver was added to prevent.
 *
 * The one deliberate difference is the SHAPE of the redirect target, not the
 * choice of it: `preferV2Path` keeps a redirect inside the v2 layer when the
 * destination has been ported and lets it out when it has not. A bare legacy
 * href here would drop the user out of the shell they just entered, which is
 * the same reasoning `V2AppLayout` gives for its own sidebar links.
 */
export default function V2HomeRoute() {
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

  return <Navigate replace to={preferV2Path(firstAllowed?.href ?? FALLBACK_HREF)} />;
}
