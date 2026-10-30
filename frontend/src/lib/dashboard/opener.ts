/**
 * What a click on a tile, row or stage does: go to the address the server sent for it. The server sends an address only
 * where the person may open that page (PRD 9, "Where a tile links"), so with none the element is drawn but does nothing
 * and the page holds no address of its own.
 */
export function opener(link: string | null | undefined, navigate: (to: string) => void): (() => void) | undefined {
  return link ? () => navigate(link) : undefined;
}
