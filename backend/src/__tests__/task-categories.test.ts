import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Task categories foundation (visits-and-task-categories slice 08): an org-wide list of task
// categories, one optional category per task. Setting it rides the ordinary task create/update
// (no extra permission) but the id must name a category in the task's own organization.
// Prior art: inv-vendor-categories.test.ts.

const mockPrisma = prisma as unknown as {
  task: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  taskCategory: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  user: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const TASK_ID = 'aa000000-0000-4000-8000-000000000801';
const CAT_ID = 'c8000000-0000-4000-8000-000000000801';
const FOREIGN_CAT_ID = 'c8000000-0000-4000-8000-0000000008ff';
const CATEGORY = { id: CAT_ID, name: 'Part order', color: '#F97316' };

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  task_number: 'T00801',
  organization_id: ALPHA_ORG_ID,
  title: 'Order the hinge kit',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [TEST_USERS.technician.id],
  watcher_ids: [],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  category_id: null,
  category: null,
  completed_at: null,
  created_by: TEST_USERS.technician.id,
  created_at: new Date('2026-09-28'),
  updated_at: new Date('2026-09-28'),
  _count: { subtasks: 0 },
  ...over,
});

/** The category lookup answers only for ids in the caller's org - the tenant filter is real. */
function categoriesInOrg(rows: Array<{ id: string; name: string; color: string }>) {
  mockPrisma.taskCategory.findFirst.mockImplementation(
    async (args: { where: { id?: string; organization_id?: string } }) =>
      args.where.organization_id === ALPHA_ORG_ID ? rows.find((r) => r.id === args.where.id) ?? null : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.user.findMany.mockResolvedValue([]);
  categoriesInOrg([CATEGORY]);
});

describe('POST /api/tasks - category', () => {
  it('stores the category a creator picks', async () => {
    mockAuthAs('technician');
    mockPrisma.task.create.mockResolvedValue(taskRow({ category_id: CAT_ID, category: CATEGORY }));

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('technician'))
      .send({ title: 'Order the hinge kit', category_id: CAT_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.task.create.mock.calls[0][0].data.category_id).toBe(CAT_ID);
    expect(res.body.task.category).toEqual(CATEGORY);
  });

  it('creating one without a category is allowed', async () => {
    mockAuthAs('technician');
    mockPrisma.task.create.mockResolvedValue(taskRow());

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('technician'))
      .send({ title: 'Order the hinge kit' });

    expect(res.status).toBe(201);
    expect(mockPrisma.task.create.mock.calls[0][0].data.category_id).toBeNull();
    expect(res.body.task.category).toBeNull();
  });

  it('refuses a category id from another organization, and creates nothing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: 'Order the hinge kit', category_id: FOREIGN_CAT_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That category does not exist.');
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
    // The probe is tenant-scoped: that is what makes another org's id "not found".
    expect(mockPrisma.taskCategory.findFirst.mock.calls[0][0].where).toMatchObject({
      id: FOREIGN_CAT_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('PATCH /api/tasks/:id - category', () => {
  // A technician on the task can edit it - no TaskCategory grant beyond `read` is involved.
  const onTask = taskRow({ assignee_ids: [TEST_USERS.technician.id] });

  it('a non-admin who can edit the task changes its category', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue(onTask);
    mockPrisma.task.update.mockResolvedValue({ ...onTask, category_id: CAT_ID, category: CATEGORY });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ category_id: CAT_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.task.update.mock.calls[0][0].data).toEqual({ category_id: CAT_ID });
    expect(res.body.task.category).toEqual(CATEGORY);
  });

  it('clears the category with null', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({ ...onTask, category_id: CAT_ID });
    mockPrisma.task.update.mockResolvedValue(onTask);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ category_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.task.update.mock.calls[0][0].data).toEqual({ category_id: null });
    expect(res.body.task.category).toBeNull();
    expect(mockPrisma.taskCategory.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a category id from another organization, and changes nothing', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue(onTask);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ category_id: FOREIGN_CAT_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That category does not exist.');
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('someone who cannot see the task cannot set its category either', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [TEST_USERS.admin.id], created_by: TEST_USERS.admin.id }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ category_id: CAT_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});

describe('task payloads carry the category', () => {
  it('the list answers with each task\'s category (id, name, color)', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findMany.mockResolvedValue([taskRow({ category_id: CAT_ID, category: CATEGORY })]);

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].category).toEqual(CATEGORY);
    expect(mockPrisma.task.findMany.mock.calls[0][0].include.category).toEqual({
      select: { id: true, name: true, color: true },
    });
  });

  it('the detail answers with the category (id, name, color)', async () => {
    mockAuthAs('admin');
    const p = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;
    for (const model of ['taskSubtask', 'note', 'timelineEvent']) p[model].findMany.mockResolvedValue([]);
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ category_id: CAT_ID, category: CATEGORY }));

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.task.category).toEqual(CATEGORY);
    expect(mockPrisma.task.findFirst.mock.calls[0][0].include.category).toEqual({
      select: { id: true, name: true, color: true },
    });
  });
});

describe('GET /api/task-categories', () => {
  it('any role reads its own org\'s list, in order, with the chip fields', async () => {
    mockAuthAs('technician');
    mockPrisma.taskCategory.findMany.mockResolvedValue([
      { id: CAT_ID, name: 'Part order', color: '#F97316', sort_order: 1 },
    ]);

    const res = await request(app).get('/api/task-categories').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([{ id: CAT_ID, name: 'Part order', color: '#F97316', sort_order: 1 }]);
    const args = mockPrisma.taskCategory.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ organization_id: ALPHA_ORG_ID });
    expect(args.orderBy).toEqual([{ sort_order: 'asc' }, { name: 'asc' }]);
  });
});

// Code review #6: the category is checked, then written. An admin deleting it in between makes the
// write fail on the foreign key (Prisma P2003 on tasks_category_id_fkey). That is the same fact as
// "no such category", so it gets the same 400 - never a generic 500 - and nothing is stored.
describe('a category deleted between the check and the write', () => {
  const fkRace = () =>
    Object.assign(new Error('Foreign key constraint violated on the constraint: `tasks_category_id_fkey`'), {
      code: 'P2003',
      meta: { modelName: 'Task', constraint: 'tasks_category_id_fkey' },
    });

  it('create answers "That category does not exist." (400)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.create.mockRejectedValue(fkRace());

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('technician'))
      .send({ title: 'Order the hinge kit', category_id: CAT_ID });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'That category does not exist.' });
  });

  it('update answers "That category does not exist." (400)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [TEST_USERS.technician.id] }));
    mockPrisma.task.update.mockRejectedValue(fkRace());

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ category_id: CAT_ID });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'That category does not exist.' });
  });

  it('another foreign-key failure is still a 500', async () => {
    mockAuthAs('technician');
    mockPrisma.task.create.mockRejectedValue(
      Object.assign(new Error('fk'), { code: 'P2003', meta: { modelName: 'Task', constraint: 'tasks_organization_id_fkey' } }),
    );

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('technician'))
      .send({ title: 'Order the hinge kit', category_id: CAT_ID });

    expect(res.status).toBe(500);
  });
});
