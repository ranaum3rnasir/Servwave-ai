/**
 * ResizableTable — the shared "ServWave Option 1" table for pages that render
 * their own bespoke cells (inventory, communication) and therefore can't use the
 * full TanStack-based <DataTable />.
 *
 * Gives those tables the ALPHA look + behavior:
 *  - white no-fill header + hairline, column dividers, 12px uppercase labels, 6px card.
 *  - Column resize (drag the right edge, double-click to reset) + flex-fill via
 *    `computeLayout` from table-flex.ts → no trailing whitespace; overflow scrolls.
 *
 * Columns are a model ({ id, header, cell, ... }); the `cell` render fn keeps each
 * page's custom content, row-click, inline buttons, badges, etc. intact.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeLayout, type ColumnDef } from './table-flex';

export interface ResizableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Default width (px). */
  width?: number;
  /** Resize floor (px) — header/content stays readable. */
  min?: number;
  /** Flex-fill weight; 0 = fixed (icon/action columns). */
  grow?: number;
  align?: 'left' | 'right' | 'center';
  headerClassName?: string;
  cellClassName?: string;
  /**
   * Opt-in built-in sorting. When provided, the header becomes a click-to-sort
   * toggle with a chevron and the table sorts `rows` by this value. Leave unset
   * for non-sortable columns (or when the host owns sorting, e.g. CallsTable).
   */
  sortValue?: (row: T) => string | number | null | undefined;
  /**
   * Optional totals/footer cell. If ANY column defines `footer`, the table
   * renders a sticky-styled `<tfoot>` totals row that respects column widths.
   */
  footer?: ReactNode;
}

export interface ResizableTableProps<T> {
  columns: ResizableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  /** Shown (spanning all columns) when `rows` is empty. */
  empty?: ReactNode;
  /** Sticky header for full-height scroll tables (e.g. the inventory grid). */
  stickyHeader?: boolean;
  /** Nested inside another card/section that already provides the frame. */
  flat?: boolean;
  className?: string;
}

const DEFAULTS = { width: 160, min: 80, grow: 1 };

function toColumnDef<T>(c: ResizableColumn<T>): ColumnDef {
  const grow = c.grow ?? DEFAULTS.grow;
  return {
    id: c.id,
    width: c.width ?? DEFAULTS.width,
    minWidth: c.min ?? DEFAULTS.min,
    growWeight: grow,
    visible: true,
    manuallySized: false,
    fixed: grow === 0,
  };
}

function alignClass(a?: 'left' | 'right' | 'center') {
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
}

