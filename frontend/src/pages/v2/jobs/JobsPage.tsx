import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { Download, Plus } from 'lucide-react';

import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import { useAssignableUsers } from '@/lib/api/users';
import { useTagFacetOptions } from '@/lib/api/tags';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { useFilterState } from '@/lib/filters/useFilterState';
import { jobsRegistry, MONTHLY_JOB_STATUSES } from '@/lib/filters/registries/jobs';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import type { FacetOption, FilterState } from '@/lib/filters/types';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { DataTableToolbar } from '@/ui-kit/components/data/dataTable/dataTableToolbar';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

import { v2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { AppliedFilterBar as JobFilterBar } from '../_shared/appliedFilters';
import { FilterPopover, facetSelectionCount } from './components/filterPopover';
import { BulkBar } from './components/bulkBar';
import { buildJobColumns, formatJobLocation, formatJobScheduledCell, type JobListItem } from './jobsColumns';

interface JobStats {
  unassigned: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  need_invoices: number;
}

interface Department {
  id: string;
  name: string;
}

/**
 * /v2/jobs - the jobs list on the CRM UI kit.
 *
 * Every query, param, cache key, filter rule and permission gate below is the
 * legacy page's, imported or copied verbatim; only the components changed. Two
 * shape differences are forced by the kit and are recorded in the ledger:
 *
 *  SORTING IS SERVER-SIDE, and the table is told so: `sorting` is this page's
 *  state, `onSortingChange` is the way back in and `manualSorting` stops the
 *  table re-ordering rows the server already ordered.
 *
 *  SELECTION goes through the table, and `useScopedRowSelection` - the legacy
 *  list's own hook, unforked - is the state behind it, keyed on the same scope
 *  string the legacy page built.
 *
 * Paging is server-side too, and the table takes it: `page`, `pageCount`,
 * `pageSize` and `rowCount` are handed to the DataTable and its footer is the
 * ONLY paging control on the page.
 */
export default function JobsPage() {
  useRecordVisit('jobs');
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);

  // The LEGACY page's table key, verbatim (`pages/JobsPage.tsx`'s
  // `tableKey="jobs"`), so a user's stored column widths and visibility carry
  // over to this list instead of starting empty.

  // The legacy DataTable debounced its search box by 300 ms before lifting the
  // value; the kit's toolbar lifts on every keystroke, so the debounce moves
  // here. Page still snaps back to 1 on the keystroke itself, not on the
  // settled value, so no state is written from an effect.
  const search = useDebounce(searchInput, 300);

  const canManage = ability.can('create', 'Job');

  // Generalized filter registry: status, assigned_to, department_id, scheduled
  // (dateRange), created (dateRange), needs_invoice (1-option multi), tags - all
  // URL-driven via `jobsRegistry`. Deep links like
  // `?status=UNSCHEDULED&status=SCHEDULED` or `?needs_invoice=true` (the
  // Customers "Active Jobs" KPI, the Invoices "To Be Invoiced" KPI) are decoded
  // automatically on mount by `useFilterState`.
  const { value, setValue, listParams: filterParams } = useFilterState(jobsRegistry);

  // #1634: the org zone. Feeds both the Scheduled cell/CSV (below, an org fact -
  // when the crew is going) and the Completed/Cancelled tiles' month bounds
  // (also an org fact, not a "when was this row made" one) so the tile and the
  // Filter popover's "scheduled" preset agree.
  const tz = useScheduleTimezone();
  const monthStart = useMemo(() => startOfMonthDay(tz), [tz]);
  const monthEnd = useMemo(() => endOfMonthDay(tz), [tz]);

  // Roster for the "Assigned To" filter and the bulk Assign menu - assignable-role
  // users unioned with anyone actually referenced on a job, so a genuinely-assigned
  // non-technician is not dropped.
  // `directory`, not `jobCrew`: this roster is the list page's assignee FILTER facet plus its
  // name lookups. It assigns nobody - the crew write lives on the job detail/visit dialogs,
  // which keep `jobCrew` - so `read User` is the grant that governs it.
  const { data: techsData } = useAssignableUsers({ purpose: 'directory', includeReferencedIn: 'jobs' });
  const techs = useMemo(() => techsData ?? [], [techsData]);

  const { data: departmentsData } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get('/api/departments');
      return data.departments as Department[];
    },
  });

  // Memoized on the underlying query data (a stable react-query reference, not
  // re-derived into a fresh array identity every render) per the registry-
  // stability contract.
  const assignedToOptions = useMemo<FacetOption[]>(
    () => techs.map((t) => ({ value: t.id, label: `${t.first_name} ${t.last_name}`.trim() })),
    [techs],
  );
  const departmentOptions = useMemo<FacetOption[]>(
    () => (departmentsData ?? []).map((d) => ({ value: d.id, label: d.name })),
    [departmentsData],
  );
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'assignableUsers') return assignedToOptions;
      if (sourceId === 'departments') return departmentOptions;
      if (sourceId === 'tags') return tagFacetOptions;
      return [];
    },
    [assignedToOptions, departmentOptions, tagFacetOptions],
  );

  // Any filter change (facet edit, chip removal, "Clear all", KPI click) snaps
  // back to page 1 - the same behaviour the legacy per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  // Drives whether the applied-chip bar renders at all. Counted through the same
  // helper the popover uses, so an empty-but-present facet entry - which `value`
  // keeps after a clear - does not leave a chip row with nothing in it. (The
  // legacy gate was `Object.keys(value).length > 0`, which did leave one.)
  const hasActiveFilters = useMemo(
    () => jobsRegistry.some((facet) => facetSelectionCount(value[facet.key]) > 0),
    [value],
  );

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve the
  // pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present - even if
  // `undefined` - on an unfiltered mount). `filterParams` only carries keys for
  // ACTIVE facets, so this baseline fills in the rest; axios drops
  // `undefined`-valued params before sending either way.
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    assigned_to: undefined as string | undefined,
    department_id: undefined as string | undefined,
    scheduled_after: undefined as string | undefined,
    scheduled_before: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    needs_invoice: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    // Service-plan visit-jobs are managed in the Service Plans module, not this
    // list. They remain on the calendar and the technician app.
    exclude_plan_visits: 'true',
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
  });

  const stats: JobStats | undefined = data?.stats;
  const rows: JobListItem[] = data?.jobs ?? [];
  const pagination = data?.pagination as { page: number; limit: number; total: number; totalPages: number } | undefined;

  // A selected id only makes sense against the CURRENT page/sort/filter. Mirrors
  // the legacy page's `useScopedRowSelection` key exactly - and it IS that
  // hook, unforked: a scope change reads back as empty in the SAME render, so
  // there is never a repaint with stale rows still ticked.
  const selectionScope = JSON.stringify([page, pageSize, search, sortBy, sortDir, value]);
  const { rowSelection, setRowSelection, selectedIds: selectedJobIds } =
    useScopedRowSelection(selectionScope);

  // Selection is only offered to a viewer who can act on it: the legacy bulk bar
  // is entirely ability-gated, so without one of these the checkboxes lead
  // nowhere.
  const canBulkAct =
    ability.can('assign', 'Job') ||
    ability.can('arrive', 'Job') || ability.can('start', 'Job') ||
    ability.can('complete', 'Job') || ability.can('cancel', 'Job');

  const handleSearchChange = useCallback((next: string) => {
    setSearchInput(next);
    setPage(1);
  }, []);

  const toggleSort = useCallback((columnId: string) => {
    setSorting((prev) => {
      const current = prev[0];
      if (!current || current.id !== columnId) return [{ id: columnId, desc: false }];
      if (!current.desc) return [{ id: columnId, desc: true }];
      return [];
    });
    setPage(1);
  }, []);

  // The table's second route into the same state. `toggleSort` is what the
  // header buttons call; anything that goes through TanStack's own sorting API
  // lands here, and both snap the list back to page 1.
  const handleSortingChange = useCallback((next: SortingState) => {
    setSorting(next);
    setPage(1);
  }, []);

  // tz (the org zone) is resolved once, above, near the "scheduled" facet's KPI bounds.
  const columns = useMemo(
    () => buildJobColumns(sorting, toggleSort, canBulkAct, tz),
    [sorting, toggleSort, canBulkAct, tz],
  );

  const clearAllFilters = () => {
    setValue({});
    setSearchInput('');
    setPage(1);
  };

  // --- Clickable status KPIs ------------------------------------------------
  // Each tile maps 1:1 to its count: filtering shows exactly that many rows, and
  // clicking the active tile clears the filter.
  //   - All-time tiles (Unscheduled/Scheduled/In Progress): status only, no date range.
  //   - Monthly tiles (Completed/Cancelled): status + the current-month Scheduled range.
  // A tile is only "active" when NOTHING else narrows the list further than the
  // tile's own count implies.
  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const assignedValues = value.assigned_to?.kind === 'multi' ? value.assigned_to.values : [];
  const departmentValues = value.department_id?.kind === 'multi' ? value.department_id.values : [];
  const scheduledValue = value.scheduled?.kind === 'dateRange' ? value.scheduled : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const needsInvoiceValues = value.needs_invoice?.kind === 'multi' ? value.needs_invoice.values : [];
  const needsInvoiceActive = needsInvoiceValues.includes('true');
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here
  // too - otherwise a status-plus-tags filter leaves the status tile lit over a
  // list narrowed further than its count implies, and a repeat click routes into
  // clearAllFilters() and drops the tag filter.
  const otherFiltersActive =
    assignedValues.length > 0 ||
    departmentValues.length > 0 ||
    tagValues.length > 0 ||
    Boolean(createdValue?.from) || Boolean(createdValue?.to) ||
    Boolean(search);

  const noScheduledRange = !scheduledValue?.from && !scheduledValue?.to;
  const isMonthRange = scheduledValue?.from === monthStart && scheduledValue?.to === monthEnd;
  const soleStatus = statusValues.length === 1 ? statusValues[0] : null;

  const activeStatusKpi =
    soleStatus && !otherFiltersActive && !needsInvoiceActive
      ? MONTHLY_JOB_STATUSES.includes(soleStatus)
        ? (isMonthRange ? soleStatus : null)
        : (noScheduledRange ? soleStatus : null)
      : null;

  const handleStatusKpi = (status: string) => {
    if (activeStatusKpi === status) { clearAllFilters(); return; }
    setSearchInput('');
    setPage(1);
    if (MONTHLY_JOB_STATUSES.includes(status)) {
      setValue({
        status: { kind: 'multi', values: [status] },
        scheduled: { kind: 'dateRange', from: monthStart, to: monthEnd },
      });
    } else {
      setValue({ status: { kind: 'multi', values: [status] } });
    }
  };

  // Need Invoices tile: completed-but-unbilled jobs. Active only when
  // needs_invoice is the sole filter.
  const activeNeedInvoicesKpi =
    needsInvoiceActive && statusValues.length === 0 && noScheduledRange && !otherFiltersActive;

  const handleNeedInvoicesKpi = () => {
    if (activeNeedInvoicesKpi) { clearAllFilters(); return; }
    // `setValue` full-replaces every registry facet (see useFilterState.ts's
    // JSDoc), so this single call clears status/assigned_to/department_id/
    // scheduled/created/tags in the same stroke.
    setValue({ needs_invoice: { kind: 'multi', values: ['true'] } });
    setSearchInput('');
    setPage(1);
  };

  const toExportRow = (j: JobListItem) => ({
    'Job #': j.job_number,
    'Customer': customerDisplayName(j.customer, ''),
    'Company': j.customer.company_name ?? '',
    'Status': j.status,
    'Location': formatJobLocation(j.service_location),
    'Assigned To': (j.assignees ?? []).map((a) => `${a.user.first_name} ${a.user.last_name}`).join('; '),
    'Scheduled': formatJobScheduledCell(j.visits, tz, j.status),
    'Created': formatExactInstant(j.created_at),
  });

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (list: JobListItem[], filename: string) => {
    // The legacy export no-ops silently on an empty set. Saying so out loud is
    // the leads module's precedent and costs no behaviour.
    if (!list.length) {
      toast('Nothing to export', { description: 'No jobs match the current filters.' });
      return;
    }
    downloadCSV(toCSV(list.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => exportRows(rows, `jobs-page${page}-${today()}.csv`);

  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/jobs/export', { params: listParams });
      exportRows(ex.jobs ?? [], `jobs-all-${today()}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export jobs. Please try again.' });
    }
  };

  return (
    <div>
      {/* Actions hold ONLY the primary one. Export is a table-scoped action - it
          exports what the table is showing - so it lives in the table's own
          toolbar, next to Columns, and appears exactly once on the page. */}
      <PageHeader
        title="Jobs"
        actions={
          canManage ? (
            <Button onClick={() => navigate(v2Path('/jobs/new'))}>
              <Plus />
              New Job
            </Button>
          ) : undefined
        }
      />

      {/* No `tone`: StatCards carry no colour. The legacy strip tinted five tiles
          a different hue each and none of them meant anything the label did not
          already say; the delta chip is the only colour on a KPI that does. */}
      <StatCardGroup className="mb-4 xl:grid-cols-6">
        <StatCard
          label="Unscheduled" value={stats?.unassigned ?? 0} loading={isLoading}
          active={activeStatusKpi === 'UNSCHEDULED'} onClick={() => handleStatusKpi('UNSCHEDULED')}
        />
        <StatCard
          label="Scheduled" value={stats?.scheduled ?? 0} loading={isLoading}
          active={activeStatusKpi === 'SCHEDULED'} onClick={() => handleStatusKpi('SCHEDULED')}
        />
        <StatCard
          label="In Progress" value={stats?.in_progress ?? 0} loading={isLoading}
          active={activeStatusKpi === 'IN_PROGRESS'} onClick={() => handleStatusKpi('IN_PROGRESS')}
        />
        <StatCard
          label="Completed" value={stats?.completed ?? 0} loading={isLoading}
          active={activeStatusKpi === 'COMPLETED'} onClick={() => handleStatusKpi('COMPLETED')}
        />
        <StatCard
          label="Cancelled" value={stats?.cancelled ?? 0} loading={isLoading}
          active={activeStatusKpi === 'CANCELLED'} onClick={() => handleStatusKpi('CANCELLED')}
        />
        <StatCard
          label="Need Invoices" value={stats?.need_invoices ?? 0} loading={isLoading}
          active={activeNeedInvoicesKpi} onClick={handleNeedInvoicesKpi}
        />
      </StatCardGroup>

      {/* Applied-filter chips only. The Filter TRIGGER lives in the table toolbar
          beside Columns and Export, where the other table controls are; this bar
          appears solely to name what is currently constraining the list. */}
      {hasActiveFilters && (
        <JobFilterBar
          className="mb-3"
          registry={jobsRegistry}
          value={value}
          onChange={handleFilterChange}
          resolveOptions={resolveOptions}
          resultCount={rows.length}
          totalCount={pagination?.total}
        />
      )}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(job) => job.id}
        isLoading={isLoading}
        page={page}
        pageCount={pagination?.totalPages ?? 1}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        rowCount={pagination?.total ?? 0}
        sorting={sorting}
        onSortingChange={handleSortingChange}
        manualSorting
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        enableColumnResizing
        mobileCards
        onRowClick={(job) => navigate(v2Path(`/jobs/${job.id}`))}
        // The legacy list renders ONE message for both "no jobs exist" and "no
        // rows match the filters", and the list query has no error branch either
        // - a failed fetch looks identical. Reproduced as-is; inventing a
        // distinction would be a behaviour change (map section 12 flags it).
        empty={<EmptyState title="No results found." />}
      >
        {(table) => (
          <>
            <DataTableToolbar
              table={table}
              searchValue={searchInput}
              onSearchChange={handleSearchChange}
              searchPlaceholder="Search jobs..."
              actions={
                <>
                  <FilterPopover
                    registry={jobsRegistry}
                    value={value}
                    onChange={handleFilterChange}
                    resolveOptions={resolveOptions}
                  />
                  {/* The only raw ROLE check on this page, carried over
                      verbatim: SALES sees no export. */}
                  {user?.role !== 'SALES' && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Download />
                          Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Export as CSV</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={handleExportCurrentPage}>
                          Current page ({rows.length} rows)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleExportAll}>
                          All ({pagination?.total ?? '...'})
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </>
              }
            />
            {canBulkAct && (
              <BulkBar
                selectedJobIds={selectedJobIds}
                onClear={() => setRowSelection({})}
                assignees={techs}
              />
            )}
          </>
        )}
      </DataTable>
    </div>
  );
}
