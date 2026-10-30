import { useSearchParams } from 'react-router-dom';

import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { useAppAbility } from '@/contexts/AbilityContext';

import { isLegacyPaymentsTab } from './legacyPaymentsTabs';
import ServwavePaymentsPage from './ServwavePaymentsPage';
import ServwavePaymentsRedirect from './ServwavePaymentsRedirect';

/**
 * The door to Settings > ServWave Payments. An old bell or email link that carries a known `?tab=` still goes to the
 * Payments page; anything else renders the settings page for a person who may change company settings or manage the
 * payout account. A person with neither gets the no-access page.
 */
export default function ServwavePaymentsRoute() {
  const [params] = useSearchParams();
  const ability = useAppAbility();
  if (isLegacyPaymentsTab(params.get('tab'))) return <ServwavePaymentsRedirect />;
  if (!ability.can('update', 'Organization') && !ability.can('manage_payout_account', 'Organization')) {
    return <NotAuthorizedPage />;
  }
  return <ServwavePaymentsPage />;
}
