import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ColumnDef, VisibilityState, SortingState, RowSelectionState } from '@tanstack/react-table';
import api from '@/lib/axios';
import type { CustomerKind, CustomerSegment, CustomerPhone } from '@/types/entities';
import { useAuthStore } from '@/stores/auth.store';
import { DataTable } from '@/components/data/data-table';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ContactCell } from '@/components/data/ContactCell';
import { formatExactInstant } from '@/lib/format-date';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  User,
  Users,
  UserPlus,
  ClipboardList,
  Wrench,
  Download,
} from 'lucide-react';
import { cn, formatPhone, getInitials } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { FilterChip } from '@/components/data/filter-chip';
import { startOfMonthDay } from '@/lib/date-range';
import { toast } from '@/components/ui/use-toast';
import { FilterBar } from '@/components/filters/FilterBar';
import { AppliedChips } from '@/components/filters/AppliedChips';
import { useFilterState } from '@/lib/filters/useFilterState';
import { customersRegistry } from '@/lib/filters/registries/customers';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { tagsColumn } from '@/components/data/TagChips';
import { useTagFacetOptions, type Tag } from '@/lib/api/tags';
import { useAppAbility } from '@/contexts/AbilityContext';
import { BulkTagPopover } from '@/components/customers/BulkTagPopover';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';

interface Customer {
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
  // entity-redesign (additive/optional — Phase 8 forms supply these):
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
  tags?: Tag[];
}

interface CustomerStats {
  total: number;
  newThisMonth: number;
  activeLeads: number;
  activeJobs: number;
}

const AD_SOURCE_STYLES: Record<string, string> = {
  Google:         'bg-info-surface text-info-text border-info-border',
  Facebook:       'bg-info-surface text-info-text border-info-border',
  Referral:       'bg-success-surface text-success-text border-success-border',
  Yelp:           'bg-danger-surface text-danger-text border-danger-border',
  Instagram:      'bg-ai-surface text-ai-text border-ai-border',
  'Direct Mail':  'bg-warning-surface text-warning-text border-warning-border',
  'Door Hanger':  'bg-warning-surface text-warning-text border-warning-border',
  Other:          'bg-neutral-surface text-neutral-text border-neutral-border',
};

function getAdSourceStyle(source: string | null | undefined): string {
  if (!source) return '';
  return AD_SOURCE_STYLES[source] ?? 'bg-neutral-surface text-neutral-text border-neutral-border';
}

function customerInitials(c: Pick<Customer, 'first_name' | 'last_name' | 'company_name'>): string {
  const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return getInitials(name || c.company_name);
}

import { DEFAULT_CUSTOMERS_SORTING } from '@/lib/customers/customersSorting';

