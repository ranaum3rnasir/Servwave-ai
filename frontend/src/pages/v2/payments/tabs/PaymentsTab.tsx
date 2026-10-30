import { useCallback, useMemo, useRef, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { SearchX } from 'lucide-react';

import {
  fetchPaymentsExport, useAttention, usePaymentsList, usePaymentsSummary, type AttentionItem, type AttentionType, type PaymentRow, type PaymentsListParams,
} from '@/lib/api/paymentsPage';
import { downloadCSV, toCSV } from '@/lib/csv';
import { paymentsRegistry } from '@/lib/filters/registries/payments';
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
import { AttentionActions, visibleActions } from '../components/attentionActions';
import { AttentionHistory } from '../components/AttentionHistory';
import { CARD_LIMIT } from '../components/AttentionCard';
import { PAYMENT_CHIPS, PaymentsToolbar, type PaymentChip } from '../components/PaymentsToolbar';
import { DisputeDrawer } from '../components/DisputeDrawer';
import { PaymentDrawer } from '../components/PaymentDrawer';
import { buildPaymentColumns, SORTABLE_COLUMNS, toPaymentExportRow } from '../components/paymentsColumns';
import type { PaymentsTabProps } from '../types';

const DEFAULT_SORT: SortingState = [{ id: 'date', desc: true }];
/** Date is always sorted (newest first or oldest first); the money columns can also fall back to the default order. */
const ALWAYS_SORTED = new Set(['date']);
const NO_OPTIONS = (): FacetOption[] => [];

/** The type select's values as the item types the route filters by. */
const ATTENTION_TYPES_OF: Record<string, AttentionType[]> = {
  failed_payment: ['failed_payment'],
  failed_refund: ['failed_refund'],
  dispute: ['dispute'],
  failed_payout: ['failed_payout'],
  unmatched: ['unmatched_payment', 'unmatched_refund'],
};

const isChip = (v: string | null): v is PaymentChip => PAYMENT_CHIPS.some((c) => c.value === v);

/** Every URL key the filter facets own, so one update can clear them all with the chip and the search. */
const FACET_URL_KEYS = paymentsRegistry.flatMap((f) => [f.param, `${f.param}_min`, `${f.param}_max`]);

/**
 * The Payments tab (payments go-live P6): quick chips, search, the app's filter popover, Export, a server-paged table
 * and the payment drawer. Chip, search, facets and the open payment live in the URL; the page number, page size and
 * sort are this tab's own and snap back to page 1 whenever the period, chip, search or a facet changes.
 */
/**
 * The open items that belong to the drawer's payment, asked for by that payment (the server links an item to its
 * payment), so they come back however long the open backlog is. They sit in the footer at the footer's own button size.
 */
function useDrawerItems(paymentId: string | null) {
  const { data } = useAttention('open', { limit: 50, ...(paymentId ? { payment_id: paymentId } : {}) }, { enabled: Boolean(paymentId) });
  return paymentId ? (data?.items ?? []).filter((item) => item.payment_id === paymentId) : [];
}

/** Respond is the dispute alert's own button in this drawer, so the footer does not repeat it. */
function DrawerAttentionActions({ items }: { items: AttentionItem[] }) {
  return (
    <>
      {items.map((item) => <AttentionActions key={item.key} item={item} size="default" omit={['respond']} />)}
    </>
  );
}

export default function PaymentsTab({ range, tabState }: PaymentsTabProps) {
  const { params, setParams } = tabState;
  const timeZone = useScheduleTimezone();

  const rawChip = params.get('chip');
  const chip: PaymentChip = isChip(rawChip) ? rawChip : 'all';
  const q = params.get('q') ?? '';
  const paymentId = params.get('payment');
  const drawerItems = useDrawerItems(paymentId);
  const disputeId = params.get('dispute');
  const [searchInput, setSearchInput] = useState(q);
  const attentionOn = chip === 'attention';
  const attView = params.get('attView') === 'resolved' ? 'resolved' : 'open';
  const rawType = params.get('type') ?? 'all';
  const attType = rawType in ATTENTION_TYPES_OF ? rawType : 'all';

  const { value: filters, setValue: setFilters, listParams: facetParams } = useFilterState(paymentsRegistry);

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
  // the card's; the open items it returns also feed the drawer's action slot.
  const attention = useAttention('open', { limit: CARD_LIMIT });
  const openCount = attention.data?.counts?.open ?? 0;
  const resolvedCount = attention.data?.counts?.resolved ?? 0;
  const rows = list.data?.payments ?? [];
  const pagination = list.data?.pagination;

  const anyFacet = paymentsRegistry.some((f) => facetSelectionCount(filters[f.key]) > 0);
  const anythingApplied = Boolean(q) || anyFacet || chip !== 'all';

  const clearAll = () => {
    setSearchInput('');
    setParams({ chip: null, q: null, attView: null, type: null, ...Object.fromEntries(FACET_URL_KEYS.map((k) => [k, null])) });
  };

  const toggleSort = useCallback((columnId: string) => {
    if (SORTABLE_COLUMNS.has(columnId)) setSorting((prev) => toggleColumnSort(prev, columnId, ALWAYS_SORTED));
  }, [setSorting]);
  const columns = useMemo(() => buildPaymentColumns({ sorting, onToggleSort: toggleSort, timeZone }), [sorting, toggleSort, timeZone]);

  // The row that opened the drawer, so Close and Escape put focus back on it.
  const openerRef = useRef<HTMLElement | null>(null);

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await fetchPaymentsExport(filterQuery);
      downloadCSV(toCSV(all.map((p) => toPaymentExportRow(p, timeZone))), `payments-${range.from}-${range.to}.csv`);
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
          type: attType,
          onType: (next) => setParams({ type: next === 'all' ? null : next }),
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
          registry={paymentsRegistry}
          value={filters}
          onChange={onFilters}
          resolveOptions={NO_OPTIONS}
          resultCount={rows.length}
          totalCount={pagination?.total}
        />
      )}
      {attentionOn ? (
        <AttentionHistory
          view={attView}
          q={q}
          types={attType === 'all' ? undefined : ATTENTION_TYPES_OF[attType]}
          timeZone={timeZone}
          onOpen={(target) => {
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setParams(target);
          }}
          onClear={() => { setSearchInput(''); setParams({ q: null, type: null }); }}
        />
      ) : list.isError && !list.data ? (
        <LoadError title="Couldn’t load payments." onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <DataTable<PaymentRow, unknown>
          columns={columns}
          data={rows}
          getRowId={(p) => p.id}
          isLoading={list.isPending}
          isFetching={list.isFetching}
          page={page}
          pageCount={pagination?.totalPages ?? 1}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          rowCount={pagination?.total ?? 0}
          sorting={sorting}
          onSortingChange={(next) => setSorting(next.length ? next : DEFAULT_SORT)}
          manualSorting
          mobileCards
          rowsFocusable
          isRowClickable={(p) => !p.restricted}
          onRowClick={(p) => {
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setParams({ payment: p.id });
          }}
          empty={emptyState}
        />
      )}
      <PaymentDrawer
        paymentId={paymentId}
        row={rows.find((p) => p.id === paymentId) ?? null}
        onClose={() => setParams({ payment: null })}
        onOpenDispute={(id) => setParams({ payment: null, dispute: id })}

        onOpenPayout={tabState.openPayout}
        returnFocusRef={openerRef}
        extraActions={() => <DrawerAttentionActions items={drawerItems} />}
        hideRefund={drawerItems.some((item) => visibleActions(item).includes('refund_again'))}
      />
      <DisputeDrawer disputeId={disputeId} onClose={() => setParams({ dispute: null })} returnFocusRef={openerRef} />
    </div>
  );
}
