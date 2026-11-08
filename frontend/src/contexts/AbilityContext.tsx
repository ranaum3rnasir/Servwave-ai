import React, { createContext, useContext } from 'react';
import type { AppAbility } from '@/lib/ability';
import { emptyAbility } from '@/lib/ability';

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
