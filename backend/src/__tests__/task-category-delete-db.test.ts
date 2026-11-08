/* =============================================================================
   Deleting a task category - keep, move or delete its tasks (slice 11), against a
   real, migrated database: the foreign keys (subtasks cascade, category SET NULL),
   the org-scoped statements and the one-transaction rollback are Postgres's, not a
   mock's. Also measures a large category: 500 tasks per mode, well inside the 30s
   interactive-transaction limit (lib/prisma.ts).

   Skips when TEST_DATABASE_URL is unset, the same idiom as the other *-db suites.
   Every org this suite creates is removed again in afterAll.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { deleteTaskCategory } from '../lib/tasks/categoryWrites';
import { announceTaskDeletions, deleteTasks, DELETABLE_TASK_SELECT } from '../lib/tasks/deletion';

// The bell and the automation dispatch are counted at their boundary: the app's own client is the
// suite-wide mock, so they cannot write here. What matters is how many times each is asked.
vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue([]) }));
import { emit } from '../services/notifications/notificationService';
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('deleting a task category (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  interface Fixture {
    orgId: string;
    adminId: string;
    catId: string;
    otherCatId: string;
    taskIds: string[];
    otherTaskId: string;
  }

  /** An org with an admin, two categories, `n` tasks in the first (mixed statuses) and one in the second. */
  async function fixture(n: number, { withContent = false } = {}): Promise<Fixture> {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await prisma.organization.create({
      data: {
        id: orgId, name: `vtc11-delete-${tag}`, email: `delete-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const adminId = randomUUID();
    await prisma.user.create({
      data: { id: adminId, email: `admin-${tag}@example.test`, first_name: 'Ada', last_name: 'Admin', role: 'ADMIN', organization_id: orgId },
    });
    const catId = randomUUID();
    const otherCatId = randomUUID();
    await prisma.taskCategory.createMany({
      data: [
        { id: catId, name: 'Part order', color: '#F97316', sort_order: 10, organization_id: orgId },
        { id: otherCatId, name: 'Callback', color: '#3B82F6', sort_order: 11, organization_id: orgId },
      ],
    });
    const statuses = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const;
    const taskIds = Array.from({ length: n }, () => randomUUID());
    const otherTaskId = randomUUID();
    await prisma.task.createMany({
      data: [
        ...taskIds.map((id, i) => ({
          id, organization_id: orgId, task_number: `T${String(i + 1).padStart(5, '0')}`, title: `Task ${i + 1}`,
          status: statuses[i % statuses.length], created_by: adminId, assignee_ids: [adminId], category_id: catId,
        })),
        { id: otherTaskId, organization_id: orgId, task_number: 'T99999', title: 'Other', created_by: adminId, assignee_ids: [adminId], category_id: otherCatId },
      ],
    });
    if (withContent) {
      const everyTask = [...taskIds, otherTaskId];
      await prisma.taskSubtask.createMany({ data: everyTask.map((task_id) => ({ task_id, text: 'step' })) });
      await prisma.note.createMany({
        data: everyTask.map((entity_id) => ({ entity_type: 'TASK' as const, entity_id, content: 'a comment', created_by: adminId, organization_id: orgId })),
      });
      await prisma.attachment.createMany({
        data: everyTask.map((entity_id) => ({
          entity_type: 'TASK' as const, entity_id, organization_id: orgId, uploaded_by: adminId,
          file_name: 'a.jpg', display_name: 'a.jpg', file_type: 'image/jpeg', file_size: 10,
          file_url: '', storage_path: `${orgId}/task/${entity_id}/a.jpg`,
        })),
      });
    }
    return { orgId, adminId, catId, otherCatId, taskIds, otherTaskId };
  }

  const actorOf = (f: Fixture) => ({ orgId: f.orgId, actorId: f.adminId });
  const categoryIds = async (orgId: string) =>
    (await prisma.taskCategory.findMany({ where: { organization_id: orgId }, select: { id: true } })).map((c) => c.id);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(prisma.attachment.deleteMany({ where: { organization_id } }));
      await quietly(prisma.note.deleteMany({ where: { organization_id } }));
      await quietly(prisma.timelineEvent.deleteMany({ where: { organization_id } }));
      await quietly(prisma.task.deleteMany({ where: { organization_id } }));
      await quietly(prisma.taskCategory.deleteMany({ where: { organization_id } }));
      await quietly(prisma.user.deleteMany({ where: { organization_id } }));
      await quietly(prisma.organization.deleteMany({ where: { id: organization_id } }));
    }
    await prisma.$disconnect();
  });

  it('keep: the category goes and every task stays, with no category', async () => {
    const f = await fixture(5);

    const r = await deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'keep' });

    expect(r).toMatchObject({ ok: true, taskCount: 5 });
    expect(await categoryIds(f.orgId)).toEqual([f.otherCatId]);
    const tasks = await prisma.task.findMany({ where: { id: { in: f.taskIds } }, select: { category_id: true } });
    expect(tasks).toHaveLength(5);
    expect(tasks.every((t) => t.category_id === null)).toBe(true);
    expect((await prisma.task.findUnique({ where: { id: f.otherTaskId } }))!.category_id).toBe(f.otherCatId);
  });

  it('move: every task moves to the target; a target in another organization is refused and nothing changes', async () => {
    const f = await fixture(5);
    const stranger = await fixture(0);

    const refused = await deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'move', target_id: stranger.catId });
    expect(refused).toEqual({ ok: false, error: 'invalid_target' });
    expect(await categoryIds(f.orgId)).toContain(f.catId);
    expect(await prisma.task.count({ where: { category_id: f.catId } })).toBe(5);

    const moved = await deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'move', target_id: f.otherCatId });
    expect(moved).toMatchObject({ ok: true, taskCount: 5, target: { id: f.otherCatId } });
    expect(await prisma.task.count({ where: { organization_id: f.orgId, category_id: f.otherCatId } })).toBe(6);
    expect(await categoryIds(f.orgId)).toEqual([f.otherCatId]);
  });

  it('delete_tasks: every task in the category goes, with its subtasks, comments and file rows; the rest stay', async () => {
    const f = await fixture(5, { withContent: true });

    const r = await deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'delete_tasks', confirm_name: 'Part order' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.taskCount).toBe(5);
    expect(r.attachmentPaths.sort()).toEqual(f.taskIds.map((id) => `${f.orgId}/task/${id}/a.jpg`).sort());
    expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(0);
    expect(await prisma.taskSubtask.count({ where: { task_id: { in: f.taskIds } } })).toBe(0);
    expect(await prisma.note.count({ where: { entity_id: { in: f.taskIds } } })).toBe(0);
    expect(await prisma.attachment.count({ where: { entity_id: { in: f.taskIds } } })).toBe(0);
    // The audit trail: one DELETED event per task, which outlives it.
    const events = await prisma.timelineEvent.findMany({ where: { organization_id: f.orgId, event_type: 'DELETED' } });
    expect(events.map((e) => e.entity_id).sort()).toEqual([...f.taskIds].sort());
    expect(events.every((e) => e.created_by === f.adminId)).toBe(true);
    // The other category's task and everything on it are untouched.
    expect(await prisma.task.count({ where: { id: f.otherTaskId } })).toBe(1);
    expect(await prisma.taskSubtask.count({ where: { task_id: f.otherTaskId } })).toBe(1);
    expect(await prisma.note.count({ where: { entity_id: f.otherTaskId } })).toBe(1);
    expect(await prisma.attachment.count({ where: { entity_id: f.otherTaskId } })).toBe(1);
    expect(await categoryIds(f.orgId)).toEqual([f.otherCatId]);
  });

  it('delete_tasks with a wrong name deletes nothing', async () => {
    const f = await fixture(3, { withContent: true });

    const r = await deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'delete_tasks', confirm_name: 'part order' });

    expect(r).toEqual({ ok: false, error: 'confirm_mismatch' });
    expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(3);
    expect(await prisma.note.count({ where: { entity_id: { in: f.taskIds } } })).toBe(3);
    expect(await categoryIds(f.orgId)).toContain(f.catId);
  });

  it('another organization\'s category is not found and keeps its tasks', async () => {
    const f = await fixture(2);
    const stranger = await fixture(0);

    const r = await deleteTaskCategory(prisma, actorOf(stranger), f.catId, { mode: 'delete_tasks', confirm_name: 'Part order' });

    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(2);
  });

  it('is all-or-nothing: when the transaction fails part-way, every task and row is still there', async () => {
    const f = await fixture(5, { withContent: true });
    // A client whose category delete - the transaction's LAST statement - fails.
    const failing = {
      $transaction: (fn: (tx: any) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          fn(new Proxy(tx, {
            get(target, key) {
              if (key !== 'taskCategory') return (target as any)[key];
              return { ...target.taskCategory, findFirst: target.taskCategory.findFirst, delete: async () => { throw new Error('boom'); } };
            },
          })),
        ),
    } as unknown as PrismaClient;

    await expect(
      deleteTaskCategory(failing, actorOf(f), f.catId, { mode: 'delete_tasks', confirm_name: 'Part order' }),
    ).rejects.toThrow('boom');

    expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(5);
    expect(await prisma.taskSubtask.count({ where: { task_id: { in: f.taskIds } } })).toBe(5);
    expect(await prisma.note.count({ where: { entity_id: { in: f.taskIds } } })).toBe(5);
    expect(await prisma.attachment.count({ where: { entity_id: { in: f.taskIds } } })).toBe(5);
    expect(await prisma.timelineEvent.count({ where: { organization_id: f.orgId } })).toBe(0);
    expect(await categoryIds(f.orgId)).toContain(f.catId);
  });

  describe('two deletes racing for the same task', () => {
    const bellsFor = (id: string) =>
      vi.mocked(emit).mock.calls.filter(([e]) => e.verb === 'task.deleted' && e.object.id === id).length;
    const runsFor = (id: string) =>
      vi.mocked(dispatchAutomationEvent).mock.calls.filter(([e]) => e.type === 'TASK_DELETED' && e.entity.id === id).length;
    const deletedEvents = (id: string) => prisma.timelineEvent.count({ where: { entity_id: id, event_type: 'DELETED' } });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const readTask = (id: string) => prisma.task.findUniqueOrThrow({ where: { id }, select: DELETABLE_TASK_SELECT });

    /** What DELETE /api/tasks/:id does with the row in hand: the service, then its announcements. */
    async function deleteOne(f: Fixture, task: Awaited<ReturnType<typeof readTask>>, holdOpen?: Promise<void>) {
      const out = await prisma.$transaction(async (tx) => {
        const r = await deleteTasks(tx, [task], actorOf(f));
        await holdOpen;
        return r;
      });
      await announceTaskDeletions(actorOf(f), out.deleted, out.attachmentPaths);
      return out.deleted.map((t) => t.id);
    }

    /** An org whose tasks are someone else's, so deleting one rings a bell (the actor is never told). */
    async function raceFixture(n: number): Promise<Fixture> {
      const f = await fixture(n, { withContent: true });
      await prisma.task.updateMany({ where: { id: { in: f.taskIds } }, data: { assignee_ids: [randomUUID()] } });
      return f;
    }

    beforeEach(() => {
      vi.mocked(emit).mockClear();
      vi.mocked(dispatchAutomationEvent).mockClear();
    });

    it('two single deletes: exactly one deletes it, writes the event, rings the bell and dispatches the run', async () => {
      const f = await raceFixture(1);
      const id = f.taskIds[0]!;
      // Both requests read the row before either deletes it.
      const [a, b] = [await readTask(id), await readTask(id)];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });

      const first = deleteOne(f, a, gate);
      await sleep(150);
      const second = deleteOne(f, b);
      await sleep(150);
      release();
      const [won, lost] = await Promise.all([first, second]);

      expect(won).toEqual([id]);
      expect(lost).toEqual([]);
      expect(await deletedEvents(id)).toBe(1);
      expect(bellsFor(id)).toBe(1);
      expect(runsFor(id)).toBe(1);
    });

    it('a category delete racing a single delete: each task is deleted and announced once; the category leaves out the one it lost', async () => {
      const f = await raceFixture(3);
      const [contested, ...rest] = f.taskIds as [string, ...string[]];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });

      const single = deleteOne(f, await readTask(contested), gate);
      await sleep(150);
      const category = deleteTaskCategory(prisma, actorOf(f), f.catId, { mode: 'delete_tasks', confirm_name: 'Part order' });
      await sleep(150);
      release();
      const [singleDeleted, cat] = await Promise.all([single, category]);
      if (!cat.ok) throw new Error('category delete refused');
      await announceTaskDeletions(actorOf(f), cat.deletedTasks, cat.attachmentPaths);

      expect(singleDeleted).toEqual([contested]);
      expect(cat.taskCount).toBe(2);
      expect(cat.deletedTasks.map((t) => t.id).sort()).toEqual([...rest].sort());
      for (const id of f.taskIds) {
        expect(await deletedEvents(id)).toBe(1);
        expect(bellsFor(id)).toBe(1);
        expect(runsFor(id)).toBe(1);
      }
      expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(0);
    });
  });

  describe('a large category (500 tasks)', () => {
    const LARGE = 500;
    const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
      const start = performance.now();
      const out = await work();
      return [out, performance.now() - start];
    };

    for (const mode of ['keep', 'move', 'delete_tasks'] as const) {
      it(`${mode} finishes in one transaction, well inside its time limit`, async () => {
        const f = await fixture(LARGE, { withContent: mode === 'delete_tasks' });
        const input =
          mode === 'keep' ? { mode } as const
          : mode === 'move' ? { mode, target_id: f.otherCatId } as const
          : { mode, confirm_name: 'Part order' } as const;

        const [r, ms] = await timed(() => deleteTaskCategory(prisma, actorOf(f), f.catId, input));

        expect(r).toMatchObject({ ok: true, taskCount: LARGE });
        // eslint-disable-next-line no-console
        console.log(`[slice 11] ${mode} of ${LARGE} tasks: ${Math.round(ms)} ms`);
        expect(ms).toBeLessThan(10_000);
        if (mode === 'delete_tasks') {
          expect(await prisma.task.count({ where: { id: { in: f.taskIds } } })).toBe(0);
          expect(await prisma.timelineEvent.count({ where: { organization_id: f.orgId, event_type: 'DELETED' } })).toBe(LARGE);
        }
      }, 60_000);
    }
  });
});
