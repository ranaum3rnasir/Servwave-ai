/**
 * The v2 (/tasks hub) drawer's delete control.
 *
 * The drawer's own header comment used to list "there is NO delete control" as a
 * known gap. That gap made the DELETE endpoint's row-level escape hatch
 * unreachable from the UI: a TECHNICIAN holds no `delete Task` grant, and a task
 * must always keep at least one assignee, so a todo item they opened for themselves
 * could be neither deleted nor handed away.
 *
 * What is pinned here is the GATE, which must match `task.controller.remove`'s
 * two arms exactly - the `delete` grant, or creator-AND-sole-assignee - and must
 * never be a `role === 'ADMIN'` test, which custom roles are invisible to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { TaskDetailDrawer } from '../components/taskDetailDrawer';

/** The signed-in user in the harness (src/__tests__/setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';

const mockFetchTaskDetail = vi.fn().mockResolvedValue(undefined);
const mockDeleteTask = vi.fn().mockResolvedValue(undefined);
const noop = vi.fn().mockResolvedValue(undefined);

const TASK = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: '',
  status: 'TODO' as const,
  priority: 'HIGH' as const,
  assignee_ids: ['u1'],
  assignees: [{ id: 'u1', name: 'Oved Adani' }],
  watcher_ids: [],
  watchers: [],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [],
  comments: [],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

let mockTasks: (typeof TASK)[] = [TASK];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: () => ({
    tasks: mockTasks,
    fetchTaskDetail: mockFetchTaskDetail,
    deleteTask: mockDeleteTask,
    addComment: noop,
    addSubtask: noop,
    toggleSubtask: noop,
    deleteSubtask: noop,
    setAssignees: noop,
    setWatchers: noop,
    nudge: noop,
    updateTask: noop,
    updateStatus: noop,
  }),
}));

vi.mock('@/stores/taskDetailStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

// The people widget fetches its own roster; not the subject here.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id, value }: { id?: string; value: string[] }) => (
    <div data-testid={id ?? 'multi-assignee-select'}>{value.join(',')}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK];
  mockDeleteTask.mockResolvedValue(undefined);
});

describe('v2 TaskDetailDrawer delete control', () => {
  const deleteGrant = () => buildAbility([{ action: 'delete', subject: 'Task' }]);

  it('is HIDDEN for a user with neither the grant nor the ownership exception', () => {
    // Default fixture is created by / assigned to 'u1', who is not ME, and no
    // ability is passed -> emptyAbility -> can('delete','Task') is false.
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByRole('button', { name: /^delete task$/i })).not.toBeInTheDocument();
  });

  it('is SHOWN for the creator who is the task\'s sole assignee, with no grant at all', () => {
    mockTasks = [{ ...TASK, created_by: ME, assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }] }];
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByRole('button', { name: /^delete task$/i })).toBeInTheDocument();
  });

  it('is HIDDEN for the creator once somebody ELSE is also assigned', () => {
    mockTasks = [{
      ...TASK,
      created_by: ME,
      assignee_ids: [ME, 'u9'],
      assignees: [{ id: ME, name: 'Test Admin' }, { id: 'u9', name: 'Sam' }],
    }];
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByRole('button', { name: /^delete task$/i })).not.toBeInTheDocument();
  });

  it('is SHOWN for a holder of the `delete` grant on somebody else\'s task', () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });
    expect(screen.getByRole('button', { name: /^delete task$/i })).toBeInTheDocument();
  });

  it('confirms - naming the comments and activity that go with it - before deleting', async () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });

    await userEvent.click(screen.getByRole('button', { name: /^delete task$/i }));
    expect(mockDeleteTask).not.toHaveBeenCalled();

    expect(await screen.findByText(/Delete T00001\?/)).toBeInTheDocument();
    expect(screen.getByText(/every comment, every file and its whole activity history/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(mockDeleteTask).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(useTaskDetailStore.getState().close).toHaveBeenCalled());
  });

  it('does NOT close the drawer when the server refuses (403)', async () => {
    mockDeleteTask.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 403, data: { error: 'Insufficient permissions' } },
      }),
    );

    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });
    await userEvent.click(screen.getByRole('button', { name: /^delete task$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /delete permanently/i }));

    await waitFor(() => expect(mockDeleteTask).toHaveBeenCalledWith('t1'));
    expect(useTaskDetailStore.getState().close).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Fix the valve')).toBeInTheDocument();
  });

  it('can be backed out of without deleting anything', async () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });
    await userEvent.click(screen.getByRole('button', { name: /^delete task$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /keep task/i }));

    await waitFor(() => expect(screen.queryByText(/Delete T00001\?/)).not.toBeInTheDocument());
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(useTaskDetailStore.getState().close).not.toHaveBeenCalled();
  });
});
