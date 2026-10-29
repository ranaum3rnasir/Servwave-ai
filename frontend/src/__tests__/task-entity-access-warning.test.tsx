/**
 * #05 - the assignee/watcher pickers flag people who cannot open the task's linked entity.
 *
 * ADVISORY ONLY. Nothing here may block: a flagged candidate is still selectable, still
 * submittable, and the write path is untouched. What is under test is that the person choosing
 * finds out, on all four live surfaces, and that finding out costs ONE request.
 *
 * The four live surfaces, established by following the imports rather than the directory names:
 *   /tasks hub          -> pages/v2/tasks/components/{createTaskDialog,taskDetailDrawer}.tsx
 *                          (pages/v2/routes/tasks.routes.tsx lazily imports pages/v2/tasks)
 *   entity tasks tab    -> components/tasks/{CreateTaskModal,TaskDetailDrawer}.tsx
 *                          (mounted by components/tasks/JobLeadTasksTab.tsx)
 * `pages/tasks/**` is NOT one of them - nothing but its own tests imports it.
 *
 * The real MultiAssigneeSelect renders here, deliberately: stubbing it is what would let a
 * "flagged" assertion pass against a component that never renders the marker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';

import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { TaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';
import { TaskDetailDrawer as V2TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';

/** The signed-in user in the harness (setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';
/** In `without_access` AND in `checked_user_ids` - the one candidate that must be flagged. */
const FLAGGED = 'user-alice';
/** Checked and cleared. */
const CLEARED = 'user-bob';
/** In `without_access` but NOT in `checked_user_ids` - no verdict, so no flag. */
const UNCHECKED = 'user-carol';

const ENTITY = { type: 'JOB' as const, id: 'job-1', label: 'J00934 - Access Control' };
const ENTITY_LABEL = 'J00934 - Access Control';

const MOCK_USERS = [
  { id: ME, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_active: true, has_login: true, department: null },
  { id: FLAGGED, first_name: 'Alice', last_name: 'Anderson', role: 'TECHNICIAN', is_active: true, has_login: true, department: null },
  { id: CLEARED, first_name: 'Bob', last_name: 'Baker', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
  { id: UNCHECKED, first_name: 'Carol', last_name: 'Chen', role: 'TECHNICIAN', is_active: true, has_login: true, department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
  useUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

// ── Store mocks ────────────────────────────────────────────────────────────────

const mockAddTask = vi.fn();
const mockSetAssignees = vi.fn().mockResolvedValue(undefined);
const mockSetWatchers = vi.fn().mockResolvedValue(undefined);

const TASK = {
  id: 't1',
  task_number: 'T00001',
  title: 'Ask about the access panel',
  description: '',
  status: 'TODO' as const,
  priority: 'MEDIUM' as const,
  // Every interesting case is pre-selected, so the verdicts are observable on the chips
  // without opening a Radix portal.
  assignee_ids: [FLAGGED, CLEARED, UNCHECKED],
  assignees: [
    { id: FLAGGED, name: 'Alice Anderson' },
    { id: CLEARED, name: 'Bob Baker' },
    { id: UNCHECKED, name: 'Carol Chen' },
  ],
  watcher_ids: [FLAGGED],
  watchers: [{ id: FLAGGED, name: 'Alice Anderson' }],
  due_at: null,
  linked_entity: ENTITY as { type: 'JOB'; id: string; label: string } | null,
  tags: [],
  subtasks: [],
  comments: [],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  created_by: ME,
  created_at: '2026-08-25T00:00:00Z',
  updated_at: '2026-08-25T00:00:00Z',
  completed_at: null,
};

let mockTasks: (typeof TASK)[] = [TASK];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      tasks: mockTasks,
      addTask: mockAddTask,
      fetchTaskDetail: vi.fn().mockResolvedValue(undefined),
      addComment: vi.fn(),
      addSubtask: vi.fn(),
      toggleSubtask: vi.fn(),
      deleteSubtask: vi.fn(),
      deleteTask: vi.fn(),
      setAssignees: mockSetAssignees,
      setWatchers: mockSetWatchers,
      nudge: vi.fn(),
      updateTask: vi.fn(),
      updateStatus: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores/taskDetailStore', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

// ── api.get router ─────────────────────────────────────────────────────────────

type AccessBody = {
  entity: { type: string; id: string; label: string | null; redacted: boolean };
  checked_user_ids: string[];
  without_access: string[];
};

const DEFAULT_BODY: AccessBody = {
  entity: { type: 'JOB', id: 'job-1', label: ENTITY_LABEL, redacted: false },
  checked_user_ids: [ME, FLAGGED, CLEARED],
  without_access: [FLAGGED, UNCHECKED],
};

function routeApi(body: AccessBody | Error = DEFAULT_BODY) {
  vi.mocked(api).get.mockImplementation(((url: string) => {
    if (url === '/api/tasks/entity-access') {
      return body instanceof Error
        ? Promise.reject(body)
        : (Promise.resolve({ data: body }) as ReturnType<typeof api.get>);
    }
    return Promise.resolve({ data: { users: [], tasks: [], departments: [] } }) as ReturnType<typeof api.get>;
  }) as typeof api.get);
}

const accessCalls = () =>
  vi.mocked(api).get.mock.calls.filter((c) => c[0] === '/api/tasks/entity-access');

const ASSIGN_ONLY = { ability: buildAbility([{ action: 'assign', subject: 'Task' }]) };
/** The three stock non-admin roles: `update Task`, deliberately NO `assign Task`. */
const UPDATE_NO_ASSIGN = {
  ability: buildAbility([
    { action: 'read', subject: 'Task' },
    { action: 'create', subject: 'Task' },
    { action: 'update', subject: 'Task' },
  ]),
};
/** A custom role that can open a task and change nothing about it. */
const READ_ONLY = { ability: buildAbility([{ action: 'read', subject: 'Task' }]) };

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK];
  mockAddTask.mockResolvedValue({ ...TASK, id: 't_new' });
  routeApi();
});

