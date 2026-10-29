import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import {
  createTask,
  listTasks,
  mapRowToTask,
  getTask,
  addCommentApi,
  addSubtaskApi,
  updateSubtaskApi,
  deleteSubtaskApi,
  nudgeApi,
  updateTaskApi,
} from '@/lib/api/tasks';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
import { toast } from '@/components/ui/use-toast';

// UUID regex (RFC-4122)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mockApi = vi.mocked(api);
const ROW = { id: 't1', task_number: 'T00001', title: 'X', description: '', status: 'TODO', priority: 'MEDIUM',
  assignee_ids: ['u1'], assignees: [{ id: 'u1', name: 'Oved Adani' }],
  due_at: null, linked_entity_type: 'JOB', linked_entity_id: 'job-1', tags: [],
  created_by: 'u1', created_at: '2026-06-17T00:00:00Z', updated_at: '2026-06-17T00:00:00Z', completed_at: null };

beforeEach(() => { vi.clearAllMocks(); });

it('createTask posts to /api/tasks and maps the row to a full Task', async () => {
  mockApi.post.mockResolvedValue({ data: { task: ROW } });
  const t = await createTask({ title: 'X', linked_entity: { type: 'JOB', id: 'job-1' } });
  expect(mockApi.post).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ title: 'X', linked_entity_id: 'job-1', linked_entity_type: 'JOB' }));
  expect(t.subtasks).toEqual([]);            // default-filled
  // Dangling shape: the create response never resolved a label, so it stays '' and NOT redacted.
  expect(t.linked_entity).toEqual({ type: 'JOB', id: 'job-1', label: '', redacted: false });
  expect(t.ai.source).toBe('manual');
});

it('listTasks passes the linked filter and maps rows', async () => {
  mockApi.get.mockResolvedValue({ data: { tasks: [ROW] } });
  const tasks = await listTasks({ linked_entity_type: 'JOB', linked_entity_id: 'job-1' });
  expect(mockApi.get).toHaveBeenCalledWith('/api/tasks', { params: { linked_entity_type: 'JOB', linked_entity_id: 'job-1' } });
  expect(tasks[0].watcher_ids).toEqual([]);
});

// ── Regression: entity id must be UUID, never a display number (J00001/L00001) ──
describe('createTask entity-id regression: linked_entity_id must be a UUID', () => {
  const JOB_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const JOB_ROW = { ...ROW, linked_entity_type: 'JOB', linked_entity_id: JOB_UUID };

  it('rejects J00001 as linked_entity_id (would 400 on the backend uuid validator)', () => {
    // Confirm "J00001" does NOT match UUID format — this is the class of bug being fixed
    expect('J00001').not.toMatch(UUID_RE);
    expect('L00001').not.toMatch(UUID_RE);
  });

  it('posts a UUID as linked_entity_id when presetEntity carries a UUID id', async () => {
    mockApi.post.mockResolvedValue({ data: { task: JOB_ROW } });
    // This is the shape JobLeadTasksTab passes — entity.id MUST be a UUID (job.id), not job.job_number
    await createTask({ title: 'Install AC', linked_entity: { type: 'JOB', id: JOB_UUID } });
    const [, body] = (mockApi.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(body.linked_entity_id).toMatch(UUID_RE);
    expect(body.linked_entity_id).toBe(JOB_UUID);
    expect(body.linked_entity_id).not.toBe('J00001'); // guard: display number must never reach the API
  });
});

describe('fetchTasks store loading guard', () => {
  it('second concurrent fetchTasks call is a no-op: api.get fires only once', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');

    // Reset store to unfetched state
    useTasksStore.setState({ tasks: [], loaded: false, loading: false });

    let resolveGet!: (v: unknown) => void;
    mockApi.get.mockReturnValue(
      new Promise((res) => { resolveGet = res; }) as ReturnType<typeof mockApi.get>,
    );

    // Fire two concurrent fetchTasks; second should see loading=true and return early
    const p1 = useTasksStore.getState().fetchTasks();
    const p2 = useTasksStore.getState().fetchTasks();

    resolveGet({ data: { tasks: [ROW] } });
    await Promise.all([p1, p2]);

    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(useTasksStore.getState().tasks).toHaveLength(1);
    expect(useTasksStore.getState().loaded).toBe(true);
    expect(useTasksStore.getState().loading).toBe(false);
  });

  it('fetchTasks is also a no-op when already loaded', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');

    // Simulate already-loaded state
    useTasksStore.setState({ tasks: [{ id: 'existing' } as never], loaded: true, loading: false });

    await useTasksStore.getState().fetchTasks();

    expect(mockApi.get).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });
});