export const columns: ColumnDef<Customer, unknown>[] = [
  {
    id: 'customer_number',
    accessorKey: 'customer_number',
    header: 'Customer #',
    size: 112,
    meta: { pinned: true, fixed: true, minWidth: 112 },
    cell: ({ row }) => (
      <span className="text-sm tabular-nums text-text-secondary">
        {row.original.customer_number ?? '—'}
      </span>
    ),
  },
  {
    id: 'name',
    // No single Customer field expresses the display name (customerDisplayName falls back to
    // company_name), which is precisely why SRVW-89's sort vocabulary is a map, not accessorKey.
    accessorFn: (c) => customerDisplayName(c),
    header: 'Customer',
    size: 170,
    enableHiding: false,
    meta: { locked: true, pinned: true, growWeight: 1.5, minWidth: 150 },
    cell: ({ row }) => {
      const c = row.original;
      return (
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback
              tone="solid"
              className="text-xs font-semibold"
            >
              {customerInitials(c)}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-text-primary truncate">
            {customerDisplayName(c)}
          </span>
        </div>
      );
    },
  },
  {
    id: 'phone',
    header: 'Phone',
    size: 140,
    enableSorting: false,
    meta: { fixed: true, minWidth: 80 },
    cell: ({ row }) => <ContactCell type="phone" value={row.original.phone} />,
  },
  {
    id: 'email',
    header: 'Email',
    size: 185,
    enableSorting: false,
    meta: { growWeight: 1.5, minWidth: 120 },
    cell: ({ row }) => <ContactCell type="email" value={row.original.email} />,
  },
  {
    id: 'address',
    header: 'Address',
    size: 180,
    enableSorting: false,
    meta: { growWeight: 2, minWidth: 100 },
    cell: ({ row }) => {
      const loc = row.original.service_locations?.[0];
      if (!loc) return null;
      return (
        <span className="text-sm text-text-secondary truncate block">
          {loc.city}, {loc.state} {loc.zip}
        </span>
      );
    },
  },
  {
    id: 'company',
    accessorKey: 'company_name',
    header: 'Company',
    size: 120,
    meta: { fixed: true },
    cell: ({ row }) => (
      <span className="text-sm text-text-secondary">
        {row.original.company_name || null}
      </span>
    ),
  },
  {
    id: 'source',
    header: 'Source',
    size: 140,
    enableSorting: false,
    meta: { fixed: true },
    cell: ({ row }) => {
      const source = row.original.ad_source;
      if (!source) return null;
      return (
        <Badge variant="outline" className={cn(getAdSourceStyle(source))}>
          {source}
        </Badge>
      );
    },
  },
  tagsColumn<Customer>(),
  {
    id: 'leads',
    header: 'Leads',
    size: 74,
    enableSorting: false,
    meta: { fixed: true, minWidth: 50 },
    cell: ({ row }) => (
      <span className="text-sm tabular-nums text-text-primary">{row.original._count.leads}</span>
    ),
  },
  {
    id: 'jobs',
    header: 'Jobs',
    size: 74,
    enableSorting: false,
    meta: { fixed: true, minWidth: 50 },
    cell: ({ row }) => (
      <span className="text-sm tabular-nums text-text-primary">{row.original._count.jobs}</span>
    ),
  },
  {
    id: 'created_at',
    accessorKey: 'created_at',
    header: 'Member Since',
    size: 120,
    meta: { fixed: true, minWidth: 90 },
    cell: ({ row }) => (
      <span className="text-sm text-text-secondary">
        {formatExactInstant(row.original.created_at)}
      </span>
    ),
  },
];

// ─── CSV Export ──────────────────────────────────────────

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
    'Created At': new Date(c.created_at).toLocaleDateString('en-US'),
  };
};

// ─── Page ───────────────────────────────────────────────

