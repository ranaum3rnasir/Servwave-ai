import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ColumnDef, SortingState, RowSelectionState } from '@tanstack/react-table';
import api from '@/lib/axios';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { KpiStrip } from '@/components/data/KpiStrip';
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
  FilePen,
  Send,
  CheckCircle2,
  XCircle,
  Ban,
  Download,
  Clock,
  FileText,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { NewEstimateDialog } from '@/components/estimates/NewEstimateDialog';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { toast } from '@/components/ui/use-toast';
import { FilterBar } from '@/components/filters/FilterBar';
import { AppliedChips } from '@/components/filters/AppliedChips';
import { useFilterState } from '@/lib/filters/useFilterState';
import { estimatesRegistry, MONTHLY_ESTIMATE_STATUSES } from '@/lib/filters/registries/estimates';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { tagsColumn } from '@/components/data/TagChips';
import { useTagFacetOptions, type Tag } from '@/lib/api/tags';
import { useAppAbility } from '@/contexts/AbilityContext';
import { summariseBulkResult } from '@/lib/bulk-result';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { useConfirm } from '@/hooks/useConfirm';

interface Deposit {
  id: string;
  status: string;
  amount: number;
  payment_method: string | null;
}

interface Estimate {
  id: string;
  estimate_number: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  // SERV10X-61 - a customer-anchored estimate has NO lead, so `lead` is nullable and the customer
  // is resolved from the direct `customer` instead. Both are returned by estimateListSelect. This
  // type previously declared `lead` (and its `customer`) as non-nullable, which is why tsc could
  // not catch the unguarded `e.lead.customer` in the CSV export below.
  lead: {
    id: string;
    customer: { id: string; first_name: string; last_name: string; company_name?: string | null; customer_number?: string | null };
  } | null;
  customer: { id: string; first_name: string; last_name: string; company_name?: string | null; customer_number?: string | null } | null;
  creator: { id: string; first_name: string; last_name: string };
  deposit?: Deposit | null;
  tags?: Tag[];
}

interface StatusStat { count: number; value: number; }
interface DepositsStat { count: number; total: number; }

interface EstimateStats {
  draft: StatusStat;
  sent: StatusStat;
  pending: StatusStat;
  won: StatusStat;
  declined: StatusStat;
  archived: StatusStat;
  pending_deposits?: DepositsStat;
}

interface Creator {
  id: string;
  first_name: string;
  last_name: string;
}

export const columns: ColumnDef<Estimate, unknown>[] = [
  {
    id: 'estimate_number',
    accessorKey: 'estimate_number',
    header: 'Estimate #',
    size: 110,
    meta: { pinned: true, fixed: true, minWidth: 90 },
    cell: ({ row }) => (
      <span className="font-mono text-xs text-text-secondary">{row.original.estimate_number}</span>
    ),
  },
  {
    id: 'customer',
    header: 'Customer',
    size: 200,
    enableHiding: false,
    enableSorting: false,
    meta: { locked: true, pinned: true, growWeight: 2, minWidth: 140 },
    cell: ({ row }) => {
      // Lead-anchored rows resolve through the lead; a customer-anchored one has no lead and
      // resolves from the direct customer. Without the fallback every lead-less estimate showed
      // an em dash here even though the API returns its customer.
      const c = row.original.lead?.customer ?? row.original.customer;
      if (!c) return <span className="text-text-secondary">—</span>;
      return (
        <div>
          <span className="font-medium text-text-primary truncate block">
            {customerDisplayName(c)}
          </span>
          {c.customer_number && (
            <span className="font-mono text-xs text-text-secondary">{c.customer_number}</span>
          )}
        </div>
      );
    },
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    meta: { fixed: true },
    cell: ({ row }) => <StatusBadge domain="estimate" status={row.original.status} />,
  },
  {
    id: 'deposit',
    accessorKey: 'deposit',
    header: 'Deposit',
    size: 110,
    enableSorting: false,
    meta: { fixed: true },
    cell: ({ row }) => {
      const deposit = row.original.deposit;
      if (!deposit) return null;
      return <StatusBadge domain="deposit" status={deposit.status} />;
    },
  },
  {
    id: 'total',
    accessorKey: 'total_amount',
    header: 'Total',
    size: 110,
    meta: { fixed: true, minWidth: 80 },
    cell: ({ row }) => (
      <span className="font-medium tabular-nums">{formatCurrency(Number(row.original.total_amount))}</span>
    ),
  },
  {
    id: 'created_by',
    accessorKey: 'creator',
    header: 'Created By',
    size: 160,
    enableSorting: false,
    meta: { growWeight: 1, minWidth: 80 },
    cell: ({ row }) => (
      <span>{row.original.creator.first_name} {row.original.creator.last_name}</span>
    ),
  },
  tagsColumn<Estimate>(),
  {
    id: 'date',
    accessorKey: 'created_at',
    header: 'Date',
    size: 110,
    meta: { fixed: true, minWidth: 90 },
    cell: ({ row }) => (
      <span className="tabular-nums">{formatExactInstant(row.original.created_at)}</span>
    ),
  },
];

