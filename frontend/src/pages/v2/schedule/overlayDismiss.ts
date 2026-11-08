/**
 * Does a dismissal `mousedown` belong to one of the schedule's own overlays
 * rather than to the board behind them?
 *
 * The page dismisses its hand-positioned surfaces - the two context menus and
 * the quick-schedule cards - from a capturing document `mousedown` listener, so
 * every press has to be classified. Three things count as INSIDE:
 *
 *  - `[data-schedule-overlay]` - the surfaces themselves. An ATTRIBUTE, not a
 *    class-name match: the selector used to read `[class*="fixed"][class*="z-["]`,
 *    and renaming that Tailwind utility to a named layer silently broke it.
 *  - `[data-radix-popper-content-wrapper]` - content those surfaces portal to
 *    `<body>`, e.g. the quick-schedule card's TimeSelect list. Without it,
 *    picking a time dismissed the card the list belongs to.
 *  - `<html>` / `<body>` - a press the browser hit-tested to the document root.
 *    A Radix Select puts `pointer-events: none` on `<body>` for as long as its
 *    list is open (DismissableLayer, `disableOutsidePointerEvents`), so the
 *    press that dismisses that list cannot hit ANYTHING inside `<body>` -
 *    including the card the pointer is physically over - and is retargeted
 *    upward. That is not an outside click; the pointer was over the card, the
 *    card just could not be hit.
 *
 * The third case is the bug this file exists for. The quick-schedule card holds
 * a start-time and an end-time TimeSelect, and clicking from one to the other
 * dismissed the whole card and opened a fresh one in its place: the retargeted
 * press closed the card here, and react-big-calendar's own document `mousedown`
 * then started a new slot selection over the freed space (its Selection falls
 * back to a coordinate collision when the press target sits outside its
 * container). Keeping the card mounted stops both halves - the card stays under
 * the pointer, so the library's `elementFromPoint` check no longer reports the
 * grid as the thing being pressed.
 *
 * The cost is deliberate and small: a press on genuinely bare `<body>` no longer
 * dismisses these surfaces. The page fills the viewport with real elements, and
 * Escape and the card's own close button are unaffected.
 */
export function isScheduleOverlayInteraction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const doc = target.ownerDocument;
  if (target === doc.documentElement || target === doc.body) return true;
  return (
    target.closest('[data-schedule-overlay]') !== null ||
    target.closest('[data-radix-popper-content-wrapper]') !== null
  );
}
