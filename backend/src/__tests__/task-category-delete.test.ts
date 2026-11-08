/**
 * Deleting a task category (visits-and-task-categories slice 11).
 *
 * DELETE /api/task-categories/:id takes a mode:
 *   keep          - the category goes, every task that carried it keeps going with none;
 *   move          - every task moves to another category of the SAME organization (a merge);
 *   delete_tasks  - every task in the category goes too, whatever its status, exactly as a manual
 *                   delete would take it: comments, subtasks (FK cascade), files, the DELETED
 *                   audit event, the bell, and one "Task is deleted" automation run per task.
 *                   The admin must send the category's name back, and the server compares it.
 * All of it in one transaction; admin-only.
 *
 * The client is mocked (setup.ts); an in-memory model behind it honours the `where` shapes the
 * code uses, so these tests assert outcomes (rows left, events written, runs dispatched). The
 * same behaviour against a real, migrated database is task-category-delete-db.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue([]),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;
const storage = supabaseAdmin.storage.from('attachments') as unknown as { remove: ReturnType<typeof vi.fn> };

const ADMIN = TEST_USERS.admin.id;
const DANA = 'aaaaaaa1-0000-0000-0000-000000000001';
const ELI = 'aaaaaaa1-0000-0000-0000-000000000002';

const PART_ORDER = 'c9000000-0000-4000-8000-000000000911';
const FOLLOW_UP = 'c9000000-0000-4000-8000-000000000912';
const OTHER_ORG_CAT = 'c9000000-0000-4000-8000-0000000009ff';

type Cat = { id: string; name: string; color: string; sort_order: number; organization_id: string };
type TaskRow = {
  id: string; task_number: string; title: string; status: string; organization_id: string;
  category_id: string | null; assignee_ids: string[]; watcher_ids: string[]; created_by: string;
};
type Poly = { id: string; entity_type: string; entity_id: string; organization_id: string };
type File = Poly & { storage_path: string | null; file_url: string };

let db: {
  categories: Cat[];
  tasks: TaskRow[];
  notes: Poly[];
  files: File[];
  events: Array<Record<string, any>>;
};

/** A task-ish row matching a Prisma `where` on the fields the code filters by. */
function hit(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && 'in' in v) {
      if (!v.in.includes(row[k])) return false;
    } else if (v && typeof v === 'object' && 'not' in v) {
      if (row[k] === v.not) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

const t = (n: number, over: Partial<TaskRow> = {}): TaskRow => ({
  id: `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  task_number: `T${String(n).padStart(5, '0')}`,
  title: `Task ${n}`,
  status: 'TODO',
  organization_id: ALPHA_ORG_ID,
  category_id: PART_ORDER,
  assignee_ids: [DANA],
  watcher_ids: [],
  created_by: ADMIN,
  ...over,
});

function install() {
  db = {
    categories: [
      { id: PART_ORDER, name: 'Part order', color: '#F97316', sort_order: 1, organization_id: ALPHA_ORG_ID },
      { id: FOLLOW_UP, name: 'Follow-up', color: '#22C55E', sort_order: 0, organization_id: ALPHA_ORG_ID },
      { id: OTHER_ORG_CAT, name: 'Permit', color: '#8B5CF6', sort_order: 0, organization_id: ORG_B_ID },
    ],
    tasks: [
      t(1, { assignee_ids: [DANA, ELI] }),
      t(2, { status: 'IN_PROGRESS' }),
      t(3, { status: 'DONE' }),
      t(4, { status: 'CANCELLED', watcher_ids: [ELI] }),
      t(5, { category_id: FOLLOW_UP }),
      t(6, { category_id: null }),
      t(7, { category_id: OTHER_ORG_CAT, organization_id: ORG_B_ID }),
    ],
    notes: [],
    files: [],
    events: [],
  };
  db.notes = db.tasks.map((x, i) => ({ id: `n${i}`, entity_type: 'TASK', entity_id: x.id, organization_id: x.organization_id }));
  db.files = [
    { id: 'f1', entity_type: 'TASK', entity_id: t(1).id, organization_id: ALPHA_ORG_ID, storage_path: `${ALPHA_ORG_ID}/task/${t(1).id}/a.jpg`, file_url: '' },
    { id: 'f2', entity_type: 'TASK', entity_id: t(5).id, organization_id: ALPHA_ORG_ID, storage_path: `${ALPHA_ORG_ID}/task/${t(5).id}/b.jpg`, file_url: '' },
  ];

  const c = mockPrisma.taskCategory;
  c.findFirst.mockImplementation(async ({ where }: any) => db.categories.find((r) => hit(r, where)) ?? null);
  c.findMany.mockImplementation(async ({ where }: any) =>
    db.categories.filter((r) => hit(r, where)).sort((a, b) => a.sort_order - b.sort_order),
  );
  c.delete.mockImplementation(async ({ where }: any) => {
    const r = db.categories.find((x) => x.id === where.id)!;
    db.categories = db.categories.filter((x) => x !== r);
    // The FK is ON DELETE SET NULL.
    for (const task of db.tasks) if (task.category_id === r.id) task.category_id = null;
    return r;
  });

  const tk = mockPrisma.task;
  tk.findMany.mockImplementation(async ({ where }: any) => db.tasks.filter((r) => hit(r, where)));
  tk.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.tasks.filter((r) => hit(r, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });
  tk.deleteMany.mockImplementation(async ({ where }: any) => {
    const gone = db.tasks.filter((r) => hit(r, where));
    db.tasks = db.tasks.filter((r) => !gone.includes(r));
    return { count: gone.length };
  });
  tk.groupBy.mockImplementation(async ({ where }: any) => {
    const out = new Map<string, { category_id: string; status: string; _count: { _all: number } }>();
    for (const r of db.tasks.filter((x) => hit(x, where))) {
      const k = `${r.category_id}|${r.status}`;
      const e = out.get(k) ?? { category_id: r.category_id!, status: r.status, _count: { _all: 0 } };
      e._count._all += 1;
      out.set(k, e);
    }
    return [...out.values()];
  });

  mockPrisma.note.deleteMany.mockImplementation(async ({ where }: any) => {
    const gone = db.notes.filter((r) => hit(r, where));
    db.notes = db.notes.filter((r) => !gone.includes(r));
    return { count: gone.length };
  });
  mockPrisma.attachment.findMany.mockImplementation(async ({ where }: any) => db.files.filter((r) => hit(r, where)));
  mockPrisma.attachment.deleteMany.mockImplementation(async ({ where }: any) => {
    const gone = db.files.filter((r) => hit(r, where));
    db.files = db.files.filter((r) => !gone.includes(r));
    return { count: gone.length };
  });
  mockPrisma.timelineEvent.createMany.mockImplementation(async ({ data }: any) => {
    db.events.push(...data);
    return { count: data.length };
  });
  mockPrisma.auditLog.create.mockResolvedValue({});
  // The service's row lock: answers with the requested tasks that still exist.
  mockPrisma.$queryRaw.mockImplementation(async (_sql: unknown, ...values: unknown[]) => {
    const ids = values.find((v): v is string[] => Array.isArray(v)) ?? [];
    return db.tasks.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id }));
  });
}

/** Everything the transaction wrote is undone when its callback throws, as Postgres would. */
function transactional() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
    const snapshot = structuredClone(db);
    try {
      return await fn(prisma);
    } catch (err) {
      db = snapshot;
      throw err;
    }
  });
}

const ours = () => db.tasks.filter((x) => x.organization_id === ALPHA_ORG_ID);
const del = (id: string, body: Record<string, unknown>, role: 'admin' | 'dispatcher' | 'sales' | 'technician' = 'admin') =>
  request(app).delete(`/api/task-categories/${id}`).set(authHeader(role)).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  install();
  transactional();
  mockPrisma.$executeRaw.mockResolvedValue(0);
  storage.remove.mockResolvedValue({ data: null, error: null });
  mockAuthAs('admin');
});

describe('DELETE /api/task-categories/:id - keep the tasks', () => {
  it('deletes the category and leaves every task that carried it without one', async () => {
    const res = await del(PART_ORDER, { mode: 'keep' });

    expect(res.status).toBe(200);
    expect(db.categories.map((c) => c.id)).not.toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    for (const n of [1, 2, 3, 4]) expect(db.tasks.find((x) => x.id === t(n).id)!.category_id).toBeNull();
    // Other categories' tasks are untouched.
    expect(db.tasks.find((x) => x.id === t(5).id)!.category_id).toBe(FOLLOW_UP);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/task-categories/:id - move the tasks to another category', () => {
  it('reassigns every task to the target and deletes the category', async () => {
    const res = await del(PART_ORDER, { mode: 'move', target_id: FOLLOW_UP });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'move', task_count: 4, target: { id: FOLLOW_UP, name: 'Follow-up' } });
    expect(db.categories.map((c) => c.id)).not.toContain(PART_ORDER);
    for (const n of [1, 2, 3, 4, 5]) expect(db.tasks.find((x) => x.id === t(n).id)!.category_id).toBe(FOLLOW_UP);
    expect(db.tasks.find((x) => x.id === t(6).id)!.category_id).toBeNull();
    expect(ours()).toHaveLength(6);
  });

  it('refuses a target from another organization, and changes nothing', async () => {
    const res = await del(PART_ORDER, { mode: 'move', target_id: OTHER_ORG_CAT });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET');
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    for (const n of [1, 2, 3, 4]) expect(db.tasks.find((x) => x.id === t(n).id)!.category_id).toBe(PART_ORDER);
    expect(db.tasks.find((x) => x.id === t(7).id)!.category_id).toBe(OTHER_ORG_CAT);
  });

  it('refuses moving the tasks into the category being deleted', async () => {
    const res = await del(PART_ORDER, { mode: 'move', target_id: PART_ORDER });

    expect(res.status).toBe(400);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
  });

  it('refuses a move with no target', async () => {
    const res = await del(PART_ORDER, { mode: 'move' });

    expect(res.status).toBe(400);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
  });
});

describe('DELETE /api/task-categories/:id - delete the tasks too', () => {
  const deleteAll = () => del(PART_ORDER, { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 4 });
  const inCategory = [1, 2, 3, 4].map((n) => t(n).id);

  it('deletes every task in the category whatever its status, and the category', async () => {
    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('delete_tasks');
    expect(res.body.task_count).toBe(4);
    expect([...res.body.deleted_task_ids].sort()).toEqual([...inCategory].sort());
    expect(db.categories.map((c) => c.id)).not.toContain(PART_ORDER);
    expect(ours().map((x) => x.id).sort()).toEqual([t(5).id, t(6).id].sort());
    // Another organization's rows are never touched.
    expect(db.tasks.find((x) => x.id === t(7).id)).toBeDefined();
  });

  it('takes their comments and files with them, and removes the stored objects after the commit', async () => {
    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(db.notes.map((n) => n.entity_id).sort()).toEqual([t(5).id, t(6).id, t(7).id].sort());
    expect(db.files.map((f) => f.id)).toEqual(['f2']);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove.mock.calls[0][0]).toEqual([`${ALPHA_ORG_ID}/task/${t(1).id}/a.jpg`]);
  });

  it('writes the delete audit trail per task: a DELETED event with the title and number', async () => {
    await deleteAll();

    const deleted = db.events.filter((e) => e.event_type === 'DELETED');
    expect(deleted.map((e) => e.entity_id).sort()).toEqual([...inCategory].sort());
    for (const e of deleted) {
      const n = Number(e.entity_id.slice(-4));
      expect(e).toMatchObject({
        organization_id: ALPHA_ORG_ID,
        entity_type: 'TASK',
        created_by: ADMIN,
        metadata: { task_title: `Task ${n}`, task_number: `T0000${n}` },
      });
    }
  });

  it('dispatches exactly one "Task is deleted" run per task, with each task\'s own snapshot', async () => {
    await deleteAll();

    const runs = mockDispatch.mock.calls.map((c: any[]) => c[0]);
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.type === 'TASK_DELETED' && r.organizationId === ALPHA_ORG_ID && r.actorId === ADMIN)).toBe(true);
    expect(runs.map((r) => r.entity.id).sort()).toEqual([...inCategory].sort());
    const first = runs.find((r) => r.entity.id === t(1).id);
    expect(first.eventPayload).toEqual({
      mergeFields: { 'task.number': 'T00001', 'task.title': 'Task 1' },
      taskSnapshot: { assigneeIds: [DANA, ELI], watcherIds: [], creatorId: ADMIN },
    });
    expect(runs.find((r) => r.entity.id === t(4).id).eventPayload.taskSnapshot.watcherIds).toEqual([ELI]);
  });

  it('rings the task.deleted bell for each task, after the commit', async () => {
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let early = false;
    mockEmit.mockImplementation(async () => { if (!committed) early = true; return []; });
    mockDispatch.mockImplementation(() => { if (!committed) early = true; });

    await deleteAll();

    const bells = mockEmit.mock.calls.map((c: any[]) => c[0]).filter((e) => e.verb === 'task.deleted');
    expect(bells.map((b) => b.object.id).sort()).toEqual([...inCategory].sort());
    expect(early).toBe(false);
  });

  it('leaves out a task another request deleted first: not counted, not announced, not audited', async () => {
    // T00002 is read with the category, then deleted by a single DELETE before the lock is taken.
    const read = mockPrisma.task.findMany.getMockImplementation()!;
    mockPrisma.task.findMany.mockImplementationOnce(async (args: any) => {
      const rows = await read(args);
      db.tasks = db.tasks.filter((x) => x.id !== t(2).id);
      return rows;
    });

    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(res.body.task_count).toBe(3);
    expect([...res.body.deleted_task_ids].sort()).toEqual([t(1).id, t(3).id, t(4).id].sort());
    expect(db.events.map((e) => e.entity_id)).not.toContain(t(2).id);
    expect(mockDispatch.mock.calls.map((c: any[]) => c[0].entity.id)).not.toContain(t(2).id);
    expect(mockEmit.mock.calls.map((c: any[]) => c[0].object.id)).not.toContain(t(2).id);
    await new Promise((r) => setImmediate(r));
    const entry = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'task.category_deleted');
    expect(entry.metadata.task_count).toBe(3);
    expect(entry.metadata.deleted_task_numbers).not.toContain('T00002');
  });

  it.each([
    ['a wrong name', { confirm_name: 'Parts order' }],
    ['the name in another letter case', { confirm_name: 'part order' }],
    ['no name at all', {}],
    ['an empty name', { confirm_name: '' }],
  ])('refuses %s and deletes nothing', async (_label, extra) => {
    const res = await del(PART_ORDER, { mode: 'delete_tasks', expected_task_count: 4, ...extra });

    expect(res.status).toBe(400);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    expect(db.notes).toHaveLength(7);
    expect(db.files).toHaveLength(2);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('accepts the name with stray spacing around it, the way names are stored', async () => {
    const res = await del(PART_ORDER, { mode: 'delete_tasks', confirm_name: '  Part   order ', expected_task_count: 4 });

    expect(res.status).toBe(200);
    expect(res.body.task_count).toBe(4);
  });

  it('is all-or-nothing: a failure part-way leaves every task, file and the category in place', async () => {
    mockPrisma.taskCategory.delete.mockRejectedValueOnce(new Error('boom'));

    const res = await deleteAll();

    expect(res.status).toBe(500);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    expect(db.notes).toHaveLength(7);
    expect(db.files).toHaveLength(2);
    expect(db.events).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/task-categories/:id - who and which', () => {
  for (const role of ['dispatcher', 'sales', 'technician'] as const) {
    it(`${role}: refused with 403, whatever the mode, and nothing changes`, async () => {
      mockAuthAs(role);

      for (const body of [
        { mode: 'keep' },
        { mode: 'move', target_id: FOLLOW_UP },
        { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 4 },
      ]) {
        const res = await del(PART_ORDER, body, role);
        expect(res.status).toBe(403);
      }
      expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
      expect(ours()).toHaveLength(6);
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  }

  it('another organization\'s category is not found, and is left alone with its tasks', async () => {
    const res = await del(OTHER_ORG_CAT, { mode: 'delete_tasks', confirm_name: 'Permit', expected_task_count: 1 });

    expect(res.status).toBe(404);
    expect(db.categories.map((c) => c.id)).toContain(OTHER_ORG_CAT);
    expect(db.tasks.find((x) => x.id === t(7).id)!.category_id).toBe(OTHER_ORG_CAT);
  });

  it('an unknown mode is refused', async () => {
    const res = await del(PART_ORDER, { mode: 'archive' });

    expect(res.status).toBe(400);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
  });

  it('writes an audit entry naming the category, the mode and the tasks it touched', async () => {
    await del(PART_ORDER, { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 4 });
    await new Promise((r) => setImmediate(r));

    const entry = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'task.category_deleted');
    expect(entry).toMatchObject({
      org_id: ALPHA_ORG_ID,
      actor_id: ADMIN,
      resource_type: 'TaskCategory',
      resource_id: PART_ORDER,
      metadata: { name: 'Part order', mode: 'delete_tasks', task_count: 4 },
    });
    expect([...entry.metadata.deleted_task_numbers].sort()).toEqual(['T00001', 'T00002', 'T00003', 'T00004']);
  });

  it('a move\'s audit entry names the target', async () => {
    await del(PART_ORDER, { mode: 'move', target_id: FOLLOW_UP });
    await new Promise((r) => setImmediate(r));

    const entry = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'task.category_deleted');
    expect(entry.metadata).toMatchObject({ mode: 'move', task_count: 4, target_id: FOLLOW_UP, target_name: 'Follow-up' });
  });
});

describe('DELETE /api/task-categories/:id - the count the dialog showed (stale-count guard)', () => {
  it('refuses with 409 when the category now holds a different number of tasks, and deletes nothing', async () => {
    // The dialog said 3; a fourth task joined the category since.
    const res = await del(PART_ORDER, { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 3 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TASK_COUNT_CHANGED');
    expect(res.body.error).toMatch(/number of tasks in this category changed/i);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('refuses a delete_tasks that does not say how many tasks it expects', async () => {
    const res = await del(PART_ORDER, { mode: 'delete_tasks', confirm_name: 'Part order' });

    expect(res.status).toBe(400);
    expect(ours()).toHaveLength(6);
  });
});

describe('DELETE /api/task-categories/:id - delete_tasks needs the right to delete those tasks', () => {
  const DISPATCHER = TEST_USERS.dispatcher.id;
  /** A dispatcher-based custom role that also holds `delete TaskCategory`, with or without `delete Task`. */
  function grantCategoryDelete({ withTaskDelete }: { withTaskDelete: boolean }) {
    const grants = DEFAULT_GRANTS
      .filter((g) => g.role === 'DISPATCHER' && (withTaskDelete || !(g.action === 'delete' && g.subject === 'Task')))
      .concat([{ role: 'DISPATCHER', action: 'delete', subject: 'TaskCategory' }]);
    mockPrisma.rolePermission.findMany.mockResolvedValue(grants);
    clearPermissionCache();
  }
  const deleteAllAs = () =>
    del(PART_ORDER, { mode: 'delete_tasks', confirm_name: 'Part order', expected_task_count: 4 }, 'dispatcher');

  it('a role that may delete categories but not tasks is refused, and nothing changes', async () => {
    mockAuthAs('dispatcher');
    grantCategoryDelete({ withTaskDelete: false });
    for (const n of [1, 2, 3, 4]) db.tasks.find((x) => x.id === t(n).id)!.assignee_ids.push(DISPATCHER);

    const res = await deleteAllAs();

    expect(res.status).toBe(403);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    expect(mockDispatch).not.toHaveBeenCalled();
    // The same role may still delete the category and keep its tasks.
    expect((await del(PART_ORDER, { mode: 'keep' }, 'dispatcher')).status).toBe(200);
  });

  it('a non-admin who may delete tasks is refused when one task in the category is not theirs to open', async () => {
    mockAuthAs('dispatcher');
    grantCategoryDelete({ withTaskDelete: true });
    // On three of the four; T00004 belongs to other people and is linked to nothing.
    for (const n of [1, 2, 3]) db.tasks.find((x) => x.id === t(n).id)!.assignee_ids.push(DISPATCHER);

    const res = await deleteAllAs();

    expect(res.status).toBe(403);
    expect(db.categories.map((c) => c.id)).toContain(PART_ORDER);
    expect(ours()).toHaveLength(6);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a non-admin who may delete tasks and can open every one of them deletes them', async () => {
    mockAuthAs('dispatcher');
    grantCategoryDelete({ withTaskDelete: true });
    for (const n of [1, 2, 3, 4]) db.tasks.find((x) => x.id === t(n).id)!.assignee_ids.push(DISPATCHER);

    const res = await deleteAllAs();

    expect(res.status).toBe(200);
    expect(res.body.task_count).toBe(4);
  });
});

describe('GET /api/task-categories - task counts', () => {
  it('an admin gets each category\'s tasks split into open and done (done = DONE or CANCELLED)', async () => {
    const res = await request(app).get('/api/task-categories').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.categories.map((c: any) => [c.id, c.task_counts]));
    expect(byId[PART_ORDER]).toEqual({ open: 2, done: 2 });
    expect(byId[FOLLOW_UP]).toEqual({ open: 1, done: 0 });
    // One grouped query, scoped to the organization.
    expect(mockPrisma.task.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.groupBy.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('a category with no tasks counts zero', async () => {
    db.tasks = db.tasks.filter((x) => x.category_id !== FOLLOW_UP);

    const res = await request(app).get('/api/task-categories').set(authHeader('admin'));

    expect(res.body.categories.find((c: any) => c.id === FOLLOW_UP).task_counts).toEqual({ open: 0, done: 0 });
  });

  it('a non-admin gets the list without counts, and no count query runs', async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/task-categories').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBe(2);
    expect(res.body.categories.every((c: any) => !('task_counts' in c))).toBe(true);
    expect(mockPrisma.task.groupBy).not.toHaveBeenCalled();
  });
});