export default function EstimatesPage() {
  const { confirm, confirmDialog } = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  // List-level bulk actions (bulk-delete DRAFT estimates) — keyed by estimate id.

  // Generalized filter registry (Task 13): status, created_by, deposit_status,
  // total (range, money), created (dateRange) — all URL-driven via
  // `estimatesRegistry`. Mirrors Jobs' Task 11 wiring (`useFilterState`
  // replaces the old page's five bespoke `useState`s for these fields).
  const { value, setValue, listParams: filterParams } = useFilterState(estimatesRegistry);

  // Standalone state — NOT registry facets (see estimatesRegistry.ts's
  // file-level comment for why): search, pagination, sort.
  const [sorting, setSorting] = useState<SortingState>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [preSelectedCustomerId, setPreSelectedCustomerId] = useState<string | undefined>();

  // Auto-open dialog when returning from lead/customer creation or quick-create
  useEffect(() => {
    const newCustomerId = searchParams.get('newCustomerId');
    const action = searchParams.get('action');
    if (newCustomerId) {
      setPreSelectedCustomerId(newCustomerId);
      setShowNewDialog(true);
      searchParams.delete('newCustomerId');
      setSearchParams(searchParams, { replace: true });
    } else if (action === 'new-estimate') {
      setShowNewDialog(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Fetch creators for the Created By filter
  const { data: creatorsData } = useQuery({
    queryKey: ['estimate-creators'],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates/creators');
      return data.users as Creator[];
    },
  });
  const creators = creatorsData ?? [];

  // Resolved option list for the registry's `created_by` `optionSource`.
  // Memoized on the underlying query data (stable react-query reference) per
  // the registry-stability contract (see jobs.ts's `assignedToOptions`).
  const creatorOptions = useMemo<FacetOption[]>(
    () => creators.map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}`.trim() })),
    [creators]
  );
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'assignableUsers') return creatorOptions;
      if (sourceId === 'tags') return tagFacetOptions;
      return [];
    },
    [creatorOptions, tagFacetOptions]
  );
  // No backend "max total across all estimates" stat today — 100000 is a
  // sensible static money ceiling (see estimatesRegistry.ts's comment on the
  // `total` facet's `maxSource`). This is the first production `money: true`
  // RangeFacet.
  const resolveMax = useCallback(
    (sourceId: string): number => (sourceId === 'estimates.maxTotal' ? 100000 : 0),
    []
  );

  // Any filter change (facet edit, chip removal, "Clear all") snaps back to
  // page 1 — same behavior the old per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve
  // the pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present —
  // even if `undefined` — on an unfiltered mount). `filterParams` (from
  // `useFilterState`) only carries keys for ACTIVE facets, so this baseline
  // fills in the rest; axios drops `undefined`-valued params before sending
  // the request either way. `total_min`/`total_max` REPLACE the old
  // `min_total`/`max_total` param names (Task 12's backend registry reads
  // `total_min`/`total_max` — no existing test asserted the old names).
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    created_by: undefined as string | undefined,
    deposit_status: undefined as string | undefined,
    total_min: undefined as string | undefined,
    total_max: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['estimates', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });

  const stats: EstimateStats | undefined = data?.stats;

  // A selected id only makes sense against the CURRENT page/sort/filter — once any of the
  // estimates query's own params change, drop the selection instead of carrying stale ids
  // (or a now-invisible row) forward. Mirrors the useQuery's own queryKey dependency set exactly.

  const { rowSelection, setRowSelection, selectedIds: selectedEstimateIds } =
    useScopedRowSelection(JSON.stringify([page, pageSize, search, sortBy, sortDir, value]));

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/estimates/bulk-delete', { ids });
      return data as { deleted: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      setRowSelection({});
      const { title, description } = summariseBulkResult({
        okCount: result.deleted.length,
        failed: result.failed,
        noun: 'estimate',
        nounPlural: 'estimates',
        verbPast: 'deleted',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Delete failed', description: 'Failed to delete estimates. Please try again.', variant: 'destructive' });
    },
  });

  const handleBulkDelete = async () => {
    const count = selectedEstimateIds.length;
    if (count === 0) return;
    const confirmed = await confirm({
      title: `Delete ${count} draft estimate${count === 1 ? '' : 's'}?`,
      description: 'This cannot be undone.',
      // Not plain 'Delete': the toolbar button that opens this is also 'Delete', and two
      // identically-named buttons on screen is ambiguous for users and for tests alike.
      confirmLabel: `Delete estimate${count === 1 ? '' : 's'}`,
      tone: 'danger',
    });
    if (!confirmed) return;
    bulkDeleteMutation.mutate(selectedEstimateIds);
  };

  const bulkStatusMutation = useMutation({
    mutationFn: async ({ ids, transition }: { ids: string[]; transition: 'backtodraft' | 'backtosent' }) => {
      const { data } = await api.post('/api/estimates/bulk-status', { ids, transition });
      return data as { updated: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      setRowSelection({});
      const { title, description } = summariseBulkResult({
        okCount: result.updated.length,
        failed: result.failed,
        noun: 'estimate',
        nounPlural: 'estimates',
        verbPast: 'updated',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Update failed', description: 'Failed to update estimate status. Please try again.', variant: 'destructive' });
    },
  });

  // "Back to draft" nulls the customer's signature/consent + public link (setStatusInternal) -
  // irreversible, across up to 100 rows, from one click. The sibling Delete button in this same
  // toolbar already confirms; this is at least as destructive and must too.
  const handleBulkBackToDraft = async () => {
    const count = selectedEstimateIds.length;
    if (count === 0) return;
    const confirmed = await confirm({
      title: `Recall ${count} estimate${count === 1 ? '' : 's'} to draft?`,
      description:
        "This invalidates the customer's existing link and clears any signature. This cannot be undone.",
      confirmLabel: 'Recall to draft',
      tone: 'danger',
    });
    if (!confirmed) return;
    bulkStatusMutation.mutate({ ids: selectedEstimateIds, transition: 'backtodraft' });
  };

  const handleBulkBackToSent = () => {
    if (selectedEstimateIds.length === 0) return;
    bulkStatusMutation.mutate({ ids: selectedEstimateIds, transition: 'backtosent' });
  };

  const bulkSendReminderMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/estimates/bulk-send-reminder', { ids });
      return data as { sent: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      setRowSelection({});
      const { title, description } = summariseBulkResult({
        okCount: result.sent.length,
        failed: result.failed,
        noun: 'estimate',
        nounPlural: 'estimates',
        verbPast: 'sent',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Send failed', description: 'Failed to send estimate reminders. Please try again.', variant: 'destructive' });
    },
  });

  const handleBulkSendReminder = () => {
    if (selectedEstimateIds.length === 0 || selectedEstimateIds.length > 25) return;
    bulkSendReminderMutation.mutate(selectedEstimateIds);
  };

  const bulkSendOverCap = selectedEstimateIds.length > 25;

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const clearAllFilters = () => {
    setValue({});
    setSearch('');
    setPage(1);
  };

  // ─── Clickable status KPIs ───────────────────────────────
  // Monthly tiles (Draft/Sent/Approved/Declined/Cancelled) map to estimates
  // CREATED this month → clicking sets status=[X] AND the Created range to the
  // full current month, so the listed rows match the tile's monthly count.
  // Pending is all-time (status only, no date). Clicking the active tile clears.
  const monthStart = useMemo(() => startOfMonthDay(), []);
  const monthEnd = useMemo(() => endOfMonthDay(), []);

  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const createdByValues = value.created_by?.kind === 'multi' ? value.created_by.values : [];
  const depositValues = value.deposit_status?.kind === 'multi' ? value.deposit_status.values : [];
  const totalValue = value.total?.kind === 'range' ? value.total : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;

  const totalActive = Boolean(totalValue && (totalValue.from != null || totalValue.to != null));
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  // A status tile is active only when it is the sole filter applied and, for
  // monthly tiles, the Created range is exactly the current month — the old
  // page's `onlyStatusFilter`/`isMonthRange`/`noDateRange` logic verbatim,
  // generalized to read from `value` instead of bespoke `useState`s.
  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here
  // too - otherwise a status-plus-tags filter leaves the status tile lit over a list
  // narrowed further than its count implies, and a repeat click routes into
  // clearAllFilters() and drops the tag filter.
  const otherFiltersActive =
    createdByValues.length > 0 ||
    depositValues.length > 0 ||
    tagValues.length > 0 ||
    totalActive ||
    Boolean(search);

  const noCreatedRange = !createdValue?.from && !createdValue?.to;
  const isMonthRange = createdValue?.from === monthStart && createdValue?.to === monthEnd;
  const soleStatus = statusValues.length === 1 ? statusValues[0] : null;

  const activeStatusKpi =
    soleStatus && !otherFiltersActive
      ? MONTHLY_ESTIMATE_STATUSES.includes(soleStatus)
        ? (isMonthRange ? soleStatus : null)
        : (noCreatedRange ? soleStatus : null)
      : null;

  const handleStatusKpi = (status: string) => {
    if (activeStatusKpi === status) { clearAllFilters(); return; }
    setSearch('');
    setPage(1);
    if (MONTHLY_ESTIMATE_STATUSES.includes(status)) {
      setValue({
        status: { kind: 'multi', values: [status] },
        created: { kind: 'dateRange', from: monthStart, to: monthEnd },
      });
    } else {
      setValue({ status: { kind: 'multi', values: [status] } });
    }
  };

  // Pending Deposits tile: active exactly when deposit_status=[REQUESTED] is
  // the selected value — mirrors the pre-refactor page's naive
  // `depositStatus === 'REQUESTED'` check verbatim. Unlike the status tiles,
  // toggling this OFF only clears `deposit_status` (it does not also require
  // "no other facet active" to show itself as active, and does not reset any
  // other facet on toggle-off) — same asymmetry the old page had.
  const activeDepositKpi = depositValues.length === 1 && depositValues[0] === 'REQUESTED';

  const handleDepositKpi = () => {
    if (activeDepositKpi) {
      const next = { ...value };
      delete next.deposit_status;
      setValue(next);
      setPage(1);
      return;
    }
    // Mirror the fields handleStatusKpi clears so the deposit KPI is exclusive.
    setSearch('');
    setPage(1);
    setValue({ deposit_status: { kind: 'multi', values: ['REQUESTED'] } });
  };

  // Whether the applied-filters strip has anything to show — mirrors the old
  // page's `hasActiveFilters` gate (search was never part of it either; the
  // search box is its own toolbar element, not a chip).
  const hasAnyFacetActive = Object.keys(value).length > 0;

  const toExportRow = (e: Estimate) => {
    // Same anchor fallback as the Customer column. This was an UNGUARDED `e.lead.customer`, so
    // exporting any list containing a customer-anchored estimate threw before it wrote a row.
    const c = e.lead?.customer ?? e.customer;
    return {
      'Estimate #': e.estimate_number,
      'Customer': customerDisplayName(c, ''),
      'Company': c?.company_name ?? '',
      'Status': e.status,
      'Total': Number(e.total_amount),
      'Created By': `${e.creator.first_name} ${e.creator.last_name}`,
      'Date': new Date(e.created_at).toLocaleDateString('en-US'),
    };
  };

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (rows: Estimate[], filename: string) => {
    if (!rows.length) return;
    downloadCSV(toCSV(rows.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => exportRows(data?.estimates ?? [], `estimates-page${page}-${today()}.csv`);
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/estimates/export', { params: listParams });
      exportRows(ex.estimates ?? [], `estimates-all-${today()}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export estimates. Please try again.', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <Heading className="flex items-center gap-2"><FileText className="h-5 w-5 shrink-0 text-primary" />Estimates</Heading>

      {/* KPI Summary Strip */}
      <KpiStrip
        loading={isLoading}
        items={[
          { icon: FilePen, label: 'Draft', value: stats?.draft?.count ?? 0, sub: `${formatCurrency(Number(stats?.draft?.value ?? 0))} this month`, tone: 'neutral', active: activeStatusKpi === 'DRAFT', onClick: () => handleStatusKpi('DRAFT') },
          { icon: Send, label: 'Sent', value: stats?.sent?.count ?? 0, sub: `${formatCurrency(Number(stats?.sent?.value ?? 0))} this month`, tone: 'primary', active: activeStatusKpi === 'SENT', onClick: () => handleStatusKpi('SENT') },
          { icon: Clock, label: 'Pending', value: stats?.pending?.count ?? 0, sub: formatCurrency(Number(stats?.pending?.value ?? 0)), tone: 'warning', active: activeStatusKpi === 'PENDING', onClick: () => handleStatusKpi('PENDING') },
          { icon: CheckCircle2, label: 'Won', value: stats?.won?.count ?? 0, sub: `${formatCurrency(Number(stats?.won?.value ?? 0))} this month`, tone: 'success', active: activeStatusKpi === ESTIMATE_STATUS.WON, onClick: () => handleStatusKpi(ESTIMATE_STATUS.WON) },
          { icon: XCircle, label: 'Declined', value: stats?.declined?.count ?? 0, sub: `${formatCurrency(Number(stats?.declined?.value ?? 0))} this month`, tone: 'danger', active: activeStatusKpi === 'DECLINED', onClick: () => handleStatusKpi('DECLINED') },
          { icon: Ban, label: 'Archived', value: stats?.archived?.count ?? 0, sub: `${formatCurrency(Number(stats?.archived?.value ?? 0))} this month`, tone: 'neutral', active: activeStatusKpi === ESTIMATE_STATUS.ARCHIVED, onClick: () => handleStatusKpi(ESTIMATE_STATUS.ARCHIVED) },
          {
            icon: Clock,
            label: 'Pending Deposits',
            value: formatCurrency(Number(stats?.pending_deposits?.total ?? 0)),
            sub: `(${stats?.pending_deposits?.count ?? 0})`,
            tone: 'warning',
            emphasize: true,
            active: activeDepositKpi,
            onClick: handleDepositKpi,
          },
        ]}
      />

      {/* Bulk-selection toolbar — visible only while at least one row is checked */}
      {selectedEstimateIds.length > 0 && (
        <div className="flex items-center justify-between rounded-card border border-border bg-surface-light px-4 py-2.5 shadow-card">
          <span className="text-sm font-medium text-text-primary">
            {selectedEstimateIds.length} selected
          </span>
          <div className="flex items-center gap-2">
            {ability.can('update', 'Estimate') && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkBackToDraft}
                  disabled={bulkStatusMutation.isPending}
                >
                  Back to draft
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkBackToSent}
                  disabled={bulkStatusMutation.isPending}
                >
                  Back to sent
                </Button>
              </>
            )}
            {ability.can('send', 'Estimate') && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkSendReminder}
                disabled={bulkSendReminderMutation.isPending || bulkSendOverCap}
                title={bulkSendOverCap ? 'Select 25 or fewer estimates to send a reminder' : undefined}
              >
                {bulkSendReminderMutation.isPending ? 'Sending...' : 'Send reminder'}
              </Button>
            )}
            {ability.can('delete', 'Estimate') && (
              <Button
                variant="solid" tone="danger"
                size="sm"
                onClick={handleBulkDelete}
                disabled={bulkDeleteMutation.isPending}
              >
                {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <DataTable
        tableKey="estimates"
        columns={columns}
        data={data?.estimates ?? []}
        pagination={data?.pagination}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        getRowId={(estimate) => estimate.id}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
        searchValue={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search estimates..."
        sorting={sorting}
        onSortingChange={(s) => { setSorting(s); setPage(1); }}
        onRowClick={(estimate) => navigate(`/estimates/${estimate.id}`)}
        filters={
          <FilterBar
            registry={estimatesRegistry}
            value={value}
            onChange={handleFilterChange}
            resolveOptions={resolveOptions}
            resolveMax={resolveMax}
          />
        }
        activeFilters={
          hasAnyFacetActive ? (
            <div className="flex items-center gap-2 flex-wrap">
              <AppliedChips
                registry={estimatesRegistry}
                value={value}
                onChange={handleFilterChange}
                resolveOptions={resolveOptions}
              />
              <Button
                variant="ghost"
                tone="subtle"
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
                  Current page ({data?.estimates?.length ?? 0} rows)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportAll}>
                  All ({data?.pagination?.total ?? '...'})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="solid" tone="business" onClick={() => setShowNewDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Estimate
            </Button>
          </div>
        }
      />

      <NewEstimateDialog
        open={showNewDialog}
        onOpenChange={setShowNewDialog}
        preSelectedCustomerId={preSelectedCustomerId}
        onPreSelectConsumed={() => setPreSelectedCustomerId(undefined)}
      />
      {confirmDialog}
    </div>
  );
}
