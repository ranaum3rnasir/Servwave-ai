import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The report grid, on the kit's DataTable.
 *
 * WHY AN ADAPTER AND NOT TWENTY COLUMN REWRITES. Every report table in the
 * legacy module is a `ResizableTable` driven by the same small column model -
 * `{ id, header, cell, width, min, grow, align, sortValue, footer }` - and
 * seventeen files declare one. Restating each of those arrays as a TanStack
 * `ColumnDef` would be seventeen chances to drop a width, an alignment or a
 * sort accessor in a diff nobody can review. So the model is kept and mapped
 * here, once. The table underneath is the kit's, with none of its behaviour
 * reimplemented: sorting, sizing, paging and the empty state are all its own.
 *
 * WHAT MAPS ONTO WHAT:
 *   width/min       -> `size` / `minSize`. TanStack clamps to these in
 *                      `getSize()`, and the kit's layout pass shares leftover
 *                      width proportionally, which is what `computeLayout`
 *                      did in ResizableTable.
 *   grow: 0         -> `meta.fixed`, the kit's own "do not stretch this
 *                      column" flag (icon and action columns).
 *   sortValue       -> `accessorFn` plus a sortable header. A column without
 *                      one is `enableSorting: false`, exactly as before: the
 *                      legacy header only became clickable when `sortValue`
 *                      was declared.
 *   align           -> an alignment class on the cell and the header. The
 *                      kit's TableCell has no align prop; alignment is layout,
 *                      not appearance, so it stays a className.
 *   header (string) -> `meta.label` too, so the kit's mobile card layout and
 *                      its column-visibility menu have a readable name.
 *
 * WHAT DOES NOT MAP: `footer`. The kit's DataTable renders header, body and
 * pagination and has no `<tfoot>` slot or footer render path, so the nine
 * reports with a totals row get `<ReportTableTotals>` below the table instead
 * of a totals row aligned under its columns. That is a kit API gap, filed in
 * the ledger; it is not a loss of the numbers, only of their alignment.
 */
export interface ReportColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Default width (px). */
  width?: number;
  /** Resize floor (px). */
  min?: number;
  /** Flex-fill weight; 0 = fixed (icon/action columns). */
  grow?: number;
  align?: 'left' | 'right' | 'center';
  headerClassName?: string;
  cellClassName?: string;
  /** Opt-in sorting: when set, the header becomes a click-to-sort toggle. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Totals cell. Rendered by <ReportTableTotals>, not inside the table. */
  footer?: ReactNode;
}

const DEFAULTS = { width: 160, min: 80 };

function alignClass(a?: 'left' | 'right' | 'center') {
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
}

function justifyClass(a?: 'left' | 'right' | 'center') {
  return a === 'right' ? 'justify-end' : a === 'center' ? 'justify-center' : 'justify-start';
}

export interface ReportTableProps<T> {
  columns: ReportColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Shown in place of the body when `rows` is empty. */
  empty?: ReactNode;
  className?: string;
  /** Rows per page before the kit's own footer pages the rest. */
  initialPageSize?: number;
}

export function ReportTable<T>({
  columns, rows, getRowKey, onRowClick, empty, className, initialPageSize = 25,
}: ReportTableProps<T>) {
  const tableColumns = useMemo<ColumnDef<T, unknown>[]>(
    () => columns.map((c) => ({
      id: c.id,
      // A non-sortable column still needs an accessor for TanStack to build a
      // column from an id alone; a constant one is inert because the column
      // also declares enableSorting: false.
      accessorFn: c.sortValue ? (row: T) => c.sortValue!(row) : () => null,
      enableSorting: !!c.sortValue,
      size: c.width ?? DEFAULTS.width,
      minSize: c.min ?? DEFAULTS.min,
      meta: {
        label: typeof c.header === 'string' ? c.header : undefined,
        fixed: c.grow === 0,
      },
      header: ({ column }) => {
        const content = <span className="truncate">{c.header}</span>;
        if (!c.sortValue) {
          return (
            <span className={cn('flex min-w-0 items-center', justifyClass(c.align), c.headerClassName)}>
              {content}
            </span>
          );
        }
        const sorted = column.getIsSorted();
        return (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => column.toggleSorting(sorted === 'asc')}
            // `text-[11.5px] font-semibold` matches TableHead's own type scale;
            // Button's `size="sm"` ships `text-[13px]` and would otherwise make
            // sortable titles bigger than the plain headers beside them.
            className={cn(
              '-mx-3 w-full gap-1 text-[11.5px] font-semibold',
              justifyClass(c.align),
              c.headerClassName,
            )}
          >
            {content}
            {sorted === 'asc' ? <ArrowUp /> : sorted === 'desc' ? <ArrowDown /> : <ArrowUpDown className="opacity-40" />}
          </Button>
        );
      },
      cell: ({ row }) => (
        <div className={cn('min-w-0', alignClass(c.align), c.cellClassName)}>{c.cell(row.original)}</div>
      ),
    })),
    [columns],
  );

  return (
    <DataTable
      className={className}
      columns={tableColumns}
      data={rows}
      getRowId={(row) => getRowKey(row)}
      onRowClick={onRowClick}
      empty={empty}
      initialPageSize={initialPageSize}
      enableColumnResizing
      mobileCards
    />
  );
}

/**
 * The totals row, rendered beneath the table.
 *
 * See the note on `footer` above: the kit's DataTable has no `<tfoot>`, so the
 * nine reports that declared totals cells get them as a labelled strip instead
 * of a row aligned under its columns. Each entry keeps the column's own header
 * as its label, so a total is still attributable to the column it totals.
 */
export function ReportTableTotals<T>({ columns, className }: { columns: ReportColumn<T>[]; className?: string }) {
  const totals = columns.filter((c) => c.footer !== undefined && c.footer !== null && c.footer !== '');
  if (totals.length === 0) return null;
  return (
    <div
      className={cn(
        'bg-muted flex flex-wrap items-baseline gap-x-6 gap-y-1.5 rounded-lg border px-4 py-2.5',
        className,
      )}
    >
      {totals.map((c) => (
        <span key={c.id} className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground text-[11.5px] font-semibold tracking-wide uppercase">
            {typeof c.header === 'string' ? c.header : c.id}
          </span>
          <span className="text-[13.5px] font-bold tabular-nums">{c.footer}</span>
        </span>
      ))}
    </div>
  );
}
