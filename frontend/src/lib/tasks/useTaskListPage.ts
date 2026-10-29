import { useCallback, useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { listTasksPage, type TaskListPage } from '@/lib/api/tasks';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

import type { Task } from './types';
import { taskListFilterParams } from './taskListQuery';
import { useSelectedTaskCategoryIds } from './useFilteredTasks';

/**
 * How many tasks one request brings. A page is what a phone holds and paints at a time; the list
 * asks for the next one as the reader scrolls (mobile slice 72).
 */
export const TASK_LIST_PAGE_SIZE = 25;

/** Every cached page of the List tab sits under this key, so one prefix invalidates them all. */
export const TASK_LIST_PAGE_KEY = ['tasks', 'list-page'] as const;

/** How long a typed search waits for the next keystroke before it asks the server. */
const SEARCH_DEBOUNCE_MS = 300;

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/**
 * The List tab's rows: a bounded, server-filtered page at a time, never the whole organisation.
 *
 * The filters and the search are the SAME stores the other tabs read (`taskFilterStore`,
 * `taskViewStore`); they are sent to the server instead of being applied to a list held in the
 * browser, so changing one starts again at the first page of the new answer. The rows themselves
 * come from the server; the tasks store is read only to show a row's freshest edit at once (an
 * edit made in the drawer), and its writes (`revision`) make the list ask the server again so a
 * task that no longer matches leaves and a new one arrives in order.
 *
 * `watchWrites` is for the one reader that owns the list on screen; a second reader of the same
 * cache (the Filter window's category counts) leaves it off.
 */
export function useTaskListPage({ watchWrites = false }: { watchWrites?: boolean } = {}) {
  const queryClient = useQueryClient();

  const memberId = useTaskFilterStore((s) => s.memberId);
  const departmentId = useTaskFilterStore((s) => s.departmentId);
  const category = useTaskFilterStore((s) => s.category);
  const overdue = useTaskFilterStore((s) => s.overdue);
  const atRisk = useTaskFilterStore((s) => s.atRisk);
  const dueFrom = useTaskFilterStore((s) => s.dueFrom);
  const dueTo = useTaskFilterStore((s) => s.dueTo);
  const createdFrom = useTaskFilterStore((s) => s.createdFrom);
  const createdTo = useTaskFilterStore((s) => s.createdTo);
  const categoryIds = useSelectedTaskCategoryIds();
  const search = useDebounce(useTaskViewStore((s) => s.listSearch), SEARCH_DEBOUNCE_MS);

  const filters = useMemo(
    () => taskListFilterParams(
      { memberId, departmentId, categoryIds, category, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo },
      search,
    ),
    [memberId, departmentId, categoryIds, category, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo, search],
  );

  const query = useInfiniteQuery({
    queryKey: [...TASK_LIST_PAGE_KEY, filters],
    initialPageParam: 0,
    // Changing a filter keeps the rows on screen until the new first page arrives, rather than
    // blanking the list under the reader's thumb.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => listTasksPage({ ...filters, limit: TASK_LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (last: TaskListPage) =>
      // An empty page that still says "more" would ask for the same offset forever.
      last.hasMore && last.tasks.length > 0 ? last.offset + last.tasks.length : undefined,
  });

  // A write elsewhere on the Tasks page (a create, a status or due-date change, a delete) can move
  // a row in, out or along the list, so ask again. Skipped for the first render.
  const revision = useTasksStore((s) => s.revision);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (!watchWrites || seenRevision.current === revision) return;
    seenRevision.current = revision;
    void queryClient.invalidateQueries({ queryKey: TASK_LIST_PAGE_KEY });
  }, [watchWrites, revision, queryClient]);

  const stored = useTasksStore((s) => s.tasks);
  const rows = useMemo<Task[]>(() => {
    const fresh = new Map(stored.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const t of page.tasks) {
        // Offset paging can hand the same row twice if one was added while the reader scrolled.
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(fresh.get(t.id) ?? t);
      }
    }
    return out;
  }, [query.data, stored]);

  // Stable, so a watcher on the end of the list is not torn down and rebuilt on every render.
  const { fetchNextPage: fetchNext, refetch } = query;
  const fetchNextPage = useCallback(() => { void fetchNext(); }, [fetchNext]);
  const retry = useCallback(() => { void refetch(); }, [refetch]);

  const first = query.data?.pages[0];
  const categoryCounts = useMemo<ReadonlyMap<string, number>>(
    () => (first?.categoryCounts ? new Map(Object.entries(first.categoryCounts)) : NO_COUNTS),
    [first],
  );

  return {
    rows,
    /** Every task the filters match, across all pages (not just the ones loaded). */
    total: query.data?.pages[query.data.pages.length - 1]?.total ?? 0,
    categoryCounts,
    /** No page has arrived yet. */
    isLoading: query.isPending,
    /** The first page failed and there is nothing to show. */
    isError: query.isError && !query.data,
    /** The NEXT page failed; the rows already loaded stay on screen. */
    nextPageFailed: query.isFetchNextPageError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage,
    retry,
  };
}
