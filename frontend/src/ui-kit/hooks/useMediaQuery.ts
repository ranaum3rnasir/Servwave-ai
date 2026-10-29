import { useCallback, useSyncExternalStore } from "react";

import { MEDIA } from "@/ui-kit/lib/breakpoints";

/**
 * Subscribe to a CSS media query from JS.
 *
 *   const isPhone = useIsBelow("md");
 *   const wide = useMediaQuery(MEDIA.lg);
 *
 * Only for behaviour that CSS cannot express - swapping a table for a card
 * list, or defaulting the sidebar closed. Pure styling belongs in Tailwind
 * responsive classes, which cost nothing at runtime.
 *
 * Pass a query from `MEDIA` (ui-kit/lib/breakpoints), the one breakpoint
 * source Tailwind's screens are built from too, never a pixel width of your
 * own: a private number is how the shell came to switch at 760 px while the
 * phone hook switched at 768.
 *
 * Built on useSyncExternalStore rather than useState + useEffect. A media query
 * IS an external store, and the effect version had to seed its state with a
 * synchronous setState on mount - the cascading render that
 * react-hooks/set-state-in-effect flags. This reads the live value during
 * render instead, which also removes the old false-then-correct flash on the
 * first paint.
 *
 * The server snapshot is false so server and client markup agree; the real
 * value is read on the client's first render. In jsdom `matchMedia` is mocked
 * to `matches: false`, so tests get the wide (non-matching) variant by default.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export type NamedBreakpoint = "sm" | "md" | "lg" | "xl";

const BELOW: Record<NamedBreakpoint, string> = {
  sm: MEDIA.belowSm,
  md: MEDIA.belowMd,
  lg: MEDIA.belowLg,
  xl: MEDIA.belowXl,
};

/**
 * True below a named Tailwind screen: `useIsBelow("md")` is exactly the range
 * where `md:` utilities do not apply yet.
 */
export function useIsBelow(breakpoint: NamedBreakpoint): boolean {
  return useMediaQuery(BELOW[breakpoint]);
}

/** True under the one named short-height condition (a phone held sideways). */
export function useIsShortHeight(): boolean {
  return useMediaQuery(MEDIA.shortHeight);
}
