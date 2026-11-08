import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { ListPagerProps } from './components/listPager';

/**
 * The customer page's server-paged lists (visits slice 06). Both keys sit under the prefixes the
 * shared visit-write refresh (`lib/refreshAfterVisitWrite.ts`) invalidates, so every page of both
 * lists goes stale on a visit write, a job create or a job/lead delete.
 */
export type CustomerList = 'customer-jobs' | 'customer-leads';

/** The page size a list opens with - the 20 the page used to cap each list at. */
export const CUSTOMER_LIST_PAGE_SIZE = 20;

export function customerListPageKey(list: CustomerList, customerId: string, page: number, limit: number) {
  return [list, customerId, { page, limit }] as const;
}

export interface CustomerListPage<T> {
  rows: T[];
  /** Every row the reader can open, across all pages. */
  total: number;
}

/**
 * What a paged list's tab renders.
 *  - `loading`: rows exist but none are on screen yet (the first load, or a step back in flight).
 *  - `error`: the request failed and there is nothing to show - an error, never "No jobs yet.".
 *  - `ready`: the rows (possibly none: then the list is genuinely empty).
 */
export type CustomerListStatus = 'loading' | 'error' | 'ready';

export interface CustomerListView<T> {
  rows: T[];
  status: CustomerListStatus;
  /**
   * The page whose request failed while an earlier page is still on screen (with its pager), or
   * null. The tab names it and offers Retry rather than wiping the list it can still show.
   */
  failedPage: number | null;
  /** Re-requests the page that failed. */
  onRetry: () => void;
  pager: ListPagerProps;
}

/**
 * One list's page state and its current page. Called from the page component, not from the tab:
 * only the active tab is mounted, so state kept in the page is what lets a tab return to the page
 * it was on after the user looks at another tab.
 */
export function useCustomerListPage<T>({ list, customerId, enabled, fetchPage }: {
  list: CustomerList;
  customerId: string;
  enabled: boolean;
  fetchPage: (page: number, limit: number) => Promise<CustomerListPage<T>>;
}): CustomerListView<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CUSTOMER_LIST_PAGE_SIZE);
  // The last page this list actually showed - what stays on screen when the next page fails.
  const [lastShown, setLastShown] = useState<{ page: number; data: CustomerListPage<T> } | null>(null);
  // Another customer's page opens on page 1 (the route reuses this component across ids).
  const [pagedCustomer, setPagedCustomer] = useState(customerId);
  if (pagedCustomer !== customerId) {
    setPagedCustomer(customerId);
    setPage(1);
    setLastShown(null);
  }

  const query = useQuery({
    queryKey: customerListPageKey(list, customerId, page, pageSize),
    queryFn: () => fetchPage(page, pageSize),
    enabled,
    // The previous page stays on screen while the next one loads; the pager shows the spinner.
    placeholderData: keepPreviousData,
  });
  const ownData = query.isPlaceholderData ? undefined : query.data;
  if (ownData && lastShown?.data !== ownData) setLastShown({ page, data: ownData });

  // Data wins over a failed background refetch; with no data of its own, a failure is a failure.
  const failed = query.isError && !ownData;
  // The page on screen when the next one failed: keep it, with its own pager, rather than wipe it.
  const kept = failed && lastShown && lastShown.page !== page && lastShown.data.rows.length > 0 ? lastShown : null;
  const shownPage = kept ? kept.page : page;
  const data = kept ? kept.data : query.data;

  const total = data?.total ?? 0;
  // A delete can leave the current page past the new end (its last row gone): step back to the
  // new last page instead of showing an empty page. Judged on this page's own answer only, never
  // on the previous page's rows still shown while it loads.
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (ownData && page > lastPage) setPage(lastPage);

  const rows = data?.rows ?? [];
  let status: CustomerListStatus = 'ready';
  if (failed && !kept) status = 'error';
  // No rows on screen yet for a list that has some: the first load, or the step back above while
  // the earlier page loads (the emptied page is the placeholder). "No jobs yet." is for a total of
  // zero only.
  else if (query.isLoading || (rows.length === 0 && total > 0)) status = 'loading';

  return {
    rows,
    status,
    failedPage: kept ? page : null,
    onRetry: () => { void query.refetch(); },
    pager: {
      page: shownPage,
      pageSize,
      total,
      // Asking again for the page that just failed is a retry, not a no-op.
      onPageChange: (next) => (next === page ? void query.refetch() : setPage(next)),
      onPageSizeChange: (size) => {
        setPageSize(size);
        setPage(1);
      },
      isFetching: query.isFetching,
    },
  };
}
