import { Navigate, useSearchParams } from 'react-router-dom';

import { LEGACY_PAYMENTS_TAB_TARGETS, isLegacyPaymentsTab } from './legacyPaymentsTabs';

/**
 * The legacy-tab branch of the ServWave Payments route (payments go-live P8): an old bell or email link that carries
 * one of the four old `?tab=` values still lands on the Payments page. It renders inside the route, so the Settings
 * shell is drawn for the instant before the redirect lands. Who may stay is the Payments page's own guard (View
 * payments and payouts); anyone else ends on their dashboard.
 */
export default function ServwavePaymentsRedirect() {
  const [params] = useSearchParams();
  const tab = params.get('tab');
  const target = isLegacyPaymentsTab(tab) ? LEGACY_PAYMENTS_TAB_TARGETS[tab] : undefined;
  return target ? <Navigate to={target} replace /> : null;
}