export function ResizableTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  rowClassName,
  empty,
  stickyHeader,
  flat,
  className,
}: ResizableTableProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [cols, setCols] = useState<ColumnDef[]>(() => columns.map(toColumnDef));
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null);

  // `meta` carries the live render fns (fresh closures each render).
  const meta = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  const hasFooter = columns.some((c) => c.footer !== undefined);

  function toggleSort(id: string) {
    setSort((prev) =>
      prev?.id === id ? { id, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'asc' },
    );
  }

  // Built-in sort (only when the active column declares `sortValue`).
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = meta.get(sort.id);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, meta]);

  // Re-sync width state if the column set changes, preserving user widths by id.
  const colIds = columns.map((c) => c.id).join('|');
  useEffect(() => {
    setCols((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      return columns.map((c) => byId.get(c.id) ?? toColumnDef(c));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colIds]);

  // Measure the container so computeLayout can fill it (no trailing whitespace).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Floor each column to fit its (string) header label so headers never clip by
  // default — same rule as the TanStack <DataTable />. A manual resize opts out.
  const headerFloor = (col: ColumnDef): number => {
    if (col.manuallySized) return 0;
    const m = meta.get(col.id);
    if (typeof m?.header !== 'string') return 0;
    const CHAR_PX = 8; // 12px semibold uppercase tracking-wide
    const PADDING = 32; // px-4 each side
    const SORT_ICON = m?.sortValue ? 20 : 0;
    return Math.ceil(m.header.length * CHAR_PX + PADDING + SORT_ICON + 6);
  };
  const layoutCols = cols.map((c) => {
    const floor = headerFloor(c);
    return floor > 0 ? { ...c, width: Math.max(c.width, floor), minWidth: Math.max(c.minWidth, floor) } : c;
  });

  const totalBase = layoutCols.reduce((s, c) => s + c.width, 0);
  const { widths } = computeLayout({ containerWidth: containerWidth || totalBase, columns: layoutCols });
  const total = layoutCols.reduce((s, c) => s + (widths[c.id] ?? c.width), 0);

  const startResize = (e: React.MouseEvent, col: ColumnDef) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col.id] ?? col.width;
    setResizingId(col.id);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(col.minWidth, startW + ev.clientX - startX);
      setCols((cs) => cs.map((c) => (c.id === col.id ? { ...c, width: next, manuallySized: true } : c)));
    };
    const onUp = () => {
      setResizingId(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resetCol = (id: string) => {
    const def = meta.get(id)?.width ?? DEFAULTS.width;
    setCols((cs) => cs.map((c) => (c.id === id ? { ...c, width: def, manuallySized: false } : c)));
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-x-auto rounded-card border border-border bg-surface-light shadow-card',
        flat && 'rounded-none border-0 shadow-none',
        stickyHeader && 'overflow-y-auto',
        resizingId && 'cursor-col-resize select-none',
        className
      )}
    >
      <table className="text-sm" style={{ width: total, tableLayout: 'fixed' }}>
        <thead className={cn(stickyHeader && 'sticky top-0 z-10')}>
          <tr className="border-b-2 border-border bg-table-header">
            {cols.map((c) => {
              const m = meta.get(c.id);
              const sortable = !!m?.sortValue;
              const active = sort?.id === c.id;
              return (
                <th
                  key={c.id}
                  style={{ width: widths[c.id] }}
                  onClick={sortable ? () => toggleSort(c.id) : undefined}
                  className={cn(
                    'relative border-r border-r-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary last:border-r-0',
                    alignClass(m?.align),
                    sortable && 'group/th cursor-pointer select-none',
                    m?.headerClassName
                  )}
                >
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-1',
                      m?.align === 'right' && 'justify-end',
                      m?.align === 'center' && 'justify-center',
                    )}
                  >
                    <span className="truncate">{m?.header}</span>
                    {sortable &&
                      (active ? (
                        sort!.dir === 'asc' ? (
                          <ArrowUp className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5 shrink-0 text-primary" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover/th:opacity-40" />
                      ))}
                  </span>
                  <div
                    onMouseDown={(e) => startResize(e, c)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      resetCol(c.id);
                    }}
                    role="separator"
                    aria-orientation="vertical"
                    className={cn(
                      'absolute -right-1 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none select-none justify-center',
                      'after:absolute after:top-0 after:h-full after:transition-colors after:content-[""]',
                      resizingId === c.id
                        ? 'after:w-0.5 after:bg-primary'
                        : 'after:w-px after:bg-transparent hover:after:w-0.5 hover:after:bg-primary/50'
                    )}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty != null && (
            <tr>
              <td colSpan={cols.length} className="px-4 py-12 text-center text-sm text-text-secondary">
                {empty}
              </td>
            </tr>
          )}
          {sortedRows.map((row) => (
            <tr
              key={getRowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'group border-b border-border transition-colors last:border-0',
                onRowClick && 'cursor-pointer hover:bg-background-light/60',
                rowClassName?.(row)
              )}
            >
              {cols.map((c) => {
                const m = meta.get(c.id);
                return (
                  <td
                    key={c.id}
                    style={{ width: widths[c.id] }}
                    className={cn(
                      'overflow-hidden border-r border-r-border px-4 py-3 align-middle last:border-r-0',
                      alignClass(m?.align),
                      m?.cellClassName
                    )}
                  >
                    {m?.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {hasFooter && rows.length > 0 && (
          <tfoot className={cn(stickyHeader && 'sticky bottom-0 z-10')}>
            <tr className="border-t-2 border-border bg-table-header font-semibold text-text-primary">
              {cols.map((c) => {
                const m = meta.get(c.id);
                return (
                  <td
                    key={c.id}
                    style={{ width: widths[c.id] }}
                    className={cn(
                      'overflow-hidden border-r border-r-border px-4 py-3 align-middle last:border-r-0',
                      alignClass(m?.align),
                      m?.cellClassName
                    )}
                  >
                    {m?.footer}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
