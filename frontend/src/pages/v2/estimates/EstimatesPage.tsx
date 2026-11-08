import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { Download, Plus } from 'lucide-react';

import api from '@/lib/axios';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { useAppAbility } from '@/contexts/AbilityContext';
import { summariseBulkResult } from '@/lib/bulk-result';
import { customerDisplayName } from '@/lib/customer-name';
import { endOfMonthDay, startOfMonthDay } from '@/lib/date-range';
import { estimatesRegistry, MONTHLY_ESTIMATE_STATUSES } from '@/lib/filters/registries/estimates';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { useFilterState } from '@/lib/filters/useFilterState';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import { useTagFacetOptions } from '@/lib/api/tags';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { formatCurrency } from '@/lib/utils';

import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
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

import { useConfirm } from '@/hooks/useConfirm';
import { useRecordVisit } from '../pageBreadcrumbs';
import { v2Path } from '../uiV2';
import { AppliedFilterBar as EstimateFilterBar } from '../_shared/appliedFilters';
import { facetSelectionCount, FilterPopover } from './components/filterPopover';
import { NewEstimateDialog } from './components/newEstimateDialog';
import { buildEstimateColumns, type Estimate } from './estimatesColumns';

interface StatusStat { count: number; value: number }
interface DepositsStat { count: number; total: number }

// Prisma's `_sum` over a Decimal column arrives on the wire as a string
// ("1357.19"), not a number, so every read must be coerced. `|| 0` catches a
// `null`/`""`/garbage value that would otherwise coerce to `NaN`: #2011's AC1
// requires "$0.00", never "$NaN".
const statWorth = (value: number | string | null | undefined) => formatCurrency(Number(value ?? 0) || 0);

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

/**
 * /v2/estimates - the estimates list on the CRM UI kit.
 *
 * Every query, param, cache key, KPI activation rule and bulk mutation below is
 * the legacy page's, imported or copied verbatim; only the components changed.
 *
 *  SORTING IS SERVER-SIDE, and the table is told so: `sorting` is this page's
 *  state, `onSortingChange` is the way back in and `manualSorting` stops the
 *  table re-ordering rows the server already ordered.
 *
 *  SELECTION goes through the table, and `useScopedRowSelection` - the legacy
 *  list's own hook, unforked - is the state behind it. A scope change reads
 *  back as empty in the same render, so no repaint ever shows stale rows
 *  ticked.
 *
 *  PAGING is server-side too, but the table now takes it: `page`, `pageCount`,
 *  `pageSize` and `rowCount` are handed to the DataTable and its footer is the
 *  ONLY paging control on the page.
 */
