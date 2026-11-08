import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { Download, Plus, Receipt } from 'lucide-react';

import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { formatCurrency } from '@/lib/utils';
import { summariseBulkResult } from '@/lib/bulk-result';
import { useFilterState } from '@/lib/filters/useFilterState';
import { invoicesRegistry } from '@/lib/filters/registries/invoices';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { useTagFacetOptions } from '@/lib/api/tags';
import type { FacetOption, FilterState } from '@/lib/filters/types';

import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { DataTableToolbar } from '@/ui-kit/components/data/dataTable/dataTableToolbar';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

import { useScheduleTimezone } from '@/lib/schedule-tz';
import { v2Path, preferV2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
// Generic, module-agnostic: it renders one removable chip per active facet and
// names the field on each. Imported rather than copied so the chip vocabulary
// cannot drift between modules; the `Lead` in the name is historical, hence the
// alias. Flagged for a rename/hoist at integration.
import { AppliedFilterBar } from '../_shared/appliedFilters';
import { FilterPopover, facetSelectionCount } from '../_shared/filterPopover';
import {
  buildInvoiceColumns, toInvoiceExportRow, DEFAULT_COLUMN_VISIBILITY,
  type InvoiceListItem,
} from './invoicesColumns';

interface NeedInvoiceJob {
  id: string;
  job_number: string;
  scheduled_start: string | null;
  customer: { id: string; first_name: string; last_name: string; company_name: string | null };
}

interface InvoiceStats {
  due: { total: number; count: number };
  overdue: { total: number; count: number };
  collected_this_month: { total: number; count: number };
  unsent: number;
  need_invoices: number;
  /** Deposit money taken but not yet applied to an invoice. See the tile below. */
  deposits_held: number;
}

/** Set-equality helper for the clickable status KPIs. Ported verbatim. */
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && b.every((x) => a.includes(x));

/**
 * /v2/invoices - the invoices list on the CRM UI kit.
 *
 * Every query, param, cache key, KPI predicate and export mapping below is the
 * legacy page's, imported or copied verbatim; only the components changed.
 *
 *  SORTING IS SERVER-SIDE, and the table is told so: `sorting` is this page's
 *  state, `onSortingChange` is the way back in and `manualSorting` stops the
 *  table re-ordering rows the server already ordered.
 *
 *  COLUMN VISIBILITY is seeded by `defaultColumnVisibility` (the four money
 *  columns start hidden) and ROW SELECTION rides the page's
 *  `useScopedRowSelection` through `rowSelection`/`onRowSelectionChange`.
 *
 *  NO SAVED TABLE VIEW. This list read and wrote `/api/me/table-views/invoices`
 *  through the toolbar's "View" menu; the owner asked for that control to go,
 *  which left nothing able to save a view, so the whole path came out. The
 *  hook itself still serves the legacy list.
 */
export default function InvoicesPage() {
  useRecordVisit('invoices');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  // Standalone-invoice creation is ADMIN + DISPATCHER (the `create Invoice`
  // grant also covers technicians, but they never reach this desktop page;
  // SALES can only read).
  const canCreateInvoice = ability.can('create', 'Invoice');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [needInvoiceOpen, setNeedInvoiceOpen] = useState(false);

  // The legacy DataTable debounced its search box by 300 ms before lifting the
  // value; the kit's toolbar lifts on every keystroke, so the debounce moves
  // here. Page still snaps back to 1 on the keystroke itself.
  const search = useDebounce(searchInput, 300);

  const { value, setValue, listParams: filterParams } = useFilterState(invoicesRegistry);

  // SRVW-58 - the org's tag vocabulary for the Tags facet, this registry's only
  // dynamic `optionSource`.
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => (sourceId === 'tags' ? tagFacetOptions : []),
    [tagFacetOptions],
  );
  // No backend "max total"/"max balance across all invoices" stat today -
  // 100000 is the static money ceiling for both, same as the legacy page.
  const resolveMax = useCallback(
    (sourceId: string): number =>
      sourceId === 'invoices.maxTotal' || sourceId === 'invoices.maxBalance' ? 100000 : 0,
    [],
  );

  // Any filter change (facet edit, chip removal, "Clear all") snaps back to
  // page 1 - the same behaviour the legacy per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve the
  // legacy `listParams` object's exact key set (a unit test asserts `status` is
  // present - even if `undefined` - on an unfiltered mount). `filterParams`
  // only carries keys for ACTIVE facets, so this baseline fills in the rest;
  // axios drops `undefined`-valued params before sending either way.
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    total_min: undefined as string | undefined,
    total_max: undefined as string | undefined,
    balance_min: undefined as string | undefined,
    balance_max: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    due_after: undefined as string | undefined,
    due_before: undefined as string | undefined,
    overdue: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/invoices', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
  });

  // #594 - lazy, gated query for the "To Be Invoiced" modal; only fetches once
  // the tile is clicked. Distinct queryKey so it cannot collide with the
  // invoices/jobs lists.
  const { data: needInvoiceData, isLoading: needInvoiceLoading } = useQuery({
    queryKey: ['jobs', 'needs-invoice'],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', { params: { needs_invoice: 'true', limit: 100 } });
      return data as { jobs: NeedInvoiceJob[] };
    },
    enabled: needInvoiceOpen,
  });

  const stats: InvoiceStats | undefined = data?.stats;
  const rows: InvoiceListItem[] = data?.invoices ?? [];
  const pagination = data?.pagination as
    { page: number; limit: number; total: number; totalPages: number } | undefined;

  // A selected id only makes sense against the CURRENT page/sort/filter -
  // mirrors the invoices query's own queryKey dependency set exactly. The
  // legacy list's own hook, unforked: a scope change reads back as empty in the
  // SAME render, so there is never a repaint with stale rows still ticked.
  const selectionScope = JSON.stringify([page, pageSize, search, sortBy, sortDir, value]);
  const { rowSelection, setRowSelection, selectedIds: selectedInvoiceIds } =
    useScopedRowSelection(selectionScope);

  const bulkSendMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/invoices/bulk-send', { ids });
      return data as { sent: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      const { title, description } = summariseBulkResult({
        okCount: result.sent.length,
        failed: result.failed,
        noun: 'invoice',
        nounPlural: 'invoices',
        verbPast: 'sent',
      });
      toast(title, { description });
    },
    onError: () => {
      toast.error('Send failed', { description: 'Failed to send invoices. Please try again.' });
    },
  });

  const bulkResendMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/invoices/bulk-resend', { ids });
      return data as { sent: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      const { title, description } = summariseBulkResult({
        okCount: result.sent.length,
        failed: result.failed,
        noun: 'invoice',
        nounPlural: 'invoices',
        verbPast: 'sent',
      });
      toast(title, { description });
    },
    onError: () => {
      toast.error('Send failed', {
        description: 'Failed to send invoice reminders. Please try again.',
      });
    },
  });

  const bulkSendOverCap = selectedInvoiceIds.length > 25;
  const handleBulkSend = () => {
    if (selectedInvoiceIds.length === 0 || bulkSendOverCap) return;
    bulkSendMutation.mutate(selectedInvoiceIds);
  };
  const handleBulkResend = () => {
    if (selectedInvoiceIds.length === 0 || bulkSendOverCap) return;
    bulkResendMutation.mutate(selectedInvoiceIds);
  };

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

  // A FULL page load, not react-router: the Jobs module is a separate
  // migration, so a soft navigation from here could land on a v2 route that
  // does not exist yet. Ported from the legacy cell verbatim.
  // The OVERDUE pseudo-status is counted on the ORG's calendar day, so this list and the
  // invoice detail page cannot disagree about whether an invoice due today is late yet.
  const timeZone = useScheduleTimezone();

  const openJob = useCallback((jobId: string) => {
    window.location.href = `/jobs/${jobId}`;
  }, []);

  const columns = useMemo(
    () => buildInvoiceColumns(sorting, toggleSort, openJob, timeZone),
    [sorting, toggleSort, openJob, timeZone],
  );

  // NOTE on "Clear all": the legacy page owned that button and cleared the
  // search box along with the facets. Here the chip bar is the kit's FilterBar,
  // which wires its own Clear all straight to `onChange({})` - so it clears
  // every facet and snaps to page 1, but leaves the search box alone. The
  // search box grew its own Reset in the table toolbar, so nothing became
  // unreachable; the two controls are just separate now. Recorded as a delta.

  // Drives whether the applied-chip bar renders at all.
  const hasActiveFilters = useMemo(
    () => invoicesRegistry.some((facet) => facetSelectionCount(value[facet.key]) > 0),
    [value],
  );

  // --- Clickable KPIs ------------------------------------------------------
  // The stats are GLOBAL (tenant/role-scoped, independent of the active list
  // filters). For the KPI counts/sums to match the filtered list exactly, a KPI
  // click clears every other filter and sets only the relevant status (or the
  // overdue flag). `active` therefore also requires no other filter be set.
  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const overdueValues = value.overdue?.kind === 'multi' ? value.overdue.values : [];
  const kindValues = value.kind?.kind === 'multi' ? value.kind.values : [];
  const totalValue = value.total?.kind === 'range' ? value.total : undefined;
  const balanceValue = value.balance?.kind === 'range' ? value.balance : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const dueValue = value.due?.kind === 'dateRange' ? value.due : undefined;

  const totalActive = Boolean(totalValue && (totalValue.from != null || totalValue.to != null));
  const balanceActive = Boolean(balanceValue && (balanceValue.from != null || balanceValue.to != null));
  const createdActive = Boolean(createdValue?.from || createdValue?.to);
  const dueRangeActive = Boolean(dueValue?.from || dueValue?.to);
  const overdueActive = overdueValues.includes('true');
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added
  // here too - otherwise a status-plus-tags filter leaves a tile lit over a
  // list narrowed further than its count implies, and clicking it routes into
  // setValue({}) and drops the tag filter.
  const noOtherFacetsOrStandalone =
    !totalActive && !balanceActive && !createdActive && !dueRangeActive && !search &&
    tagValues.length === 0;
  const noOtherFilters = !overdueActive && noOtherFacetsOrStandalone;

  const dueKpiActive = noOtherFilters && sameSet(statusValues, ['SENT', 'PARTIAL']);
  const overdueKpiActive = overdueActive && statusValues.length === 0 && noOtherFacetsOrStandalone;

  const handleStatusKpi = (next: string[], isActive: boolean) => {
    setSearchInput('');
    setPage(1);
    setValue(isActive ? {} : { status: { kind: 'multi', values: next } });
  };
  // Not a status filter like the tiles beside it: "held" is about the document's
  // KIND, so it drives the `kind` facet and lights up only for that exact
  // selection - the same set-equality rule the status tiles use.
  const depositsKpiActive = sameSet(kindValues, ['DEPOSIT']);
  const handleDepositsKpi = () =>
    setValue(depositsKpiActive ? {} : { kind: { kind: 'multi', values: ['DEPOSIT'] } });

  const handleOverdueKpi = () => {
    setSearchInput('');
    setPage(1);
    // `setValue` replaces the whole registry-owned facet set in one call, so
    // this single call both applies (or clears) `overdue` AND clears every
    // other facet - overdue spans all statuses.
    setValue(overdueKpiActive ? {} : { overdue: { kind: 'multi', values: ['true'] } });
  };

  // --- Export --------------------------------------------------------------

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (list: InvoiceListItem[], filename: string) => {
    if (!list.length) return;
    downloadCSV(toCSV(list.map((inv) => toInvoiceExportRow(inv, timeZone))), filename);
  };

  const handleExportCurrentPage = () => exportRows(rows, `invoices-page${page}-${today()}.csv`);
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/invoices/export', { params: listParams });
      exportRows(ex.invoices ?? [], `invoices-all-${today()}.csv`);
    } catch {
      toast.error('Export failed', { description: 'Failed to export invoices. Please try again.' });
    }
  };

  return (
    <div>
      <PageHeader
        title="Invoices"
        actions={
          canCreateInvoice ? (
            <Button onClick={() => navigate(v2Path('/invoices/new'))}>
              <Plus />
              New Invoice
            </Button>
          ) : undefined
        }
      />

      <StatCardGroup className="mb-4">
        <StatCard
          label="Due"
          value={formatCurrency(Number(stats?.due?.total ?? 0))}
          loading={isLoading}
          active={dueKpiActive}
          onClick={() => handleStatusKpi(['SENT', 'PARTIAL'], dueKpiActive)}
        />
        {/* Overdue is the one tile that carries a rail: money past its due date
            is the only figure on this row that means "act now". */}
        <StatCard
          label="Overdue"
          value={formatCurrency(Number(stats?.overdue?.total ?? 0))}
          tone="red"
          loading={isLoading}
          active={overdueKpiActive}
          onClick={handleOverdueKpi}
        />
        {/* Bug #21 / #594 - the completed-but-unbilled count opens an in-page
            modal listing those jobs. It is NOT a filter of this list, so it
            never lights up as an active KPI. */}
        <StatCard
          label="To Be Invoiced"
          value={stats?.need_invoices ?? 0}
          loading={isLoading}
          onClick={() => setNeedInvoiceOpen(true)}
        />
        {/* Deposits are excluded from every revenue figure the app reports -
            correctly, because a deposit is money held against work not yet done.
            The cost of that correctness was that the money became invisible: an
            org could hold six figures in deposits and see it nowhere. This tile
            is that number, and clicking it filters the list to the rows behind
            it. */}
        <StatCard
          label="Deposits Held"
          value={formatCurrency(Number(stats?.deposits_held ?? 0))}
          loading={isLoading}
          active={depositsKpiActive}
          onClick={handleDepositsKpi}
        />
      </StatCardGroup>

      {hasActiveFilters && (
        <AppliedFilterBar
          className="mb-3"
          registry={invoicesRegistry}
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
        getRowId={(invoice) => invoice.id}
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
        defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
        enableColumnResizing
        mobileCards
        onRowClick={(invoice) => navigate(v2Path(`/invoices/${invoice.id}`))}
        empty={<EmptyState title="No results found." />}
      >
        {(table) => (
          <>
            <DataTableToolbar
              table={table}
              searchValue={searchInput}
              onSearchChange={handleSearchChange}
              searchPlaceholder="Search invoices..."
              actions={
                <>
                  <FilterPopover
                    registry={invoicesRegistry}
                    value={value}
                    onChange={handleFilterChange}
                    resolveOptions={resolveOptions}
                    resolveMax={resolveMax}
                    statusDomain="invoice"
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
            {ability.can('send', 'Invoice') && (
              <BulkActionBar
                count={selectedInvoiceIds.length}
                onClear={() => setRowSelection({})}
                noun={['invoice', 'invoices']}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkSend}
                  disabled={bulkSendMutation.isPending || bulkSendOverCap}
                  title={bulkSendOverCap ? 'Select 25 or fewer invoices to send' : undefined}
                >
                  {bulkSendMutation.isPending ? 'Sending...' : 'Send'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkResend}
                  disabled={bulkResendMutation.isPending || bulkSendOverCap}
                  title={bulkSendOverCap ? 'Select 25 or fewer invoices to send a reminder' : undefined}
                >
                  {bulkResendMutation.isPending ? 'Sending...' : 'Send reminder'}
                </Button>
              </BulkActionBar>
            )}
          </>
        )}
      </DataTable>

      {/* #594 - "To Be Invoiced": completed jobs that still need an invoice. */}
      <Dialog open={needInvoiceOpen} onOpenChange={setNeedInvoiceOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>To Be Invoiced</DialogTitle>
            <DialogDescription>
              Completed jobs that still need an invoice. Select a job to bill it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-5">
            {needInvoiceLoading ? (
              <div className="flex items-center justify-center py-10">
                <Spinner />
              </div>
            ) : (needInvoiceData?.jobs.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Receipt />}
              title="No completed jobs are waiting to be invoiced."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Scheduled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {needInvoiceData!.jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      {/* Jobs is a separate migration - this stays a legacy path. */}
                      <Link to={preferV2Path(`/jobs/${job.id}`)} className="text-brand font-medium hover:underline">
                        {job.job_number}
                      </Link>
                    </TableCell>
                    <TableCell>{customerDisplayName(job.customer, '')}</TableCell>
                    <TableCell>
                      <span className="text-muted-foreground tabular-nums">
                        {formatExactInstant(job.scheduled_start)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
