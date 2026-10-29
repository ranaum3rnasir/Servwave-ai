/* =============================================================================
   Autofocus only where it cannot pop a keyboard up (mobile slice 24, rubric KB-08).

   Focusing a text field on a phone or tablet opens the on-screen keyboard, which
   covers half of a dialog, sheet or popover before the user has read it. So a
   field may take focus on its own only when the device's PRIMARY pointer is not
   coarse: a mouse or trackpad desktop keeps today's autofocus exactly, a finger
   never gets it. The primary pointer decides interaction, never the width
   (PRD module 2: a narrow desktop window still autofocuses; an iPad at 1024 px
   does not).

   Two doors, one rule:
   - `canAutoFocus()` for a field that asks for focus itself: write
     `autoFocus={canAutoFocus()}` (or `cond && canAutoFocus()`), never a bare
     `autoFocus`. The guard src/__tests__/input-guards/autofocus.guard.test.ts
     holds every JSX `autoFocus` in the app to that shape.
   - `touchSafeOpenAutoFocus` for the overlay primitives (Dialog, Sheet, Popover):
     Radix moves focus to the first tabbable element when one opens, which is a
     text field in most of our dialogs. On a coarse pointer the overlay's own
     container takes focus instead, so focus is still inside it (and trapped, for
     a modal) and a screen reader still lands in it, but no keyboard opens.

   The query is read when it is needed, not cached: a tablet with a keyboard and
   trackpad attached can change its primary pointer while the app is open.
   ============================================================================= */

/** The media query for "the primary pointer is a finger" - the same one the `touch:` variant uses. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * True when a field may focus itself on mount: the primary pointer is not
 * coarse. Anything that cannot be read (no window, no matchMedia) keeps the
 * desktop behaviour, which is what every caller did before this gate.
 */
export function canAutoFocus(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * An overlay's `onOpenAutoFocus`, wrapping the caller's own handler. The
 * caller's handler runs first and wins: one that already called
 * `preventDefault()` has decided where focus goes (it must gate any text field
 * it focuses with `canAutoFocus()` itself). Otherwise, on a coarse pointer, the
 * default "focus the first tabbable" is cancelled and the overlay's container
 * (Radix renders it with tabIndex -1) takes focus.
 */
export function touchSafeOpenAutoFocus(event: Event, callerHandler?: (event: Event) => void): void {
  callerHandler?.(event);
  if (event.defaultPrevented || canAutoFocus()) return;
  event.preventDefault();
  const container = event.currentTarget;
  if (container instanceof HTMLElement) container.focus({ preventScroll: true });
}
