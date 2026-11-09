import { quickCreateItems, quickCreateItemShows } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useMySwitches } from '@/lib/api/shared/mySwitches';
import type { AppAction, AppSubject } from '@/lib/ability';

/**
 * Which ways out of the new-estimate dialog the person is offered (Roles & Permissions S02.26). Both copies of the dialog
 * (one opens from the Estimates list and Create New, the other from the dashboard "New" menu) read this, so they cannot
 * drift apart.
 *
 * - `addNewClient`: the standalone New Customer, so it follows the same Create customers + View customers pair as the
 *   Create New item of that name. The pair is READ from `quickCreateItems`, never copied. Nothing shows until the person's
 *   switches have arrived.
 * - `createLead`: starting a lead for the picked customer, on Create leads.
 * - `estimateWithoutLead`: an estimate on the customer alone, on Standalone estimates (the server refuses it without).
 */
export interface NewEstimateEntries {
  addNewClient: boolean;
  createLead: boolean;
  estimateWithoutLead: boolean;
}

export function useNewEstimateEntries(): NewEstimateEntries {
  const ability = useAppAbility();
  const mySwitches = useMySwitches();
  const can = (action: AppAction, subject: AppSubject) => ability.can(action, subject);

  const newCustomer = quickCreateItems.find((item) => item.label === 'New Customer');
  if (!newCustomer) throw new Error('No Create New item labelled "New Customer"');

  return {
    addNewClient: quickCreateItemShows(newCustomer, can, mySwitches?.values),
    createLead: can('create', 'Lead'),
    estimateWithoutLead: can('create_standalone', 'Estimate'),
  };
}
