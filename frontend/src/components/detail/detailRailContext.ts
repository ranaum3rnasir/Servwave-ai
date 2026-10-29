import { createContext, useContext, type ReactNode } from 'react';

/** One panel the side rail can open, as the header's overflow menu lists it on a phone. */
export interface RailMenuEntry {
  key: string;
  label: string;
  icon: ReactNode;
  open: () => void;
}

/**
 * What the side rail (`IconRail`) hands the detail header below md (mobile slice 56).
 *
 * On a phone the rail reserves no width, so its trigger has no column to live in: the header's
 * overflow menu lists one entry per panel instead. Outside a rail, or from md up where the rail
 * keeps its column, the context is `null` and the header adds nothing.
 */
export const DetailRailContext = createContext<readonly RailMenuEntry[] | null>(null);

export function useRailMenuEntries(): readonly RailMenuEntry[] {
  return useContext(DetailRailContext) ?? [];
}
