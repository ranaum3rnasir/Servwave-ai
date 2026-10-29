import { SCREENS, SHORT_HEIGHT_MAX } from '@/ui-kit/lib/breakpoints';

/**
 * Where the list filter goes: one pure function of (viewport, anchor rectangle, content height).
 *
 * Below md, or on a phone held sideways (md wide but short), the filter is a bottom sheet: the
 * screen is too small to float a 640 px panel beside a button without it leaving the viewport.
 * At md and up it is a popover anchored to the button, on whichever side has room, and capped to
 * the room on that side so its own list scrolls instead of running off the window.
 */

export interface PlacementRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface FilterPlacementInput {
  viewport: { width: number; height: number };
  /** The Filter button's rectangle in viewport coordinates. */
  anchor: PlacementRect;
  /** The panel's natural height with nothing capping it. */
  contentHeight: number;
}

export interface FilterPlacement {
  presentation: 'popover' | 'sheet';
  side: 'top' | 'bottom';
  /** The tallest the panel may be, in px. */
  maxHeight: number;
}

/** The panel's natural height: header, facet area and footer. Used until the real one is measured. */
export const FILTER_CONTENT_HEIGHT = 440;
/** Space kept between the panel and the window edge (Radix `collisionPadding`). */
export const FILTER_COLLISION_PADDING = 16;
/** Space between the anchor and the panel (Radix `sideOffset`). */
export const FILTER_SIDE_OFFSET = 6;
/** A sheet never covers the whole screen: the page stays visible above it. */
const SHEET_HEIGHT_FRACTION = 0.85;

export function filterPlacement({ viewport, anchor, contentHeight }: FilterPlacementInput): FilterPlacement {
  const sheet = viewport.width < SCREENS.md || viewport.height <= SHORT_HEIGHT_MAX;
  if (sheet) {
    return {
      presentation: 'sheet',
      side: 'bottom',
      maxHeight: Math.floor(Math.min(contentHeight, viewport.height * SHEET_HEIGHT_FRACTION)),
    };
  }

  const reserve = FILTER_SIDE_OFFSET + FILTER_COLLISION_PADDING;
  const below = Math.max(0, viewport.height - anchor.bottom - reserve);
  const above = Math.max(0, anchor.top - reserve);
  const side = below >= contentHeight || below >= above ? 'bottom' : 'top';
  const room = side === 'bottom' ? below : above;
  return { presentation: 'popover', side, maxHeight: Math.floor(Math.min(contentHeight, room)) };
}