/** The chip a picker renders for an already-selected person. */
function chipFor(name: string): HTMLElement {
  const chip = screen.getAllByText((_, node) => node?.textContent?.startsWith(name) === true)
    .find((node) => node.tagName === 'SPAN' && node.className.includes('rounded-full'));
  if (!chip) throw new Error(`no chip rendered for ${name}`);
  return chip;
}

// ── The four live surfaces ─────────────────────────────────────────────────────

describe('#05 assignee picker flags candidates without linked-entity access', () => {
  it('entity-tab drawer: flags the candidate in without_access and explains, naming the entity', async () => {
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`)).length).toBeGreaterThan(0);
  });

  it('hub drawer: same flag and same explanation', async () => {
    renderWithProviders(<V2TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`)).length).toBeGreaterThan(0);
  });

  it('entity-tab create modal: flags the seeded assignee and explains', async () => {
    renderWithProviders(
      <CreateTaskModal
        open
        onOpenChange={vi.fn()}
        presetEntity={ENTITY}
        initialParse={{ title: 'Ask about it', assignee_id: FLAGGED, due_at: null, linked_entity: null, priority: 'MEDIUM' }}
      />,
      ASSIGN_ONLY,
    );

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`)).length).toBeGreaterThan(0);
  });

  it('hub create dialog: flags the seeded assignee and explains', async () => {
    renderWithProviders(
      <CreateTaskDialog
        open
        onOpenChange={vi.fn()}
        presetEntity={ENTITY}
        initialParse={{ title: 'Ask about it', assignee_id: FLAGGED, due_at: null, linked_entity: null, priority: 'MEDIUM' }}
      />,
      ASSIGN_ONLY,
    );

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`)).length).toBeGreaterThan(0);
  });
});

describe('#05 the flag marks, it does not gate', () => {
  it('the dropdown row for a flagged candidate carries the marker and is still selectable', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateTaskDialog open onOpenChange={vi.fn()} presetEntity={ENTITY} />,
      ASSIGN_ONLY,
    );

    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    await user.click(screen.getByRole('combobox', { name: 'Assignees' }));

    const flaggedRow = await screen.findByRole('option', { name: /Alice Anderson/ });
    expect(within(flaggedRow).getByText('No access')).toBeInTheDocument();
    // Radix marks an unselectable row with data-disabled. The whole point of this issue is that
    // it must not be there.
    expect(flaggedRow).not.toHaveAttribute('data-disabled');
    expect(flaggedRow).toHaveAttribute('aria-selected', 'false');

    expect(within(screen.getByRole('option', { name: /Bob Baker/ })).queryByText('No access')).toBeNull();
  });
});

