import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { Download, Plus } from 'lucide-react';

import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import { customerDisplayName } from '@/lib/customer-name';
import { startOfMonthDay } from '@/lib/date-range';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { formatPhone } from '@/lib/utils';
import { useFilterState } from '@/lib/filters/useFilterState';
import { customersRegistry } from '@/lib/filters/registries/customers';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { useTagFacetOptions } from '@/lib/api/tags';
import type { FacetOption, FilterState } from '@/lib/filters/types';
// The default sort is IMPORTED, never restated: `customers-default-sort.test.tsx`
// asserts `DEFAULT_CUSTOMERS_SORTING === [{ id: 'created_at', desc: true }]`
// against the legacy page's export, and a second copy here could drift from it
// silently (issue #420 is exactly that regression).
import { DEFAULT_CUSTOMERS_SORTING } from '@/lib/customers/customersSorting';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { DataTableToolbar } from '@/ui-kit/components/data/dataTable/dataTableToolbar';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Label } from '@/ui-kit/components/ui/label';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

import { v2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { FilterPopover } from '../_shared/filterPopover';
import { CustomerFilterBar, type StandaloneFilters } from './components/appliedFilters';
import { BulkBar } from './components/bulkBar';
import { buildCustomerColumns, type Customer } from './customersColumns';

interface CustomerStats {
  total: number;
  newThisMonth: number;
  activeLeads: number;
  activeJobs: number;
}

const toExportRow = (c: Customer): Record<string, unknown> => {
  const loc = c.service_locations?.[0];
  return {
    'First Name': c.first_name ?? '',
    'Last Name': c.last_name ?? '',
    'Email': c.email ?? '',
    'Additional Emails': (c.extra_emails || []).map((e) => e.label ? `${e.email} (${e.label})` : e.email).join('; '),
    'Phone': formatPhone(c.phone),
    'Address': loc?.address_line1 ?? '',
    'City': loc?.city ?? '',
    'State': loc?.state ?? '',
    'ZIP': loc?.zip ?? '',
    'Company': c.company_name ?? '',
    'Ad Source': c.ad_source ?? '',
    'Leads': String(c._count.leads),
    'Jobs': String(c._count.jobs),
    'Created At': new Date(c.created_at).toLocaleDateString(),
  };
};

/**
 * /v2/customers - the customers list on the CRM UI kit.
 *
 * Every query, param, cache key, KPI predicate and filter rule below is the
 * legacy page's, imported or copied verbatim; only the components changed.
 * Three shape differences are forced by the kit and recorded in the ledger:
 *
 *  SORTING IS SERVER-SIDE, and the table is told so: `sorting` is this page's
 *  state, `onSortingChange` is the way back in and `manualSorting` stops the
 *  table re-ordering rows the server already ordered.
 *
 *  PAGING is server-side too, but the table now takes it, and its footer is the
 *  only paging control on the page.
 *
 *  The Filter trigger, the "Show archived" checkbox, Export and Columns all sit
 *  in the table's own toolbar, because all four act on the table.
 */
export default function CustomersPage() {
  useRecordVisit('clients');
  const navigate = useNavigate();
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_CUSTOMERS_SORTING);

  // The LEGACY page's table key, verbatim (`pages/CustomersPage.tsx`'s
  // `tableKey="customers"`), so a user's stored column widths and visibility
  // carry over to this list instead of starting empty.

  // The legacy DataTable debounced its search box by 300 ms before lifting the
  // value; the kit's toolbar lifts on every keystroke, so the debounce moves
  // here. Page still snaps back to 1 on the keystroke itself.
  const search = useDebounce(searchInput, 300);

  const { value, setValue, listParams: filterParams } = useFilterState(customersRegistry);

  // Standalone state - NOT registry facets (see the customers registry file for
  // why): open_leads/active_jobs are KPI-tile-only booleans and
  // include_archived is a plain checkbox.
  const [openLeads, setOpenLeads] = useState(false);
  const [activeJobs, setActiveJobs] = useState(false);
  // Default OFF - the list shows ACTIVE customers (the backend hides archived
  // unless this is on).
  const [includeArchived, setIncludeArchived] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery<CustomerStats>({
    queryKey: ['customer-stats'],
    queryFn: async () => {
      const { data } = await api.get('/api/customers/stats');
      return data;
    },
    staleTime: 30_000,
  });

  // SRVW-58 - the org's tag vocabulary for the Tags facet, this registry's only
  // dynamic `optionSource`.
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => (sourceId === 'tags' ? tagFacetOptions : []),
    [tagFacetOptions],
  );
  // No backend "max leads/jobs on any one customer" stat today - 50 is a
  // sensible static ceiling for both (see the registry's comment).
  const resolveMax = useCallback(
    (sourceId: string): number =>
      sourceId === 'customers.maxLeads' || sourceId === 'customers.maxJobs' ? 50 : 0,
    [],
  );

  // Any filter change (facet edit, chip removal, "Clear all") snaps back to
  // page 1 - same behaviour the legacy per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const monthStart = useMemo(() => startOfMonthDay(), []);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve the
  // legacy `listParams` object's exact key set (`customers-page.test.tsx`
  // asserts `expect.objectContaining({ page: 1, limit: 25, ad_source: undefined })`
  // on an unfiltered mount). `filterParams` only carries keys for ACTIVE facets,
  // so this baseline fills in the rest; axios drops `undefined`-valued params
  // before sending either way.
  const listParams = {
    search: search || undefined,
    ad_source: undefined as string | undefined,
    payment_type: undefined as string | undefined,
    tax_exempt: undefined as string | undefined,
    has_leads: undefined as string | undefined,
    has_jobs: undefined as string | undefined,
    leads_min: undefined as string | undefined,
    leads_max: undefined as string | undefined,
    jobs_min: undefined as string | undefined,
    jobs_max: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    open_leads: openLeads ? 'true' : undefined,
    active_jobs: activeJobs ? 'true' : undefined,
    include_archived: includeArchived ? true : undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['customers', { page, pageSize, search, value, openLeads, activeJobs, includeArchived, sortBy, sortDir }],
    queryFn: async () => {
      const { data } = await api.get('/api/customers', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const rows: Customer[] = data?.customers ?? [];
  const pagination = data?.pagination as
    { page: number; limit: number; total: number; totalPages: number } | undefined;

  // A selected id only makes sense against the CURRENT page/sort/filter -
  // mirrors the customers query's own queryKey dependency set exactly.
  const selectionScope = JSON.stringify(
    [page, pageSize, search, value, openLeads, activeJobs, includeArchived, sortBy, sortDir],
  );

  // The legacy list's own hook, unforked: a scope change reads back as empty in
  // the SAME render, so there is never a repaint with stale rows still ticked.
  const { rowSelection, setRowSelection, selectedIds: selectedCustomerIds } =
    useScopedRowSelection(selectionScope);

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

  // #2041 slice 1, decision 11 - ask the ABILITY, not the role (was `user?.role === 'ADMIN' ||
  // user?.role === 'DISPATCHER'`), copying the `canExport` line below: per-user permission
  // overrides and any future re-grant then flow through with no further edits.
  const canCreate = ability.can('create', 'Customer');
  const canTag = ability.can('update', 'Customer');
  // ONE gate for BOTH export paths, deliberately placed on the shared parent
  // dropdown rather than inside each handler. "All customers" round-trips to
  // /api/customers/export and is guarded server-side; "Current page" builds its
  // CSV client-side from rows already in the query cache, so it issues no
  // request and passes through no guard, audit trail or rate limiter. Hiding
  // the parent is the only single place that closes both.
  //
  // Ask the ABILITY, not the role (same reasoning as `canCreate` above): per-user
  // permission overrides and any future re-grant then flow through with no further edits.
  const canExport = ability.can('export', 'Customer');

  const columns = useMemo(
    () => buildCustomerColumns(sorting, toggleSort, canTag),
    [sorting, toggleSort, canTag],
  );

  const handleExportCurrentPage = () => {
    if (!rows.length) return;
    const csv = toCSV(rows.map(toExportRow));
    const date = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `customers-page${page}-${date}.csv`);
  };

  const handleExportAll = async () => {
    try {
      const { data: exportData } = await api.get('/api/customers/export', { params: listParams });
      const exportRows: Customer[] = exportData.customers ?? [];
      const csv = toCSV(exportRows.map(toExportRow));
      const date = new Date().toISOString().split('T')[0];
      downloadCSV(csv, `customers-all-${date}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export customers. Please try again.' });
    }
  };

  const clearAllFilters = () => {
    // `setValue({})` full-replaces every registry-owned param.
    setValue({});
    setOpenLeads(false);
    setActiveJobs(false);
    setIncludeArchived(false);
    setSearchInput('');
    setPage(1);
  };

  // --- Clickable KPIs -------------------------------------------------------
  // Total -> show all (clear). New This Month -> exact created_after filter.
  // Active Leads / Active Jobs filter the table in place and count CUSTOMERS,
  // so the tile count matches the filtered row count.
  const adSourceValues = value.ad_source?.kind === 'multi' ? value.ad_source.values : [];
  const paymentTypeValues = value.payment_type?.kind === 'multi' ? value.payment_type.values : [];
  const taxExemptValues = value.tax_exempt?.kind === 'multi' ? value.tax_exempt.values : [];
  const hasLeadsValues = value.has_leads?.kind === 'multi' ? value.has_leads.values : [];
  const hasJobsValues = value.has_jobs?.kind === 'multi' ? value.has_jobs.values : [];
  const leadsRangeValue = value.leads?.kind === 'range' ? value.leads : undefined;
  const jobsRangeValue = value.jobs?.kind === 'range' ? value.jobs : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  const leadsRangeActive = Boolean(leadsRangeValue && (leadsRangeValue.from != null || leadsRangeValue.to != null));
  const jobsRangeActive = Boolean(jobsRangeValue && (jobsRangeValue.from != null || jobsRangeValue.to != null));
  const createdActive = Boolean(createdValue?.from || createdValue?.to);

  // "No manual filters" = no registry facet set AND no standalone toggle set -
  // excludes `created` (checked separately) and `include_archived` (excluded
  // from KPI-active determination entirely). SRVW-58: this gate ENUMERATES
  // facet keys, so a new facet has to be added here too, otherwise a tags-only
  // filter leaves the Total tile lit over a narrowed list.
  const noManualFilters =
    adSourceValues.length === 0 && paymentTypeValues.length === 0 && taxExemptValues.length === 0 &&
    hasLeadsValues.length === 0 && hasJobsValues.length === 0 &&
    tagValues.length === 0 &&
    !leadsRangeActive && !jobsRangeActive &&
    !openLeads && !activeJobs && !search;
  const noFilters = noManualFilters && !createdActive;
  const activeKpi: 'total' | 'month' | null =
    (createdValue?.from === monthStart && !createdValue?.to && noManualFilters) ? 'month' :
    (noFilters) ? 'total' : null;

  // No manual filters other than the open-leads / active-jobs flag itself.
  const noOtherManualFilters =
    adSourceValues.length === 0 && paymentTypeValues.length === 0 && taxExemptValues.length === 0 &&
    hasLeadsValues.length === 0 && hasJobsValues.length === 0 &&
    tagValues.length === 0 &&
    !leadsRangeActive && !jobsRangeActive &&
    !search;
  const activeLeadsKpi = openLeads && !activeJobs && noOtherManualFilters && !createdActive;
  const activeJobsKpi = activeJobs && !openLeads && noOtherManualFilters && !createdActive;

  const handleTotalKpi = () => {
    if (activeKpi === 'total') return;
    clearAllFilters();
  };
  const handleMonthKpi = () => {
    if (activeKpi === 'month') { handleTotalKpi(); return; }
    // NOTE: deliberately does NOT reset include_archived - only Total /
    // Active Leads / Active Jobs route through `clearAllFilters`, which does.
    setValue({ created: { kind: 'dateRange', from: monthStart, to: '' } });
    setSearchInput('');
    setOpenLeads(false); setActiveJobs(false);
    setPage(1);
  };
  const handleActiveLeadsKpi = () => {
    if (activeLeadsKpi) { clearAllFilters(); return; }
    clearAllFilters();
    setOpenLeads(true);
    setPage(1);
  };
  const handleActiveJobsKpi = () => {
    if (activeJobsKpi) { clearAllFilters(); return; }
    clearAllFilters();
    setActiveJobs(true);
    setPage(1);
  };

  // Whether the applied-filters strip has anything to show - mirrors the legacy
  // `hasActiveFilters` gate (search was never part of it either; the search box
  // is its own toolbar element, not a chip).
  const standalone: StandaloneFilters = { openLeads, activeJobs, includeArchived };
  const hasActiveFilters =
    Object.keys(value).length > 0 || openLeads || activeJobs || includeArchived;

  const removeStandalone = (key: keyof StandaloneFilters) => {
    if (key === 'openLeads') setOpenLeads(false);
    if (key === 'activeJobs') setActiveJobs(false);
    if (key === 'includeArchived') setIncludeArchived(false);
    setPage(1);
  };

  const currentMonth = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          canCreate ? (
            <Button onClick={() => navigate(v2Path('/customers/new'))}>
              <Plus />
              Add Customer
            </Button>
          ) : undefined
        }
      />

      {/* No `tone`: StatCards carry no colour. The legacy strip painted all four
          tiles the same `primary` hue, which said nothing that the four labels
          did not already say. */}
      <StatCardGroup className="mb-4">
        <StatCard
          label="Total Customers" value={stats?.total ?? 0} loading={statsLoading}
          active={activeKpi === 'total'} onClick={handleTotalKpi}
        />
        <StatCard
          label="New This Month" value={stats?.newThisMonth ?? 0} loading={statsLoading}
          active={activeKpi === 'month'} onClick={handleMonthKpi}
        />
        <StatCard
          label="Active Leads" value={stats?.activeLeads ?? 0} loading={statsLoading}
          active={activeLeadsKpi} onClick={handleActiveLeadsKpi}
        />
        <StatCard
          label="Active Jobs" value={stats?.activeJobs ?? 0} loading={statsLoading}
          active={activeJobsKpi} onClick={handleActiveJobsKpi}
        />
      </StatCardGroup>

      {/* Applied-filter chips only. The Filter TRIGGER lives in the table
          toolbar beside Columns and Export, where the other table controls are;
          this bar appears solely to name what is currently constraining the
          list, and disappears when nothing is. */}
      {hasActiveFilters && (
        <CustomerFilterBar
          className="mb-3"
          registry={customersRegistry}
          value={value}
          onChange={handleFilterChange}
          resolveOptions={resolveOptions}
          standalone={standalone}
          onRemoveStandalone={removeStandalone}
          onClearAll={clearAllFilters}
          resultCount={rows.length}
          totalCount={pagination?.total}
        />
      )}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(customer) => customer.id}
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
        onRowClick={(customer) => navigate(v2Path(`/customers/${customer.id}`))}
        // The legacy list renders ONE message for both "no customers exist" and
        // "no rows match the filters", and offers no clear-filters affordance.
        // Reproduced as-is: inventing one would be a behaviour change.
        empty={<EmptyState title="No results found." />}
      >
        {(table) => (
          <>
            <DataTableToolbar
              table={table}
              searchValue={searchInput}
              onSearchChange={handleSearchChange}
              searchPlaceholder="Search customers..."
              filters={
                // Standalone control - NOT a registry facet. The label wraps
                // nothing; it is associated by id, which is what keeps the
                // accessible name "Show archived" that the vitest spec queries.
                <Label htmlFor="v2-customers-include-archived" className="flex items-center gap-2 font-normal">
                  <Checkbox
                    id="v2-customers-include-archived"
                    checked={includeArchived}
                    onCheckedChange={(checked) => { setIncludeArchived(checked === true); setPage(1); }}
                  />
                  Show archived
                </Label>
              }
              actions={
                <>
                  <FilterPopover
                    registry={customersRegistry}
                    value={value}
                    onChange={handleFilterChange}
                    resolveOptions={resolveOptions}
                    resolveMax={resolveMax}
                    // The customers registry declares no `status` facet, so
                    // nothing here is painted through it. `lead` is what this
                    // page has always passed by way of importing the leads
                    // module's copy; keeping it makes the move provably neutral.
                    statusDomain="lead"
                  />
                  {canExport && (
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
                          All customers ({stats?.total ?? '...'})
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </>
              }
            />
            {canTag && (
              <BulkBar
                selectedIds={selectedCustomerIds}
                onClear={() => setRowSelection({})}
                canTag={canTag}
              />
            )}
          </>
        )}
      </DataTable>
    </div>
  );
}
