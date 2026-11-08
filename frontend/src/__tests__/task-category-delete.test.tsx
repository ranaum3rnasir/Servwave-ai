/**
 * Deleting a task category (visits-and-task-categories slice 11), frontend half.
 *
 * Every row of the manage panel shows how many tasks use the category and offers Delete. The
 * delete dialog states the count split into open and done and offers three choices: keep the
 * tasks (the default), move them to another category, or also delete them - the last behind the
 * typed category name, with a button that names the number of tasks. Afterwards the task store
 * both task UIs render from follows: kept tasks lose the chip, moved tasks carry the new one,
 * deleted tasks are gone (and an open drawer on one of them closes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { TaskCategoryManager } from '@/components/tasks/TaskCategoryManager';
import type { TaskCategoryRow } from '@/lib/api/taskCategories';
import type { Task, TaskCategoryRef } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import ListView from '@/pages/v2/tasks/views/listView';
import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';
import PaymentsListsPage from '@/pages/v2/settings/PaymentsListsPage';
import { buildAbility } from '@/lib/ability';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

const ME = '00000000-0000-0000-0000-000000000001';
const FOLLOW_UP: TaskCategoryRef = { id: 'cat-follow', name: 'Follow-up', color: '#22C55E' };
const PART_ORDER: TaskCategoryRef = { id: 'cat-parts', name: 'Part order', color: '#F97316' };
const INTERNAL: TaskCategoryRef = { id: 'cat-internal', name: 'Internal', color: '#6B7280' };

const ORG = {
  id: 'o1', stripe_account_id: null, accepted_payment_methods: ['CASH'], source_options: ['Google'],
  job_type_options: [], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

/** The server's list with each category's counts; the mocked DELETE removes from it. */
let serverList: TaskCategoryRow[];
const REAL_TASK_ACTIONS = { ...useTasksStore.getState() };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', task_number: 'T00001', title: 'Order the hinge kit', description: '',
    status: 'TODO', priority: 'MEDIUM', assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }],
    watcher_ids: [], due_at: null, linked_entity: null, tags: [], category: PART_ORDER, subtasks: [],
    created_by: ME, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    completed_at: null, activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

/** What the API answers for a delete, given the tasks in the store that carry the category. */
function deleteAnswer(id: string, body: { mode: string; target_id?: string }) {
  serverList = serverList.filter((c) => c.id !== id);
  const inCategory = useTasksStore.getState().tasks.filter((t) => t.category?.id === id);
  return {
    data: {
      mode: body.mode,
      task_count: inCategory.length,
      target: body.mode === 'move' ? serverList.find((c) => c.id === body.target_id) ?? null : null,
      deleted_task_ids: body.mode === 'delete_tasks' ? inCategory.map((t) => t.id) : [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serverList = [
    { ...FOLLOW_UP, sort_order: 0, task_counts: { open: 1, done: 0 } },
    { ...PART_ORDER, sort_order: 1, task_counts: { open: 11, done: 3 } },
    { ...INTERNAL, sort_order: 2, task_counts: { open: 0, done: 0 } },
  ];
  useTasksStore.setState({ ...REAL_TASK_ACTIONS, tasks: [], loaded: true, loading: false });
  useTaskDetailStore.setState({ openTaskId: null });
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/task-categories'
      ? Promise.resolve({ data: { categories: serverList.map((c) => ({ ...c })) } })
      : url === '/api/organization'
        ? Promise.resolve({ data: ORG })
        : Promise.resolve({ data: { tasks: [], users: [], departments: [] } }),
  );
  mockApi.delete.mockImplementation((url: string, config?: { data?: { mode: string; target_id?: string } }) => {
    const id = url.replace('/api/task-categories/', '');
    if (!config?.data) throw new Error('a category delete always sends its mode');
    return Promise.resolve(deleteAnswer(id, config.data));
  });
});

const openDelete = async (name: string) => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Delete ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: `Delete "${name}"?` });
  return { user, dialog };
};