it('getTask maps the detail row to a full Task', async () => {
  mockApi.get.mockResolvedValue({ data: { task: {
    ...ROW, linked_entity_label: 'J00934 · Access Control',
    risk: { score: 40, reason: 'high priority' },
    subtasks: [{ id:'s1', text:'Wire', done:true, position:0 }],
    comments: [{ id:'n1', body:'Ordered', author_id:'u1', author_name:'Oved Adani', at:'2026-06-17T00:00:00Z' }],
    activity: [{ id:'a1', type:'CREATED', description:'created the task', actor_id:'u1', actor_name:'Oved Adani', at:'2026-06-17T00:00:00Z', metadata:null }],
    watchers: [{ id:'u2', name:'Priya' }],
  } } });
  const t = await getTask('t1');
  expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  expect(t.subtasks[0].text).toBe('Wire');
  expect(t.comments[0].author_name).toBe('Oved Adani');
  expect(t.activity[0].type).toBe('created');
  expect(t.linked_entity?.label).toBe('J00934 · Access Control');
  expect(t.ai.risk_score).toBe(40);
});

// ── FE-2: rich write model ──────────────────────────────────────────────────

describe('addCommentApi', () => {
  it('POSTs /api/tasks/:id/comments with the body', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    await addCommentApi('t1', 'Great progress');
    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/comments', { body: 'Great progress' });
  });
});

describe('addSubtaskApi', () => {
  it('POSTs /api/tasks/:id/subtasks with the text', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    await addSubtaskApi('t1', 'Buy parts');
    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/subtasks', { text: 'Buy parts' });
  });
});

describe('updateSubtaskApi', () => {
  it('PATCHes /api/tasks/:id/subtasks/:sid with the patch', async () => {
    mockApi.patch.mockResolvedValue({ data: {} });
    await updateSubtaskApi('t1', 's1', { done: true });
    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1/subtasks/s1', { done: true });
  });

  it('can patch text as well', async () => {
    mockApi.patch.mockResolvedValue({ data: {} });
    await updateSubtaskApi('t1', 's1', { text: 'Updated text', done: false });
    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1/subtasks/s1', { text: 'Updated text', done: false });
  });
});

describe('deleteSubtaskApi', () => {
  it('DELETEs /api/tasks/:id/subtasks/:sid', async () => {
    mockApi.delete.mockResolvedValue({ data: {} });
    await deleteSubtaskApi('t1', 's1');
    expect(mockApi.delete).toHaveBeenCalledWith('/api/tasks/t1/subtasks/s1');
  });
});

describe('nudgeApi', () => {
  it('POSTs /api/tasks/:id/nudge', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    await nudgeApi('t1');
    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/nudge');
  });
});

