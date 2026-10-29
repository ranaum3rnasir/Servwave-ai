/**
 * SRVW-248 - the v2 task drawer's per-subtask X button used to call `deleteSubtask` straight
 * from `onClick`, with nothing in between. This asserts the mutation does not fire until the
 * confirm dialog is accepted, mirroring TaskDetailDrawer.test.tsx's coverage of the legacy
 * (`@/components/tasks/TaskDetailDrawer`) drawer, which this v2 drawer does not share code with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';

const mockFetchTaskDetail = vi.fn().mockResolvedValue(undefined);
const mockDeleteSubtask = vi.fn().mockResolvedValue(undefined);
const mockToggleSubtask = vi.fn().mockResolvedValue(undefined);
const mockAddSubtask = vi.fn().mockResolvedValue(undefined);
const mockAddComment = vi.fn().mockResolvedValue(undefined);
const mockSetWatchers = vi.fn().mockResolvedValue(undefined);
const mockNudge = vi.fn().mockResolvedValue(undefined);
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);

const TASK = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: 'Needs attention',
  status: 'TODO' as const,
  priority: 'HIGH' as const,
  owner_id: 'u1',
  owner_name: 'Oved Adani',
  watcher_ids: ['u2'],
  watchers: [{ id: 'u2', name: 'Priya' }],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [{ id: 's1', text: 'Order parts', done: false }],
  comments: [],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

let mockTasks = [TASK];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: () => ({
    tasks: mockTasks,
    fetchTaskDetail: mockFetchTaskDetail,
    addComment: mockAddComment,
    addSubtask: mockAddSubtask,
    toggleSubtask: mockToggleSubtask,
    deleteSubtask: mockDeleteSubtask,
    setWatchers: mockSetWatchers,
    nudge: mockNudge,
    updateTask: mockUpdateTask,
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock('@/stores/taskDetailStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

vi.mock('@/components/crm/AssigneeSelect', () => ({
  AssigneeSelect: () => <div data-testid="assignee-select" />,
}));

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: () => <div data-testid="multi-assignee-select" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK];
});

describe('v2 TaskDetailDrawer - subtask delete confirm', () => {
  it('does not delete a subtask until the confirm dialog is accepted', async () => {
    renderWithProviders(<TaskDetailDrawer />);

    const deleteBtn = screen.getByRole('button', { name: /delete subtask/i });
    await userEvent.click(deleteBtn);

    expect(await screen.findByText('Delete "Order parts"?')).toBeInTheDocument();
    expect(mockDeleteSubtask).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(mockDeleteSubtask).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /delete subtask/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockDeleteSubtask).toHaveBeenCalledWith('t1', 's1');
    });
  });
});
