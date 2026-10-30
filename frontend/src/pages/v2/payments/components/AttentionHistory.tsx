import { useMemo, useState } from 'react';
import { CheckCircle2, SearchX } from 'lucide-react';

import { useAttention, type AttentionItem, type AttentionParams, type AttentionView } from '@/lib/api/paymentsPage';
import { extractApiError } from '@/lib/utils';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';

import { LoadError } from '../../_shared/loadError';
import { itemTarget } from './attentionRow';
import { buildAttentionColumns } from './attentionColumns';

export const HISTORY_PAGE_SIZE = 25;

/**
 * The Needs attention table (payments go-live P7): every open or resolved item, server-paged 25 at a time. The search
 * and the type come from the toolbar. A row opens the same drawer its card title does.
 */
export function AttentionHistory({
  view, q, types, timeZone, onOpen, onClear,
}: {
  view: AttentionView;
  q: string;
  types: AttentionParams['type'];
  timeZone: string;
  onOpen: (target: Record<string, string>) => void;
  onClear: () => void;
}) {
  // A page number only means something under the filters it was picked for; changing any of them reads as page 1.
  const scope = JSON.stringify([view, q, types]);
  const [pageState, setPageState] = useState({ scope, page: 1 });
  const page = pageState.scope === scope ? pageState.page : 1;

  const params = useMemo<AttentionParams>(
    () => ({ page, limit: HISTORY_PAGE_SIZE, ...(q ? { q } : {}), ...(types?.length ? { type: types } : {}) }),
    [page, q, types],
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
          description="Search or choose a type to narrow"
        />
      );
    }
    return <LoadError title="Couldn’t load these items." onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  }

  const narrowed = Boolean(q) || Boolean(types?.length);
  const empty = narrowed ? (
    <EmptyState
      icon={<SearchX />}
      title="No items match"
      action={<Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={onClear}>Clear filters</Button>}
    />
  ) : (
    <EmptyState icon={<CheckCircle2 />} title={view === 'open' ? 'Nothing needs attention' : 'No resolved items yet'} />
  );

  return (
    <DataTable<AttentionItem, unknown>
      columns={columns}
      data={items}
      getRowId={(item) => item.key}
      isLoading={list.isPending}
      isFetching={list.isFetching}
      page={page}
      pageCount={pagination?.totalPages ?? 1}
      onPageChange={(next) => setPageState({ scope, page: next })}
      pageSize={HISTORY_PAGE_SIZE}
      hidePageSize
      rowCount={pagination?.total ?? 0}
      mobileCards
      rowsFocusable
      isRowClickable={(item) => itemTarget(item) != null}
      onRowClick={(item) => {
        const target = itemTarget(item);
        if (target) onOpen(target);
      }}
      empty={empty}
    />
  );
}
