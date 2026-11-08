/**
 * Each Tasks tab's own row rule (lib/tasks/taskViewRows), which the tab draws with and the Filter
 * popover counts with. The hub-level test (task-category-filter) proves count === rows per tab;
 * these pin the rules themselves at their edges.
 */
import { describe, it, expect } from 'vitest';

import {
  boardRows,
  calendarRows,
  listRows,
  myDayRows,
  taskViewRows,
  type TaskViewContext,
} from '@/lib/tasks/taskViewRows';
import type { Task } from '@/lib/tasks/types';

const ME = 'u-me';
const NOW = new Date(2026, 8, 16, 12, 0, 0); // Wed 16 Sep 2026, local noon

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't', task_number: 'T00001', title: 'x', description: '', status: 'TODO', priority: 'MEDIUM',
    assignee_ids: [ME], assignees: [{ id: ME, name: 'Me' }], watcher_ids: [],
    due_at: '2026-09-16T00:00:00.000Z', linked_entity: null, tags: [], category: null, subtasks: [],
    created_by: ME, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
    completed_at: null, activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}
const ids = (tasks: Task[]) => tasks.map((t) => t.id).sort();

describe('myDayRows', () => {
  it('keeps my open tasks due today or overdue; drops tomorrow, undated, finished and not-mine', () => {
    const tasks = [
      makeTask({ id: 'today' }),
      makeTask({ id: 'overdue', due_at: '2026-09-10T00:00:00.000Z' }),
      makeTask({ id: 'tomorrow', due_at: '2026-09-17T00:00:00.000Z' }),
      makeTask({ id: 'undated', due_at: null }),
      makeTask({ id: 'done', status: 'DONE', completed_at: '2026-09-15T00:00:00.000Z' }),
      makeTask({ id: 'cancelled', status: 'CANCELLED' }),
      makeTask({ id: 'theirs', assignee_ids: ['u-other'], assignees: [{ id: 'u-other', name: 'O' }] }),
    ];
    expect(ids(myDayRows(tasks, ME, NOW))).toEqual(['overdue', 'today']);
  });
});

describe('boardRows', () => {
  it('drops cancelled tasks and tasks closed before the 7-day Done window, keeps an undated DONE', () => {
    const tasks = [
      makeTask({ id: 'open' }),
      makeTask({ id: 'cancelled', status: 'CANCELLED' }),
      makeTask({ id: 'done-recent', status: 'DONE', completed_at: '2026-09-12T12:00:00.000Z' }),
      makeTask({ id: 'done-old', status: 'DONE', completed_at: '2026-09-01T00:00:00.000Z' }),
      makeTask({ id: 'done-no-date', status: 'DONE', completed_at: null }),
    ];
    expect(ids(boardRows(tasks, NOW))).toEqual(['done-no-date', 'done-recent', 'open']);
  });
});

describe('listRows', () => {
  it('matches title, any assignee and the linked label; blank search keeps all', () => {
    const tasks = [
      makeTask({ id: 'title', title: 'Replace the closer' }),
      makeTask({ id: 'person', assignees: [{ id: ME, name: 'Priya Nair' }] }),
      makeTask({ id: 'link', linked_entity: { type: 'JOB', id: 'j', label: 'Closer install' } }),
      makeTask({ id: 'none', title: 'Sweep' }),
    ];
    expect(ids(listRows(tasks, '  closer '))).toEqual(['link', 'title']);
    expect(ids(listRows(tasks, 'priya'))).toEqual(['person']);
    expect(listRows(tasks, '   ')).toHaveLength(4);
  });
});

describe('calendarRows', () => {
  const tasks = [
    makeTask({ id: 'sep-01', due_at: '2026-09-01T00:00:00.000Z' }),
    makeTask({ id: 'sep-13-sun', due_at: '2026-09-13T00:00:00.000Z' }),
    makeTask({ id: 'sep-16', due_at: '2026-09-16T15:00:00.000Z' }),
    makeTask({ id: 'sep-19-sat', due_at: '2026-09-19T23:59:00.000Z' }),
    makeTask({ id: 'sep-20-sun', due_at: '2026-09-20T00:00:00.000Z' }),
    makeTask({ id: 'oct-01', due_at: '2026-10-01T00:00:00.000Z' }),
    makeTask({ id: 'undated', due_at: null }),
  ];
  const anchor = new Date('2026-09-16T12:00:00.000Z');

  it('Month: due in the UTC month, plus the unscheduled strip', () => {
    expect(ids(calendarRows(tasks, 'month', anchor)))
      .toEqual(['sep-01', 'sep-13-sun', 'sep-16', 'sep-19-sat', 'sep-20-sun', 'undated']);
  });

  it('Week: Sunday to Saturday (UTC), no unscheduled strip', () => {
    expect(ids(calendarRows(tasks, 'week', anchor))).toEqual(['sep-13-sun', 'sep-16', 'sep-19-sat']);
  });

  it('Day: that UTC day only', () => {
    expect(ids(calendarRows(tasks, 'day', anchor))).toEqual(['sep-16']);
  });
});

describe('taskViewRows', () => {
  const ctx: TaskViewContext = {
    viewerId: ME, now: NOW, listSearch: '', calendarMode: 'month', calendarAnchor: NOW,
    historyScope: 'mine', historyRange: '30d', historySearch: '',
  };

  it('History: closed tasks in range and scope; the Dashboard draws no rows of its own', () => {
    const tasks = [
      makeTask({ id: 'open' }),
      makeTask({ id: 'done', status: 'DONE', completed_at: '2026-09-15T00:00:00.000Z' }),
      makeTask({ id: 'done-long-ago', status: 'DONE', completed_at: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(ids(taskViewRows('history', tasks, ctx))).toEqual(['done']);
    expect(taskViewRows('dashboard', tasks, ctx)).toBe(tasks);
  });
});
