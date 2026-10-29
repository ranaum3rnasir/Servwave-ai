import { useEffect, useState } from 'react';

import { readKeyboardMetrics, type KeyboardMetrics } from '@/lib/keyboardInset';

const CLOSED: KeyboardMetrics = { inset: 0, visibleHeight: 0, open: false };

/**
 * Measures the on-screen keyboard from the visual viewport (mobile slice 54). Listens to the visual
 * viewport's resize and scroll, the window's resize and focus changes, and re-renders only when a
 * number actually changed. Every listener it adds is removed on unmount.
 */
export function useKeyboardMetrics(): KeyboardMetrics {
  const [metrics, setMetrics] = useState<KeyboardMetrics>(() =>
    typeof window === 'undefined' ? CLOSED : { ...CLOSED, visibleHeight: Math.round(window.innerHeight) },
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const baseline = { width: window.innerWidth, height: window.innerHeight };
    const measure = () => {
      const next = readKeyboardMetrics(window, baseline);
      setMetrics((prev) =>
        prev.inset === next.inset && prev.visibleHeight === next.visibleHeight && prev.open === next.open
          ? prev
          : next,
      );
    };
    measure();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    // Focus moving between fields (or off one) changes whether a shrunk layout means a keyboard.
    window.addEventListener('focusin', measure);
    window.addEventListener('focusout', measure);
    return () => {
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('focusin', measure);
      window.removeEventListener('focusout', measure);
    };
  }, []);
  return metrics;
}

/**
 * THE app-level keyboard hook (mobile slice 54). Mounted once, it publishes on the document root:
 *
 *  - `--keyboard-inset`: pixels of the bottom edge the keyboard covers (zero when the layout itself
 *    resized, so nothing is lifted twice);
 *  - `--visible-height`: the height the user can see;
 *  - `--keyboard-open`: 1 or 0, which `--safe-bottom` (index.css) uses to drop the home-indicator
 *    padding a keyboard already covers.
 *
 * Sticky overlay footers, composers and bottom sheets read those variables in CSS. index.css gives
 * each a safe default, so a page without this hook renders exactly as before.
 */
export function useKeyboardInset(): KeyboardMetrics {
  const metrics = useKeyboardMetrics();
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--keyboard-inset', `${metrics.inset}px`);
    style.setProperty('--visible-height', `${metrics.visibleHeight}px`);
    style.setProperty('--keyboard-open', metrics.open ? '1' : '0');
  }, [metrics]);
  useEffect(() => {
    const style = document.documentElement.style;
    return () => {
      style.removeProperty('--keyboard-inset');
      style.removeProperty('--visible-height');
      style.removeProperty('--keyboard-open');
    };
  }, []);
  return metrics;
}
