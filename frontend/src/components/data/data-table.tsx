import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTableView, applySavedView } from '@/hooks/useTableView';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { TableViewConfig } from '@/lib/api/table-views';
import {
  ColumnDef,
  RowData,
  VisibilityState,
  SortingState,
  RowSelectionState,
  Table,
  Row,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  ColumnResizeMode,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { computeLayout } from './table-flex';

/**
 * Estimate the minimum width (px) a header needs so its label is fully visible
 * (not ellipsis-truncated) by default. Headers render uppercase 12px semibold
 * with tracking-wide inside a `px-4` cell; sortable columns always reserve room
 * for the sort glyph. Deliberately generous: over-estimating widens a column a
 * touch, while under-estimating would clip the header — and the rule is that
 * every header is fully visible by default. A manual resize opts a column out.
 */
export function estimateHeaderWidth(label: string, sortable: boolean): number {
  const CHAR_PX = 9; // uppercase 12px semibold + tracking-wide, generous
  const CELL_PADDING = 32; // TableHead px-4 → 16px each side
  const SORT_ICON = sortable ? 20 : 0; // gap-1 + sort glyph (reserved when sortable)
  const SAFETY = 6;
  return Math.ceil(label.length * CHAR_PX + CELL_PADDING + SORT_ICON + SAFETY);
}

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    locked?: boolean      // identity col: non-hideable, pinned
    pinned?: boolean      // sticky left
    growWeight?: number   // weighted flex-fill
    minWidth?: number     // per-column min (global fallback: 64)
    fixed?: boolean       // never grows
  }
}
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/form/SelectField';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  pagination?: PaginationMeta;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  isLoading?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  headerActions?: React.ReactNode;
  filters?: React.ReactNode;
  activeFilters?: React.ReactNode;
  onRowClick?: (row: TData) => void;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (visibility: VisibilityState) => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
  onSaveView?: () => void;
  tableKey?: string;
  // Opt-in row selection (TanStack Table's built-in row-selection state, wired via a synthetic
  // '__select' checkbox column) — OFF by default. Only a caller that passes `enableRowSelection`
  // gets the checkbox column at all; the other DataTable callers are unaffected (desktop table
  // only — the mobile card view never renders a selection checkbox).
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  getRowId?: (row: TData) => string;
}

// ─── Truncated Cell with Tooltip ─────────────────────────
const TruncatedCell = React.memo(function TruncatedCell({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollWidth > el.clientWidth);
  }, []);

  useEffect(() => {
    checkTruncation();
  }, [children, checkTruncation]);

  const content = (
    <div ref={ref} className="overflow-hidden text-ellipsis whitespace-nowrap">
      {children}
    </div>
  );

  if (!isTruncated) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {children}
      </TooltipContent>
    </Tooltip>
  );
});

// ─── Column Visibility Toggle ────────────────────────────
interface ColumnVisibilityToggleProps {
  table: ReturnType<typeof useReactTable>;
  onSaveView?: () => void;
  onResetWidths?: () => void;
}

