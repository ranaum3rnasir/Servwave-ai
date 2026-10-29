import { useKeyboardMetrics } from '@/hooks/useKeyboardInset';

/**
 * True while an on-screen keyboard covers the page (mobile slice 41). It is the shared keyboard
 * measurement (mobile slice 54), so it holds both where the keyboard overlays the page and where the
 * layout itself shrinks to make room (the resizes-content viewport mode). Where the visual viewport
 * API is missing (jsdom, old browsers) this is always false.
 */
export function useKeyboardOpen(): boolean {
  return useKeyboardMetrics().open;
}