describe('assignee_ids on the wire', () => {
  it('createTask OMITS assignee_ids when the caller did not choose any', async () => {
    // A missing key is the documented way to say "default to the actor"; an
    // EMPTY array is a 400 ("a task must have at least one assignee"). The two
    // must not be conflated by a helpful `?? []`.
    mockApi.post.mockResolvedValue({ data: { task: ROW } });
    await createTask({ title: 'X' });
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect('assignee_ids' in body).toBe(false);
  });

  it('createTask omits assignee_ids when handed an empty array', async () => {
    mockApi.post.mockResolvedValue({ data: { task: ROW } });
    await createTask({ title: 'X', assignee_ids: [] });
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect('assignee_ids' in body).toBe(false);
  });

  it('createTask forwards a chosen assignee set verbatim', async () => {
    mockApi.post.mockResolvedValue({ data: { task: ROW } });
    await createTask({ title: 'X', assignee_ids: ['u1', 'u2'] });
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.assignee_ids).toEqual(['u1', 'u2']);
  });

  it('updateTaskApi forwards assignee_ids in the PATCH body', async () => {
    mockApi.patch.mockResolvedValue({ data: { task: ROW } });
    await updateTaskApi('t1', { assignee_ids: ['u2', 'u3'] });
    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', expect.objectContaining({ assignee_ids: ['u2', 'u3'] }));
  });

  it('mapRowToTask materialises a ref for an id the row did not resolve', async () => {
    mockApi.get.mockResolvedValue({ data: { tasks: [{ ...ROW, assignee_ids: ['u1', 'ghost'] }] } });
    const [task] = await listTasks();
    // 'ghost' has no entry in `assignees`, so it must still render as a person.
    expect(task.assignee_ids).toEqual(['u1', 'ghost']);
    expect(task.assignees).toEqual([{ id: 'u1', name: 'Oved Adani' }, { id: 'ghost', name: null }]);
  });
});

describe('updateTaskApi watcher_ids', () => {
  it('forwards watcher_ids in the PATCH body', async () => {
    mockApi.patch.mockResolvedValue({ data: { task: ROW } });
    await updateTaskApi('t1', { watcher_ids: ['u2', 'u3'] });
    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', expect.objectContaining({ watcher_ids: ['u2', 'u3'] }));
  });
});

// ── Store action integration (resync) ───────────────────────────────────────

const DETAIL_ROW = {
  ...ROW,
  subtasks: [{ id: 's1', text: 'Wire', done: true, position: 0 }],
  comments: [{ id: 'n1', body: 'Ordered', author_id: 'u1', author_name: 'Oved', at: '2026-06-17T00:00:00Z' }],
  activity: [],
  watchers: [{ id: 'u2', name: 'Priya' }],
};

