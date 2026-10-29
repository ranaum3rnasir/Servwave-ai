/**
 * task-deactivation-sweep.test.ts — issue 02, dangling user ids in the task people-arrays.
 *
 * `assignee_ids` / `watcher_ids` are uuid[] and carry no foreign key, so deactivating a user used
 * to leave their id on every task that named them. The sweep in `lib/tasks/deactivation.ts` closes
 * that at the source; this file pins the rule it applies.
 *
 * Both routes that can flip `is_active` to false are exercised — `DELETE /api/users/:id` and
 * `PATCH /api/users/:id { is_active: false }` — because a fix wired to only one of them is not a
 * fix. `prisma.task.findMany` and `prisma.user.findFirst` are FAKES that honour the `where` they
 * are given rather than blanket `mockResolvedValue`s: the org scope and the `has` predicate are
 * part of what is under test, and a mock that answers any query at all would make the cross-org
 * case vacuous.
 *
 * The notification assertion is row-level for the reason design §9 gives: `emit()` returns `[]`
 * for an unregistered verb without throwing, so an assertion on a mocked `emit` stays green while
 * nothing is delivered.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS } from './helpers';
import { buildDedupeKey } from '../services/automations/dedupe';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

/** The automation events of one type this request dispatched, in order. */
const dispatchesOf = (type: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e) => e.type === type);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

// ─── People ───────────────────────────────────────────────────────────────────
//
// ACTOR is the signed-in admin doing the deactivating. ADMIN_SENIOR exists so the escalation
// rule ("longest-serving active ADMIN") has something to be wrong about: it was created BEFORE
// the actor, so a rule that merely grabbed any admin would pick the wrong one half the time.

const ACTOR        = TEST_USERS.admin.id;
const ADMIN_SENIOR = 'aaaaaaa2-0000-0000-0000-00000000000a';
const DEPARTING    = 'aaaaaaa2-0000-0000-0000-000000000001';
const CO_ASSIGNEE  = 'aaaaaaa2-0000-0000-0000-000000000002';
const CREATOR      = 'aaaaaaa2-0000-0000-0000-000000000003';
const DEAD_CREATOR = 'aaaaaaa2-0000-0000-0000-000000000004';
const ORG_B_USER   = 'bbbbbbb2-0000-0000-0000-000000000001';

const user = (
  id: string,
  over: Partial<{ role: string; is_active: boolean; organization_id: string; created_at: Date; first_name: string }> = {},
) => ({
  id,
  email: `${id}@test.com`,
  first_name: 'User',
  last_name: id.slice(-4),
  role: 'TECHNICIAN',
  is_active: true,
  has_login: false,
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-05-01'),
  ...over,
});

const ORG_USERS = [
  user(ADMIN_SENIOR, { role: 'ADMIN', first_name: 'Senior',  created_at: new Date('2024-01-01') }),
  user(ACTOR,        { role: 'ADMIN', first_name: 'Test',    created_at: new Date('2026-01-01') }),
  user(DEPARTING,    { first_name: 'Departing' }),
  user(CO_ASSIGNEE,  { first_name: 'Coco' }),
  user(CREATOR,      { role: 'DISPATCHER', first_name: 'Cassie' }),
  user(DEAD_CREATOR, { is_active: false, first_name: 'Ghost' }),
  user(ORG_B_USER,   { role: 'ADMIN', organization_id: ORG_B_ID, first_name: 'Bee' }),
];

const fullName = (id: string) => {
  const u = ORG_USERS.find((x) => x.id === id)!;
  return `${u.first_name} ${u.last_name}`;
};

// ─── Tasks ────────────────────────────────────────────────────────────────────

const task = (
  id: string,
  over: Partial<{ assignee_ids: string[]; watcher_ids: string[]; created_by: string; organization_id: string }>,
) => ({
  id,
  task_number: `T${id.slice(-5)}`,
  title: `Task ${id.slice(-5)}`,
  organization_id: ALPHA_ORG_ID,
  assignee_ids: [] as string[],
  watcher_ids: [] as string[],
  created_by: CREATOR,
  ...over,
});

