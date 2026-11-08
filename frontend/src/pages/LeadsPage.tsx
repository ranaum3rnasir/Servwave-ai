import { useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ColumnDef, SortingState } from '@tanstack/react-table';
import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useAssignableUsers } from '@/lib/api/users';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { KpiStrip } from '@/components/data/KpiStrip';
import { Badge } from '@/components/ui/badge';
import { ContactCell } from '@/components/data/ContactCell';
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
  ClipboardList,
  Sparkles,
  UserX,
  Trophy,
  XCircle,
  Download,
  Filter,
} from 'lucide-react';
import { formatPhone } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { startOfWeekDay } from '@/lib/date-range';
import { toast } from '@/components/ui/use-toast';
import { FilterBar } from '@/components/filters/FilterBar';
import { AppliedChips } from '@/components/filters/AppliedChips';
import { useFilterState } from '@/lib/filters/useFilterState';
import { leadsRegistry } from '@/lib/filters/registries/leads';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { tagsColumn } from '@/components/data/TagChips';
import { useTagFacetOptions, type Tag } from '@/lib/api/tags';

interface Lead {
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
  // entity-redesign (additive/optional — Phase 8 wires the service-location picker):
  service_location_id?: string | null;
  created_at: string;
  customer: { id: string; first_name: string; last_name: string; company_name?: string | null; phone: string; customer_number?: string | null; ad_source?: string | null; service_locations?: { city: string; state: string }[] };
  // Lead owner (SINGLE) + the M2M owner-mirror row. Walkthrough performers are MULTI.
  commission_owner?: { id: string; first_name: string; last_name: string } | null;
  lead_assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  estimates?: { id: string; total_amount: number }[];
  tags?: Tag[];
}

interface LeadStats {
  total: number;
  new_this_week: number;
  unassigned: number;
  won: number;
  lost: number;
}

// The lead status vocabulary lives in `@/lib/filters/registries/leads`
// (LEAD_STATUSES) and its appearance lives in the status registry
// (STATUS_REGISTRY.lead). This page renders status only through
// <StatusBadge domain="lead"> and filters only through `leadsRegistry`, so it
// holds no local copy of either.
//
// ONE EXCEPTION, and it is a documented survivor: `getWalkthroughDisplay` below
// reads `lead.status === 'NEW'` to pick a text colour. It is the list-view twin
// of LeadDetailPage's WalkthroughDot - a walkthrough-progress indicator derived
// from two timestamps plus one status value, not a status badge - so it is not
// resolvable through a per-status registry entry. Left in place deliberately;
// see the survivors table in the work package.
const ACTIVE_STATUSES = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'];

// Walkthrough-as-entity redesign, PR-D2: walkthrough_needed is deleted (Ran's call - no
// dismiss/opt-out escape hatch was built). The chip now degrades to just the two states the
// Walkthrough relation itself carries - a current visit (done/scheduled) or "needs scheduling" -
// with the pre-existing NEW-status exception above left untouched.
function getWalkthroughDisplay(lead: Lead) {
  if (lead.walkthrough_completed_at) return { text: '\u2713 Done', className: 'text-success-text font-medium' };
  if (lead.walkthrough_scheduled_at) return { text: new Date(lead.walkthrough_scheduled_at).toLocaleDateString('en-US'), className: 'text-primary' };
  if (lead.status === 'NEW') return { text: '\u2014', className: 'text-text-secondary' };
  return { text: 'Needs Sched.', className: 'text-warning-text font-medium' };
}

