/**
 * FE-3: CreateTaskModal — real assignee/watcher pickers + real-data AI parse
 *
 * Strategy:
 * - vi.mock useAssignableUsers → returns 2 test users
 * - vi.mock the tasks store's addTask so we can inspect what it receives
 * - Radix Select doesn't fully work in jsdom (no portal-based open/close), so we
 *   verify the shadcn SelectTrigger shows placeholder text (the assignee picker rendered)
 *   and that MultiAssigneeSelect rendered its add-member trigger.
 * - Submit path: mock store addTask, fill title, click Create, assert assignee_ids passed.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import type { AssignableUser } from '@/lib/api/users';

// The signed-in user, per the default auth.store mock in __tests__/setup.ts.
// They must ALSO be an assignable user, or the self-assigned chip a non-holder
// sees would render as "Unknown".
const ACTOR_ID = '00000000-0000-0000-0000-000000000001';

// ── Mock useAssignableUsers ──────────────────────────────────────────────────
const MOCK_USERS: AssignableUser[] = [
  {
    id: ACTOR_ID,
    first_name: 'Test',
    last_name: 'Admin',
    role: 'ADMIN',
    is_active: true,
    has_login: true,
    department: { id: 'dept-ops', name: 'Operations' },
  },
  {
    id: 'user-alice-uuid',
    first_name: 'Alice',
    last_name: 'Anderson',
    role: 'DISPATCHER',
    is_active: true,
    has_login: true,
    department: { id: 'dept-ops', name: 'Operations' },
  },
  {
    id: 'user-bob-uuid',
    first_name: 'Bob',
    last_name: 'Baker',
    role: 'TECHNICIAN',
    is_active: true,
    has_login: false,
    department: null,
  },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
  // Re-export the type shape so TS doesn't complain on imports
}));

// ── Mock tasksStore ──────────────────────────────────────────────────────────
const mockAddTask = vi.fn().mockResolvedValue({
  id: 't_new',
  task_number: 'T00001',
  title: 'Test task',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: ['user-alice-uuid'],
  assignees: [{ id: 'user-alice-uuid', name: 'Alice Anderson' }],
  watcher_ids: [],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [],
  created_by: 'admin',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
  activity: [],
  comments: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
});

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      tasks: [],
      addTask: mockAddTask,
    })
  ),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CreateTaskModal — real assignee/watcher pickers (FE-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-install the resolved value after clearAllMocks
    mockAddTask.mockResolvedValue({
      id: 't_new',
      task_number: 'T00001',
      title: 'Test task',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      assignee_ids: ['user-alice-uuid'],
      assignees: [{ id: 'user-alice-uuid', name: 'Alice Anderson' }],
      watcher_ids: [],
      due_at: null,
      linked_entity: null,
      tags: [],
      subtasks: [],
      created_by: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      activity: [],
      comments: [],
      ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    });
  });

  it('renders the assignee picker with placeholder instead of a plain <select>', () => {
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );

    // The shadcn Select renders a button[role="combobox"] as the trigger.
    // MultiAssigneeSelect is used for assignees; its trigger shows the placeholder.
    const triggers = screen.getAllByRole('combobox');
    // At least one combobox trigger exists (the assignee picker)
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT render the NL free-text input or Parse button (#414)', () => {
    renderWithProviders(<CreateTaskModal open={true} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Parse' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/e\.g\./i)).not.toBeInTheDocument();
    // Positive check: the structured form is the creation UI
    expect(screen.getByPlaceholderText('Task title')).toBeInTheDocument();
  });

  it('restricts the Due Date picker to 15-minute increments (#416)', async () => {
    // #416's intent, preserved against the DateTimePicker split into a DatePicker +
    // TimeCombobox: the time choices are generated every 15 minutes (00/15/30/45),
    // never per-minute. TimeCombobox is a typeable list, not a Radix Select, so
    // options are plain buttons, not role="option".
    const user = userEvent.setup();
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    await user.click(screen.getByPlaceholderText('Time'));
    const options = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2} (AM|PM)/ });
    expect(options).toHaveLength(96);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  it('dismisses the Due Date picker on outside click while the dialog stays open (#430)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    await user.click(screen.getByRole('button', { name: /open calendar/i }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();

    // Click elsewhere INSIDE the dialog (the title) — the picker must dismiss
    // while the New Task dialog itself stays open.
    await user.click(screen.getByText('New Task'));
    await waitFor(() =>
      expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    );
    expect(screen.getByText('New Task')).toBeInTheDocument();
  });

  it('does NOT render a "Suggested:" assignee recommendation chip (#415)', () => {
    // suggestAssignee([], [alice, bob]) returns alice as "lightest load", so the
    // chip would render under these mocks if the component still showed it.
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    expect(screen.queryByText(/Suggested:/i)).not.toBeInTheDocument();
  });

  it('does NOT render MOCK_PEOPLE names (Priya, Ohad, Sagiv) as checkbox labels', () => {
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    // Old mock-people watcher checkboxes should be gone
    expect(screen.queryByLabelText('Priya')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ohad')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sagiv Peker')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Emanuel Dahan')).not.toBeInTheDocument();
  });

  it('does NOT render MOCK_PEOPLE as plain <option> elements in the assignee select', () => {
    const { container } = renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    // There should be no <option> elements with mock person names
    const options = Array.from(container.querySelectorAll('option'));
    const optionTexts = options.map((o) => o.textContent ?? '');
    expect(optionTexts).not.toContain('Priya');
    expect(optionTexts).not.toContain('Ohad');
  });

  it('renders the MultiAssigneeSelect add-member combobox for watchers', () => {
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />
    );
    // MultiAssigneeSelect renders a combobox with placeholder "Add member..."
    // (we can't open Radix dropdowns in jsdom, but the trigger renders)
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBeGreaterThanOrEqual(2); // assignees + watchers
  });

  it('submits without assignee_ids when a grant-holder leaves the field blank, so the server defaults to the actor', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={onOpenChange} />,
      { ability: buildAbility([{ action: 'assign', subject: 'Task' }]) },
    );

    // Fill in the title (required)
    const titleInput = screen.getByPlaceholderText('Task title');
    await user.type(titleInput, 'Install sensor');

    // Click Create
    const createBtn = screen.getByRole('button', { name: 'Create' });
    await user.click(createBtn);

    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledOnce();
    });

    const callArg = (mockAddTask as Mock).mock.calls[0][0];
    expect(callArg).toMatchObject({
      title: 'Install sensor',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    // An EMPTY assignee field must send no key at all: the server reads a
    // missing `assignee_ids` as "default to the actor", while an empty array is
    // a 400.
    expect(callArg.assignee_ids).toBeUndefined();
  });

  // ── Assignee gating (CASL `assign` on Task) ───────────────────────────────

  it('disables the assignee field and pre-fills the actor for a caller WITHOUT `assign` on Task', async () => {
    // No `ability` -> emptyAbility -> can('assign','Task') is false. This is the
    // custom-role case: `role === 'ADMIN'` would answer this question wrongly in
    // both directions, so the control reads the CASL grant instead.
    const user = userEvent.setup();
    renderWithProviders(<CreateTaskModal open={true} onOpenChange={vi.fn()} />);

    // The picker's trigger is disabled, and the actor is shown as a chip, so
    // the field states the outcome the server will force rather than looking
    // like a free choice.
    //
    // THE EXPLANATORY SENTENCE IS GONE (#1956) and its absence is asserted, not merely
    // un-asserted: the disabled field carrying the actor's own name IS the explanation, and
    // the sentence beneath it was a second one. Removing the note must not remove the
    // explanation, so the two assertions below are what carries the rule now.
    expect(screen.queryByText('You can only assign tasks to yourself.')).not.toBeInTheDocument();
    expect(document.getElementById('new-task-assignees')).toBeDisabled();
    expect(screen.getByText('Test Admin')).toBeInTheDocument();
    // The chip carries no remove control while disabled.
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Task title'), 'My own errand');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledOnce());
    // Exactly [actorId] - the only array the server accepts from a non-holder.
    expect((mockAddTask as Mock).mock.calls[0][0].assignee_ids)
      .toEqual([ACTOR_ID]);
  });

  it('lets a caller WITH `assign` on Task edit the field, and sends what they chose', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={vi.fn()} />,
      { ability: buildAbility([{ action: 'assign', subject: 'Task' }]) },
    );

    // A holder starts blank - no forced self-assignment, no explanatory note.
    expect(screen.queryByText('You can only assign tasks to yourself.')).not.toBeInTheDocument();
    expect(document.getElementById('new-task-assignees')).toBeEnabled();

    await user.type(screen.getByPlaceholderText('Task title'), 'Crew job');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledOnce());
    expect((mockAddTask as Mock).mock.calls[0][0].assignee_ids).toBeUndefined();
  });

  // ── Watcher pool wiring (#1956) ───────────────────────────────────────────

  it('asks for the WATCHER pool for Watchers and the ASSIGNEE pool for Assignees', async () => {
    // The bug this pins: both fields asked `purpose=task`, which reads `assign Task` — a grant
    // no seeded role holds — so the Watchers field offered exactly one name (the rep) and
    // watched nothing. The two fields feed different server rules and must ask different
    // questions. Asserted on the hook's arguments because that IS the wire: `useAssignableUsers`
    // puts `purpose` straight onto the query string.
    const { useAssignableUsers } = await import('@/lib/api/users');
    (useAssignableUsers as Mock).mockClear();
    renderWithProviders(<CreateTaskModal open={true} onOpenChange={vi.fn()} />);

    const purposes = (useAssignableUsers as Mock).mock.calls.map((c) => c[0]?.purpose);
    expect(purposes).toContain('taskWatcher');
    expect(purposes).toContain('task');
    // And nothing asks for the directory here — that family gates on `read User`, which SALES
    // does not hold, so it would 403 the very user this change is for.
    expect(purposes).not.toContain('directory');
  });

  it('closes modal and resets after successful create', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <CreateTaskModal open={true} onOpenChange={onOpenChange} />
    );

    await user.type(screen.getByPlaceholderText('Task title'), 'Cleanup task');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

// ── Bug fix: watcher_ids forwarded on create ────────────────────────────────
//
// The fix adds watcher_ids to CreateTaskInput and passes it from the modal.
// Because Radix Select can't open in jsdom, we can't simulate picking a watcher
// via the UI. Instead we verify the CONTRACT at two levels:
//
// 1. The addTask call in the submit path doesn't include watcher_ids when the
//    watcherIds state is empty (no regression — undefined or absent is both fine).
// 2. A unit test on the createTask() API function (lib/api/tasks.ts) directly
//    asserts that watcher_ids is forwarded in the POST body when present.

import { createTask } from '@/lib/api/tasks';
import api from '@/lib/axios';

describe('CreateTaskModal — watcher_ids forwarded to addTask (bug fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddTask.mockResolvedValue({
      id: 't_new',
      task_number: 'T00001',
      title: 'Test task',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      assignee_ids: ['admin'],
      assignees: [{ id: 'admin', name: 'Admin User' }],
      watcher_ids: [],
      due_at: null,
      linked_entity: null,
      tags: [],
      subtasks: [],
      created_by: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      activity: [],
      comments: [],
      ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    });
  });

  it('createTask() API fn includes watcher_ids in POST body when non-empty', async () => {
    const mockTask = {
      id: 't_new',
      task_number: 'T00001',
      title: 'Fit sensor',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      assignee_ids: ['admin'],
      assignees: [{ id: 'admin', name: 'Admin User' }],
      due_at: null,
      linked_entity_type: null,
      linked_entity_id: null,
      tags: [],
      created_by: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
    };
    vi.mocked(api).post.mockResolvedValue({ data: { task: mockTask } });

    await createTask({
      title: 'Fit sensor',
      watcher_ids: ['user-bob-uuid'],
    });

    const postBody = vi.mocked(api).post.mock.calls[0][1] as Record<string, unknown>;
    expect(postBody.watcher_ids).toEqual(['user-bob-uuid']);
  });

  it('createTask() API fn omits watcher_ids from POST body when empty', async () => {
    const mockTask = {
      id: 't_new',
      task_number: 'T00001',
      title: 'Fit sensor',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      assignee_ids: ['admin'],
      assignees: [{ id: 'admin', name: 'Admin User' }],
      due_at: null,
      linked_entity_type: null,
      linked_entity_id: null,
      tags: [],
      created_by: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
    };
    vi.mocked(api).post.mockResolvedValue({ data: { task: mockTask } });

    await createTask({ title: 'Fit sensor' });

    const postBody = vi.mocked(api).post.mock.calls[0][1] as Record<string, unknown>;
    expect(postBody.watcher_ids).toBeUndefined();
  });

  it('addTask call does not include watcher_ids when none selected (no regression)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderWithProviders(<CreateTaskModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByPlaceholderText('Task title'), 'No watcher task');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledOnce();
    });

    const callArg = (mockAddTask as Mock).mock.calls[0][0];
    // watcher_ids should be absent (not passed as empty array — the spread only adds it when non-empty)
    expect(callArg.watcher_ids).toBeUndefined();
  });
});
