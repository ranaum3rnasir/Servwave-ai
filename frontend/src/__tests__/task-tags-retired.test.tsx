/**
 * Tags are retired from both task UIs (visits-and-task-categories slice 10).
 *
 * Category replaced the Tag filter, and with it go the drawer's read-only Tags row and the History
 * view's tag badges - on the Tasks page and in the legacy components the Job/Lead Tasks tabs mount.
 * The tags column stays in the database (dropping it is a later cleanup), so a task can still
 * ARRIVE carrying tags; none of them may be drawn, searched or written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { createTask } from '@/lib/api/tasks';
import type { Task } from '@/lib/tasks/types';

const ME = '00000000-0000-0000-0000-000000000001';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', task_number: 'T00001', title: 'Replace the closer', description: '',
    status: 'DONE', priority: 'MEDIUM',
    assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }], watcher_ids: [],
    due_at: null, linked_entity: null,
    tags: ['warranty-legacy'],
    category: null, subtasks: [],
    created_by: ME, created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    completed_at: new Date(Date.now() - 86_400_000).toISOString(),
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

let mockTasks: Task[] = [];
const noop = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => {
    const state = {
      tasks: mockTasks, loaded: true, loading: false,
      updateTask: noop, addTask: noop, updateStatus: noop, fetchTaskDetail: noop, deleteTask: noop,
      addComment: noop, addSubtask: noop, toggleSubtask: noop, deleteSubtask: noop,
      setAssignees: noop, setWatchers: noop, nudge: noop,
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

import { TaskDetailDrawer as V2TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';
import { TaskDetailDrawer as LegacyTaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import HistoryView from '@/pages/v2/tasks/views/historyView';

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [makeTask()];
  useTaskViewStore.getState().reset();
  vi.mocked(api).get.mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof api.get>>);
  vi.mocked(api).post.mockResolvedValue({ data: { task: { id: 'new' } } } as Awaited<ReturnType<typeof api.post>>);
});

describe.each([
  ['Tasks page drawer', V2TaskDetailDrawer],
  ['legacy drawer', LegacyTaskDetailDrawer],
])('%s', (_name, Drawer) => {
  it('has no Tags row, even for a task that still carries tags', () => {
    mockTasks = [makeTask({ status: 'TODO', completed_at: null })];
    renderWithProviders(<Drawer />);
    expect(screen.getByRole('dialog')).toHaveTextContent('T00001');
    expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    expect(screen.queryByText('warranty-legacy')).not.toBeInTheDocument();
  });
});

describe('History view', () => {
  it('draws no tag badge on a closed task that carries tags', () => {
    renderWithProviders(<HistoryView />);
    expect(screen.getByText('Replace the closer')).toBeInTheDocument();
    expect(screen.queryByText('warranty-legacy')).not.toBeInTheDocument();
  });

  it('neither offers nor matches a tag search', () => {
    renderWithProviders(<HistoryView />);
    const search = screen.getByRole('searchbox');
    expect(search.getAttribute('placeholder') ?? '').not.toMatch(/tag/i);
    fireEvent.change(search, { target: { value: 'warranty-legacy' } });
    expect(screen.queryByText('Replace the closer')).not.toBeInTheDocument();
  });
});

describe('nothing writes tags', () => {
  it('creating a task sends no tags key', async () => {
    await createTask({ title: 'New one' });
    const body = vi.mocked(api).post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('tags');
  });
});