export default function CustomersPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  // List-level bulk actions (bulk-tag) - keyed by customer id.

  // Generalized filter registry (Task 17): ad_source, payment_type,
  // tax_exempt, has_leads, has_jobs, leads (# of Leads count range), jobs
  // (# of Jobs count range), created (dateRange) — all URL-driven via
  // `customersRegistry`. Replaces the old page's bespoke `adSources`/
  // `paymentTypes`/`taxExempt`/`dateFrom`/`dateTo` `useState`s for these
  // fields (mirrors Estimates' Task 13 / Invoices' Task 15 wiring).
  const { value, setValue, listParams: filterParams } = useFilterState(customersRegistry);

  // Standalone state — NOT registry facets (see customers.ts registry
  // file's comment for why): open_leads/active_jobs (KPI-tile-only booleans,
  // no dedicated user control), include_archived (a plain "show archived"
  // checkbox), search, pagination, sort, column visibility. has_leads/
  // has_jobs moved INTO the registry as 2-option `multi` facets (mirrors
  // `tax_exempt`) — they're read/written via `value`/`setValue` below.
  const [openLeads, setOpenLeads] = useState(false);
  const [activeJobs, setActiveJobs] = useState(false);
  // Default OFF — list shows ACTIVE customers (backend hides archived unless this is on).
  const [includeArchived, setIncludeArchived] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_CUSTOMERS_SORTING);

  // Stats query (independent of table pagination/filters)
  const { data: stats, isLoading: statsLoading } = useQuery<CustomerStats>({
    queryKey: ['customer-stats'],
    queryFn: async () => {
      const { data } = await api.get('/api/customers/stats');
      return data;
    },
    staleTime: 30_000,
  });

  // SRVW-58 - the org's tag vocabulary for the Tags facet, this registry's FIRST
  // dynamic `optionSource` (resolveOptions was a stable no-op before).
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => (sourceId === 'tags' ? tagFacetOptions : []),
    [tagFacetOptions]
  );
  // No backend "max leads/jobs on any one customer" stat today — 50 is a
  // sensible static ceiling for both (see customers.ts registry's comment
  // on the `leads`/`jobs` facets).
  const resolveMax = useCallback(
    (sourceId: string): number =>
      sourceId === 'customers.maxLeads' || sourceId === 'customers.maxJobs' ? 50 : 0,
    []
  );

  // Any filter change (facet edit, chip removal, "Clear all") snaps back to
  // page 1 — same behavior the old per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const monthStart = useMemo(() => startOfMonthDay(), []);

  // Customers list query
  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve
  // the pre-refactor `listParams` object's key set. `filterParams` (from
  // `useFilterState`) only carries keys for ACTIVE facets, so this baseline
  // fills in the rest; axios drops `undefined`-valued params before sending
  // the request either way. The standalone bits (open_leads/active_jobs/
  // include_archived/search/sort) are layered on top, unaffected by the
  // registry. has_leads/has_jobs are now facet-owned params, supplied by
  // `filterParams` below like every other registry facet.
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

  // A selected id only makes sense against the CURRENT page/sort/filter - mirrors the customers
  // query's own queryKey dependency set exactly (EstimatesPage.tsx does the same).

  const { rowSelection, setRowSelection, selectedIds: selectedCustomerIds } =
    useScopedRowSelection(JSON.stringify([page, pageSize, search, value, openLeads, activeJobs, includeArchived, sortBy, sortDir]));

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleExportCurrentPage = () => {
    const rows: Customer[] = data?.customers ?? [];
    if (!rows.length) return;
    const csv = toCSV(rows.map(toExportRow));
    const date = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `customers-page${page}-${date}.csv`);
  };

  const handleExportAll = async () => {
    try {
      const { data: exportData } = await api.get('/api/customers/export', { params: listParams });
      const rows: Customer[] = exportData.customers ?? [];
      const csv = toCSV(rows.map(toExportRow));
      const date = new Date().toISOString().split('T')[0];
      downloadCSV(csv, `customers-all-${date}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export customers. Please try again.', variant: 'destructive' });
    }
  };

  const clearAllFilters = () => {
    // `setValue({})` full-replaces every registry-owned param (including
    // has_leads/has_jobs, now facets) — no explicit reset needed for them.
    setValue({});
    setOpenLeads(false);
    setActiveJobs(false);
    setIncludeArchived(false);
    setSearch('');
    setPage(1);
  };

  // ─── Clickable KPIs ──────────────────────────────────────
  // Total → show all (clear). New This Month → exact created_after filter.
  // Active Leads / Active Jobs filter the customers table in place (customers
  // with an open lead / active job) and count *customers*, so the tile count
  // matches the filtered row count.
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

  // "No manual filters" = no registry facet set (ad_source/payment_type/tax_exempt/
  // has_leads/has_jobs/leads/jobs) AND no standalone toggle set (open_leads/
  // active_jobs/search) — excludes `created` (checked separately below) and
  // `include_archived` (excluded from KPI-active determination entirely, same as
  // before this task).
  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here
  // too - otherwise a tags-only filter leaves the Total tile lit over a narrowed list.
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
  const activeLeadsKpi =
    openLeads && !activeJobs && noOtherManualFilters && !createdActive;
  const activeJobsKpi =
    activeJobs && !openLeads && noOtherManualFilters && !createdActive;

  const handleTotalKpi = () => {
    if (activeKpi === 'total') return;
    clearAllFilters();
  };
  const handleMonthKpi = () => {
    if (activeKpi === 'month') { handleTotalKpi(); return; }
    // NOTE: does NOT reset include_archived — same asymmetry the pre-Task-17
    // page had (only Total/Active-Leads/Active-Jobs route through
    // `clearAllFilters`, which does reset it; Month sets its fields directly).
    // `setValue` full-replaces every registry-owned param, so this also
    // clears has_leads/has_jobs/ad_source/payment_type/tax_exempt/leads/jobs.
    setValue({ created: { kind: 'dateRange', from: monthStart, to: '' } });
    setSearch('');
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

  const canCreate = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';
  // ONE gate for BOTH export paths — see the identical comment on the LIVE page
  // (`pages/v2/customers/CustomersPage.tsx`, which is what `/customers` routes
  // to). This copy is unrouted, but ~4 test files still import it, so it is kept
  // in lockstep rather than left as a divergent second answer to the same
  // question. Asks the ability, not the role (`canCreate` above is pre-existing
  // and deliberately untouched).
  const canExport = ability.can('export', 'Customer');

  // Whether the applied-filters strip has anything to show — mirrors the old
  // page's `hasActiveFilters` gate (search was never part of it either; the
  // search box is its own toolbar element, not a chip).
  const hasAnyFacetActive = Object.keys(value).length > 0;
  const hasActiveFilters =
    hasAnyFacetActive || openLeads || activeJobs || includeArchived;

  const currentMonth = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <Heading className="flex items-center gap-2"><User className="h-5 w-5 shrink-0 text-primary" />Customers</Heading>

      {/* KPI Summary Strip */}
      <KpiStrip
        loading={statsLoading}
        items={[
          { icon: Users, label: 'Total Customers', value: stats?.total ?? 0, sub: 'All time', tone: 'primary',
            active: activeKpi === 'total', onClick: handleTotalKpi },
          { icon: UserPlus, label: 'New This Month', value: stats?.newThisMonth ?? 0, sub: currentMonth, tone: 'primary',
            active: activeKpi === 'month', onClick: handleMonthKpi },
          { icon: ClipboardList, label: 'Active Leads', value: stats?.activeLeads ?? 0, sub: 'Open leads', tone: 'primary',
            active: activeLeadsKpi, onClick: handleActiveLeadsKpi },
          { icon: Wrench, label: 'Active Jobs', value: stats?.activeJobs ?? 0, sub: 'In progress', tone: 'primary',
            active: activeJobsKpi, onClick: handleActiveJobsKpi },
        ]}
      />

      {/* Bulk-selection toolbar - visible only while at least one row is checked */}
      {selectedCustomerIds.length > 0 && (
        <div className="flex items-center justify-between rounded-card border border-border bg-surface-light px-4 py-2.5 shadow-card">
          <span className="text-sm font-medium text-text-primary">
            {selectedCustomerIds.length} selected
          </span>
          {ability.can('update', 'Customer') && (
            <BulkTagPopover
              customerIds={selectedCustomerIds}
              onDone={() => setRowSelection({})}
            />
          )}
        </div>
      )}

      {/* Table with enhanced toolbar */}
      <DataTable
        tableKey="customers"
        columns={columns}
        data={data?.customers ?? []}
        pagination={data?.pagination}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        getRowId={(customer) => customer.id}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
        searchValue={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search customers..."
        onRowClick={(customer) => navigate(`/customers/${customer.id}`)}
        sorting={sorting}
        onSortingChange={(s) => { setSorting(s); setPage(1); }}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        filters={
          <div className="flex items-center gap-2">
            <FilterBar
              registry={customersRegistry}
              value={value}
              onChange={handleFilterChange}
              resolveOptions={resolveOptions}
              resolveMax={resolveMax}
            />
            {/* Standalone control — NOT a registry facet (see customers.ts
                registry file). has_leads/has_jobs moved INTO the FilterBar
                popover as `multi` facets; "Show archived" is the one
                standalone control left. Checkbox row (label wraps its
                control) - not a FormField-shape site, left raw. */}
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => { setIncludeArchived(e.target.checked); setPage(1); }}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary/20"
              />
              Show archived
            </label>
          </div>
        }
        activeFilters={
          hasActiveFilters ? (
            <div className="flex items-center gap-2 flex-wrap">
              <AppliedChips
                registry={customersRegistry}
                value={value}
                onChange={handleFilterChange}
                resolveOptions={resolveOptions}
              />
              {openLeads && (
                <FilterChip label="Has open leads" onRemove={() => { setOpenLeads(false); setPage(1); }} />
              )}
              {activeJobs && (
                <FilterChip label="Has active jobs" onRemove={() => { setActiveJobs(false); setPage(1); }} />
              )}
              {includeArchived && (
                <FilterChip label="Including archived" onRemove={() => { setIncludeArchived(false); setPage(1); }} />
              )}
              <Button
                variant="ghost" tone="subtle"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={clearAllFilters}
              >
                Clear all
              </Button>
            </div>
          ) : null
        }
        headerActions={
          <div className="flex items-center gap-2">
            {/* Export dropdown */}
            {canExport && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Download className="mr-2 h-4 w-4" />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Export as CSV</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExportCurrentPage}>
                    Current page ({data?.customers?.length ?? 0} rows)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportAll}>
                    All customers ({stats?.total ?? '...'})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Add Customer */}
            {canCreate && (
              <Button variant="solid" tone="business" onClick={() => navigate('/customers/new')}>
                <Plus className="mr-2 h-4 w-4" />
                Add Customer
              </Button>
            )}
          </div>
        }
      />


    </div>
  );
}
