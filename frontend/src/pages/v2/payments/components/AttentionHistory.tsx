import { useMemo, useState } from 'react';
import { CheckCircle2, SearchX } from 'lucide-react';

import { useAttention, type AttentionItem, type AttentionParams, type AttentionView } from '@/lib/api/paymentsPage';
import { extractApiError } from '@/lib/utils';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';

import { LoadError } from '../../_shared/loadError';
import { stackForItem } from '../drawerStack';
import { buildAttentionColumns } from './attentionColumns';
import { useScrollTableIntoView } from '../useScrollTableIntoView';

export const HISTORY_PAGE_SIZE = 25;

/**
 * The Needs attention table (payments go-live P7): every open or resolved item, server-paged 25 at a time. The search
 * comes from the toolbar. A row opens the same drawer its card title does.
 */
export function AttentionHistory({
  view, q, timeZone, onOpen, onClear,
}: {
  view: AttentionView;
  q: string;
  timeZone: string;
  onOpen: (item: AttentionItem) => void;
  onClear: () => void;
}) {
  // A page number only means something under the filters it was picked for; changing any of them reads as page 1.
  const scope = JSON.stringify([view, q]);
  const [pageState, setPageState] = useState({ scope, page: 1 });
  const page = pageState.scope === scope ? pageState.page : 1;
  const { ref: tableTopRef, request: scrollTableTop } = useScrollTableIntoView();

  const params = useMemo<AttentionParams>(
    () => ({ page, limit: HISTORY_PAGE_SIZE, ...(q ? { q } : {}) }),
    [page, q],
  );
  const list = useAttention(view, params);
  const columns = useMemo(() => buildAttentionColumns({ timeZone }), [timeZone]);
  const items = list.data?.items ?? [];
  const pagination = list.data?.pagination;

  if (list.isError && !list.data) {
    const status = (list.error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 400) {
      return (
        <EmptyState
          icon={<SearchX />}
          title={extractApiError(list.error, 'That is further than the list goes.')}
          description="Search to narrow"
        />
      );
    }
    return <LoadError title="Couldn’t load these items." onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  }

  const empty = q ? (
    <EmptyState
      icon={<SearchX />}
      title="No payments match"
      description="Try a different search, filter or period."
      action={<Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={onClear}>Clear filters</Button>}
    />
  ) : (
    <EmptyState icon={<CheckCircle2 />} title={view === 'open' ? 'Nothing needs attention' : 'No resolved items yet'} />
  );

  // No rows: the empty state alone, not under a "Showing 0-0 of 0" pager.
  if (!list.isPending && list.data && items.length === 0) {
    return <div ref={tableTopRef} className="bg-kit-card overflow-hidden rounded-lg border shadow-sm">{empty}</div>;
  }

  return (
    <div ref={tableTopRef}>
      <DataTable<AttentionItem, unknown>
        columns={columns}
        data={items}
        getRowId={(item) => item.key}
        isLoading={list.isPending}
        isFetching={list.isFetching}
        page={page}
        pageCount={pagination?.totalPages ?? 1}
        onPageChange={(next) => { setPageState({ scope, page: next }); scrollTableTop(); }}
        pageSize={HISTORY_PAGE_SIZE}
        hidePageSize
        rowCount={pagination?.total ?? 0}
        mobileCards
        rowsFocusable
        isRowClickable={(item) => stackForItem(item) != null}
        onRowClick={onOpen}
        empty={empty}
      />
    </div>
  );
}
