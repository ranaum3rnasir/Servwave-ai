/**
 * Issue 03 - CANCELLED task status, frontend half.
 *
 * The enum value is the small part. DONE was hard-coded as "the terminal status" at every
 * frontend site that means "not finished", each in its own words, so adding a value made all of
 * them wrong by exactly one. What is pinned here is that they now agree:
 *
 *   - a cancelled task is not open, not overdue and not at risk, so it is absent from the KPI
 *     tiles, the per-assignee load and the My Day list;
 *   - reopening it to TODO puts it straight back into all of them;
 *   - it appears on History next to the completed ones and cannot be mistaken for one;
 *   - it has no board column, and the board does not render it at all;
 *   - the drawer's existing status control is how it is both reached and left.
 *
 * The fixtures deliberately give the cancelled task a PAST due date and a null `completed_at`,
 * which is the shape the backend actually writes (`completed_at` means the work finished, and a
 * cancellation never finished).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import {
  BOARD_TASK_STATUSES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isCompletedTaskStatus,
  isTerminalTaskStatus,
  type Task,
  type TaskStatus,
} from '@/lib/tasks/types';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import {
  applyTaskFilter,
  assessRisk,
  assigneeOpenCounts,
  computeStats,
  isOverdue,
  rankMyDay,
  selectCompletionLog,
  taskClosedAt,
} from '@/lib/tasks/tasks-logic';

/** The signed-in user in the harness (src/__tests__/setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-06-07T12:00:00.000Z');

function makeTask(overrides: Partial<Task> & { id: string; status: TaskStatus }): Task {
  return {
    task_number: overrides.id.toUpperCase(),
    title: `Task ${overrides.id}`,
    description: '',
    priority: 'MEDIUM',
    assignee_ids: [ME],
    assignees: [{ id: ME, name: 'Test Admin' }],
    watcher_ids: [],
    due_at: null,
    linked_entity: null,
    tags: [],
    subtasks: [],
    created_by: ME,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-06T09:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

/** Open, overdue, and therefore at risk - the control the cancelled twin is compared against. */
const OPEN_OVERDUE = makeTask({ id: 'open', status: 'TODO', due_at: '2026-06-01T00:00:00.000Z' });
/** Byte-identical except for the status. */
const CANCELLED_OVERDUE = makeTask({ id: 'cancelled', status: 'CANCELLED', due_at: '2026-06-01T00:00:00.000Z' });
const COMPLETED = makeTask({
  id: 'done',
  status: 'DONE',
  due_at: '2026-06-06T00:00:00.000Z',
  completed_at: '2026-06-05T18:00:00.000Z',
});

/**
 * Render fixtures are dated against the REAL clock, not `NOW`.
 *
 * Both rendered surfaces window themselves on `Date.now()` - History opens on the last 30 days
 * and the board's Done lane reaches back 7 - so a fixture pinned to a fixed date falls out of
 * both the moment the calendar moves past it, and the test would pass today and fail in a month.
 */
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const RECENT_DONE = makeTask({
  id: 'done',
  status: 'DONE',
  due_at: hoursAgo(48),
  completed_at: hoursAgo(24),
  updated_at: hoursAgo(24),
});
const RECENT_CANCELLED = makeTask({
  id: 'cancelled',
  status: 'CANCELLED',
  due_at: hoursAgo(48),
  updated_at: hoursAgo(12),
});

// ---------------------------------------------------------------------------
// Mocks. `mockTasks` is read at render time so each test may set its own fixture.
// ---------------------------------------------------------------------------

let mockTasks: Task[] = [];
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
const noop = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@/lib/tasks/taskAI', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks/taskAI')>('@/lib/tasks/taskAI');
  return { ...actual, taskAI: { ...actual.taskAI, rollup: () => 'This week summary' } };
});

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => {
    const state = {
      tasks: mockTasks,
      loaded: true,
      loading: false,
      updateStatus: mockUpdateStatus,
      fetchTaskDetail: noop,
      deleteTask: noop,
      addComment: noop,
      addSubtask: noop,
      toggleSubtask: noop,
      deleteSubtask: noop,
      setAssignees: noop,
      setWatchers: noop,
      nudge: noop,
      updateTask: noop,
    };
    return sel ? sel(state) : state;
  }),
}));

