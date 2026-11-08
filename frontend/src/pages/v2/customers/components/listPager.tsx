import { getCoreRowModel, useReactTable, type PaginationState, type Updater } from '@tanstack/react-table';

import { DataTablePagination } from '@/ui-kit/components/data/dataTable/dataTablePagination';

/** One server-paged list's pager state (visits slice 06). `page` is 1-based. */
export interface ListPagerProps {
  page: number;
  pageSize: number;
  /** Every row the reader can open, across all pages - the "of N" in the readout. */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** A page change is in flight: the old rows stay on screen and the pager shows a spinner. */
  isFetching: boolean;
}

const LIST_PAGE_SIZE_OPTIONS = [20, 50, 100];

const NO_ROWS: never[] = [];
const NO_COLUMNS: never[] = [];

/**
 * The customer page's Jobs and Leads pagers: the kit's own `DataTablePagination` in its numbered
 * mode - "Showing 21-40 of 45", the rows selector, and previous / 1 2 3 / next - under a list drawn
 * with the kit Table primitives rather than DataTable.
 *
 * `DataTablePagination` reads a TanStack table instance, so a row-less, column-less instance in
 * manual-pagination mode carries the server's numbers to it, the way DataTable's own server-paging
 * mode does (`page`/`pageCount`/`rowCount` there).
 */
export function ListPager({ page, pageSize, total, onPageChange, onPageSizeChange, isFetching }: ListPagerProps) {
  const pagination: PaginationState = { pageIndex: page - 1, pageSize };
  const table = useReactTable({
    data: NO_ROWS,
    columns: NO_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
    pageCount: Math.ceil(total / pageSize),
    state: { pagination },
    onPaginationChange: (updater: Updater<PaginationState>) => {
      const next = typeof updater === 'function' ? updater(pagination) : updater;
      if (next.pageSize !== pageSize) onPageSizeChange(next.pageSize);
      else if (next.pageIndex !== pagination.pageIndex) onPageChange(next.pageIndex + 1);
    },
  });

  return (
    <DataTablePagination table={table} isFetching={isFetching} pageSizeOptions={LIST_PAGE_SIZE_OPTIONS} variant="numbered" />
  );
}
