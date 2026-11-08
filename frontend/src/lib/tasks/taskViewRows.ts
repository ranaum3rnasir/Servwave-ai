import { matchesAssignee } from './assignees';
import { rankMyDay, selectCompletionLog, type CompletionRange, type CompletionScope } from './tasks-logic';
import { BOARD_TASK_STATUSES, isCompletedTaskStatus, isTerminalTaskStatus, type Task } from './types';

/**
 * Which of the hub-filtered tasks each Tasks tab actually draws - one pure function per tab.
 *
 * Every tab first reads the shared Filter through `useFilteredTasks`, then narrows by its own
 * rule: My Day to what is due, the Board to its lanes, the Calendar to its period, and so on.
 * Those rules live HERE, and both the tab and the Filter popover's per-category counts call
 * them (slice 10), so a count is always exactly the rows that ticking the category shows. A
 * rule written inside a view instead would let the two drift, which is the bug this exists for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// My Day
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' of the UTC day a task is due on, or null. Due dates are days, stored at UTC. */
function dueDay(dueAt: string | null | undefined): string | null {
  return dueAt ? dueAt.slice(0, 10) : null;
}

/**
 * My Day: the viewer's own open tasks due today or already overdue, in `rankMyDay` order.
 *
 * "Today" is the viewer's LOCAL calendar day written as that day's UTC date - the form a due
 * date is stored in. No due date at all is unscheduled work, not today's.
 */
export function myDayRows(tasks: Task[], viewerId: string, now: Date): Task[] {
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
  return rankMyDay(tasks, viewerId, now).filter((task) => {
    if (isTerminalTaskStatus(task.status)) return false;
    const day = dueDay(task.due_at);
    return day !== null && day <= today;
  });
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * How far back the Board's Done lane reaches.
 *
 * Done is the only lane that never drains, so on any board more than a few weeks old it grew to
 * several times the height of every other column and the board's own scrollbar became useless.
 * A week is the window in which "did that get finished?" is still a live question; everything
 * closed before it is history, and the History tab is the surface for history.
 */
export const BOARD_DONE_WINDOW_DAYS = 7;

/** A status the Board has a lane for. Cancelled has none (issue 03). */
export function hasBoardLane(task: Task): boolean {
  return BOARD_TASK_STATUSES.includes(task.status);
}

/**
 * A finished task closed before the Done lane's window. A DONE task with no `completed_at` is
 * kept rather than guessed at - dropping it would lose it from every board surface at once.
 */
export function closedBeforeBoardWindow(task: Task, now: Date): boolean {
  if (!isCompletedTaskStatus(task.status)) return false;
  const closed = task.completed_at ? new Date(task.completed_at).getTime() : NaN;
  return Number.isFinite(closed) && closed < now.getTime() - BOARD_DONE_WINDOW_DAYS * DAY_MS;
}

/** The Board: every task with a lane, less the ones closed before the Done window. */
export function boardRows(tasks: Task[], now: Date): Task[] {
  return tasks.filter((t) => hasBoardLane(t) && !closedBeforeBoardWindow(t, now));
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** The List: its search box over title, ANY assignee and the linked-entity label. */
export function listRows(tasks: Task[], search: string): Task[] {
  const q = search.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      matchesAssignee(t, q) ||
      (t.linked_entity?.label ?? '').toLowerCase().includes(q),
  );
}

// ---------------------------------------------------------------------------
// Calendar - every date here is UTC, as the view has always drawn it
// ---------------------------------------------------------------------------

export type CalendarMode = 'day' | 'week' | 'month';

/** The Sunday that starts the week containing `d` (UTC). */
export function calendarWeekStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
}

/**
 * The Calendar: tasks due inside the period on screen. The Month view also lists the tasks with
 * no due date under "Unscheduled"; the Week and Day views do not.
 */
export function calendarRows(tasks: Task[], mode: CalendarMode, anchor: Date): Task[] {
  let from: number;
  let to: number;
  if (mode === 'month') {
    from = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1);
    to = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1);
  } else if (mode === 'week') {
    from = calendarWeekStart(anchor).getTime();
    to = from + 7 * DAY_MS;
  } else {
    from = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
    to = from + DAY_MS;
  }
  return tasks.filter((t) => {
    if (!t.due_at) return mode === 'month';
    const due = new Date(t.due_at).getTime();
    return due >= from && due < to;
  });
}

// ---------------------------------------------------------------------------
// Every tab
// ---------------------------------------------------------------------------

/** The Tasks hub's tabs. */
export type TaskViewKey = 'my-day' | 'board' | 'list' | 'calendar' | 'history' | 'dashboard';

/** Everything besides the task list that decides a tab's rows. */
export interface TaskViewContext {
  viewerId: string;
  now: Date;
  listSearch: string;
  calendarMode: CalendarMode;
  calendarAnchor: Date;
  historyScope: CompletionScope;
  historyRange: CompletionRange;
  historySearch: string;
}

/**
 * The tasks `view` draws from `tasks` (the hub-filtered list for that tab). The Dashboard draws
 * no rows, only aggregates over the whole list, so it answers with the list itself.
 */
export function taskViewRows(view: TaskViewKey, tasks: Task[], ctx: TaskViewContext): Task[] {
  switch (view) {
    case 'my-day': return myDayRows(tasks, ctx.viewerId, ctx.now);
    case 'board': return boardRows(tasks, ctx.now);
    case 'list': return listRows(tasks, ctx.listSearch);
    case 'calendar': return calendarRows(tasks, ctx.calendarMode, ctx.calendarAnchor);
    case 'history':
      return selectCompletionLog(
        tasks,
        { scope: ctx.historyScope, viewerId: ctx.viewerId, range: ctx.historyRange, search: ctx.historySearch },
        ctx.now,
      ).map((e) => e.task);
    case 'dashboard': return tasks;
  }
}
