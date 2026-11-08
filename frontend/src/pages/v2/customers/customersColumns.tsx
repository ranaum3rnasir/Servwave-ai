import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import type { CustomerKind, CustomerSegment, CustomerPhone } from '@/types/entities';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { TagChips, type TagChip } from '@/components/data/TagChips';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { ContactCell } from '../_shared/contactCell';
import { adSourceLabel } from '../_shared/adSource';

export interface Customer {
  id: string;
  customer_number?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string | null;
  extra_emails?: { id: string; email: string; label?: string | null }[];
  phone: string;
  ad_source?: string | null;
  created_at: string;
  service_locations?: { address_line1: string; city: string; state: string; zip: string }[];
  _count: { leads: number; jobs: number };
  kind?: CustomerKind;
  segment?: CustomerSegment;
  parent_id?: string | null;
  bill_to_customer_id?: string | null;
  billing_address_line1?: string | null;
  billing_address_line2?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  billing_terms?: string | null;
  source?: string | null;
  notes?: string | null;
  is_active?: boolean;
  archived_at?: string | null;
  phones?: CustomerPhone[];
  tags?: TagChip[];
}

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 * Same four sortable columns as the legacy list (`customer_number`, `name`,
 * `company`, `created_at`) and the same verbatim `sortBy` values.
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

export function buildCustomerColumns(
  sorting: SortingState,
  onToggleSort: (columnId: string) => void,
  /** Selection is only offered to callers that can act on it - see CustomersPage. */
  selectable: boolean,
): ColumnDef<Customer, unknown>[] {
  const sortable = (columnId: string, title: string) => () =>
    <SortHeader columnId={columnId} title={title} sorting={sorting} onToggleSort={onToggleSort} />;

  // Pinned so it leads the sticky run: pinning honours the LEADING run of
  // pinned columns only, so the checkbox in front of the legacy pair has to be
  // pinned too or the run stops before it starts.
  const selectColumn: ColumnDef<Customer, unknown> = {
    id: 'select',
    size: 40,
    enableHiding: false,
    enableResizing: false,
    meta: { label: 'Select', pinned: true, fixed: true },
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all customers on this page"
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
        aria-label={`Select ${customerDisplayName(row.original)}`}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(value === true)}
        onClick={(e) => e.stopPropagation()}
      />
    ),
  };

  const columns: ColumnDef<Customer, unknown>[] = [
    {
      id: 'customer_number',
      accessorKey: 'customer_number',
      header: sortable('customer_number', 'Customer #'),
      size: 112,
      // `pinned` ported verbatim from the legacy list, which sticks the
      // identity pair (customer_number + name) to the left edge.
      meta: { label: 'Customer #', pinned: true, fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground font-mono text-xs">
          {row.original.customer_number ?? '-'}
        </span>
      ),
    },
    {
      id: 'name',
      // No single Customer field expresses the display name (customerDisplayName
      // falls back to company_name), which is why the sort vocabulary is a map
      // on the backend rather than an accessorKey here.
      accessorFn: (c) => customerDisplayName(c),
      header: sortable('name', 'Customer'),
      size: 200,
      meta: { label: 'Customer', pinned: true },
      cell: ({ row }) => {
        const label = customerDisplayName(row.original);
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar size="sm" name={label} />
            <span className="truncate font-medium">{label}</span>
          </div>
        );
      },
    },
    {
      id: 'phone',
      header: 'Phone',
      // 160, not 140. A formatted US number measures ~99px at this type size and
      // the cell also carries ContactCell's 24px copy control plus its 4px gap,
      // so 140 (108px of content box) is 19px short. The shortfall never showed
      // while the cell could not shrink and quietly overhung its own right
      // padding; now that the value truncates, 140 would ellipsise a phone
      // number that has always fitted on screen.
      size: 160,
      meta: { label: 'Phone', fixed: true },
      cell: ({ row }) => <ContactCell type="phone" value={row.original.phone} />,
    },
    {
      id: 'email',
      header: 'Email',
      size: 185,
      meta: { label: 'Email' },
      cell: ({ row }) => <ContactCell type="email" value={row.original.email} />,
    },
    {
      id: 'address',
      header: 'Address',
      size: 180,
      meta: { label: 'Address' },
      cell: ({ row }) => {
        const loc = row.original.service_locations?.[0];
        if (!loc) return null;
        return (
          <span className="text-muted-foreground block truncate text-sm">
            {loc.city}, {loc.state} {loc.zip}
          </span>
        );
      },
    },
    {
      id: 'company',
      accessorKey: 'company_name',
      header: sortable('company', 'Company'),
      size: 120,
      meta: { label: 'Company', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{row.original.company_name || null}</span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      size: 140,
      meta: { label: 'Source', fixed: true },
      // Where a customer came from is a QUALIFIER, not a state, and the kit's
      // locked rule is "status = solid badge, qualifiers = soft". The legacy
      // list tinted each source its own hue through AD_SOURCE_STYLES; the kit's
      // soft neutral pill is the same decision the v2 leads list already made
      // for this exact field, so the two lists agree. Recorded in the ledger.
      cell: ({ row }) =>
        row.original.ad_source
          ? <Badge variant="softNeutral" size="pill">{adSourceLabel(row.original.ad_source)}</Badge>
          : null,
    },
    {
      id: 'tags',
      header: 'Tags',
      size: 140,
      meta: { label: 'Tags' },
      // `tags` are org-defined rows whose colour is runtime user data (a hex on
      // the Tag record), so the chip cannot be a kit Badge variant - see the
      // shared TagChips component, reused verbatim.
      cell: ({ row }) => <TagChips tags={row.original.tags} />,
    },
    {
      id: 'leads',
      header: 'Leads',
      size: 74,
      meta: { label: 'Leads', fixed: true },
      cell: ({ row }) => <span className="tabular-nums">{row.original._count.leads}</span>,
    },
    {
      id: 'jobs',
      header: 'Jobs',
      size: 74,
      meta: { label: 'Jobs', fixed: true },
      cell: ({ row }) => <span className="tabular-nums">{row.original._count.jobs}</span>,
    },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      header: sortable('created_at', 'Member Since'),
      size: 120,
      meta: { label: 'Member Since', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{formatExactInstant(row.original.created_at)}</span>
      ),
    },
  ];

  return selectable ? [selectColumn, ...columns] : columns;
}
