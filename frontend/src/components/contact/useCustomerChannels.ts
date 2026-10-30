import { useFeature } from '@/lib/entitlements';
import { useAppAbility } from '@/contexts/AbilityContext';
import { switchOn, useMySwitches } from '@/lib/api/mySwitches';

/**
 * Which ServWave channels the signed-in person can open from a customer's details: the same predicate as the top-bar
 * shortcuts (the phone service for Text, the email service for Email, Access communication, and the Show switch of the
 * page each opens). One hook so the customer block and the Contact dialog always agree.
 */
export function useCustomerChannels(): { text: boolean; email: boolean } {
  const ability = useAppAbility();
  const phoneService = useFeature('phone');
  const emailService = useFeature('email');
  const switches = useMySwitches()?.values;
  const inbox = ability.can('access_inbox', 'Communication');
  return {
    text: phoneService && inbox && switchOn(switches, 'show_text'),
    email: emailService && inbox && switchOn(switches, 'show_email'),
  };
}
