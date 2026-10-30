import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { useAppAbility } from '@/contexts/AbilityContext';

import PaymentsListsPage from './PaymentsListsPage';

/**
 * The route's door to Settings > Payments & Lists. The nav hides the entry from anyone who may not change company
 * settings, but a typed URL used to reach the form: its loads were refused, the status card was an empty placeholder
 * and Card / Bank read "Unavailable" for a reason the page could not check. Such a user now gets the no-access page
 * instead (payments go-live slice 35, from the slice 22 acceptance). Refunding is no reason to be here since P8: the
 * attention list it served is on the Payments page.
 */
export default function PaymentsListsRoute() {
  const ability = useAppAbility();
  if (!ability.can('update', 'Organization')) return <NotAuthorizedPage />;
  return <PaymentsListsPage />;
}
