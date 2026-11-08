import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Link } from 'react-router-dom';

import { customerDisplayName } from '@/lib/customer-name';
import { isTerminalLeadStatus } from '@/lib/filters/registries/leads';
import { formatExactInstant } from '@/lib/format-date';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';

import { adSourceLabel } from '../_shared/adSource';
import { ContactCell } from '../_shared/contactCell';
import { StatusChip } from '../_shared/statusChip';
import { preferV2Path } from '../uiV2';
import { formatDate } from './components/leadShared';

export interface Lead {
  id: string;
  lead_number: string;
  status: string;
  service_request: string;
  job_type?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  walkthrough_scheduled_at?: string | null;
  walkthrough_completed_at?: string | null;
  contacted_at?: string | null;
  service_location_id?: string | null;
  created_at: string;
  customer: {
    id: string; first_name: string; last_name: string; company_name?: string | null;
    phone: string; customer_number?: string | null; ad_source?: string | null;
    service_locations?: { city: string; state: string }[];
  };
  commission_owner?: { id: string; first_name: string; last_name: string } | null;
  lead_assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  estimates?: { id: string; total_amount: number }[];
}

/**
 * Walkthrough chip, ported verbatim from LeadsPage including the NEW-status
 * exception the survivors table records: it is a walkthrough-progress
 * indicator derived from two timestamps plus one status value, not a status
 * badge, so it does not resolve through the status registry.
 *
 * The scheduled date is an ORG fact (#1634) - when the crew is going to the
 * site, not when the viewer happens to be looking - so it renders through
 * `formatDate`/`tz` like every other scheduling date on the lead surfaces,
 * not the browser's own clock.
 */
export function getWalkthroughDisplay(lead: Lead, tz: string): { text: string; className: string } {
  if (lead.walkthrough_completed_at) return { text: '✓ Done', className: 'text-status-green-emphasis font-medium' };
  if (lead.walkthrough_scheduled_at) return { text: formatDate(lead.walkthrough_scheduled_at, tz), className: 'text-brand' };
  // A closed lead needs no scheduling (slice 05): since the list stopped reporting a cancelled
  // trip as the walkthrough date, a lead marked lost arrives here with none, and must not read
  // as work to book.
  if (lead.status === 'NEW' || isTerminalLeadStatus(lead.status)) return { text: '-', className: 'text-muted-foreground' };
  return { text: 'Needs Sched.', className: 'text-status-amber-emphasis font-medium' };
}

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 * Same three sortable columns as the legacy list (`lead_number`, `status`,
 * `created`), same verbatim `sortBy` values - including the two the backend
 * allow-list does not recognise (see the branch report).
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