const SHARED    = task('t0000000-0000-0000-0000-000000000001', { assignee_ids: [DEPARTING, CO_ASSIGNEE] });
const SOLE      = task('t0000000-0000-0000-0000-000000000002', { assignee_ids: [DEPARTING], created_by: CREATOR });
const ORPHANED  = task('t0000000-0000-0000-0000-000000000003', { assignee_ids: [DEPARTING], created_by: DEAD_CREATOR });
const WATCHED   = task('t0000000-0000-0000-0000-000000000004', { assignee_ids: [CO_ASSIGNEE], watcher_ids: [DEPARTING] });
const UNRELATED = task('t0000000-0000-0000-0000-000000000005', { assignee_ids: [CO_ASSIGNEE] });
const ORG_B     = task('t0000000-0000-0000-0000-000000000006', { assignee_ids: [DEPARTING], organization_id: ORG_B_ID });

let tasks = [SHARED, SOLE, ORPHANED, WATCHED, UNRELATED, ORG_B];

// ─── Query-honouring fakes ────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const matchesUser = (u: any, where: any): boolean => {
  if (where.organization_id !== undefined && u.organization_id !== where.organization_id) return false;
  if (where.is_active !== undefined && u.is_active !== where.is_active) return false;
  if (where.role !== undefined && u.role !== where.role) return false;
  if (typeof where.id === 'string' && u.id !== where.id) return false;
  if (where.id && typeof where.id === 'object') {
    if (where.id.in && !where.id.in.includes(u.id)) return false;
    if (where.id.not && u.id === where.id.not) return false;
  }
  return true;
};

/** Honours `orderBy: [{ created_at }, { id }]` so the escalation ordering is genuinely tested. */
function userFindFirst({ where, orderBy }: any) {
  const hits = ORG_USERS.filter((u) => matchesUser(u, where ?? {}));
  if (Array.isArray(orderBy)) {
    hits.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
  }
  return Promise.resolve(hits[0] ?? null);
}

function taskFindMany({ where }: any) {
  return Promise.resolve(
    tasks.filter((t) => {
      if (t.organization_id !== where.organization_id) return false;
      if (!where.OR) return true;
      return where.OR.some((arm: any) =>
        (arm.assignee_ids?.has && t.assignee_ids.includes(arm.assignee_ids.has)) ||
        (arm.watcher_ids?.has && t.watcher_ids.includes(arm.watcher_ids.has)));
    }),
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The `data` the sweep wrote for one task, or undefined if it never touched it. */
const dataFor = (taskId: string): Record<string, string[]> | undefined =>
  mockPrisma.task.update.mock.calls.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any[]) => c[0].where.id === taskId,
  )?.[0].data;

const timelineFor = (taskId: string): Array<{ event_type: string; description: string }> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.timelineEvent.createMany.mock.calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((c: any[]) => c[0].data as any[])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((d: any) => d.entity_id === taskId);

/**
 * Let the DETACHED handover announcements finish. The deactivation response deliberately does not
 * wait on them (announceTaskHandovers), so a test that wants to see the rows has to.
 */
const flushAnnouncements = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

// ─── Notification capture (row-level, per design §9) ──────────────────────────

const notifRows = new Map<string, { verb: string; object_id: string }>();

/** The task ids a verb was announced ABOUT, in order. Duplicates here are double-announcements. */
const announcedTaskIds = (verb: string): string[] =>
  [...notifRows.values()].filter((n) => n.verb === verb).map((n) => n.object_id);

/** The `user.tasks_swept` audit rows this request wrote. */
const sweptAuditRows = (): Array<Record<string, unknown>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.auditLog.create.mock.calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any[]) => c[0].data)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((d: any) => d.action === 'user.tasks_swept');

