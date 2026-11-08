/**
 * Task categories, frontend half (visits-and-task-categories slice 08).
 *
 * A task has at most one category. The creator picks it in the create dialog, an editor changes
 * or clears it in the drawer, and everyone sees it as a colored chip on board cards, list rows,
 * My Day and the drawer - in BOTH task UIs: the Tasks page (pages/v2/tasks) and the legacy
 * components the Job/Lead Tasks tabs mount (components/tasks). The Calendar view is not tinted.
 * The picker offers only existing categories; creating one is slice 09.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import type { Task, TaskCategoryRef } from '@/lib/tasks/types';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';

const ME = '00000000-0000-0000-0000-000000000001';
const FOLLOW_UP: TaskCategoryRef = { id: 'cat-follow', name: 'Follow-up', color: '#22C55E' };
const PART_ORDER: TaskCategoryRef = { id: 'cat-parts', name: 'Part order', color: '#F97316' };
const INTERNAL: TaskCategoryRef = { id: 'cat-internal', name: 'Internal', color: '#6B7280' };
const LIST = [FOLLOW_UP, PART_ORDER, INTERNAL].map((c, i) => ({ ...c, sort_order: i }));

// "Today" the way My Day computes it (myDayView.tsx): the LOCAL calendar day, written as that
// day's UTC midnight - the form a due date is stored in. `new Date().toISOString()` is the UTC
// day instead, which is already tomorrow on an evening west of Greenwich, so My Day hid the task.
const todayIso = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString();
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    task_number: 'T00001',
    title: 'Order the hinge kit',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    assignee_ids: [ME],
    assignees: [{ id: ME, name: 'Test Admin' }],
    watcher_ids: [],
    due_at: todayIso(),
    linked_entity: null,
    tags: [],
    category: PART_ORDER,
    subtasks: [],
    created_by: ME,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks - `mockTasks` is read at render time so each test sets its own fixture.
// ---------------------------------------------------------------------------
let mockTasks: Task[] = [];
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockAddTask = vi.fn();
const noop = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => {
    const state = {
      tasks: mockTasks,
      loaded: true,
      loading: false,
      updateTask: mockUpdateTask,
      addTask: mockAddTask,
      updateStatus: noop,
      fetchTaskDetail: noop,
      deleteTask: noop,
      addComment: noop,
      addSubtask: noop,
      toggleSubtask: noop,
      deleteSubtask: noop,
      setAssignees: noop,
      setWatchers: noop,
      nudge: noop,
    };
    return sel ? sel(state) : state;
  }),
}));

vi.mock('@/stores/taskDetailStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id, value }: { id?: string; value: string[] }) => (
    <div data-testid={id ?? 'multi-assignee-select'}>{value.join(',')}</div>
  ),
}));

import { TaskCard as V2TaskCard } from '@/pages/v2/tasks/components/taskCard';
import { TaskDetailDrawer as V2TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';
import ListView from '@/pages/v2/tasks/views/listView';
import MyDayView from '@/pages/v2/tasks/views/myDayView';
import CalendarView from '@/pages/v2/tasks/views/calendarView';
import { TaskCard as LegacyTaskCard } from '@/components/tasks/TaskCard';
import { TaskDetailDrawer as LegacyTaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [makeTask()];
  mockAddTask.mockResolvedValue(makeTask());
  (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
    url === '/api/task-categories'
      ? Promise.resolve({ data: { categories: LIST } })
      : Promise.resolve({ data: {} }),
  );
});

/** The chip is the category's name, marked by a dot in the category's own color (slice 09 mockup). */
function expectChip(container: HTMLElement, category: TaskCategoryRef) {
  const chip = within(container).getByTestId('task-category-chip');
  expect(chip).toHaveTextContent(category.name);
  expect(within(chip).getByTestId('task-category-dot')).toHaveStyle({ backgroundColor: category.color });
}

describe('the payload carries the category', () => {
  it('a task row keeps its category (id, name, color), and none reads as null', () => {
    const row = { id: 't1', category: PART_ORDER } as unknown as TaskRow;
    expect(mapRowToTask(row).category).toEqual(PART_ORDER);
    expect(mapRowToTask({ ...row, category: null }).category).toBeNull();
  });
});

describe('the chip shows everywhere a task is listed - Tasks page', () => {
  it('on a board card', () => {
    const { container } = renderWithProviders(<V2TaskCard task={makeTask()} />);
    expectChip(container, PART_ORDER);
  });

  it('on a board card with no category, no chip', () => {
    renderWithProviders(<V2TaskCard task={makeTask({ category: null })} />);
    expect(screen.queryByTestId('task-category-chip')).not.toBeInTheDocument();
  });

  it('on a list row', () => {
    renderWithProviders(<ListView />);
    expectChip(screen.getByRole('row', { name: /Order the hinge kit/ }), PART_ORDER);
  });

  it('on My Day', () => {
    const { container } = renderWithProviders(<MyDayView />);
    expectChip(container, PART_ORDER);
  });

  it('in the drawer', () => {
    renderWithProviders(<V2TaskDetailDrawer />);
    expectChip(screen.getByRole('dialog'), PART_ORDER);
  });

  it('but the Calendar view is not tinted by category', () => {
    const { container } = renderWithProviders(<CalendarView />);
    expect(screen.queryByTestId('task-category-chip')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(PART_ORDER.color);
    expect(container.innerHTML).not.toContain('rgb(249, 115, 22)');
  });
});

describe('the chip shows in the legacy task UI (Job/Lead Tasks tabs)', () => {
  it('on a card', () => {
    const { container } = renderWithProviders(<LegacyTaskCard task={makeTask()} />);
    expectChip(container, PART_ORDER);
  });

  it('in the drawer', () => {
    renderWithProviders(<LegacyTaskDetailDrawer />);
    expectChip(screen.getByRole('dialog'), PART_ORDER);
  });
});

describe.each([
  ['Tasks page drawer', V2TaskDetailDrawer],
  ['legacy drawer', LegacyTaskDetailDrawer],
])('%s - change or clear the category', (_name, Drawer) => {
  it('changes it', async () => {
    renderWithProviders(<Drawer />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Follow-up' }));
    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { category: FOLLOW_UP });
  });

  it('clears it', async () => {
    renderWithProviders(<Drawer />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('option', { name: 'No category' }));
    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { category: null });
  });

  it('offers only the existing categories - no create option', async () => {
    renderWithProviders(<Drawer />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'No category', 'Follow-up', 'Part order', 'Internal',
    ]);
    expect(within(screen.getByRole('listbox')).queryByText(/add|create|new/i)).not.toBeInTheDocument();
  });
});

describe.each([
  ['Tasks page', CreateTaskDialog],
  ['legacy', CreateTaskModal],
])('%s create dialog - pick a category', (_name, Dialog) => {
  it('sends the picked category with the new task', async () => {
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Task title'), 'Chase the supplier');
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Part order' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockAddTask).toHaveBeenCalled());
    expect(mockAddTask.mock.calls[0][0].category_id).toBe(PART_ORDER.id);
  });

  it('creates without one when none is picked', async () => {
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Task title'), 'Chase the supplier');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockAddTask).toHaveBeenCalled());
    expect(mockAddTask.mock.calls[0][0].category_id ?? null).toBeNull();
  });

  it('offers no create option', async () => {
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'No category', 'Follow-up', 'Part order', 'Internal',
    ]);
  });
});
