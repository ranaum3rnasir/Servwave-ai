/**
 * Is this page one fixed column with a single scroller of its own, so the canvas must not scroll?
 *
 * The two-pane messengers (text and chat): a thread's messages are the only thing that scrolls and
 * the composer is pinned under them (mobile slice 69). The Phone hub (mobile slice 71): the call log
 * takes the rest of the canvas and scrolls in the page's own scroller, never under a canvas that
 * scrolls too. The layout hands the answer to AppShell's `bounded`; a page that returns true here
 * sizes itself with `flex-1 min-h-0`, never `h-full`.
 */
export function isBoundedPage(pathname: string): boolean {
  return /^\/communication\/(text|whatsapp|phone)(\/|$)/i.test(pathname);
}
