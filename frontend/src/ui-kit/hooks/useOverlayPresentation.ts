import { createContext, useContext } from 'react';

import { useIsBelow, useIsShortHeight } from '@/ui-kit/hooks/useMediaQuery';
import {
  overlayPresentation,
  overlayWidthClass,
  type OverlayIntent,
  type OverlayPresentation,
} from '@/ui-kit/lib/overlayPresentation';

/**
 * The presentation an overlay takes right now. With no intent it is always the card: an overlay
 * opts in by stating what it is for, so nothing changes for the ones that have not yet.
 */
export function useOverlayPresentation(intent: OverlayIntent | undefined): OverlayPresentation {
  const belowMd = useIsBelow('md');
  const shortHeight = useIsShortHeight();
  if (!intent) return 'card';
  return overlayPresentation(overlayWidthClass({ belowMd, shortHeight }), intent);
}

/** What the surrounding overlay is drawn as, so its header, body and footer slots can follow. */
export const OverlayPresentationContext = createContext<OverlayPresentation>('card');

export function useSurroundingPresentation(): OverlayPresentation {
  return useContext(OverlayPresentationContext);
}

/**
 * The classes for a LIST inside a dialog body: capped and scrolling on its own as a card (so a long
 * list cannot push Save off a desktop screen), and flowing in the body on a phone, where the body
 * is the only scroller (mobile slice 65, SCR-02). A list that kept its own cap there would be a
 * scroller inside a scroller: a finger on the list scrolls the list, a finger beside it scrolls the
 * body, and the end of one hands off to the other.
 *
 *   const list = useNestedListClass('max-h-56 overflow-y-auto');
 *
 * Outside any overlay the surrounding presentation is the card, so the cap stays.
 */
export function useNestedListClass(cardClassName: string): string {
  return useSurroundingPresentation() === 'card' ? cardClassName : '';
}
