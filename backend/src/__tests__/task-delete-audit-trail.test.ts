import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, stubTaskRowLocks } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';
import { deletedTaskLabel, resolveDeletedTaskLabels, TASK_DELETED_EVENT_TYPE } from '../lib/tasks/deletion';

// Issue 04 - a task's timeline is its audit trail and must outlive the task. `remove` keeps the
// timeline, still deletes the notes, and closes the trail with a DELETED event carrying the
// title and number, because the row those came from is gone by the time anyone reads it.

const TASK_ID = 'aa000000-0000-0000-0000-000000000001';
const JOB_ID = '10000000-0000-0000-0000-000000000001';
const TECH_ID = TEST_USERS.technician.id;
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000aa';

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
  created_by: TEST_USERS.admin.id,
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids: [],
  _count: { subtasks: 0 },
};

const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  mockPrisma.task.findFirst.mockResolvedValue(TASK_FIXTURE);
  mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
  stubTaskRowLocks();
  mockPrisma.note.deleteMany.mockResolvedValue({ count: 2 });
  mockPrisma.timelineEvent.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'ev-1' });
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
});

// ══════════════════════════════════════════════════════
// 1. DELETE keeps the timeline, drops the notes
// ══════════════════════════════════════════════════════

describe('DELETE /api/tasks/:id - the timeline survives, the notes do not', () => {
  it('deletes the notes and the task but never the task\'s timeline events', async () => {
    mockAuthAs('admin');

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.note.deleteMany).toHaveBeenCalledWith({
      where: { entity_type: 'TASK', entity_id: { in: [TASK_ID] }, organization_id: ALPHA_ORG_ID },
    });
    expect(mockPrisma.task.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [TASK_ID] }, organization_id: ALPHA_ORG_ID } });

    // The whole point of the issue: no timeline deleteMany may name this task.
    const timelineDeletes = (mockPrisma.timelineEvent.deleteMany as Mock).mock.calls
      .filter((c: any[]) => c[0]?.where?.entity_id === TASK_ID);
    expect(timelineDeletes).toEqual([]);
  });

  it('closes the trail with a DELETED event carrying the title and number', async () => {
    mockAuthAs('admin');

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    // Written in bulk (the task-deletion service also deletes a whole category's tasks).
    const created = (mockPrisma.timelineEvent.createMany as Mock).mock.calls
      .flatMap((c: any[]) => c[0].data)
      .filter((d: any) => d.entity_type === 'TASK' && d.entity_id === TASK_ID);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      event_type: TASK_DELETED_EVENT_TYPE,
      created_by: TEST_USERS.admin.id,
      // Snapshot: nothing is left to join to once the row is gone.
      metadata: { task_title: 'Inspect compressor', task_number: 'T00001' },
    });
    expect(created[0].description).toBeTruthy();
  });

  it('writes the deletion event BEFORE the row it describes is deleted', async () => {
    mockAuthAs('admin');
    const order: string[] = [];
    (mockPrisma.timelineEvent.createMany as Mock).mockImplementation(async () => {
      order.push('event');
      return { count: 1 };
    });
    (mockPrisma.task.deleteMany as Mock).mockImplementation(async () => {
      order.push('delete');
      return TASK_FIXTURE;
    });

    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(order).toEqual(['event', 'delete']);
  });
});

// ══════════════════════════════════════════════════════
// 2. Authorization is untouched by the change
// ══════════════════════════════════════════════════════

