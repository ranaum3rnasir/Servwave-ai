import { createContext, useContext } from 'react';
import type { CopilotSessionApi } from './voice/useServyCopilot';

export const CopilotContext = createContext<CopilotSessionApi | null>(null);

export function useCopilot(): CopilotSessionApi {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error('useCopilot must be used within <CopilotProvider>');
  return ctx;
}
