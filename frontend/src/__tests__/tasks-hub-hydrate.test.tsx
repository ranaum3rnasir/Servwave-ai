/**
 * #413 — Tasks dashboard shows 0 open because the Tasks hub never hydrates the
 * task store from the server. The store starts empty and is only ever populated
 * by session-local optimistic adds (store.addTask) / detail fetches, so tasks
 * created in a prior session or on a lead page never reach the main dashboard.
 *
 * Fix: TasksHubPage calls fetchTasks() on mount, so the dashboard reflects the
 * server's tasks. This test asserts the hub issues the GET /api/tasks list call
 * on mount and that the (real) store is hydrated from the response.
 *
 * The tab views are stubbed so the hub's own mount behavior is tested in
 * isolation (recharts' ResponsiveContainer in DashboardView does not render
 * under jsdom). The store and fetchTasks are REAL; only axios is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTasksStore } from '@/stores/tasksStore';

// ── Stub the heavy tab views + side widgets so only the hub shell renders ──
vi.mock('@/pages/tasks/views/DashboardView', () => ({ default: () => <div data-testid="dashboard-view" /> }));
vi.mock('@/pages/tasks/views/BoardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/MyDayView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/ListView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/CalendarView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/HistoryView', () => ({ default: () => <div /> }));
vi.mock('@/components/tasks/AiCommandBar', () => ({ AiCommandBar: () => <div /> }));
vi.mock('@/components/tasks/CreateTaskModal', () => ({ CreateTaskModal: () => <div /> }));
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => <div /> }));

import TasksHubPage from '@/pages/tasks/TasksHubPage';

const SERVER_TASK_ROW = {
  id: 'srv-1',
  task_number: 'T00050',
  title: 'Schedule Approval',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: ['priya-uuid'],
  assignees: [{ id: 'priya-uuid', name: 'Priya Nair' }],
  due_at: '2026-06-24T00:00:00Z',
  linked_entity_type: 'LEAD',
  linked_entity_id: 'lead-700',
  tags: [],
  created_by: 'u1',
  created_at: '2026-06-20T00:00:00Z',
  updated_at: '2026-06-20T00:00:00Z',
  completed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level store to an unhydrated state (as after a page reload).
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url === '/api/tasks') {
      return Promise.resolve({ data: { tasks: [SERVER_TASK_ROW] } }) as ReturnType<typeof api.get>;
    }
    return Promise.resolve({ data: { users: [], tasks: [] } }) as ReturnType<typeof api.get>;
  });
});

describe('Tasks hub hydrates the store from the server on mount (#413)', () => {
  it('issues GET /api/tasks on mount', async () => {
    renderWithProviders(<TasksHubPage />);
    await waitFor(() => {
      expect(vi.mocked(api).get.mock.calls.some((c) => c[0] === '/api/tasks')).toBe(true);
    });
  });

  it('populates the task store from the server response', async () => {
    expect(useTasksStore.getState().tasks).toHaveLength(0);
    renderWithProviders(<TasksHubPage />);
    await waitFor(() => {
      expect(useTasksStore.getState().tasks).toHaveLength(1);
    });
    expect(useTasksStore.getState().tasks[0].title).toBe('Schedule Approval');
  });
});
