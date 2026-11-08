"use client";

import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import { SearchInput } from "@/ui-kit/components/form/searchInput";
import { DataTableViewOptions } from "./dataTableViewOptions";

export interface DataTableToolbarProps<TData> extends React.ComponentProps<"div"> {
  table: Table<TData>;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter controls - status pickers, date ranges. */
  filters?: React.ReactNode;
  /** Right-hand actions - export, refresh. */
  actions?: React.ReactNode;
}

function DataTableToolbar<TData>({
  table, searchValue, onSearchChange,
  searchPlaceholder = "Search…",
  filters, actions, className, ...props
}: DataTableToolbarProps<TData>) {
  const filtered = table.getState().columnFilters.length > 0 || searchValue.length > 0;

  return (
    <div
      data-slot="data-table-toolbar"
      className={cn("flex flex-wrap items-center gap-2 border-b px-4 py-3", className)}
      {...props}
    >
      <div className="min-w-[12rem] flex-1">
        <SearchInput value={searchValue} onValueChange={onSearchChange} placeholder={searchPlaceholder} />
      </div>
      {filters}
      {filtered && (
        // Only appears once something is filtered - a permanent Reset button
        // implies a state the user isn't in.
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { table.resetColumnFilters(); onSearchChange(""); }}
        >
          Reset<X />
        </Button>
      )}
      <div className="ms-auto flex items-center gap-2">
        {actions}
        <DataTableViewOptions table={table} />
      </div>
    </div>
  );
}

export { DataTableToolbar };