export default function EstimatesPage() {
  useRecordVisit('estimates');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const { confirm, confirmDialog } = useConfirm();
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [preSelectedCustomerId, setPreSelectedCustomerId] = useState<string | undefined>();

  // The LEGACY page's table key, verbatim (`pages/EstimatesPage.tsx`'s
  // `tableKey="estimates"`), so a user's stored column widths and visibility
  // carry over to this list instead of starting empty.

  // The legacy DataTable debounced its search box by 300 ms before lifting the
  // value; the kit's toolbar lifts on every keystroke, so the debounce moves
  // here. Page still snaps back to 1 on the keystroke itself, not on the
  // settled value, so no state is written from an effect.
  const search = useDebounce(searchInput, 300);

  const { value, setValue, listParams: filterParams } = useFilterState(estimatesRegistry);

  // Auto-open the picker when returning from lead/customer creation, or from a
  // quick-create shortcut. The param is consumed so a refresh does not reopen.
  useEffect(() => {
    const newCustomerId = searchParams.get('newCustomerId');
    const action = searchParams.get('action');
    if (newCustomerId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes a one-shot URL param, which IS the external system being synced from
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

  const { data: creatorsData } = useQuery({
    queryKey: ['estimate-creators'],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates/creators');
      return data.users as Creator[];
    },
  });

  // Memoized on the underlying query data (a stable react-query reference) per
  // the registry-stability contract in `useFilterState`.
  const creatorOptions = useMemo<FacetOption[]>(
    () => (creatorsData ?? []).map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}`.trim() })),
    [creatorsData],
  );
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'assignableUsers') return creatorOptions;
      if (sourceId === 'tags') return tagFacetOptions;
      return [];
    },
    [creatorOptions, tagFacetOptions],
  );
  // No backend "max total across all estimates" stat today - 100000 is a static
  // money ceiling (see the estimates registry's comment on the `total` facet).
  const resolveMax = useCallback(
    (sourceId: string): number => (sourceId === 'estimates.maxTotal' ? 100000 : 0),
    [],
  );

  // Any filter change (facet edit, chip removal, "Clear all", KPI click) snaps
  // back to page 1 - the same behaviour the legacy per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve the
  // pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present - even
  // if `undefined` - on an unfiltered mount). `filterParams` only carries keys
  // for ACTIVE facets, so this baseline fills in the rest; axios drops
  // `undefined`-valued params before sending either way.
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
  const rows: Estimate[] = data?.estimates ?? [];
  const pagination = data?.pagination as
    { page: number; limit: number; total: number; totalPages: number } | undefined;

  // A selected id only makes sense against the CURRENT page/sort/filter - once
  // any of the estimates query's own params change, the selection drops instead
  // of carrying stale ids (or a now-invisible row) forward. The scope key
  // mirrors the useQuery's own dependency set exactly.
  // `rowSelection` goes to the table, `selectedIds` is the same state already
  // reduced to the shape the three bulk endpoints take.
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
      toast(title, { description });
    },
    onError: () => {
      toast.error('Delete failed', { description: 'Failed to delete estimates. Please try again.' });
    },
  });

  const handleBulkDelete = async () => {
    const count = selectedEstimateIds.length;
    if (count === 0) return;
    const confirmed = await confirm({
      title: `Delete ${count} draft estimate${count === 1 ? '' : 's'}?`,
      description: 'This cannot be undone.',
      // Not plain 'Delete': the toolbar button that opens this is also 'Delete',
      // and two identically-named buttons on screen is ambiguous.
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
      toast(title, { description });
    },
    onError: () => {
      toast.error('Update failed', { description: 'Failed to update estimate status. Please try again.' });
    },
  });

  // "Back to draft" nulls the customer's signature/consent and public link -
  // irreversible, across up to 100 rows, from one click. The sibling Delete
  // button in this same bar already confirms; this is at least as destructive
  // and must too.
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
      toast(title, { description });
    },
    onError: () => {
      toast.error('Send failed', { description: 'Failed to send estimate reminders. Please try again.' });
    },
  });

  const handleBulkSendReminder = () => {
    if (selectedEstimateIds.length === 0 || selectedEstimateIds.length > 25) return;
    bulkSendReminderMutation.mutate(selectedEstimateIds);
  };

  const bulkSendOverCap = selectedEstimateIds.length > 25;

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

  const clearAllFilters = () => {
    setValue({});
    setSearchInput('');
    setPage(1);
  };

  // --- Clickable status KPIs -------------------------------------------------
  // Monthly tiles (Draft/Sent/Won/Declined/Archived) map to estimates CREATED
  // this month, so clicking one sets status=[X] AND the Created range to the
  // full current month and the listed rows match the tile's count. Pending is
  // all-time (status only, no date). Clicking the active tile clears.
  const monthStart = useMemo(() => startOfMonthDay(), []);
  const monthEnd = useMemo(() => endOfMonthDay(), []);

  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const createdByValues = value.created_by?.kind === 'multi' ? value.created_by.values : [];
  const depositValues = value.deposit_status?.kind === 'multi' ? value.deposit_status.values : [];
  const totalValue = value.total?.kind === 'range' ? value.total : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  const totalActive = Boolean(totalValue && (totalValue.from != null || totalValue.to != null));

  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added
  // here too - otherwise a status-plus-tags filter leaves the status tile lit
  // over a list narrowed further than its count implies, and a repeat click
  // routes into clearAllFilters() and drops the tag filter.
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
    setSearchInput('');
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
  // the selected value. Unlike the status tiles it does NOT also require "no
  // other facet active", and toggling it off clears only `deposit_status` -
  // the same asymmetry the legacy page has, carried over deliberately.
  const activeDepositKpi = depositValues.length === 1 && depositValues[0] === 'REQUESTED';

  const handleDepositKpi = () => {
    if (activeDepositKpi) {
      const next = { ...value };
      delete next.deposit_status;
      setValue(next);
      setPage(1);
      return;
    }
    setSearchInput('');
    setPage(1);
    setValue({ deposit_status: { kind: 'multi', values: ['REQUESTED'] } });
  };

  // Drives whether the applied-chip bar renders at all. Counted through the
  // same helper the popover uses, so an empty-but-present facet entry - which
  // `value` keeps after removing the last chip of a multi facet - does not
  // leave a chip row with nothing in it.
  const hasActiveFilters = useMemo(
    () => estimatesRegistry.some((facet) => facetSelectionCount(value[facet.key]) > 0),
    [value],
  );

  const columns = useMemo(
    () => buildEstimateColumns({ sorting, onToggleSort: toggleSort }),
    [sorting, toggleSort],
  );

  // --- Export ----------------------------------------------------------------
  const toExportRow = (e: Estimate) => {
    // Same anchor fallback as the Customer column: an unguarded `e.lead.customer`
    // threw before writing a row whenever a customer-anchored estimate was in
    // the list.
    const c = e.lead?.customer ?? e.customer;
    return {
      'Estimate #': e.estimate_number,
      'Customer': customerDisplayName(c, ''),
      'Company': c?.company_name ?? '',
      'Status': e.status,
      'Total': Number(e.total_amount),
      'Created By': `${e.creator.first_name} ${e.creator.last_name}`,
      'Date': new Date(e.created_at).toLocaleDateString(),
    };
  };

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (list: Estimate[], filename: string) => {
    if (!list.length) return;
    downloadCSV(toCSV(list.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => exportRows(rows, `estimates-page${page}-${today()}.csv`);
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/estimates/export', { params: listParams });
      exportRows(ex.estimates ?? [], `estimates-all-${today()}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export estimates. Please try again.' });
    }
  };

  return (
    <div>
      {/* Actions hold ONLY the primary one. Export is a table-scoped action -
          it exports what the table is showing - so it lives in the table's own
          toolbar, next to Columns and Filter, and appears exactly once. */}
      <PageHeader
        title="Estimates"
        actions={
          <Button onClick={() => setShowNewDialog(true)}>
            <Plus />
            New Estimate
          </Button>
        }
      />

      {/* No `tone`: StatCards carry no colour. The legacy strip tinted seven
          tiles a different hue each and none of them meant anything.
          The stat KEYS are the API's: `won` and `archived`, which is what this
          endpoint returns today. */}
      <StatCardGroup className="mb-1.5 xl:grid-cols-4 2xl:grid-cols-7">
        <StatCard
          label="Draft" value={stats?.draft?.count ?? 0} detail={statWorth(stats?.draft?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.DRAFT}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.DRAFT)}
        />
        <StatCard
          label="Sent" value={stats?.sent?.count ?? 0} detail={statWorth(stats?.sent?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.SENT}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.SENT)}
        />
        <StatCard
          label="Pending" value={stats?.pending?.count ?? 0} detail={statWorth(stats?.pending?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.PENDING}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.PENDING)}
        />
        <StatCard
          label="Won" value={stats?.won?.count ?? 0} detail={statWorth(stats?.won?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.WON}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.WON)}
        />
        <StatCard
          label="Declined" value={stats?.declined?.count ?? 0} detail={statWorth(stats?.declined?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.DECLINED}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.DECLINED)}
        />
        <StatCard
          label="Archived" value={stats?.archived?.count ?? 0} detail={statWorth(stats?.archived?.value)} loading={isLoading}
          active={activeStatusKpi === ESTIMATE_STATUS.ARCHIVED}
          onClick={() => handleStatusKpi(ESTIMATE_STATUS.ARCHIVED)}
        />
        <StatCard
          label="Pending Deposits"
          value={formatCurrency(Number(stats?.pending_deposits?.total ?? 0))}
          loading={isLoading}
          active={activeDepositKpi}
          onClick={handleDepositKpi}
        />
      </StatCardGroup>

      {/* The count and the worth beneath it share a window, but the tiles do
          not share one with each other - draft/sent/won/declined/archived are
          this-month, pending and pending deposits are all time. */}
      <p className="text-muted-foreground mb-4 text-xs">
        Draft, Sent, Won, Declined and Archived cover estimates created this month. Pending and Pending Deposits are all time.
      </p>

      {/* Applied-filter chips only. The Filter TRIGGER lives in the table
          toolbar beside Columns and Export, where the other table controls are;
          this bar appears solely to name what is currently constraining the
          list, and disappears when nothing is. */}
      {hasActiveFilters && (
        <EstimateFilterBar
          className="mb-3"
          registry={estimatesRegistry}
          value={value}
          onChange={handleFilterChange}
          resolveOptions={resolveOptions}
          resultCount={rows.length}
          totalCount={pagination?.total}
        />
      )}

      {selectedEstimateIds.length > 0 && (
        <BulkActionBar
          className="mb-3 rounded-lg border"
          count={selectedEstimateIds.length}
          noun={['estimate', 'estimates']}
          onClear={() => setRowSelection({})}
        >
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
              variant="destructive"
              size="sm"
              onClick={handleBulkDelete}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          )}
        </BulkActionBar>
      )}

      {/* The server's page state drives the table's own footer, which is the
          page's single paging control. */}
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(estimate) => estimate.id}
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
        onRowClick={(estimate) => navigate(v2Path(`/estimates/${estimate.id}`))}
        // One string, no filter-aware variant: the legacy list does not
        // distinguish "no estimates exist" from "nothing matches", and
        // inventing the distinction here would be a behaviour change.
        empty={<EmptyState title="No results found." />}
      >
        {(table) => (
          <DataTableToolbar
            table={table}
            searchValue={searchInput}
            onSearchChange={handleSearchChange}
            searchPlaceholder="Search estimates..."
            actions={
              <>
                <FilterPopover
                  registry={estimatesRegistry}
                  value={value}
                  onChange={handleFilterChange}
                  resolveOptions={resolveOptions}
                  resolveMax={resolveMax}
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