export const columns: ColumnDef<Lead, unknown>[] = [
  {
    id: 'lead_number',
    accessorKey: 'lead_number',
    header: 'Lead #',
    size: 90,
    meta: { pinned: true, fixed: true, minWidth: 80 },
    cell: ({ row }) => (
      <span className="font-mono text-xs text-text-secondary">
        {row.original.lead_number}
      </span>
    ),
  },
  {
    id: 'customer',
    header: 'Customer',
    size: 170,
    enableHiding: false,
    enableSorting: false,
    meta: { locked: true, pinned: true, growWeight: 1.5, minWidth: 140 },
    cell: ({ row }) => {
      const c = row.original.customer;
      return (
        <div>
          {c?.id ? (
            <Link
              to={`/customers/${c.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-primary hover:underline truncate block"
            >
              {customerDisplayName(c)}
            </Link>
          ) : (
            <span className="font-medium text-text-primary truncate block">
              {customerDisplayName(c)}
            </span>
          )}
          {c?.customer_number && (
            <span className="font-mono text-xs text-text-secondary">{c.customer_number}</span>
          )}
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
    cell: ({ row }) => <ContactCell type="phone" value={row.original.customer.phone} />,
  },
  {
    id: 'source',
    accessorKey: 'job_source',
    header: 'Source',
    size: 120,
    enableSorting: false,
    meta: { fixed: true, minWidth: 80 },
    cell: ({ row }) =>
      row.original.customer.ad_source ? (
        <Badge variant="outline">
          {row.original.customer.ad_source}
        </Badge>
      ) : (
        <span className="text-text-secondary">—</span>
      ),
  },
  {
    id: 'service_request',
    accessorKey: 'service_request',
    header: 'Service Request',
    size: 200,
    enableSorting: false,
    meta: { growWeight: 2, minWidth: 100 },
    cell: ({ row }) => (
      <span className="text-text-secondary truncate block" title={row.original.service_request}>
        {row.original.service_request}
      </span>
    ),
  },
  {
    id: 'location',
    accessorKey: 'service_city',
    header: 'Location',
    size: 140,
    enableSorting: false,
    meta: { growWeight: 1.5, minWidth: 80 },
    cell: ({ row }) => {
      const { service_city, service_state, customer } = row.original;
      const city = service_city || customer.service_locations?.[0]?.city;
      const state = service_state || customer.service_locations?.[0]?.state;
      if (!city && !state) return <span className="text-text-secondary">—</span>;
      return (
        <span className="text-text-secondary text-sm">
          {[city, state].filter(Boolean).join(', ')}
        </span>
      );
    },
  },
  {
    id: 'type',
    accessorKey: 'job_type',
    header: 'Type',
    size: 100,
    enableSorting: false,
    meta: { fixed: true },
    cell: ({ row }) =>
      row.original.job_type ? (
        <Badge variant="outline">
          {row.original.job_type}
        </Badge>
      ) : (
        <span className="text-text-secondary">—</span>
      ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    meta: { fixed: true },
    cell: ({ row }) => <StatusBadge domain="lead" status={row.original.status} neutral />,
  },
  {
    id: 'estimates',
    accessorKey: 'estimates',
    header: 'Est.',
    size: 64,
    enableSorting: false,
    meta: { fixed: true, minWidth: 50 },
    cell: ({ row }) => {
      const estimates = row.original.estimates ?? [];
      return (
        <span className={`tabular-nums ${estimates.length === 0 ? 'text-text-secondary' : 'font-medium'}`}>
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
    enableSorting: false,
    meta: { fixed: true },
    cell: ({ row }) =>
      row.original.commission_owner ? (
        <span>
          {row.original.commission_owner.first_name} {row.original.commission_owner.last_name}
        </span>
      ) : (
        <span className="text-text-secondary">Unassigned</span>
      ),
  },
  {
    id: 'walkthrough',
    accessorKey: 'walkthrough_scheduled_at',
    header: 'Walkthrough',
    size: 120,
    enableSorting: false,
    meta: { fixed: true },
    cell: ({ row }) => {
      const display = getWalkthroughDisplay(row.original);
      return <span className={display.className}>{display.text}</span>;
    },
  },
  tagsColumn<Lead>(),
  {
    id: 'created',
    accessorKey: 'created_at',
    header: 'Created',
    size: 110,
    meta: { fixed: true, minWidth: 90 },
    cell: ({ row }) => (
      <span className="text-text-secondary text-sm">
        {formatExactInstant(row.original.created_at)}
      </span>
    ),
  },
];

export default function LeadsPage() {
  const { data: org } = useOrganization();
  const navigate = useNavigate();
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);

  // Generalized filter registry (Task 9): status, ad_source, job_type,
  // assigned_to, walkthrough_status, estimates (countRange), created
  // (dateRange) — all URL-driven via `leadsRegistry`. See resolveOptions/
  // resolveMax below for how each facet's dynamic options/ceiling resolve.
  const { value, setValue, listParams: filterParams } = useFilterState(leadsRegistry);

  // Any filter change (facet edit, chip removal, "Clear all", KPI click)
  // snaps back to page 1 — same behavior the old per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  // Assignable users for the Assigned To filter (the old /api/leads/assignees
  // endpoint was removed in the scheduler redesign) — the shared hook, not an
  // inline query. Unioned with anyone actually referenced on a lead so a
  // genuinely-assigned user is never dropped from the filter (completeness fix).
  // DEAD v1 twin - kept in step with pages/v2/leads/LeadsPage. Not invested in.
  const { data: assigneesData } = useAssignableUsers({ purpose: 'directory', includeReferencedIn: 'leads' });

  // Resolved option lists for the registry's dynamic `optionSource` facets.
  // Memoized on the underlying query/org data (not re-derived into a fresh
  // array identity every render) per the registry-stability contract.
  const sourceOptions = useMemo<FacetOption[]>(
    () => (org?.source_options ?? []).map((s) => ({ value: s, label: s })),
    [org?.source_options]
  );
  const jobTypeOptions = useMemo<FacetOption[]>(
    () => (org?.job_type_options ?? []).map((t) => ({ value: t, label: t })),
    [org?.job_type_options]
  );
  const assignedToOptions = useMemo<FacetOption[]>(
    () => [
      { value: 'UNASSIGNED', label: 'Unassigned' },
      ...(assigneesData ?? []).map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}`.trim() })),
    ],
    [assigneesData]
  );
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'org.sourceOptions') return sourceOptions;
      if (sourceId === 'org.jobTypeOptions') return jobTypeOptions;
      if (sourceId === 'assignableUsers') return assignedToOptions;
      if (sourceId === 'tags') return tagFacetOptions;
      return [];
    },
    [sourceOptions, jobTypeOptions, assignedToOptions, tagFacetOptions]
  );
  // No backend field for "max estimates on any one lead" today — 20 is a
  // static ceiling (see leads.ts registry comment); could become data-driven
  // later.
  const resolveMax = useCallback((sourceId: string): number => (sourceId === 'leads.maxEstimates' ? 20 : 0), []);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet param preserve the
  // pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present —
  // even if `undefined` — on an unfiltered mount). `filterParams` (from
  // `useFilterState`) only carries keys for ACTIVE facets, so this baseline
  // fills in the rest; axios drops `undefined`-valued params before sending
  // the request either way, so actual wire behavior is unchanged.
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

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const clearAllFilters = () => {
    setValue({});
    setSearch('');
    setPage(1);
  };

  // ─── Clickable KPIs ──────────────────────────────────────
  // Each KPI maps to a real, user-reproducible filter (status + date + assignee),
  // expressed as a `FilterState` preset rather than bespoke setters.
  const weekStart = useMemo(() => startOfWeekDay(), []);

  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const assignedValues = value.assigned_to?.kind === 'multi' ? value.assigned_to.values : [];
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];
  // No source/type/walkthrough/tags filter manually applied, and no active search -
  // same "noManual" gate the pre-refactor page used to decide a KPI is active.
  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here too.
  // Without the `tagValues` term a tags-only filter leaves `activeKpi` resolving to
  // 'total', which renders the Total tile active over a narrowed list - and clicking
  // that falsely-active tile takes handleKpiClick's toggle-off branch into
  // clearAllFilters(), silently dropping the tag filter.
  const noManual =
    (value.ad_source?.kind !== 'multi' || value.ad_source.values.length === 0) &&
    (value.job_type?.kind !== 'multi' || value.job_type.values.length === 0) &&
    (value.walkthrough_status?.kind !== 'multi' || value.walkthrough_status.values.length === 0) &&
    tagValues.length === 0 &&
    !search;

  const activeKpi: string | null =
    (statusValues.length === 0 && createdValue?.from === weekStart && !createdValue?.to && assignedValues.length === 0 && noManual) ? 'new_this_week' :
    (statusValues.length === 1 && statusValues[0] === 'WON' && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'won' :
    (statusValues.length === 1 && statusValues[0] === 'LOST' && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'lost' :
    (assignedValues.length === 1 && assignedValues[0] === 'UNASSIGNED' && statusValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'unassigned' :
    (statusValues.length === 0 && assignedValues.length === 0 && !createdValue?.from && !createdValue?.to && noManual) ? 'total' :
    null;

  const applyKpi = (preset: string) => {
    setSearch('');
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
    if (activeKpi === preset) { clearAllFilters(); return; }       // toggle off → default view
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
    'Status': l.status,
    'Estimates': (l.estimates ?? []).length,
    'Est. Value': (l.estimates ?? []).reduce((sum, e) => sum + Number(e.total_amount), 0),
    'Assigned To': l.commission_owner ? `${l.commission_owner.first_name} ${l.commission_owner.last_name}` : 'Unassigned',
    'Created': new Date(l.created_at).toLocaleDateString('en-US'),
  });

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (rows: Lead[], filename: string) => {
    if (!rows.length) {
      toast({ title: 'Nothing to export', description: 'No leads match the current filters.' });
      return;
    }
    downloadCSV(toCSV(rows.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => {
    try {
      exportRows(data?.leads ?? [], `leads-page${page}-${today()}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export leads. Please try again.', variant: 'destructive' });
    }
  };
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/leads/export', { params: listParams });
      exportRows(ex.leads ?? [], `leads-all-${today()}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export leads. Please try again.', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <Heading className="flex items-center gap-2"><Filter className="h-5 w-5 shrink-0 text-primary" />Leads</Heading>

      {/* KPI Summary Strip */}
      <KpiStrip
        loading={isLoading}
        items={[
          { icon: ClipboardList, label: 'Total Leads', value: stats?.total ?? 0, sub: 'All time', tone: 'primary',
            active: activeKpi === 'total', onClick: () => handleKpiClick('total') },
          { icon: Sparkles, label: 'New This Week', value: stats?.new_this_week ?? 0, sub: 'This week', tone: 'primary',
            active: activeKpi === 'new_this_week', onClick: () => handleKpiClick('new_this_week') },
          { icon: UserX, label: 'Unassigned', value: stats?.unassigned ?? 0, sub: 'Needs attention', tone: 'warning', emphasize: (stats?.unassigned ?? 0) > 0,
            active: activeKpi === 'unassigned', onClick: () => handleKpiClick('unassigned') },
          { icon: Trophy, label: 'Won', value: stats?.won ?? 0, sub: 'All time', tone: 'success',
            active: activeKpi === 'won', onClick: () => handleKpiClick('won') },
          { icon: XCircle, label: 'Lost', value: stats?.lost ?? 0, sub: 'All time', tone: 'danger',
            active: activeKpi === 'lost', onClick: () => handleKpiClick('lost') },
        ]}
      />

      {/* Table */}
      <DataTable
        tableKey="leads"
        columns={columns}
        data={data?.leads ?? []}
        pagination={data?.pagination}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
        searchValue={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search leads..."
        sorting={sorting}
        onSortingChange={(s) => { setSorting(s); setPage(1); }}
        onRowClick={(lead) => navigate(`/leads/${lead.id}`)}
        filters={
          <FilterBar
            registry={leadsRegistry}
            value={value}
            onChange={handleFilterChange}
            resolveOptions={resolveOptions}
            resolveMax={resolveMax}
          />
        }
        activeFilters={
          <AppliedChips
            registry={leadsRegistry}
            value={value}
            onChange={handleFilterChange}
            resolveOptions={resolveOptions}
          />
        }
        headerActions={
          <div className="flex items-center gap-2">
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
                  Current page ({data?.leads?.length ?? 0} rows)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportAll}>
                  All ({data?.pagination?.total ?? '...'})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {ability.can('create', 'Lead') && (
              <Button variant="solid" tone="business" onClick={() => navigate('/leads/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Lead
              </Button>
            )}
          </div>
        }
      />
    </div>
  );
}
