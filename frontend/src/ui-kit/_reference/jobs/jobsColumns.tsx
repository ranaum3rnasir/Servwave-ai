"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";

import { Avatar, AvatarGroup } from "@/ui-kit/components/ui/avatar";
import { Badge } from "@/ui-kit/components/ui/badge";
import { Button } from "@/ui-kit/components/ui/button";
import { Checkbox } from "@/ui-kit/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";
import { DataTableColumnHeader } from "@/ui-kit/components/data/dataTable/dataTableColumnHeader";
import type { Job, JobStatus } from "./jobsData";

const STATUS_TONE: Record<JobStatus, "green" | "blue" | "amber" | "purple" | "slate"> = {
  Completed: "green",
  Scheduled: "blue",
  "In progress": "amber",
  Unscheduled: "purple",
  Cancelled: "slate",
};

/**
 * Dates render as "18 Jul 2026" rather than 07/18/2026.
 *
 * The source app uses the numeric form, which is ambiguous the moment anyone
 * outside the US reads it - 07/08 is either 7 August or 8 July depending on
 * where the reader learned to read dates. A spelled month costs three
 * characters and removes the ambiguity entirely.
 */
function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export const jobsColumns: ColumnDef<Job>[] = [
  {
    id: "select",
    size: 44,
    meta: { fixed: true },
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label={`Select ${row.original.number}`}
      />
    ),
  },
  {
    accessorKey: "number",
    size: 104,
    minSize: 84,
    meta: { label: "Job #" },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Job #" />,
    cell: ({ row }) => (
      <span className="flex flex-col gap-px">
        <span className="font-semibold">{row.original.number}</span>
        <span className="text-subtle-foreground text-[11.5px]">{row.original.reference}</span>
      </span>
    ),
  },
  {
    accessorKey: "customer",
    size: 236,
    minSize: 140,
    meta: { label: "Customer" },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
    cell: ({ row }) => (
      // Customer and location were separate columns in the source. Pairing them
      // halves the horizontal scroll and keeps the two facts that identify a
      // job - who and where - inside one glance.
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate font-semibold">{row.original.customer}</span>
        <span className="text-subtle-foreground truncate text-[11.5px]">{row.original.location}</span>
      </span>
    ),
  },
  {
    accessorKey: "status",
    size: 132,
    minSize: 112,
    meta: { label: "Status" },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge variant={STATUS_TONE[row.original.status]}>{row.original.status}</Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: "assignees",
    size: 150,
    minSize: 110,
    enableSorting: false,
    meta: { label: "Assigned to" },
    header: () => "Assigned to",
    cell: ({ row }) => {
      const people = row.original.assignees;
      if (people.length === 0) {
        // Italic and muted: unassigned is a state to notice, not a name to read.
        return <span className="text-subtle-foreground text-[12.5px] italic">Unassigned</span>;
      }
      const [only] = people;
      if (people.length === 1 && only) {
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={only} size="xs" />
            <span className="truncate text-[12.5px]">{only}</span>
          </span>
        );
      }
      return <AvatarGroup names={people} max={3} size="xs" />;
    },
  },
  {
    accessorKey: "scheduledAt",
    size: 128,
    minSize: 104,
    meta: { label: "Scheduled" },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Scheduled" />,
    cell: ({ row }) => {
      const value = formatDate(row.original.scheduledAt);
      return value
        ? <span className="whitespace-nowrap">{value}</span>
        : <span className="text-subtle-foreground">-</span>;
    },
  },
  {
    accessorKey: "createdAt",
    size: 128,
    minSize: 104,
    meta: { label: "Created" },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
    cell: ({ row }) => (
      <span className="text-muted-foreground whitespace-nowrap">{formatDate(row.original.createdAt)}</span>
    ),
  },
  {
    id: "actions",
    size: 56,
    meta: { fixed: true },
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
    // Last column: DataTable gives it any leftover width, so its contents stay
    // pinned to the right edge of the row.
    cell: ({ row }) => (
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-subtle-foreground">
              <MoreHorizontal />
              <span className="sr-only">Actions for {row.original.number}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>View job</DropdownMenuItem>
            <DropdownMenuItem>Edit job</DropdownMenuItem>
            <DropdownMenuItem>Assign technician</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Cancel job</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ),
  },
];
