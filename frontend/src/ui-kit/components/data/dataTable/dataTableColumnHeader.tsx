"use client";

import * as React from "react";
import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";

export interface DataTableColumnHeaderProps<TData, TValue>
  extends React.ComponentProps<"div"> {
  column: Column<TData, TValue>;
  title: string;
  align?: "left" | "right";
}

/**
 * Sortable header cell.
 *
 * The arrow shows the *current* direction rather than what clicking would do -
 * the opposite convention exists, and it's a coin flip users lose. Showing
 * state is unambiguous.
 */
function DataTableColumnHeader<TData, TValue>({
  column, title, align = "left", className, ...props
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort() && !column.getCanHide()) {
    return <div title={title} className={cn(align === "right" && "text-right", className)} {...props}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  return (
    <div title={title} className={cn("flex min-w-0 items-center", align === "right" && "justify-end", className)} {...props}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            title={title}
            // `min-w-0` down the chain, and the TITLE is what truncates - not
            // the header cell. Ellipsising the cell instead put the "..." after
            // the sort arrow, which reads as a third control rather than as a
            // clipped word. The arrow is the one part that must stay legible:
            // it is the only thing saying which way the table is sorted.
            className="data-[state=open]:bg-muted -ms-2 h-7 min-w-0 gap-1.5 px-2 text-[11.5px] font-semibold"
          >
            <span className="truncate" title={title}>{title}</span>
            {sorted === "desc" ? <ArrowDown className="text-brand size-3.5" />
              : sorted === "asc" ? <ArrowUp className="text-brand size-3.5" />
              : <ChevronsUpDown className="size-3.5 opacity-45" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align === "right" ? "end" : "start"} className="min-w-[9rem]">
          <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
            <ArrowUp />Ascending
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
            <ArrowDown />Descending
          </DropdownMenuItem>
          {column.getCanHide() && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
                <EyeOff />Hide column
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export { DataTableColumnHeader };
