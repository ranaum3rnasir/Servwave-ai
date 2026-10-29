import type { TaskListPageParams } from '@/lib/api/tasks';
import type { TaskDrillDown } from './tasks-logic';

/** The Filter window's state, as `taskFilterStore` holds it (`'all'` and `''` mean "not set"). */
export interface TaskListFilterInput {
  memberId: string;
  departmentId: string;
  /** The Category facet, already read through the live category list. */
  categoryIds: string[];
  /** The Dashboard KPI drill-down. */
  category: TaskDrillDown | undefined;
  overdue: boolean;
  atRisk: boolean;
  dueFrom: string;
  dueTo: string;
  createdFrom: string;
  createdTo: string;
}

/**
 * The List tab's filters and search as the server's query: the same facets
 * `applyTaskFilter` + `listRows` used to apply in the browser, so the rows the server pages are
 * the rows the browser used to show. Only a constraint that is ON is in the result, so the same
 * filters always make the same query (and the same cache key).
 */
export function taskListFilterParams(
  f: TaskListFilterInput,
  search: string,
): Omit<TaskListPageParams, 'limit' | 'offset'> {
  const params: Omit<TaskListPageParams, 'limit' | 'offset'> = {};
  if (f.memberId && f.memberId !== 'all') params.member_id = f.memberId;
  if (f.departmentId && f.departmentId !== 'all') params.department_id = f.departmentId;
  if (f.categoryIds.length > 0) params.category_ids = f.categoryIds;
  if (f.category && f.category !== 'all') params.drill = f.category;
  if (f.overdue) params.overdue = true;
  if (f.atRisk) params.at_risk = true;
  if (f.dueFrom) params.due_from = f.dueFrom;
  if (f.dueTo) params.due_to = f.dueTo;
  if (f.createdFrom) params.created_from = f.createdFrom;
  if (f.createdTo) params.created_to = f.createdTo;
  const q = search.trim();
  if (q) params.q = q;
  return params;
}
