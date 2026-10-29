import { useIsBelow } from '@/ui-kit/hooks/useMediaQuery';

/**
 * The app's media-query hooks are the kit's, re-exported so existing imports
 * keep working. There is ONE implementation and ONE breakpoint source
 * (`@/ui-kit/lib/breakpoints`, which Tailwind's screens are built from too).
 *
 * Why a JS hook at all: it lets a component render EITHER the desktop or the
 * mobile layout instead of shipping both to the DOM behind CSS `hidden md:block`
 * / `md:hidden` - which duplicates content for screen readers, doubles render
 * cost, breaks jsdom tests (CSS media queries don't hide nodes, so `getByText`
 * matches twice), and - critically - cannot suppress PORTALED children (a Radix
 * dialog renders to `<body>`, escaping the `lg:hidden` wrapper, so both copies'
 * dialogs show).
 *
 * In jsdom `matchMedia` is mocked to `matches: false`, so tests get the desktop
 * (non-matching) variant by default.
 */
export { useMediaQuery, useIsBelow, useIsShortHeight } from '@/ui-kit/hooks/useMediaQuery';
export { MEDIA } from '@/ui-kit/lib/breakpoints';

/** True when the viewport is below Tailwind's `md` screen (i.e. phone-width). */
export function useIsMobile(): boolean {
  return useIsBelow('md');
}
