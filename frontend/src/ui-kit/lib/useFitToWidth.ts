"use client";

import * as React from "react";

/**
 * Keep a one-line figure inside its box (mobile slice F03a). A figure never
 * breaks inside the number - "$94,760." on one line and "21" on the next reads
 * as a different sum - so it is `nowrap`, and when it is wider than its tile
 * (two tiles share a 320 px row) it is set smaller, in half-pixel steps, until
 * it fits or reaches `floorPx`. The inline size is cleared before every
 * measurement, so a figure that fits keeps its CSS size, and a tile that
 * widens (rotation) or a shorter value gets the full size back.
 */
function fitToWidth(el: HTMLElement, floorPx: number) {
  el.style.fontSize = "";
  const overflows = () => el.scrollWidth > el.clientWidth + 0.5;
  if (el.clientWidth <= 0 || !overflows()) return;
  const cssPx = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(cssPx)) return;
  // A first guess by proportion, then step down: text width is close to
  // linear in the font size, but not exactly (glyph rounding).
  let px = Math.max(floorPx, Math.floor(((cssPx * el.clientWidth) / el.scrollWidth) * 2) / 2);
  el.style.fontSize = `${px}px`;
  while (overflows() && px > floorPx) {
    px = Math.max(floorPx, px - 0.5);
    el.style.fontSize = `${px}px`;
  }
}

/**
 * Fit the figure on mount and whenever it changes (layout effect, so the first
 * painted frame is already the fitted one), whenever its box changes width,
 * and once the web font has loaded, since that changes every width measured.
 */
export function useFitToWidth(floorPx: number, content: React.ReactNode) {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useLayoutEffect(() => {
    if (ref.current) fitToWidth(ref.current, floorPx);
  }, [floorPx, content]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let lastWidth = -1;
    // Width only: fitting changes the figure's height, which must not refit.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? -1;
      if (width === lastWidth) return;
      lastWidth = width;
      fitToWidth(el, floorPx);
    });
    observer?.observe(el);
    void document.fonts?.ready.then(() => {
      if (live) fitToWidth(el, floorPx);
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [floorPx]);

  return ref;
}