export function buildLeadColumns(
  sorting: SortingState,
  onToggleSort: (columnId: string) => void,
  tz: string,
): ColumnDef<Lead, unknown>[] {
  const sortable = (columnId: string, title: string) => () =>
    <SortHeader columnId={columnId} title={title} sorting={sorting} onToggleSort={onToggleSort} />;

  // NO SELECTION COLUMN. It existed for one bulk action, Export selected, and
  // the toolbar's own Export already writes the same file from the same
  // mapping - the picked rows were the only difference - so the checkbox column
  // was a second route to a control the page already has.
  const columns: ColumnDef<Lead, unknown>[] = [
    // NO MORE SORTABLE COLUMNS. Three of these are sortable and three is the
    // ceiling: sorting here is SERVER-side, the column id goes out as `sortBy`,
    // and the backend maps exactly `lead_number`, `status` and `created`
    // (`LEAD_SORT_FIELDS` in backend/src/lib/sortFields.ts). Anything else 400s
    // before a query runs, so declaring Phone or Assignee sortable would trade a
    // dead header for a broken one. Widening it is a backend change - a map
    // entry per column, plus relation ordering for Customer and Assignee - not
    // a column-set change, and switching this list to client sorting would
    // reorder one page of many.
    {
      id: 'lead_number',
      accessorKey: 'lead_number',
      header: sortable('lead_number', 'Lead #'),
      size: 90,
      // `pinned` ported verbatim from the legacy list, which sticks the
      // identity pair (lead_number + customer) to the left edge. No checkbox
      // column here, so the leading run starts with this one.
      meta: { label: 'Lead #', pinned: true, fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground font-mono text-xs">{row.original.lead_number}</span>
      ),
    },
    {
      id: 'customer',
      accessorKey: 'customer',
      header: 'Customer',
      size: 170,
      meta: { label: 'Customer', pinned: true },
      cell: ({ row }) => {
        const c = row.original.customer;
        return (
          <div className="min-w-0">
            {c?.id ? (
              <Link
                to={preferV2Path(`/customers/${c.id}`)}
                onClick={(e) => e.stopPropagation()}
                className="text-brand block truncate font-medium hover:underline"
              >
                {customerDisplayName(c)}
              </Link>
            ) : (
              <span className="block truncate font-medium">{customerDisplayName(c)}</span>
            )}
            {c?.customer_number && (
              <span className="text-muted-foreground font-mono text-xs">{c.customer_number}</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'phone',
      accessorKey: 'phone',
      header: 'Phone',
      // 160 for the same reason as the customers list - a formatted number plus
      // ContactCell's copy control needs ~127px of content box and 140 gives
      // 108. See customersColumns.tsx.
      size: 160,
      meta: { label: 'Phone', fixed: true },
      cell: ({ row }) => <ContactCell type="phone" value={row.original.customer.phone} />,
    },
    {
      id: 'source',
      accessorKey: 'job_source',
      header: 'Source',
      size: 120,
      meta: { label: 'Source', fixed: true },
      // Where the lead came from is a QUALIFIER, not a state, and the kit's
      // locked rule is "status = solid badge, qualifiers = soft". A bordered
      // outline box put a second hard-edged chip two columns from the solid
      // status badge and the two competed for the same read; the soft neutral
      // pill is the mockup's own `.badge-soft` - muted fill, muted ink, no
      // border, fully round - which is how it treats secondary row metadata.
      cell: ({ row }) =>
        row.original.customer.ad_source
          ? (
            <Badge variant="softNeutral" size="pill">
              {adSourceLabel(row.original.customer.ad_source)}
            </Badge>
          )
          : <span className="text-muted-foreground">{'-'}</span>,
    },
    {
      id: 'service_request',
      accessorKey: 'service_request',
      header: 'Service Request',
      size: 200,
      meta: { label: 'Service Request' },
      cell: ({ row }) => (
        <span className="text-muted-foreground block truncate" title={row.original.service_request}>
          {row.original.service_request}
        </span>
      ),
    },
    {
      id: 'location',
      accessorKey: 'service_city',
      header: 'Location',
      size: 140,
      meta: { label: 'Location' },
      cell: ({ row }) => {
        const { service_city, service_state, customer } = row.original;
        const city = service_city || customer.service_locations?.[0]?.city;
        const state = service_state || customer.service_locations?.[0]?.state;
        if (!city && !state) return <span className="text-muted-foreground">{'-'}</span>;
        return <span className="text-muted-foreground text-sm">{[city, state].filter(Boolean).join(', ')}</span>;
      },
    },
    {
      id: 'type',
      accessorKey: 'job_type',
      header: 'Type',
      size: 100,
      meta: { label: 'Type', fixed: true },
      // job_type is unbounded org free text, and Badge's inline-flex box floors
      // its width at whitespace-nowrap's full-string minimum, so it overflows
      // into the Status cell next to it. max-w-full caps the badge at the
      // column; the inner span is what actually shrinks, since "truncate"
      // brings overflow-hidden, which is what zeroes a flex item's automatic
      // minimum size and lets it go below its content width.
      cell: ({ row }) =>
        row.original.job_type
          ? (
            <Badge variant="outline" size="sm" className="max-w-full" title={row.original.job_type}>
              <span className="truncate">{row.original.job_type}</span>
            </Badge>
          )
          : <span className="text-muted-foreground">{'-'}</span>,
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: sortable('status', 'Status'),
      // Sized for the longest chip, 'Walkthrough Completed' (about 139 px, nowrap) plus the cell's
      // 32 px of padding. At 110 it painted over the Service Request column.
      size: 176,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="lead" status={row.original.status} />,
    },
    {
      id: 'estimates',
      accessorKey: 'estimates',
      header: 'Est.',
      size: 64,
      meta: { label: 'Est.', fixed: true },
      cell: ({ row }) => {
        const estimates = row.original.estimates ?? [];
        return (
          <span className={estimates.length === 0 ? 'text-muted-foreground tabular-nums' : 'font-medium tabular-nums'}>
            {estimates.length}
          </span>
        );
      },
    },
    {
      id: 'assignee',
      accessorKey: 'commission_owner',
      header: 'Assignee',
      size: 120,
      meta: { label: 'Assignee', fixed: true },
      cell: ({ row }) =>
        row.original.commission_owner
          ? <span>{row.original.commission_owner.first_name} {row.original.commission_owner.last_name}</span>
          : <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      id: 'walkthrough',
      accessorKey: 'walkthrough_scheduled_at',
      header: 'Walkthrough',
      size: 120,
      meta: { label: 'Walkthrough', fixed: true },
      cell: ({ row }) => {
        const display = getWalkthroughDisplay(row.original, tz);
        return <span className={display.className}>{display.text}</span>;
      },
    },
    {
      id: 'created',
      accessorKey: 'created_at',
      header: sortable('created', 'Created'),
      size: 110,
      meta: { label: 'Created', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{formatExactInstant(row.original.created_at)}</span>
      ),
    },
  ];

  return columns;
}
