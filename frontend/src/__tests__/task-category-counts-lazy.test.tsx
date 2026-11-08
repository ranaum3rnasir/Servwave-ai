/**
 * Code review #10: the Filter trigger is mounted on every Tasks tab at all times, so the Category
 * facet's per-category counts - the hub filter plus the open tab's own rows, recomputed on every
 * render - must only be taken while someone is looking at them: with the Filter window open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import * as tasksLogic from '@/lib/tasks/tasks-logic';

vi.mock('@/lib/tasks/tasks-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks/tasks-logic')>();
  return { ...actual, countTasksByCategory: vi.fn(actual.countTasksByCategory) };
});
vi.mock('@/pages/v2/tasks/views/dashboardView', () => ({ default: () => <div data-testid="dashboard-view" /> }));

import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

const ME = '00000000-0000-0000-0000-000000000001';
const FOLLOW_UP = { id: '11111111-1111-4111-8111-111111111111', name: 'Follow-up', color: '#22C55E' };

function row(id: string, title: string, category: typeof FOLLOW_UP | null) {
  return {
    id, task_number: `T-${id}`, title, description: '', status: 'TODO', priority: 'MEDIUM',
    assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }], watcher_ids: [],
    due_at: null, linked_entity_type: null, linked_entity_id: null, category,
    created_by: ME, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    completed_at: null,
  };
}
const ROWS = [row('a', 'Call back about the quote', FOLLOW_UP), row('b', 'Sweep the shop', null)];

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  useTaskFilterStore.getState().reset();
  useTaskViewStore.getState().reset();
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url === '/api/tasks') return Promise.resolve({ data: { tasks: ROWS } }) as ReturnType<typeof api.get>;
    if (url === '/api/task-categories') {
      return Promise.resolve({ data: { categories: [{ ...FOLLOW_UP, sort_order: 0 }] } }) as ReturnType<typeof api.get>;
    }
    return Promise.resolve({ data: { users: [], tasks: [], departments: [] } }) as ReturnType<typeof api.get>;
  });
});

describe('the Category counts are taken only while the Filter window is open', () => {
  it('none while it is shut - through load, a tab switch and a search - then counts once it opens', async () => {
    renderWithProviders(<TasksHubPage />);
    await waitFor(() => expect(useTasksStore.getState().tasks).toHaveLength(ROWS.length));
    fireEvent.click(within(screen.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'List' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'call' } });
    await screen.findByText('Call back about the quote');

    expect(tasksLogic.countTasksByCategory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
    fireEvent.click(await screen.findByRole('tab', { name: /^Category/ }));

    expect(await screen.findByRole('checkbox', { name: 'Follow-up, 1 task' })).toBeInTheDocument();
    expect(tasksLogic.countTasksByCategory).toHaveBeenCalled();
  });
});
