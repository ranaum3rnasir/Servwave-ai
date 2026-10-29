/**
 * The dirty guard: one pure state machine from (how an overlay is being dismissed, is it dirty)
 * to what happens next. Every dismissal path asks THIS, so no path can be the one that forgets.
 *
 *   close    shut it now.
 *   confirm  hold it open and ask "Keep editing" / "Discard".
 *   ignore   do nothing - the overlay stays exactly as it is.
 *
 * A viewport resize is `ignore` whether or not the overlay is dirty: opening the on-screen
 * keyboard, rotating the phone or resizing a window changes the viewport, and none of those is
 * the user asking to leave. (The schedule create sheet used to close on resize - which fired
 * every time the keyboard opened.)
 */

export type Dismissal =
  /** A tap or click on the scrim, outside the overlay. */
  | 'outside'
  /** The Escape key. */
  | 'escape'
  /** A swipe-down on a sheet. */
  | 'swipe'
  /** The close button, or a Cancel button that means "leave". */
  | 'close'
  /** Leaving the screen: the Back button, or a tap that navigates away. */
  | 'navigation'
  /** The viewport changed size (keyboard, rotation, window resize). Never a dismissal. */
  | 'resize';

export type DismissOutcome = 'close' | 'confirm' | 'ignore';

export function decideDismissal(dismissal: Dismissal, dirty: boolean): DismissOutcome {
  if (dismissal === 'resize') return 'ignore';
  return dirty ? 'confirm' : 'close';
}