describe('the manage panel rows', () => {
  it('show how many tasks use each category, and a Delete action', async () => {
    renderWithProviders(<TaskCategoryManager />);

    const list = await screen.findByRole('list', { name: 'Task categories' });
    const row = (name: string) => within(list).getByText(name).closest('li') as HTMLElement;
    await waitFor(() => expect(within(row('Part order')).getByText('14 tasks')).toBeInTheDocument());
    expect(within(row('Follow-up')).getByText('1 task')).toBeInTheDocument();
    expect(within(row('Internal')).getByText('0 tasks')).toBeInTheDocument();
    for (const name of ['Follow-up', 'Part order', 'Internal']) {
      expect(within(row(name)).getByRole('button', { name: `Delete ${name}` })).toBeInTheDocument();
    }
  });

  it('offer Delete in both places the panel opens: the Tasks page dialog and the Settings card', async () => {
    const user = userEvent.setup();
    const hub = renderWithProviders(<TasksHubPage />, { ability: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Task categories' });
    expect(await within(dialog).findByRole('button', { name: 'Delete Part order' })).toBeInTheDocument();
    hub.unmount();

    renderWithProviders(<PaymentsListsPage />, { ability: ADMIN });
    expect(await screen.findByRole('button', { name: 'Delete Part order' })).toBeInTheDocument();
  });
});

describe('the delete dialog', () => {
  it('states the open and done counts, and keeps the tasks by default', async () => {
    renderWithProviders(<TaskCategoryManager />);
    const { dialog } = await openDelete('Part order');

    expect(within(dialog).getByText('14 tasks use this category: 11 open, 3 done.')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Keep the tasks/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('radio', { name: /Move them to another category/ })).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByRole('radio', { name: /Also delete the 14 tasks/ })).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByRole('button', { name: 'Delete category' })).toBeEnabled();
  });

  it('re-reads the counts when it opens, so the numbers it states are current', async () => {
    renderWithProviders(<TaskCategoryManager />);
    await screen.findByText('14 tasks');
    serverList = serverList.map((c) => (c.id === PART_ORDER.id ? { ...c, task_counts: { open: 12, done: 3 } } : c));

    const { dialog } = await openDelete('Part order');

    await waitFor(() => expect(within(dialog).getByText('15 tasks use this category: 12 open, 3 done.')).toBeInTheDocument());
  });

  it('keep: deletes the category and the tasks lose their chip', async () => {
    useTasksStore.setState({
      tasks: [makeTask(), makeTask({ id: 't2', title: 'Call the lab', category: FOLLOW_UP })],
      loaded: true,
    });
    renderWithProviders(<><TaskCategoryManager /><ListView /></>);
    const { user, dialog } = await openDelete('Part order');

    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/task-categories/cat-parts', { data: { mode: 'keep' } }));
    await waitFor(() =>
      expect(within(screen.getByRole('row', { name: /Order the hinge kit/ })).queryByTestId('task-category-chip')).not.toBeInTheDocument(),
    );
    expect(useTasksStore.getState().tasks.map((t) => t.category)).toEqual([null, FOLLOW_UP]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Part order')).not.toBeInTheDocument());
  });

  it('move: sends the chosen category and the tasks carry its chip', async () => {
    useTasksStore.setState({ tasks: [makeTask()], loaded: true });
    renderWithProviders(<><TaskCategoryManager /><ListView /></>);
    const { user, dialog } = await openDelete('Part order');

    await user.click(within(dialog).getByRole('radio', { name: /Move them to another category/ }));
    expect(within(dialog).getByText('Pick a category for all 14.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete category' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('combobox', { name: 'Move the tasks to' }));
    // The category being deleted is not a destination.
    expect(screen.queryByRole('option', { name: 'Part order' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Follow-up' }));
    await user.click(confirm);

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith('/api/task-categories/cat-parts', {
        data: { mode: 'move', target_id: 'cat-follow' },
      }),
    );
    await waitFor(() =>
      expect(within(screen.getByRole('row', { name: /Order the hinge kit/ })).getByTestId('task-category-chip'))
        .toHaveTextContent('Follow-up'),
    );
    expect(useTasksStore.getState().tasks[0].category).toEqual(FOLLOW_UP);
  });

  it('delete the tasks: the button names the count and stays disabled until the name is typed exactly', async () => {
    renderWithProviders(<TaskCategoryManager />);
    const { user, dialog } = await openDelete('Part order');

    await user.click(within(dialog).getByRole('radio', { name: /Also delete the 14 tasks/ }));
    expect(within(dialog).getByText("Their comments, subtasks and files are deleted too. This can't be undone.")).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete category and 14 tasks' });
    expect(confirm).toBeDisabled();

    const field = within(dialog).getByRole('textbox', { name: 'Type Part order to confirm' });
    await user.type(field, 'part order');
    expect(confirm).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'Part orde');
    expect(confirm).toBeDisabled();
    await user.type(field, 'r');
    expect(confirm).toBeEnabled();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('delete the tasks: sends the typed name and the count it showed, and the tasks leave the store and the list', async () => {
    useTasksStore.setState({
      tasks: [makeTask(), makeTask({ id: 't2', title: 'Call the lab', category: FOLLOW_UP })],
      loaded: true,
    });
    useTaskDetailStore.setState({ openTaskId: 't1' });
    renderWithProviders(<><TaskCategoryManager /><ListView /></>);
    const { user, dialog } = await openDelete('Part order');

    await user.click(within(dialog).getByRole('radio', { name: /Also delete the 14 tasks/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Type Part order to confirm' }), 'Part order');
    await user.click(within(dialog).getByRole('button', { name: 'Delete category and 14 tasks' }));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith('/api/task-categories/cat-parts', {
        data: { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 14 },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('row', { name: /Order the hinge kit/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /Call the lab/ })).toBeInTheDocument();
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(['t2']);
    // The drawer that was open on a deleted task closes.
    expect(useTaskDetailStore.getState().openTaskId).toBeNull();
  });

  it('delete the tasks: when the count moved since the dialog opened, re-reads it and says so', async () => {
    renderWithProviders(<TaskCategoryManager />);
    const { user, dialog } = await openDelete('Part order');
    await user.click(within(dialog).getByRole('radio', { name: /Also delete the 14 tasks/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Type Part order to confirm' }), 'Part order');
    // A task joined the category after the dialog read its count.
    serverList = serverList.map((c) => (c.id === PART_ORDER.id ? { ...c, task_counts: { open: 12, done: 3 } } : c));
    mockApi.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 409'), {
        response: {
          status: 409,
          data: {
            error: 'The number of tasks in this category changed. Check the new count and try again.',
            code: 'TASK_COUNT_CHANGED',
          },
        },
      }),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Delete category and 14 tasks' }));

    expect(
      await within(dialog).findByText('The number of tasks in this category changed. Check the new count and try again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText('15 tasks use this category: 12 open, 3 done.')).toBeInTheDocument());
    expect(within(dialog).getByRole('button', { name: 'Delete category and 15 tasks' })).toBeInTheDocument();
    expect(useTasksStore.getState().tasks).toEqual([]);
  });

  it('a category no task uses is deleted with a plain confirmation', async () => {
    renderWithProviders(<TaskCategoryManager />);
    const { user, dialog } = await openDelete('Internal');

    expect(within(dialog).getByText('No tasks use this category.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/task-categories/cat-internal', { data: { mode: 'keep' } }));
  });

  it('shows the server\'s refusal in the dialog and keeps it open', async () => {
    mockApi.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: 'The name you typed does not match the category.' } },
      }),
    );
    renderWithProviders(<TaskCategoryManager />);
    const { user, dialog } = await openDelete('Part order');

    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));

    expect(await within(dialog).findByText('The name you typed does not match the category.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete "Part order"?' })).toBeInTheDocument();
  });
});
