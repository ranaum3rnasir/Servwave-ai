"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";

export interface BulkActionBarProps extends React.ComponentProps<"div"> {
  count: number;
  onClear: () => void;
  /** Singular/plural noun, e.g. ["job", "jobs"]. */
  noun?: [string, string];
  children?: React.ReactNode;
}

/**
 * Appears when rows are selected, disappears when they aren't.
 *
 * Rendered inline above the table rather than as a floating overlay: a bar that
 * hovers over content covers the very rows the user is deciding about. It
 * announces politely so the count reaches a screen reader without stealing
 * focus mid-selection.
 */
function BulkActionBar({
  className, count, onClear, noun = ["item", "items"], children, ...props
}: BulkActionBarProps) {
  if (count === 0) return null;

  return (
    <div
      data-slot="bulk-action-bar"
      role="status"
      aria-live="polite"
      className={cn(
        "bg-brand-subtle flex flex-wrap items-center gap-2.5 border-b px-4 py-2.5",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200",
        className,
      )}
      {...props}
    >
      <span className="text-brand-emphasis text-[12.5px] font-bold">
        {count} {count === 1 ? noun[0] : noun[1]} selected
      </span>
      <div className="ms-auto flex flex-wrap items-center gap-1.5">
        {children}
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear<X />
        </Button>
      </div>
    </div>
  );
}

export { BulkActionBar };
