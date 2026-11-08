import { useEffect, useState } from "react";

/**
 * Holds a flag false until it has been true for `delay` ms.
 *
 *   const isFetching = ...;
 *   const showSkeleton = useDelayedFlag(isFetching, 300);
 *
 * Anything that resolves inside the window never renders a loading state at
 * all. A spinner that flashes for 120ms reads as a glitch rather than as
 * feedback, and the flash costs more perceived performance than the wait did.
 */
export function useDelayedFlag(active: boolean, delay = 300): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) {
      // Deferred by a tick so this is not a synchronous setState in an effect
      // body (react-hooks/set-state-in-effect). Hiding is already immediate -
      // the return below reads `active &&` - so this reset exists only so the
      // NEXT activation starts hidden, where one tick is not observable.
      const reset = setTimeout(() => setElapsed(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setElapsed(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);

  // `active &&` keeps hiding synchronous with the flag going false, so a
  // request that resolves drops its skeleton in the same commit.
  return active && elapsed;
}
