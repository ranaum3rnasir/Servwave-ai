/**
 * Task notifications deep-link into the Tasks hub via `?task=<id>`.
 *
 * The five `task.*` verbs all carry `object_type: 'TASK'` and the task's uuid,
 * but Tasks is ONE route with no `:id` child - the detail is a store-driven
 * drawer, not a URL - so `notificationDeepLink` hands the id over as a query
 * param and the hub consumes it once and strips it.
 *
 * THE LOAD HERE IS COLD ON PURPOSE. The store is NOT pre-hydrated and
 * `GET /api/tasks` answers with an empty list, so nothing but the deep link can
 * put the task on screen - that is the arrival a notification click from another
 * page, or a pasted URL, actually produces. The REAL TaskDetailDrawer is mounted
 * (not a stub), so the assertion is the rendered sheet rather than a store field
 * the drawer might ignore.
 *
 * Honest note on what each spec pins. The drawer re-fetches on every `openTaskId`
 * change and `fetchTaskDetail` appends an absent row, so the HAPPY cold path
 * would also resolve if the hub only flipped the id. The spec that actually pins
 * the hub-side resolution is the DEAD END: a `task.deleted` notification points
 * at a row that is gone, and `fetchTaskDetail` neither catches nor reports, so
 * resolving inside the drawer's effect is an unhandled rejection (vitest fails
 * the run on one) that pins `openTaskId` to a task that never arrives and tells
 * the user nothing. Landing on the plain hub with a toast, and with `openTaskId`
 * still null, is only reachable by resolving before opening.
 *
 * Tab views and the create dialog are stubbed the way the other hub specs stub
 * them, so only the hub shell + the drawer render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { toast } from '@/ui-kit/components/ui/sonner';

// The hub reports the dead end through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not. Spying on the call keeps
// the copy asserted without standing a toaster up per test.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      message: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

// ── Stub the heavy tab views + the create dialog; the DRAWER STAYS REAL ──
vi.mock('@/pages/v2/tasks/views/dashboardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/views/boardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/views/myDayView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/views/listView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/views/calendarView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/views/historyView', () => ({ default: () => <div /> }));
vi.mock('@/pages/v2/tasks/components/createTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));
vi.mock('@/pages/v2/tasks/components/taskFilterBar', () => ({
  TaskFilterChips: () => null,
  TaskFilterTrigger: () => null,
}));

import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

const LIVE_TASK_ID = '7a1c0000-0000-4000-8000-000000000001';
const DELETED_TASK_ID = '7a1c0000-0000-4000-8000-0000000000ff';

const LIVE_TASK_DETAIL = {
  id: LIVE_TASK_ID,
  task_number: 'T00777',
  title: 'Re-key the Larkin storefront',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: ['u-1'],
  assignees: [{ id: 'u-1', name: 'Priya Nair' }],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  created_by: 'u-9',
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
  completed_at: null,
  subtasks: [],
  comments: [],
  activity: [],
  watchers: [],
};

/** Renders the current router location so the param strip can be asserted. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{`${loc.pathname}${loc.search}`}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A COLD arrival: nothing hydrated, exactly as after a reload or a click from
  // another page. Nothing in these specs puts the task in the store by hand.
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  useTaskDetailStore.setState({ openTaskId: null });

  vi.mocked(api).get.mockImplementation((url: string) => {
    // The hub's own list hydration answers EMPTY, so it cannot be what makes
    // the deep-linked task resolvable.
    if (url === '/api/tasks') {
      return Promise.resolve({ data: { tasks: [] } }) as ReturnType<typeof api.get>;
    }
    if (url === `/api/tasks/${LIVE_TASK_ID}`) {
      return Promise.resolve({ data: { task: LIVE_TASK_DETAIL } }) as ReturnType<typeof api.get>;
    }
    if (url === `/api/tasks/${DELETED_TASK_ID}`) {
      return Promise.reject({
        response: { status: 404, data: { error: 'Task not found' } },
      }) as ReturnType<typeof api.get>;
    }
    return Promise.resolve({ data: { users: [], tasks: [] } }) as ReturnType<typeof api.get>;
  });
});

describe('Tasks hub notification deep-link (?task=<id>)', () => {
  it('opens the detail drawer for the deep-linked task on a COLD load and strips the param', async () => {
    expect(useTasksStore.getState().tasks).toHaveLength(0);

    renderWithProviders(
      <>
        <TasksHubPage />
        <LocationProbe />
      </>,
      { initialEntries: [`/tasks?task=${LIVE_TASK_ID}`] },
    );

    // The hub fetched the one row itself - the list call could not have supplied it.
    await waitFor(() => {
      expect(
        vi.mocked(api).get.mock.calls.some((c) => c[0] === `/api/tasks/${LIVE_TASK_ID}`),
      ).toBe(true);
    });

    // The REAL drawer is open on the deep-linked task.
    await waitFor(() => {
      expect(screen.getByText('T00777')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Task title')).toHaveValue('Re-key the Larkin storefront');
    expect(useTaskDetailStore.getState().openTaskId).toBe(LIVE_TASK_ID);
    // fetchTaskDetail APPENDED the absent row - that is the cold-load mechanism.
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual([LIVE_TASK_ID]);

    // One-shot handshake: the param is gone so Back does not re-open the drawer.
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(/^\/tasks$/);
    });
  });

  it('degrades to the hub with a toast when the task no longer exists (task.deleted)', async () => {
    renderWithProviders(
      <>
        <TasksHubPage />
        <LocationProbe />
      </>,
      { initialEntries: [`/tasks?task=${DELETED_TASK_ID}`] },
    );

    await waitFor(() => {
      expect(vi.mocked(toast).error).toHaveBeenCalledWith(
        'This task no longer exists',
        expect.objectContaining({
          description: 'It may have been deleted since you were notified.',
        }),
      );
    });

    // No crash, no half-open drawer, and the hub itself is still on screen.
    expect(screen.getByTestId('tasks-workspace')).toBeInTheDocument();
    expect(useTaskDetailStore.getState().openTaskId).toBeNull();
    expect(useTasksStore.getState().tasks).toHaveLength(0);
    expect(screen.queryByLabelText('Task title')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(/^\/tasks$/);
    });
  });

  it('leaves the drawer shut on a plain /tasks and fetches no detail row', async () => {
    renderWithProviders(<TasksHubPage />, { initialEntries: ['/tasks'] });

    await waitFor(() => {
      expect(vi.mocked(api).get.mock.calls.some((c) => c[0] === '/api/tasks')).toBe(true);
    });
    expect(
      vi.mocked(api).get.mock.calls.some((c) => String(c[0]).startsWith('/api/tasks/')),
    ).toBe(false);
    expect(useTaskDetailStore.getState().openTaskId).toBeNull();
    expect(vi.mocked(toast).error).not.toHaveBeenCalled();
  });
});