describe('store actions trigger fetchTaskDetail resync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setAssignees: PATCHes the new set then resyncs', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.patch.mockResolvedValue({ data: { task: ROW } });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().setAssignees('t1', ['u2', 'u3']);

    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', { assignee_ids: ['u2', 'u3'] });
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('setAssignees: refuses an EMPTY set locally instead of sending a doomed PATCH', async () => {
    // The server answers `assignee_ids: []` with a 400 ("a task must have at
    // least one assignee"). This is called from a multi-select's onChange, where
    // a rejected promise has nowhere to be caught - so the invariant is enforced
    // here, with a toast, and the widget resynced back to the real roster.
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().setAssignees('t1', []);

    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // ...and the drawer is put back in sync, so the removed chip reappears.
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('addComment: POSTs then resyncs from server', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().addComment('t1', 'hello');

    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/comments', { body: 'hello' });
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('addSubtask: POSTs then resyncs from server', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().addSubtask('t1', 'Buy parts');

    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/subtasks', { text: 'Buy parts' });
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('toggleSubtask: PATCHes the subtask then resyncs', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().toggleSubtask('t1', 's1', true);

    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1/subtasks/s1', { done: true });
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('deleteSubtask: DELETEs subtask then resyncs', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.delete.mockResolvedValue({ data: {} });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().deleteSubtask('t1', 's1');

    expect(mockApi.delete).toHaveBeenCalledWith('/api/tasks/t1/subtasks/s1');
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('setWatchers: PATCHes watcher_ids then resyncs', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.patch.mockResolvedValue({ data: { task: ROW } });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().setWatchers('t1', ['u2', 'u3']);

    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', expect.objectContaining({ watcher_ids: ['u2', 'u3'] }));
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('nudge: POSTs nudge then resyncs', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [{ id: 't1', title: 'X' } as never], loaded: true, loading: false });

    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().nudge('t1');

    expect(mockApi.post).toHaveBeenCalledWith('/api/tasks/t1/nudge');
    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('fetchTaskDetail pushes task into store if it does not exist yet', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [], loaded: true, loading: false });

    mockApi.get.mockResolvedValue({ data: { task: DETAIL_ROW } });

    await useTasksStore.getState().fetchTaskDetail('t1');

    const stored = useTasksStore.getState().tasks.find((t) => t.id === 't1');
    expect(stored).toBeDefined();
    expect(stored?.title).toBe('X');
  });
});

// ── #176: calendar drag-to-reschedule — optimistic apply + rollback ─────────

describe('reschedule optimistic + rollback', () => {
  const OLD_ISO = '2026-07-01T09:00:00.000Z';
  const NEW_ISO = '2026-07-15T09:00:00.000Z';

  beforeEach(() => { vi.clearAllMocks(); });

  it('applies due_at optimistically before the PATCH resolves, then reconciles with the server row preserving client-only keys', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({
      tasks: [{
        id: 't1', title: 'X', due_at: OLD_ISO,
        subtasks: [{ id: 's1', text: 'Wire', done: false, position: 0 }],
      } as never],
      loaded: true, loading: false,
    });

    let resolvePatch!: (v: unknown) => void;
    mockApi.patch.mockReturnValue(
      new Promise((res) => { resolvePatch = res; }) as ReturnType<typeof mockApi.patch>,
    );

    const p = useTasksStore.getState().reschedule('t1', NEW_ISO);

    // Optimistic: the chip moved before the API answered
    expect(useTasksStore.getState().tasks[0].due_at).toBe(NEW_ISO);

    resolvePatch({ data: { task: { ...ROW, due_at: NEW_ISO } } });
    await p;

    const t = useTasksStore.getState().tasks[0];
    expect(t.due_at).toBe(NEW_ISO);        // server value kept
    expect(t.subtasks).toHaveLength(1);    // client-only key survived the list-row reconcile
    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', { due_at: NEW_ISO });
  });

  it('rolls back due_at and fires a destructive toast when the PATCH fails', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({
      tasks: [{ id: 't1', title: 'X', due_at: OLD_ISO } as never],
      loaded: true, loading: false,
    });

    mockApi.patch.mockRejectedValue(new Error('500'));

    await useTasksStore.getState().reschedule('t1', NEW_ISO); // must not throw

    expect(useTasksStore.getState().tasks[0].due_at).toBe(OLD_ISO); // rolled back
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

// Task categories (visits-and-task-categories slice 08): the category travels as its id and
// comes back as { id, name, color } on the row.
describe('category on the wire', () => {
  const CATEGORY = { id: 'cat-parts', name: 'Part order', color: '#F97316' };

  it('createTask sends the picked category id', async () => {
    mockApi.post.mockResolvedValue({ data: { task: { ...ROW, category_id: CATEGORY.id, category: CATEGORY } } });
    const t = await createTask({ title: 'X', category_id: CATEGORY.id });
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ category_id: CATEGORY.id });
    expect(t.category).toEqual(CATEGORY);
  });

  it('createTask sends no category id when none was picked', async () => {
    mockApi.post.mockResolvedValue({ data: { task: { ...ROW, category: null } } });
    await createTask({ title: 'X', category_id: null });
    expect(mockApi.post.mock.calls[0][1]).not.toHaveProperty('category_id');
  });

  it('the store PATCHes category_id and keeps the category the server answers with', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [mapRowToTask({ ...ROW, category: null } as never)], loaded: true, loading: false });
    mockApi.patch.mockResolvedValue({ data: { task: { ...ROW, category_id: CATEGORY.id, category: CATEGORY } } });

    await useTasksStore.getState().updateTask('t1', { category: CATEGORY });

    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', { category_id: CATEGORY.id });
    expect(useTasksStore.getState().tasks[0].category).toEqual(CATEGORY);
  });

  it('the store clears the category with category_id null', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [mapRowToTask({ ...ROW, category: CATEGORY } as never)], loaded: true, loading: false });
    mockApi.patch.mockResolvedValue({ data: { task: { ...ROW, category_id: null, category: null } } });

    await useTasksStore.getState().updateTask('t1', { category: null });

    expect(mockApi.patch).toHaveBeenCalledWith('/api/tasks/t1', { category_id: null });
    expect(useTasksStore.getState().tasks[0].category).toBeNull();
  });
});