vi.mock('@/stores/taskFilterStore', () => {
  const state = {
    memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
    overdue: false, atRisk: false, dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
    setMember: vi.fn(), setDepartment: vi.fn(), setCategoryIds: vi.fn(), setCategory: vi.fn(),
    reset: vi.fn(),
  };
  return { useTaskFilterStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

vi.mock('@/stores/taskDetailStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const store = create(() => ({ openTaskId: 'cancelled', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id, value }: { id?: string; value: string[] }) => (
    <div data-testid={id ?? 'multi-assignee-select'}>{value.join(',')}</div>
  ),
}));

import BoardView from '@/pages/v2/tasks/views/boardView';
import DashboardView from '@/pages/v2/tasks/views/dashboardView';
import HistoryView from '@/pages/v2/tasks/views/historyView';
import { TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [];
});

// ---------------------------------------------------------------------------

describe('the terminal-status constant is the only enumeration of finished statuses', () => {
  it('carries both finished statuses and nothing else', () => {
    expect(TERMINAL_TASK_STATUSES).toEqual(['DONE', 'CANCELLED']);
    expect(TASK_STATUSES).toContain('CANCELLED');
  });

  it('is the same list the status registry paints, so neither can gain a value alone', () => {
    // The registry is already pinned to the Prisma enum by
    // design-system/__tests__/status-registry-schema-guard.test.ts. Tying TASK_STATUSES to the
    // registry closes the chain enum -> registry -> the list every status <Select> renders: a
    // value that reaches the wire with no option to choose it is unreachable from the UI, and
    // an option the enum lacks is a 400 on save. Neither is visible from either end alone.
    expect([...TASK_STATUSES]).toEqual(Object.keys(STATUS_REGISTRY.task));
  });

  it('separates "finished either way" from "actually completed"', () => {
    expect(isTerminalTaskStatus('CANCELLED')).toBe(true);
    expect(isTerminalTaskStatus('DONE')).toBe(true);
    expect(isTerminalTaskStatus('TODO')).toBe(false);
    // The narrow one. A cancelled task delivered nothing, so it is not a completion.
    expect(isCompletedTaskStatus('CANCELLED')).toBe(false);
    expect(isCompletedTaskStatus('DONE')).toBe(true);
  });
});

describe('a cancelled task is closed, not open', () => {
  it('is not overdue however far past its due date it is', () => {
    expect(isOverdue(OPEN_OVERDUE, NOW)).toBe(true);
    expect(isOverdue(CANCELLED_OVERDUE, NOW)).toBe(false);
  });

  it('scores no risk at all', () => {
    expect(assessRisk(OPEN_OVERDUE, { now: NOW, assigneeOpenCount: 9 }).atRisk).toBe(true);
    expect(assessRisk(CANCELLED_OVERDUE, { now: NOW, assigneeOpenCount: 9 }))
      .toEqual({ score: 0, reason: null, atRisk: false });
  });

  it('does not count against its assignee\'s open load', () => {
    const counts = assigneeOpenCounts([OPEN_OVERDUE, CANCELLED_OVERDUE, COMPLETED]);
    expect(counts.get(ME)).toBe(1);
  });

  it('is absent from the open category filter and from My Day', () => {
    const tasks = [OPEN_OVERDUE, CANCELLED_OVERDUE];
    const filtered = applyTaskFilter(tasks, {
      memberId: 'all', departmentId: 'all', categoryIds: [], category: 'open',
    }, [], NOW);
    expect(filtered.map((t) => t.id)).toEqual(['open']);
    expect(rankMyDay(tasks, ME, NOW).map((t) => t.id)).toEqual(['open']);
  });

  it('leaves the on-time rate describing delivered work only', () => {
    // The cancelled task is past due with no completion. Were it counted as a closure it would
    // halve a rate that is supposed to say how much delivered work landed on time.
    expect(computeStats([COMPLETED, CANCELLED_OVERDUE], NOW).onTimePct).toBe(100);
  });

  it('returns to the open counts the moment it is reopened to TODO', () => {
    const reopened = { ...CANCELLED_OVERDUE, status: 'TODO' as const };
    expect(computeStats([reopened], NOW).open).toBe(1);
    expect(assigneeOpenCounts([reopened]).get(ME)).toBe(1);
    expect(isOverdue(reopened, NOW)).toBe(true);
  });
});

