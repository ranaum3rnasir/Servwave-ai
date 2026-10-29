import type { SortingState } from '@tanstack/react-table';

/**
 * The click-to-sort state machine behind every list page's sortable column
 * headers. Two shapes, chosen per column:
 *
 *   - A REGULAR column (Status, Name, Company, a money total) has a genuine
 *     "unsorted" state - there's no default order to fall back to once you've
 *     picked one, so the cycle is ascending -> descending -> unsorted.
 *   - A column in `alwaysSortedColumns` (an entity's reference number - Lead
 *     #, Job #, Estimate # - or a date/timestamp - Created, Date, Scheduled,
 *     Due Date) never has a meaningful "unsorted" state: the list is always
 *     ordered by SOMETHING, and for these the natural resting order is newest
 *     (or highest-numbered) first. So the cycle is just descending <->
 *     ascending, defaulting to descending on first click, and a third click
 *     never clears it.
 */
export function toggleColumnSort(
  prev: SortingState,
  columnId: string,
  alwaysSortedColumns: ReadonlySet<string>,
): SortingState {
  const current = prev[0];
  const alwaysSorted = alwaysSortedColumns.has(columnId);

  if (!current || current.id !== columnId) {
    return [{ id: columnId, desc: alwaysSorted }];
  }
  if (alwaysSorted) {
    return [{ id: columnId, desc: !current.desc }];
  }
  return current.desc ? [] : [{ id: columnId, desc: true }];
}
