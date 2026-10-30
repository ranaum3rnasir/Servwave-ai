import { useLayoutEffect, useState } from 'react';

/**
 * The visible height of the page canvas (the shell's <main>, the element that scrolls) around an element, kept current
 * as the window or the canvas resizes; 0 when there is no canvas to measure. Used as a panel's minimum height so
 * switching to a shorter tab never shortens the page and pulls the person's scroll position with it. It is measured from
 * the panel so the shell itself does not change. Put `attach` on the element as its `ref` (a callback ref, because the
 * element may appear only after the page has loaded).
 */
export function useCanvasMinHeight(): { attach: (el: HTMLElement | null) => void; height: number } {
  const [element, attach] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const canvas = element?.closest('main');
    if (!canvas) return;
    const measure = () => setHeight(canvas.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [element]);
  return { attach, height };
}
