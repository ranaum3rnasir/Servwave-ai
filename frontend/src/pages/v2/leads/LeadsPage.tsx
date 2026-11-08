import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { Download, Plus } from 'lucide-react';

import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useAssignableUsers } from '@/lib/api/users';
import { customerDisplayName } from '@/lib/customer-name';
import { startOfWeekDay } from '@/lib/date-range';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { formatPhone } from '@/lib/utils';
import { useFilterState } from '@/lib/filters/useFilterState';
import { leadsRegistry } from '@/lib/filters/registries/leads';
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
import { AppliedFilterBar as LeadFilterBar } from '../_shared/appliedFilters';
import { FilterPopover, facetSelectionCount } from '../_shared/filterPopover';
import { buildLeadColumns, type Lead } from './leadsColumns';

interface LeadStats {
  total: number;
  new_this_week: number;
  unassigned: number;
  won: number;
  lost: number;
}

/**
 * /v2/leads - the leads list on the CRM UI kit.
 *
 * Every query, param, cache key and filter rule below is the legacy page's,
 * imported or copied verbatim; only the components changed.
 *
 *  SORTING IS SERVER-SIDE, and the table is told so: `sorting` is this page's
 *  state, `onSortingChange` is the way back in and `manualSorting` stops the
 *  table re-ordering rows the server already ordered.
 *
 * Paging is server-side too, but the table now takes it: `page`, `pageCount`,
 * `pageSize` and `rowCount` are handed to the DataTable and its footer is the
 * ONLY paging control on the page. It used to render a second set above the
 * table because the kit component had no way in, and a list with two paginators
 * makes the reader work out which one is real.
 */
