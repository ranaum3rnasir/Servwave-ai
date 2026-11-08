"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Cell,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnSizingState,
  type Header,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type RowData,
  type Table as TanstackTable,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table";

import { cn } from "@/ui-kit/lib/utils";
import { Skeleton } from "@/ui-kit/components/ui/skeleton";
import { useMediaQuery } from "@/ui-kit/hooks/useMediaQuery";

// Merges with the app's existing ColumnMeta augmentation in
// components/data/data-table.tsx, which already supplies `fixed` and `pinned`.
// The kit adds `label` so the column-visibility menu can show "Scheduled" and
// not "scheduledAt". `pinned` is redeclared with the identical type so a column
// set can be ported between the two tables verbatim.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    pinned?: boolean;
  }
}
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/ui-kit/components/ui/table";
import { DataTablePagination } from "./dataTablePagination";

/**
 * NOT HERE: the per-user saved view.
 *
 * The table accepted a `savedView` adapter - the resolved state of the app's
 * `useTableView` - restored the stored column widths and visibility once on
 * mount, and handed the render prop a `saveView`/`resetColumnSizing` pair for
 * the toolbar's "View" menu to call. That menu was removed at the owner's
 * request, which left no way to save a view and no way to undo a column drag,
 * so the whole path came out with it rather than persisting a layout the user
 * can no longer manage.
 *
 * `frontend/src/hooks/useTableView.ts` is untouched: the LEGACY table
 * (`components/data/data-table.tsx`) still drives it from `tableKey`, and
 * legacy is the live app.
 */
export interface DataTableProps<TData, TValue> {
  /**
   * Column widths are authoritative. Leftover container width is taken up by a
   * trailing spacer cell, not by a neighbouring column - see the note on
   * `spacer` below for why that distinction matters.
   */
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Stable row identity - required for selection to survive sorting or paging. */
  getRowId?: (row: TData, index: number) => string;
  isLoading?: boolean;
  /** Rendered in place of the body when there are no rows. */
  empty?: React.ReactNode;
  /** Receives the table instance so a parent can render toolbars and bulk bars. */
  children?: (table: TanstackTable<TData>) => React.ReactNode;
  onRowClick?: (row: TData) => void;
  initialPageSize?: number;
  className?: string;
  /**
   * SERVER-SIDE PAGING. Pass `page` (1-based) and the table stops owning
   * pagination: TanStack switches to `manualPagination`, the footer reports
   * these numbers, and its controls call back out instead of slicing rows.
   *
   * A page that pages on the server otherwise has to render its own controls
   * somewhere else, and then the list has two of them - which is the state
   * this exists to remove. Leave `page` undefined and nothing changes: the
   * table pages itself exactly as before.
   */
  page?: number;
  /** Total pages the server reports. Drives "Page n of m" and Next/Last. */
  pageCount?: number;
  onPageChange?: (page: number) => void;
  /** Rows per page. Controlled only alongside `page`. */
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
  /** Total matching rows on the server - the "of N" in the footer readout. */
  rowCount?: number;

  /**
   * CONTROLLED SORTING. Standard TanStack pattern: pass `sorting` to own the
   * state, `onSortingChange` to observe it, or neither and the table keeps
   * sorting itself exactly as before.
   *
   * Passing only the callback is the useful middle case - the table still owns
   * the state and the page just watches it.
   */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** The rows arrive already ordered; do not re-sort them client-side. */
  manualSorting?: boolean;

  /** CONTROLLED ROW SELECTION. Same three modes as `sorting`. */
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (rowSelection: RowSelectionState) => void;

  /** CONTROLLED COLUMN VISIBILITY. Same three modes as `sorting`. */
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (columnVisibility: VisibilityState) => void;
  /**
   * Columns that start hidden, for a table that still owns its own visibility -
   * the "these four money columns are off until asked for" case. Ignored when
   * `columnVisibility` is passed, since that prop already says everything.
   */
  defaultColumnVisibility?: VisibilityState;

  /**
   * Renders a drag grip on every resizable column header. Off by default: the
   * table has always accepted column sizing state, but never drew the handle
   * that lets a user change it, so turning this on is the only visible change.
   */
  enableColumnResizing?: boolean;

  /**
   * Below the `md` breakpoint, render each row as a labelled card instead of
   * forcing a wide horizontal scroll. Opt-in, so no existing list's phone
   * layout moves until it asks for it.
   */
  mobileCards?: boolean;

