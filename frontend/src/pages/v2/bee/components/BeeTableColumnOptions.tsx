import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Table as TanstackTable } from '@tanstack/react-table';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';

export interface BeeTableColumnOptionsProps<TData> {
  table: TanstackTable<TData>;
  storageKey: string;
  defaultVisibility: Record<string, boolean>;
  containerRef?: React.RefObject<HTMLElement | null>;
  stickyColId?: string;
}

export function BeeTableColumnOptions<TData>({
  table,
  storageKey,
  defaultVisibility,
  containerRef,
  stickyColId = 'customer_name',
}: BeeTableColumnOptionsProps<TData>) {
  const [isOpen, setIsOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const rafRef = useRef<number | null>(null);

  const hideableColumns = table.getAllLeafColumns().filter((column) => {
    const meta = column.columnDef.meta as { label?: string } | undefined;
    return !!meta?.label && column.getCanHide();
  });

  const checkHiddenColumns = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      // 1. Toggled off columns
      const toggledOffCount = hideableColumns.filter((col) => !col.getIsVisible()).length;

      // 2. Off-screen columns (if container exists and overflows horizontally)
      let offscreenCount = 0;
      const el = containerRef?.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
      if (el) {
        const { scrollLeft, scrollWidth, clientWidth } = el;
        if (scrollWidth > clientWidth) {
          const containerRect = el.getBoundingClientRect();
          const stickyTh = el.querySelector<HTMLTableCellElement>(`thead [data-col-id="${stickyColId}"]`);
          const stickyRight = stickyTh ? stickyTh.getBoundingClientRect().right : containerRect.left;

          const allThs = el.querySelectorAll<HTMLTableCellElement>('thead [data-col-id]');
          allThs.forEach((th) => {
            const colId = th.getAttribute('data-col-id');
            if (colId === stickyColId) return;

            const rect = th.getBoundingClientRect();
            const isOffLeft = rect.right <= stickyRight + 4;
            const isOffRight = rect.left >= containerRect.right - 4;

            if (isOffLeft || isOffRight) {
              offscreenCount++;
            }
          });
        }
      }

      setHiddenCount(toggledOffCount + offscreenCount);
    });
  }, [hideableColumns, containerRef, stickyColId]);

  useEffect(() => {
    checkHiddenColumns();

    const el = containerRef?.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!el) return;

    el.addEventListener('scroll', checkHiddenColumns, { passive: true });
    window.addEventListener('resize', checkHiddenColumns, { passive: true });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      el.removeEventListener('scroll', checkHiddenColumns);
      window.removeEventListener('resize', checkHiddenColumns);
    };
  }, [checkHiddenColumns, containerRef]);

  const handleToggleColumn = (colId: string, isChecked: boolean) => {
    const visibleCount = hideableColumns.filter((c) => c.getIsVisible()).length;
    if (!isChecked && visibleCount <= 1) {
      toast.info('At least one column must remain visible');
      return;
    }

    const column = table.getColumn(colId);
    if (!column) return;

    column.toggleVisibility(isChecked);

    // Save to localStorage
    try {
      const current = table.getState().columnVisibility;
      const next = { ...current, [colId]: isChecked };
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleResetColumns = () => {
    table.setColumnVisibility(defaultVisibility);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    toast.success('Columns reset to default');
  };

  const handleScrollToColumn = (colId: string) => {
    const el = containerRef?.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!el) return;

    const column = table.getColumn(colId);
    if (column && !column.getIsVisible()) {
      handleToggleColumn(colId, true);
    }

    setTimeout(() => {
      const th = el.querySelector<HTMLTableCellElement>(`thead [data-col-id="${colId}"]`);
      if (!th) return;

      const stickyTh = el.querySelector<HTMLTableCellElement>(`thead [data-col-id="${stickyColId}"]`);
      const stickyWidth = stickyTh ? stickyTh.offsetWidth : 0;

      const targetScroll = Math.max(0, th.offsetLeft - stickyWidth - 12);
      el.scrollTo({
        left: targetScroll,
        behavior: 'smooth',
      });
    }, 60);
  };

  const visibleCount = hideableColumns.filter((c) => c.getIsVisible()).length;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 text-xs font-medium text-text-primary border-border bg-surface-light hover:bg-muted/50 cursor-pointer"
          aria-label="Manage table columns"
          aria-expanded={isOpen}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-text-secondary" />
          <span>Columns</span>
          {hiddenCount > 0 && (
            <span className="rounded-full bg-primary/10 text-primary font-semibold px-1.5 py-0.5 text-[10px]">
              +{hiddenCount} hidden
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 max-w-[90vw] max-h-[85vh] overflow-y-auto p-3 bg-surface-light border border-border shadow-xl rounded-xl z-50 text-xs"
      >
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
          <div className="font-semibold text-text-primary text-xs">Table Columns</div>
          <button
            type="button"
            onClick={handleResetColumns}
            className="inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-primary transition-colors cursor-pointer"
            title="Reset to default columns"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        </div>

        <div className="space-y-1" role="group" aria-label="Toggle column visibility">
          {hideableColumns.map((col) => {
            const isVisible = col.getIsVisible();
            const meta = col.columnDef.meta as { label?: string } | undefined;
            const label = meta?.label || col.id;

            return (
              <div
                key={col.id}
                className="flex items-center justify-between gap-2 p-1.5 rounded-lg hover:bg-muted/40 transition-colors group"
              >
                <label
                  htmlFor={`col-opt-${col.id}`}
                  className="flex items-center gap-2 cursor-pointer flex-1 select-none text-text-primary font-medium"
                >
                  <Checkbox
                    id={`col-opt-${col.id}`}
                    checked={isVisible}
                    onCheckedChange={(checked) => handleToggleColumn(col.id, Boolean(checked))}
                    aria-label={`Show ${label} column`}
                  />
                  <span>{label}</span>
                </label>

                {/* Click to scroll into view */}
                <button
                  type="button"
                  onClick={() => handleScrollToColumn(col.id)}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[10px] text-text-secondary hover:text-primary px-1.5 py-0.5 rounded border border-border/60 hover:border-primary/40 transition cursor-pointer"
                  title={`Scroll table to ${label}`}
                  aria-label={`Scroll table to ${label}`}
                >
                  View
                </button>
              </div>
            );
          })}
        </div>

        <div className="pt-2.5 mt-2.5 border-t border-border/60 flex items-center justify-between text-[11px] text-text-secondary">
          <span>{visibleCount} of {hideableColumns.length} visible</span>
          <button
            type="button"
            onClick={handleResetColumns}
            className="text-primary hover:underline font-medium cursor-pointer"
          >
            Reset to default
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

