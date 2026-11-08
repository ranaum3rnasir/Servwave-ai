import { useEffect, useRef, useState } from 'react';

/**
 * Animates a numeric value from 0 to `target` over `duration` ms using an
 * ease-out cubic curve. Returns the current animated value.
 *
 * @param target   Final numeric value to animate to
 * @param duration Animation duration in ms (default 900)
 * @param enabled  Only starts the animation when true (pass !isLoading && !!data)
 */
export function useCountUp(target: number, duration = 900, enabled = true): number {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) {
      setCurrent(0);
      return;
    }
    if (target === 0) {
      setCurrent(0);
      return;
    }

    const startTime = performance.now();

    function frame(now: number) {
      const progress = Math.min((now - startTime) / duration, 1);
      // ease-out cubic: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(Math.round(target * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(frame);
      }
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, enabled]);

  return current;
}
