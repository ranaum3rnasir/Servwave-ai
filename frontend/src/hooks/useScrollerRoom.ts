import { useLayoutEffect, useState, type RefObject } from 'react';

/** The least room a column is given, so a very short window still shows a few rows and lets the page scroll instead. */
const LEAST_ROOM = 192;

/** The nearest ancestor that scrolls the page vertically: the shell's `<main>`. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * How many pixels of the page scroller are left below `anchor`, for a column that sticks beside a long page and must
 * fit what the person can see (the Roles page's side column).
 *
 * `anchor` is the column's fixed slot, not the sticky box inside it: the slot never moves when the page scrolls, so the
 * answer is the same wherever the page is scrolled to. It is the scroller's visible height, less where the slot starts
 * in the scroller's content, less the scroller's own bottom padding - so the column ends exactly one padding above the
 * scroller's bottom edge when the page is at the top, and the scroller never gains a scroll of its own because of it.
 * Re-measured when the scroller or anything laid out above the anchor changes size. `undefined` until measured.
 */
export function useScrollerRoom(anchor: RefObject<HTMLElement | null>): number | undefined {
  const [room, setRoom] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const slot = anchor.current;
    if (!slot) return;
    const scroller = scrollerOf(slot);

    const measure = () => {
      const top = slot.getBoundingClientRect().top;
      let next: number;
      if (scroller) {
        const slotTop = top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop;
        const bottomPad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
        next = scroller.clientHeight - slotTop - bottomPad;
      } else {
        next = window.innerHeight - top;
      }
      next = Math.max(LEAST_ROOM, Math.floor(next));
      setRoom((current) => (current === next ? current : next));
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    // Anything above the slot that changes height moves it: watch the scroller and every earlier sibling on the way up.
    const watched = new Set<Element>(scroller ? [scroller] : []);
    for (let node: Element | null = slot; node && node !== scroller; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) watched.add(before);
    }
    watched.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [anchor]);

  return room;
}