  /**
   * NOT HERE: row virtualization.
   *
   * The legacy table virtualizes past 40 rows, but only because its body is a
   * fixed-height scroller - `useVirtualizer` needs a scroll element with a
   * measurable viewport, and this table deliberately has none: it grows to its
   * content and the PAGE scrolls. Adding one would change how every one of the
   * nine existing lists scrolls, which is a layout decision, not a prop.
   *
   * It also matters much less here. This table pages at 25 by default and every
   * v2 list pages on the server, so a row model past 40 is the exception rather
   * than the norm the legacy table was tuned for. Scoped out deliberately - see
   * the branch report.
   */
}

/**
 * Controlled-or-not table state.
 *
 * Three modes, and the third is the one the module branches kept reaching for:
 *   - value + onChange  -> the parent owns it
 *   - onChange only     -> the table owns it, the parent watches
 *   - neither           -> the table owns it, silently (the original behaviour)
 *
 * The current value goes through a ref because TanStack hands back an updater
 * over the state it thinks is current, and resolving that updater against a
 * stale closure drops every second change.
 */
function useTableState<T>(
  controlled: T | undefined,
  onChange: ((next: T) => void) | undefined,
  initial: T,
): [T, (updater: Updater<T>) => void] {
  const [internal, setInternal] = React.useState<T>(initial);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : internal;

  // Both refs are written DURING RENDER on purpose, and must stay that way.
  //
  // TanStack calls `set` with an updater over the state it believes is current,
  // and `set` is memoized, so it has to resolve that updater against the newest
  // `value` rather than the one its closure captured. In the controlled mode
  // `value` IS the incoming prop, so a parent that pushes new sorting (a URL
  // param, a reset button) can commit a render and have `set` fire before
  // React flushes passive effects. Moving these writes into an effect would
  // resolve that updater against the previous value and drop the change -
  // precisely the every-second-change bug the docblock above describes.
  const valueRef = React.useRef(value);
  // eslint-disable-next-line react-hooks/refs -- see above: the updater must resolve against the value from THIS render, before effects flush
  valueRef.current = value;

  const onChangeRef = React.useRef(onChange);
  // eslint-disable-next-line react-hooks/refs -- the notify callback must be this render's, so a parent swapping handlers is never called on the stale one
  onChangeRef.current = onChange;

  const set = React.useCallback((updater: Updater<T>) => {
    const next = typeof updater === "function"
      ? (updater as (old: T) => T)(valueRef.current)
      : updater;
    if (!isControlled) setInternal(next);
    onChangeRef.current?.(next);
  }, [isControlled]);

  return [value, set];
}

/**
 * TanStack Table, wired up.
 *
 * TanStack is headless - it owns sorting, filtering, selection, visibility and
 * pagination state; every pixel is ours. That split is the reason not to
 * hand-roll: the moment a table needs "sort by column, filter, select across
 * pages, then hide a column", ad-hoc useState turns into a small state machine
 * with bugs at every intersection.
 *
 * Note `getRowId`. Without it, selection is keyed by row index, so sorting the
 * table silently reassigns every checkbox to a different record.
 *
 *   <DataTable columns={columns} data={jobs} getRowId={(job) => job.id}>
 *     {(table) => <DataTableToolbar table={table} … />}
 *   </DataTable>
 */
