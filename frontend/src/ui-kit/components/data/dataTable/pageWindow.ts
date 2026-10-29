/**
 * The page numbers a numbered pager draws, and where an ellipsis stands in for a
 * run of hidden pages.
 *
 *   pageWindow(50, 100)    -> 1 … 49 50 51 … 100
 *   pageWindow(50, 100, 0) -> 1 … 50 … 100          (compact, for a phone)
 *
 * Rules:
 *  - the first page, the last page and the current page's `siblings` neighbours
 *    on each side are always drawn;
 *  - an ellipsis never hides a single page: that page's own number takes the
 *    same room and is one click closer;
 *  - once there are more pages than fit, the window is always the same number
 *    of items (2 x siblings + 5), so paging never makes the control jump.
 *
 * `current` is 1-based and clamped into range.
 */
export type PageWindowItem =
  | { type: "page"; page: number }
  | { type: "ellipsis"; key: "ellipsis-start" | "ellipsis-end" };

const range = (from: number, to: number): PageWindowItem[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ type: "page", page: from + i }));

const START_GAP: PageWindowItem = { type: "ellipsis", key: "ellipsis-start" };
const END_GAP: PageWindowItem = { type: "ellipsis", key: "ellipsis-end" };

export function pageWindow(current: number, pageCount: number, siblings = 1): PageWindowItem[] {
  if (pageCount < 1) return [];
  // first + last + current + two ellipses + the neighbours on both sides
  const slots = 2 * siblings + 5;
  if (pageCount <= slots) return range(1, pageCount);

  const page = Math.min(Math.max(current, 1), pageCount);
  const left = Math.max(page - siblings, 1);
  const right = Math.min(page + siblings, pageCount);
  // An ellipsis only where it would hide two pages or more.
  const gapBefore = left > 3;
  const gapAfter = right < pageCount - 2;
  // With one ellipsis, the other end fills the slots its ellipsis and neighbours would take.
  const endRun = 2 * siblings + 3;

  if (!gapBefore) return [...range(1, endRun), END_GAP, ...range(pageCount, pageCount)];
  if (!gapAfter) return [...range(1, 1), START_GAP, ...range(pageCount - endRun + 1, pageCount)];
  return [...range(1, 1), START_GAP, ...range(left, right), END_GAP, ...range(pageCount, pageCount)];
}