describe('the KPI tiles', () => {
  it('count one open task, not two, when one of the pair is cancelled', () => {
    mockTasks = [OPEN_OVERDUE, CANCELLED_OVERDUE];
    renderWithProviders(<DashboardView />);
    expect(within(screen.getByRole('button', { name: /Open/i })).getByText('1')).toBeInTheDocument();
  });
});

describe('History holds both kinds of closure and keeps them apart', () => {
  it('logs a cancellation, dated by `updated_at` since `completed_at` is null by design', () => {
    expect(taskClosedAt(CANCELLED_OVERDUE)?.toISOString()).toBe('2026-06-06T09:00:00.000Z');

    const log = selectCompletionLog(
      [COMPLETED, CANCELLED_OVERDUE, OPEN_OVERDUE],
      { scope: 'everyone', viewerId: ME, range: 'all', search: '' },
      NOW,
    );
    expect(log.map((e) => [e.task.id, e.outcome])).toEqual([
      ['cancelled', 'CANCELLED'],
      ['done', 'DONE'],
    ]);
  });

  it('still drops a DONE row that carries no completed_at', () => {
    // The guard the old `status !== 'DONE' || !completed_at` test existed for. Adding CANCELLED
    // to that comparison rather than replacing it would have kept this guard AND excluded every
    // cancellation, since a cancellation never has a completed_at either.
    const ghost = makeTask({ id: 'ghost', status: 'DONE', completed_at: null });
    expect(taskClosedAt(ghost)).toBeNull();
    expect(selectCompletionLog([ghost], { scope: 'everyone', viewerId: ME, range: 'all', search: '' }, NOW))
      .toHaveLength(0);
  });

  it('renders the two outcomes with different chips and strikes the abandoned title', () => {
    mockTasks = [RECENT_DONE, RECENT_CANCELLED];
    renderWithProviders(<HistoryView />);

    const doneRow = screen.getByText('Task done').closest('tr')!;
    const cancelledRow = screen.getByText('Task cancelled').closest('tr')!;

    expect(within(doneRow).getByText('Done')).toBeInTheDocument();
    expect(within(cancelledRow).getByText('Cancelled')).toBeInTheDocument();

    // Not colour alone: the abandoned title is struck through as well.
    expect(screen.getByText('Task cancelled').className).toMatch(/line-through/);
    expect(screen.getByText('Task done').className).not.toMatch(/line-through/);
  });
});

describe('the board', () => {
  it('gives CANCELLED no column', () => {
    expect(BOARD_TASK_STATUSES).not.toContain('CANCELLED');
    expect(BOARD_TASK_STATUSES).toContain('DONE');
  });

  it('renders no Cancelled lane and no card for a cancelled task', () => {
    mockTasks = [OPEN_OVERDUE, RECENT_CANCELLED, RECENT_DONE];
    renderWithProviders(<BoardView />);

    // Lane headings, not any text: "Done" also appears on the completed card's own status chip.
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cancelled' })).not.toBeInTheDocument();
    expect(screen.getByText('Task done')).toBeInTheDocument();
    // Not merely lane-less: the card is nowhere on the board, chip included.
    expect(screen.queryByText('Task cancelled')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
  });
});

describe('the drawer status control is the way in and the way out', () => {
  it('offers Cancelled and sends CANCELLED when it is chosen', async () => {
    mockTasks = [{ ...OPEN_OVERDUE, id: 'cancelled' }];
    renderWithProviders(<TaskDetailDrawer />);

    await userEvent.click(screen.getByRole('combobox', { name: /change status/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Cancelled' }));

    expect(mockUpdateStatus).toHaveBeenCalledWith('cancelled', 'CANCELLED');
  });

  it('sends TODO when a cancelled task is reopened through the same control', async () => {
    mockTasks = [CANCELLED_OVERDUE];
    renderWithProviders(<TaskDetailDrawer />);

    await userEvent.click(screen.getByRole('combobox', { name: /change status/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'To Do' }));

    expect(mockUpdateStatus).toHaveBeenCalledWith('cancelled', 'TODO');
  });
});
