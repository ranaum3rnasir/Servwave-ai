import { useCallback, useEffect, useRef, useState } from 'react';

interface UseResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

/**
 * Drag-to-resize width with localStorage persistence and min/max clamping.
 *
 * - Width updates during a drag are coalesced to ≤1 per frame via
 *   requestAnimationFrame so heavy consumers re-render smoothly.
 * - Persistence is mouseup-only by design: navigating away mid-drag keeps
 *   the previously saved width.
 * - Body cursor/userSelect are set for the duration of a drag and restored
 *   on mouseup AND on unmount (mid-drag unmount safe).
 */
export function useResizableWidth({ storageKey, defaultWidth, min, max }: UseResizableWidthOptions): {
  width: number;
  startResize: (e: React.MouseEvent) => void;
} {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved > 0 ? Math.min(max, Math.max(min, saved)) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  // Mirror of the current width so startResize never captures a stale
  // closure value — a second drag must start from where the first ended.
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Teardown for the ACTIVE drag (listeners + body styles); null when idle.
  const cleanupRef = useRef<(() => void) | null>(null);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      let latestX = startX;
      let frame: number | null = null;
      let finalWidth = startWidth;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const clamp = (w: number) => Math.min(max, Math.max(min, w));

      const onMouseMove = (ev: MouseEvent) => {
        latestX = ev.clientX;
        // Coalesce to one state update per frame — keeps the resize smooth
        // even when the consuming page is expensive to re-render.
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            finalWidth = clamp(startWidth + latestX - startX);
            setWidth(finalWidth);
          });
        }
      };

      const cleanup = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        cleanupRef.current = null;
      };

      const onMouseUp = (ev: MouseEvent) => {
        finalWidth = clamp(startWidth + ev.clientX - startX);
        setWidth(finalWidth);
        cleanup();
        try {
          localStorage.setItem(storageKey, String(finalWidth));
        } catch {
          // localStorage unavailable — width simply won't persist.
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      cleanupRef.current = cleanup;
    },
    // Reads only refs + stable options captured at mount; storageKey/min/max
    // are constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // If the component unmounts mid-drag, detach listeners + restore body styles.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  return { width, startResize };
}