function ColumnVisibilityToggle({ table, onSaveView, onResetWidths }: ColumnVisibilityToggleProps) {
  // '__select' (opt-in row-selection checkbox column) is enableHiding:false chrome, same as
  // 'actions' — exclude both from the picker rather than rendering a disabled, mislabeled row.
  const allColumns = table.getAllLeafColumns().filter((col) => col.id !== 'actions' && col.id !== '__select');
  const hiddenCount = allColumns.filter((col) => !col.getIsVisible()).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <SlidersHorizontal className="h-4 w-4" />
          Columns
          {hiddenCount > 0 && (
            <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              {hiddenCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="space-y-1">
          {allColumns.map((column) => {
            const isLocked = column.columnDef.meta?.locked;
            const label = typeof column.columnDef.header === 'string'
              ? column.columnDef.header
              : column.id.replace(/_/g, ' ');
            return (
              <label
                key={column.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  isLocked ? "cursor-not-allowed opacity-60" : "hover:bg-background-light/50 cursor-pointer"
                )}
              >
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={isLocked ? undefined : column.getToggleVisibilityHandler()}
                  disabled={isLocked}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary/20 disabled:cursor-not-allowed"
                />
                <span className="capitalize flex items-center gap-1">
                  {label}
                  {isLocked && <span>🔒</span>}
                </span>
              </label>
            );
          })}
        </div>

        <Separator className="my-2" />

        {/* Raw by design: the three rows below are popover menu items
            (dropdown-menu-item shape), not Buttons. */}
        <div className="space-y-0.5">
          {onSaveView && (
            <button
              onClick={onSaveView}
              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-background-light/50 text-left"
            >
              <span>💾</span>
              <span>Save current view</span>
            </button>
          )}
          <button
            onClick={() => table.toggleAllColumnsVisible(true)}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-background-light/50 text-left"
          >
            <span>↺</span>
            <span>Reset to default columns</span>
          </button>
          <button
            onClick={onResetWidths}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-background-light/50 text-left"
          >
            <span>↺</span>
            <span>Reset column widths</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Right-click Context Menu ────────────────────────────
interface ContextMenuState {
  x: number;
  y: number;
  columnId: string;
}

function HeaderContextMenu({
  state,
  onResetThis,
  onResetAll,
  onClose,
}: {
  state: ContextMenuState;
  onResetThis: (columnId: string) => void;
  onResetAll: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{ top: state.y, left: state.x, position: 'fixed' }}
      className="z-50 min-w-40 rounded-lg border border-border bg-surface-light shadow-lg py-1"
    >
      {/* Raw by design: both rows below are a custom right-click context menu's
          items (dropdown-menu-item shape), not Buttons. */}
      <button
        onClick={() => { onResetThis(state.columnId); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-background-light/50 text-left"
      >
        ↺ Reset this column width
      </button>
      <button
        onClick={() => { onResetAll(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-background-light/50 text-left"
      >
        ↺ Reset all widths
      </button>
    </div>
  );
}

// ─── Row-selection checkbox column (opt-in — see DataTableProps.enableRowSelection) ──────
// Extracted as small named components (not inline arrow-fn `header`/`cell` in the ColumnDef
// object literal below) so the header's useRef/useEffect indeterminate-state logic unambiguously
// satisfies rules-of-hooks: it's a real component, rendered by flexRender only when this column
// exists at all — which only happens when enableRowSelection is true, stable for the table's
// lifetime — not a hook called conditionally inline.
function SelectAllHeaderCheckbox({ table }: { table: Table<any> }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected();
  });
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all rows"
      checked={table.getIsAllRowsSelected()}
      onChange={table.getToggleAllRowsSelectedHandler()}
      className="h-4 w-4 rounded border-border text-primary focus:ring-primary/20"
    />
  );
}

function SelectRowCheckbox({ row }: { row: Row<any> }) {
  return (
    <input
      type="checkbox"
      aria-label="Select row"
      checked={row.getIsSelected()}
      onChange={row.getToggleSelectedHandler()}
      // TableRow has onClick={() => onRowClick?.(row.original)} — stop propagation so
      // checking a row's box doesn't also navigate away via the row click handler.
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 rounded border-border text-primary focus:ring-primary/20"
    />
  );
}

// Module scope — one stable column definition shared by every DataTable instance that opts in.
// `any` is deliberate here: this column's behavior never depends on TData's shape (pure
// selection-state plumbing), and it is cast to ColumnDef<TData, unknown> at the one call site
// (effectiveColumns below) where the real TData is known.
const selectColumn: ColumnDef<any, unknown> = {
  id: '__select',
  size: 40,
  enableSorting: false,
  enableHiding: false,
  // A fixed 40px checkbox column has no interior room for the resize handle rendered per-header
  // (renderResizeHandle's `absolute -right-1 w-2` div) without it overlapping the checkbox itself
  // and winning the hit-test — getCanResize() already bails renderResizeHandle out when false.
  enableResizing: false,
  // NOT meta.locked — table-flex.ts's computeLayout falls back to `visible.find(c => c.locked)`
  // as the surplus-width dump target whenever a column set has zero growable columns, and does
  // not itself check `fixed`. '__select' is prepended first, so marking it locked would make it
  // win that fallback ahead of the page's real identity column (e.g. Estimates' customer column)
  // once every growable column gets manually resized — a 40px checkbox absorbing hundreds of
  // px of surplus. It doesn't need `locked` anyway: enableHiding:false above already keeps it out
  // of the visibility picker (which is also filtered by id — see ColumnVisibilityToggle).
  meta: { pinned: true, fixed: true, minWidth: 40 },
  header: SelectAllHeaderCheckbox,
  cell: SelectRowCheckbox,
};

// ─── DataTable Component ─────────────────────────────────
export function DataTable<TData>({
  columns,
  data,
  pagination,
  onPageChange,
  isLoading,
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  headerActions,
  filters,
  activeFilters,
  onRowClick,
  columnVisibility,
  onColumnVisibilityChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  sorting,
  onSortingChange,
  manualSorting = true,
  onSaveView,
  tableKey,
  enableRowSelection: enableRowSelectionArg,
  rowSelection: rowSelectionProp,
  onRowSelectionChange: onRowSelectionChangeProp,
  getRowId: getRowIdProp,
}: DataTableProps<TData>) {
  // Render only the active layout (desktop table vs. mobile cards) instead of
  // shipping both behind CSS — avoids duplicated DOM (a11y/perf) and jsdom test
  // double-matches. The hidden md:block / md:hidden classes stay as CSS guards.
  const isMobile = useIsMobile();
  const [localSearch, setLocalSearch] = useState(searchValue || '');
  // When a page omits the controlled visibility props (passing only `tableKey`,
  // like Estimates/Leads/Jobs), DataTable self-manages column visibility so the
  // Columns picker hides live AND a saved view's hidden set restores on load.
  const visibilityControlled = columnVisibility !== undefined;
  const [internalVisibility, setInternalVisibility] = useState<VisibilityState>({});
  const effectiveVisibility = visibilityControlled ? columnVisibility : internalVisibility;
  const wasResizing = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Track columns that have been manually sized (by drag or double-click auto-fit)
  const [manuallySizedColumns, setManuallySizedColumns] = useState<Set<string>>(new Set());
  // Inner scroll-container content-box width (clientWidth) drives the flex layout — excludes the 1px borders + vertical-scrollbar gutter so columns never sum wider than the box (would phantom-overflow and let the sticky column clip its neighbor). Mirrors ResizableTable.tsx.
  const [containerWidth, setContainerWidth] = useState(800);
  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // ─── Server-backed saved view ────────────────────────
  // useTableView is always called (rules of hooks), but only acts when tableKey is set.
  // We fall back to a stable sentinel key when tableKey is absent.
  const effectiveKey = tableKey ?? '__no_key__';
  const { config: savedConfig, saveView } = useTableView(effectiveKey);
  const appliedForKey = useRef<string | null>(null);

  useEffect(() => {
    if (!tableKey || appliedForKey.current === effectiveKey || savedConfig === undefined) return;
    appliedForKey.current = effectiveKey;
    if (!savedConfig) return;

    // Build column defs from the column definitions passed to this table
    const colDefs = columns.map((col) => {
      const id = typeof col.id === 'string' ? col.id : (col as { accessorKey?: string }).accessorKey ?? '';
      const meta = (col as { meta?: { minWidth?: number; locked?: boolean } }).meta;
      return { id, minWidth: meta?.minWidth, locked: meta?.locked };
    }).filter((c) => c.id !== '');

    const defaults: Record<string, { width?: number; visible?: boolean; manuallySized?: boolean }> = {};
    for (const c of colDefs) {
      defaults[c.id] = { visible: true };
    }

    const merged = applySavedView(defaults, savedConfig, colDefs);

    // Apply visibility — drive the table directly (parallel to setColumnSizing
    // below) so the restored hidden set takes effect even when the page omits
    // the controlled props; also notify a controlled parent if present.
    const newVisibility: Record<string, boolean> = {};
    for (const [id, pref] of Object.entries(merged)) {
      if (pref.visible !== undefined) newVisibility[id] = pref.visible;
    }
    table.setColumnVisibility(newVisibility);
    onColumnVisibilityChange?.(newVisibility);

    // Apply sizing
    const newSizing: Record<string, number> = {};
    const newManuallySized = new Set<string>();
    for (const [id, pref] of Object.entries(merged)) {
      if (pref.width !== undefined) {
        newSizing[id] = pref.width;
      }
      if (pref.manuallySized) {
        newManuallySized.add(id);
      }
    }
    if (Object.keys(newSizing).length > 0) {
      table.setColumnSizing(newSizing);
    }
    if (newManuallySized.size > 0) {
      setManuallySizedColumns(newManuallySized);
    }
  // Run once when savedConfig resolves; table and columns are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedConfig, tableKey]);

  // Build the effective onSaveView: when tableKey is set, package current state and call saveView.
  // When tableKey is absent, fall back to the passed-in onSaveView prop.
  const effectiveOnSaveView = useCallback(() => {
    if (tableKey) {
      const sizing = table.getState().columnSizing;
      const visibility = table.getState().columnVisibility;
      const colsConfig: TableViewConfig['columns'] = {};

      for (const col of table.getAllColumns()) {
        colsConfig[col.id] = {
          width: sizing[col.id],
          visible: visibility[col.id] !== false,
          manuallySized: manuallySizedColumns.has(col.id),
        };
      }

      saveView({ version: 1, columns: colsConfig });
    } else {
      onSaveView?.();
    }
  // table is stable; manuallySizedColumns, saveView, onSaveView are the reactive deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, onSaveView, saveView, manuallySizedColumns]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange?.(localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch, onSearchChange]);

  // Sync external search value
  useEffect(() => {
    if (searchValue !== undefined && searchValue !== localSearch) {
      setLocalSearch(searchValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  // Reset wasResizing flag on global mouseup (covers drag ending anywhere).
  // Also clamp the final column size to the column's minWidth and record it as manually sized.
  useEffect(() => {
    const handleMouseUp = () => {
      if (wasResizing.current) {
        setTimeout(() => {
          wasResizing.current = false;

          // Clamp every sized column to its meta.minWidth and mark as manually sized
          const sizing = table.getState().columnSizing;
          const clamped: Record<string, number> = {};
          let hasChange = false;
          const newlySized = new Set<string>();

          for (const col of table.getAllColumns()) {
            const rawSize = sizing[col.id];
            if (rawSize === undefined) continue;
            const min = col.columnDef.meta?.minWidth ?? 64;
            const safe = Math.max(rawSize, min);
            if (safe !== rawSize) {
              clamped[col.id] = safe;
              hasChange = true;
            }
            newlySized.add(col.id);
          }

          if (hasChange) {
            table.setColumnSizing((prev) => ({ ...prev, ...clamped }));
          }
          setManuallySizedColumns((prev) => {
            const next = new Set(prev);
            newlySized.forEach((id) => next.add(id));
            return next;
          });
        }, 150);
      }
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  // table ref is stable; functional updater avoids stale closure on manuallySizedColumns
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the inner scroll container's content box (clientWidth) and re-measure on any size change. Depends on isMobile because scrollContainerRef only mounts when !isMobile (line ~683); re-run when it flips so the ref is live. The ?? 800 fallback (in the layout memo) covers the null-ref / pre-mount / jsdom frame.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  const [columnResizeMode] = useState<ColumnResizeMode>('onChange');

  // Opt-in '__select' checkbox column, prepended ONLY when enableRowSelection is set — every
  // other caller's `columns` array (and therefore its rendered column count) is untouched.
  const effectiveColumns = useMemo<ColumnDef<TData, unknown>[]>(
    () => (enableRowSelectionArg ? [selectColumn as ColumnDef<TData, unknown>, ...columns] : columns),
    [enableRowSelectionArg, columns]
  );

  const table = useReactTable({
    data,
    columns: effectiveColumns,
    getCoreRowModel: getCoreRowModel(),
    ...(onSortingChange && { getSortedRowModel: getSortedRowModel() }),
    enableColumnResizing: true,
    columnResizeMode,
    manualPagination: true,
    manualSorting,
    enableRowSelection: !!enableRowSelectionArg,
    getRowId: getRowIdProp ? (row) => getRowIdProp(row) : undefined,
    pageCount: pagination?.totalPages ?? -1,
    state: {
      columnVisibility: effectiveVisibility,
      ...(sorting !== undefined && { sorting }),
      ...(rowSelectionProp !== undefined && { rowSelection: rowSelectionProp }),
    },
    onColumnVisibilityChange: (updater) => {
      const next = typeof updater === 'function' ? updater(effectiveVisibility ?? {}) : updater;
      if (visibilityControlled) {
        onColumnVisibilityChange?.(next);
      } else {
        setInternalVisibility(next);
      }
    },
    onSortingChange: onSortingChange
      ? (updater) => {
          const next = typeof updater === 'function' ? updater(sorting ?? []) : updater;
          onSortingChange(next);
        }
      : undefined,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelectionProp ?? {}) : updater;
      onRowSelectionChangeProp?.(next);
    },
  });

  const isResizing = !!table.getState().columnSizingInfo.isResizingColumn;
  const resizingColumnId = table.getState().columnSizingInfo.isResizingColumn;

  // Build a map from column ID → header (for body cell resize handlers)
  const headerMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof table.getHeaderGroups>[number]['headers'][number]>();
    for (const group of table.getHeaderGroups()) {
      for (const header of group.headers) {
        map.set(header.column.id, header);
      }
    }
    return map;
  }, [table]);

  // ─── Virtualization (only when > 40 rows) ──────────────
  const rows = table.getRowModel().rows;
  const shouldVirtualize = rows.length > 40;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 41,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  const startItem = pagination ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const endItem = pagination ? Math.min(pagination.page * pagination.limit, pagination.total) : 0;

  // ─── Last pinned column id (gets right-edge shadow) ────
  const lastPinnedColId = useMemo(() => {
    const visibleCols = table.getAllColumns().filter((col) => col.getIsVisible());
    let last: string | undefined;
    for (const col of visibleCols) {
      if (col.columnDef.meta?.pinned) last = col.id;
    }
    return last;
  // Recompute when visibility changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.getState().columnVisibility]);

  // ─── Flex-fill layout computation ──────────────────────
  const layout = useMemo(() => {
    const cols = table.getAllColumns()
      .filter((col) => col.getIsVisible())
      .map((col) => {
        const manuallySized = manuallySizedColumns.has(col.id);
        // Floor every column to fit its header label so headers are fully visible
        // by default. A manual resize opts the column out (respect the user's width).
        const label = typeof col.columnDef.header === 'string' ? col.columnDef.header : '';
        const headerFloor = !manuallySized && label
          ? estimateHeaderWidth(label, col.getCanSort())
          : 0;
        const baseMin = col.columnDef.meta?.minWidth ?? 64;
        return {
          id: col.id,
          width: Math.max(col.getSize(), headerFloor),
          minWidth: Math.max(baseMin, headerFloor),
          growWeight: col.columnDef.meta?.growWeight,
          visible: col.getIsVisible(),
          manuallySized,
          fixed: col.columnDef.meta?.fixed,
          pinned: col.columnDef.meta?.pinned,
          locked: col.columnDef.meta?.locked,
        };
      });
    // NOTE: after this fix the DEFAULT table no longer phantom-overflows; a user who MANUALLY widens columns past the box can still overflow and see the sticky column overlap — that is inherent sticky-column behavior, out of scope for #454.
    return computeLayout({ containerWidth, columns: cols });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // containerWidth is the observed clientWidth of scrollContainerRef; it changes on mount + any resize.
    containerWidth,
    table.getState().columnSizing,
    table.getState().columnVisibility,
    manuallySizedColumns,
  ]);

  // Resize handle renderer for both header and body cells
  const renderResizeHandle = (columnId: string, isHeader: boolean) => {
    const header = headerMap.get(columnId);
    if (!header || !header.column.getCanResize()) return null;

    return (
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          wasResizing.current = true;
          header.getResizeHandler()?.(e);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          wasResizing.current = true;
          header.getResizeHandler()?.(e);
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          // Auto-fit measures only the visible row window due to virtualization
          // (same limitation as AG Grid — measuring all data rows defeats virtualization)
          const colId = header.column.id;
          const cells = document.querySelectorAll<HTMLElement>(`[data-col-id="${colId}"]`);
          const minWidth = header.column.columnDef.meta?.minWidth ?? 64;
          let maxWidth = minWidth;
          cells.forEach((cell) => {
            if (cell.scrollWidth > maxWidth) maxWidth = cell.scrollWidth;
          });
          const fittedWidth = Math.max(minWidth, Math.min(maxWidth, 600));
          table.setColumnSizing((prev) => ({ ...prev, [colId]: fittedWidth }));
          setManuallySizedColumns((prev) => new Set(prev).add(colId));
        }}
        role="separator"
        aria-orientation="vertical"
        className={cn(
          'absolute -right-1 top-0 h-full w-2 cursor-col-resize select-none touch-none z-10 flex justify-center',
          'after:content-[""] after:absolute after:top-0 after:h-full after:transition-colors',
          isHeader
            ? header.column.getIsResizing()
              ? 'after:w-0.5 after:bg-primary'
              : 'after:w-px after:bg-transparent hover:after:w-0.5 hover:after:bg-primary/50'
            : resizingColumnId === columnId
              ? 'after:w-0.5 after:bg-primary'
              : 'after:w-px after:bg-transparent hover:after:w-0.5 hover:after:bg-primary/30'
        )}
      />
    );
  };

  // Stable reset-widths callback for ColumnVisibilityToggle
  const handleResetWidths = useCallback(() => {
    table.resetColumnSizing();
    setManuallySizedColumns(new Set());
  }, [table]);

  // Sort click handler that guards against resize
  const handleSortClick = (canSort: boolean, toggleHandler: ((e: unknown) => void) | undefined) => {
    if (!canSort || !toggleHandler) return undefined;
    return (e: React.MouseEvent) => {
      if (wasResizing.current) return;
      toggleHandler(e);
    };
  };

  return (
    <TooltipProvider delayDuration={400}>
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 min-w-0 items-center gap-3">
          {/* min-w-0 — flex items default to min-width:auto, which blocks the
              wrapper from shrinking below the input's intrinsic width and
              overflows the toolbar at 640-900px viewports (#377). */}
          {onSearchChange && (
            <div className="relative w-full max-w-sm min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <Input
                placeholder={searchPlaceholder}
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}
          {filters}
        </div>
        {/* sm:shrink-0 — the actions are the fixed cluster the search yields to;
            flex-wrap lets buttons wrap (not clip) in the below-sm stacked mode (#377). */}
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <ColumnVisibilityToggle
            table={table as ReturnType<typeof useReactTable>}
            onSaveView={effectiveOnSaveView}
            onResetWidths={handleResetWidths}
          />
          {headerActions}
        </div>
      </div>

      {/* Active filters */}
      {activeFilters}

      {/* Table — desktop / tablet (≥ md). Rendered only above the md breakpoint
          (useIsMobile) so the row markup isn't duplicated in the DOM; the
          `hidden md:block` class stays as a CSS guard. On phones it would force a
          wide horizontal scroll, so the stacked cards below take over. */}
      {!isMobile && (
      <div ref={scrollContainerRef} className="hidden md:block rounded-card border border-border bg-surface-light shadow-card overflow-auto max-h-[calc(100vh-280px)]">
        <table className={cn(
          "caption-bottom text-sm table-fixed w-full",
          isResizing && "cursor-col-resize select-none"
        )}>
          <TableHeader className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-table-header border-b-2 border-border hover:bg-table-header">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();

                  return (
                    <TableHead
                      key={header.id}
                      data-col-id={header.column.id}
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide text-text-secondary relative group/th whitespace-nowrap border-r border-r-border last:border-r-0",
                        canSort && "cursor-pointer select-none"
                      )}
                      style={{
                        width: layout.widths[header.column.id] ?? header.getSize(),
                        ...(header.column.columnDef.meta?.pinned && layout.stickyOffsets[header.column.id] !== undefined
                          ? {
                              position: 'sticky',
                              left: layout.stickyOffsets[header.column.id],
                              zIndex: 3,
                              backgroundColor: 'rgb(var(--table-header))', // pinned header cell — matches header row token

                              ...(header.column.id === lastPinnedColId
                                ? { boxShadow: '2px 0 4px rgba(0,0,0,0.08)' }
                                : {}),
                            }
                          : {}),
                      }}
                      onClick={handleSortClick(canSort, header.column.getToggleSortingHandler())}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, columnId: header.column.id });
                      }}
                      aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : canSort ? 'none' : undefined}
                    >
                      <div className="flex items-center gap-1">
                        {/* '__select' is a 16px checkbox in a fixed 40px column — the label-truncation
                            span below (overflow-hidden, sized for text headers) clips it to a sliver
                            narrower than the checkbox itself, so its own center falls outside the
                            clickable area. Render it unwrapped instead of forcing it through that span. */}
                        {header.column.id === '__select' ? (
                          !header.isPlaceholder && flexRender(header.column.columnDef.header, header.getContext())
                        ) : (
                          <span className="overflow-hidden text-ellipsis">
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                        )}
                        {canSort && (
                          <span className="flex-shrink-0">
                            {sortDir === 'asc' ? (
                              <ArrowUp className="h-3.5 w-3.5 text-primary" />
                            ) : sortDir === 'desc' ? (
                              <ArrowDown className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <ArrowUpDown className="h-3.5 w-3.5 opacity-0 group-hover/th:opacity-40 transition-opacity" />
                            )}
                          </span>
                        )}
                      </div>
                      {renderResizeHandle(header.column.id, true)}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: pagination?.limit ?? 5 }).map((_, i) => (
                <TableRow key={i}>
                  {effectiveColumns.map((_, j) => (
                    <TableCell key={j} divider>
                      <div className="h-4 w-3/4 animate-pulse rounded bg-background-light" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={effectiveColumns.length}>
                  <EmptyState title="No results found." />
                </TableCell>
              </TableRow>
            ) : shouldVirtualize ? (
              (() => {
                const virtualRows = virtualizer.getVirtualItems();
                const totalSize = virtualizer.getTotalSize();
                const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
                const paddingBottom = virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1]!.end : 0;
                return (
                  <>
                    {paddingTop > 0 && <tr><td colSpan={effectiveColumns.length} style={{ height: paddingTop }} /></tr>}
                    {virtualRows.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <TableRow
                          key={row.id}
                          className={onRowClick ? 'cursor-pointer hover:bg-background-light/50' : ''}
                          onClick={() => { if (wasResizing.current) return; onRowClick?.(row.original); }}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              data-col-id={cell.column.id}
                              style={{
                                width: layout.widths[cell.column.id] ?? cell.column.getSize(),
                                ...(cell.column.columnDef.meta?.pinned && layout.stickyOffsets[cell.column.id] !== undefined
                                  ? {
                                      position: 'sticky',
                                      left: layout.stickyOffsets[cell.column.id],
                                      zIndex: 2,
                                      backgroundColor: 'rgb(var(--surface))', // pinned body cell — matches row surface

                                      ...(cell.column.id === lastPinnedColId
                                        ? { boxShadow: '2px 0 4px rgba(0,0,0,0.08)' }
                                        : {}),
                                    }
                                  : {}),
                              }}
                              className="relative"
                              divider
                            >
                              {/* '__select' is a bare checkbox, never truncatable text — TruncatedCell's
                                  scrollWidth>clientWidth probe false-positives on it and wraps it in a
                                  Radix Tooltip trigger, which intercepts the checkbox's own click. */}
                              {cell.column.id === '__select' ? (
                                flexRender(cell.column.columnDef.cell, cell.getContext())
                              ) : (
                                <TruncatedCell>
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </TruncatedCell>
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                    {paddingBottom > 0 && <tr><td colSpan={effectiveColumns.length} style={{ height: paddingBottom }} /></tr>}
                  </>
                );
              })()
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={onRowClick ? 'cursor-pointer hover:bg-background-light/50' : ''}
                  onClick={() => { if (wasResizing.current) return; onRowClick?.(row.original); }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      data-col-id={cell.column.id}
                      style={{
                        width: layout.widths[cell.column.id] ?? cell.column.getSize(),
                        ...(cell.column.columnDef.meta?.pinned && layout.stickyOffsets[cell.column.id] !== undefined
                          ? {
                              position: 'sticky',
                              left: layout.stickyOffsets[cell.column.id],
                              zIndex: 2,
                              backgroundColor: 'rgb(var(--surface))', // pinned body cell — matches row surface

                              ...(cell.column.id === lastPinnedColId
                                ? { boxShadow: '2px 0 4px rgba(0,0,0,0.08)' }
                                : {}),
                            }
                          : {}),
                      }}
                      className="relative"
                      divider
                    >
                      {/* '__select' is a bare checkbox, never truncatable text — TruncatedCell's
                          scrollWidth>clientWidth probe false-positives on it and wraps it in a
                          Radix Tooltip trigger, which intercepts the checkbox's own click. */}
                      {cell.column.id === '__select' ? (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      ) : (
                        <TruncatedCell>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TruncatedCell>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </table>
      </div>
      )}

      {/* Mobile (< md) — each row becomes a tappable stacked card. Rendered only
          below the md breakpoint (useIsMobile); `md:hidden` stays as a CSS guard.
          Reuses the same column cell renderers and respects column visibility, so
          every list page gets a readable phone layout from this one component. */}
      {isMobile && (
      <div className="space-y-3 md:hidden">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-card border border-border bg-surface-light p-4 shadow-card">
              <div className="h-4 w-1/2 animate-pulse rounded bg-background-light" />
              <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-background-light" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-background-light" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="rounded-card border border-border bg-surface-light p-8 shadow-card">
            <EmptyState title="No results found." />
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className={cn(
                'rounded-card border border-border bg-surface-light p-4 shadow-card',
                onRowClick && 'cursor-pointer active:bg-background-light/50'
              )}
              onClick={() => onRowClick?.(row.original)}
            >
              <dl className="space-y-1.5">
                {/* Desktop-table only — this app has no mobile bulk-select pattern; the
                    '__select' checkbox column never renders in the stacked card layout. */}
                {row.getVisibleCells().filter((cell) => cell.column.id !== '__select').map((cell) => {
                  const label =
                    typeof cell.column.columnDef.header === 'string'
                      ? cell.column.columnDef.header
                      : '';
                  const value = flexRender(cell.column.columnDef.cell, cell.getContext());
                  // Action columns (and any non-text header) render right-aligned
                  // without a label so menus/buttons keep their affordance.
                  if (cell.column.id === 'actions' || !label) {
                    return (
                      <dd key={cell.id} className="flex justify-end pt-1" onClick={(e) => e.stopPropagation()}>
                        {value}
                      </dd>
                    );
                  }
                  return (
                    <div key={cell.id} className="flex items-start justify-between gap-3">
                      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">
                        {label}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words text-right text-sm text-text-primary">
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
      )}

      {/* Pagination */}
      {pagination && (pagination.totalPages > 1 || onPageSizeChange) && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <p className="text-sm text-text-secondary">
              Showing {startItem}–{endItem} of {pagination.total}
            </p>
            {onPageSizeChange && (
              <SelectField
                value={String(pagination.limit)}
                onValueChange={(v) => onPageSizeChange(Number(v))}
                className="h-8 text-sm text-text-secondary"
                options={pageSizeOptions.map((size) => ({ value: String(size), label: `${size} / page` }))}
              />
            )}
          </div>
          {pagination.totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange?.(pagination.page - 1)}
                disabled={pagination.page <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span className="text-sm text-text-secondary">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange?.(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>

    {/* Right-click header context menu */}
    {contextMenu && (
      <HeaderContextMenu
        state={contextMenu}
        onResetThis={(columnId) => {
          table.setColumnSizing((prev) => {
            const next = { ...prev };
            delete next[columnId];
            return next;
          });
          setManuallySizedColumns((prev) => {
            const next = new Set(prev);
            next.delete(columnId);
            return next;
          });
        }}
        onResetAll={() => {
          table.resetColumnSizing();
          setManuallySizedColumns(new Set());
        }}
        onClose={() => setContextMenu(null)}
      />
    )}
    </TooltipProvider>
  );
}
