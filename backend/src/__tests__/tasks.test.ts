import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, stubTaskRowLocks } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  task: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  taskSubtask: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  user: {
    findMany: ReturnType<typeof vi.fn>;
  };
  job: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────

const JOB_ID = '10000000-0000-0000-0000-000000000001';
const TASK_ID = 'aa000000-0000-0000-0000-000000000001';

const TASK_FIXTURE = {
  id: TASK_ID,
  task_number: 'T00001',
  organization_id: ALPHA_ORG_ID,
  title: 'Inspect compressor',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [] as string[],
  due_at: null,
  linked_entity_type: 'JOB',
  linked_entity_id: JOB_ID,
  tags: [],
  completed_at: null,
  created_by: '00000000-0000-0000-0000-000000000001',
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids: [],
  _count: { subtasks: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.task.findMany.mockResolvedValue([TASK_FIXTURE]);
  mockPrisma.task.findFirst.mockResolvedValue(TASK_FIXTURE);
  mockPrisma.task.create.mockResolvedValue(TASK_FIXTURE);
  mockPrisma.task.update.mockResolvedValue(TASK_FIXTURE);
  mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
  stubTaskRowLocks();
  // Default $transaction: execute the callback with prisma (so tx.task.create resolves)
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  // Enrichment resolvers: default to empty arrays so non-enrichment tests don't crash
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  // #245 row checks: the linked JOB resolves as in-tenant/in-scope by default, so tests that
  // exercise non-row concerns (create link gate, sales delete via linked-JOB scope) stay green.
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
  mockPrisma.taskSubtask.findFirst.mockResolvedValue(null);
  mockPrisma.taskSubtask.create.mockResolvedValue({ id: 'sub-1', task_id: TASK_ID, text: 'Check valve', done: false, position: 0, created_at: new Date('2026-06-18') });
  mockPrisma.taskSubtask.update.mockResolvedValue({ id: 'sub-1', task_id: TASK_ID, text: 'Check valve', done: true, position: 0, created_at: new Date('2026-06-18') });
  mockPrisma.taskSubtask.delete.mockResolvedValue({ id: 'sub-1' });
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.note.create.mockResolvedValue({
    id: 'note-1',
    content: 'Looks good',
    created_by: '00000000-0000-0000-0000-000000000001',
    created_at: new Date('2026-06-18'),
    entity_type: 'TASK',
    entity_id: TASK_ID,
    organization_id: ALPHA_ORG_ID,
  });
  mockPrisma.note.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.deleteMany.mockResolvedValue({ count: 0 });
});

// ══════════════════════════════════════════════════════
// 1. GET /api/tasks — admin list (tenant scoped)
// ══════════════════════════════════════════════════════

describe('GET /api/tasks', () => {
  it('admin can list all tasks (200, array, tenant-scoped)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/tasks')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks[0].task_number).toBe('T00001');

    // Confirm tenantWhere (organization_id) applied to findMany
    const args = mockPrisma.task.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({ organization_id: ALPHA_ORG_ID });
  });

  it('admin can filter tasks by linked entity (200, where carries linked fields)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/tasks?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    const args = mockPrisma.task.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      linked_entity_type: 'JOB',
      linked_entity_id: JOB_ID,
    });
  });

  it('technician can list tasks (200) — has read:Task grant', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/tasks')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
  });

  // Design §4 — assignee OR watcher, and NOTHING else. `created_by` was an arm until the
  // multi-assignee change and is deliberately gone: creating is an event, not a role.
  it('non-admin list is scoped to assignee OR watcher (no created_by arm)', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/tasks').set(authHeader('technician'));
    const where = (mockPrisma.task.findMany.mock.calls[0][0] as any).where;
    expect(where.OR).toEqual([
      { assignee_ids: { has: expect.any(String) } },
      { watcher_ids: { has: expect.any(String) } },
    ]);
  });

  it('list enriches each task with assignees, label, and risk', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findMany.mockResolvedValue([{ ...TASK_FIXTURE, assignee_ids: ['00000000-0000-0000-0000-000000000001'] }]);
    // assignee-name + label resolvers read these:
    mockPrisma.user.findMany.mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000001', first_name: 'Oved', last_name: 'Adani' }]);
    mockPrisma.job.findMany.mockResolvedValue([{ id: JOB_ID, job_number: 'J00934', job_type: 'Access Control' }]);
    const res = await request(app).get('/api/tasks').set(authHeader('admin'));
    expect(res.body.tasks[0].assignees).toEqual([
      { id: '00000000-0000-0000-0000-000000000001', name: 'Oved Adani' },
    ]);
    expect(res.body.tasks[0].owner_name).toBeUndefined();
    expect(res.body.tasks[0].linked_entity_label).toBe('J00934 · Access Control');
    expect(res.body.tasks[0].risk).toHaveProperty('score');
  });
});