// ── Who must NOT be flagged ────────────────────────────────────────────────────

describe('#05 fails open rather than over-warning', () => {
  it('a candidate the server cleared is not flagged', async () => {
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    expect(within(chipFor('Bob Baker')).queryByText('No access')).toBeNull();
  });

  it('a candidate absent from checked_user_ids is not flagged, even though without_access names them', async () => {
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    // Carol is in without_access but was never evaluated. No verdict must never read as "denied".
    expect(within(chipFor('Carol Chen')).queryByText('No access')).toBeNull();
  });

  it('a 404 (linked entity gone or out of tenant) produces no warnings at all', async () => {
    routeApi(Object.assign(new Error('Request failed'), { response: { status: 404 } }));
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    expect(screen.getByDisplayValue('Ask about the access panel')).toBeInTheDocument();
    expect(screen.queryByText('No access')).toBeNull();
    expect(screen.queryByText(/cannot open/)).toBeNull();
  });

  it('an unlinked task flags nobody AND issues no request', async () => {
    mockTasks = [{ ...TASK, linked_entity: null }];
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    // The picker is fully rendered (chips for all three) before the assertion, so this is not
    // just "the request has not happened yet".
    await waitFor(() => expect(chipFor('Alice Anderson')).toBeInTheDocument());
    expect(accessCalls()).toHaveLength(0);
    expect(screen.queryByText('No access')).toBeNull();
    expect(screen.queryByText(/cannot open/)).toBeNull();
  });

  it('an OPEN create dialog with no entity flags nobody AND issues no request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateTaskDialog open onOpenChange={vi.fn()} />, ASSIGN_ONLY);

    // Drive the picker all the way open, so this is not just "nothing has rendered yet".
    await user.click(screen.getByRole('combobox', { name: 'Assignees' }));
    await screen.findByRole('option', { name: /Alice Anderson/ });

    expect(accessCalls()).toHaveLength(0);
    expect(screen.queryByText('No access')).toBeNull();
    expect(screen.queryByText(/cannot open/)).toBeNull();
  });

  it('a closed create dialog issues no request even with the entity preset', () => {
    renderWithProviders(
      <CreateTaskModal open={false} onOpenChange={vi.fn()} presetEntity={ENTITY} />,
      ASSIGN_ONLY,
    );
    expect(accessCalls()).toHaveLength(0);
  });
});

// ── When the sentence appears ──────────────────────────────────────────────────

describe('#05 the explanation appears when it is about to matter, not permanently', () => {
  // The regression this pins: testing the whole assignable roster made every CUSTOMER-linked task
  // on a technician-heavy org carry the sentence forever, twice per surface.
  it('does not render while a flagged person is only in the roster, unselected, dropdown shut', async () => {
    renderWithProviders(
      <CreateTaskDialog open onOpenChange={vi.fn()} presetEntity={ENTITY} />,
      ASSIGN_ONLY,
    );

    // The verdict has arrived and Alice IS flagged - this is not "the answer has not landed yet".
    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    expect(screen.queryByText(/cannot open/)).toBeNull();
  });

  it('renders once a flagged person is actually selected', async () => {
    renderWithProviders(
      <CreateTaskDialog
        open
        onOpenChange={vi.fn()}
        presetEntity={ENTITY}
        initialParse={{ title: 'x', assignee_id: FLAGGED, due_at: null, linked_entity: null, priority: 'MEDIUM' }}
      />,
      ASSIGN_ONLY,
    );

    await waitFor(() => expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`))).toHaveLength(1));
  });

  it('renders while the dropdown is open on a flagged candidate, and retracts when it shuts', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateTaskDialog open onOpenChange={vi.fn()} presetEntity={ENTITY} />,
      ASSIGN_ONLY,
    );
    await waitFor(() => expect(accessCalls()).toHaveLength(1));

    await user.click(screen.getByRole('combobox', { name: 'Assignees' }));
    await screen.findByRole('option', { name: /Alice Anderson/ });
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`))).toHaveLength(1);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(/cannot open/)).toBeNull());
  });

  it('a disabled picker carries no marker at all - the assignee control without the assign grant', async () => {
    renderWithProviders(<TaskDetailDrawer />, UPDATE_NO_ASSIGN);

    // The watcher picker is never disabled and holds Alice, so the marking IS live on this surface.
    await waitFor(() => expect(screen.getAllByText('No access')).toHaveLength(1));
    // ...and it is the watcher chip, not one of the three disabled assignee chips.
    expect(within(chipFor('Bob Baker')).queryByText('No access')).toBeNull();
    expect(screen.getAllByText(new RegExp(`cannot open ${ENTITY_LABEL}`))).toHaveLength(1);
  });
});

