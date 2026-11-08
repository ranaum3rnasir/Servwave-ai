/**
 * A task you only WATCH has to appear on your Board.
 *
 * #1776 scoped the Board to `assignee_ids.includes(me) || watcher_ids.includes(me)`. The
 * watcher half of that predicate could never be true: `mapRowToTask` - the mapper every list
 * read goes through - hardcoded `watcher_ids: []`, on the belief that only `GET /api/tasks/:id`
 * knows about watchers. It does not. `watcher_ids` is a `String[]` column and `GET /api/tasks`
 * answers by spreading the Prisma row, so the ids were on the wire the whole time and the
 * client threw them away.
 *
 * What that looked like: a task you were only watching was missing from your Board. Opening it
 * from anywhere else ran the detail fetch, which populated the real watchers, and the card
 * appeared - so it read as a refresh bug rather than a mapping one.
 *
 * The write paths (`POST /api/tasks`, `PATCH /api/tasks/:id`) spread the same row, so they
 * carry the field too. A response that genuinely omits it is the one case where the ids in
 * hand are the best answer, and it is pinned below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useAuthStore } from '@/stores/auth.store';
import type { Task } from '@/lib/tasks/types';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

import BoardView from '@/pages/v2/tasks/views/boardView';

/** setup.ts mocks auth.store as a selector fn, so the user is set by re-implementing it. */
function signedInAs(id: string) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id, role: 'ADMIN' }, isAuthenticated: true, isLoading: false, error: null }),
  );
}

const ME = 'admin-id';
const SOMEBODY_ELSE = 'tech-id';

function row(over: Partial<TaskRow>): TaskRow {
  return {
    id: 'x', task_number: 'T00000', title: 't', description: '',
    status: 'TODO', priority: 'MEDIUM',
    assignee_ids: [SOMEBODY_ELSE], assignees: [{ id: SOMEBODY_ELSE, name: null }],
    watcher_ids: [],
    due_at: null,
    linked_entity_type: null, linked_entity_id: null,
    linked_entity_label: null, linked_entity_redacted: false,
    tags: [],
    created_by: SOMEBODY_ELSE,
    created_at: '2026-08-20T10:00:00Z', updated_at: '2026-08-20T10:00:00Z',
    completed_at: null,
    ...over,
  } as TaskRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  // 'all' is the filter store's own no-filter sentinel - NOT null. Using null here would read
  // as an active member filter and disable the Board's self-scope entirely.
  useTaskFilterStore.getState().reset();
  signedInAs(ME);
});

describe('the list mapper carries watchers', () => {
  it('keeps the watcher ids the row came with', () => {
    const task = mapRowToTask(row({ watcher_ids: [ME, SOMEBODY_ELSE] }));
    expect(task.watcher_ids).toEqual([ME, SOMEBODY_ELSE]);
  });

  it('is empty when the row says the task has no watchers', () => {
    expect(mapRowToTask(row({ watcher_ids: [] })).watcher_ids).toEqual([]);
  });

  /**
   * Absent is not empty. A payload without the key has said nothing about watchers, so the
   * ones already in hand survive rather than being cleared - the same rule the linked-entity
   * fields follow on the write path.
   */
  it('keeps the watchers already held when a response omits the field entirely', () => {
    const { watcher_ids: _omitted, ...withoutTheKey } = row({});
    const prev = { watcher_ids: [ME] } as Task;

    expect(mapRowToTask(withoutTheKey as TaskRow, prev).watcher_ids).toEqual([ME]);
    // ...and with nothing in hand either, an empty list, never undefined: every reader calls
    // `.includes()` on this.
    expect(mapRowToTask(withoutTheKey as TaskRow).watcher_ids).toEqual([]);
  });
});

describe('the Board shows a task you only watch', () => {
  it('renders a watch-only task hydrated from GET /api/tasks', async () => {
    vi.mocked(api).get.mockResolvedValue({
      data: {
        tasks: [
          row({ id: 'watched', task_number: 'T00001', title: 'Watched not assigned', watcher_ids: [ME] }),
          row({ id: 'theirs', task_number: 'T00002', title: 'Neither mine nor watched' }),
        ],
      },
    } as never);

    await useTasksStore.getState().fetchTasks();
    renderWithProviders(<BoardView />);

    await waitFor(() => {
      expect(screen.getByText('Watched not assigned')).toBeInTheDocument();
    });
    expect(screen.queryByText('Neither mine nor watched')).not.toBeInTheDocument();
  });
});
