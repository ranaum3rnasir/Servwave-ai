/**
 * SRVW-89 - every sortable column on every list has a backend sort-field-map entry, and the
 * map itself is proved reachable from the frontend build (a cross-workspace relative import,
 * unprecedented in this repo before this card).
 *
 * "Sortable" reproduces TanStack v8's real getCanSort() gate rather than filtering on
 * enableSorting alone: `(enableSorting ?? true) && !!accessorFn` where accessorFn is only
 * synthesised when the ColumnDef carries `accessorKey` or `accessorFn`. Filtering on
 * enableSorting alone would pass green on Customers today while every header stayed
 * unclickable (all ten columns were display columns with no accessor) - the exact false-green
 * this test exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CUSTOMER_SORT_FIELDS,
  JOB_SORT_FIELDS,
  ESTIMATE_SORT_FIELDS,
  LEAD_SORT_FIELDS,
  INVOICE_SORT_FIELDS,
  type SortFieldMap,
} from '../../../backend/src/lib/sortFields';
import { columns as customerColumns } from '../pages/CustomersPage';
import { columns as jobColumns } from '../pages/JobsPage';
import { columns as estimateColumns } from '../pages/EstimatesPage';
import { columns as leadColumns } from '../pages/LeadsPage';
import { columns as invoiceColumns } from '../pages/InvoicesPage';

function hasAccessor(col: ColumnDef<unknown, unknown>): boolean {
  return 'accessorKey' in col || 'accessorFn' in col;
}

function sortableIds(columns: ColumnDef<unknown, unknown>[]): string[] {
  return columns
    .filter((c) => c.enableSorting !== false && hasAccessor(c))
    .map((c) => (c as { id?: string; accessorKey?: string }).id ?? (c as { accessorKey?: string }).accessorKey!);
}

const LISTS: { name: string; columns: ColumnDef<unknown, unknown>[]; map: SortFieldMap }[] = [
  { name: 'Customers', columns: customerColumns as ColumnDef<unknown, unknown>[], map: CUSTOMER_SORT_FIELDS },
  { name: 'Jobs', columns: jobColumns as ColumnDef<unknown, unknown>[], map: JOB_SORT_FIELDS },
  { name: 'Estimates', columns: estimateColumns as ColumnDef<unknown, unknown>[], map: ESTIMATE_SORT_FIELDS },
  { name: 'Leads', columns: leadColumns as ColumnDef<unknown, unknown>[], map: LEAD_SORT_FIELDS },
  { name: 'Invoices', columns: invoiceColumns as ColumnDef<unknown, unknown>[], map: INVOICE_SORT_FIELDS },
];

describe('every sortable column on every list has a SORT_FIELD_MAPS entry', () => {
  for (const { name, columns, map } of LISTS) {
    it(`${name} has at least one sortable column`, () => {
      expect(sortableIds(columns).length).toBeGreaterThan(0);
    });

    it(`${name}: every sortable column id resolves in its backend map`, () => {
      const unmapped = sortableIds(columns).filter((id) => !(id in map));
      expect(unmapped).toEqual([]);
    });
  }
});
