import React, { createContext, useContext } from 'react';
import type { AppAbility } from '@/lib/ability';
import { canSeePrices, emptyAbility } from '@/lib/ability';

const AbilityContext = createContext<AppAbility>(emptyAbility);

export function AbilityProvider({
  ability,
  children,
}: {
  ability: AppAbility;
  children: React.ReactNode;
}) {
  return <AbilityContext.Provider value={ability}>{children}</AbilityContext.Provider>;
}

export function useAppAbility(): AppAbility {
  return useContext(AbilityContext);
}

/** Whether the signed-in person holds See prices: a screen leaves out the place for a price when they do not (P11). */
export function useCanSeePrices(): boolean {
  return canSeePrices(useContext(AbilityContext));
}
