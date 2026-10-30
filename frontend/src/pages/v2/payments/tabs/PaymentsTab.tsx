import { useCallback, useMemo, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { SearchX } from 'lucide-react';

import {
  fetchPaymentsExport, useAttention, usePaymentsList, usePaymentsSummary, type PaymentRow, type PaymentsListParams,
} from '@/lib/api/paymentsPage';
import { downloadCSV, toCSV } from '@/lib/csv';
import { useCanSeePrices } from '@/contexts/AbilityContext';
import { paymentsRegistry, paymentsRegistryFor } from '@/lib/filters/registries/payments';
import { useFilterState } from '@/lib/filters/useFilterState';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { toggleColumnSort } from '@/lib/tableSort';
import { extractApiError } from '@/lib/utils';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { toast } from '@/ui-kit/components/ui/sonner';

import { AppliedFilterBar } from '../../_shared/appliedFilters';
import { facetSelectionCount } from '../../_shared/filterPopover';
import { LoadError } from '../../_shared/loadError';
import { useScrollTableIntoView } from '../useScrollTableIntoView';
import { AttentionHistory } from '../components/AttentionHistory';
import { ATTENTION_FETCH_LIMIT } from '../attentionCardItems';
import { PAYMENT_CHIPS, PaymentsToolbar, type PaymentChip } from '../components/PaymentsToolbar';
import { useDrawerHost } from '../drawerHost';
import { stackForItem } from '../drawerStack';
import { buildPaymentColumns, PAYMENT_PRICE_COLUMN_IDS, SORTABLE_COLUMNS, toPaymentExportRow } from '../components/paymentsColumns';
import type { PaymentsTabProps } from '../types';

const DEFAULT_SORT: SortingState = [{ id: 'date', desc: true }];
/** Date is always sorted (newest first or oldest first); the money columns can also fall back to the default order. */
const ALWAYS_SORTED = new Set(['date']);
const NO_OPTIONS = (): FacetOption[] => [];

const isChip = (v: string | null): v is PaymentChip => PAYMENT_CHIPS.some((c) => c.value === v);

/** Every URL key the filter facets own, so one update can clear them all with the chip and the search. */
const FACET_URL_KEYS = paymentsRegistry.flatMap((f) => [f.param, `${f.param}_min`, `${f.param}_max`]);

/**
 * The Payments tab (payments go-live P6): quick chips, search, the app's filter popover, Export, a server-paged table
 * and the payment drawer. Chip, search, facets and the open payment live in the URL; the page number, page size and
 * sort are this tab's own and snap back to page 1 whenever the period, chip, search or a facet changes.
 */
export default function PaymentsTab({ range, tabState }: PaymentsTabProps) {
  const { params, setParams } = tabState;
  const timeZone = useScheduleTimezone();

  const rawChip = params.get('chip');
  const chip: PaymentChip = isChip(rawChip) ? rawChip : 'all';
  const q = params.get('q') ?? '';
  const host = useDrawerHost();
  const [searchInput, setSearchInput] = useState(q);
  const attentionOn = chip === 'attention';
  const attView = params.get('attView') === 'resolved' ? 'resolved' : 'open';

  // P11: without See prices there is no Amount facet and no Amount, Fee or Net column.
  const canSeePrices = useCanSeePrices();
  const registry = paymentsRegistryFor(canSeePrices);
  const { value: filters, setValue: setFilters, listParams: facetParams } = useFilterState(registry);

  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORT);
  const [pageSize, setPageSize] = useState(25);
  const sortBy = sorting[0]?.id ?? 'date';
  const sortDir: 'asc' | 'desc' = (sorting[0] ? sorting[0].desc : true) ? 'desc' : 'asc';

  // The page number is only valid for the filters it was chosen under; a different period, chip, search, facet, sort or
  // page size reads as page 1 without an effect to reset it.
  const scope = JSON.stringify([range, chip, q, facetParams, sortBy, sortDir, pageSize]);
  const [pageState, setPageState] = useState({ scope, page: 1 });
  const page = pageState.scope === scope ? pageState.page : 1;
  const setPage = (next: number) => setPageState({ scope, page: next });
  const { ref: tableTopRef, request: scrollTableTop } = useScrollTableIntoView();

  const filterQuery = useMemo<PaymentsListParams>(
    () => ({
      from: range.from,
      to: range.to,
      chip: chip === 'all' ? undefined : chip,
      q: q || undefined,
      ...facetParams,
    }),
    [range.from, range.to, chip, q, facetParams],
  );
  const listQuery = useMemo<PaymentsListParams>(
    () => ({ ...filterQuery, page, limit: pageSize, sortBy, sortDir }),
    [filterQuery, page, pageSize, sortBy, sortDir],
  );

  const list = usePaymentsList(listQuery, { enabled: !attentionOn });
  const summary = usePaymentsSummary(range);
  // The same request the card makes, so the chip, the card and the table never disagree about the counts. Its limit is
  // the card's (one request, so the counts never disagree); the open items it returns also feed the drawer's action slot.
  const attention = useAttention('open', { limit: ATTENTION_FETCH_LIMIT });
  const openCount = attention.data?.counts?.open ?? 0;
  const resolvedCount = attention.data?.counts?.resolved ?? 0;
  const rows = list.data?.payments ?? [];
  const pagination = list.data?.pagination;

  const anyFacet = registry.some((f) => facetSelectionCount(filters[f.key]) > 0);
  // "shown of total" only describes the facets alone: a search or a status chip narrows past them.
  const showCount = !q && chip === 'all';
  const anythingApplied = Boolean(q) || anyFacet || chip !== 'all';

  const clearAll = () => {
    setSearchInput('');
    setParams({ chip: null, q: null, attView: null, ...Object.fromEntries(FACET_URL_KEYS.map((k) => [k, null])) });
  };

  const toggleSort = useCallback((columnId: string) => {
    if (SORTABLE_COLUMNS.has(columnId)) setSorting((prev) => toggleColumnSort(prev, columnId, ALWAYS_SORTED));
  }, [setSorting]);
  const columns = useMemo(
    () => buildPaymentColumns({ sorting, onToggleSort: toggleSort, timeZone }).filter((c) => canSeePrices || !PAYMENT_PRICE_COLUMN_IDS.has(String(c.id))),
    [sorting, toggleSort, timeZone, canSeePrices],
  );

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await fetchPaymentsExport(filterQuery);
      downloadCSV(toCSV(all.map((p) => toPaymentExportRow(p, timeZone, canSeePrices))), `payments-${range.from}-${range.to}.csv`);
      toast.success(`Exported ${all.length} ${all.length === 1 ? 'payment' : 'payments'}`);
    } catch (err) {
      toast.error(extractApiError(err, 'Could not export payments.'));
    } finally {
      setExporting(false);
    }
  };

  const onFilters = (next: FilterState) => setFilters(next);

  const emptyState = anythingApplied ? (
    <EmptyState
      icon={<SearchX />}
      title="No payments match"
      description="Try a different search, filter or period."
      action={<Button variant="outline" size="sm" onClick={clearAll}>Clear filters</Button>}
    />
  ) : (
    <EmptyState icon={<SearchX />} title="No payments match" description="Payments in this period will show here." />
  );

  return (
    <div className="flex flex-col gap-4 pt-4">
      <PaymentsToolbar
        chip={chip}
        onChip={(next) => setParams({ chip: next === 'all' ? null : next })}
        disputedCount={summary.data?.disputed_count ?? 0}
        attentionCount={openCount}
        attention={attentionOn ? {
          view: attView,
          onView: (next) => setParams({ attView: next === 'open' ? null : next }),
          openCount,
          resolvedCount,
        } : undefined}
        searchValue={searchInput}
        onSearchValue={setSearchInput}
        onSearchSettled={(value) => { if (value !== q) setParams({ q: value || null }); }}
        filters={filters}
        onFilters={onFilters}
        onExport={() => void exportCsv()}
        exporting={exporting}
      />
      {!attentionOn && anyFacet && (
        <AppliedFilterBar
          registry={registry}
          value={filters}
          onChange={onFilters}
          resolveOptions={NO_OPTIONS}
          resultCount={showCount ? rows.length : undefined}
          totalCount={showCount ? pagination?.total : undefined}
        />
      )}
      {attentionOn ? (
        <AttentionHistory
          view={attView}
          q={q}
          timeZone={timeZone}
          onOpen={(item) => {
            const views = stackForItem(item);
            if (views) host.open(views);
          }}
          onClear={clearAll}
        />
      ) : list.isError && !list.data ? (
        <LoadError title="Couldn’t load payments." onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <div ref={tableTopRef}>
          <DataTable<PaymentRow, unknown>
            columns={columns}
            data={rows}
            getRowId={(p) => p.id}
            isLoading={list.isPending}
            isFetching={list.isFetching}
            page={page}
            pageCount={pagination?.totalPages ?? 1}
            onPageChange={(next) => { setPage(next); scrollTableTop(); }}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            rowCount={pagination?.total ?? 0}
            sorting={sorting}
            onSortingChange={(next) => setSorting(next.length ? next : DEFAULT_SORT)}
            manualSorting
            mobileCards
            rowsFocusable
            isRowClickable={(p) => !p.restricted}
            onRowClick={(p) => host.open([{ kind: 'payment', id: p.id }], { seeds: { [`payment:${p.id}`]: p } })}
            empty={emptyState}
          />
        </div>
      )}
    </div>
  );
}
