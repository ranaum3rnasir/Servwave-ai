/**
 * FE-6: TaskDetailDrawer rich mutations
 * Tests that drawer wires fetch-on-open, subtask CRUD, comment composer,
 * nudge button, and watcher management to real store actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { TaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';

/** The signed-in user in the harness (src/__tests__/setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';

// ── Store mocks ────────────────────────────────────────────────────────────────

const mockFetchTaskDetail = vi.fn().mockResolvedValue(undefined);
const mockAddComment = vi.fn().mockResolvedValue(undefined);
const mockAddSubtask = vi.fn().mockResolvedValue(undefined);
const mockToggleSubtask = vi.fn().mockResolvedValue(undefined);
const mockDeleteSubtask = vi.fn().mockResolvedValue(undefined);
const mockSetWatchers = vi.fn().mockResolvedValue(undefined);
const mockSetAssignees = vi.fn().mockResolvedValue(undefined);
const mockNudge = vi.fn().mockResolvedValue(undefined);
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
const mockDeleteTask = vi.fn().mockResolvedValue(undefined);

// Default task object used in most tests
const TASK = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: 'Needs attention',
  status: 'TODO' as const,
  priority: 'HIGH' as const,
  assignee_ids: ['u1'],
  assignees: [{ id: 'u1', name: 'Oved Adani' }],
  watcher_ids: ['u2'],
  watchers: [{ id: 'u2', name: 'Priya' }],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [{ id: 's1', text: 'Order parts', done: false }],
  comments: [{ id: 'c1', author_id: 'u1', author_name: 'Oved', body: 'In progress', at: '2026-06-17T10:00:00Z' }],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

// Mutable tasks list so per-test overrides work without re-mocking the module
let mockTasks = [TASK as typeof TASK & { created_by_name?: string | null }];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: () => ({
    tasks: mockTasks,
    fetchTaskDetail: mockFetchTaskDetail,
    addComment: mockAddComment,
    addSubtask: mockAddSubtask,
    toggleSubtask: mockToggleSubtask,
    deleteSubtask: mockDeleteSubtask,
    deleteTask: mockDeleteTask,
    setAssignees: mockSetAssignees,
    setWatchers: mockSetWatchers,
    nudge: mockNudge,
    updateTask: mockUpdateTask,
    updateStatus: mockUpdateStatus,
  }),
}));

// taskDetailStore: open t1 by default
vi.mock('@/stores/taskDetailStore', () => {
  const { create } = require('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

// AssigneeSelect: lightweight stub — clicking fires onChange with 'u3'
vi.mock('@/components/crm/AssigneeSelect', () => ({
  AssigneeSelect: ({ onChange }: { onChange: (id: string | null) => void }) => (
    <button data-testid="assignee-select" onClick={() => onChange('u3')}>
      Change Owner
    </button>
  ),
}));

// MultiAssigneeSelect: stub — clicking fires onChange with []
// The drawer now mounts TWO of these - assignees and watchers - so the stub
// keys its testid off the `id` the drawer passes. A single shared testid would
// make `getByTestId` ambiguous and, worse, let an assertion about watchers pass
// against the assignee widget.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({
    id,
    value,
    onChange,
    disabled,
  }: {
    id?: string;
    value: string[];
    onChange: (ids: string[]) => void;
    disabled?: boolean;
  }) => (
    <button
      data-testid={id ?? 'multi-assignee-select'}
      disabled={disabled}
      onClick={() => onChange([])}
    >
      {`${id ?? 'people'}: ${value.join(',')}`}
    </button>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK]; // reset to default fixture
  mockDeleteTask.mockResolvedValue(undefined);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TaskDetailDrawer FE-6 rich mutations', () => {
  it('calls fetchTaskDetail when the drawer opens (openTaskId changes)', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(mockFetchTaskDetail).toHaveBeenCalledWith('t1');
  });

  it('renders the task title in the drawer', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByDisplayValue('Fix the valve')).toBeInTheDocument();
  });

  it('restricts the Due time list to 15-minute increments (#416)', async () => {
    // The Due field is a DateTimePicker (DatePicker + TimeCombobox); the time list is
    // generated every stepMinutes (default 15), so only :00/:15/:30/:45 appear.
    const user = userEvent.setup();
    renderWithProviders(<TaskDetailDrawer />);
    const timeInput = screen.getByPlaceholderText('Time');
    await user.click(timeInput);
    const options = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2} (AM|PM)/ });
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  // ── Subtasks ───────────────────────────────────────────────────────────────

  it('renders existing subtask with checkbox + delete button', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText('Order parts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete subtask/i })).toBeInTheDocument();
  });

  it('toggleSubtask is called when a subtask checkbox is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const checkbox = screen.getByRole('checkbox');
    await userEvent.click(checkbox);
    expect(mockToggleSubtask).toHaveBeenCalledWith('t1', 's1', true);
  });

  it('deleteSubtask is called when the subtask delete button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const deleteBtn = screen.getByRole('button', { name: /delete subtask/i });
    await userEvent.click(deleteBtn);
    expect(mockDeleteSubtask).toHaveBeenCalledWith('t1', 's1');
  });

  it('addSubtask is called when a new subtask is submitted', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const input = screen.getByPlaceholderText(/add subtask/i);
    await userEvent.type(input, 'Buy copper fittings');
    const addBtn = screen.getByRole('button', { name: /add subtask/i });
    await userEvent.click(addBtn);
    expect(mockAddSubtask).toHaveBeenCalledWith('t1', 'Buy copper fittings');
  });

  it('addSubtask can also be triggered by pressing Enter in the subtask input', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const input = screen.getByPlaceholderText(/add subtask/i);
    await userEvent.type(input, 'Test{Enter}');
    expect(mockAddSubtask).toHaveBeenCalledWith('t1', 'Test');
  });

  // ── Comments ───────────────────────────────────────────────────────────────

  it('renders existing comment body', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('addComment is called when the Post button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Looks good');
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    expect(mockAddComment).toHaveBeenCalledWith('t1', 'Looks good');
  });

  it('clears the comment textarea after successful post', async () => {
    mockAddComment.mockResolvedValue(undefined);
    renderWithProviders(<TaskDetailDrawer />);
    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Nice work');
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('does not call addComment when textarea is empty', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  // ── Nudge ─────────────────────────────────────────────────────────────────

  it('nudge is called when the Nudge button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    await userEvent.click(screen.getByRole('button', { name: /nudge/i }));
    expect(mockNudge).toHaveBeenCalledWith('t1');
  });

  // ── Watchers ──────────────────────────────────────────────────────────────

  it('renders MultiAssigneeSelect for watchers with current watcher_ids', () => {
    renderWithProviders(<TaskDetailDrawer />);
    const watcherWidget = screen.getByTestId('task-watchers');
    expect(watcherWidget).toBeInTheDocument();
    expect(watcherWidget.textContent).toContain('u2');
  });

  it('setWatchers is called when watchers change', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const watcherWidget = screen.getByTestId('task-watchers');
    await userEvent.click(watcherWidget);
    expect(mockSetWatchers).toHaveBeenCalledWith('t1', []);
  });

  // ── Assignees (multi-assignee) ────────────────────────────────────────────

  it('renders the assignee widget with the task\'s current assignee_ids', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByTestId('task-assignees').textContent).toContain('u1');
  });

  it('disables the assignee field for a caller WITHOUT `assign` on Task', () => {
    // No `ability` passed -> emptyAbility -> can('assign','Task') is false.
    // This is the custom-role case the feature exists for: the API would 403 an
    // assignee edit from this user, so the control must not offer one.
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByTestId('task-assignees')).toBeDisabled();
    // ...while a field they ARE allowed to edit stays live.
    expect(screen.getByTestId('task-watchers')).not.toBeDisabled();
  });

  it('enables the assignee field and calls setAssignees for a caller WITH `assign` on Task', async () => {
    renderWithProviders(<TaskDetailDrawer />, {
      ability: buildAbility([{ action: 'assign', subject: 'Task' }]),
    });
    const widget = screen.getByTestId('task-assignees');
    expect(widget).not.toBeDisabled();
    await userEvent.click(widget);
    expect(mockSetAssignees).toHaveBeenCalledWith('t1', []);
  });

  // ── QA-Fix-4b: created_by_name ─────────────────────────────────────────────

  it('renders created_by_name when present (not the raw UUID)', () => {
    // Swap tasks list to include created_by_name before render
    mockTasks = [{ ...TASK, created_by_name: 'Oved Adani' }];
    renderWithProviders(<TaskDetailDrawer />);
    // "Created by" row should show the name, not the raw id
    expect(screen.getByText('Oved Adani')).toBeInTheDocument();
  });

  it('falls back to created_by UUID when created_by_name is absent', () => {
    renderWithProviders(<TaskDetailDrawer />);
    // TASK fixture has created_by: 'u1', no created_by_name
    expect(screen.getByText('u1')).toBeInTheDocument();
  });
});

// ── Delete control ────────────────────────────────────────────────────────────
// The DELETE endpoint has TWO independent arms (task.controller.remove): the
// `delete` grant on Task, OR the row-level exception - creator AND sole
// assignee. The control must appear under exactly those, and never key off
// `role === 'ADMIN'`, which is invisible to the custom roles now in production.

describe('TaskDetailDrawer delete control', () => {
  const deleteGrant = () => buildAbility([{ action: 'delete', subject: 'Task' }]);

  it('is HIDDEN for a user with neither the grant nor the ownership exception', () => {
    // Default fixture: created_by 'u1', assignee_ids ['u1'] - neither is ME.
    // No ability passed -> emptyAbility -> can('delete','Task') is false.
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByRole('button', { name: /^delete task$/i })).not.toBeInTheDocument();
    // The subtask row action is a different control and must still be there.
    expect(screen.getByRole('button', { name: /delete subtask/i })).toBeInTheDocument();
  });

  it('is SHOWN for the creator who is the task\'s sole assignee, with no grant at all', () => {
    mockTasks = [{ ...TASK, created_by: ME, assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }] }];
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByRole('button', { name: /^delete task$/i })).toBeInTheDocument();
  });

  it('is HIDDEN for the creator once somebody ELSE is also assigned', () => {
    // The exception is creator AND *sole* assignee - a shared task is not a
    // private todo item any more, so only the grant may remove it.
    mockTasks = [{
      ...TASK,
      created_by: ME,
      assignee_ids: [ME, 'u9'],
      assignees: [{ id: ME, name: 'Test Admin' }, { id: 'u9', name: 'Sam' }],
    }];
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByRole('button', { name: /^delete task$/i })).not.toBeInTheDocument();
  });

  it('is HIDDEN for a sole assignee who did NOT create the task', () => {
    mockTasks = [{ ...TASK, created_by: 'someone-else', assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }] }];
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByRole('button', { name: /^delete task$/i })).not.toBeInTheDocument();
  });

  it('is SHOWN for a holder of the `delete` grant on somebody else\'s task', () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });
    expect(screen.getByRole('button', { name: /^delete task$/i })).toBeInTheDocument();
  });

  it('requires a confirmation that names what else is destroyed, and only then calls deleteTask', async () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });

    await userEvent.click(screen.getByRole('button', { name: /^delete task$/i }));
    // Nothing has been deleted just by opening the confirmation.
    expect(mockDeleteTask).not.toHaveBeenCalled();

    expect(await screen.findByText(/Delete T00001\?/)).toBeInTheDocument();
    expect(screen.getByText(/every comment, every file and its whole activity history/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(mockDeleteTask).toHaveBeenCalledWith('t1'));
  });

  it('closes the drawer on a successful delete', async () => {
    renderWithProviders(<TaskDetailDrawer />, { ability: deleteGrant() });
    await userEvent.click(screen.getByRole('button', { name: /^delete task$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /delete permanently/i }));

    await waitFor(() => expect(useTaskDetailStore.getState().close).toHaveBeenCalled());
  });

  it('does NOT close the drawer when the server refuses (403) and surfaces the rejection', async () => {
    // `deleteTask` rejects; the handler must catch it - an unhandled rejection
    // here would leave the drawer claiming nothing happened.
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
    // The drawer is still up, still showing the task it failed to delete.
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
