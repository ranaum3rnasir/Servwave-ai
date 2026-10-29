"use client";

import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/ui-kit/components/ui/button";
import { SelectField } from "@/ui-kit/components/form/selectField";
import { Spinner } from "@/ui-kit/components/ui/spinner";
import { useMediaQuery } from "@/ui-kit/hooks/useMediaQuery";
import { cn } from "@/ui-kit/lib/utils";

import { pageWindow } from "./pageWindow";

export interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  pageSizeOptions?: number[];
  /**
   * A page change is in flight. Server-paged callers pass their query's
   * `isFetching` (not `isLoading`) so this fires on every page/size change,
   * not just the very first load - see dataTable.tsx's `isFetching` prop doc.
   */
  isFetching?: boolean;
  /**
   * Same controls, rendered above the table instead of below it - both read
   * the same `table` instance, so paging from either stays in sync with the
   * other with no extra wiring. Only the border side flips, to face the row
   * of table content it sits next to rather than away from.
   */
  placement?: "top" | "bottom";
  /**
   * `"numbered"` swaps "Page n of m" and the first/last arrows for clickable
   * page numbers - 1 … 4 5 6 … 20, the current one marked - between the
   * previous/next arrows, inside a labelled `nav`. Opt-in for a list short
   * enough that jumping to a page by number is the natural move; the default
   * stays the compact readout every other table uses.
   */
  variant?: "default" | "numbered";
}

/**
 * Selection count, page size, page controls - rendered once above the table
 * and once below it (see `placement`).
 *
 * The left slot swaps to "N of M selected" while rows are checked - the count
 * belongs where the user is already looking, not in a separate banner.
 */
function DataTablePagination<TData>({
  table,
  pageSizeOptions = [10, 25, 50, 100],
  isFetching = false,
  placement = "bottom",
  variant = "default",
}: DataTablePaginationProps<TData>) {
  const selected = table.getFilteredSelectedRowModel().rows.length;
  // `getRowCount()` rather than the filtered row model: under server-side
  // paging the filtered model only holds the page in hand, so the readout
  // would say "of 25" on a 4,000-row list. It falls back to the same filtered
  // count when the table pages itself, so the client path is unchanged.
  const total = table.getRowCount();
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = table.getPageCount();
  // A phone gets the compact window (first, current, last) so the row never overflows.
  const isPhone = useMediaQuery("(max-width: 639px)");

  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-4 py-3", placement === "top" ? "border-b" : "border-t")}>
      <div className="text-muted-foreground text-[0.78125rem]">
        {selected > 0 ? (
          <><span className="text-foreground font-bold">{selected}</span> of {total} selected</>
        ) : (
          <>Showing <span className="text-foreground font-bold">
            {total === 0 ? 0 : pageIndex * pageSize + 1}-{Math.min((pageIndex + 1) * pageSize, total)}
          </span> of <span className="text-foreground font-bold">{total}</span></>
        )}
      </div>

      <div className="ms-auto flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground hidden text-[0.78125rem] font-medium sm:inline">Rows</span>
          {/* Through the kit's one dropdown entry point (DESIGN_SYSTEM.md
              §4.2) rather than the primitives, so the page-size list is
              counted like every other dropdown. The default is three options
              and every current caller passes a short list, so this is the plain
              select branch - but a caller that ever passes ten page sizes gets
              search for free, with no change here. */}
          <SelectField
            // The "Rows" caption is hidden below sm and is not a <label>, so the trigger
            // names itself (mobile slice 25, A11Y-03).
            aria-label="Rows per page"
            value={String(pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
            size="sm"
            className="w-[4.5rem]"
            options={pageSizeOptions.map((size) => ({
              value: String(size),
              label: String(size),
            }))}
          />
        </div>

        {variant === "numbered" ? (
          // Wraps rather than overflows: on touch every page button is 44 px (mobile slice 25),
          // and the phone window (first, …, current, …, last, plus Previous/Next) is seven of them.
          <nav aria-label="Pagination" className="flex flex-wrap items-center justify-end gap-1.5">
            {isFetching && <Spinner size="sm" label="Loading page" />}
            <Button variant="outline" size="icon-sm" aria-label="Previous page"
              onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage() || isFetching}>
              <ChevronLeft />
            </Button>
            {pageWindow(pageIndex + 1, pageCount, isPhone ? 0 : 1).map((item) => {
              if (item.type === "ellipsis") {
                return <span key={item.key} aria-hidden="true" className="text-muted-foreground text-[0.78125rem]">…</span>;
              }
              const current = item.page === pageIndex + 1;
              return (
                <Button key={item.page} variant={current ? "default" : "outline"} size="sm"
                  aria-label={`Page ${item.page}`} aria-current={current ? "page" : undefined}
                  onClick={() => table.setPageIndex(item.page - 1)} disabled={isFetching}>
                  {item.page}
                </Button>
              );
            })}
            <Button variant="outline" size="icon-sm" aria-label="Next page"
              onClick={() => table.nextPage()} disabled={!table.getCanNextPage() || isFetching}>
              <ChevronRight />
            </Button>
          </nav>
        ) : (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5 text-[0.78125rem] font-medium">
              Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
              {/* Keeps the old page's rows on screen (the caller's own
                  keepPreviousData) rather than blanking to a skeleton, so this is
                  the only signal a page change is actually in flight. */}
              {isFetching && <Spinner size="sm" label="Loading page" />}
            </span>

            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon-sm" aria-label="First page" className="hidden sm:inline-flex"
                onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage() || isFetching}>
                <ChevronsLeft />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Previous page"
                onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage() || isFetching}>
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Next page"
                onClick={() => table.nextPage()} disabled={!table.getCanNextPage() || isFetching}>
                <ChevronRight />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Last page" className="hidden sm:inline-flex"
                onClick={() => table.setPageIndex(pageCount - 1)} disabled={!table.getCanNextPage() || isFetching}>
                <ChevronsRight />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { DataTablePagination };
