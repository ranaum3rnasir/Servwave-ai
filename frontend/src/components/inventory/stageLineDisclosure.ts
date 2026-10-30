import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing } from '@/lib/ability';

/**
 * What a staging line may show the person looking at it (Roles & Permissions, PRD 7). The server already leaves
 * `unitCost` out without See financial data and `vendor` out without View vendors; the screens also follow the
 * switches, so a cost or vendor is never drawn as a blank or a zero and never leaks through a cached response.
 */
export function useStageLineDisclosure(): { showCost: boolean; showVendor: boolean } {
  const ability = useAppAbility();
  return { showCost: canSeePricing(ability), showVendor: ability.can('read', 'Vendor') };
}
