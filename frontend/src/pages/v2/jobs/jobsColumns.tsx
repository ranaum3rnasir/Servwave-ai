import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Link } from 'react-router-dom';

import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { formatInstant } from '@/lib/schedule-tz';
import { isLiveVisit } from '@/lib/visits';
import { TagChips, type TagChip } from '@/components/data/TagChips';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { preferV2Path } from '../uiV2';
import { StatusChip } from './components/statusChip';

/** One row of the `visits` array jobListSelect ships on every list row (job.controller.ts). */
export interface JobListVisit {
  id: string;
  visit_seq: number;
  status: string;
  scheduled_at: string | null;
  scheduled_end: string | null;
  is_all_day: boolean;
}

export interface JobListItem {
  id: string;
  job_number: string;
  status: string;
  // SRVW-112 - rendered inside the existing Status cell, not as a new column.
  sub_status?: { id: string; label: string } | null;
  // S8 §2/§3 (RATIFIED, A5): the stored mirror this field named is now DROPPED - the backend
  // computes it fresh off `visits[]` on every response (job-schedule-projection.ts). Still DERIVED,
  // not authoritative - this column's own cell already reads `visits[]` directly (below), so this
  // key exists only for `accessorKey`'s internal bookkeeping and any other reader that has not
  // moved to `visits[]` yet.
  scheduled_start: string | null;
  // Multi-visit S8 §4: the whole visit set, not just the mirror. The Scheduled cell (and the CSV
  // export in JobsPage.tsx) resolve their own value from this array - see
  // `nextScheduledCellVisit` below - rather than trusting `scheduled_start`, which A1 measured as
  // stale (non-null with no live visit) on thousands of staging rows.
  visits: JobListVisit[];
  created_at: string;
  customer: {
    id: string; first_name: string; last_name: string;
    company_name: string | null; customer_number?: string | null;
  };
  assignees: { user: { id: string; first_name: string; last_name: string } }[];
  service_location: { id: string; address_line1: string; city: string; state: string } | null;
  tags?: TagChip[];
}

/**
 * The Scheduled column's value (#1634 + A1): the next upcoming LIVE visit - earliest by
 * `scheduled_at` among SCHEDULED / EN_ROUTE / ON_SITE / IN_PROGRESS rows - falling back to the
 * earliest NON-CANCELLED visit when the job holds no live one, which is exactly A2+'s
 * `first_visit_start` definition (MIN(scheduled_at) over non-cancelled visits).
 *
 * Computed HERE from the `visits` array the list already ships, not read off a job-level mirror
 * column: `Job.scheduled_start` is the forward-looking mirror A1 found stale on 7,492 staging
 * rows (set, but with no live visit left to justify it), and `Job.first_visit_start` is not
 * projected on this list's select at all - see jobsColumns' own header note. Untimed visits
 * (`scheduled_at === null`) never win.
 *
 * `jobStatus` narrows ONE more case, deliberately and only that one: when the JOB itself is
 * CANCELLED and every one of its visits is too, the cell falls back further to the earliest
 * visit of ANY status rather than going blank. D19 says history is "readable, never actionable" -
 * blanking it makes it unreadable, and it would be incoherent with the list's own filter:
 * `buildJobListWhere` (job.controller.ts:966-971) carries a second OR arm specifically so a
 * CANCELLED job still MATCHES a date-range question, so without this the list could match a
 * cancelled job on a date and then render an empty cell for the very date it matched on.
 *
 * This does NOT widen to a LIVE job (SCHEDULED / IN_PROGRESS / UNSCHEDULED / ...) whose visits
 * are all cancelled - there, blank is a true signal (D16: nothing is booked, this needs a
 * dispatcher), and showing a stale cancelled-visit date in its place would hide that. Ratified by
 * the release owner 2026-08-24; do not widen this without a fresh ruling.
 */
export function nextScheduledCellVisit(visits: JobListVisit[], jobStatus: string): JobListVisit | null {
  const timed = visits.filter((v) => v.scheduled_at !== null);
  const earliestOf = (rows: JobListVisit[]) =>
    rows.reduce((earliest, v) =>
      (new Date(v.scheduled_at!).getTime() < new Date(earliest.scheduled_at!).getTime() ? v : earliest));
  const live = timed.filter(isLiveVisit);
  if (live.length > 0) return earliestOf(live);
  const notCancelled = timed.filter((v) => v.status !== 'CANCELLED');
  if (notCancelled.length > 0) return earliestOf(notCancelled);
  if (jobStatus === 'CANCELLED' && timed.length > 0) return earliestOf(timed);
  return null;
}

/** Formats the Scheduled cell's value in the ORG zone. Shared by the table cell and the CSV export. */
export function formatJobScheduledCell(visits: JobListVisit[], tz: string, jobStatus: string): string {
  const visit = nextScheduledCellVisit(visits ?? [], jobStatus);
  return visit ? formatInstant(visit.scheduled_at, tz) : '';
}

/**
 * Location display rules, ported verbatim from `pages/JobsPage.tsx` including
 * the historical-import sentinel: an imported placeholder address renders as
 * nothing rather than as the placeholder text.
 */
