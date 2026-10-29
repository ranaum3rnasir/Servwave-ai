import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** How long Back keeps trying to reach a saved position while the page's content is still arriving. */
const RESTORE_WINDOW_MS = 1000;
const RESTORE_STEP_MS = 16;
/** History entries remembered; the oldest are dropped past this. */
const MAX_ENTRIES = 100;

/**
 * The shell's one page scroller (mobile slice 34, SCR-01).
 *
 * The shell's <main> is the same element for every route, so without this its scrollTop simply
 * carries over: a forward navigation opened the next page part-way down, and Back landed wherever
 * the page before had left the scroller. The rule:
 *
 *   - forward navigation (PUSH) opens at the top;
 *   - a redirect (REPLACE) to another path opens at the top, to the same path (a filter or tab
 *     written into the URL) leaves the position alone;
 *   - Back and Forward (POP) restore the position that history entry had when it was left. The
 *     page it returns to may still be loading, so the restore retries for a moment and gives up
 *     the instant the user touches, wheels or keys the scroller.
 *
 * Positions are remembered per history entry (`location.key`), in memory only.
 */
export function useShellScroll(target: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const currentKey = useRef(location.key);
  const lastPath = useRef(location.pathname);
  const cancelRestore = useRef<(() => void) | null>(null);

  // Remember where the current entry is scrolled to, as the user scrolls.
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const onScroll = () => {
      const map = positions.current;
      map.delete(currentKey.current); // re-insert so the Map stays in recency order
      map.set(currentKey.current, el.scrollTop);
      if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [target]);

  // Before paint, so the new page is never seen at the old page's offset.
  useLayoutEffect(() => {
    const el = target.current;
    cancelRestore.current?.();
    cancelRestore.current = null;
    const previousPath = lastPath.current;
    lastPath.current = location.pathname;
    currentKey.current = location.key;
    if (!el) return;

    if (navType === 'POP') {
      const saved = positions.current.get(location.key) ?? 0;
      cancelRestore.current = restore(el, saved);
    } else if (navType === 'PUSH' || previousPath !== location.pathname) {
      scrollElementTo(el, 0);
    }
    // A REPLACE on the same path keeps the position.
    return () => {
      cancelRestore.current?.();
      cancelRestore.current = null;
    };
  }, [location.key, location.pathname, navType, target]);
}

/** The one place the scroller is written to. */
function scrollElementTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
}

/** Scroll `el` to `top`, retrying until the content is tall enough or the user takes over. */
function restore(el: HTMLElement, top: number): () => void {
  const stop = () => {
    clearTimeout(timer);
    for (const type of USER_INPUT) el.removeEventListener(type, stop);
  };
  for (const type of USER_INPUT) el.addEventListener(type, stop, { passive: true });
  const deadline = Date.now() + RESTORE_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    scrollElementTo(el, top);
    if (Math.abs(el.scrollTop - top) <= 1 || Date.now() >= deadline) {
      stop();
      return;
    }
    timer = setTimeout(step, RESTORE_STEP_MS);
  };
  step();
  return stop;
}

const USER_INPUT = ['touchstart', 'wheel', 'keydown', 'mousedown'] as const;
