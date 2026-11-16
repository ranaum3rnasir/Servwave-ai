import React, { useState, useEffect, useRef } from 'react';

export interface BeeTableScrollFadesProps {
  containerRef: React.RefObject<HTMLElement | null>;
  stickyColId?: string;
  hasStickyCol?: boolean;
}

export function BeeTableScrollFades({
  containerRef,
  stickyColId = 'customer_name',
  hasStickyCol = true,
}: BeeTableScrollFadesProps) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [stickyColWidth, setStickyColWidth] = useState(180);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const el = root.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!el) return;

    const checkScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const { scrollLeft, scrollWidth, clientWidth } = el;
        const maxScroll = scrollWidth - clientWidth;
        setCanScrollLeft(scrollLeft > 2);
        setCanScrollRight(maxScroll - scrollLeft > 2);

        if (hasStickyCol) {
          const containerRect = el.getBoundingClientRect();
          const pinnedThs = el.querySelectorAll<HTMLTableCellElement>('thead th[data-pinned]');
          const lastPinned = pinnedThs.length > 0 ? pinnedThs[pinnedThs.length - 1] : undefined;
          if (lastPinned) {
            const lastPinnedRect = lastPinned.getBoundingClientRect();
            const endX = Math.round(lastPinnedRect.right - containerRect.left);
            setStickyColWidth(endX > 0 ? endX : 180);
          } else {
            const stickyTh = el.querySelector<HTMLTableCellElement>(`thead [data-col-id="${stickyColId}"]`);
            if (stickyTh) {
              const thRect = stickyTh.getBoundingClientRect();
              const endX = Math.round(thRect.right - containerRect.left);
              setStickyColWidth(endX > 0 ? endX : stickyTh.offsetWidth);
            }
          }
        }
      });
    };

    checkScroll();

    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(checkScroll);
      ro.observe(el);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
      if (ro) ro.disconnect();
    };
  }, [containerRef, stickyColId, hasStickyCol]);

  return (
    <>
      {canScrollLeft && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 z-30 w-8 md:w-10 bg-gradient-to-r from-card via-card/60 to-transparent transition-opacity duration-200"
          style={{ left: hasStickyCol ? stickyColWidth : 0 }}
        />
      )}
      {canScrollRight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 bottom-0 z-30 w-10 md:w-14 bg-gradient-to-l from-card via-card/60 to-transparent transition-opacity duration-200"
        />
      )}
    </>
  );
}

