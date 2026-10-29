"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";

export interface ActiveFilter {
  id: string;
  /** The field - "Status", "Owner". Always shown, so the chip reads as a sentence. */
  label: string;
  value: string;
}

export interface FilterBarProps extends React.ComponentProps<"div"> {
  filters: ActiveFilter[];
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  /** Filter controls - selects, date pickers. */
  children?: React.ReactNode;
  resultCount?: number;
  totalCount?: number;
}

/**
 * Filter controls plus a chip for every active constraint.
 *
 * The chips exist because hidden filters are the most common way a CRM lies to
 * someone: a saved status filter, a stale date range, and the user swears a
 * record has vanished. Every constraint stays visible and individually
 * removable, and each chip names its field - "Status: Overdue", not "Overdue".
 */
function FilterBar({
  className, filters, onRemove, onClearAll, children, resultCount, totalCount, ...props
}: FilterBarProps) {
  const hasFilters = filters.length > 0;

  return (
    <div data-slot="filter-bar" className={cn("flex flex-col gap-2.5", className)} {...props}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((filter) => (
            <span
              key={filter.id}
              className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full py-1 ps-2.5 pe-1 text-[12px] font-medium"
            >
              <span className="text-muted-foreground">{filter.label}:</span>
              <span className="font-semibold">{filter.value}</span>
              <button
                type="button"
                onClick={() => onRemove(filter.id)}
                aria-label={`Remove ${filter.label} filter`}
                className="text-subtle-foreground hover:bg-kit-card hover:text-foreground grid size-4.5 place-items-center rounded-full transition-colors"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}

          {onClearAll && filters.length > 1 && (
            <Button variant="ghost" size="sm" onClick={onClearAll} className="h-7 px-2 text-[12px]">
              Clear all
            </Button>
          )}

          {resultCount != null && totalCount != null && (
            <span className="text-muted-foreground ms-auto text-[12.5px]">
              <span className="text-foreground font-bold">{resultCount}</span> of {totalCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export { FilterBar };