// ── Who is worth asking for ────────────────────────────────────────────────────

describe('#05 only asks on behalf of someone who can change a roster', () => {
  it('a reader who can change NEITHER roster issues no request', async () => {
    renderWithProviders(<TaskDetailDrawer />, READ_ONLY);

    await waitFor(() => expect(chipFor('Alice Anderson')).toBeInTheDocument());
    expect(accessCalls()).toHaveLength(0);
    expect(screen.queryByText('No access')).toBeNull();
  });

  it('a reader with update but no assign STILL asks - watcher_ids rides on update Task', async () => {
    renderWithProviders(<TaskDetailDrawer />, UPDATE_NO_ASSIGN);

    // Gating this on `assign` would have silenced SALES, DISPATCHER and TECHNICIAN, who between
    // them are every non-admin stock role, on a picker they can all still edit.
    await waitFor(() => expect(accessCalls()).toHaveLength(1));
  });
});

// ── Cost ───────────────────────────────────────────────────────────────────────

describe('#05 resolves the whole roster in one batched request', () => {
  it('two pickers on one surface share ONE request, and typing in the picker adds none', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    // The drawer mounts an assignee picker AND a watcher picker over the same roster.
    expect(accessCalls()).toHaveLength(1);
    expect(accessCalls()[0]![1]).toEqual({ params: { entity_type: 'JOB', entity_id: 'job-1' } });

    // The picker's own search is Radix Select typeahead over the open listbox. Every keystroke
    // must be answered from the payload already in hand.
    // The drawer labels its pickers with a <dt>, not <label htmlFor>, so the trigger is reached
    // by the id it is given rather than by an accessible name.
    await user.click(document.getElementById('task-assignees')!);
    // The dropdown lists only people NOT already selected, and this fixture has all three
    // interesting candidates on the task already.
    await screen.findByRole('option', { name: /Test Admin/ });
    await user.keyboard('bob');
    await user.keyboard('ali');
    await user.keyboard('carol');

    expect(accessCalls()).toHaveLength(1);
  });
});

// ── Still non-blocking ─────────────────────────────────────────────────────────

describe('#05 never blocks the assignment', () => {
  it('a flagged assignee still submits, with no extra confirmation step', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <CreateTaskModal
        open
        onOpenChange={onOpenChange}
        presetEntity={ENTITY}
        initialParse={{ title: 'Ask about it', assignee_id: FLAGGED, due_at: null, linked_entity: null, priority: 'MEDIUM' }}
      />,
      ASSIGN_ONLY,
    );

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());

    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(mockAddTask.mock.calls[0]![0]).toMatchObject({ assignee_ids: [FLAGGED] });
    // One click, one create: no confirm dialog stood between them.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a flagged assignee can still be removed and re-picked - the chip is not frozen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskDetailDrawer />, ASSIGN_ONLY);

    await waitFor(() => expect(within(chipFor('Alice Anderson')).getByText('No access')).toBeInTheDocument());
    // Two pickers hold Alice - assignees first in the DOM, watchers second.
    const remove = screen.getAllByRole('button', { name: 'Remove Alice Anderson' })[0]!;
    expect(remove).toBeEnabled();
    await user.click(remove);

    expect(mockSetAssignees).toHaveBeenCalledWith('t1', [CLEARED, UNCHECKED]);
  });
});
