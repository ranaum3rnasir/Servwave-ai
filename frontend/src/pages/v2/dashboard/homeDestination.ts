import type { AppAbility } from '@/lib/ability';
import { DEFAULT_LAYOUT_KEYS, getDestination } from '@/components/layout/nav-registry';

import { preferV2Path } from '../uiV2';

/** Safe landing when an ability permits no sidebar destination at all. */
export const FALLBACK_HREF = '/leads';

/**
 * Where the app root `/` sends someone, or `null` when it renders the dashboard itself.
 *
 *   `read Dashboard`  -> null: the dashboard renders (ADMIN via `manage all`, DISPATCHER via an
 *                        explicit grant)
 *   otherwise         -> the FIRST destination the ability allows, in the sidebar's display order,
 *                        skipping the dashboard row itself and anything `comingSoon`
 *   nothing allowed   -> `/leads`
 *
 * One rule, two readers: `V2HomeRoute` redirects with it, and `preloadLandingRoute` (mobile slice
 * 61) uses it at entry to start downloading the landing page's chunk before the router gets there.
 * Having both ask the same function is what keeps the preload from guessing a different page than
 * the redirect picks.
 */
export function homeDestinationHref(ability: AppAbility): string | null {
  if (ability.can('read', 'Dashboard')) return null;

  const firstAllowed = DEFAULT_LAYOUT_KEYS.map((key) => getDestination(key)).find(
    (dest) =>
      !!dest &&
      dest.key !== 'dashboard' &&
      !dest.comingSoon &&
      ability.can(dest.action, dest.subject)
  );

  return preferV2Path(firstAllowed?.href ?? FALLBACK_HREF);
}
