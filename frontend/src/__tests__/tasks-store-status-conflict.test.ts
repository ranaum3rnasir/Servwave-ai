/**
 * A status change that lost a race to someone else's (visits-and-task-categories slice 14).
 *
 * `PATCH /api/tasks/:id` moves a status with a compare-and-set. When another person moved the
 * task to a DIFFERENT status first, the server refuses with 409 STATE_CONFLICT and writes nothing.
 * Every live status control - the Tasks page drawer and board, and the legacy drawer and card the
 * entity tabs mount through JobLeadTasksTab - goes through `tasksStore.updateStatus`, so this is
 * the one place the answer has to be handled.
 *
 * Rolling back to the pre-click status would be wrong twice over: the drawer would show a status
 * the task no longer has, and a "please try again" toast invites the user to overwrite the other
 * person's change. The store instead shows the task as the server now holds it, and says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import { toast } from '@/components/ui/use-toast';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

const CONFLICT_MESSAGE = 'This task was changed by someone else. Reload it and try again.';

const ROW: TaskRow = {
  id: 't1',
  task_number: 'T00047',
  title: 'Replace the gate hinge',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: ['u1'],
  assignees: [{ id: 'u1', name: 'Dana Levi' }],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  created_by: 'u1',
  created_at: '2026-09-27T10:00:00Z',
  updated_at: '2026-09-27T10:00:00Z',
  completed_at: null,
};

/** What `GET /api/tasks/:id` answers: the list row plus the detail arrays. */
const detail = (over: Partial<TaskRow>) => ({
  ...ROW, ...over, subtasks: [], comments: [], activity: [], watchers: [], created_by_name: 'Dana Levi',
});

function axiosError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

async function seed() {
  const { useTasksStore } = await import('@/stores/tasksStore');
  useTasksStore.setState({ tasks: [mapRowToTask(ROW)], loaded: true, loading: false });
  return useTasksStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateStatus - the move lost a race to someone else', () => {
  it('shows the status the server now holds, not the one from before the click', async () => {
    const store = await seed();
    mockApi.patch.mockRejectedValue(axiosError(409, { error: CONFLICT_MESSAGE, code: 'STATE_CONFLICT' }));
    // Someone else cancelled it first.
    mockApi.get.mockResolvedValue({ data: { task: detail({ status: 'CANCELLED' }) } });

    await store.getState().updateStatus('t1', 'DONE');

    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
    expect(store.getState().tasks.find((t) => t.id === 't1')!.status).toBe('CANCELLED');
  });

  it("says why, in the server's words - never 'please try again'", async () => {
    const store = await seed();
    mockApi.patch.mockRejectedValue(axiosError(409, { error: CONFLICT_MESSAGE, code: 'STATE_CONFLICT' }));
    mockApi.get.mockResolvedValue({ data: { task: detail({ status: 'CANCELLED' }) } });

    await store.getState().updateStatus('t1', 'DONE');

    expect(mockToast).toHaveBeenCalledTimes(1);
    const shown = mockToast.mock.calls[0]![0] as { description?: string };
    expect(shown.description).toBe(CONFLICT_MESSAGE);
    expect(shown.description).not.toMatch(/please try again/i);
  });

  it('still rolls back, with the generic message, on any other failure', async () => {
    const store = await seed();
    mockApi.patch.mockRejectedValue(axiosError(500, { error: 'Failed to update task' }));

    await store.getState().updateStatus('t1', 'DONE');

    expect(mockApi.get).not.toHaveBeenCalled();
    expect(store.getState().tasks.find((t) => t.id === 't1')!.status).toBe('TODO');
    const shown = mockToast.mock.calls[0]![0] as { description?: string };
    expect(shown.description).toBe('Could not move the task. Please try again.');
  });

  it('falls back to the pre-click status if the task cannot be re-read', async () => {
    const store = await seed();
    mockApi.patch.mockRejectedValue(axiosError(409, { error: CONFLICT_MESSAGE, code: 'STATE_CONFLICT' }));
    mockApi.get.mockRejectedValue(axiosError(500, {}));

    await store.getState().updateStatus('t1', 'DONE');

    expect(store.getState().tasks.find((t) => t.id === 't1')!.status).toBe('TODO');
    const shown = mockToast.mock.calls[0]![0] as { description?: string };
    expect(shown.description).toBe(CONFLICT_MESSAGE);
  });
});
