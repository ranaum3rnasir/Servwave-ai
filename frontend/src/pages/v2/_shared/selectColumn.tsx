import type { ColumnDef } from '@tanstack/react-table';

import { Checkbox } from '@/ui-kit/components/ui/checkbox';

/**
 * The row-selection checkbox column, as the four bulk-capable v2 lists declare
 * it (`jobsColumns.tsx`, `customersColumns.tsx`, `estimatesColumns.tsx`,
 * `invoicesColumns.tsx`).
 *
 * Those four each carry their own verbatim copy - written when the module
 * branches were forbidden from editing a shared file. This is the same column,
 * factored, for the lists that gained a selection afterwards: inventory stock,
 * the price book, the three purchase-order grids and vendor spend. Leads had one
 * too until its only bulk action, Export selected, was dropped as a second route
 * to the toolbar Export. Everything that varied between the four copies is a
 * prop, so nothing here decides anything per caller.
 *
 * PINNED, deliberately. Column pinning honours the LEADING run of pinned
 * columns only, so a checkbox placed in front of an already-pinned identity
 * column has to be pinned too or the run stops before it starts.
 *
 * A selection is only useful against ONE query scope, which is the caller's
 * job: hold it in `useScopedRowSelection` and hand it to the DataTable as
 * `rowSelection`/`onRowSelectionChange`.
 */
export function buildSelectColumn<TData>({
  allLabel, rowLabel,
}: {
  /** aria-label for the header checkbox, e.g. "Select all leads on this page". */
  allLabel: string;
  /** aria-label for a row's checkbox, e.g. `Select ${row.lead_number}`. */
  rowLabel: (row: TData) => string;
}): ColumnDef<TData, unknown> {
  return {
    id: 'select',
    size: 40,
    enableHiding: false,
    enableResizing: false,
    meta: { label: 'Select', pinned: true, fixed: true },
    header: ({ table }) => (
      <Checkbox
        aria-label={allLabel}
        checked={
          table.getIsAllPageRowsSelected()
            ? true
            : table.getIsSomePageRowsSelected() ? 'indeterminate' : false
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={rowLabel(row.original)}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(value === true)}
        onClick={(e) => e.stopPropagation()}
      />
    ),
  };
}
