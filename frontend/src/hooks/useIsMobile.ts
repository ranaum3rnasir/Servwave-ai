import { useEffect, useState } from 'react';

// Tailwind's `md` breakpoint is min-width: 768px, so "mobile" is anything below it.
const MOBILE_QUERY = '(max-width: 767.98px)';

/**
 * True when the given CSS media query currently matches.
 *
 * Lets components render EITHER the desktop or the mobile layout instead of
 * shipping both to the DOM behind CSS `hidden md:block` / `md:hidden` — which
 * duplicates content for screen readers, doubles render cost, breaks jsdom
 * tests (CSS media queries don't hide nodes, so `getByText` matches twice), and —
 * critically — cannot suppress PORTALED children (a Radix dialog renders to
 * `<body>`, escaping the `lg:hidden` wrapper, so both copies' dialogs show).
 *
 * Initialises synchronously from `matchMedia` so there's no first-paint flash.
 * In jsdom `matchMedia` is mocked to `matches: false`, so tests get the desktop
 * (non-matching) variant by default. Pass a literal query so the effect dep is
 * stable across renders.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** True when the viewport is below Tailwind's `md` breakpoint (i.e. phone-width). */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
