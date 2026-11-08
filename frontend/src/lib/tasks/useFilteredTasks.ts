import { useMemo } from 'react';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { applyTaskFilter, countTasksByCategory, liveCategoryIds } from './tasks-logic';
import { useAssignableUsers } from '@/lib/api/users';
import { useTaskCategories } from '@/lib/api/taskCategories';
import { useAuthStore } from '@/stores/auth.store';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { taskViewRows, type TaskViewKey } from './taskViewRows';

export interface FilteredTasksOptions {
  /** Apply the Dashboard KPI drill-down (`category`). Default true. */
  applyCategory?: boolean;
  /** Narrow to the viewer's own tasks unless a member filter is set. Default false. */
  scopeToSelf?: boolean;
}

/**
 * How each Tasks tab reads the shared filter - the ONE place that says so, because the Filter
 * popover's per-category counts must be taken over exactly the list the open tab shows.
 */
export const TASK_VIEW_FILTER_OPTIONS: Record<TaskViewKey, FilteredTasksOptions> = {
  'my-day': {},
  board: { scopeToSelf: true },
  list: {},
  calendar: {},
  history: { applyCategory: false },
  dashboard: { applyCategory: false },
};

const NO_CATEGORY_SELECTION: string[] = [];

/**
 * The Category facet's selection, less any id the org no longer has.
 *
 * A category deleted (slice 11) while it is ticked - here or in another session - would
 * otherwise keep narrowing the view to a category no task can be in, behind a chip naming a bare
 * id. So the selection is read through the live list: a stale id simply stops counting, and the
 * next tick or untick writes the store without it. A rename needs nothing: the selection holds
 * ids, and every label is resolved from the same list.
 */
export function useSelectedTaskCategoryIds(): string[] {
  const stored = useTaskFilterStore((s) => s.categoryIds);
  const { data: categories } = useTaskCategories();
  return useMemo(() => liveCategoryIds(stored, categories), [stored, categories]);
}

/**
 * `scopeToSelf` narrows the result to tasks the signed-in user is actually on - assignee or
 * watcher. It exists for the Board.
 *
 * The API already scopes this way for everyone EXCEPT an ADMIN, whose `taskVisibilityWhere`
 * short-circuits to the whole org (design section 4). That is right for the List, which is the
 * management surface, and wrong for the Board, which is a personal work surface: an admin in a
 * real org would open it onto every task the company has.
 *
 * An explicit member filter WINS over it. Otherwise the member filter would be dead chrome on
 * the Board - the one tab where "show me Dana's board" is a reasonable thing to ask - and the
 * filter bar is shared by every tab, so it cannot simply be hidden there.
 */
export function useFilteredTasks(options?: FilteredTasksOptions) {
  return useHubFilteredTasks(options, useSelectedTaskCategoryIds());
}

/**
 * Tasks per category - keyed by id, `NO_CATEGORY_FILTER_VALUE` for none - over the ROWS `view` shows:
 * the hub filter with every facet except Category, then the tab's own rule (`taskViewRows`)
 * with its own toolbar state. Each count is therefore exactly what ticking that category shows
 * in that tab. The category facet commutes with every tab rule (all per-task predicates), which
 * is what lets it be left out here and applied in the view.
 */
export function useTaskCategoryCounts(view: TaskViewKey): Map<string, number> {
  const tasks = useHubFilteredTasks(TASK_VIEW_FILTER_OPTIONS[view], NO_CATEGORY_SELECTION);
  const viewerId = useAuthStore((s) => s.user?.id) ?? '';
  const listSearch = useTaskViewStore((s) => s.listSearch);
  const calendarMode = useTaskViewStore((s) => s.calendarMode);
  const calendarAnchor = useTaskViewStore((s) => s.calendarAnchor);
  const historyScope = useTaskViewStore((s) => s.historyScope);
  const historyRange = useTaskViewStore((s) => s.historyRange);
  const historySearch = useTaskViewStore((s) => s.historySearch);
  return useMemo(() => {
    const rows = taskViewRows(view, tasks, {
      viewerId, now: new Date(),
      listSearch, calendarMode, calendarAnchor, historyScope, historyRange, historySearch,
    });
    return countTasksByCategory(rows);
  }, [view, tasks, viewerId, listSearch, calendarMode, calendarAnchor, historyScope, historyRange, historySearch]);
}

function useHubFilteredTasks(options: FilteredTasksOptions | undefined, categoryIds: string[]) {
  const tasks = useTasksStore((s) => s.tasks);
  const memberId = useTaskFilterStore((s) => s.memberId);
  const departmentId = useTaskFilterStore((s) => s.departmentId);
  const category = useTaskFilterStore((s) => s.category);
  const overdue = useTaskFilterStore((s) => s.overdue);
  const atRisk = useTaskFilterStore((s) => s.atRisk);
  const dueFrom = useTaskFilterStore((s) => s.dueFrom);
  const dueTo = useTaskFilterStore((s) => s.dueTo);
  const createdFrom = useTaskFilterStore((s) => s.createdFrom);
  const createdTo = useTaskFilterStore((s) => s.createdTo);
  // `directory`, not `task`: this hook resolves the FILTER state's assignee names for every
  // task view. It never assigns, so no assign grant governs it - `read User` does.
  const { data: rawUsers = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' });

  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';

  const now = useMemo(() => new Date(), []);
  const applyCategory = options?.applyCategory !== false;
  const scopeToSelf = options?.scopeToSelf === true;

  const people = useMemo(
    () => rawUsers.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    })),
    [rawUsers],
  );

  return useMemo(
    () => {
      const filtered = applyTaskFilter(
        tasks,
        {
          memberId, departmentId, categoryIds,
          category: applyCategory ? category ?? 'all' : 'all',
          overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo,
        },
        people,
        now,
      );
      // The filter store's "no filter" sentinel is the STRING 'all', not null or '' - a plain
      // truthiness test here would read the default as an active member filter and disable the
      // self-scope entirely. A real member filter means the user asked for somebody in
      // particular, and wins.
      //
      // No `currentUserId` means auth has not resolved yet; narrowing to nobody would flash an
      // empty board, so leave the list alone and let the next render scope it.
      if (!scopeToSelf || (memberId && memberId !== 'all') || !currentUserId) return filtered;
      return filtered.filter(
        (t) => t.assignee_ids.includes(currentUserId) || t.watcher_ids.includes(currentUserId),
      );
    },
    [tasks, memberId, departmentId, categoryIds, category, applyCategory, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo, people, now, scopeToSelf, currentUserId],
  );
}
