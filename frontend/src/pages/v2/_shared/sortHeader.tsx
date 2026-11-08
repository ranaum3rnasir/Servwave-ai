import type { ReactNode } from 'react';
import type { Column } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * Click-to-sort header for a list the TABLE sorts, not the server.
 *
 * The entity lists (jobs, leads, customers, estimates, invoices) each carry a
 * near-identical `SortHeader` that reports the click OUT to the page, which
 * turns it into a `sortBy` query param and refetches - those lists page on the
 * server, so the rows have to be reordered there. Inventory's four tables and
 * the report grid hold their whole row set in memory and page client-side, so
 * the sort belongs to the table: `column.toggleSorting` drives TanStack's own
 * sorted row model and nothing is refetched.
 *
 * Same three glyphs and the same button geometry as the server-side headers, so
 * a sortable column looks identical wherever a user meets one. The arrow shows
 * the CURRENT direction rather than what a click would do - the other
 * convention exists and it is a coin flip users lose.
 *
 * Not the kit's own `DataTableColumnHeader`: that one opens a dropdown with
 * Ascending / Descending / Hide column, which is a second, heavier interaction
 * for the same job, and no v2 list uses it.
 */
export function ClientSortHeader<TData, TValue>({
  column, title, align = 'left',
}: {
  column: Column<TData, TValue>;
  title: ReactNode;
  /** Right-align the control over a numeric column, so it sits over its digits. */
  align?: 'left' | 'right';
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      // `text-[11.5px] font-semibold` restates what TableHead already sets on
      // the cell; Button's `size="sm"` ships `text-[13px]` and would otherwise
      // win inside the header, leaving sortable titles bigger than plain ones.
      className={cn(
        'h-7 gap-1.5 px-2 text-[11.5px] font-semibold',
        align === 'right' ? '-me-2 ms-auto' : '-ms-2',
      )}
      onClick={() => column.toggleSorting(sorted === 'asc')}
    >
      <span>{title}</span>
      {sorted === 'asc' ? <ArrowUp /> : sorted === 'desc' ? <ArrowDown /> : <ChevronsUpDown />}
    </Button>
  );
}