const recipientsOf = (verb: string): string[] => {
  const ids = [...notifRows.entries()].filter(([, n]) => n.verb === verb).map(([id]) => id);
  // `mockPrisma` is Record<string, any>, so the whole chain would otherwise be `any` and
  // every callback parameter below implicitly `any`. Bind the createMany payloads to their
  // real element type once, and the filter/map that follow are genuinely checked.
  const rows: Array<Record<string, unknown>> = mockPrisma.notificationRecipient.createMany.mock.calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((c: any[]) => c[0].data as Array<Record<string, unknown>>);
  return rows
    .filter((r) => ids.includes(r.notification_id as string))
    .map((r) => r.recipient_id as string)
    .sort();
};

beforeEach(() => {
  vi.clearAllMocks();
  notifRows.clear();
  tasks = [SHARED, SOLE, ORPHANED, WATCHED, UNRELATED, ORG_B];
  mockAuthAs('admin');

  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.user.findFirst.mockImplementation(userFindFirst);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.user.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve(ORG_USERS.filter((u) => matchesUser(u, where ?? {}))));
  mockPrisma.user.count.mockResolvedValue(2);
  mockPrisma.user.update.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ ...ORG_USERS.find((u) => u.id === where.id), avatar_path: null, is_active: false }));

  mockPrisma.task.findMany.mockImplementation(taskFindMany);
  mockPrisma.task.update.mockResolvedValue({});
  mockPrisma.timelineEvent.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.auditLog.create.mockResolvedValue({});

  mockPrisma.notification.findFirst.mockResolvedValue(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.notification.create.mockImplementation(({ data }: any) => {
    const id = `notif-${notifRows.size + 1}`;
    notifRows.set(id, data);
    return Promise.resolve({ id });
  });
  mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 0 });
});

const deactivate = () => request(app).delete(`/api/users/${DEPARTING}`).set(authHeader('admin'));
const patchActive = (is_active: boolean) =>
  request(app).patch(`/api/users/${DEPARTING}`).set(authHeader('admin')).send({ is_active });

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/users/:id — the deactivate route
// ══════════════════════════════════════════════════════════════════════════════

describe('deactivation sweeps the task people-arrays', () => {
  it('drops a co-assignee and leaves the other assignees alone', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(SHARED.id)).toEqual({ assignee_ids: [CO_ASSIGNEE] });
  });

  it('hands a SOLE assignee\'s task to the creator, who is a real active person', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(SOLE.id)).toEqual({ assignee_ids: [CREATOR] });
    // The point of the whole rule: the >= 1 invariant holds AND the survivor is reachable.
    const landed = ORG_USERS.find((u) => u.id === CREATOR)!;
    expect(landed.is_active).toBe(true);
    expect(landed.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('escalates to the LONGEST-SERVING active admin when the creator is inactive too', async () => {
    expect((await deactivate()).status).toBe(200);
    // Not merely "an admin": ADMIN_SENIOR predates the acting admin, so a rule that took
    // whichever admin came back first would pick ACTOR here at least some of the time.
    expect(dataFor(ORPHANED.id)).toEqual({ assignee_ids: [ADMIN_SENIOR] });
    expect(ORG_USERS.find((u) => u.id === ADMIN_SENIOR)!.is_active).toBe(true);
  });

  it('removes a watcher with no assignee side effects', async () => {
    expect((await deactivate()).status).toBe(200);
    const data = dataFor(WATCHED.id);
    expect(data).toEqual({ watcher_ids: [] });
    expect(data).not.toHaveProperty('assignee_ids');
  });

  it('never touches a task the user was not on', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(UNRELATED.id)).toBeUndefined();
  });

  it('never leaves an assignee list empty', async () => {
    expect((await deactivate()).status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const call of mockPrisma.task.update.mock.calls as any[]) {
      const next = call[0].data.assignee_ids;
      if (next !== undefined) expect(next.length).toBeGreaterThan(0);
    }
  });

  it('writes the same named activity entries an interactive edit would', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(timelineFor(SOLE.id)).toEqual([
      expect.objectContaining({ event_type: 'UNASSIGNED', description: `unassigned ${fullName(DEPARTING)}` }),
      expect.objectContaining({ event_type: 'ASSIGNED',   description: `assigned ${fullName(CREATOR)}` }),
    ]);
    expect(timelineFor(WATCHED.id)).toEqual([
      expect.objectContaining({ event_type: 'WATCHER_REMOVED', description: `removed ${fullName(DEPARTING)} as watcher` }),
    ]);
  });

  it('tells the fallback assignees they now own the work (real NotificationRecipient rows)', async () => {
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();
    // task.assigned already exists for exactly this event; no new verb is invented for the sweep.
    expect(recipientsOf('task.assigned')).toEqual([ADMIN_SENIOR, CREATOR].sort());
  });
});

