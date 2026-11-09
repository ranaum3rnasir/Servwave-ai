import { useMemo } from 'react';
import { useFeature } from '@/lib/entitlements';
import { useMySwitches } from '@/lib/api/shared/mySwitches';
import { contactRulesFrom, type ContactPolicyInput } from './contactDisplayPolicy';

/** The policy's two inputs for the signed-in person: their resolved switches and the company's phone service. */
export function useContactPolicyInput(): ContactPolicyInput {
  const values = useMySwitches()?.values;
  const phoneService = useFeature('phone');
  return useMemo(
    () => ({ switches: contactRulesFrom(values), phoneService }),
    [values, phoneService],
  );
}
