/**
 * Staging acceptance follow-up: an edit must not blank the DETAIL-only fields.
 *
 * Sibling of `tasks-store-linked-entity-merge.test.ts`, and the same defect class one field
 * over. `PATCH /api/tasks/:id` answers with a LIST row, and the list mapper hardcodes
 * `subtasks: []`, `activity: []`, `comments: []`, `watcher_ids: []` and never sets
 * `created_by_name` or `watchers` at all - only `GET /api/tasks/:id` resolves those names.
 *
 * `tasksStore` spreads the mapped response over the row it holds, so every one of those keys
 * was blanked by any status change, rename or reschedule. The visible symptom found on staging:
 * the drawer renders `task.created_by_name ?? task.created_by`, so cancelling a task made
 * "Created by" flip from a person's name to their raw uuid until the drawer was reopened.
 *
 * Three write paths, one shared key list, so they cannot drift apart again. The mutators that
 * re-fetch the detail row outright (setAssignees / setWatchers / nudge / comments / subtasks)
 * are not in scope - they never merge a list row in the first place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import type { Task } from '@/lib/tasks/types';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const CREATOR = 'b3ce980d-2d9b-4492-9cb5-bc7ea422e35f';
const CREATOR_NAME = 'System Admin';
const WATCHER = { id: 'u9', name: 'Dana Levi' };

/** The raw row a WRITE path answers with - no resolved names, no rich arrays. */
const WRITE_ROW: TaskRow = {
  id: 't1',
  task_number: 'T00047',
  title: 'QA-2 cancel me',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [CREATOR],
  assignees: [{ id: CREATOR, name: CREATOR_NAME }],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  created_by: CREATOR,
  created_at: '2026-08-25T10:00:00Z',
  updated_at: '2026-08-25T10:00:00Z',
  completed_at: null,
};

/** What the store actually holds once the drawer has fetched `GET /api/tasks/:id`. */
const DETAIL: Task = {
  ...mapRowToTask(WRITE_ROW),
  created_by_name: CREATOR_NAME,
  watchers: [WATCHER],
  watcher_ids: [WATCHER.id],
  subtasks: [{ id: 's1', text: 'Check the valve', done: false }],
  comments: [{ id: 'c1', author_id: CREATOR, author_name: CREATOR_NAME, body: 'Looking at it', at: '2026-08-25T10:01:00Z' }],
  activity: [{ id: 'a1', type: 'created', actor_id: CREATOR, actor_name: CREATOR_NAME, at: '2026-08-25T10:00:00Z' }],
};

async function seed(task: Task) {
  const { useTasksStore } = await import('@/stores/tasksStore');
  useTasksStore.setState({ tasks: [task], loaded: true, loading: false });
  return useTasksStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// created_by_name - the field the staging run actually caught
// ---------------------------------------------------------------------------

describe('created_by_name survives a write', () => {
  it('updateStatus - cancelling from the drawer - keeps the creator NAME, not the uuid', async () => {
    const store = await seed(DETAIL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, status: 'CANCELLED' } } });

    await store.getState().updateStatus('t1', 'CANCELLED');

    const t = store.getState().tasks[0];
    expect(t.status).toBe('CANCELLED');
    expect(t.created_by_name).toBe(CREATOR_NAME);
    // The exact regression: the drawer's fallback would print this instead.
    expect(t.created_by_name ?? t.created_by).not.toBe(CREATOR);
  });

  it('updateTask - a priority or title edit - keeps the creator name', async () => {
    const store = await seed(DETAIL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, priority: 'HIGH' } } });

    await store.getState().updateTask('t1', { priority: 'HIGH' });

    expect(store.getState().tasks[0].created_by_name).toBe(CREATOR_NAME);
  });

  it('reschedule - the calendar drag - keeps the creator name', async () => {
    const store = await seed(DETAIL);
    const due = '2026-09-01T12:00:00.000Z';
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, due_at: due } } });

    await store.getState().reschedule('t1', due);

    const t = store.getState().tasks[0];
    expect(t.due_at).toBe(due);
    expect(t.created_by_name).toBe(CREATOR_NAME);
  });
});

// ---------------------------------------------------------------------------
// The rest of the detail-only set, blanked by the same spread
// ---------------------------------------------------------------------------

describe('the other detail-only fields survive a write', () => {
  it('updateStatus keeps watchers, subtasks, comments and activity', async () => {
    const store = await seed(DETAIL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, status: 'DONE' } } });

    await store.getState().updateStatus('t1', 'DONE');

    const t = store.getState().tasks[0];
    expect(t.watchers).toEqual([WATCHER]);
    expect(t.watcher_ids).toEqual([WATCHER.id]);
    expect(t.subtasks).toHaveLength(1);
    expect(t.comments).toHaveLength(1);
    expect(t.activity).toHaveLength(1);
  });

  /**
   * `updateTask` picked from `patch` - the CALLER's partial - rather than from the stored row.
   * The drawer sends `{ priority }` alone, so every key in the list restored nothing and the
   * empty server row won. This is the one path where the bug was the source, not the key list.
   */
  it('updateTask keeps them too, though the patch mentions none of them', async () => {
    const store = await seed(DETAIL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, title: 'Renamed' } } });

    await store.getState().updateTask('t1', { title: 'Renamed' });

    const t = store.getState().tasks[0];
    expect(t.title).toBe('Renamed');
    expect(t.watchers).toEqual([WATCHER]);
    expect(t.watcher_ids).toEqual([WATCHER.id]);
    expect(t.subtasks).toHaveLength(1);
    expect(t.comments).toHaveLength(1);
    expect(t.activity).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The merge must not resurrect anything for a row that never had it
// ---------------------------------------------------------------------------

describe('a list-only row is not given fields it never had', () => {
  it('leaves created_by_name unset when the store row never carried one', async () => {
    const store = await seed(mapRowToTask(WRITE_ROW));
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, status: 'DONE' } } });

    await store.getState().updateStatus('t1', 'DONE');

    const t = store.getState().tasks[0];
    expect(t.created_by_name ?? null).toBeNull();
    expect(t.created_by).toBe(CREATOR);
  });
});