export function formatJobLocation(loc: JobListItem['service_location']): string {
  if (!loc) return '';
  const { address_line1, city, state } = loc;
  if (address_line1?.toLowerCase().includes('historical import')) return '';
  if (!address_line1) return city && state ? `${city}, ${state}` : city || '';
  if (city) return `${address_line1}, ${city}`;
  return address_line1;
}

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 * Same four sortable columns as the legacy list (`job_number`, `status`,
 * `scheduled`, `created`) and the same verbatim `sortBy` values.
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
      // `text-[11.5px] font-semibold` restates what TableHead already sets on
      // the cell. Button's own `size="sm"` ships `text-[13px]`, which wins
      // inside the header and made every SORTABLE column's title a size and a
      // weight apart from its plain neighbours - the row read as two different
      // header styles rather than one.
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

export function buildJobColumns(
  sorting: SortingState,
  onToggleSort: (columnId: string) => void,
  /**
   * Selection is only offered when the viewer can act on it - see JobsPage.
   * The legacy list renders the checkbox column unconditionally, but its bulk
   * toolbar is entirely ability-gated, so a viewer with neither a status verb
   * nor `assign Job` could tick rows and be offered nothing.
   */
  selectable: boolean,
  /** #1634: the Scheduled cell renders in the ORG zone, not the viewer's browser zone. */
  tz: string,
): ColumnDef<JobListItem, unknown>[] {
  const sortable = (columnId: string, title: string) => () =>
    <SortHeader columnId={columnId} title={title} sorting={sorting} onToggleSort={onToggleSort} />;

  // Pinned so it leads the sticky run: pinning honours the LEADING run of
  // pinned columns only, so the checkbox in front of the legacy pair has to be
  // pinned too or the run stops before it starts.
  const selectColumn: ColumnDef<JobListItem, unknown> = {
    id: 'select',
    size: 40,
    enableHiding: false,
    enableResizing: false,
    meta: { label: 'Select', pinned: true, fixed: true },
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all jobs on this page"
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
        aria-label={`Select ${row.original.job_number}`}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(value === true)}
        onClick={(e) => e.stopPropagation()}
      />
    ),
  };

  const columns: ColumnDef<JobListItem, unknown>[] = [
    {
      id: 'job_number',
      accessorKey: 'job_number',
      header: sortable('job_number', 'Job #'),
      size: 96,
      // `pinned` ported verbatim from the legacy list, which sticks the
      // identity pair (job_number + customer) to the left edge.
      meta: { label: 'Job #', pinned: true, fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground font-mono text-xs">{row.original.job_number}</span>
      ),
    },
    {
      id: 'customer',
      accessorKey: 'customer',
      header: 'Customer',
      size: 170,
      // Hideable, like every other named column. It was locked on, which kept
      // it out of the Columns menu entirely - the menu lists what can be
      // toggled - so the list appeared to be missing one of its own headers.
      meta: { label: 'Customer', pinned: true },
      cell: ({ row }) => {
        const c = row.original.customer;
        return (
          <div className="min-w-0">
            {c?.id ? (
              // The legacy cell was plain text and the whole row navigated to
              // the job. The customer name is the one other record a job row
              // points at, and the detail page already links it, so the link is
              // offered here too - stopPropagation keeps the row click intact.
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
      id: 'status',
      accessorKey: 'status',
      header: sortable('status', 'Status'),
      size: 120,
      meta: { label: 'Status', fixed: true },
      // SRVW-112 - the org-defined sub-status rides UNDER the parent badge in
      // the same cell. No new column, so the column-visibility machinery is
      // untouched.
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <StatusChip domain="job" status={row.original.status} />
          {row.original.sub_status && (
            <span className="text-muted-foreground truncate text-xs">{row.original.sub_status.label}</span>
          )}
        </div>
      ),
    },
    {
      id: 'location',
      accessorKey: 'service_location',
      header: 'Location',
      size: 180,
      meta: { label: 'Location' },
      cell: ({ row }) => {
        const display = formatJobLocation(row.original.service_location);
        return display
          ? <span className="text-muted-foreground block truncate text-sm" title={display}>{display}</span>
          : <span className="text-muted-foreground">{'-'}</span>;
      },
    },
    {
      id: 'assigned_to',
      accessorKey: 'assignees',
      header: 'Assigned To',
      size: 140,
      meta: { label: 'Assigned To' },
      cell: ({ row }) => {
        const crew = row.original.assignees ?? [];
        const names = crew.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ');
        return crew.length > 0
          ? <span className="block truncate" title={names}>{names}</span>
          : <span className="text-muted-foreground italic">Unassigned</span>;
      },
    },
    {
      id: 'scheduled',
      accessorKey: 'scheduled_start',
      header: sortable('scheduled', 'Scheduled'),
      size: 120,
      meta: { label: 'Scheduled', fixed: true },
      cell: ({ row }) => {
        const d = formatJobScheduledCell(row.original.visits, tz, row.original.status);
        return d
          ? <span className="tabular-nums">{d}</span>
          : <span className="text-muted-foreground">{'-'}</span>;
      },
    },
    {
      id: 'tags',
      header: 'Tags',
      size: 140,
      meta: { label: 'Tags' },
      // The app's shared chip treatment, not a kit Badge: `tag.color` is runtime
      // user data applied as an inline style, and `TagChips` is the one place
      // that rule lives (SRVW-58).
      cell: ({ row }) => <TagChips tags={row.original.tags} />,
    },
    {
      id: 'created',
      accessorKey: 'created_at',
      header: sortable('created', 'Created'),
      size: 120,
      meta: { label: 'Created', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums">{formatExactInstant(row.original.created_at)}</span>
      ),
    },
  ];

  return selectable ? [selectColumn, ...columns] : columns;
}
