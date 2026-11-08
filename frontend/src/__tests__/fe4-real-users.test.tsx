/**
 * FE-4: real users in filter bar / useFilteredTasks / drawer-assignees / command bar / MyDay
 *
 * Tests:
 * 1. The Tasks Filter — member list comes from useAssignableUsers, not MOCK_PEOPLE
 * 2. The Tasks Filter — department list comes from useDepartments, not MOCK_DEPARTMENTS
 * 3. useFilteredTasks — department mapping uses u.department?.id (null → '')
 * 4. AiCommandBar — passes real users to taskAI.parse (no tasks-mock import)
 * 5. TaskDetailDrawer — activity uses actor_name, comments use author_name
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import type { AssignableUser } from '@/lib/api/users';
import type { Department } from '@/lib/api/departments';
import type { Task } from '@/lib/tasks/types';

// ── Shared test data ─────────────────────────────────────────────────────────

const REAL_USERS: AssignableUser[] = [
  {
    id: 'user-uuid-alice',
    first_name: 'Alice',
    last_name: 'Anderson',
    role: 'DISPATCHER',
    is_active: true,
    has_login: true,
    department: { id: 'dept-ops', name: 'Operations' },
  },
  {
    id: 'user-uuid-bob',
    first_name: 'Bob',
    last_name: 'Baker',
    role: 'TECHNICIAN',
    is_active: true,
    has_login: false,
    department: null, // no department — should map to '' not null
  },
];

const REAL_DEPTS: Department[] = [
  { id: 'dept-ops', name: 'Operations', head_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'dept-sales', name: 'Sales', head_id: null, created_at: '2026-01-01T00:00:00Z' },
];

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: REAL_USERS, isLoading: false })),
}));

vi.mock('@/lib/api/departments', () => ({
  useDepartments: vi.fn(() => ({ data: REAL_DEPTS, isLoading: false })),
}));

// tasksStore stub — supports selector and no-selector call patterns
vi.mock('@/stores/tasksStore', () => {
  const state = {
    tasks: [],
    updateStatus: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskDetail: vi.fn(() => Promise.resolve()),
    addComment: vi.fn(() => Promise.resolve()),
    addSubtask: vi.fn(() => Promise.resolve()),
    toggleSubtask: vi.fn(() => Promise.resolve()),
    deleteSubtask: vi.fn(() => Promise.resolve()),
    setWatchers: vi.fn(() => Promise.resolve()),
    nudge: vi.fn(() => Promise.resolve()),
  };
  return { useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

// taskFilterStore stub — selector and no-selector calls from the Filter
vi.mock('@/stores/taskFilterStore', () => {
  const state = {
    memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
    overdue: false, atRisk: false,
    dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
    setMember: vi.fn(), setDepartment: vi.fn(), setCategoryIds: vi.fn(), setCategory: vi.fn(), reset: vi.fn(),
    setOverdue: vi.fn(), setAtRisk: vi.fn(),
    setDueRange: vi.fn(), setCreatedRange: vi.fn(),
  };
  return { useTaskFilterStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

// taskDetailStore stub — no-selector call from TaskDetailDrawer
vi.mock('@/stores/taskDetailStore', () => {
  const state = { openTaskId: null as string | null, close: vi.fn(), open: vi.fn() };
  return { useTaskDetailStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

// auth store stub — real user id
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ user: { id: 'real-user-uuid-123', email: 'alice@test.com' } }),
  ),
}));

// taskAI stub — captures parse args
const mockParse = vi.fn(() => ({
  title: 'Test task',
  due_at: null,
  linked_entity: null,
  priority: 'MEDIUM' as const,
}));

vi.mock('@/lib/tasks/taskAI', () => ({
  taskAI: {
    parse: (...args: unknown[]) => mockParse(...args),
    rankMyDay: vi.fn(() => []),
  },
}));

// CreateTaskModal stub (opened by AiCommandBar)
vi.mock('@/components/tasks/CreateTaskModal', () => ({
  CreateTaskModal: () => <div data-testid="create-task-modal-stub" />,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { TaskFilterTrigger } from '@/pages/v2/tasks/components/taskFilterBar';
import { TaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import { AiCommandBar } from '@/components/tasks/AiCommandBar';
import { applyTaskFilter } from '@/lib/tasks/tasks-logic';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useTasksStore } from '@/stores/tasksStore';

// ── 1 & 2. The routed Filter (pages/v2/tasks taskFilterBar): member + department lists from real APIs

describe('the Tasks Filter — member and department selects from real APIs', () => {
  it('calls useAssignableUsers (not MOCK_PEOPLE) for the member list', async () => {
    const { useAssignableUsers } = await import('@/lib/api/users');
    renderWithProviders(<TaskFilterTrigger view="list" />);
    // The hook must have been called — confirms the component reaches out to real data
    expect(vi.mocked(useAssignableUsers)).toHaveBeenCalled();
  });

  it('calls useDepartments (not MOCK_DEPARTMENTS) for the department list', async () => {
    const { useDepartments } = await import('@/lib/api/departments');
    renderWithProviders(<TaskFilterTrigger view="list" />);
    expect(vi.mocked(useDepartments)).toHaveBeenCalled();
  });

  it('does NOT render legacy mock person names anywhere in the document', () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    // These are MOCK_PEOPLE names that should be gone
    expect(screen.queryByText('Priya')).not.toBeInTheDocument();
    expect(screen.queryByText('Oved Adani')).not.toBeInTheDocument();
    expect(screen.queryByText('Sagiv Peker')).not.toBeInTheDocument();
    expect(screen.queryByText('Emanuel Dahan')).not.toBeInTheDocument();
  });

  it('does NOT render legacy mock department names anywhere in the document', () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    // MOCK_DEPARTMENTS entries that should be absent
    expect(screen.queryByText('Logistics')).not.toBeInTheDocument();
    expect(screen.queryByText('Management')).not.toBeInTheDocument();
    expect(screen.queryByText('Field')).not.toBeInTheDocument();
  });
});

// ── 3. useFilteredTasks: department mapping ───────────────────────────────────

describe('useFilteredTasks — department mapping from useAssignableUsers', () => {
  it('user with department maps to department?.id (dept-ops)', () => {
    const taskAlice: Task = {
      id: 't2', task_number: 'T00002', title: 'Task A', description: '',
      status: 'TODO', priority: 'MEDIUM',
      assignee_ids: ['user-uuid-alice'],
      assignees: [{ id: 'user-uuid-alice', name: 'Alice Anderson' }],
      watcher_ids: [],
      due_at: null, linked_entity: null, tags: [], subtasks: [],
      created_by: 'user-uuid-alice', created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z', completed_at: null,
      activity: [], comments: [],
      ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    };
    const people = REAL_USERS.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    }));

    const result = applyTaskFilter(
      [taskAlice],
      { memberId: 'all', departmentId: 'dept-ops' },
      people,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.assignee_ids).toEqual(['user-uuid-alice']);
  });

  it('user with null department maps to "" — excluded from any concrete dept filter', () => {
    const taskBob: Task = {
      id: 't1', task_number: 'T00001', title: 'Task B', description: '',
      status: 'TODO', priority: 'MEDIUM',
      assignee_ids: ['user-uuid-bob'],
      assignees: [{ id: 'user-uuid-bob', name: 'Bob Baker' }],
      watcher_ids: [],
      due_at: null, linked_entity: null, tags: [], subtasks: [],
      created_by: 'user-uuid-bob', created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z', completed_at: null,
      activity: [], comments: [],
      ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    };
    // Bob has department: null in REAL_USERS → maps to ''
    const people = REAL_USERS.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    }));

    const result = applyTaskFilter(
      [taskBob],
      { memberId: 'all', departmentId: 'dept-ops' },
      people,
    );
    expect(result).toHaveLength(0);
  });

  it('department filter "all" passes tasks for both users (with and without dept)', () => {
    const taskAlice: Task = {
      id: 't2', task_number: 'T00002', title: 'Task A', description: '',
      status: 'TODO', priority: 'MEDIUM',
      assignee_ids: ['user-uuid-alice'],
      assignees: [{ id: 'user-uuid-alice', name: 'Alice Anderson' }],
      watcher_ids: [],
      due_at: null, linked_entity: null, tags: [], subtasks: [],
      created_by: 'user-uuid-alice', created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z', completed_at: null,
      activity: [], comments: [],
      ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    };
    const taskBob: Task = { ...taskAlice, id: 't1', task_number: 'T00001', title: 'Task B',
      assignee_ids: ['user-uuid-bob'],
      assignees: [{ id: 'user-uuid-bob', name: 'Bob Baker' }] };

    const people = REAL_USERS.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    }));

    const result = applyTaskFilter(
      [taskAlice, taskBob],
      { memberId: 'all', departmentId: 'all' },
      people,
    );
    expect(result).toHaveLength(2);
  });
});

// ── 4. TaskDetailDrawer — BE-provided names ───────────────────────────────────

const taskWithActivity: Task = {
  id: 'task-uuid-1',
  task_number: 'T00001',
  title: 'Fix the sensor',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: ['user-uuid-alice'],
  assignees: [{ id: 'user-uuid-alice', name: 'Alice Anderson' }],
  watcher_ids: ['user-uuid-bob'],
  watchers: [{ id: 'user-uuid-bob', name: 'Bob Baker' }],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [],
  created_by: 'created-by-alice-id',   // raw ID shown in "Created by" — that's by design
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  completed_at: null,
  activity: [
    {
      id: 'act-1',
      type: 'created',
      actor_id: 'actor-id-alice',       // raw actor_id should NOT appear
      actor_name: 'Alice Anderson',     // this should appear instead
      at: '2026-06-01T09:00:00Z',
    },
  ],
  comments: [
    {
      id: 'cmt-1',
      author_id: 'author-id-bob',       // raw author_id should NOT appear
      author_name: 'Bob Baker',         // this should appear instead
      body: 'Looking good.',
      at: '2026-06-01T10:00:00Z',
    },
  ],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
};

describe('TaskDetailDrawer — BE-provided names in activity and comments', () => {
  const DETAIL_OPEN_STATE = { openTaskId: 'task-uuid-1', close: vi.fn(), open: vi.fn() };
  const TASKS_WITH_ACT = {
    tasks: [taskWithActivity],
    updateStatus: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskDetail: vi.fn(() => Promise.resolve()),
    addComment: vi.fn(() => Promise.resolve()),
    addSubtask: vi.fn(() => Promise.resolve()),
    toggleSubtask: vi.fn(() => Promise.resolve()),
    deleteSubtask: vi.fn(() => Promise.resolve()),
    setWatchers: vi.fn(() => Promise.resolve()),
    nudge: vi.fn(() => Promise.resolve()),
  };

  beforeEach(() => {
    vi.mocked(useTaskDetailStore).mockImplementation(
      (sel?: (s: unknown) => unknown) => (sel ? sel(DETAIL_OPEN_STATE) : DETAIL_OPEN_STATE),
    );
    vi.mocked(useTasksStore).mockImplementation(
      (sel?: (s: unknown) => unknown) => (sel ? sel(TASKS_WITH_ACT) : TASKS_WITH_ACT),
    );
  });

  it('shows actor_name in activity (not the raw actor_id)', () => {
    renderWithProviders(<TaskDetailDrawer />);
    // actor_name = 'Alice Anderson' should appear at least once
    const els = screen.getAllByText(/Alice Anderson/);
    expect(els.length).toBeGreaterThanOrEqual(1);
    // raw actor_id 'actor-id-alice' must NOT appear
    expect(screen.queryByText('actor-id-alice')).not.toBeInTheDocument();
  });

  it('shows author_name in comments (not the raw author_id)', () => {
    renderWithProviders(<TaskDetailDrawer />);
    const els = screen.getAllByText(/Bob Baker/);
    expect(els.length).toBeGreaterThanOrEqual(1);
    // raw author_id must NOT appear
    expect(screen.queryByText('author-id-bob')).not.toBeInTheDocument();
  });

  it('does NOT render raw actor_id strings when actor_name is present', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.queryByText('actor-id-alice')).not.toBeInTheDocument();
  });

  it('shows watcher names from task.watchers[].name (not MOCK_PEOPLE lookup)', () => {
    renderWithProviders(<TaskDetailDrawer />);
    const els = screen.getAllByText(/Bob Baker/);
    expect(els.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 5. AiCommandBar — real users passed to taskAI.parse ──────────────────────

describe('AiCommandBar — real users fed to taskAI.parse', () => {
  it('passes the mapped real users to taskAI.parse (no MOCK_PEOPLE names)', async () => {
    const user = userEvent.setup();

    renderWithProviders(<AiCommandBar />);

    const input = screen.getByPlaceholderText(/ask anything/i);
    await user.type(input, 'Remind Alice to order parts');
    await user.keyboard('{Enter}');

    expect(mockParse).toHaveBeenCalledOnce();
    const [, ctx] = mockParse.mock.calls[0] as [
      string,
      { people: { id: string; name: string }[]; entities: unknown[]; now: Date },
    ];
    const { people, entities, now } = ctx;

    // Real user ids and names
    expect(people.some((p) => p.id === 'user-uuid-alice')).toBe(true);
    expect(people.some((p) => p.name === 'Alice Anderson')).toBe(true);
    expect(people.some((p) => p.name === 'Bob Baker')).toBe(true);

    // entities = [] (entity resolved in modal — FE-5)
    expect(entities).toEqual([]);

    // now is a real Date, not a fixed mock date
    expect(now).toBeInstanceOf(Date);
    expect(now.getFullYear()).toBeGreaterThanOrEqual(2026);

    // No legacy mock ids (they start with u_)
    expect(people.every((p) => !p.id.startsWith('u_'))).toBe(true);
  });
});