// ══════════════════════════════════════════════════════
// 2. POST /api/tasks — admin create
// ══════════════════════════════════════════════════════

describe('POST /api/tasks', () => {
  it('admin can create a task (201, task_number allocated, linked fields persisted)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({
        title: 'Inspect compressor',
        linked_entity_type: 'JOB',
        linked_entity_id: JOB_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.task.task_number).toMatch(/^T\d+/);

    // Verify the create call captured linked fields + tenant scope
    const createArgs = mockPrisma.task.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.organization_id).toBe(ALPHA_ORG_ID);
    expect(createArgs.data.linked_entity_type).toBe('JOB');
    expect(createArgs.data.linked_entity_id).toBe(JOB_ID);
  });

  // INVERTED by the multi-assignee change: the creator used to be force-added to watcher_ids.
  // Watchers are a deliberate observer list now and default to nobody (design §1/§3).
  it('create records CREATED activity and does NOT add the creator as a watcher', async () => {
    mockAuthAs('admin');
    await request(app).post('/api/tasks').set(authHeader('admin')).send({ title: 'X' });
    const createArgs = mockPrisma.task.create.mock.calls[0][0] as any;
    expect(createArgs.data.watcher_ids).toEqual([]);
    expect(createArgs.data.assignee_ids).toEqual(['00000000-0000-0000-0000-000000000001']); // admin id from helpers
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entity_type: 'TASK', event_type: 'CREATED' }) }),
    );
  });
});

// ══════════════════════════════════════════════════════
// 3. PATCH /api/tasks/:id — status DONE sets completed_at, IN_PROGRESS clears it
// ══════════════════════════════════════════════════════

describe('PATCH /api/tasks/:id', () => {
  it('status → DONE sets completed_at', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ status: 'DONE' });

    expect(res.status).toBe(200);

    const updateArgs = mockPrisma.task.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArgs.data.completed_at).toBeInstanceOf(Date);
  });

  it('status → IN_PROGRESS clears completed_at', async () => {
    mockAuthAs('admin');
    // Simulate a previously-completed task
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'DONE', completed_at: new Date() });
    mockPrisma.task.update.mockResolvedValue({ ...TASK_FIXTURE, status: 'IN_PROGRESS', completed_at: null });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ status: 'IN_PROGRESS' });

    expect(res.status).toBe(200);

    const updateArgs = mockPrisma.task.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArgs.data.completed_at).toBeNull();
  });

  // ── Issue 03: CANCELLED ─────────────────────────────────────────────────────
  it('status → CANCELLED leaves completed_at NULL; a cancelled task never finished', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'TODO' });
    mockPrisma.task.update.mockResolvedValue({ ...TASK_FIXTURE, status: 'CANCELLED', completed_at: null });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.task.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data.status).toBe('CANCELLED');
    expect(updateArgs.data.completed_at).toBeNull();
  });

  it('cancelling a task that was DONE CLEARS completed_at', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'DONE', completed_at: new Date() });
    mockPrisma.task.update.mockResolvedValue({ ...TASK_FIXTURE, status: 'CANCELLED', completed_at: null });

    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'CANCELLED' });

    const updateArgs = mockPrisma.task.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data.completed_at).toBeNull();
  });

  it('patch status→CANCELLED records CANCELLED, never COMPLETED', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'IN_PROGRESS' });
    mockPrisma.task.update.mockResolvedValue({ ...TASK_FIXTURE, status: 'CANCELLED' });

    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'CANCELLED' });

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'CANCELLED' }) }),
    );
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'COMPLETED' }) }),
    );
  });

  it('a cancelled task can be REOPENED to TODO', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'CANCELLED', completed_at: null });
    mockPrisma.task.update.mockResolvedValue({ ...TASK_FIXTURE, status: 'TODO', completed_at: null });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ status: 'TODO' });

    // Nothing in the transition logic is allowed to trap a task in CANCELLED.
    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.task.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data.status).toBe('TODO');
    expect(updateArgs.data.completed_at).toBeNull();
  });

  it('patch status→DONE sets completed_at and records COMPLETED', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'TODO' });
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'DONE' });
    const updArgs = mockPrisma.task.update.mock.calls[0][0] as any;
    expect(updArgs.data.completed_at).toBeInstanceOf(Date);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'COMPLETED' }) }),
    );
  });
});

