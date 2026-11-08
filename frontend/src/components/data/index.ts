/* =============================================================================
   ServWave Data — barrel.
   Data-display components: tables and the metric/status widgets that annotate
   rows and dashboards. Split out of `components/ui`, which is primitives only.

   Three table implementations coexist deliberately:
     - `table`          raw shadcn markup primitives (Table/TableRow/TableCell)
     - `DataTable`      TanStack-backed, for standard sortable/filterable lists
     - `ResizableTable` for pages with bespoke cell rendering + column resizing
   Pick the lowest-powered one that does the job.
   ============================================================================= */

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from './table';

export { DataTable, estimateHeaderWidth } from './data-table';

export { ResizableTable } from './ResizableTable';
export type { ResizableTableProps, ResizableColumn } from './ResizableTable';

export { computeLayout } from './table-flex';
export type { ColumnDef, LayoutInput, LayoutResult } from './table-flex';

export { KpiStrip, KpiTile } from './KpiStrip';
export type { KpiStripProps, KpiTileProps, KpiTone } from './KpiStrip';

export { TrendDelta } from './TrendDelta';
export type { TrendDeltaProps } from './TrendDelta';

export { StatusBadge } from './status-badge';

export { ContactCell } from './ContactCell';

export { FilterChip } from './filter-chip';
