/**
 * Deleting a task deletes its files (visits-and-task-categories slice 12).
 *
 * Attachments are polymorphic - `entity_type` + `entity_id`, no foreign key - so nothing in the
 * database removes a task's files when the task goes. `remove` has to: the ROWS inside the delete
 * transaction (they vanish with the task or not at all), the storage OBJECTS only after it
 * commits (an object deleted for a rolled-back task is a file its row still points at, lost for
 * good). A storage failure after commit is logged, not surfaced: the task is gone, and the orphan
 * sweep owns the `task` path segment, so it reclaims what storage kept.
 *
 * Storage is mocked at the service boundary (`supabaseAdmin.storage`), per the build runbook:
 * the local stack has no storage service, so the real object removal is unverified locally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, stubTaskRowLocks } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as unknown as Record<string, any>;
const storage = supabaseAdmin.storage.from('attachments') as unknown as { remove: ReturnType<typeof vi.fn> };

const TASK_ID = 'aa000000-0000-0000-0000-0000000000d1';

const TASK = {
  id: TASK_ID,
  task_number: 'T00042',
  organization_id: ALPHA_ORG_ID,
  title: 'Photograph the gate',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [TEST_USERS.admin.id],
  watcher_ids: [],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  completed_at: null,
  created_by: TEST_USERS.admin.id,
  created_at: new Date('2026-09-27T12:00:00Z'),
  updated_at: new Date('2026-09-27T12:00:00Z'),
  _count: { subtasks: 0 },
};

const PATH_A = `${ALPHA_ORG_ID}/task/${TASK_ID}/1-gate.jpg`;
const PATH_B = `${ALPHA_ORG_ID}/task/${TASK_ID}/2-walkthrough.mp4`;

/** The task's files, answered only for a TASK-scoped, tenant-scoped query. */
function givenTaskFiles(rows: Array<{ storage_path: string | null; file_url: string }>) {
  mockPrisma.attachment.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    const scoped = w.entity_type === 'TASK' && w.entity_id?.in?.includes(TASK_ID) && w.organization_id === ALPHA_ORG_ID;
    return scoped ? rows : [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  mockPrisma.task.findFirst.mockResolvedValue(TASK);
  mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
  stubTaskRowLocks();
  mockPrisma.note.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'ev-1' });
  mockPrisma.attachment.deleteMany.mockResolvedValue({ count: 2 });
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  storage.remove.mockResolvedValue({ data: null, error: null });
});

describe('DELETE /api/tasks/:id - the task\'s attachments go with it', () => {
  it('deletes the attachment rows and then the storage objects', async () => {
    givenTaskFiles([
      { storage_path: PATH_A, file_url: '' },
      { storage_path: PATH_B, file_url: '' },
    ]);

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.attachment.deleteMany).toHaveBeenCalledWith({
      where: { entity_type: 'TASK', entity_id: { in: [TASK_ID] }, organization_id: ALPHA_ORG_ID },
    });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove.mock.calls[0][0].sort()).toEqual([PATH_A, PATH_B].sort());
  });

  it('removes the rows INSIDE the transaction and the objects only AFTER it commits', async () => {
    givenTaskFiles([{ storage_path: PATH_A, file_url: '' }]);
    const order: string[] = [];
    mockPrisma.attachment.deleteMany.mockImplementation(async () => { order.push('rows'); return { count: 1 }; });
    mockPrisma.task.deleteMany.mockImplementation(async () => { order.push('task'); return { count: 1 }; });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      order.push('commit');
      return out;
    });
    storage.remove.mockImplementation(async () => { order.push('objects'); return { data: null, error: null }; });

    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(order).toEqual(['rows', 'task', 'commit', 'objects']);
  });

  it('leaves storage alone when the delete transaction fails', async () => {
    givenTaskFiles([{ storage_path: PATH_A, file_url: '' }]);
    mockPrisma.task.deleteMany.mockRejectedValue(new Error('boom'));

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(500);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('still answers 204 when storage refuses after the commit - the task is already gone', async () => {
    givenTaskFiles([{ storage_path: PATH_A, file_url: '' }]);
    storage.remove.mockResolvedValue({ data: null, error: { message: 'unavailable' } });

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('finds the object of a legacy row that carries only a public URL', async () => {
    givenTaskFiles([{
      storage_path: null,
      file_url: `https://test.supabase.co/storage/v1/object/public/attachments/${PATH_A}`,
    }]);

    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(storage.remove).toHaveBeenCalledWith([PATH_A]);
  });

  it('makes no storage call for a task with no files', async () => {
    givenTaskFiles([]);

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