// ══════════════════════════════════════════════════════
// 4. DELETE /api/tasks/:id — technician → 403
// ══════════════════════════════════════════════════════

describe('DELETE /api/tasks/:id', () => {
  it('technician cannot delete a task (403)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    // delete should NOT have been called
    expect(mockPrisma.task.deleteMany.mock.calls.length).toBe(0);
  });

  it('admin can delete a task (204)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('sales can delete a task (204) — exercises DEFAULT_GRANTS delete:Task path', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue(TASK_FIXTURE);

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(204);
    expect(mockPrisma.task.deleteMany.mock.calls.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════
// 5. GET /api/tasks/:id — detail with includes
// ══════════════════════════════════════════════════════

describe('GET /api/tasks/:id', () => {
  it('returns task with subtasks, comments, activity, watcher names', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: ['u-1'], watcher_ids: ['u-2'] });
    mockPrisma.taskSubtask.findMany.mockResolvedValue([{ id: 's1', task_id: TASK_ID, text: 'Wire reader', done: true, position: 0 }]);
    mockPrisma.note.findMany.mockResolvedValue([{ id: 'n1', content: 'Ordered', created_by: 'u-1', created_at: new Date(), entity_type: 'TASK', entity_id: TASK_ID }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([{ id: 't1', event_type: 'CREATED', description: 'created the task', created_by: 'u-1', created_at: new Date(), metadata: null }]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u-1', first_name: 'Oved', last_name: 'Adani' }, { id: 'u-2', first_name: 'Priya', last_name: 'D' }]);
    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.task.subtasks[0].text).toBe('Wire reader');
    expect(res.body.task.comments[0].author_name).toBe('Oved Adani');
    expect(res.body.task.activity[0].type).toBe('CREATED');
    expect(res.body.task.watchers).toEqual([{ id: 'u-2', name: 'Priya D' }]);
    expect(res.body.task.assignees).toEqual([{ id: 'u-1', name: 'Oved Adani' }]);
  });
  it('404 when task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════
// 6. POST /api/tasks/:id/comments — add comment via Note
// ══════════════════════════════════════════════════════

describe('POST /api/tasks/:id/comments', () => {
  it('201: creates a Note with entity_type TASK and records COMMENTED activity', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: 'Looks good' });

    expect(res.status).toBe(201);

    // note.create must have been called with entity_type:'TASK' and the task id
    expect(mockPrisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'TASK',
          entity_id: TASK_ID,
          content: 'Looks good',
          organization_id: ALPHA_ORG_ID,
        }),
      }),
    );

    // COMMENTED activity event recorded
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'TASK',
          entity_id: TASK_ID,
          event_type: 'COMMENTED',
        }),
      }),
    );

    // Response shape: { comment: { id, body, author_id, at } }
    expect(res.body.comment).toMatchObject({
      id: 'note-1',
      body: 'Looks good',
      author_id: '00000000-0000-0000-0000-000000000001',
    });
    expect(res.body.comment.at).toBeDefined();
  });

  it('404 when task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: 'Hello' });

    expect(res.status).toBe(404);
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });

  it('400 when body is empty string', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: '' });

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════
// 7. Subtask CRUD — POST/PATCH/DELETE /api/tasks/:id/subtasks
// ══════════════════════════════════════════════════════

const SUBTASK_ID = 'bb000000-0000-0000-0000-000000000002';

