"use client";

import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { Columns3 } from "lucide-react";

import { Button } from "@/ui-kit/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";

/**
 * Column visibility toggle.
 *
 * Reads `meta.label` for the human name - falling back to the accessor key
 * shows people "scheduledAt" when they were looking for "Scheduled".
 *
 * WHAT DECIDES THE LIST: a column is offered here if it can be hidden and it
 * has a `meta.label`. It used to be `accessorFn !== undefined && getCanHide()`,
 * the stock shadcn test, and the accessor half of that was silently wrong for
 * this app: a DISPLAY column - one that renders from the row rather than
 * reading a field, like Jobs' Tags - carries no accessor, so it never appeared
 * in the menu and there was no way to turn it off. The header was on the table
 * and absent from the list of headers, which reads as a bug in the menu.
 *
 * `meta.label` is the gate instead of the accessor because it is exactly the
 * set of columns that have a NAME to show. It leaves out the structural
 * columns - the select checkbox, the trailing actions column - which have no
 * header text to offer and are marked `enableHiding: false` anyway.
 */
function DataTableViewOptions<TData>({ table }: { table: Table<TData> }) {
  const columns = table
    .getAllColumns()
    .filter((column) => {
      const label = (column.columnDef.meta as { label?: string } | undefined)?.label;
      return !!label && column.getCanHide();
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 />
          <span className="hidden sm:inline">Columns</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(!!value)}
            onSelect={(e) => e.preventDefault()}
          >
            {(column.columnDef.meta as { label?: string } | undefined)?.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { DataTableViewOptions };