describe('DELETE /api/tasks/:id - a task another request deleted first', () => {
  /**
   * Two deletes of one task can both read the row before either commits. The service locks the
   * row inside its transaction and goes on only if it is still there, so the loser - here, the
   * lock finds nothing - answers 404 and leaves no second DELETED event, bell or automation run.
   */
  it('answers 404 and writes, deletes and announces nothing', async () => {
    mockAuthAs('admin');
    stubTaskRowLocks(() => false);

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
    expect(mockPrisma.timelineEvent.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.note.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/tasks/:id - authorization unchanged', () => {
  it('a TECHNICIAN with no delete grant still deletes their own sole-assignee to-do (204)', async () => {
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

  it('a non-creator TECHNICIAN still cannot delete a task reached via a linked job (403)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, assignee_ids: [OTHER_USER_ID] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.task.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.note.deleteMany).not.toHaveBeenCalled();
    // A refused delete must not leave a "deleted this task" event behind either.
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.createMany).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// 3. resolveDeletedTaskLabels / deletedTaskLabel
// ══════════════════════════════════════════════════════

describe('deletedTaskLabel', () => {
  it('joins number and title, and falls back to the number alone when the title is blank', () => {
    expect(deletedTaskLabel({ task_number: 'T00001', task_title: 'Inspect compressor' }))
      .toBe('T00001 · Inspect compressor');
    expect(deletedTaskLabel({ task_number: 'T00001', task_title: '   ' })).toBe('T00001');
  });
});

describe('resolveDeletedTaskLabels', () => {
  it('returns a label for a deleted task and nothing for a live one', async () => {
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { entity_id: TASK_ID, metadata: { task_title: 'Inspect compressor', task_number: 'T00001' } },
    ]);

    const out = await resolveDeletedTaskLabels(ALPHA_ORG_ID, [
      { entity_type: 'TASK', entity_id: TASK_ID },
      { entity_type: 'TASK', entity_id: 'bb000000-0000-0000-0000-000000000002' },
      { entity_type: 'JOB', entity_id: JOB_ID },
    ]);

    expect(out.get(TASK_ID)).toBe('T00001 · Inspect compressor');
    expect(out.has('bb000000-0000-0000-0000-000000000002')).toBe(false);
    expect(out.has(JOB_ID)).toBe(false);

    const where = (mockPrisma.timelineEvent.findMany as Mock).mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.entity_type).toBe('TASK');
    expect(where.event_type).toBe(TASK_DELETED_EVENT_TYPE);
    expect(where.entity_id).toEqual({ in: [TASK_ID, 'bb000000-0000-0000-0000-000000000002'] });
  });

  it('costs no query when the window holds no TASK events', async () => {
    const out = await resolveDeletedTaskLabels(ALPHA_ORG_ID, [{ entity_type: 'JOB', entity_id: JOB_ID }]);
    expect(out.size).toBe(0);
    expect(mockPrisma.timelineEvent.findMany).not.toHaveBeenCalled();
  });

  it('ignores an event whose metadata carries no snapshot', async () => {
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { entity_id: TASK_ID, metadata: null },
      { entity_id: 'bb000000-0000-0000-0000-000000000002', metadata: { task_title: 'x' } },
    ]);

    const out = await resolveDeletedTaskLabels(ALPHA_ORG_ID, [
      { entity_type: 'TASK', entity_id: TASK_ID },
      { entity_type: 'TASK', entity_id: 'bb000000-0000-0000-0000-000000000002' },
    ]);

    expect(out.size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════
// 4. The two org-wide readers meet an orphaned event
// ══════════════════════════════════════════════════════

function stubEveryDashboardQuery() {
  (prisma.job.groupBy as Mock).mockResolvedValue([]);
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
  (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
  (prisma.lead.findMany as Mock).mockResolvedValue([]);
  (prisma.lead.groupBy as Mock).mockResolvedValue([]);
  (prisma.lead.count as Mock).mockResolvedValue(0);
  (prisma.estimate.findMany as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
}

const LIVE_TASK_ID = 'bb000000-0000-0000-0000-000000000002';

/** The feed query has no `event_type`; the orphan lookup is the one that does. */
function stubTimelineReads(feed: any[], deletedSnapshots: any[]) {
  (prisma.timelineEvent.findMany as Mock).mockImplementation(async (args: any) =>
    args?.where?.event_type === TASK_DELETED_EVENT_TYPE ? deletedSnapshots : feed,
  );
}

describe('GET /api/dashboard - activity feed with an orphaned task event', () => {
  beforeEach(() => {
    stubEveryDashboardQuery();
  });

  it('marks the deleted task\'s events as gone and labels them from the snapshot', async () => {
    mockAuthAs('admin');
    stubTimelineReads(
      [
        {
          id: 'ev-1', event_type: 'ASSIGNED', description: 'assigned Dana',
          entity_type: 'TASK', entity_id: TASK_ID,
          created_at: new Date('2026-06-19T15:00:00.000Z'),
          creator: { first_name: 'Test', last_name: 'Admin' },
        },
        {
          id: 'ev-2', event_type: 'NUDGED', description: 'nudged the task',
          entity_type: 'TASK', entity_id: LIVE_TASK_ID,
          created_at: new Date('2026-06-19T14:00:00.000Z'),
          creator: null,
        },
      ],
      [{ entity_id: TASK_ID, metadata: { task_title: 'Inspect compressor', task_number: 'T00001' } }],
    );

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const [orphan, live] = res.body.activity;
    expect(orphan.entity_deleted).toBe(true);
    expect(orphan.entity_label).toBe('T00001 · Inspect compressor');
    expect(orphan.entity_label).not.toBe('');
    // No dead link: the feed must not hand the client something to navigate to.
    expect(live.entity_deleted).toBe(false);
    expect(live.entity_label).toBeNull();
  });

  it('does not break when the orphan lookup finds nothing', async () => {
    mockAuthAs('admin');
    stubTimelineReads(
      [{
        id: 'ev-1', event_type: 'ASSIGNED', description: 'assigned Dana',
        entity_type: 'TASK', entity_id: TASK_ID,
        created_at: new Date('2026-06-19T15:00:00.000Z'),
        creator: null,
      }],
      [],
    );

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.activity[0].entity_deleted).toBe(false);
    expect(res.body.activity[0].entity_label).toBeNull();
  });
});

describe('GET /api/reports/activity - orphaned task events', () => {
  it('rolls them up by actor without erroring and with a non-empty breakdown label', async () => {
    mockAuthAs('admin');
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([
      {
        event_type: TASK_DELETED_EVENT_TYPE,
        created_at: new Date('2026-06-19T15:00:00.000Z'),
        created_by: TEST_USERS.admin.id,
        creator: { first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
      },
      {
        event_type: 'ASSIGNED',
        created_at: new Date('2026-06-19T14:00:00.000Z'),
        created_by: TEST_USERS.admin.id,
        creator: { first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
      },
    ]);

    const res = await request(app).get('/api/reports/activity').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const user = res.body.users.find((u: any) => u.id === TEST_USERS.admin.id);
    expect(user.actions).toBe(2);
    for (const b of user.breakdown) expect(b.label).toBeTruthy();
    expect(user.breakdown.map((b: any) => b.label).sort()).toEqual(['ASSIGNED', TASK_DELETED_EVENT_TYPE].sort());
  });
});