export default function LeadsPage() {
  useRecordVisit('leads');
  const { data: org } = useOrganization();
  const tz = useScheduleTimezone();
  const navigate = useNavigate();
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);

  // The LEGACY page's table key, verbatim (`pages/LeadsPage.tsx`'s
  // `tableKey="leads"`), so a user's stored column widths and visibility carry
  // over to this list instead of starting empty.

  // The legacy DataTable debounced its search box by 300 ms before lifting the
  // value; the kit's toolbar lifts on every keystroke, so the debounce moves
  // here. Page still snaps back to 1 on the keystroke itself, not on the
  // settled value, so no state is written from an effect.
  const search = useDebounce(searchInput, 300);

  const { value, setValue, listParams: filterParams } = useFilterState(leadsRegistry);

  // Any filter change (facet edit, chip removal, "Clear all", KPI click) snaps
  // back to page 1.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  // Drives whether the applied-chip bar renders at all. Counted through the
  // same helper the popover uses, so an empty-but-present facet entry - which
  // `value` keeps after a clear - does not leave a chip row with nothing in it.
  const hasActiveFilters = useMemo(
    () => leadsRegistry.some((facet) => facetSelectionCount(value[facet.key]) > 0),
    [value],
  );

  // `directory`, not `walkthroughPerformer`: the list page's assignee FILTER facet. The
  // performer WRITE is on the lead's Walkthrough tab and keeps its pool-governed purpose.
  const { data: assigneesData } = useAssignableUsers({ purpose: 'directory', includeReferencedIn: 'leads' });

  const sourceOptions = useMemo<FacetOption[]>(
    () => (org?.source_options ?? []).map((s) => ({ value: s, label: s })),
    [org?.source_options],
  );
  const jobTypeOptions = useMemo<FacetOption[]>(
    () => (org?.job_type_options ?? []).map((t) => ({ value: t, label: t })),
    [org?.job_type_options],
  );
  const assignedToOptions = useMemo<FacetOption[]>(
    () => [
      { value: 'UNASSIGNED', label: 'Unassigned' },
      ...(assigneesData ?? []).map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}`.trim() })),
    ],
    [assigneesData],
  );
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'org.sourceOptions') return sourceOptions;
      if (sourceId === 'org.jobTypeOptions') return jobTypeOptions;
      if (sourceId === 'assignableUsers') return assignedToOptions;
      return [];
    },
    [sourceOptions, jobTypeOptions, assignedToOptions],
  );
  // No backend field for "max estimates on any one lead" today - 20 is a static
  // ceiling (see the leads registry comment).
  const resolveMax = useCallback((sourceId: string): number => (sourceId === 'leads.maxEstimates' ? 20 : 0), []);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet param preserve the
  // pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present - even if
  // `undefined` - on an unfiltered mount). Axios drops `undefined`-valued params
  // before sending, so the wire request is unchanged either way.
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    ad_source: undefined as string | undefined,
    job_type: undefined as string | undefined,
    assigned_to: undefined as string | undefined,
    walkthrough_status: undefined as string | undefined,
    estimates_min: undefined as string | undefined,
    estimates_max: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['leads', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });

  const stats: LeadStats | undefined = data?.stats;
  const rows: Lead[] = data?.leads ?? [];
  const pagination = data?.pagination as { page: number; limit: number; total: number; totalPages: number } | undefined;

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

  // No selection column: the list's only bulk action was Export selected, and
  // the toolbar Export below already covers exporting this list.
  const columns = useMemo(() => buildLeadColumns(sorting, toggleSort, tz), [sorting, toggleSort, tz]);

  const clearAllFilters = () => {
    setValue({});
    setSearchInput('');
    setPage(1);
  };

  // Clickable KPIs. Each maps to a real, user-reproducible filter preset.
  const weekStart = useMemo(() => startOfWeekDay(), []);

  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const assignedValues = value.assigned_to?.kind === 'multi' ? value.assigned_to.values : [];
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const noManual =
    (value.ad_source?.kind !== 'multi' || value.ad_source.values.length === 0) &&
    (value.job_type?.kind !== 'multi' || value.job_type.values.length === 0) &&
    (value.walkthrough_status?.kind !== 'multi' || value.walkthrough_status.values.length === 0) &&
    !search;

  const activeKpi: string | null =
    (statusValues.length === 0 && createdValue?.from === weekStart && !createdValue?.to && assignedValues.length === 0 && noManual) ? 'new_this_week' :
    (statusValues.length === 1 && statusValues[0] === 'WON' && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'won' :
    (statusValues.length === 1 && statusValues[0] === 'LOST' && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'lost' :
    (assignedValues.length === 1 && assignedValues[0] === 'UNASSIGNED' && statusValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'unassigned' :
    (statusValues.length === 0 && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'total' :
    null;

  const applyKpi = (preset: string) => {
    setSearchInput('');
    setPage(1);
    if (preset === 'total') {
      setValue({});
    } else if (preset === 'unassigned') {
      setValue({ assigned_to: { kind: 'multi', values: ['UNASSIGNED'] } });
    } else if (preset === 'new_this_week') {
      setValue({ created: { kind: 'dateRange', from: weekStart, to: '' } });
    } else if (preset === 'won') {
      setValue({ status: { kind: 'multi', values: ['WON'] } });
    } else if (preset === 'lost') {
      setValue({ status: { kind: 'multi', values: ['LOST'] } });
    }
  };

  const handleKpiClick = (preset: string) => {
    if (activeKpi === preset) { clearAllFilters(); return; }
    applyKpi(preset);
  };

  const toExportRow = (l: Lead) => ({
    'Customer': customerDisplayName(l.customer, ''),
    'Company': l.customer.company_name ?? '',
    'Phone': formatPhone(l.customer.phone),
    'Source': l.customer.ad_source ?? '',
    'Service Request': l.service_request,
    'Location': [l.service_city, l.service_state].filter(Boolean).join(', '),
    'Type': l.job_type ?? '',
    'Status': STATUS_REGISTRY.lead[l.status]?.label ?? l.status,
    'Estimates': (l.estimates ?? []).length,
    'Est. Value': (l.estimates ?? []).reduce((sum, e) => sum + Number(e.total_amount), 0),
    'Assigned To': l.commission_owner ? `${l.commission_owner.first_name} ${l.commission_owner.last_name}` : 'Unassigned',
    'Created': new Date(l.created_at).toLocaleDateString(),
  });

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (list: Lead[], filename: string) => {
    if (!list.length) {
      toast('Nothing to export', { description: 'No leads match the current filters.' });
      return;
    }
    downloadCSV(toCSV(list.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => {
    try {
      exportRows(rows, `leads-page${page}-${today()}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export leads. Please try again.' });
    }
  };

  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/leads/export', { params: listParams });
      exportRows(ex.leads ?? [], `leads-all-${today()}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export leads. Please try again.' });
    }
  };

  return (
    <div>
      {/* Actions hold ONLY the primary one. Export is a table-scoped action -
          it exports what the table is showing - so it lives in the table's own
          toolbar, next to Columns, and appears exactly once on the page. */}
      <PageHeader
        title="Leads"
        actions={
          ability.can('create', 'Lead') ? (
            <Button onClick={() => navigate(v2Path('/leads/new'))}>
              <Plus />
              New Lead
            </Button>
          ) : undefined
        }
      />

      {/* No `tone`: StatCards carry no colour. The rail tinted five cards a
          different hue each and none of them meant anything - the delta chip is
          the only colour on a KPI that does. */}
      <StatCardGroup className="mb-4 xl:grid-cols-5">
        <StatCard
          label="Total Leads" value={stats?.total ?? 0} loading={isLoading}
          active={activeKpi === 'total'} onClick={() => handleKpiClick('total')}
        />
        <StatCard
          label="New This Week" value={stats?.new_this_week ?? 0} loading={isLoading}
          active={activeKpi === 'new_this_week'} onClick={() => handleKpiClick('new_this_week')}
        />
        <StatCard
          label="Unassigned" value={stats?.unassigned ?? 0} loading={isLoading}
          active={activeKpi === 'unassigned'} onClick={() => handleKpiClick('unassigned')}
        />
        <StatCard
          label="Won" value={stats?.won ?? 0} loading={isLoading}
          active={activeKpi === 'won'} onClick={() => handleKpiClick('won')}
        />
        <StatCard
          label="Lost" value={stats?.lost ?? 0} loading={isLoading}
          active={activeKpi === 'lost'} onClick={() => handleKpiClick('lost')}
        />
      </StatCardGroup>

      {/* Applied-filter chips only. The Filter TRIGGER now lives in the table
          toolbar beside Columns and Export, where the other table controls are;
          this bar appears solely to name what is currently constraining the
          list, and disappears when nothing is. An always-present empty row
          above the table was a row of chrome saying nothing. */}
      {hasActiveFilters && (
        <LeadFilterBar
          className="mb-3"
          registry={leadsRegistry}
          value={value}
          onChange={handleFilterChange}
          resolveOptions={resolveOptions}
          resultCount={rows.length}
          totalCount={pagination?.total}
        />
      )}

      {/* The server's page state drives the table's own footer, which is the
          page's single paging control. */}
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(lead) => lead.id}
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
        enableColumnResizing
        mobileCards
        onRowClick={(lead) => navigate(v2Path(`/leads/${lead.id}`))}
        empty={<EmptyState title="No results found." />}
      >
        {(table) => (
          <DataTableToolbar
            table={table}
            searchValue={searchInput}
            onSearchChange={handleSearchChange}
            searchPlaceholder="Search leads..."
            actions={
              <>
                {/* Filter sits with the other table controls - Columns and
                    Export - because all three act on the same table. Splitting
                    one of them onto its own row above made it read as a page
                    control rather than a table control. */}
                <FilterPopover
                  registry={leadsRegistry}
                  value={value}
                  onChange={handleFilterChange}
                  resolveOptions={resolveOptions}
                  resolveMax={resolveMax}
                  statusDomain="lead"
                />
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
              </>
            }
          />
        )}
      </DataTable>
    </div>
  );
}