// ── Spec B slice 2: the handover is an assignment, and it is emailed ─────────
//
// A person who inherits work in flight without asking for it is the case MOST in need of an
// email rather than a bell they may not check - they were not in the app when it happened and
// have no reason to open it. So the sweep dispatches TASK_ASSIGNED alongside the bell verb it
// already emits.

describe('the handover sweep dispatches TASK_ASSIGNED for each fallback assignee', () => {
  it('fires once per reassigned task, addressed to the person who inherited it', async () => {
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    const events = dispatchesOf('TASK_ASSIGNED');
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.entity.id, e.occurrenceKey]).sort()).toEqual(
      [
        [SOLE.id, CREATOR],
        [ORPHANED.id, ADMIN_SENIOR],
      ].sort(),
    );
  });

  it('carries the inheriting person\'s own row, so `assigned_user` resolves to THEM', async () => {
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    const sole = dispatchesOf('TASK_ASSIGNED').find((e) => e.entity.id === SOLE.id)!;
    expect(sole.eventPayload.recipient).toMatchObject({ id: CREATOR, email: `${CREATOR}@test.com` });
    // The acting admin is the one doing the deactivating, not the one inheriting.
    expect(sole.actorId).toBe(ACTOR);
    // The TITLE, matching every other task-shaped label.
    expect(sole.entity).toEqual({ type: 'task', id: SOLE.id, label: SOLE.title });
  });

  it('supplies an occurrence, so the two handovers cannot dedupe into one', async () => {
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    const keys = dispatchesOf('TASK_ASSIGNED').map((e) => buildDedupeKey(e.type, e.entity.id, e.occurrenceKey));
    expect(new Set(keys).size).toBe(2);
  });

  it('dispatches nothing for a task that was merely trimmed, only for one handed over', async () => {
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    const ids = dispatchesOf('TASK_ASSIGNED').map((e) => e.entity.id);
    // SHARED kept its co-assignee and WATCHED only lost a watcher: nobody inherited anything.
    expect(ids).not.toContain(SHARED.id);
    expect(ids).not.toContain(WATCHED.id);
  });

  it('dispatches nothing at all when no task changed hands', async () => {
    tasks = [SHARED, WATCHED, UNRELATED];

    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/users/:id — the OTHER route that can flip is_active
// ══════════════════════════════════════════════════════════════════════════════

describe('PATCH is_active', () => {
  it('sweeps on is_active:false, exactly like DELETE does', async () => {
    expect((await patchActive(false)).status).toBe(200);
    expect(dataFor(SHARED.id)).toEqual({ assignee_ids: [CO_ASSIGNEE] });
    expect(dataFor(SOLE.id)).toEqual({ assignee_ids: [CREATOR] });
  });

  it('does NOT restore a re-activated user to any task — removal is one-way', async () => {
    expect((await patchActive(true)).status).toBe(200);
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Tenancy
// ══════════════════════════════════════════════════════════════════════════════

describe('cross-org safety', () => {
  it('a deactivation in org A does not touch org B\'s tasks', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(ORG_B.id)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const call of mockPrisma.task.findMany.mock.calls as any[]) {
      expect(call[0].where.organization_id).toBe(ALPHA_ORG_ID);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The org with nobody left to escalate to
// ══════════════════════════════════════════════════════════════════════════════

describe('no active admin to escalate to', () => {
  it('keeps the dangling id rather than emptying the list, and still 200s', async () => {
    // Only the sole-assignee task whose creator is also inactive, in an org whose only admins
    // have been removed from the fixture.
    tasks = [ORPHANED];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.user.findFirst.mockImplementation(({ where, orderBy }: any) =>
      where?.role === 'ADMIN' ? Promise.resolve(null) : userFindFirst({ where, orderBy }));

    expect((await deactivate()).status).toBe(200);
    // An empty array is worse than a wrong one: it is invisible to every view.
    expect(dataFor(ORPHANED.id)).toBeUndefined();
  });

  it('is reachable in practice - the last-admin guard does not cover this', async () => {
    // `wouldRemoveLastAdmin` refuses to deactivate the last active ADMIN, which is why the
    // escalation target is usually guaranteed to exist. It only looks at the TARGET's own role,
    // though: deactivating a technician in an org that already has no active admin never
    // consults it at all, so the stranded branch is load-bearing, not theoretical.
    tasks = [ORPHANED];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.user.findFirst.mockImplementation(({ where, orderBy }: any) =>
      where?.role === 'ADMIN' ? Promise.resolve(null) : userFindFirst({ where, orderBy }));

    expect((await deactivate()).status).toBe(200);
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Assignee lists whose OTHER ids are already dangling
//
// The rule is "keep the ids that name an active member of this org", NOT "delete the one id this
// sweep was triggered for". The difference only shows up on a list that was already carrying a
// dead id - which is exactly what the stranded branch above leaves behind, and exactly what every
// row predating this release looks like. A delete-one-id sweep answers "one assignee left,
// nothing to repair" and leaves the task assigned solely to a ghost: the defect issue 02 exists
// to prevent. The SQL backfill has never had that hole, so this is also where the two rules would
// silently come apart.
// ══════════════════════════════════════════════════════════════════════════════

describe('an assignee list whose other ids are already dangling', () => {
  it('falls back rather than leaving the task assigned solely to a dead id', async () => {
    const STALE = task('t0000000-0000-0000-0000-00000000000a', {
      assignee_ids: [DEAD_CREATOR, DEPARTING], created_by: CREATOR,
    });
    tasks = [STALE];
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(STALE.id)).toEqual({ assignee_ids: [CREATOR] });
    expect(timelineFor(STALE.id)).toEqual([
      expect.objectContaining({ event_type: 'UNASSIGNED', description: `unassigned ${fullName(DEAD_CREATOR)}` }),
      expect.objectContaining({ event_type: 'UNASSIGNED', description: `unassigned ${fullName(DEPARTING)}` }),
      expect.objectContaining({ event_type: 'ASSIGNED',   description: `assigned ${fullName(CREATOR)}` }),
    ]);
  });

  it('treats an id that is active in ANOTHER org as dangling', async () => {
    const FOREIGN = task('t0000000-0000-0000-0000-00000000000b', {
      assignee_ids: [ORG_B_USER, DEPARTING], watcher_ids: [ORG_B_USER], created_by: CREATOR,
    });
    tasks = [FOREIGN];
    expect((await deactivate()).status).toBe(200);
    // ORG_B_USER is an active ADMIN - of org B. Being active somewhere else is not a reason to
    // keep them on this tenant's task.
    expect(dataFor(FOREIGN.id)).toEqual({ assignee_ids: [CREATOR], watcher_ids: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cost of the sweep at the size that actually hurts
// ══════════════════════════════════════════════════════════════════════════════

describe('a user solely assigned to hundreds of tasks', () => {
  const BULK = 200;
  const CHUNK = 25; // TASKS_PER_TRANSACTION
  let updatesPerTransaction: number[] = [];

  beforeEach(() => {
    updatesPerTransaction = [];
    tasks = Array.from({ length: BULK }, (_, i) =>
      task(`t0000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, {
        assignee_ids: [DEPARTING], created_by: CREATOR,
      }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => unknown) => {
      const before = mockPrisma.task.update.mock.calls.length;
      const out = await fn(prisma);
      updatesPerTransaction.push(mockPrisma.task.update.mock.calls.length - before);
      return out;
    });
  });

  it('bounds every transaction instead of opening one that spans the whole sweep', async () => {
    // Prisma closes an interactive transaction after 5s by default. 200 tasks in one transaction
    // is ~800 sequential round trips; at a Render-to-Supabase RTT that is past the ceiling, and
    // the whole sweep would roll back behind a swallowed error.
    expect((await deactivate()).status).toBe(200);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(BULK);
    expect(updatesPerTransaction).toHaveLength(Math.ceil(BULK / CHUNK));
    for (const n of updatesPerTransaction) expect(n).toBeLessThanOrEqual(CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const call of mockPrisma.$transaction.mock.calls as any[]) {
      expect(call[1]).toMatchObject({ timeout: expect.any(Number) });
    }
  });

  it('writes the activity feed in one insert per chunk, not one per event', async () => {
    expect((await deactivate()).status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.createMany).toHaveBeenCalledTimes(Math.ceil(BULK / CHUNK));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = mockPrisma.timelineEvent.createMany.mock.calls.flatMap((c: any[]) => c[0].data);
    expect(rows).toHaveLength(BULK * 2); // one UNASSIGNED + one ASSIGNED per task
  });

  it('does not hold the response open for the notification fan-out', async () => {
    // emit() ends in publishNotificationsChanged, which opens, joins and tears down a Supabase
    // Realtime channel PER RECIPIENT PER TASK. If the response waited on that, a notification
    // write that never settles would hang the deactivation - which is what this asserts it does
    // not do. The rows are committed either way; only the in-app ping can be late.
    mockPrisma.notification.create.mockImplementation(() => new Promise<never>(() => {}));
    const res = await deactivate();
    expect(res.status).toBe(200);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(BULK);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cases the first pass left uncovered (QA)
// ══════════════════════════════════════════════════════════════════════════════

describe('edges the rule has to get right', () => {
  it('escalates rather than handing the task back to the person leaving', async () => {
    // `created_by` IS the departing user. The routes flip `is_active` before the sweep runs, so
    // the membership probe already excludes them - but the sweep also deletes them from the probe
    // set explicitly, and this is the case that would notice if either stopped being true.
    const OWN = task('t0000000-0000-0000-0000-00000000000c', {
      assignee_ids: [DEPARTING], created_by: DEPARTING,
    });
    tasks = [OWN];
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(OWN.id)).toEqual({ assignee_ids: [ADMIN_SENIOR] });
  });

  it('repairs an all-dangling assignee list even when the trigger was only a WATCHER', async () => {
    // Deactivating a watcher normally has no assignee side effect (see above). It does when the
    // assignee list was ALREADY entirely dangling: the sweep applies the whole rule to every row
    // it touches, not just the one list the trigger appeared on. Documented here because it is a
    // deliberate consequence, not an accident.
    const ROTTEN = task('t0000000-0000-0000-0000-00000000000d', {
      assignee_ids: [DEAD_CREATOR], watcher_ids: [DEPARTING], created_by: CREATOR,
    });
    tasks = [ROTTEN];
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(ROTTEN.id)).toEqual({ assignee_ids: [CREATOR], watcher_ids: [] });
  });

  it('leaves an already-empty assignee list empty rather than inventing an owner', async () => {
    const BLANK = task('t0000000-0000-0000-0000-00000000000e', {
      assignee_ids: [], watcher_ids: [DEPARTING],
    });
    tasks = [BLANK];
    expect((await deactivate()).status).toBe(200);
    expect(dataFor(BLANK.id)).toEqual({ watcher_ids: [] });
  });

  it('sends no notification when the fallback assignee is the admin doing the deactivating', async () => {
    // dedupe() drops the actor, so emit() resolves nobody and writes no row. Correct - you do not
    // need telling about work you just handed to yourself - but it means "every handover is
    // announced" is false, and a future reader should know which of the two it is.
    const MINE = task('t0000000-0000-0000-0000-00000000000f', {
      assignee_ids: [DEPARTING], created_by: ACTOR,
    });
    tasks = [MINE];
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();
    expect(dataFor(MINE.id)).toEqual({ assignee_ids: [ACTOR] });
    expect(recipientsOf('task.assigned')).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// What a failure PART-WAY through the chunked sweep leaves behind
// ══════════════════════════════════════════════════════════════════════════════

describe('a sweep that dies half way', () => {
  const N = 60; // 25 + 25 + 10

  it('commits the chunks it finished, and a re-run repairs the rest without emptying anything', async () => {
    tasks = Array.from({ length: N }, (_, i) =>
      task(`t0000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, {
        assignee_ids: [DEPARTING], created_by: CREATOR,
      }));
    const committed = new Set<string>();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.task.update.mockImplementation(({ where }: any) => {
      calls += 1;
      if (calls > 30) return Promise.reject(new Error('simulated failure mid-sweep'));
      committed.add(where.id);
      return Promise.resolve({});
    });

    // The deactivation itself still succeeds: the sweep is failure-isolated on purpose.
    expect((await deactivate()).status).toBe(200);
    expect(committed.size).toBe(30);

    // Re-run against a database that reflects only what was committed. Nothing else is reset:
    // the point is that the SECOND sweep sees the half-repaired world and finishes the job.
    mockPrisma.task.update.mockReset();
    mockPrisma.task.update.mockResolvedValue({});
    tasks = tasks.map((t) => (committed.has(t.id) ? { ...t, assignee_ids: [CREATOR] } : t));

    expect((await deactivate()).status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = mockPrisma.task.update.mock.calls as any[];
    expect(second).toHaveLength(N - committed.size);
    for (const call of second) {
      expect(committed.has(call[0].where.id)).toBe(false);   // no task rewritten twice
      expect(call[0].data.assignee_ids).toEqual([CREATOR]);  // and never emptied
    }
  });

  // Chunking made the DATA recoverable by a re-run and made nothing else recoverable. A task that
  // committed is not selected by the next sweep - it no longer names the departing user - so if
  // the failure threw away `reassigned`, the people who were handed those tasks were never told,
  // and no later run could tell them. The announcement and the audit row are owed by THIS request
  // or by nobody.
  const bulk = (n: number) => Array.from({ length: n }, (_, i) =>
    task(`t0000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, {
      assignee_ids: [DEPARTING], created_by: CREATOR,
    }));
  /** Reject from the (n+1)th task.update onwards, as a chunk failing part-way does. */
  const failAfter = (n: number) => {
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.task.update.mockImplementation(() => {
      calls += 1;
      return calls > n
        ? Promise.reject(new Error('simulated failure mid-sweep'))
        : Promise.resolve({});
    });
  };

  it('still announces and audits the chunks that DID commit', async () => {
    tasks = bulk(N);
    failAfter(30); // chunk 1 (25) commits; chunk 2 dies on its 6th row; chunk 3 is never tried

    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    // Only the committed chunk: the other 25 rolled back with their transaction and the last 10
    // were never attempted.
    expect(announcedTaskIds('task.assigned')).toHaveLength(25);
    expect(recipientsOf('task.assigned')).toEqual(Array(25).fill(CREATOR));

    const audit = sweptAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ tasks_updated: 25, reassigned: 25, failed: 35 });
  });

  it('does not announce a committed chunk a second time when the sweep is re-run', async () => {
    tasks = bulk(N);
    failAfter(30);
    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();
    const firstPass = announcedTaskIds('task.assigned');
    expect(firstPass).toHaveLength(25);

    // The world the re-run wakes up in: the committed chunk no longer names the departing user.
    const done = new Set(firstPass);
    tasks = tasks.map((t) => (done.has(t.id) ? { ...t, assignee_ids: [CREATOR] } : t));
    notifRows.clear();
    mockPrisma.task.update.mockReset();
    mockPrisma.task.update.mockResolvedValue({});

    expect((await deactivate()).status).toBe(200);
    await flushAnnouncements();

    const secondPass = announcedTaskIds('task.assigned');
    expect(secondPass).toHaveLength(N - firstPass.length);
    for (const id of secondPass) expect(done.has(id)).toBe(false);
  });
});
