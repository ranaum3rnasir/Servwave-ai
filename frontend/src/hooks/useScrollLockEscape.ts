import { useCallback } from 'react';

/**
 * Ref callback that lets a scrollable list inside a portalled Popover scroll
 * while a Dialog is open.
 *
 * Radix portals PopoverContent to document.body, so a popover opened from
 * inside a Dialog lands OUTSIDE that dialog's scroll lock. react-remove-scroll
 * (which Radix Dialog wraps its overlay in) whitelists only DialogContent via
 * `shards`, and its document-level wheel/touchmove listener preventDefault()s
 * every other event - which silently kills scrolling in the popover's own
 * `overflow-y-auto` list.
 *
 * Stopping the event on the list keeps that document listener from ever seeing
 * it, so the browser scrolls the list normally. Pair it with
 * `overscroll-contain` so reaching either end does not chain into the dialog.
 *
 * The listeners are attached to the node itself and die with it when the
 * popover unmounts, so no explicit teardown is needed.
 */
export function useScrollLockEscape() {
  return useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const stop = (e: Event) => e.stopPropagation();
    node.addEventListener('wheel', stop, { passive: false });
    node.addEventListener('touchmove', stop, { passive: false });
  }, []);
}