function DataTable<TData, TValue>({
  columns, data, getRowId, isLoading, empty, children, onRowClick,
  initialPageSize = 25, className,
  page, pageCount, onPageChange, pageSize, onPageSizeChange, rowCount,
  sorting: sortingProp, onSortingChange, manualSorting,
  rowSelection: rowSelectionProp, onRowSelectionChange,
  columnVisibility: columnVisibilityProp, onColumnVisibilityChange, defaultColumnVisibility,
  enableColumnResizing = false, mobileCards = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useTableState<SortingState>(sortingProp, onSortingChange, []);
  const [rowSelection, setRowSelection] = useTableState<RowSelectionState>(
    rowSelectionProp, onRowSelectionChange, {},
  );
  const [columnVisibility, setColumnVisibility] = useTableState<VisibilityState>(
    columnVisibilityProp, onColumnVisibilityChange, defaultColumnVisibility ?? {},
  );
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});

  // Controlled only when a `page` arrives. Spread conditionally rather than
  // always passing `pagination`, so the uncontrolled path keeps its own state
  // in `initialState` and behaves exactly as it did before this prop existed.
  const serverPaged = page !== undefined;
  const pagination = React.useMemo(
    () => ({ pageIndex: Math.max(0, (page ?? 1) - 1), pageSize: pageSize ?? initialPageSize }),
    [page, pageSize, initialPageSize],
  );

  // TanStack hands back either the next state or an updater over the current
  // one; both forms have to be resolved before the two halves are lifted out.
  const handlePaginationChange = React.useCallback((updater: Updater<PaginationState>) => {
    const next = typeof updater === "function" ? updater(pagination) : updater;
    if (next.pageIndex !== pagination.pageIndex) onPageChange?.(next.pageIndex + 1);
    if (next.pageSize !== pagination.pageSize) onPageSizeChange?.(next.pageSize);
  }, [pagination, onPageChange, onPageSizeChange]);

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      sorting, columnFilters, columnVisibility, rowSelection, columnSizing,
      ...(serverPaged && { pagination }),
    },
    initialState: { pagination: { pageIndex: 0, pageSize: initialPageSize } },
    ...(serverPaged && {
      manualPagination: true,
      pageCount,
      rowCount,
      onPaginationChange: handlePaginationChange,
    }),
    ...(manualSorting && { manualSorting: true }),
    enableRowSelection: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const visibleColumns = table.getVisibleLeafColumns().length;
  const rows = table.getRowModel().rows;

  const isMobile = useMediaQuery("(max-width: 767px)");
  const showCards = mobileCards && isMobile;

  /**
   * The table always fills its container, and no column becomes a dead strip.
   *
   * Leftover width is shared across the flexible columns in proportion to their
   * current size. The two obvious shortcuts are both wrong: parking the surplus
   * in the last column just relocates the gap, and a trailing spacer makes the
   * gap official.
   *
   * During a resize, only columns to the *right* of the grip take the change.
   * Nothing left of the handle moves, so the boundary tracks the cursor
   * one-to-one; spreading the change across all columns would drag the handle
   * away from the pointer. Freeze the rendered widths on pointerdown before
   * doing this - `columnSizing` holds base sizes, and starting from those makes
   * every column jump as the surplus is recomputed from the wrong baseline.
   *
   * Mark fixed-purpose columns (selection checkbox, row actions) with
   * `meta.fixed` so they keep their size.
   */
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState(0);
  const [scrollLeft, setScrollLeft] = React.useState(0);
  const scrollRafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        setScrollLeft(el.scrollLeft);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    setScrollLeft(el.scrollLeft);

    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      el.removeEventListener("scroll", onScroll);
    };
  }, [showCards]);
  // useLayoutEffect, and a synchronous first read, because ResizeObserver only
  // reports AFTER a paint. With the observer alone the first frame was always
  // laid out from `available = 0` - every column at its declared size, summing
  // to more than the viewport - and the corrected distribution landed one frame
  // later. That one frame is the flicker people described as the table "not
  // drawing its column separators until you leave the page and come back".
  React.useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    setAvailable(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
    // The container only exists in the table layout, so the observer has to be
    // re-attached when the card layout hands the table back.
  }, [showCards]);
  /**
   * The widths in force when the current resize STARTED, or null when no drag
   * is in progress.
   *
   * A resize has to move one boundary and leave every other column where the
   * eye last saw it. Recomputing the whole distribution from `columnSizing` on
   * every mouse-move cannot do that: `columnSizing` holds base sizes, the
   * distribution below re-derives everything from them, and the result is that
   * the handle drifts away from the cursor while unrelated columns twitch. So
   * the rendered layout is frozen on pointer-down and the drag is applied as a
   * delta against that frozen picture.
   */
  const [resizeBase, setResizeBase] = React.useState<
    { columnId: string; rendered: Record<string, number>; size: number } | null
  >(null);

  const layout = React.useMemo(() => {
    const columns = table.getVisibleLeafColumns();
    const width: Record<string, number> = {};
    columns.forEach((column) => { width[column.id] = column.getSize(); });

    // `width` is populated for every visible column directly above, so these
    // lookups are always present; the helper exists to satisfy
    // noUncheckedIndexedAccess without widening the arithmetic to `undefined`.
    const at = (id: string) => width[id] ?? 0;
    const floorOf = (column: (typeof columns)[number]) =>
      // TanStack's own default minSize is 20; the kit asserted this non-null,
      // which yielded NaN for any column that never set one.
      (column.columnDef.meta as { fixed?: boolean })?.fixed
        ? at(column.id)
        : Math.max(column.columnDef.minSize ?? 20, 56);

    /**
     * A LIVE RESIZE. The frozen picture, with the drag's delta moved across the
     * one boundary the user has hold of.
     *
     * Columns LEFT of the handle do not move at all - that is what makes the
     * boundary track the cursor one-to-one. Columns to the RIGHT absorb the
     * change between them, proportionally, down to their floors; once they are
     * all on their floor the table simply gets wider and the container scrolls,
     * which is better than the alternative of the handle stopping dead.
     */
    if (resizeBase) {
      const dragged = columns.find((column) => column.id === resizeBase.columnId);
      const rendered = resizeBase.rendered;
      if (dragged && rendered[resizeBase.columnId] !== undefined) {
        columns.forEach((column) => { width[column.id] = rendered[column.id] ?? column.getSize(); });

        const index = columns.indexOf(dragged);
        const rightward = columns
          .slice(index + 1)
          .filter((column) => !(column.columnDef.meta as { fixed?: boolean })?.fixed);

        // How far the pointer has travelled, in the same units the frozen
        // picture is in. TanStack has already clamped it to the column's own
        // min/max, so this never asks for a negative width.
        const wanted = dragged.getSize() - resizeBase.size;
        const headroom = rightward.reduce((sum, column) => sum + (at(column.id) - floorOf(column)), 0);
        const delta = Math.max(wanted, -(at(dragged.id) - floorOf(dragged)));

        width[dragged.id] = at(dragged.id) + delta;

        // Take it back off the right-hand side, sharing the take in proportion
        // to how much slack each column has rather than to its width - a column
        // already at its floor must contribute nothing.
        if (delta > 0 && headroom > 0) {
          for (const column of rightward) {
            const slack = at(column.id) - floorOf(column);
            width[column.id] = at(column.id) - Math.min(slack, delta * (slack / headroom));
          }
        } else if (delta < 0 && rightward.length) {
          // Giving width back to the right-hand side. Shared by current width,
          // since growing runs into no ceiling.
          const rightTotal = rightward.reduce((sum, column) => sum + at(column.id), 0);
          for (const column of rightward) {
            width[column.id] = at(column.id)
              + (rightTotal > 0 ? -delta * (at(column.id) / rightTotal) : -delta / rightward.length);
          }
        }

        columns.forEach((column) => { width[column.id] = Math.round(at(column.id)); });
        return width;
      }
    }

    if (!available) return width;

    const pool = columns.filter((column) => !(column.columnDef.meta as { fixed?: boolean })?.fixed);
    if (!pool.length) return width;

    /**
     * ONLY SURPLUS IS DISTRIBUTED. A table that wants more room than it has
     * scrolls; it does not get squeezed.
     *
     * The previous rule went both ways - it shared out spare width AND clawed
     * width back when the columns asked for too much - and the clawback is what
     * broke these pages. `meta.fixed` turns out to mean "this column has a
     * width I chose", and most list column sets mark most of their columns that
     * way: on /v2/leads ten of thirteen are fixed and they alone add up to the
     * full container, so the entire deficit landed on the three that were not.
     * Customer, Service Request and Location were each handed their floor while
     * every other column kept its declared size, which is the collapsed-column
     * layout on that page.
     *
     * Refusing to shrink is also what makes resizing behave: widening a column
     * widens the table and the container scrolls, instead of the extra pixels
     * being silently taken back off its neighbours on the next distribution.
     */
    const total = columns.reduce((sum, column) => sum + at(column.id), 0);
    const surplus = available - total;
    if (surplus <= 0) return width;

    const poolTotal = pool.reduce((sum, column) => sum + at(column.id), 0);
    if (poolTotal <= 0) return width;
    for (const column of pool) width[column.id] = at(column.id) + surplus * (at(column.id) / poolTotal);

    // Round once, at the end, then walk the leftover pixel or two out across
    // the flexible columns rather than dumping the whole remainder on one.
    for (const column of columns) width[column.id] = Math.round(at(column.id));
    let drift = available - columns.reduce((sum, column) => sum + at(column.id), 0);
    for (let step = 0; drift !== 0 && step < Math.abs(drift) + pool.length; step++) {
      const column = pool[step % pool.length];
      if (!column) break;
      if (drift > 0) { width[column.id] = at(column.id) + 1; drift -= 1; }
      else if (at(column.id) - 1 >= floorOf(column)) { width[column.id] = at(column.id) - 1; drift += 1; }
    }
    return width;
  }, [table, available, columnSizing, columnVisibility, resizeBase]);

  /**
   * The layout as last rendered, readable from an event handler.
   *
   * `beginResize` fires during the pointer-down that CREATES `resizeBase`, so
   * it needs the pre-drag picture; closing over `layout` would make the handler
   * a new function on every distribution change, and reading it out of a ref
   * keeps the freeze exact without that churn.
   */
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;

  /** What the distribution adds up to - the table's own width. */
  const tableWidth = React.useMemo(
    () => table.getVisibleLeafColumns().reduce((sum, column) => sum + (layout[column.id] ?? 0), 0),
    [table, layout],
  );

  /**
   * Start a resize: freeze the picture, then hand the event on to TanStack.
   *
   * The frozen copy is released on the next pointer-up ANYWHERE, not on the
   * grip - the pointer leaves the narrow handle within a frame or two of the
   * drag starting, so a listener on the grip itself would never fire.
   */
  const beginResize = React.useCallback(
    (header: Header<TData, unknown>) => (event: React.MouseEvent | React.TouchEvent) => {
      setResizeBase({
        columnId: header.column.id,
        rendered: { ...layoutRef.current },
        size: header.column.getSize(),
      });
      header.getResizeHandler()(event);
    },
    [],
  );

  React.useEffect(() => {
    if (!resizeBase) return;
    const release = () => setResizeBase(null);
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    return () => {
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, [resizeBase]);

  /**
   * The columns that actually get pinned, in order.
   *
   * Only the LEADING run of pinned columns is honoured. A pinned column with an
   * unpinned one before it would have to be offset by a width that scrolls
   * away, so it lands on top of its neighbour instead of beside it - the
   * failure mode is worse than not pinning at all, so the run stops at the
   * first unpinned column.
   */
  const pinnedIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const column of table.getVisibleLeafColumns()) {
      if (!column.columnDef.meta?.pinned) break;
      ids.push(column.id);
    }
    return ids;
  }, [table, columnVisibility]);

  /**
   * What the pinned columns actually RENDER at, read back from the DOM.
   *
   * `layout` above is a request, not a fact. The table renders
   * `table-layout: auto`, so the browser recomputes every column from its
   * content and routinely disagrees - and a sticky `left` built from the
   * request then parks the column somewhere it does not sit. Because a pinned
   * cell is opaque, it paints over its neighbour rather than merely sitting
   * wrong. Measured on /v2/inventory: SKU asks 120px and renders 85px, which
   * put Item's sticky edge 35px too far right and clipped the first ~3
   * characters off every line of the Category column, header included. On
   * /v2/leads the sign is flipped (90 asked, 102 rendered) and it hides 12px
   * of the Customer column as soon as the table scrolls.
   *
   * Measuring, rather than switching the table to `table-layout: fixed` the
   * way the legacy table does, is the narrow fix: fixed layout would make
   * `layout` authoritative and correct the offsets too, but it also hands
   * every column width in six lists to the deficit branch above, which
   * squeezes the first flexible column to its minSize (on that same page Item
   * asks 260 and is assigned 20), with no truncation to contain the result.
   * This changes offsets only - not one column width moves.
   */
  const [renderedWidths, setRenderedWidths] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cells: [string, HTMLElement][] = [];
    for (const id of pinnedIds) {
      const cell = container.querySelector<HTMLElement>(`thead [data-col-id="${id}"]`);
      if (cell) cells.push([id, cell]);
    }
    if (!cells.length) return;

    const read = () => {
      const next: Record<string, number> = {};
      for (const [id, cell] of cells) next[id] = cell.getBoundingClientRect().width;
      setRenderedWidths((prev) =>
        cells.every(([id]) => prev[id] === next[id]) ? prev : next,
      );
    };

    // The observer catches a later reflow - a window resize, a column made
    // visible, content that rewraps. `read()` covers the first paint, which is
    // the one the observer never reports.
    const observer = new ResizeObserver(read);
    for (const [, cell] of cells) observer.observe(cell);
    read();
    return () => observer.disconnect();
  }, [pinnedIds, showCards, layout]);

  /** Sticky-left offset per pinned column - where each one actually starts. */
  const { pinnedOffsets, totalPinnedWidth, columnLeftOffsets } = React.useMemo(() => {
    const pOffsets: Record<string, number> = {};
    const cOffsets: Record<string, number> = {};
    let running = 0;
    let pinnedTotal = 0;
    let inPinnedRun = true;

    for (const column of table.getVisibleLeafColumns()) {
      cOffsets[column.id] = running;
      const rendered = renderedWidths[column.id];
      const colWidth = rendered && rendered > 0 ? rendered : layout[column.id] ?? column.getSize();

      if (inPinnedRun && column.columnDef.meta?.pinned) {
        pOffsets[column.id] = running;
        pinnedTotal = running + colWidth;
      } else {
        inPinnedRun = false;
      }
      running += colWidth;
    }
    return { pinnedOffsets: pOffsets, totalPinnedWidth: pinnedTotal, columnLeftOffsets: cOffsets };
  }, [table, layout, renderedWidths]);

  const pinnedStyle = (columnId: string, zIndex: number): React.CSSProperties =>
    pinnedOffsets[columnId] === undefined
      ? {}
      : { position: "sticky", left: pinnedOffsets[columnId], zIndex };

  const renderCell = (cell: Cell<TData, unknown>) => (
    <TableCell
      key={cell.id}
      pinned={pinnedOffsets[cell.column.id] !== undefined}
      style={pinnedStyle(cell.column.id, 2)}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </TableCell>
  );

  const body = showCards ? (
    /**
     * Phone layout: one labelled card per row.
     *
     * Reuses the same cell renderers and honours column visibility, so a list
     * gets its phone layout from its existing column set. A cell whose column
     * has no readable label - the selection checkbox, the row-actions menu -
     * renders right-aligned and unlabelled rather than under a made-up heading.
     */
    <div>
      {isLoading ? (
        Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 border-b px-4 py-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))
      ) : rows.length === 0 ? (
        <div className="px-4 py-3">{empty}</div>
      ) : (
        rows.map((row) => (
          <div
            key={row.id}
            data-slot="table-card"
            data-state={row.getIsSelected() ? "selected" : undefined}
            onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            className={cn(
              "border-b px-4 py-3 last:border-b-0",
              "data-[state=selected]:bg-selected",
              onRowClick && "cursor-pointer",
            )}
          >
            <dl className="space-y-1.5">
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta;
                const header = cell.column.columnDef.header;
                const label = meta?.label ?? (typeof header === "string" ? header : "");
                const value = flexRender(cell.column.columnDef.cell, cell.getContext());
                if (!label) {
                  return (
                    <dd key={cell.id} className="flex justify-end">{value}</dd>
                  );
                }
                return (
                  <div key={cell.id} className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground shrink-0 text-[11.5px] font-semibold">
                      {label}
                    </dt>
                    <dd className="min-w-0 flex-1 text-right text-[13px] break-words">
                      {value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))
      )}
    </div>
  ) : (
    /**
     * `table-fixed`, with an explicit width, is what makes every width above
     * MEAN something.
     *
     * Under the browser's default `table-layout: auto` a `width` on a cell is a
     * suggestion, and the browser re-derives the whole row from its content and
     * routinely ignores it - measured on this page, Customer was assigned 20px
     * and rendered at 184. That is why dragging a resize grip used to have no
     * visible effect: the state changed, the request changed, and the layout
     * the browser actually performed did not depend on either.
     *
     * The width is the sum of the distribution rather than `w-full`, so that a
     * table asking for more room than it has scrolls inside its container
     * instead of having its columns silently rescaled; `min-w-full` covers the
     * opposite case, where the distribution has not been measured yet.
     */
    <Table
      containerClassName="w-full"
      ref={containerRef}
      className="table-fixed min-w-full"
      style={{ width: tableWidth }}
    >
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className="hover:bg-kit-card">
            {headerGroup.headers.map((header) => {
              const pinned = pinnedOffsets[header.column.id] !== undefined;
              const resizable = enableColumnResizing && header.column.getCanResize();
              const colWidth = layout[header.column.id] ?? header.column.getSize();
              const colStart = columnLeftOffsets[header.column.id] ?? 0;
              const colMeta = header.column.columnDef.meta as { label?: string; align?: string } | undefined;
              const colTitle = colMeta?.label ?? (typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : header.column.id);

              // If unpinned and partially tucked under pinned columns (or container left edge):
              // Shift the header content rightwards so the label remains visible and legible at the boundary
              let headerSlideX = 0;
              if (!pinned && colWidth > 40 && colMeta?.align !== 'right') {
                const visibleLeft = colStart - scrollLeft;
                if (visibleLeft < totalPinnedWidth && visibleLeft + colWidth > totalPinnedWidth) {
                  const tucked = totalPinnedWidth - visibleLeft;
                  const maxShift = Math.max(0, colWidth - 44);
                  headerSlideX = Math.min(Math.max(0, tucked), maxShift);
                }
              }

              return (
                <TableHead
                  key={header.id}
                  // The handle the pinned-width measurement above reads back.
                  // Same attribute the legacy table uses for the same job.
                  data-col-id={header.column.id}
                  pinned={pinned}
                  title={colTitle ? String(colTitle) : undefined}
                  style={{ width: layout[header.column.id], ...pinnedStyle(header.column.id, 3) }}
                  className={cn((pinned || resizable) && "relative")}
                >
                  <div
                    className="w-full flex items-center will-change-transform"
                    style={
                      headerSlideX > 0
                        ? { transform: `translateX(${headerSlideX}px)` }
                        : undefined
                    }
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </div>
                  {resizable && (
                    /* Absolutely positioned so the grip straddles the column
                       boundary; `touch-none` stops a drag from scrolling the
                       page out from under it on a touch screen. */
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${(header.column.columnDef.meta?.label ?? header.column.id)} column`}
                      onMouseDown={beginResize(header as Header<TData, unknown>)}
                      onTouchStart={beginResize(header as Header<TData, unknown>)}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={() => header.column.resetSize()}
                      className={cn(
                        // Wider than the hairline it paints. A 1px grip is a
                        // 1px target, and people concluded the table could not
                        // be resized because they kept missing it.
                        //
                        // The grip sits INSIDE the header cell rather than
                        // straddling the boundary. TableHead clips its overflow
                        // so a long header cannot run into the next column, and
                        // that clip applies to paint AND to hit-testing - a grip
                        // centred on the boundary spent half its width outside
                        // it, so an 8px target was really 4px and the 1px rule
                        // rendered as a half-pixel sliver. Flush right, the
                        // whole 12px is live and the rule lands on the boundary
                        // intact.
                        "absolute top-0 right-0 z-1 h-full w-3 cursor-col-resize touch-none select-none",
                        "after:absolute after:inset-y-1.5 after:right-0 after:transition-all",
                        // At rest a hairline in the control-edge colour: enough
                        // to read as a boundary you can take hold of, not enough
                        // to put a grid back into the header. Hover and drag
                        // double it to 2px, run it full height and darken it, so
                        // the thing under the cursor is unmistakable.
                        header.column.getIsResizing()
                          ? "after:inset-y-0 after:w-0.5 after:bg-brand"
                          : "after:w-px after:bg-input hover:after:inset-y-0 hover:after:w-0.5 hover:after:bg-input-hover",
                      )}
                    />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>

      <TableBody>
        {isLoading ? (
          // Skeleton rows mirror the real column count, so the layout never
          // jumps when data lands.
          Array.from({ length: 6 }).map((_, rowIndex) => (
            <TableRow key={rowIndex} className="hover:bg-kit-card">
              {Array.from({ length: visibleColumns }).map((_, colIndex) => (
                <TableCell key={colIndex}>
                  <Skeleton className={cn("h-3", colIndex === 0 ? "w-4" : colIndex === 1 ? "w-14" : "w-24")} />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : rows.length === 0 ? (
          <TableRow className="hover:bg-kit-card">
            <TableCell colSpan={visibleColumns} padding="none">{empty}</TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? "selected" : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              className={cn(onRowClick && "cursor-pointer")}
            >
              {row.getVisibleCells().map(renderCell)}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

  return (
    <div className={cn("bg-kit-card overflow-hidden rounded-lg border shadow-sm", className)}>
      {children?.(table)}
      {body}
      <DataTablePagination table={table} />
    </div>
  );
}

export { DataTable };
export type { ColumnDef, TanstackTable };
