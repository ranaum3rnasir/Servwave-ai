import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query from JS.
 *
 *   const isMobile = useMediaQuery("(max-width: 767px)");
 *
 * Only for behaviour that CSS cannot express - swapping a table for a card
 * list, or defaulting the sidebar closed. Pure styling belongs in Tailwind
 * responsive classes, which cost nothing at runtime.
 *
 * Built on useSyncExternalStore rather than useState + useEffect. A media query
 * IS an external store, and the effect version had to seed its state with a
 * synchronous setState on mount - the cascading render that
 * react-hooks/set-state-in-effect flags. This reads the live value during
 * render instead, which also removes the old false-then-correct flash on the
 * first paint.
 *
 * The server snapshot is false so server and client markup agree; the real
 * value is read on the client's first render.
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