describe('POST /api/tasks/:id/subtasks', () => {
  it('201: creates a subtask with task_id and returns { subtask }', async () => {
    mockAuthAs('admin');
    // task.findFirst returns TASK_FIXTURE (tenant check passes — set in beforeEach)
    mockPrisma.taskSubtask.create.mockResolvedValue({
      id: SUBTASK_ID,
      task_id: TASK_ID,
      text: 'Check valve',
      done: false,
      position: 0,
      created_at: new Date('2026-06-18'),
    });

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/subtasks`)
      .set(authHeader('admin'))
      .send({ text: 'Check valve' });

    expect(res.status).toBe(201);
    expect(res.body.subtask).toMatchObject({ task_id: TASK_ID, text: 'Check valve' });

    // Verify create was called with correct task_id
    const createArgs = mockPrisma.taskSubtask.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.task_id).toBe(TASK_ID);
    expect(createArgs.data.text).toBe('Check valve');
  });

  it('400 when text is empty string', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/subtasks`)
      .set(authHeader('admin'))
      .send({ text: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.taskSubtask.create).not.toHaveBeenCalled();
  });

  it('404 when parent task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/subtasks`)
      .set(authHeader('admin'))
      .send({ text: 'Check valve' });

    expect(res.status).toBe(404);
    expect(mockPrisma.taskSubtask.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tasks/:id/subtasks/:subtaskId', () => {
  it('200: toggles done=true on an existing subtask', async () => {
    mockAuthAs('admin');
    // task.findFirst passes (beforeEach default)
    mockPrisma.taskSubtask.findFirst.mockResolvedValue({
      id: SUBTASK_ID,
      task_id: TASK_ID,
      text: 'Check valve',
      done: false,
      position: 0,
      created_at: new Date('2026-06-18'),
    });
    mockPrisma.taskSubtask.update.mockResolvedValue({
      id: SUBTASK_ID,
      task_id: TASK_ID,
      text: 'Check valve',
      done: true,
      position: 0,
      created_at: new Date('2026-06-18'),
    });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'))
      .send({ done: true });

    expect(res.status).toBe(200);
    expect(res.body.subtask.done).toBe(true);

    const updateArgs = mockPrisma.taskSubtask.update.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(updateArgs.data).toMatchObject({ done: true });
    expect(updateArgs.where.id).toBe(SUBTASK_ID);
  });

  it('404 when parent task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'))
      .send({ done: true });

    expect(res.status).toBe(404);
    expect(mockPrisma.taskSubtask.update).not.toHaveBeenCalled();
  });

  it('404 when subtask does not belong to the task', async () => {
    mockAuthAs('admin');
    // task.findFirst passes but subtask.findFirst returns null (wrong task_id)
    mockPrisma.taskSubtask.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'))
      .send({ done: true });

    expect(res.status).toBe(404);
    expect(mockPrisma.taskSubtask.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/tasks/:id/subtasks/:subtaskId', () => {
  it('204: deletes a subtask', async () => {
    mockAuthAs('admin');
    mockPrisma.taskSubtask.findFirst.mockResolvedValue({
      id: SUBTASK_ID,
      task_id: TASK_ID,
      text: 'Check valve',
      done: false,
      position: 0,
      created_at: new Date('2026-06-18'),
    });

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.taskSubtask.delete).toHaveBeenCalledWith({ where: { id: SUBTASK_ID } });
  });

  it('404 when parent task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.taskSubtask.delete).not.toHaveBeenCalled();
  });

  it('404 when subtask does not belong to the task', async () => {
    mockAuthAs('admin');
    mockPrisma.taskSubtask.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.taskSubtask.delete).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// 8. POST /api/tasks/:id/nudge — records NUDGED activity
// ══════════════════════════════════════════════════════

describe('POST /api/tasks/:id/nudge', () => {
  it('200: records NUDGED activity and returns { task }', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/nudge`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ id: TASK_ID });

    // NUDGED timeline event must have been recorded
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'TASK',
          entity_id: TASK_ID,
          event_type: 'NUDGED',
        }),
      }),
    );
  });

  it('404 when task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/nudge`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// 9. GET /api/tasks/summary — open/overdue/at_risk/next_due_at per entity
// ══════════════════════════════════════════════════════

describe('GET /api/tasks/summary', () => {
  it('400 without entity params', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/tasks/summary').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
  it('returns open/overdue/at_risk/next_due_at for the entity (tenant-scoped)', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    mockPrisma.task.findMany.mockResolvedValue([
      { status: 'TODO', priority: 'URGENT', due_at: new Date(now - 86400000), completed_at: null }, // overdue + at-risk
      { status: 'IN_PROGRESS', priority: 'LOW', due_at: new Date(now + 2*86400000), completed_at: null }, // open, future
      { status: 'DONE', priority: 'HIGH', due_at: new Date(now - 5*86400000), completed_at: new Date() }, // ignored
    ]);
    const res = await request(app)
      .get(`/api/tasks/summary?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: 2, overdue: 1 });
    expect(res.body.at_risk).toBeGreaterThanOrEqual(1);
    expect(res.body.next_due_at).not.toBeNull();
    const where = (mockPrisma.task.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ organization_id: ALPHA_ORG_ID, linked_entity_type: 'JOB', linked_entity_id: JOB_ID });
  });

  // ── Issue 03: CANCELLED counts as closed everywhere DONE does ────────────────
  it('a CANCELLED task is not open, not overdue and not at risk', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    mockPrisma.task.findMany.mockResolvedValue([
      { status: 'TODO', priority: 'LOW', due_at: new Date(now + 2*86400000), completed_at: null },
      // Overdue and URGENT: it would score ~100 and count as open+overdue if CANCELLED were
      // treated as an open status. completed_at is NULL, as a cancellation always leaves it.
      { status: 'CANCELLED', priority: 'URGENT', due_at: new Date(now - 5*86400000), completed_at: null },
      { status: 'DONE', priority: 'HIGH', due_at: new Date(now - 5*86400000), completed_at: new Date() },
    ]);

    const res = await request(app)
      .get(`/api/tasks/summary?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: 1, overdue: 0, at_risk: 0 });
  });

  it('reopening that same task to TODO restores it to the open count', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    mockPrisma.task.findMany.mockResolvedValue([
      { status: 'TODO', priority: 'LOW', due_at: new Date(now + 2*86400000), completed_at: null },
      { status: 'TODO', priority: 'URGENT', due_at: new Date(now - 5*86400000), completed_at: null },
    ]);

    const res = await request(app)
      .get(`/api/tasks/summary?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: 2, overdue: 1 });
    expect(res.body.at_risk).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════
// QA-Fix-4a. POST /api/tasks — ai_source defaults to MANUAL when omitted
// ══════════════════════════════════════════════════════

describe('POST /api/tasks — ai_source default', () => {
  it('create without ai_source persists ai_source as MANUAL', async () => {
    mockAuthAs('admin');
    await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: 'No source provided' });

    const createArgs = mockPrisma.task.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.ai_source).toBe('MANUAL');
  });

  it('create with explicit ai_source preserves it', async () => {
    mockAuthAs('admin');
    await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: 'AI extracted', ai_source: 'AI_EXTRACT' });

    const createArgs = mockPrisma.task.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.ai_source).toBe('AI_EXTRACT');
  });
});

// ══════════════════════════════════════════════════════
// QA-Fix-4b. GET /api/tasks/:id — detail returns created_by_name
// ══════════════════════════════════════════════════════

describe('GET /api/tasks/:id — created_by_name', () => {
  it('detail response includes created_by_name resolved from user table', async () => {
    mockAuthAs('admin');
    const CREATOR_ID = '00000000-0000-0000-0000-000000000001';
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, created_by: CREATOR_ID, assignee_ids: [], watcher_ids: [] });
    mockPrisma.user.findMany.mockResolvedValue([{ id: CREATOR_ID, first_name: 'Oved', last_name: 'Adani' }]);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.task.created_by_name).toBe('Oved Adani');
  });

  it('created_by_name is null when creator not found in user table', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, created_by: 'unknown-uuid', assignee_ids: [], watcher_ids: [] });
    mockPrisma.user.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.task.created_by_name).toBeNull();
  });
});

// ══════════════════════════════════════════════════════
// 10. DELETE /api/tasks/:id — cleanup (Note goes, TimelineEvent stays)
// ══════════════════════════════════════════════════════
//
// Issue 04 reversed half of this: the notes are still swept, the timeline is the audit trail and
// survives. The full contract (the final DELETED event and its snapshot, and the two org-wide
// readers that now meet an orphaned event) is covered in task-delete-audit-trail.test.ts.

describe('DELETE /api/tasks/:id — cleanup', () => {
  it('deletes polymorphic Note rows, and the task, but keeps its TimelineEvent rows', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);

    // note.deleteMany called with entity_type TASK + entity_id + org scope
    expect(mockPrisma.note.deleteMany).toHaveBeenCalledWith({
      where: { entity_type: 'TASK', entity_id: { in: [TASK_ID] }, organization_id: ALPHA_ORG_ID },
    });

    // The audit trail is NOT swept with the row it describes.
    expect(mockPrisma.timelineEvent.deleteMany).not.toHaveBeenCalled();

    // task.delete called after the cleanup
    expect(mockPrisma.task.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [TASK_ID] }, organization_id: ALPHA_ORG_ID } });
  });

  it('technician still gets 403 (canDo gate unchanged)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.note.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.deleteMany).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// 11. Multi-assignee (design §3) — who may put whom on a task
// ══════════════════════════════════════════════════════

const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000aa';
const TECH_ID = '00000000-0000-0000-0000-000000000004'; // TEST_USERS.technician

describe('POST /api/tasks — assignment authority', () => {
  it('a caller WITHOUT assign:Task is force-assigned to themselves (and only themselves)', async () => {
    mockAuthAs('dispatcher'); // DEFAULT_GRANTS gives DISPATCHER no assign:Task

    const res = await request(app).post('/api/tasks').set(authHeader('dispatcher')).send({ title: 'my own to-do' });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.task.create.mock.calls[0][0] as any;
    expect(createArgs.data.assignee_ids).toEqual(['00000000-0000-0000-0000-000000000002']);
  });

  it('a caller WITHOUT assign:Task asking for someone else → 403, nothing created', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('dispatcher'))
      .send({ title: 'work for you', assignee_ids: [OTHER_USER_ID] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'You can only assign tasks to yourself.' });
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });

  it('a caller WITHOUT assign:Task naming exactly themselves is fine (201)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('dispatcher'))
      .send({ title: 'mine', assignee_ids: ['00000000-0000-0000-0000-000000000002'] });

    expect(res.status).toBe(201);
  });

  it('a grant holder creating for someone else leaves the CREATOR off the task', async () => {
    mockAuthAs('admin'); // ADMIN holds assign:Task via `manage all`
    mockPrisma.user.findMany.mockResolvedValue([{ id: OTHER_USER_ID, first_name: 'Dana', last_name: 'Cohen' }]);

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: 'delegated', assignee_ids: [OTHER_USER_ID] });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.task.create.mock.calls[0][0] as any;
    expect(createArgs.data.assignee_ids).toEqual([OTHER_USER_ID]);
    expect(createArgs.data.assignee_ids).not.toContain('00000000-0000-0000-0000-000000000001');
    expect(createArgs.data.watcher_ids).toEqual([]);
  });

  it('an assignee who is not an active user of the org → 400, nothing created', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]); // the probe finds nobody

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: 'ghost', assignee_ids: [OTHER_USER_ID] });

    expect(res.status).toBe(400);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tasks/:id — assignment authority', () => {
  it('empty assignee_ids → 400, task never updated', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'A task must have at least one assignee.' });
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('a caller WITHOUT assign:Task changing the roster → 403', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: [OTHER_USER_ID] });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('sales'))
      .send({ assignee_ids: ['00000000-0000-0000-0000-000000000003'] }); // self-join attempt

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'You can only assign tasks to yourself.' });
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('a caller WITHOUT assign:Task re-sending the SAME roster is not a change (200)', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: [OTHER_USER_ID] });
    mockPrisma.user.findMany.mockResolvedValue([{ id: OTHER_USER_ID, first_name: 'Dana', last_name: 'Cohen' }]);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('sales'))
      .send({ title: 'retitled', assignee_ids: [OTHER_USER_ID] });

    expect(res.status).toBe(200);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(1);
  });

  it('a grant holder swapping the roster logs one NAMED event per person', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: [OTHER_USER_ID] });
    mockPrisma.user.findMany.mockResolvedValue([
      { id: OTHER_USER_ID, first_name: 'Sagiv', last_name: 'Levi' },
      { id: TECH_ID, first_name: 'Dana', last_name: 'Cohen' },
    ]);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(200);
    const descriptions = mockPrisma.timelineEvent.create.mock.calls.map((c: any[]) => c[0].data.description);
    expect(descriptions).toEqual(['assigned Dana Cohen', 'unassigned Sagiv Levi']);
  });
});

describe('DELETE /api/tasks/:id — own-to-do escape hatch (design §3)', () => {
  it('a TECHNICIAN with NO delete grant deletes a task they created and solely own (204)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({
      ...TASK_FIXTURE,
      created_by: TECH_ID,
      assignee_ids: [TECH_ID],
      linked_entity_type: null,
      linked_entity_id: null,
    });

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(204);
    expect(mockPrisma.task.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('the exception does NOT extend to a shared task they created (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({
      ...TASK_FIXTURE,
      created_by: TECH_ID,
      assignee_ids: [TECH_ID, OTHER_USER_ID],
      linked_entity_type: null,
      linked_entity_id: null,
    });

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.task.deleteMany).not.toHaveBeenCalled();
  });

  it('a non-creator TECHNICIAN cannot delete an office task reached via a linked job (403)', async () => {
    mockAuthAs('technician');
    // Readable: the linked job is in their scope. NOT deletable: they neither created it nor
    // solely own it, and TECHNICIAN holds no delete:Task grant.
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: [OTHER_USER_ID] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.task.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.note.deleteMany).not.toHaveBeenCalled();
  });
});
