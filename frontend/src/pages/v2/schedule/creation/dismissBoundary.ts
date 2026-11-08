import { useEffect } from 'react';

/**
 * The popover and everything it renders through a portal are ONE dismissal boundary.
 *
 * The rule this encodes: an interaction is "inside" if it happened inside the popover's own
 * DOM subtree OR inside any floating layer the popover opened - its selects, its date and
 * time pickers, its search-results dropdown, its tooltips. Those all render through portals
 * at the document root, so by DOM containment alone they look like outside clicks, and
 * picking a time would dismiss the form mid-edit.
 *
 * Expressed as a boundary rather than as a list of component special-cases: every floating
 * layer in the kit is a Radix popper, so the wrapper Radix puts around it is the membership
 * test. A new picker dropped into the form is covered on the day it is added, with no change
 * here - which is the whole reason this is one predicate and not a growing `if` chain.
 */
const PORTAL_SELECTORS = [
  '[data-radix-popper-content-wrapper]',
  '[data-slot="popover-content"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="dialog"]',
  '[data-schedule-create-popover]',
] as const;

/** Is this node logically inside the popover, portals included? */
export function isInsideBoundary(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return false;
  return PORTAL_SELECTORS.some((sel) => el.closest(sel) !== null);
}

/**
 * The dismissals Radix does NOT give us for free.
 *
 * Radix's own `onInteractOutside` / `onEscapeKeyDown` cover click and Esc. Scrolling the
 * page, scrolling the board, and resizing the window do not reach it at all - the popover
 * simply detaches from the slot it was anchored to and floats over unrelated content, which
 * is the inconsistency this hook removes.
 *
 * Scroll is listened for in the CAPTURE phase because the board scrolls in its own
 * container, not on `window`, and scroll events do not bubble. The boundary test then keeps
 * the popover's OWN field area (and any open dropdown's list) from dismissing it - scrolling
 * a long form or a time list is interaction inside, not a page moving underneath.
 */
export function useDismissOnViewportChange(active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return undefined;

    const handleScroll = (e: Event) => {
      if (isInsideBoundary(e.target)) return;
      onDismiss();
    };
    const handleResize = () => onDismiss();

    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [active, onDismiss]);
}
