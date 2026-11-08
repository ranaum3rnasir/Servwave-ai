import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { TagChips, type TagChip } from '@/components/data/TagChips';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { StatusChip } from './components/statusChip';

interface EstimateCustomer {
  id: string;
  first_name: string;
  last_name: string;
  company_name?: string | null;
  customer_number?: string | null;
}

export interface Deposit {
  id: string;
  status: string;
  amount: number;
  payment_method: string | null;
}

export interface Estimate {
  id: string;
  estimate_number: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  // SERV10X-61 - a customer-anchored estimate has NO lead, so `lead` is nullable and the
  // customer resolves from the direct `customer` instead. Both are returned by
  // estimateListSelect. Carried over verbatim from the legacy page's own interface, including
  // the nullability that lets tsc catch an unguarded `e.lead.customer`.
  lead: { id: string; customer: EstimateCustomer } | null;
  customer: EstimateCustomer | null;
  creator: { id: string; first_name: string; last_name: string };
  deposit?: Deposit | null;
  tags?: TagChip[];
}

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 *
 * The four sortable ids are the legacy page's four verbatim: a column the
 * legacy list left sortable stays sortable, and one it turned off
 * (`customer`, `deposit`, `created_by`, `tags`) stays off. SRVW-89 turns an
 * unknown sort id into a 400, so this set is not a styling choice.
 */
function SortHeader({
  columnId, title, sorting, onToggleSort,
}: {
  columnId: string;
  title: string;
  sorting: SortingState;
  onToggleSort: (columnId: string) => void;
}) {
  const active = sorting[0]?.id === columnId ? sorting[0] : undefined;
  return (
    <Button
      variant="ghost"
      size="sm"
      // Matches TableHead's own type scale - Button's `size="sm"` ships
      // `text-[13px]`, which would otherwise make sortable titles bigger and
      // lighter than the plain headers beside them.
      className="-ms-2 h-7 gap-1.5 px-2 text-[11.5px] font-semibold"
      onClick={() => onToggleSort(columnId)}
    >
      <span>{title}</span>
      {active
        ? (active.desc ? <ArrowDown /> : <ArrowUp />)
        : <ChevronsUpDown />}
    </Button>
  );
}

export interface BuildEstimateColumnsOptions {
  sorting: SortingState;
  onToggleSort: (columnId: string) => void;
}

export function buildEstimateColumns({
  sorting, onToggleSort,
}: BuildEstimateColumnsOptions): ColumnDef<Estimate, unknown>[] {
  const sortable = (columnId: string, title: string) => () =>
    <SortHeader columnId={columnId} title={title} sorting={sorting} onToggleSort={onToggleSort} />;

  return [
    // Selection goes through the table. The page still OWNS the state - it is
    // `useScopedRowSelection`, handed in as `rowSelection` and back out as
    // `onRowSelectionChange` - so the legacy list's "a selected id only means
    // anything against the page/sort/filter it was picked under" rule is
    // unforked, and the checkboxes read the one state the table also renders
    // the row highlight and the footer readout from.
    {
      id: 'select',
      size: 44,
      enableHiding: false,
      enableResizing: false,
      // Pinned so it leads the sticky run: pinning honours the LEADING run of
      // pinned columns only, so the checkbox in front of the legacy pair has to
      // be pinned too or the run stops before it starts.
      meta: { label: 'Select', pinned: true, fixed: true },
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected() ? 'indeterminate' : false
          }
          onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked === true)}
          aria-label="Select all estimates on this page"
        />
      ),
      cell: ({ row }) => (
        // The row itself navigates, so the checkbox has to stop the click from
        // reaching it or ticking a box would leave the list.
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(checked === true)}
            aria-label={`Select estimate ${row.original.estimate_number}`}
          />
        </span>
      ),
    },
    {
      id: 'estimate_number',
      accessorKey: 'estimate_number',
      header: sortable('estimate_number', 'Estimate #'),
      size: 110,
      // `pinned` ported verbatim from the legacy list, which sticks the
      // identity pair (estimate_number + customer) to the left edge.
      meta: { label: 'Estimate #', pinned: true, fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground font-mono text-xs">{row.original.estimate_number}</span>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      size: 200,
      meta: { label: 'Customer', pinned: true },
      cell: ({ row }) => {
        // Lead-anchored rows resolve through the lead; a customer-anchored one has no lead
        // and resolves from the direct customer. Without the fallback every lead-less
        // estimate showed a dash here even though the API returns its customer.
        const c = row.original.lead?.customer ?? row.original.customer;
        if (!c) return <span className="text-muted-foreground">{'-'}</span>;
        return (
          <div className="min-w-0">
            <span className="block truncate font-medium">{customerDisplayName(c)}</span>
            {c.customer_number && (
              <span className="text-muted-foreground font-mono text-xs">{c.customer_number}</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: sortable('status', 'Status'),
      size: 150,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="estimate" status={row.original.status} />,
    },
    {
      id: 'deposit',
      accessorKey: 'deposit',
      header: 'Deposit',
      size: 110,
      meta: { label: 'Deposit', fixed: true },
      cell: ({ row }) => {
        const deposit = row.original.deposit;
        if (!deposit) return null;
        return <StatusChip domain="deposit" status={deposit.status} />;
      },
    },
    {
      id: 'total',
      accessorKey: 'total_amount',
      header: sortable('total', 'Total'),
      size: 110,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => (
        <span className="font-medium tabular-nums">{formatCurrency(Number(row.original.total_amount))}</span>
      ),
    },
    {
      id: 'created_by',
      accessorKey: 'creator',
      header: 'Created By',
      size: 160,
      meta: { label: 'Created By' },
      cell: ({ row }) => (
        <span className="truncate">{row.original.creator.first_name} {row.original.creator.last_name}</span>
      ),
    },
    {
      // The kit ships no colour-driven chip, and `tag.color` is runtime user
      // data rather than a token, so the legacy TagChips renderer is reused
      // as-is (ledger row). Only the column shell is redeclared, to carry the
      // kit's `meta.label` for the column-visibility menu.
      id: 'tags',
      header: 'Tags',
      size: 140,
      meta: { label: 'Tags' },
      cell: ({ row }) => <TagChips tags={row.original.tags} />,
    },
    {
      id: 'date',
      accessorKey: 'created_at',
      header: sortable('date', 'Date'),
      size: 110,
      meta: { label: 'Date', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm tabular-nums">{formatExactInstant(row.original.created_at)}</span>
      ),
    },
  ];
}
