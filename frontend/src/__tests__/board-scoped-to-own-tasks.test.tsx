/**
 * The Board shows what the signed-in user is on; the List still shows the org.
 *
 * `taskVisibilityWhere` short-circuits for an ADMIN and returns every task in the org
 * (design section 4). That is right for the List - the management surface - and wrong for the
 * Board, which is where a person works their own queue: an admin in a real org would open it
 * onto every task the company has.
 *
 * Ran's call after the staging acceptance run: "admins can see everything in the list, but on
 * the board it is not necessary."
 *
 * An explicit member filter still wins, because the filter bar is shared by every tab and
 * "show me Dana's board" is a reasonable thing to ask on this one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useAuthStore } from '@/stores/auth.store';
import type { Task } from '@/lib/tasks/types';

/** setup.ts mocks auth.store as a selector fn, so the user is set by re-implementing it. */
function signedInAs(id: string | null) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: id ? { id, role: 'ADMIN' } : null, isAuthenticated: !!id, isLoading: false, error: null }),
  );
}

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));
// The Category facet reads the org's category list (slice 10); none is selected here.
vi.mock('@/lib/api/taskCategories', () => ({ useTaskCategories: () => ({ data: undefined }) }));

const ME = 'admin-id';
const SOMEBODY_ELSE = 'tech-id';

function task(over: Partial<Task>): Task {
  return {
    id: 'x', task_number: 'T00000', title: 't', description: '',
    status: 'TODO', priority: 'MEDIUM',
    assignee_ids: [], assignees: [], watcher_ids: [], watchers: [],
    due_at: null, linked_entity: null, tags: [], subtasks: [],
    created_by: ME, created_at: '2026-08-25T10:00:00Z',
    updated_at: '2026-08-25T10:00:00Z', completed_at: null,
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...over,
  } as Task;
}

const MINE       = task({ id: 'mine',    task_number: 'T00001', assignee_ids: [ME] });
const WATCHING   = task({ id: 'watch',   task_number: 'T00002', assignee_ids: [SOMEBODY_ELSE], watcher_ids: [ME] });
const SOMEONES   = task({ id: 'theirs',  task_number: 'T00003', assignee_ids: [SOMEBODY_ELSE] });

beforeEach(() => {
  useTasksStore.setState({ tasks: [MINE, WATCHING, SOMEONES], loaded: true, loading: false });
  // 'all' is the store's own no-filter sentinel - NOT null. Using null here would read as an
  // active member filter and silently empty every assertion below.
  useTaskFilterStore.getState().reset();
  signedInAs(ME);
});

const numbers = (r: { result: { current: Task[] } }) => r.result.current.map((t) => t.task_number).sort();

describe('the Board scopes to the signed-in user', () => {
  it('keeps tasks they are assigned to and tasks they watch, drops the rest', () => {
    const r = renderHook(() => useFilteredTasks({ scopeToSelf: true }));
    expect(numbers(r)).toEqual(['T00001', 'T00002']);
  });

  it('an explicit member filter overrides the self-scope', () => {
    useTaskFilterStore.getState().setMember(SOMEBODY_ELSE);
    const r = renderHook(() => useFilteredTasks({ scopeToSelf: true }));
    expect(numbers(r)).toEqual(['T00002', 'T00003']);
  });

  /**
   * Auth resolves a tick after the store hydrates. Narrowing to nobody would flash an empty
   * board, so an unresolved user leaves the list alone rather than filtering it to zero.
   */
  it('does not blank the board while auth is still resolving', () => {
    signedInAs(null);
    const r = renderHook(() => useFilteredTasks({ scopeToSelf: true }));
    expect(numbers(r)).toEqual(['T00001', 'T00002', 'T00003']);
  });
});

describe('the List is untouched', () => {
  it('still shows every task the API returned', () => {
    const r = renderHook(() => useFilteredTasks());
    expect(numbers(r)).toEqual(['T00001', 'T00002', 'T00003']);
  });
});
