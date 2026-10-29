/**
 * The board card shows a task's file count (visits-and-task-categories slice 12).
 *
 * Attachments are polymorphic, so there is no relation for `_count` to follow. The list counts
 * them with ONE grouped query for the whole page - never one per task - scoped to TASK rows of
 * the caller's org and of exactly the tasks on the page. The detail row carries the same number,
 * so opening a task never resets the card to zero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;

const T1 = 'aa000000-0000-0000-0000-0000000000e1';
const T2 = 'aa000000-0000-0000-0000-0000000000e2';

function task(id: string) {
  return {
    id,
    task_number: `T-${id.slice(-2)}`,
    organization_id: ALPHA_ORG_ID,
    title: 'A task',
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
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  // Three files on T1, none on T2 - answered only for a TASK, tenant-scoped query.
  mockPrisma.attachment.groupBy.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.entity_type !== 'TASK' || w.organization_id !== ALPHA_ORG_ID) return [];
    const ids: string[] = w.entity_id?.in ?? [];
    return ids.includes(T1) ? [{ entity_id: T1, _count: { _all: 3 } }] : [];
  });
});

describe('GET /api/tasks - attachment_count', () => {
  it('carries each task\'s file count, zero when it has none, from one grouped query', async () => {
    mockPrisma.task.findMany.mockResolvedValue([task(T1), task(T2)]);

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.tasks.map((t: any) => [t.id, t.attachment_count]));
    expect(byId).toEqual({ [T1]: 3, [T2]: 0 });
    expect(mockPrisma.attachment.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.attachment.groupBy.mock.calls[0][0].where.entity_id).toEqual({ in: [T1, T2] });
  });

  it('skips the count query for an empty page', async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.groupBy).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks/:id - attachment_count', () => {
  it('carries the same count, so opening the drawer never resets the card', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(task(T1));

    const res = await request(app).get(`/api/tasks/${T1}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.task.attachment_count).toBe(3);
  });
});
