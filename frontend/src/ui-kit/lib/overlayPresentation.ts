/**
 * Which presentation an overlay takes: one pure function of (width class, intent).
 *
 * An overlay states what it is FOR, never how big it is:
 *
 *   - "form"    a task, an item, a plan: fields and a Save. Full-screen on a phone, so the keyboard
 *               and the sticky footer have the whole screen to share.
 *   - "choice"  a short list or a confirmation. A bottom sheet on a phone, within thumb reach.
 *   - "content" something to read. Full-screen on a phone.
 *
 * At md and up every intent stays what it is today: a centred card (or a side sheet).
 *
 * The width class has three values, not two. A phone held sideways is 838 px wide, so a width test
 * alone calls it a desktop and draws a card in 390 px of height; `short` is that case, and a form
 * takes the whole short height there.
 *
 * Width decides LAYOUT only (see `breakpoints.js`); nothing here reads the user agent.
 */

export type OverlayIntent = 'form' | 'choice' | 'content';

/** `phone`: below md. `short`: md and up but a short window (landscape phone). `wide`: the rest. */
export type OverlayWidthClass = 'phone' | 'short' | 'wide';

export type OverlayPresentation = 'card' | 'fullscreen' | 'bottom-sheet';

export function overlayWidthClass(input: { belowMd: boolean; shortHeight: boolean }): OverlayWidthClass {
  if (input.belowMd) return 'phone';
  return input.shortHeight ? 'short' : 'wide';
}

export function overlayPresentation(width: OverlayWidthClass, intent: OverlayIntent): OverlayPresentation {
  if (width === 'wide') return 'card';
  if (intent === 'choice') return width === 'phone' ? 'bottom-sheet' : 'card';
  return 'fullscreen';
}
