/**
 * A stand-in for `GET /api/tasks` in the frontend suites (mobile slice 72).
 *
 * The Tasks List tab asks the server for one page at a time (`?limit=&offset=` plus the filters),
 * the other views still ask for the whole list (no `limit`). A suite that mocks `api.get` hands
 * this the tasks the "server" holds and gets both answers in the wire shape the real endpoint
 * sends, so the test reads the list the way the browser now does - through a request - without
 * hand-building `{ tasks, page }` bodies.
 *
 * By default it does NOT filter: the filters run on the real server, and a suite that only checks
 * what the browser ASKS for (read `api.get.mock.calls`) and what it does with the answer needs no
 * more. With `filtered: true` it narrows the way the browser used to before the list moved to the
 * server - the same `applyTaskFilter` + `listRows` the other tabs still run - so a suite about
 * what a filter SHOWS keeps its meaning end to end: the facet the user ticks becomes a request
 * parameter, and the rows come back narrowed by that parameter. The real server's own filtering is
 * pinned in backend/src/__tests__/tasks-list-page.test.ts and, against a real database, in the
 * mobile gate's tasks-list-cards.spec.ts.
 */
import type { Task, TaskPerson } from '@/lib/tasks/types';
import type { TaskRow } from '@/lib/api/tasks';
import { applyTaskFilter, type TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { listRows } from '@/lib/tasks/taskViewRows';

/** The inverse of `mapRowToTask`, for the fields a list reads. */
export function taskToRow(t: Task): TaskRow {
  return {
    id: t.id,
    task_number: t.task_number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assignee_ids: t.assignee_ids,
    assignees: t.assignees,
    watcher_ids: t.watcher_ids,
    due_at: t.due_at,
    linked_entity_type: t.linked_entity?.type ?? null,
    linked_entity_id: t.linked_entity?.id ?? null,
    linked_entity_label: t.linked_entity ? t.linked_entity.label : null,
    linked_entity_redacted: t.linked_entity?.redacted ?? false,
    tags: t.tags,
    category: t.category ?? null,
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
    completed_at: t.completed_at,
    attachment_count: t.attachment_count,
  };
}

/** What a mocked `api.get` receives as its second argument (an axios request config). */
export interface ListRequestConfig { params?: unknown }

export interface TaskListRequestParams {
  limit?: number | string;
  offset?: number | string;
  [key: string]: unknown;
}

/** True for a request the List tab makes (it always sends `limit`). */
export const isTaskListPageRequest = (url: string, config?: ListRequestConfig): boolean =>
  url === '/api/tasks' && (config?.params as TaskListRequestParams | undefined)?.limit !== undefined;

export interface AnswerOptions {
  /** Narrow the page by the request's filter parameters. Default: serve every task. */
  filtered?: boolean;
  /** The org's people, for the department filter. */
  people?: TaskPerson[];
}

const on = (v: unknown): boolean => v === true || v === 'true';
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The tasks a list request's filters leave, with the category facet applied or left open. */
function narrow(tasks: Task[], p: TaskListRequestParams, opts: AnswerOptions, withCategory: boolean): Task[] {
  const base = applyTaskFilter(
    tasks,
    {
      memberId: text(p.member_id) || 'all',
      departmentId: text(p.department_id) || 'all',
      categoryIds: withCategory && p.category_ids ? text(p.category_ids).split(',') : [],
      category: (text(p.drill) || 'all') as TaskDrillDown,
      overdue: on(p.overdue),
      atRisk: on(p.at_risk),
      dueFrom: text(p.due_from),
      dueTo: text(p.due_to),
      createdFrom: text(p.created_from),
      createdTo: text(p.created_to),
    },
    opts.people ?? [],
    new Date(),
  );
  return listRows(base, text(p.q));
}

/** The answer to `GET /api/tasks`: one page when `limit` is sent, the whole list when it is not. */
export function answerTasksRequest(tasks: Task[], config?: ListRequestConfig, opts: AnswerOptions = {}) {
  const params = (config?.params ?? {}) as TaskListRequestParams;
  const limit = params.limit;
  if (limit === undefined) return { data: { tasks: tasks.map(taskToRow) } };

  const matching = opts.filtered ? narrow(tasks, params, opts, true) : tasks;
  const size = Number(limit);
  const offset = Number(params.offset ?? 0);
  const slice = matching.slice(offset, offset + size);
  // Counted with every OTHER facet applied and Category left open.
  const counted = opts.filtered ? narrow(tasks, params, opts, false) : tasks;
  // Counted here, not with the app's own `countTasksByCategory`: a suite may be watching that one.
  const counts: Record<string, number> = {};
  for (const t of counted) counts[t.category?.id ?? 'none'] = (counts[t.category?.id ?? 'none'] ?? 0) + 1;
  return {
    data: {
      tasks: slice.map(taskToRow),
      page: { limit: size, offset, total: matching.length, has_more: offset + slice.length < matching.length },
      ...(offset === 0 ? { category_counts: counts } : {}),
    },
  };
}
